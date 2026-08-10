import type {
  ConversationId,
  InteractionState,
  ObservedWindow,
  PermissionSnapshot,
  SerializedPilotError,
  UtteranceId,
  WindowId,
} from '@pilot/shared';
import type { Subscribe } from './common.js';

/**
 * Interaction contracts.
 *
 * PROVISIONAL. Producer: `packages/interaction` (PR-006, PR-024…PR-027).
 * Consumer: `apps/desktop` (PR-008…PR-010). This is the E5 → E1 handoff named
 * in `dp/m1.md` ("`PilotViewState` and user-command facade").
 *
 * The state machine itself — the transition table from mvp-01 §7, stale-result
 * rejection, interruption — belongs to PR-006. PR-001 only fixes the command
 * vocabulary and the view-state shape so the renderer can be built against a
 * fake.
 */

export type InteractionCommand =
  | { readonly type: 'select-window'; readonly windowId: WindowId }
  | { readonly type: 'set-observation-enabled'; readonly enabled: boolean }
  | { readonly type: 'push-to-talk-down' }
  | { readonly type: 'push-to-talk-up' }
  | { readonly type: 'submit-text'; readonly text: string }
  /** The visible "Look now" action (runbook §5 amendment 1; implemented in PR-030). */
  | { readonly type: 'look-now' }
  | { readonly type: 'interrupt' }
  | { readonly type: 'stop-speaking' }
  | { readonly type: 'clear-conversation' }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  /**
   * Clears `lastError`. PR-006 contract change: `error` is a real state in the
   * mvp-01 §7 table and needs an explicit way out, and rejected commands report
   * themselves through `lastError` without changing state, so the shell needs a
   * way to acknowledge them too.
   */
  | { readonly type: 'dismiss-error' };

export interface TranscriptEntry {
  readonly utteranceId: UtteranceId;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly at: number;
  /** True while the text is still being streamed or transcribed. */
  readonly pending: boolean;
}

/** Everything the renderer needs in order to draw. Contains no image bytes. */
export interface PilotViewState {
  readonly state: InteractionState;
  readonly conversationId: ConversationId | null;
  readonly permissions: PermissionSnapshot | null;
  readonly selectedWindow: ObservedWindow | null;
  readonly observationEnabled: boolean;
  readonly speaking: boolean;
  /** Partial transcript of the utterance currently being recognised. */
  readonly liveTranscript: string | null;
  readonly transcript: readonly TranscriptEntry[];
  /**
   * The last failure *or* refused command. `state === 'error'` means the
   * failure was terminal for the current turn; otherwise this is a command the
   * controller refused (its `details.reason` names why) and the state is
   * unchanged. Cleared by `dismiss-error`.
   */
  readonly lastError: SerializedPilotError | null;
}

export interface InteractionController {
  snapshot(): PilotViewState;
  dispatch(command: InteractionCommand): void;
  subscribe: Subscribe<PilotViewState>;
  dispose(): Promise<void>;
}
