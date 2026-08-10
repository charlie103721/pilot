import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai';
import { PilotError, nullLogger, type Logger } from '@pilot/shared';

/**
 * Where Pilot keeps the Codex refresh token (PR-037).
 *
 * WHY A STORE AT ALL. Pi owns the hard part of OAuth — refresh under a lock,
 * double-checked expiry, one credential per provider id — but it deliberately
 * does not own *persistence*: `createModels({ credentials })` defaults to
 * `InMemoryCredentialStore`, which means a signed-in Pilot would be signed out
 * again on every launch. This is the file behind it.
 *
 * WHAT SYSTEM-DESIGN §13 ALLOWS. "Persisted: selected model profiles **without
 * plaintext secrets**; provider credential **references**." A refresh token is
 * not a reference, so this file is the one place in Pilot that writes secret
 * material to disk, and it is written under three rules:
 *
 *  1. **Its own file**, not the profile store and not the conversation
 *     database. `profile-store.ts` refuses to persist anything that looks like
 *     a secret and stays that way; deleting the conversation history must not
 *     sign the user out, and signing out must not delete the conversation.
 *  2. **`0600`, in a `0700` directory**, written through a temporary file and
 *     renamed, so a crash mid-write cannot leave a half-token behind that
 *     `JSON.parse` then rejects on the next launch.
 *  3. **Encrypted at rest when the platform can**, through the
 *     {@link CodexSecretProtector} seam. On macOS `main/codex-runtime.ts`
 *     passes Electron's `safeStorage`, which is Keychain-backed. Where no
 *     protector is available the file records `protected: false` and the
 *     caller is told, because "encrypted" and "not encrypted" must not look
 *     the same from the outside.
 *
 * WHAT NEVER HAPPENS HERE. Nothing in this module logs, returns or formats a
 * token. The logger sees provider ids, byte counts and booleans. The one way
 * out is `read`/`modify`, which is Pi's own contract and is called only by Pi.
 *
 * SERIALISATION. Pi's contract: "`modify` is the only write path, so every
 * mutation is a serialized read-modify-write", and `Models.getAuth()` refreshes
 * *inside* `modify` so two concurrent requests cannot double-refresh a rotated
 * token. That serialisation is this store's job, and it is a single promise
 * chain covering the whole file rather than one per provider id — the file is
 * one document, so two providers writing at once would lose one of them.
 */

/**
 * Encryption seam. Electron's `safeStorage` satisfies it structurally on the
 * two methods; `available` is asked once at construction and again is not
 * inferred — a protector that is present but not ready must say so.
 */
export interface CodexSecretProtector {
  readonly available: boolean;
  /** Returns the protected form as a base64 string. */
  encrypt(plaintext: string): string;
  decrypt(protectedText: string): string;
}

/** Identity protector. Explicit rather than implicit: the file says `protected: false`. */
export const PLAINTEXT_PROTECTOR: CodexSecretProtector = {
  available: false,
  encrypt: (plaintext) => plaintext,
  decrypt: (protectedText) => protectedText,
};

/** File name inside the credentials directory. */
export const CODEX_CREDENTIALS_FILE = 'model-credentials.json';

/** `~/Library/Application Support/Pilot/credentials/model-credentials.json`. */
export function codexCredentialsPath(userDataDirectory: string): string {
  return join(userDataDirectory, 'credentials', CODEX_CREDENTIALS_FILE);
}

interface CredentialFile {
  readonly version: 1;
  /** False when the entries are plaintext because no protector was available. */
  readonly protected: boolean;
  /** Provider id → protected JSON of one `Credential`. */
  readonly entries: Record<string, string>;
}

const EMPTY_FILE: CredentialFile = { version: 1, protected: false, entries: {} };

function isCredentialFile(value: unknown): value is CredentialFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<CredentialFile>;
  return (
    candidate.version === 1 &&
    typeof candidate.protected === 'boolean' &&
    typeof candidate.entries === 'object' &&
    candidate.entries !== null
  );
}

export interface CodexCredentialStoreOptions {
  readonly filePath: string;
  /** Defaults to {@link PLAINTEXT_PROTECTOR}. */
  readonly protector?: CodexSecretProtector;
  readonly logger?: Logger;
}

export interface CodexCredentialStore extends CredentialStore {
  readonly filePath: string;
  /** True when entries are written through an available protector. */
  readonly encrypted: boolean;
  /** Provider ids currently stored. Never their credentials. */
  providerIds(): Promise<readonly string[]>;
}

function storeFailure(message: string, cause?: unknown): PilotError {
  return new PilotError('authentication-required', message, {
    userMessage:
      'Pilot could not read or write its saved ChatGPT sign-in. Sign in again, and report this if it keeps happening.',
    retryable: false,
    details: { providerId: 'openai-codex', reason: 'credential-store-failed' },
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * A `CredentialStore` over one JSON file.
 *
 * A file that cannot be parsed is treated as *empty* rather than fatal, and
 * said so at `warn`: the recovery for a corrupted credential file is signing in
 * again, and refusing to start is a worse answer than asking for that.
 */
export function createCodexCredentialStore(
  options: CodexCredentialStoreOptions,
): CodexCredentialStore {
  const logger = options.logger ?? nullLogger;
  const protector = options.protector ?? PLAINTEXT_PROTECTOR;
  const { filePath } = options;

  // One chain for the whole file. See the module comment.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = async <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const load = async (): Promise<CredentialFile> => {
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        return EMPTY_FILE;
      }
      throw storeFailure(`Could not read ${filePath}`, cause);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.warn('credential file is not valid JSON; treating it as empty', {
        // The path, never the contents.
        bytes: text.length,
      });
      return EMPTY_FILE;
    }
    if (!isCredentialFile(parsed)) {
      logger.warn('credential file has an unexpected shape; treating it as empty', {});
      return EMPTY_FILE;
    }
    return parsed;
  };

  const persist = async (file: CredentialFile): Promise<void> => {
    const directory = dirname(filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Best effort: an existing directory keeps its own mode, and a tightened
    // one is not worth failing a sign-in over.
    await chmod(directory, 0o700).catch(() => undefined);
    const temporary = `${filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, filePath);
  };

  const decode = (providerId: string, raw: string): Credential | undefined => {
    try {
      return JSON.parse(protector.decrypt(raw)) as Credential;
    } catch (cause) {
      // A credential that cannot be decrypted is a credential the user has to
      // replace — a re-keyed Keychain, a file copied between machines. Say it
      // once, name nothing but the provider, and behave as signed out.
      logger.warn('stored credential could not be decoded; treating it as absent', {
        providerId,
        protected: protector.available,
        cause: String(cause),
      });
      return undefined;
    }
  };

  const readEntry = async (providerId: string): Promise<Credential | undefined> => {
    const file = await load();
    const raw = file.entries[providerId];
    return raw === undefined ? undefined : decode(providerId, raw);
  };

  const assertNotAborted = (operation?: AuthOperationOptions): void => {
    operation?.signal?.throwIfAborted();
  };

  return {
    filePath,
    encrypted: protector.available,

    async read(
      providerId: string,
      operation?: AuthOperationOptions,
    ): Promise<Credential | undefined> {
      assertNotAborted(operation);
      return serialize(() => readEntry(providerId));
    },

    async list(operation?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
      assertNotAborted(operation);
      return serialize(async () => {
        const file = await load();
        const infos: CredentialInfo[] = [];
        for (const [providerId, raw] of Object.entries(file.entries)) {
          const credential = decode(providerId, raw);
          if (credential !== undefined) {
            infos.push({ providerId, type: credential.type });
          }
        }
        return infos;
      });
    },

    async modify(
      providerId: string,
      fn: (current: Credential | undefined) => Promise<Credential | undefined>,
      operation?: AuthOperationOptions,
    ): Promise<Credential | undefined> {
      assertNotAborted(operation);
      return serialize(async () => {
        const file = await load();
        const raw = file.entries[providerId];
        const current = raw === undefined ? undefined : decode(providerId, raw);
        // Pi's contract: rejections from `fn` propagate, and `undefined` means
        // "leave the entry unchanged" — not "delete it".
        const next = await fn(current);
        if (next === undefined) {
          return current;
        }
        const entries = { ...file.entries, [providerId]: protector.encrypt(JSON.stringify(next)) };
        await persist({ version: 1, protected: protector.available, entries });
        logger.debug('stored a provider credential', {
          providerId,
          protected: protector.available,
        });
        return next;
      });
    },

    async delete(providerId: string, operation?: AuthOperationOptions): Promise<void> {
      assertNotAborted(operation);
      await serialize(async () => {
        const file = await load();
        if (!(providerId in file.entries)) {
          return;
        }
        const entries = { ...file.entries };
        delete entries[providerId];
        if (Object.keys(entries).length === 0) {
          // An empty store is an absent file: signing out must not leave a
          // credentials file on disk for a forensic reader to wonder about.
          await unlink(filePath).catch(() => undefined);
          logger.info('removed the stored credential file', { providerId });
          return;
        }
        await persist({ version: 1, protected: protector.available, entries });
        logger.info('removed a provider credential', { providerId });
      });
    },

    async providerIds(): Promise<readonly string[]> {
      return serialize(async () => Object.keys((await load()).entries).sort());
    },
  };
}
