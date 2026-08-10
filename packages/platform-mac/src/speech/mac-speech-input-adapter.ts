import {
  PilotError,
  nullLogger,
  type Logger,
  type PermissionKind,
  type PermissionState,
  type SpeechRecognitionDisclosure,
  type UtteranceId,
} from '@pilot/shared';
import type {
  SpeechInputAdapter,
  SpeechInputAvailability,
  SpeechInputEvent,
  SpeechInputRequest,
  Unsubscribe,
} from '@pilot/platform';
import { Poller } from '../polling.js';
import {
  speechInputAvailabilityOperation,
  speechInputCancelOperation,
  speechInputPollOperation,
  speechInputStartOperation,
  speechInputStopOperation,
  type SpeechInputWireEvent,
  type SpeechRecognizerFacts,
} from '../protocol/speech-ops.js';
import { TypedEmitter } from '../transport/emitter.js';
import type { HelperTransportState, NativeHelperTransport } from '../transport/helper-transport.js';
import { decideRecognition, unknownRecognitionDisclosure } from './disclosure.js';
import {
  remapSpeechFailure,
  toDisclosureRefusalError,
  toSpeechInputError,
  toSpeechPermissionError,
} from './errors.js';

/**
 * macOS `SpeechInputAdapter` (system-design §5), backed by Apple Speech inside
 * the native helper.
 *
 * ## Teardown is idempotent, and that is the point
 *
 * Apple Speech does not behave like the fake. It endpoints on its own, so a
 * `final` routinely arrives *before* push-to-talk is released; it can deliver
 * a second `isFinal` result after the first; and a task that has been
 * cancelled can still call its handler. PR-025's binding is built to absorb
 * that one layer up — but it says, correctly, that the native layer should not
 * lean on it. So this adapter guarantees the two properties the contract
 * promises, on its own:
 *
 * 1. **`stop()` and `cancel()` are no-ops for an utterance that is not open.**
 *    They resolve; they do not throw. PR-025 found the defect this prevents: a
 *    recogniser that finished early made `stop-listening` throw, the throw
 *    became `failure`, and a question that had *already been submitted* landed
 *    the user in `error`.
 * 2. **At most one terminal event per utterance.** After a `final` or an
 *    `error` for an utterance, everything else it says is dropped here and
 *    counted (`droppedEventCount`). A cancelled utterance says nothing at all,
 *    which is what makes system-design §15's "results from stale utterance IDs
 *    are discarded" true below the machine as well as inside it.
 *
 * Together those mean the binding never *has* to correct this adapter — and if
 * a future recogniser misbehaves in a way neither layer predicted, both layers
 * still hold independently.
 *
 * ## Audio never leaves the helper process
 *
 * Microphone buffers go straight from the `AVAudioEngine` tap into the
 * recognition request inside the helper. No speech operation has a binary
 * body, nothing here writes a file, and no transcript is ever passed to the
 * logger — only ids, event kinds and character counts (system-design §13, §14;
 * `test/speech-privacy.test.ts` asserts all three mechanically).
 */

/**
 * How often the helper's event queue is drained while an utterance is open.
 *
 * Only bounds how stale a *partial* transcript can be, so it is deliberately
 * short and deliberately not on any critical path: `start` returns the
 * on-device decision in its own response, and a `final` is worth at most one
 * interval of latency against the seconds a user spends speaking. Polling runs
 * only while an utterance is open.
 */
export const DEFAULT_SPEECH_POLL_INTERVAL_MS = 60;

/** How many finished utterances are remembered for duplicate suppression. */
export const TERMINAL_LEDGER_SIZE = 32;

interface SpeechInputEvents extends Record<string, unknown> {
  event: SpeechInputEvent;
}

/** How far an utterance has got, as this adapter sees it. */
type UtterancePhase =
  /** Recording. Partials, a final or an error may arrive. */
  | 'open'
  /** `stop()` was forwarded; the accepted transcript is still expected. */
  | 'closing';

interface ActiveUtterance {
  readonly utteranceId: UtteranceId;
  phase: UtterancePhase;
}

export interface MacSpeechInputAdapterOptions {
  readonly transport: NativeHelperTransport;
  /**
   * Refuse to record unless recognition is pinned to this Mac, when the caller
   * does not say. `SpeechInputRequest.requireOnDevice` overrides it per call;
   * this is what `availability()` and `disclosure()` answer for.
   */
  readonly requireOnDevice?: boolean;
  /** BCP-47 locale. Omitted means the recogniser's own default. */
  readonly locale?: string;
  readonly pollIntervalMs?: number;
  readonly logger?: Logger;
}

export class MacSpeechInputAdapter implements SpeechInputAdapter {
  readonly #transport: NativeHelperTransport;
  readonly #emitter = new TypedEmitter<SpeechInputEvents>();
  readonly #logger: Logger;
  readonly #poller: Poller;
  readonly #requireOnDevice: boolean;
  readonly #locale: string | undefined;
  readonly #offTransportState: Unsubscribe;
  /** Utterances that have already produced a terminal event, newest last. */
  readonly #terminated: UtteranceId[] = [];

  #active: ActiveUtterance | null = null;
  #sinceSequence = 0;
  #droppedByHelper = 0;
  #droppedEvents = 0;
  #ignoredCalls = 0;
  #disclosure: SpeechRecognitionDisclosure = unknownRecognitionDisclosure();
  #lastTransportState: HelperTransportState;
  #disposed = false;

  constructor(options: MacSpeechInputAdapterOptions) {
    this.#transport = options.transport;
    this.#logger = (options.logger ?? nullLogger).child('mac-speech-input');
    this.#requireOnDevice = options.requireOnDevice ?? true;
    this.#locale = options.locale;
    this.#poller = new Poller(() => this.#drain(), {
      intervalMs: options.pollIntervalMs ?? DEFAULT_SPEECH_POLL_INTERVAL_MS,
      logger: this.#logger,
      name: 'speech-input',
    });
    this.#lastTransportState = options.transport.state;
    this.#offTransportState = options.transport.on('state', (state) => {
      const previous = this.#lastTransportState;
      this.#lastTransportState = state;
      this.#onTransportState(previous, state);
    });
  }

  subscribe = (listener: (event: SpeechInputEvent) => void): Unsubscribe =>
    this.#emitter.on('event', listener);

  /** The utterance currently recording or awaiting its transcript, if any. */
  get activeUtteranceId(): UtteranceId | null {
    return this.#active?.utteranceId ?? null;
  }

  /**
   * Where recognition would have sent the audio, as of the last decision.
   *
   * `unknown` until the first successful availability probe: not knowing is
   * reported as not knowing, never as "it stayed here".
   */
  get lastDisclosure(): SpeechRecognitionDisclosure {
    return this.#disclosure;
  }

  /** Events dropped because their utterance was already over. */
  get droppedEventCount(): number {
    return this.#droppedEvents;
  }

  /** `stop`/`cancel` calls that referred to an utterance that was not open. */
  get ignoredCallCount(): number {
    return this.#ignoredCalls;
  }

  // -- availability ---------------------------------------------------------

  async availability(): Promise<SpeechInputAvailability> {
    const probe = await this.#probe();
    const decision = decideRecognition(probe.facts, { requireOnDevice: this.#requireOnDevice });
    this.#disclosure = decision.disclosure;
    const permitted = probe.microphone === 'granted' && probe.speechRecognition === 'granted';
    return {
      available: decision.allowed && permitted,
      onDevice: probe.facts.supportsOnDevice,
      ...(probe.facts.locale === null ? {} : { locale: probe.facts.locale }),
      destination: decision.disclosure.destination,
      disclosure: decision.disclosure,
    };
  }

  /** system-design §14: where the audio goes, in a form the UI can draw. */
  async disclosure(): Promise<SpeechRecognitionDisclosure> {
    const probe = await this.#probe();
    const decision = decideRecognition(probe.facts, { requireOnDevice: this.#requireOnDevice });
    this.#disclosure = decision.disclosure;
    return decision.disclosure;
  }

  /** Locales this Mac can recognise at all. Diagnostics and settings UI. */
  async supportedLocales(): Promise<readonly string[]> {
    const probe = await this.#probe();
    return probe.facts.supportedLocales;
  }

  // -- capture --------------------------------------------------------------

  /**
   * Begins capture and recognition for one utterance.
   *
   * Order matters and is not negotiable: permissions, then the privacy
   * decision, then the microphone. Nothing is recorded before Pilot knows
   * where the recording would be understood.
   */
  async start(request: SpeechInputRequest): Promise<void> {
    if (this.#disposed) {
      throw new PilotError('speech-unavailable', 'Speech input adapter is disposed', {
        userMessage: 'Pilot is shutting down. Type your question instead.',
        retryable: false,
      });
    }

    // Exactly one recogniser at a time. A caller that skipped teardown gets
    // the previous utterance released rather than an audio session conflict.
    const previous = this.#active;
    if (previous !== null) {
      await this.cancel(previous.utteranceId);
    }

    const probe = await this.#probe();
    this.#assertPermission('microphone', probe.microphone);
    this.#assertPermission('speech-recognition', probe.speechRecognition);

    const decision = decideRecognition(probe.facts, {
      requireOnDevice: request.requireOnDevice,
    });
    this.#disclosure = decision.disclosure;
    if (!decision.allowed) {
      // Refusing is a *product* behaviour, not a malfunction (PR-008's
      // onboarding copy promises it), so it is logged at info with the reason
      // rather than swallowed or logged as an error.
      this.#logger.info('refused to record', {
        utteranceId: request.utteranceId,
        reason: decision.disclosure.reason,
        destination: decision.disclosure.destination,
      });
      throw toDisclosureRefusalError(decision.disclosure, request.utteranceId);
    }
    if (decision.disclosure.leavesDevice) {
      // The disclosure is data the UI renders; this line exists so the same
      // fact is also in the diagnostics log, where a user checking after the
      // fact will look. No transcript, no audio — a destination and a reason.
      this.#logger.warn('recognition audio leaves this Mac', {
        utteranceId: request.utteranceId,
        destination: decision.disclosure.destination,
        reason: decision.disclosure.reason,
        service: decision.disclosure.service,
      });
    }

    // Registered before the helper call: the helper may already have queued a
    // partial by the time the response lands, and the very next drain must
    // recognise the utterance it belongs to.
    this.#active = { utteranceId: request.utteranceId, phase: 'open' };
    try {
      await this.#transport.request(speechInputStartOperation, {
        utteranceId: request.utteranceId,
        onDevice: decision.useOnDevice,
        locale: request.locale ?? this.#locale ?? null,
      });
    } catch (cause) {
      // The utterance never began. Retire it here so a helper that also
      // queues a failure event cannot make the caller handle it twice.
      this.#retire(request.utteranceId);
      throw remapSpeechFailure(cause, 'input');
    }
    this.#poller.start();
  }

  /**
   * Ends capture and waits for the accepted transcript.
   *
   * A no-op unless this utterance is the open one — see the class comment.
   */
  async stop(utteranceId: UtteranceId): Promise<void> {
    const active = this.#active;
    if (active === null || active.utteranceId !== utteranceId || active.phase !== 'open') {
      this.#ignoreCall('stop', utteranceId);
      return;
    }
    active.phase = 'closing';
    await this.#transport.request(speechInputStopOperation, { utteranceId });
    // The final may already be queued; do not make the caller wait a whole
    // poll interval for a transcript the helper has already produced.
    await this.#poller.refresh();
  }

  /** Ends capture and discards the utterance. Also a no-op when not open. */
  async cancel(utteranceId: UtteranceId): Promise<void> {
    const active = this.#active;
    if (active === null || active.utteranceId !== utteranceId) {
      this.#ignoreCall('cancel', utteranceId);
      return;
    }
    // Retired *before* the round trip: anything the recogniser says from here
    // on belongs to an utterance that no longer exists, including whatever it
    // says while the cancel is still in flight.
    this.#retire(utteranceId);
    await this.#transport.request(speechInputCancelOperation, { utteranceId });
    // Drain once so the helper's queue does not carry a dead utterance's
    // events into the next one's sequence window.
    await this.#poller.refresh();
  }

  /** Drains the helper's event queue once, outside the schedule. */
  async refresh(): Promise<void> {
    await this.#poller.refresh();
  }

  /** Stops polling and releases the microphone if anything is still open. */
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#offTransportState();
    const active = this.#active;
    if (active !== null) {
      this.#retire(active.utteranceId);
      try {
        await this.#transport.request(speechInputCancelOperation, {
          utteranceId: active.utteranceId,
        });
      } catch (error) {
        // Disposal must not throw: the transport may already be gone, which is
        // frequently *why* the adapter is being disposed.
        this.#logger.debug('cancel during dispose failed', {
          code: error instanceof PilotError ? error.code : 'internal',
        });
      }
    }
    this.#poller.stop();
    this.#emitter.clear();
  }

  // -------------------------------------------------------------------------

  async #probe(): Promise<{
    readonly facts: SpeechRecognizerFacts;
    readonly microphone: PermissionState;
    readonly speechRecognition: PermissionState;
  }> {
    const response = await this.#transport.request(speechInputAvailabilityOperation, {
      locale: this.#locale ?? null,
    });
    return response.payload;
  }

  #assertPermission(kind: PermissionKind, state: PermissionState): void {
    if (state === 'granted') {
      return;
    }
    throw toSpeechPermissionError(kind, state);
  }

  /**
   * Drains everything the helper has queued since the last drain.
   *
   * Runs on the poller, and also directly after `stop` and `cancel` so neither
   * pays an interval it does not need to.
   */
  async #drain(): Promise<void> {
    const response = await this.#transport.request(speechInputPollOperation, {
      sinceSequence: this.#sinceSequence,
    });
    const payload = response.payload;

    if (payload.sequence < this.#sinceSequence) {
      // The helper restarted and began numbering again. Take its word for it
      // rather than silently ignoring every event below the old high-water
      // mark, which would swallow a whole utterance.
      this.#sinceSequence = 0;
    }
    if (payload.dropped > this.#droppedByHelper) {
      this.#logger.warn('helper discarded queued speech events', {
        dropped: payload.dropped - this.#droppedByHelper,
      });
      this.#droppedByHelper = payload.dropped;
    }

    for (const event of payload.events) {
      this.#sinceSequence = Math.max(this.#sinceSequence, event.sequence);
      this.#receive(event);
    }

    if (this.#active === null) {
      this.#poller.stop();
    }
  }

  #receive(event: SpeechInputWireEvent): void {
    const active = this.#active;
    const utteranceId = event.utteranceId as UtteranceId;
    if (active === null || active.utteranceId !== utteranceId) {
      this.#dropEvent(event, active === null ? 'no-open-utterance' : 'superseded');
      return;
    }

    switch (event.type) {
      case 'partial':
        this.#emitter.emit('event', { type: 'partial', utteranceId, transcript: event.transcript });
        return;
      case 'final':
        // One accepted transcript per utterance (system-design §7). Retiring
        // before emitting means a second `isFinal` from the same recogniser —
        // which Apple Speech does produce — is dropped by the branch above.
        this.#retire(utteranceId);
        this.#emitter.emit('event', { type: 'final', utteranceId, transcript: event.transcript });
        return;
      case 'error':
        this.#retire(utteranceId);
        this.#emitter.emit('event', {
          type: 'error',
          utteranceId,
          error: toSpeechInputError(event.code, event.message, { id: utteranceId }),
        });
        return;
    }
  }

  /**
   * Marks an utterance finished for good.
   *
   * The ledger is what makes "at most one terminal event" survive the moment
   * the utterance stops being the active one — without it, a late `final` for
   * an utterance nobody remembers would look exactly like an event for an
   * unknown utterance, and the diagnostics would say the wrong thing.
   */
  #retire(utteranceId: UtteranceId): void {
    this.#active = null;
    if (!this.#terminated.includes(utteranceId)) {
      this.#terminated.push(utteranceId);
      while (this.#terminated.length > TERMINAL_LEDGER_SIZE) {
        this.#terminated.shift();
      }
    }
  }

  #dropEvent(event: SpeechInputWireEvent, reason: string): void {
    this.#droppedEvents += 1;
    this.#logger.debug('dropped a speech event', {
      event: event.type,
      utteranceId: event.utteranceId,
      reason: this.#terminated.includes(event.utteranceId as UtteranceId)
        ? 'already-terminal'
        : reason,
    });
  }

  #ignoreCall(call: 'stop' | 'cancel', utteranceId: UtteranceId): void {
    this.#ignoredCalls += 1;
    this.#logger.debug('speech call ignored', {
      call,
      utteranceId,
      reason: this.#terminated.includes(utteranceId) ? 'already-closed' : 'not-open',
    });
  }

  /**
   * A helper that crashed took the microphone and the recogniser with it.
   *
   * Nothing about the utterance survives a restart — the audio is gone by
   * definition (§13: memory only) — so the honest response is to fail it
   * immediately rather than let the caller wait for a transcript that will
   * never arrive. §16 then applies: the user types instead.
   */
  #onTransportState(previous: HelperTransportState, state: HelperTransportState): void {
    const active = this.#active;
    if (active === null || previous !== 'ready' || state === 'ready') {
      return;
    }
    this.#retire(active.utteranceId);
    this.#sinceSequence = 0;
    this.#poller.stop();
    this.#emitter.emit('event', {
      type: 'error',
      utteranceId: active.utteranceId,
      error: toSpeechInputError('audio-engine', 'The macOS helper stopped while listening', {
        id: active.utteranceId,
        details: { transportState: state },
      }),
    });
  }
}
