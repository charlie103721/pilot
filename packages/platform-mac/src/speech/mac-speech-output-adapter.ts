import { PilotError, nullLogger, type Logger, type SpeechId } from '@pilot/shared';
import type {
  SpeechOutputAdapter,
  SpeechOutputEvent,
  SpeechOutputRequest,
  Unsubscribe,
} from '@pilot/platform';
import { Poller } from '../polling.js';
import {
  speechOutputAvailabilityOperation,
  speechOutputPollOperation,
  speechOutputSpeakOperation,
  speechOutputStopOperation,
  type SpeechOutputWireEvent,
  type SpeechVoice,
} from '../protocol/speech-ops.js';
import { TypedEmitter } from '../transport/emitter.js';
import type { HelperTransportState, NativeHelperTransport } from '../transport/helper-transport.js';
import {
  DEFAULT_SPEECH_POLL_INTERVAL_MS,
  TERMINAL_LEDGER_SIZE,
} from './mac-speech-input-adapter.js';
import { remapSpeechFailure, toSpeechOutputError } from './errors.js';

/**
 * macOS `SpeechOutputAdapter` (system-design §5), backed by
 * `AVSpeechSynthesizer` inside the native helper.
 *
 * ## Stopping is one round trip, not one poll
 *
 * §17 budgets TTS interruption below 300 ms, and that budget is spent the
 * moment a design makes interruption wait for anything. So `stop()` is a
 * request whose *response* carries every utterance the synthesiser discarded,
 * and this adapter emits `stopped` for each of them straight from that
 * response. Nothing waits for the event queue to be drained, and nothing waits
 * for a delegate callback. Everything else — `started`, `finished`, `error` —
 * is drained on the poller, where a few tens of milliseconds cost nothing.
 *
 * ## One queue, one stop
 *
 * `AVSpeechSynthesizer` owns its queue and offers no way to remove a single
 * entry, so stopping any utterance flushes all of them. That is reported
 * honestly rather than hidden: `stop(id)` returns every id it discarded and an
 * event is emitted for each, so PR-026's buffer never waits on a chunk that
 * will now never be spoken. Handing consecutive chunks to that native queue is
 * also what makes sentence-to-sentence playback gapless — the host is not in
 * the loop between them.
 *
 * ## Nothing blocks
 *
 * Synthesis happens in the helper process, so neither the Electron main
 * process nor the renderer ever waits on an audio callback (§17, last bullet).
 * Every method here is a framed request and returns as soon as the helper has
 * accepted it.
 *
 * ## Failure keeps the text
 *
 * §16: "TTS fails → continue showing streamed text". Every failure below is a
 * typed `speech-output-failed` (or `speech-unavailable` when the Mac has no
 * voice at all) whose `userMessage` says the answer is still on screen. A
 * caller that treats a speech error as fatal to the turn is doing something
 * this adapter never asks it to do.
 */

interface SpeechOutputEvents extends Record<string, unknown> {
  event: SpeechOutputEvent;
}

export interface MacSpeechOutputAdapterOptions {
  readonly transport: NativeHelperTransport;
  /** Voice identifier, or a BCP-47 tag the helper resolves. */
  readonly voice?: string;
  /** 0…1, mapped onto the platform's rate range. */
  readonly rate?: number;
  readonly pollIntervalMs?: number;
  readonly logger?: Logger;
}

export class MacSpeechOutputAdapter implements SpeechOutputAdapter {
  readonly #transport: NativeHelperTransport;
  readonly #emitter = new TypedEmitter<SpeechOutputEvents>();
  readonly #logger: Logger;
  readonly #poller: Poller;
  readonly #voice: string | undefined;
  readonly #rate: number | undefined;
  readonly #offTransportState: Unsubscribe;
  /** Utterances handed to the synthesiser that have not finished, in order. */
  readonly #pending: SpeechId[] = [];
  /** Utterances that already produced a terminal event, newest last. */
  readonly #terminated: SpeechId[] = [];

  #sinceSequence = 0;
  #droppedByHelper = 0;
  #droppedEvents = 0;
  #lastTransportState: HelperTransportState;
  #disposed = false;

  constructor(options: MacSpeechOutputAdapterOptions) {
    this.#transport = options.transport;
    this.#logger = (options.logger ?? nullLogger).child('mac-speech-output');
    this.#voice = options.voice;
    this.#rate = options.rate;
    this.#poller = new Poller(() => this.#drain(), {
      intervalMs: options.pollIntervalMs ?? DEFAULT_SPEECH_POLL_INTERVAL_MS,
      logger: this.#logger,
      name: 'speech-output',
    });
    this.#lastTransportState = options.transport.state;
    this.#offTransportState = options.transport.on('state', (state) => {
      const previous = this.#lastTransportState;
      this.#lastTransportState = state;
      this.#onTransportState(previous, state);
    });
  }

  subscribe = (listener: (event: SpeechOutputEvent) => void): Unsubscribe =>
    this.#emitter.on('event', listener);

  /** Utterances handed to the synthesiser that have not yet ended. */
  get pendingSpeechIds(): readonly SpeechId[] {
    return this.#pending;
  }

  get droppedEventCount(): number {
    return this.#droppedEvents;
  }

  async availability(): Promise<{
    readonly available: boolean;
    readonly voices: readonly string[];
  }> {
    const response = await this.#transport.request(speechOutputAvailabilityOperation, {});
    return {
      available: response.payload.available,
      voices: response.payload.voices.map((voice) => voice.identifier),
    };
  }

  /**
   * The full voice list, beyond the identifiers the contract carries.
   *
   * Adapter-specific rather than contractual: a voice picker needs the display
   * name, language and quality, and no other platform has to model those the
   * same way.
   */
  async voiceCatalog(): Promise<readonly SpeechVoice[]> {
    const response = await this.#transport.request(speechOutputAvailabilityOperation, {});
    return response.payload.voices;
  }

  /**
   * Speaks one chunk. PR-026 owns what a chunk is.
   *
   * Returns once the helper has accepted the text, not when it has been
   * spoken: `finished` arrives as an event so a caller can queue the next
   * chunk without blocking on the current one.
   */
  async speak(request: SpeechOutputRequest): Promise<void> {
    if (this.#disposed) {
      throw new PilotError('speech-output-failed', 'Speech output adapter is disposed', {
        userMessage:
          'Pilot cannot speak right now. The answer is still shown as text as it arrives.',
        retryable: false,
      });
    }
    const voice = request.voice ?? this.#voice ?? null;
    const rate = request.rate ?? this.#rate ?? null;

    // Tracked before the round trip: the helper may have started speaking (and
    // queued `started`) before the response lands, and an event for an
    // untracked id would be dropped.
    this.#pending.push(request.speechId);
    try {
      await this.#transport.request(speechOutputSpeakOperation, {
        speechId: request.speechId,
        text: request.text,
        voice,
        rate,
      });
    } catch (cause) {
      this.#forget(request.speechId);
      throw remapSpeechFailure(cause, 'output');
    }
    this.#poller.start();
  }

  /**
   * Stops speech now.
   *
   * `stopped` is emitted for every discarded utterance from this response, so
   * the interruption path costs exactly one round trip (§17). Stopping an
   * utterance that is not queued is a no-op, not an error — the same
   * idempotence rule the input side follows, and for the same reason: a caller
   * tearing down cannot know whether the last chunk finished microseconds ago.
   */
  async stop(speechId?: SpeechId): Promise<void> {
    const response = await this.#transport.request(speechOutputStopOperation, {
      speechId: speechId ?? null,
    });
    for (const stopped of response.payload.stopped) {
      const id = stopped as SpeechId;
      if (this.#terminated.includes(id)) {
        continue;
      }
      this.#forget(id);
      this.#emitter.emit('event', { type: 'stopped', speechId: id });
    }
    if (this.#pending.length === 0) {
      this.#poller.stop();
    }
  }

  /** Drains the helper's event queue once, outside the schedule. */
  async refresh(): Promise<void> {
    await this.#poller.refresh();
  }

  /** Stops the poller and silences anything still queued. */
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#offTransportState();
    if (this.#pending.length > 0) {
      try {
        await this.#transport.request(speechOutputStopOperation, { speechId: null });
      } catch (error) {
        this.#logger.debug('stop during dispose failed', {
          code: error instanceof PilotError ? error.code : 'internal',
        });
      }
    }
    this.#pending.length = 0;
    this.#poller.stop();
    this.#emitter.clear();
  }

  // -------------------------------------------------------------------------

  async #drain(): Promise<void> {
    const response = await this.#transport.request(speechOutputPollOperation, {
      sinceSequence: this.#sinceSequence,
    });
    const payload = response.payload;

    if (payload.sequence < this.#sinceSequence) {
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

    if (this.#pending.length === 0 && !payload.speaking) {
      this.#poller.stop();
    }
  }

  #receive(event: SpeechOutputWireEvent): void {
    const speechId = event.speechId as SpeechId;
    if (this.#terminated.includes(speechId)) {
      // A second terminal event for the same utterance — the synthesiser
      // delegate and the helper's own reconciliation can both notice the same
      // ending. Exactly one reaches the caller.
      this.#droppedEvents += 1;
      this.#logger.debug('dropped a speech event', { event: event.type, speechId });
      return;
    }
    if (!this.#pending.includes(speechId) && event.type !== 'error') {
      this.#droppedEvents += 1;
      this.#logger.debug('dropped a speech event', {
        event: event.type,
        speechId,
        reason: 'unknown-utterance',
      });
      return;
    }

    switch (event.type) {
      case 'started':
        this.#emitter.emit('event', { type: 'started', speechId });
        return;
      case 'finished':
        this.#forget(speechId);
        this.#emitter.emit('event', { type: 'finished', speechId });
        return;
      case 'stopped':
        this.#forget(speechId);
        this.#emitter.emit('event', { type: 'stopped', speechId });
        return;
      case 'error':
        this.#forget(speechId);
        this.#emitter.emit('event', {
          type: 'error',
          speechId,
          error: toSpeechOutputError(event.code, event.message, { id: speechId }),
        });
        return;
    }
  }

  /** Removes an utterance from the pending list and records its ending. */
  #forget(speechId: SpeechId): void {
    const index = this.#pending.indexOf(speechId);
    if (index >= 0) {
      this.#pending.splice(index, 1);
    }
    if (!this.#terminated.includes(speechId)) {
      this.#terminated.push(speechId);
      while (this.#terminated.length > TERMINAL_LEDGER_SIZE) {
        this.#terminated.shift();
      }
    }
  }

  /**
   * A helper that died stopped speaking, whether or not anyone asked it to.
   *
   * Reported as `stopped` rather than `error`: nothing failed about the answer,
   * the audio simply ended. §16's "keep showing streamed text" holds either
   * way, and a caller waiting to queue the next chunk is released instead of
   * hanging.
   */
  #onTransportState(previous: HelperTransportState, state: HelperTransportState): void {
    if (previous !== 'ready' || state === 'ready' || this.#pending.length === 0) {
      return;
    }
    const orphaned = [...this.#pending];
    this.#sinceSequence = 0;
    this.#poller.stop();
    for (const speechId of orphaned) {
      this.#forget(speechId);
      this.#emitter.emit('event', { type: 'stopped', speechId });
    }
    this.#logger.warn('speech ended because the macOS helper stopped', {
      count: orphaned.length,
      transportState: state,
    });
  }
}
