import type { ObservationId, ObservedWindow, RunId, SpeechId, UtteranceId } from '@pilot/shared';
import type { InterruptMode } from '@pilot/platform';

/**
 * Effects are *data*, not calls.
 *
 * The machine is a pure function; it never touches an adapter. Every
 * side effect it wants performed is returned as one of these values, in the
 * order it must be performed. `InteractionRunner` (`controller.ts`) is the only
 * place that turns them into adapter calls, which is what makes the whole
 * transition table testable without any I/O.
 */
export type InteractionEffect =
  | { readonly type: 'start-capture'; readonly window: ObservedWindow }
  | { readonly type: 'stop-capture' }
  /** Drop every retained frame and audio buffer (system-design §11). */
  | { readonly type: 'clear-buffers' }
  | { readonly type: 'start-listening'; readonly utteranceId: UtteranceId }
  /** End capture and wait for the accepted transcript. */
  | { readonly type: 'stop-listening'; readonly utteranceId: UtteranceId }
  /** End capture and discard the utterance; no transcript is expected. */
  | { readonly type: 'cancel-listening'; readonly utteranceId: UtteranceId }
  | {
      readonly type: 'submit-question';
      readonly utteranceId: UtteranceId;
      readonly text: string;
      /** Push-to-talk down, or the moment a typed question was started (§6). */
      readonly utteranceStartedAt: number;
      /**
       * Utterance end. PR-024 anchors the envelope's pointer here, so it is
       * stamped by the machine's injected clock at transition time rather than
       * read again when the effect is finally performed.
       */
      readonly askedAt: number;
    }
  /**
   * Stop or steer the active agent run.
   *
   * `runId` is `null` when a question was submitted but the agent has not
   * reported a run identifier yet; `interrupt()` is safe in that case, but it is
   * also a no-op, which is why `PilotInteractionController` additionally aborts
   * the `AbortSignal` it passed to `submit()` (PR-027).
   *
   * `reason` is the `detail` argument of `AgentSession.interrupt`, and its
   * audience depends on `mode`: with `'abort'` it is an internal string that
   * never reaches the model, with `'steer'` it is **injected into the transcript
   * as a user message verbatim**. The machine writes each accordingly — see
   * `STEER_INTERRUPTION_MESSAGE` in `table.ts`.
   */
  | {
      readonly type: 'interrupt-run';
      readonly runId: RunId | null;
      readonly mode: InterruptMode;
      readonly reason: string;
    }
  | {
      readonly type: 'request-observation';
      readonly observationId: ObservationId;
      readonly reason: 'manual';
    }
  /**
   * Say one chunk of a speech stream.
   *
   * system-design §15 gives a TTS *stream* one identifier, and PR-026 speaks a
   * streamed answer as several chunks under that one `speechId`: the binding
   * queues them and plays them in order. `sequence` and `final` are optional so
   * a single-chunk answer — the shape PR-006 emitted — still typechecks and
   * behaves identically.
   */
  | {
      readonly type: 'speak';
      readonly speechId: SpeechId;
      readonly utteranceId: UtteranceId;
      readonly text: string;
      /** Position within the stream, 0-based. Defaults to append order. */
      readonly sequence?: number;
      /**
       * No further chunks will be appended to this stream. The binding reports
       * `speech-finished` only after a final chunk has drained, which is what
       * stops an early per-chunk completion from ending the turn mid-answer.
       * A final chunk with empty `text` closes a stream that has nothing left
       * to say.
       */
      readonly final?: boolean;
    }
  /** `null` means "stop whatever is speaking". Must be immediate. */
  | { readonly type: 'stop-speech'; readonly speechId: SpeechId | null }
  | { readonly type: 'clear-conversation' };

export type InteractionEffectType = InteractionEffect['type'];
