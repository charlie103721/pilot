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
 * RESHAPED BY PR-005 against the pinned Pi release
 * (`@earendil-works/pi-agent-core@0.84.1`). Every type here now has a verified
 * counterpart in that release — see `docs/pi-notes.md` for the mapping table
 * and for the API surface Pi does *not* provide.
 *
 * The reshape is deliberately **source-compatible** with PR-001's provisional
 * shape: no member was removed and no existing signature changed arity or
 * types, so PR-002 and PR-006 keep compiling. What changed is:
 *
 *  - `interrupt(mode, detail)` — parameter renamed from `reason` to `detail`
 *    and its meaning is now pinned to verified behaviour (see below). Same
 *    arity and types, so callers are unaffected.
 *  - Added `AgentEvent` members `tool-progress` and `context-compacted`.
 *  - Added the tool contract (`AgentToolDefinition`, `AgentToolResult`,
 *    `AgentToolContent`) that PR-021 needs; PR-001 had none.
 *  - Added `AgentSessionCapabilities` and `AgentSession.capabilities`.
 *  - Corrected the `dispose()` retention comment: Pi's session storage
 *    serializes image blocks verbatim, so "images are never persisted" is a
 *    property of *Pilot's* writer, not of Pi. See `docs/pi-notes.md` §5.
 *
 * Nothing here names a Pi type. `@pilot/agent` holds the Pi-backed
 * implementation; `@pilot/platform/fakes` holds the deterministic one.
 */

/**
 * A block a tool may hand back to the model.
 *
 * Verified against `@earendil-works/pi-ai` `TextContent` / `ImageContent`
 * (`dist/types.d.ts:227` and `:241`): a tool result content array is exactly
 * `(TextContent | ImageContent)[]`, and an image block is
 * `{ type: "image", data: <base64, no data: prefix>, mimeType: string }`.
 */
export type AgentToolContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly base64: string; readonly mimeType: string };

/**
 * What a tool returns.
 *
 * Maps to Pi's `AgentToolResult<TDetails>`
 * (`@earendil-works/pi-agent-core` `dist/types.d.ts`). `details` is *not* sent
 * to the model; Pi carries it on the tool-result message for UI and audit.
 * A failing tool throws instead of setting a flag — Pi converts the thrown
 * error into `{ isError: true, content: [{ type: "text", text: message }] }`.
 */
export interface AgentToolResult {
  readonly content: readonly AgentToolContent[];
  readonly details?: unknown;
}

/**
 * A tool Pilot registers on a session.
 *
 * `parameters` is a JSON Schema object. Pi types this as a TypeBox `TSchema`
 * and validates arguments before `execute` runs; a plain JSON Schema object
 * literal is accepted at runtime. PR-021 owns the concrete `observe_screen`
 * schema.
 */
export interface AgentToolDefinition {
  readonly name: string;
  /** Human-readable label for UI display (Pi requires this field). */
  readonly label: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(
    toolCallId: ToolCallId,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<AgentToolResult> | AgentToolResult;
}

/**
 * Capability gate applied before a visual conversation starts
 * (system-design §12).
 *
 * VERIFIED CAVEAT: Pi's `Model` exposes `input: ("text" | "image")[]`, which
 * gives `vision` truthfully, but carries **no tool-support metadata at all**.
 * `tools` therefore cannot be read from Pi and must be configured per profile.
 * `docs/pi-notes.md` §6 records this contradiction with system-design §12.
 */
export interface AgentSessionCapabilities {
  /** Derived from Pi model metadata. Trustworthy. */
  readonly vision: boolean;
  /** NOT derived from Pi. Comes from Pilot's own profile configuration. */
  readonly tools: boolean;
}

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
      /** Partial tool output. Maps to Pi `tool_execution_update`. */
      readonly type: 'tool-progress';
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
  | {
      /**
       * Durable history was replaced by a summary (system-design §11).
       * Pi has no compaction *event*; Pilot emits this when it drives Pi's
       * compaction primitives itself.
       */
      readonly type: 'context-compacted';
      readonly runId: RunId;
      readonly summary: string;
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
   * Capability gate result for this session's profile. Present so callers do
   * not have to re-derive it; see {@link AgentSessionCapabilities} for what is
   * and is not verifiable from Pi.
   */
  readonly capabilities?: AgentSessionCapabilities;
  /**
   * Starts a run for one question envelope. Only one run may be active per
   * conversation (system-design §15); a second call while a run is active
   * rejects with `run-already-active`.
   *
   * VERIFIED: Pi enforces this itself — `Agent.prompt()` rejects with
   * "Agent is already processing a prompt" when a run is in flight.
   */
  submit(envelope: QuestionEnvelope, signal?: AbortSignal): Promise<AgentRunHandle>;
  /**
   * Stops or steers the active run. Safe to call when no run is active.
   *
   * `detail` is mode-dependent, matching verified Pi behaviour:
   *  - `'abort'`: an internal reason string, surfaced on `run-aborted`. Pi's
   *    `Agent.abort()` takes no argument, so this never reaches the model.
   *  - `'steer'`: the replacement question text. Pi's `Agent.steer()` takes a
   *    whole message and injects it into the transcript at the next drain
   *    point, so this string **is sent to the model verbatim**.
   */
  interrupt(mode: InterruptMode, detail: string): Promise<void>;
  subscribe: Subscribe<AgentEvent>;
  /**
   * Releases the session.
   *
   * Text state may be persisted. Image blocks must not be: Pi's session
   * storage JSON-serializes whatever message it is given, so keeping image
   * bytes off disk is the *implementation's* job, not Pi's
   * (`docs/pi-notes.md` §5).
   */
  dispose(): Promise<void>;
}

export interface AgentSessionFactory {
  create(conversationId: ConversationId, profile: ModelProfile): Promise<AgentSession>;
}
