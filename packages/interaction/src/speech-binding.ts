import { type InteractionState, type UtteranceId } from '@pilot/shared';
import type { SpeechInputAdapter, SpeechInputEvent, Unsubscribe } from '@pilot/platform';
import { lookupRule } from './table.js';
import {
  DEFAULT_DIAGNOSTIC_LIMIT,
  type SpeechCallIgnoredReason,
  type SpeechDiscardReason,
  type VoiceDiagnostic,
} from './voice-diagnostics.js';

/**
 * PR-025 — the speech-input binding.
 *
 * The machine (PR-006) says *when* to listen; it returns `start-listening`,
 * `stop-listening` and `cancel-listening` as **data**. This is the only place
 * those become `SpeechInputAdapter` calls, and the only place adapter callbacks
 * become machine events.
 *
 * ## Why a binding exists at all
 *
 * The machine already discards results from a superseded utterance
 * (system-design §15, `staleReason()` runs before the transition table). That
 * guard is necessary but it is not the whole story, because it can only see
 * inputs that reach it. Two things it cannot express live here:
 *
 * 1. **A dead utterance must not reach the machine in the first place.** The
 *    binding owns one live utterance at a time. Anything an adapter says about
 *    any other utterance — a callback that fired after `cancel`, a second
 *    `final`, a result from a recogniser that was superseded three questions
 *    ago — is dropped here, counted, and reported as a diagnostic. Defence in
 *    depth: PR-014 will replace the fake with Apple Speech, whose callbacks
 *    arrive on their own schedule and are not obliged to be well behaved.
 *
 * 2. **Teardown must be idempotent.** A recogniser is allowed to finalise on
 *    its own before push-to-talk is released (endpointing), which leaves the
 *    machine emitting `stop-listening` for an utterance the adapter has already
 *    closed. Forwarding that would make the adapter throw, the controller would
 *    turn the throw into `failure`, and a question that was *successfully
 *    submitted* would land the user in `error`. So calls for an utterance that
 *    is not open are no-ops, recorded rather than performed.
 *
 * No clock and no timers: like everything else in this lane, the binding is
 * driven entirely by the calls and callbacks it is given.
 */

export interface SpeechInputBindingOptions {
  readonly speechInput: SpeechInputAdapter;
  /** Accepted events, already proven to belong to the live utterance. */
  readonly onEvent: (event: SpeechInputEvent) => void;
  /** Everything that was dropped. Never silent (`implementation.md` delivery rules). */
  readonly onDiagnostic?: (diagnostic: VoiceDiagnostic) => void;
  /** Refuse to record unless recognition runs on device (system-design §11). */
  readonly requireOnDevice?: boolean;
  readonly locale?: string;
  /** Most recent diagnostics retained for inspection. */
  readonly diagnosticLimit?: number;
}

/** How far an utterance has got, from the binding's point of view. */
type UtterancePhase =
  /** Recording; partials, a final or an error may still arrive. */
  | 'open'
  /** `stop()` was forwarded; the accepted transcript is still expected. */
  | 'closing'
  /** Terminal: nothing this utterance says will ever be forwarded again. */
  | 'finished';

interface LiveUtterance {
  readonly utteranceId: UtteranceId;
  phase: UtterancePhase;
  /**
   * True while the adapter may still hold the microphone for this utterance.
   *
   * A `final` clears it — recognition completed by itself. An `error` does
   * **not**: system-design §16 says audio is preserved only until failure
   * handling completes, so the machine's `cancel-listening` must still reach
   * the adapter and release the session.
   */
  adapterOpen: boolean;
  /** Retirement reason, used to explain later events about this utterance. */
  retiredBecause: SpeechDiscardReason | null;
}

export class SpeechInputBinding {
  readonly #adapter: SpeechInputAdapter;
  readonly #onEvent: (event: SpeechInputEvent) => void;
  readonly #onDiagnostic: ((diagnostic: VoiceDiagnostic) => void) | undefined;
  readonly #requireOnDevice: boolean;
  readonly #locale: string | undefined;
  readonly #diagnosticLimit: number;
  readonly #unsubscribe: Unsubscribe;

  readonly #diagnostics: VoiceDiagnostic[] = [];
  /** Utterances the binding has seen, oldest first, bounded like the log. */
  readonly #history: LiveUtterance[] = [];
  #live: LiveUtterance | null = null;
  #discardedCount = 0;
  #ignoredCallCount = 0;
  #disposed = false;

  constructor(options: SpeechInputBindingOptions) {
    this.#adapter = options.speechInput;
    this.#onEvent = options.onEvent;
    this.#onDiagnostic = options.onDiagnostic;
    this.#requireOnDevice = options.requireOnDevice ?? true;
    this.#locale = options.locale;
    this.#diagnosticLimit = options.diagnosticLimit ?? DEFAULT_DIAGNOSTIC_LIMIT;
    this.#unsubscribe = this.#adapter.subscribe((event) => {
      this.#receive(event);
    });
  }

  /** The one utterance whose results are accepted, or `null`. */
  get liveUtteranceId(): UtteranceId | null {
    return this.#live !== null && this.#live.phase !== 'finished' ? this.#live.utteranceId : null;
  }

  /** True while the adapter may still be holding the microphone. */
  get recording(): boolean {
    return this.#live?.adapterOpen === true;
  }

  get diagnostics(): readonly VoiceDiagnostic[] {
    return this.#diagnostics;
  }

  get discardedEventCount(): number {
    return this.#discardedCount;
  }

  get ignoredCallCount(): number {
    return this.#ignoredCallCount;
  }

  // -- effects --------------------------------------------------------------

  /**
   * `start-listening`. Exactly one utterance can be open, so a previous one is
   * cancelled first — the adapter is never asked to run two recognisers, even
   * if a caller somehow skipped the machine's teardown.
   */
  async start(utteranceId: UtteranceId): Promise<void> {
    if (this.#disposed) {
      this.#ignoredCall('start', utteranceId, 'already-closed');
      return;
    }
    const live = this.#live;
    if (live !== null && live.utteranceId === utteranceId && live.phase !== 'finished') {
      this.#ignoredCall('start', utteranceId, 'already-listening');
      return;
    }
    if (live !== null && live.adapterOpen) {
      await this.cancel(live.utteranceId);
    }

    // Registered *before* the adapter call: a recogniser is allowed to emit its
    // first partial from inside `start()`, and that partial is not stale.
    const entry: LiveUtterance = {
      utteranceId,
      phase: 'open',
      adapterOpen: true,
      retiredBecause: null,
    };
    this.#live = entry;
    this.#remember(entry);
    try {
      await this.#adapter.start({
        utteranceId,
        requireOnDevice: this.#requireOnDevice,
        ...(this.#locale === undefined ? {} : { locale: this.#locale }),
      });
    } catch (cause) {
      // The utterance never began. Retire it here so that an adapter which
      // reports the failure twice — throw *and* callback — cannot make the
      // machine handle it twice.
      this.#retire(entry, 'already-failed', { adapterOpen: false });
      throw cause;
    }
  }

  /**
   * `stop-listening`: end capture and wait for the accepted transcript.
   *
   * A no-op unless this utterance is the open one. That is what makes a
   * recogniser which finalised early (or failed) harmless instead of fatal.
   */
  async stop(utteranceId: UtteranceId): Promise<void> {
    const live = this.#live;
    if (live === null || live.utteranceId !== utteranceId) {
      this.#ignoredCall('stop', utteranceId, this.#callReason(utteranceId));
      return;
    }
    if (!live.adapterOpen || live.phase !== 'open') {
      this.#ignoredCall('stop', utteranceId, 'already-closed');
      return;
    }
    live.phase = 'closing';
    await this.#adapter.stop(utteranceId);
  }

  /**
   * `cancel-listening`: end capture and discard the utterance.
   *
   * Everything the adapter says about it afterwards is dropped here, so a
   * cancelled utterance can never become a question — the property system-design
   * §15 asks for, enforced one layer below the machine that also enforces it.
   */
  async cancel(utteranceId: UtteranceId): Promise<void> {
    const live = this.#live;
    if (live === null || live.utteranceId !== utteranceId) {
      this.#ignoredCall('cancel', utteranceId, this.#callReason(utteranceId));
      return;
    }
    const wasOpen = live.adapterOpen;
    // An utterance that already failed keeps that reason: the cancel is the
    // release of its audio session, not a new fate.
    this.#retire(live, live.retiredBecause ?? 'cancelled', { adapterOpen: false });
    if (!wasOpen) {
      this.#ignoredCall('cancel', utteranceId, 'already-closed');
      return;
    }
    await this.#adapter.cancel(utteranceId);
  }

  /** Unsubscribe and release the microphone if anything is still open. */
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribe();
    const live = this.#live;
    if (live !== null && live.adapterOpen) {
      this.#retire(live, 'cancelled', { adapterOpen: false });
      await this.#adapter.cancel(live.utteranceId);
    }
  }

  // -- inbound --------------------------------------------------------------

  #receive(event: SpeechInputEvent): void {
    const live = this.#live;
    if (this.#disposed || live === null || live.utteranceId !== event.utteranceId) {
      this.#discard(event, this.#eventReason(event.utteranceId));
      return;
    }
    if (live.phase === 'finished') {
      this.#discard(event, live.retiredBecause ?? 'no-live-utterance');
      return;
    }

    switch (event.type) {
      case 'partial':
        break;
      case 'final':
        // One accepted transcript per utterance (system-design §7). The adapter
        // is finished with the audio session by definition.
        this.#retire(live, 'already-finalized', { adapterOpen: false });
        break;
      case 'error':
        // Keep `adapterOpen`: §16 wants the audio released explicitly, and the
        // machine answers a failure with `cancel-listening`.
        this.#retire(live, 'already-failed', { adapterOpen: true });
        break;
    }
    this.#onEvent(event);
  }

  // -- bookkeeping ----------------------------------------------------------

  #retire(
    entry: LiveUtterance,
    reason: SpeechDiscardReason,
    options: { readonly adapterOpen: boolean },
  ): void {
    entry.phase = 'finished';
    entry.adapterOpen = options.adapterOpen;
    entry.retiredBecause = reason;
  }

  #find(utteranceId: UtteranceId): LiveUtterance | undefined {
    return this.#history.find((entry) => entry.utteranceId === utteranceId);
  }

  #eventReason(utteranceId: UtteranceId): SpeechDiscardReason {
    const known = this.#find(utteranceId);
    if (known === undefined) {
      return 'unknown-utterance';
    }
    if (known.retiredBecause !== null) {
      return known.retiredBecause;
    }
    return this.#live === null ? 'no-live-utterance' : 'superseded';
  }

  #callReason(utteranceId: UtteranceId): SpeechCallIgnoredReason {
    if (this.#find(utteranceId) === undefined) {
      return 'unknown-utterance';
    }
    return this.#live === null ? 'no-live-utterance' : 'superseded';
  }

  #remember(entry: LiveUtterance): void {
    this.#history.push(entry);
    while (this.#history.length > this.#diagnosticLimit) {
      this.#history.shift();
    }
  }

  #discard(event: SpeechInputEvent, reason: SpeechDiscardReason): void {
    this.#discardedCount += 1;
    this.#report({
      kind: 'discarded-event',
      event: event.type,
      utteranceId: event.utteranceId,
      reason,
    });
  }

  #ignoredCall(
    call: 'start' | 'stop' | 'cancel',
    utteranceId: UtteranceId,
    reason: SpeechCallIgnoredReason,
  ): void {
    this.#ignoredCallCount += 1;
    this.#report({ kind: 'ignored-call', call, utteranceId, reason });
  }

  #report(diagnostic: VoiceDiagnostic): void {
    this.#diagnostics.push(diagnostic);
    while (this.#diagnostics.length > this.#diagnosticLimit) {
      this.#diagnostics.shift();
    }
    this.#onDiagnostic?.(diagnostic);
  }
}

/**
 * Can the user type a question right now?
 *
 * system-design §16: "STT fails → preserve audio only until failure handling
 * completes, then offer text input." The renderer needs to know when to offer
 * it, and the honest answer is whatever the transition table says — asking the
 * table means the affordance and the machine can never disagree. In particular
 * this is `true` in `error`, which is where a failed recogniser leaves Pilot.
 */
export function isTextFallbackAvailable(state: InteractionState): boolean {
  return lookupRule(state, 'submit-text').kind === 'accept';
}
