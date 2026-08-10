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
    }
  /**
   * Stop or steer the active agent run. `runId` is `null` when a question was
   * submitted but the agent has not reported a run identifier yet; the adapter
   * contract makes `interrupt()` safe in that case.
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
  | {
      readonly type: 'speak';
      readonly speechId: SpeechId;
      readonly utteranceId: UtteranceId;
      readonly text: string;
    }
  /** `null` means "stop whatever is speaking". Must be immediate. */
  | { readonly type: 'stop-speech'; readonly speechId: SpeechId | null }
  | { readonly type: 'clear-conversation' };

export type InteractionEffectType = InteractionEffect['type'];
