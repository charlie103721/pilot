import { join } from 'node:path';
import {
  nullLogger,
  toPilotError,
  type ConversationId,
  type Logger,
  type SerializedPilotError,
} from '@pilot/shared';
import {
  DEFAULT_WRITER_LEASE,
  EMPTY_CONVERSATION,
  isWriterLeaseHeld,
  openConversationStore,
  type ConversationBackend,
  type ConversationStore,
  type RestoredConversation,
} from '@pilot/agent';

/**
 * The durable conversation, owned by the application (PR-036, runbook
 * follow-up 20).
 *
 * PR-023 built `ConversationStore` and left the *lifecycle* to the app, which
 * is the half that is silently wrong when it is skipped. The sequence is fixed
 * and all four steps matter:
 *
 * ```text
 *   openConversationStore({ conversationId, directory })
 *     → store.restore()
 *       → new PiAgentSession({ store, restore })          (main/agent-runtime.ts)
 *         → store.close()  on `before-quit`               (main/index.ts)
 * ```
 *
 *  - **Skip `restore()`** and the user's history is still on disk and invisible
 *    to the model: the conversation reads as empty and the next question is
 *    answered without it. Nothing fails, which is what makes it dangerous.
 *  - **Skip `close()`** and the SQLite **writer lease** row survives the quit,
 *    so every relaunch inside {@link DEFAULT_WRITER_LEASE}`.ttlMs` (30 s) fails
 *    to open the store.
 *
 * ## The writer lease, and why nothing here retries or deletes
 *
 * The lease is held by the *process*, not by the user. A second instance that
 * opens the same conversation fails immediately with `WriterLeaseHeldError`
 * (`isWriterLeaseHeld(error)`, `details.reason === 'writer-lease-held'`,
 * `code: 'internal'`), and a process that crashed holds it for up to 30 s more
 * before the next launch takes over **by itself**. So:
 *
 *  - `app.requestSingleInstanceLock()` (`main/single-instance.ts`) is the first
 *    line of defence and this is the second — they answer different questions,
 *    because the lock is per *application* and the lease is per *conversation
 *    file*, which a crashed process can still be holding when a fresh, single,
 *    legitimate instance starts.
 *  - The error's own `userMessage` is surfaced rather than rewritten: it is the
 *    only sentence in the product that tells the user to wait 30 seconds, which
 *    is exactly what they should do.
 *  - **The database is never deleted to "fix" a launch.** That would throw away
 *    the conversation to work around a lock that expires on its own, and it is
 *    the mistake this comment exists to prevent.
 *
 * ## Persistence is best effort
 *
 * A store that cannot be opened — a full disk, a read-only volume, a lease that
 * has not expired — must not stop Pilot from answering questions. This module
 * therefore never throws: it returns a runtime whose `store` is `null`, whose
 * `error` carries the typed refusal for the panel, and the app runs exactly as
 * PR-029…PR-035 did, in memory, for the life of the process. That mirrors
 * `PiAgentSession`'s own choice to swallow durable-write failures (see
 * `#enqueueWrite`): the conversation is the product, the file is a convenience.
 */

/** Where the durable conversation lives, under Electron's `userData`. */
export const CONVERSATIONS_DIRECTORY = 'conversations';

/**
 * Resolves the durable directory from Electron's `userData` path.
 *
 * A named subdirectory rather than `userData` itself, so `sessions.db` sits
 * beside nothing else Pilot writes and a user can delete the conversation
 * history without touching preferences or permission state (system-design §13
 * lists them as separate persisted things).
 */
export function conversationDirectory(userDataPath: string): string {
  return join(userDataPath, CONVERSATIONS_DIRECTORY);
}

export interface ConversationStoreRuntime {
  /** `null` when the store could not be opened; see {@link error}. */
  readonly store: ConversationStore | null;
  /**
   * What was on disk. {@link EMPTY_CONVERSATION} for a first launch *and* for a
   * store that could not be opened — a caller must not have to tell those apart
   * to build a session.
   */
  readonly restore: RestoredConversation;
  readonly directory: string;
  /** The typed refusal, for the panel. `null` when the store opened. */
  readonly error: SerializedPilotError | null;
  /** True exactly when {@link error} is a writer lease Pilot could not take. */
  readonly leaseHeld: boolean;
  /** Releases the writer lease. Idempotent, and safe with no store. */
  close(): Promise<void>;
}

export interface OpenConversationStoreRuntimeOptions {
  readonly conversationId: ConversationId;
  /** Absolute. Created by the backend if it does not exist. */
  readonly directory: string;
  readonly backend?: ConversationBackend;
  readonly logger?: Logger;
}

/**
 * Opens the durable store and reads the conversation back.
 *
 * Total: every failure becomes a runtime with `store: null` and a typed
 * `error`, because the alternative is an application that will not start
 * because of a file it does not need in order to work.
 */
export async function openConversationStoreRuntime(
  options: OpenConversationStoreRuntimeOptions,
): Promise<ConversationStoreRuntime> {
  const logger = (options.logger ?? nullLogger).child('conversation-store');
  const closed = async (): Promise<void> => undefined;

  let store: ConversationStore;
  try {
    store = await openConversationStore({
      conversationId: options.conversationId,
      directory: options.directory,
      ...(options.backend === undefined ? {} : { backend: options.backend }),
    });
  } catch (cause) {
    const error = toPilotError(cause);
    const leaseHeld = isWriterLeaseHeld(cause);
    // `warn`, not `error`: a held lease is an ordinary consequence of quitting
    // and relaunching quickly, and it clears itself. The log says how long.
    logger.warn('the durable conversation could not be opened; running in memory', {
      code: error.code,
      // The backend's own words. A store failure is a *file* failure — a
      // missing directory, a read-only volume, a lease — and the code alone
      // ("internal") cannot tell those apart for whoever has to fix it. It
      // carries no conversation content: nothing here has read a message yet.
      reason: error.message,
      leaseHeld,
      ...(leaseHeld ? { leaseTtlMs: DEFAULT_WRITER_LEASE.ttlMs } : {}),
      directory: options.directory,
    });
    return {
      store: null,
      restore: EMPTY_CONVERSATION,
      directory: options.directory,
      error: error.toJSON(),
      leaseHeld,
      close: closed,
    };
  }

  let restore: RestoredConversation = EMPTY_CONVERSATION;
  try {
    restore = await store.restore();
  } catch (cause) {
    // The store is open and writable; only reading it back failed. Keep it —
    // this conversation continues, and the next turn is persisted — but start
    // the model from nothing rather than from a half-read transcript.
    logger.warn('the durable conversation could not be read back; starting empty', {
      code: toPilotError(cause).code,
    });
  }

  // NOTE the field names. `@pilot/shared`'s redaction treats any key matching
  // /messages/ as content and replaces its value with `[redacted:content]` —
  // correct, and it would have made these counts unreadable. Counting words
  // ("restored", "persisted") say the same thing and survive.
  logger.info('durable conversation opened', {
    directory: options.directory,
    backend: options.backend ?? 'sqlite',
    restored: restore.messages.length,
    persisted: restore.persistedMessageCount,
    repaired: restore.repairedMessages,
    // The summary *text* is never logged (§13, §17): only whether there is one.
    summary: restore.compaction !== undefined,
  });

  return {
    store,
    restore,
    directory: options.directory,
    error: null,
    leaseHeld: false,
    close: async (): Promise<void> => {
      try {
        await store.close();
      } catch (cause) {
        // Quitting must not fail. A lease row that outlives the process expires
        // on its own after `DEFAULT_WRITER_LEASE.ttlMs`.
        logger.warn('the durable conversation did not close cleanly', {
          code: toPilotError(cause).code,
        });
      }
    },
  };
}
