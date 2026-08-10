import type {
  ConversationId,
  ModelProfile,
  QuestionEnvelope,
  RunId,
  SerializedPilotError,
  ToolCallId,
} from '@pilot/shared';
import type { Subscribe } from './common.js';

/**
 * Agent session facade.
 *
 * PROVISIONAL (runbook §5 amendment 4). `docs/system-design.md` §8 describes
 * responsibilities, not an API, and the real Pi surface is unknown until the
 * PR-005 spike lands. This facade is intentionally the smallest thing the
 * interaction lane (E5) and the desktop lane (E1) need in order to compile and
 * to run against a fake:
 *
 *   submit a question → receive streamed events → interrupt.
 *
 * Nothing here names a Pi type. PR-005 and PR-020…PR-023 own the real
 * implementation and are expected to extend this interface; consumers should
 * not assume the event list is closed.
 */

export type AgentEvent =
  | { readonly type: 'run-started'; readonly runId: RunId; readonly utteranceId: string }
  | { readonly type: 'text-delta'; readonly runId: RunId; readonly text: string }
  | {
      readonly type: 'tool-started';
      readonly runId: RunId;
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
    }
  | {
      readonly type: 'tool-succeeded';
      readonly runId: RunId;
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
    }
  | {
      readonly type: 'tool-failed';
      readonly runId: RunId;
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      readonly error: SerializedPilotError;
    }
  | { readonly type: 'run-completed'; readonly runId: RunId; readonly text: string }
  | { readonly type: 'run-aborted'; readonly runId: RunId; readonly reason: string }
  | { readonly type: 'run-failed'; readonly runId: RunId; readonly error: SerializedPilotError };

export interface AgentRunHandle {
  readonly runId: RunId;
  /** Resolves when the run reaches a terminal event. */
  readonly completed: Promise<void>;
}

export type InterruptMode =
  /** Abort the active run and drop its remaining output. */
  | 'abort'
  /** Let the active run finish its tool work but replace the pending question. */
  | 'steer';

export interface AgentSession {
  readonly conversationId: ConversationId;
  readonly profile: ModelProfile;
  /**
   * Starts a run for one question envelope. Only one run may be active per
   * conversation (system-design §15); a second call while a run is active
   * rejects with `run-already-active`.
   */
  submit(envelope: QuestionEnvelope, signal?: AbortSignal): Promise<AgentRunHandle>;
  /** Stops or steers the active run. Safe to call when no run is active. */
  interrupt(mode: InterruptMode, reason: string): Promise<void>;
  subscribe: Subscribe<AgentEvent>;
  /** Releases the session. Text state may be persisted; images never are. */
  dispose(): Promise<void>;
}

export interface AgentSessionFactory {
  create(conversationId: ConversationId, profile: ModelProfile): Promise<AgentSession>;
}
