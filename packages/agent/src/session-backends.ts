import { join } from 'node:path';
import { JsonlSessionRepo, SessionError, type Session } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  SqliteSessionRepository,
  createNodeSqliteFactory,
  type SqliteDatabaseFactory,
  type SqliteSessionMetadata,
} from '@earendil-works/pi-session-backend-sqlite-node';
import { PilotError, type ConversationId } from '@pilot/shared';
import { createConversationStore, type ConversationStore } from './conversation-store.js';

/**
 * Opening the durable backends (PR-023).
 *
 * `docs/pi-notes.md` §1.1: the 0.84 line renamed the SQLite backend to
 * `@earendil-works/pi-session-backend-sqlite-node` and the class to
 * `SqliteSessionRepository`. The older `pi-storage-sqlite-node` pins
 * `pi-agent-core@^0.83.0` and duplicates the runtime; it must not be used.
 *
 * Two backends are supported because system-design §18 asks for the privacy
 * guarantee to be proved on real disk, and "on real disk" means on whatever is
 * actually shipped. SQLite is the default; JSONL is in-package, dependency-free
 * and is what the tests use to read the bytes back as text.
 */

export type ConversationBackend = 'sqlite' | 'jsonl';

/**
 * SQLite writer lease (`SqliteWriterLeaseOptions`).
 *
 * The backend claims a row in `writer_leases` when a session is created or
 * opened, renews it on every write and on an idle heartbeat, and deletes it on
 * `close()`. Another writer may take over only once `expires_at_ms` has
 * passed. See {@link DEFAULT_WRITER_LEASE} for the numbers and
 * {@link WriterLeaseHeldError} for what a caller sees when it cannot get one.
 */
export interface WriterLeaseOptions {
  /** Time without a successful heartbeat before another writer may take over. */
  readonly ttlMs?: number;
  /** Idle heartbeat cadence. Must be less than `ttlMs`. */
  readonly heartbeatIntervalMs?: number;
}

/**
 * Pi 0.84.1's own defaults, restated as code.
 *
 * They are passed explicitly rather than left to default so that the numbers
 * the Electron lifecycle has to respect are visible at the call site, and so a
 * silent upstream change to them fails a test instead of changing behaviour.
 *
 * **What the Electron main process must do with them.** The lease is held by
 * the process, not by the user:
 *
 *  - Call {@link ConversationStore.close} on `before-quit`, and on window
 *    close if the store is not shared. It deletes the lease row, so the next
 *    launch starts instantly.
 *  - A **second instance** that opens the same conversation while the first
 *    still holds the lease fails immediately with {@link WriterLeaseHeldError}
 *    — it does not wait, and it does not corrupt anything. Electron's
 *    `app.requestSingleInstanceLock()` is the right first line of defence;
 *    this is the second.
 *  - A **crashed or SIGKILLed** process leaves the row behind with a future
 *    expiry. Every open for the next {@link DEFAULT_WRITER_LEASE.ttlMs}
 *    milliseconds — 30 s — fails the same way; after that the next opener
 *    takes over, bumping the lease *fence*. Do not delete the file to "fix" a
 *    launch, and do not retry in a tight loop: report it and offer a retry.
 *  - If a zombie writer comes back after a takeover, its very next write
 *    fails with `SQLite session … writer lease was lost` — the fence changed
 *    underneath it. It can never interleave writes with the new owner.
 */
export const DEFAULT_WRITER_LEASE = {
  ttlMs: 30_000,
  heartbeatIntervalMs: 10_000,
} as const satisfies Required<WriterLeaseOptions>;

/**
 * Another writer holds the conversation's SQLite lease.
 *
 * Carries `code: 'internal'` deliberately: adding a `session-locked` member to
 * `PilotErrorCode` would widen a union that `PILOT_ERROR_DOMAIN_BY_CODE` and
 * every other lane's exhaustive record must cover, which is not an additive
 * change while other lanes are in flight. `instanceof` and
 * `details.reason === 'writer-lease-held'` are the stable discriminators.
 */
export class WriterLeaseHeldError extends PilotError {
  constructor(conversationId: string, cause?: unknown) {
    super(
      'internal',
      `Another Pilot process holds the writer lease for conversation ${conversationId}`,
      {
        userMessage:
          'Pilot is already open in another window. Close it, or wait up to 30 seconds if it stopped unexpectedly.',
        retryable: true,
        details: { reason: 'writer-lease-held', conversationId },
        ...(cause === undefined ? {} : { cause }),
      },
    );
  }
}

/** True when `error` reports a writer lease Pilot could not take. */
export function isWriterLeaseHeld(error: unknown): error is WriterLeaseHeldError {
  return (
    error instanceof PilotError &&
    (error.details as { reason?: unknown } | undefined)?.reason === 'writer-lease-held'
  );
}

function rethrowLeaseFailure(conversationId: string, cause: unknown): never {
  if (cause instanceof SessionError && /active writer/.test(cause.message)) {
    throw new WriterLeaseHeldError(conversationId, cause);
  }
  throw cause;
}

export interface OpenConversationStoreOptions {
  readonly conversationId: ConversationId;
  /** Directory that holds the durable data. Created if it does not exist. */
  readonly directory: string;
  /** Defaults to `'sqlite'`. */
  readonly backend?: ConversationBackend;
  /** SQLite only. Defaults to {@link DEFAULT_WRITER_LEASE}. */
  readonly writerLease?: WriterLeaseOptions;
}

/**
 * Opens — or creates — the durable store for one conversation.
 *
 * The Pi session id *is* the `ConversationId`, so a relaunch finds the same
 * conversation by name rather than by scanning for the newest file.
 */
export async function openConversationStore(
  options: OpenConversationStoreOptions,
): Promise<ConversationStore> {
  return options.backend === 'jsonl' ? openJsonlStore(options) : openSqliteStore(options);
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

async function openSqliteStore(options: OpenConversationStoreOptions): Promise<ConversationStore> {
  const id = String(options.conversationId);
  const cwd = options.directory;
  const databasePath = join(options.directory, 'sessions.db');
  const sqlite: SqliteDatabaseFactory = createNodeSqliteFactory();
  const writerLease: Required<WriterLeaseOptions> = {
    ttlMs: options.writerLease?.ttlMs ?? DEFAULT_WRITER_LEASE.ttlMs,
    heartbeatIntervalMs:
      options.writerLease?.heartbeatIntervalMs ?? DEFAULT_WRITER_LEASE.heartbeatIntervalMs,
  };
  const env = new NodeExecutionEnv({ cwd });

  const newRepository = (): SqliteSessionRepository =>
    new SqliteSessionRepository({ env, sqlite, databasePath, writerLease });

  let repository = newRepository();

  const openOrCreate = async (repo: SqliteSessionRepository): Promise<Session> => {
    try {
      const existing = (await repo.list()).find(
        (metadata: SqliteSessionMetadata) => metadata.id === id,
      );
      return existing === undefined ? await repo.create({ cwd, id }) : await repo.open(existing);
    } catch (cause) {
      // Close before rethrowing. `list()` opens the database, so a repository
      // that failed to take the lease still owns an open SQLite handle — and
      // an abandoned handle makes the *next* operation on that file fail with
      // `database is locked`, turning a clean "someone else is writing" into a
      // permanent one. Found by the demo, which opens a doomed second store on
      // purpose and then clears the conversation.
      await repo.close();
      rethrowLeaseFailure(id, cause);
    }
  };

  const session = await openOrCreate(repository);

  return createConversationStore(session, {
    async clear(): Promise<Session> {
      const existing = (await repository.list()).find(
        (metadata: SqliteSessionMetadata) => metadata.id === id,
      );
      if (existing !== undefined) {
        await repository.delete(existing);
      }
      // Deleting the rows is not the same as removing the bytes: SQLite marks
      // the pages free and reuses them later, so a cleared conversation's text
      // stays readable in the file until something overwrites it. §13 says
      // "clear conversation", so the pages are reclaimed here rather than
      // whenever the database next happens to grow. VACUUM needs the database
      // to itself, hence the close/reopen — a user-initiated, once-in-a-while
      // operation paying for a guarantee that can be checked with `grep`.
      await repository.close();
      const database = await sqlite.open(databasePath);
      try {
        database.exec('PRAGMA busy_timeout=5000');
        // MEASURED, and the reason this is two statements instead of one: the
        // backend runs the database in WAL mode, and a VACUUM in WAL mode
        // writes the rebuilt pages into the -wal file and leaves the main file
        // at its old length. The freed text is then still sitting past the
        // logical end of the database — `grep` finds it, which is the only
        // test that matters here. In rollback-journal mode VACUUM rebuilds and
        // *truncates*, so the bytes are really gone. The repository restores
        // WAL mode itself the next time it opens the file.
        database.exec('PRAGMA journal_mode=DELETE');
        database.exec('VACUUM');
      } finally {
        database.close();
      }
      repository = newRepository();
      return openOrCreate(repository);
    },
    async close(): Promise<void> {
      // Releases the writer lease row and closes the database handle. This is
      // what `SqliteSessionRepository[Symbol.asyncDispose]()` delegates to.
      await repository.close();
    },
  });
}

// ---------------------------------------------------------------------------
// JSONL
// ---------------------------------------------------------------------------

async function openJsonlStore(options: OpenConversationStoreOptions): Promise<ConversationStore> {
  const id = String(options.conversationId);
  const cwd = options.directory;
  const env = new NodeExecutionEnv({ cwd });
  const repository = new JsonlSessionRepo({ fs: env, sessionsRoot: join(cwd, 'sessions') });

  const openOrCreate = async (): Promise<Session> => {
    const existing = (await repository.list()).find((metadata) => metadata.id === id);
    return existing === undefined ? repository.create({ cwd, id }) : repository.open(existing);
  };

  const session = await openOrCreate();

  return createConversationStore(session, {
    async clear(): Promise<Session> {
      const existing = (await repository.list()).find((metadata) => metadata.id === id);
      if (existing !== undefined) {
        // One session is one file; deleting it removes every byte of it.
        await repository.delete(existing);
      }
      return openOrCreate();
    },
    async close(): Promise<void> {
      // The JSONL backend holds no lease and no long-lived handle.
    },
  });
}
