import type { AgentMessage, Entry, Session } from '@earendil-works/pi-agent-core';
import type { CompactionState, CompactionSummary, QuestionRecord } from './compaction.js';
import { createDurableTranscriptSink } from './durable-transcript.js';
import type { TranscriptSink } from './session.js';

/**
 * Durable conversation state, backed by a Pi `Session` (PR-023).
 *
 * system-design §13 persists "text conversation sessions and summaries" and
 * never persists base64 images, raw audio or credentials. §11 adds that the
 * durable transcript is *complete* — compaction is provider-facing only and
 * never touches `agent.state.messages` — so restoring a conversation needs two
 * things, not one:
 *
 *  1. the text-only transcript, written through the sanitising sink that
 *     {@link createDurableTranscriptSink} builds, and
 *  2. the compaction snapshot: `{ generation, boundaryIndex, summary }`, where
 *     `boundaryIndex` indexes the *unmodified* transcript.
 *
 * Restore only (1) and the session comes back with no summary and re-sends the
 * whole history to the provider — the failure `docs/runbook.md` follow-up 8
 * exists to prevent.
 *
 * Everything here is backend-agnostic: it talks to a `Session`, which both the
 * SQLite and the JSONL repositories return. `session-backends.ts` opens one.
 */

/**
 * Custom-entry type under which the compaction snapshot is written.
 *
 * Namespaced because the entry log is shared with Pi's own entry types
 * (`message`, `compaction`, `branch_summary`, …). Pilot deliberately does
 * *not* use Pi's `compaction` entry: that type requires `retainedTail` — a
 * verbatim copy of the messages it retained — which would duplicate the
 * transcript on disk for no benefit, and Pilot's compaction is a pure function
 * of the transcript plus a boundary index.
 */
export const PILOT_COMPACTION_ENTRY_TYPE = 'pilot.compaction.v1';

/** The compaction state as it is written to disk. */
export interface CompactionSnapshot {
  readonly generation: number;
  /** First transcript message *not* folded into {@link summary}. */
  readonly boundaryIndex: number;
  readonly summary: CompactionSummary;
  /** Total observations counted when the fold happened. */
  readonly observationsAtLastCompaction: number;
  /**
   * Timestamp of the summary message the controller injects, so a restored
   * session rebuilds a byte-identical provider context rather than a
   * same-text-different-timestamp one.
   */
  readonly summaryTimestamp: number;
  /**
   * Question records for turns *after* the boundary — the ones a future
   * summary will quote. Not needed to reproduce the current context; needed so
   * the next compaction after a restart is as good as it would have been.
   */
  readonly questions: readonly QuestionRecord[];
}

/** What a restore hands back to {@link PiAgentSession}. */
export interface RestoredConversation {
  /** Text-only transcript, in transcript order. Never contains image bytes. */
  readonly messages: readonly AgentMessage[];
  /** Absent when the conversation was never compacted, or when repair ran. */
  readonly compaction?: CompactionSnapshot;
  /**
   * Message entries found on disk, including any that {@link repairTranscript}
   * dropped. This — not `messages.length` — is where the session resumes
   * appending, because the durable log is append-only.
   */
  readonly persistedMessageCount: number;
  /** How many entries structural repair removed. Zero for anything Pilot wrote. */
  readonly repairedMessages: number;
}

/** An empty conversation. Returned for a store that has never been written to. */
export const EMPTY_CONVERSATION: RestoredConversation = {
  messages: [],
  persistedMessageCount: 0,
  repairedMessages: 0,
};

/**
 * Durable store for exactly one conversation.
 *
 * Deliberately small: a write path, a summary path, a read path, a delete path
 * and a close. It is the only thing `PiAgentSession` needs to know about
 * storage, and it is the only place Pilot writes to disk.
 */
export interface ConversationStore {
  /**
   * The sanitising, text-only write path. Every message goes through
   * `stripImageBlocks` then `toDurablePayload` before it reaches the backend.
   */
  readonly transcript: TranscriptSink;
  /** Persist the compaction snapshot alongside the transcript. */
  saveCompaction(state: CompactionState): Promise<void>;
  /** Read back transcript + summary + boundary. */
  restore(): Promise<RestoredConversation>;
  /**
   * Clear conversation: remove every durable trace of it and leave an empty,
   * writable store behind.
   */
  clear(): Promise<void>;
  /**
   * Release the backend, including the SQLite writer lease. Idempotent.
   *
   * This is exactly what `SqliteSessionRepository[Symbol.asyncDispose]()`
   * calls; the alias is not re-exported here because the repo's TypeScript
   * `lib` is ES2023 and does not declare `Symbol.asyncDispose`.
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// JSON safety
// ---------------------------------------------------------------------------

/**
 * Generic sibling of `toDurablePayload`.
 *
 * `Session.appendCustomEntry` runs the same `assertJsonSerializable` as
 * `appendMessage` and throws `SessionError("invalid_payload")` on any
 * `undefined` at any depth (`docs/pi-notes.md` §3.3). A `CompactionSummary`
 * carries an optional `supersededBy`, and `exactOptionalPropertyTypes` keeps
 * *us* from writing an explicit `undefined` — but a summary that came back
 * from an older snapshot, or from a caller outside TypeScript, can. One JSON
 * round trip removes the whole class of failure.
 */
export function toDurableJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Transcript repair
// ---------------------------------------------------------------------------

interface ToolCallBlock {
  readonly type: 'toolCall';
  readonly id: string;
}

function messageRole(message: AgentMessage): string | undefined {
  const role = (message as { role?: unknown }).role;
  return typeof role === 'string' ? role : undefined;
}

function toolCallIdsOf(message: AgentMessage): string[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter(
      (block): block is ToolCallBlock =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'toolCall' &&
        typeof (block as { id?: unknown }).id === 'string',
    )
    .map((block) => block.id);
}

/**
 * Removes the structurally impossible from a restored transcript.
 *
 * In practice this drops nothing, and that is a property of *when* Pilot
 * writes rather than of what it writes: `PiAgentSession` persists at
 * `turn_end` and `agent_end` only, and a Pi turn ends after its tool results
 * are in the transcript. A crash therefore truncates the durable log at a turn
 * boundary, never in the middle of one.
 *
 * It runs anyway because the consequence of being wrong is a provider error on
 * the user's next question — an assistant message whose tool calls have no
 * results is rejected outright by several providers — and because a session
 * file is a file: it can be truncated by a full disk, copied mid-write, or
 * written by a future version of this code.
 *
 * Two rules, applied over the whole list rather than just its tail, so the
 * function is idempotent even after a repaired transcript is appended to:
 *  1. an assistant message with a tool call that no later message answers is
 *     dropped;
 *  2. a tool result answering no surviving tool call is dropped.
 *
 * A transcript that *ends* with a user message is deliberately left alone. It
 * means a question was recorded and never answered, and restoring it is the
 * kinder reading of both possibilities: the model sees a question the user
 * really did ask, rather than Pilot quietly deleting the user's own words on
 * the strength of a guess about why the process stopped.
 */
export function repairTranscript(messages: readonly AgentMessage[]): {
  readonly messages: AgentMessage[];
  readonly dropped: number;
} {
  const answered = new Set<string>();
  for (const message of messages) {
    if (messageRole(message) === 'toolResult') {
      const id = (message as { toolCallId?: unknown }).toolCallId;
      if (typeof id === 'string') {
        answered.add(id);
      }
    }
  }

  const kept: AgentMessage[] = [];
  const liveToolCalls = new Set<string>();
  for (const message of messages) {
    const role = messageRole(message);
    if (role === 'assistant') {
      const calls = toolCallIdsOf(message);
      if (calls.some((id) => !answered.has(id))) {
        continue;
      }
      for (const id of calls) {
        liveToolCalls.add(id);
      }
      kept.push(message);
      continue;
    }
    if (role === 'toolResult') {
      const id = (message as { toolCallId?: unknown }).toolCallId;
      if (typeof id !== 'string' || !liveToolCalls.has(id)) {
        continue;
      }
      kept.push(message);
      continue;
    }
    kept.push(message);
  }

  return { messages: kept, dropped: messages.length - kept.length };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function isCompactionSnapshot(value: unknown): value is CompactionSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<CompactionSnapshot>;
  return (
    typeof candidate.generation === 'number' &&
    typeof candidate.boundaryIndex === 'number' &&
    Number.isInteger(candidate.boundaryIndex) &&
    candidate.boundaryIndex >= 0 &&
    typeof candidate.summary === 'object' &&
    candidate.summary !== null &&
    typeof (candidate.summary as CompactionSummary).text === 'string'
  );
}

/**
 * Reads transcript + summary + boundary back off a Pi `Session`.
 *
 * The compaction snapshot is dropped rather than trusted when it cannot
 * possibly line up with the transcript that was read — a boundary past the end
 * of the transcript, or a transcript that repair had to change. Losing a
 * summary costs one larger provider request; folding at the wrong index would
 * silently delete real turns from the model's view.
 */
export async function readDurableConversation(session: Session): Promise<RestoredConversation> {
  // VERIFIED: the SQLite backend defaults to `newestFirst`
  // (`storage/entries.js`), so transcript order is not the default — it has to
  // be asked for. The JSONL backend honours the same option.
  const entries: Entry[] = await session.findEntries({ order: 'oldestFirst' });

  const persisted: AgentMessage[] = [];
  let snapshot: CompactionSnapshot | undefined;
  for (const entry of entries) {
    if (entry.type === 'message') {
      persisted.push(entry.message);
      continue;
    }
    if (entry.type === 'custom' && entry.customType === PILOT_COMPACTION_ENTRY_TYPE) {
      // Last one wins: each compaction generation appends a new snapshot, and
      // the newest is the only one that describes the current boundary.
      if (isCompactionSnapshot(entry.data)) {
        snapshot = entry.data;
      }
    }
  }

  const repaired = repairTranscript(persisted);
  const usable =
    snapshot !== undefined && repaired.dropped === 0 && snapshot.boundaryIndex <= persisted.length
      ? snapshot
      : undefined;

  return {
    messages: repaired.messages,
    ...(usable === undefined ? {} : { compaction: usable }),
    persistedMessageCount: persisted.length,
    repairedMessages: repaired.dropped,
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** Backend-specific halves of a {@link ConversationStore}. */
export interface SessionStoreHooks {
  /**
   * Destroys the durable data and returns the `Session` to write into
   * afterwards. Deleting is the backend's job: a `Session` can only append.
   */
  clear(): Promise<Session>;
  close(): Promise<void>;
}

/**
 * Wraps a Pi `Session` as a {@link ConversationStore}.
 *
 * The transcript sink is rebuilt whenever `clear()` swaps the session, so a
 * caller that captured `store.transcript` before a clear keeps writing to the
 * live session rather than to a deleted one.
 */
export function createConversationStore(
  session: Session,
  hooks: SessionStoreHooks,
): ConversationStore {
  let current = session;
  let sink = createDurableTranscriptSink(current);
  let closed = false;

  return {
    transcript: {
      append: async (message: AgentMessage): Promise<void> => {
        await sink.append(message);
      },
    },

    async saveCompaction(state: CompactionState): Promise<void> {
      if (state.summary === undefined) {
        return;
      }
      const snapshot: CompactionSnapshot = {
        generation: state.generation,
        boundaryIndex: state.boundaryIndex,
        summary: state.summary,
        observationsAtLastCompaction: state.observationsAtLastCompaction,
        summaryTimestamp: state.summaryTimestamp ?? 0,
        questions: state.questions ?? [],
      };
      await current.appendCustomEntry(PILOT_COMPACTION_ENTRY_TYPE, toDurableJson(snapshot));
    },

    async restore(): Promise<RestoredConversation> {
      return readDurableConversation(current);
    },

    async clear(): Promise<void> {
      current = await hooks.clear();
      sink = createDurableTranscriptSink(current);
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await hooks.close();
    },
  };
}
