import type { SpeechId, UtteranceId } from '@pilot/shared';
import type { SpeechInputEvent, SpeechOutputEvent } from '@pilot/platform';

/**
 * Everything the voice bindings refused to act on.
 *
 * PR-025 introduced this union for the *input* side and stated the principle:
 * a dropped adapter callback is reported, never silent (`docs/implementation.md`
 * delivery rules — "expose an explicit failure or unavailable state instead of
 * silently doing nothing"). PR-026 extends it, unchanged in shape, to the
 * symmetric output side: a TTS chunk that was discarded and a synthesiser
 * callback that was ignored.
 *
 * Diagnostics carry identifiers and counts, never answer text
 * (system-design §13, "never logged").
 */

// ---------------------------------------------------------------------------
// Speech input (PR-025)
// ---------------------------------------------------------------------------

/** Why an adapter event never reached the state machine. */
export type SpeechDiscardReason =
  /** No utterance is live; the adapter spoke about a question that is over. */
  | 'no-live-utterance'
  /** A different utterance is live now — a new push-to-talk superseded this one. */
  | 'superseded'
  /** The utterance was cancelled; system-design §15 says its results are discarded. */
  | 'cancelled'
  /** A transcript was already accepted for this utterance. */
  | 'already-finalized'
  /** The utterance already failed; a later result cannot revive it. */
  | 'already-failed'
  /** The binding never started this utterance. */
  | 'unknown-utterance';

/** Why an adapter call was not forwarded. */
export type SpeechCallIgnoredReason =
  'no-live-utterance' | 'superseded' | 'already-closed' | 'already-listening' | 'unknown-utterance';

// ---------------------------------------------------------------------------
// Speech output (PR-026)
// ---------------------------------------------------------------------------

/**
 * Why a chunk the machine asked for was never handed to the synthesiser.
 *
 * Every reason here is a way of saying "the stream this chunk belongs to is
 * over" — which is what makes "a late chunk from a superseded run is never
 * spoken" (system-design §15) true at the adapter layer as well as in the
 * machine's identity guard.
 */
export type SpeechChunkDiscardReason =
  /** Nothing is speaking, and this chunk belongs to no stream the binding knows. */
  | 'no-live-stream'
  /** A newer speech stream replaced this one. */
  | 'superseded'
  /** The stream was stopped — interruption, teardown, or a new question. */
  | 'stopped'
  /** The stream already drained and reported completion. */
  | 'already-finished'
  /** The synthesiser failed this stream; later chunks cannot revive it. */
  | 'already-failed'
  /** The binding is disposed. */
  | 'disposed';

/** Why a synthesiser callback did not become a machine event. */
export type SpeechOutputDiscardReason =
  | 'no-live-stream'
  | 'superseded'
  | 'stopped'
  | 'already-finished'
  | 'already-failed'
  | 'disposed'
  /** A callback for a chunk that already ended: a duplicate or out-of-order completion. */
  | 'stale-chunk'
  /** A callback about a chunk this binding never spoke. */
  | 'unknown-chunk'
  /** The binding asked for this stop, so the machine has already moved on. */
  | 'self-initiated';

/** Why a `speak` / `stop-speech` effect was not performed. */
export type SpeechOutputCallIgnoredReason =
  | 'no-live-stream'
  | 'superseded'
  | 'already-finished'
  | 'already-failed'
  | 'stopped'
  | 'disposed'
  /** The chunk was empty once trimmed; there is nothing to say. */
  | 'nothing-to-say';

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

export type VoiceDiagnostic =
  | {
      readonly kind: 'discarded-event';
      readonly event: SpeechInputEvent['type'];
      readonly utteranceId: UtteranceId;
      readonly reason: SpeechDiscardReason;
    }
  | {
      readonly kind: 'ignored-call';
      readonly call: 'start' | 'stop' | 'cancel';
      readonly utteranceId: UtteranceId;
      readonly reason: SpeechCallIgnoredReason;
    }
  | {
      readonly kind: 'discarded-chunk';
      readonly speechId: SpeechId;
      readonly utteranceId: UtteranceId;
      readonly sequence: number;
      /** Length only: the answer text itself is never written to a log (§13). */
      readonly characters: number;
      readonly reason: SpeechChunkDiscardReason;
    }
  | {
      readonly kind: 'discarded-speech-event';
      readonly event: SpeechOutputEvent['type'];
      /** The synthesiser's own identifier, which may name a chunk, not a stream. */
      readonly speechId: SpeechId;
      readonly reason: SpeechOutputDiscardReason;
    }
  | {
      readonly kind: 'ignored-speech-call';
      readonly call: 'speak' | 'stop';
      /** `null` for "stop whatever is speaking" (see `InteractionEffect`). */
      readonly speechId: SpeechId | null;
      readonly reason: SpeechOutputCallIgnoredReason;
    };

export const DEFAULT_DIAGNOSTIC_LIMIT = 64;

/** Bounded diagnostic log shared by both bindings. */
export class DiagnosticLog {
  readonly #entries: VoiceDiagnostic[] = [];
  readonly #limit: number;
  readonly #listener: ((diagnostic: VoiceDiagnostic) => void) | undefined;
  #total = 0;

  constructor(options: {
    readonly limit?: number;
    readonly onDiagnostic?: ((diagnostic: VoiceDiagnostic) => void) | undefined;
  }) {
    this.#limit = options.limit ?? DEFAULT_DIAGNOSTIC_LIMIT;
    this.#listener = options.onDiagnostic;
  }

  get entries(): readonly VoiceDiagnostic[] {
    return this.#entries;
  }

  /** Everything ever reported, including entries the bound has since dropped. */
  get total(): number {
    return this.#total;
  }

  report(diagnostic: VoiceDiagnostic): void {
    this.#total += 1;
    this.#entries.push(diagnostic);
    while (this.#entries.length > this.#limit) {
      this.#entries.shift();
    }
    this.#listener?.(diagnostic);
  }
}
