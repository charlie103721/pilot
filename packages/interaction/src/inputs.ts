import type {
  ObservationId,
  ObservedWindow,
  PermissionSnapshot,
  RunId,
  SerializedPilotError,
  SpeechId,
  ToolCallId,
  UtteranceId,
  WindowId,
} from '@pilot/shared';
import type { InteractionCommand } from '@pilot/platform';

/**
 * The input alphabet of the interaction state machine (system-design §7,
 * mvp-01 §7).
 *
 * There are two kinds of input:
 *
 * - **Commands** come from the user, through the desktop shell. They are the
 *   `InteractionCommand` union owned by `@pilot/platform`.
 * - **Events** come from the outside world — speech input, the agent run,
 *   speech output, the platform. They are declared here because the state
 *   machine is the only consumer.
 *
 * Every event that reports the *result* of something Pilot started carries the
 * identifier of the thing it belongs to (`utteranceId`, `runId`, `speechId`,
 * `observationId`, `windowId`). The machine checks that identifier against the
 * currently active one before it consults the transition table, so a result
 * belonging to a superseded utterance can never reach the table
 * (system-design §15: "Results from stale window selections, scene IDs, or
 * utterance IDs are discarded").
 */
export type InteractionEvent =
  /** The platform reported a new permission snapshot. */
  | { readonly type: 'permissions-changed'; readonly permissions: PermissionSnapshot }
  /** The observable window list changed. */
  | { readonly type: 'windows-changed'; readonly windows: readonly ObservedWindow[] }
  /** A window disappeared. Only the selected window is meaningful here. */
  | { readonly type: 'window-closed'; readonly windowId: WindowId }
  | { readonly type: 'screen-locked' }
  | { readonly type: 'screen-unlocked' }
  /** Speech-to-text: interim hypothesis for the active utterance. */
  | {
      readonly type: 'transcript-partial';
      readonly utteranceId: UtteranceId;
      readonly text: string;
    }
  /** Speech-to-text: the one accepted transcript for this utterance. */
  | { readonly type: 'transcript-final'; readonly utteranceId: UtteranceId; readonly text: string }
  | {
      readonly type: 'transcript-failed';
      readonly utteranceId: UtteranceId;
      readonly error: SerializedPilotError;
    }
  /** The agent accepted the question and gave the run an identifier. */
  | { readonly type: 'run-started'; readonly utteranceId: UtteranceId; readonly runId: RunId }
  | { readonly type: 'run-text-delta'; readonly runId: RunId; readonly text: string }
  | {
      readonly type: 'tool-started';
      readonly runId: RunId;
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
    }
  | {
      readonly type: 'tool-finished';
      readonly runId: RunId;
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      readonly error?: SerializedPilotError;
    }
  | { readonly type: 'run-completed'; readonly runId: RunId; readonly text: string }
  | { readonly type: 'run-aborted'; readonly runId: RunId; readonly reason: string }
  | { readonly type: 'run-failed'; readonly runId: RunId; readonly error: SerializedPilotError }
  /** Completion of a user-requested ("Look now") observation. */
  | {
      readonly type: 'observation-finished';
      readonly observationId: ObservationId;
      readonly error?: SerializedPilotError;
    }
  /**
   * PR-027: the fragment that started waiting at `pendingSince` has now waited
   * out its phrase timeout, so speak it rather than let it grow in silence.
   *
   * It carries an identity like every other result event: `pendingSince` is the
   * injected-clock reading the tail began waiting at, and the machine discards
   * the input unless that is still the tail it is holding. A timer that fires
   * after the fragment was spoken, replaced, or torn down is therefore
   * `stale-phrase-timeout` and does nothing — the same guard that makes a late
   * transcript harmless makes a late timer harmless.
   *
   * The machine still owns no timers: something outside decides *when* to send
   * this, exactly as something outside decides when a transcript arrives.
   * `PilotInteractionController` will do it when given a `Scheduler`.
   */
  | { readonly type: 'phrase-timeout'; readonly pendingSince: number }
  | { readonly type: 'speech-started'; readonly speechId: SpeechId }
  | { readonly type: 'speech-finished'; readonly speechId: SpeechId }
  | { readonly type: 'speech-stopped'; readonly speechId: SpeechId }
  | {
      readonly type: 'speech-failed';
      readonly speechId: SpeechId;
      readonly error: SerializedPilotError;
    }
  /** A recoverable failure reported by any subsystem (mvp-01 §7, last row). */
  | { readonly type: 'failure'; readonly error: SerializedPilotError };

export type InteractionInput = InteractionCommand | InteractionEvent;

export type InteractionCommandType = InteractionCommand['type'];
export type InteractionEventType = InteractionEvent['type'];
export type InteractionInputType = InteractionInput['type'];

export const INTERACTION_COMMAND_TYPES = [
  'select-window',
  'set-observation-enabled',
  'push-to-talk-down',
  'push-to-talk-up',
  'submit-text',
  'look-now',
  'interrupt',
  'stop-speaking',
  'clear-conversation',
  'pause',
  'resume',
  'dismiss-error',
] as const satisfies readonly InteractionCommandType[];

export const INTERACTION_EVENT_TYPES = [
  'permissions-changed',
  'windows-changed',
  'window-closed',
  'screen-locked',
  'screen-unlocked',
  'transcript-partial',
  'transcript-final',
  'transcript-failed',
  'run-started',
  'run-text-delta',
  'tool-started',
  'tool-finished',
  'run-completed',
  'run-aborted',
  'run-failed',
  'observation-finished',
  'phrase-timeout',
  'speech-started',
  'speech-finished',
  'speech-stopped',
  'speech-failed',
  'failure',
] as const satisfies readonly InteractionEventType[];

/** Every input the transition table must have an answer for. */
export const INTERACTION_INPUT_TYPES = [
  ...INTERACTION_COMMAND_TYPES,
  ...INTERACTION_EVENT_TYPES,
] as const;

/**
 * Compile-time proof that the two lists above are complete. If a command or
 * event is added to the union without being listed, these resolve to a
 * non-`never` type and the build fails.
 */
export type UnlistedCommandTypes = Exclude<
  InteractionCommandType,
  (typeof INTERACTION_COMMAND_TYPES)[number]
>;
export type UnlistedEventTypes = Exclude<
  InteractionEventType,
  (typeof INTERACTION_EVENT_TYPES)[number]
>;

type AssertNever<T extends never> = T;
export type CommandListIsComplete = AssertNever<UnlistedCommandTypes>;
export type EventListIsComplete = AssertNever<UnlistedEventTypes>;

export function isInteractionCommand(input: InteractionInput): input is InteractionCommand {
  return (INTERACTION_COMMAND_TYPES as readonly string[]).includes(input.type);
}
