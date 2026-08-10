import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai';
import { PilotError, REDACTED_CREDENTIAL } from '@pilot/shared';

/**
 * Encrypted-at-rest credential storage (PR-038).
 *
 * ## Why this file exists at all
 *
 * PR-020 built the *auth facade* — the seam through which a request obtains a
 * credential, and the {@link ProviderCredential} wrapper whose secret lives in a
 * `#private` field so it cannot be stringified, spread or logged. What PR-020
 * deliberately did not build is the thing underneath it: **where the bytes
 * live**. `createPiAuthFacade` takes a `CredentialStore` and Pi ships exactly
 * one, `InMemoryCredentialStore`, which forgets everything on quit.
 *
 * This is that store. It implements Pi's own `CredentialStore` contract
 * (`read`/`list`/`modify`/`delete`, keyed by `Provider.id`) so `Models` keeps
 * running its refresh-under-lock logic unchanged (`docs/pi-notes.md` §2.8, §8),
 * and it adds one property Pi's has no opinion about: **nothing readable ever
 * reaches the medium.**
 *
 * ## The invariant, stated so a test can fail on it
 *
 * `docs/system-design.md` §13 permits persisting "selected model profiles
 * *without plaintext secrets*" and "provider credential *references*", and §13's
 * "Never logged" list opens with "credentials or OAuth tokens". The Phase 4 gate
 * restates it: *credentials never enter renderer state, application logs, or
 * session transcripts.*
 *
 * Three mechanisms, in decreasing order of how much they are relied upon:
 *
 *  1. **The medium only ever sees ciphertext.** {@link SecretCipher.seal} is the
 *     only thing that produces the `sealed` field, and it is the only field of
 *     the stored envelope that is derived from the credential. `providerId` and
 *     `type` are metadata Pi's own `CredentialInfo` already exposes.
 *  2. **No cipher means no write.** If secure storage is unavailable — no
 *     Keychain, `safeStorage.isEncryptionAvailable()` false — the store
 *     *refuses* rather than silently falling back to plaintext. An explicit
 *     failure is the delivery rule; a plaintext fallback is the failure mode
 *     this whole file exists to make impossible.
 *  3. **{@link createSecretScrubber} for everything else.** A provider that
 *     rejects a key very often echoes it back in the error body, and that body
 *     becomes `AssistantMessage.errorMessage`, then a `PilotError.message`, then
 *     a log line. Encryption does nothing about that path, so the key is
 *     scrubbed out of every string that leaves the API-key lane.
 *
 * ## What is NOT proven here
 *
 * There is no macOS in this environment, so `safeStorage` — and therefore the
 * Keychain — has never run. {@link createAesGcmCipher} is a real cipher and is
 * what the tests and the demo use, but its key is supplied by the caller and in
 * the app that caller is `safeStorage`. `docs/handoff.md` §1 step 17 is the
 * check only the user's Mac can make.
 */

/* -------------------------------------------------------------------------- *
 * Scrubbing
 * -------------------------------------------------------------------------- */

/**
 * Replaces known secret strings wherever they appear in text.
 *
 * Deliberately *not* a pattern matcher. `@pilot/shared`'s logger already
 * redacts by key name and by shape, and `ModelProfileStore` already rejects
 * well-known key prefixes; both are heuristics and both can miss a vendor
 * format nobody has seen. This one knows the exact strings Pilot is holding, so
 * it cannot miss them — and it is useless against a secret it was never told
 * about, which is why it is a *third* mechanism rather than the only one.
 *
 * Short strings are ignored: a four-character "key" would turn every message
 * into confetti, and no real credential is that short.
 */
export interface SecretScrubber {
  /** Replaces every occurrence of a known secret with the redaction marker. */
  scrub(text: string): string;
  /** True when `text` contains a known secret. For assertions and guards. */
  taints(text: string): boolean;
  /** Adds a secret to scrub. Safe to call with `undefined`. */
  remember(secret: string | undefined): void;
  /** Forgets every remembered secret (logout). */
  forget(): void;
}

/** Below this length a "secret" is more likely to be a word than a credential. */
export const MIN_SCRUBBABLE_SECRET_LENGTH = 8;

export function createSecretScrubber(
  initial: readonly (string | undefined)[] = [],
): SecretScrubber {
  const secrets = new Set<string>();

  const remember = (secret: string | undefined): void => {
    if (secret !== undefined && secret.length >= MIN_SCRUBBABLE_SECRET_LENGTH) {
      secrets.add(secret);
    }
  };
  for (const secret of initial) {
    remember(secret);
  }

  return {
    remember,
    forget: () => secrets.clear(),
    taints: (text) => [...secrets].some((secret) => text.includes(secret)),
    scrub(text: string): string {
      let output = text;
      // Longest first, so a key that is a prefix of another does not leave a
      // readable tail behind.
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
        output = output.split(secret).join(REDACTED_CREDENTIAL);
      }
      return output;
    },
  };
}

/* -------------------------------------------------------------------------- *
 * The cipher seam
 * -------------------------------------------------------------------------- */

/**
 * Turns a secret string into opaque text and back.
 *
 * A seam rather than a concrete implementation because the shipping one is
 * Electron's `safeStorage` — which is macOS Keychain-backed and cannot be
 * constructed, let alone exercised, outside an Electron main process. The
 * desktop app supplies that one (`apps/desktop/src/main/api-key-runtime.ts`);
 * this package supplies a real AES-GCM one for tests and the demo, and an
 * unavailable one that refuses.
 */
export interface SecretCipher {
  /** Human-readable, for status UI and the handoff. Never a value. */
  readonly name: string;
  /** False when this machine cannot store a secret safely. */
  readonly available: boolean;
  /** Produces opaque, self-describing text. Base64 by convention. */
  seal(plaintext: string): string;
  /** Inverse of {@link seal}. Throws when the text is not ours to open. */
  open(sealed: string): string;
}

function secureStorageUnavailable(reason: string): PilotError {
  return new PilotError(
    'platform-unavailable',
    `Secure credential storage unavailable: ${reason}`,
    {
      userMessage:
        'Pilot cannot store an API key securely on this machine, so it will not store one at all. ' +
        'The key can still be supplied through the environment for a single session.',
      retryable: false,
      details: { reason },
    },
  );
}

/**
 * A cipher that refuses.
 *
 * Used when `safeStorage.isEncryptionAvailable()` is false. Every write through
 * it fails loudly; nothing degrades to plaintext.
 */
export function createUnavailableCipher(reason: string): SecretCipher {
  return {
    name: `unavailable (${reason})`,
    available: false,
    seal(): never {
      throw secureStorageUnavailable(reason);
    },
    open(): never {
      throw secureStorageUnavailable(reason);
    },
  };
}

const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;
const AES_TAG_BYTES = 16;

/** A 32-byte key, for {@link createAesGcmCipher}. Not persisted by this module. */
export function generateSecretKey(): Uint8Array {
  return new Uint8Array(randomBytes(AES_KEY_BYTES));
}

/**
 * Real AES-256-GCM over a caller-supplied key.
 *
 * Honest about what it is: the key has to come from somewhere, and on the Mac
 * that somewhere is the Keychain by way of `safeStorage`. Here it comes from
 * the caller, so this is a *cipher* rather than a *key store* — which is exactly
 * the split the tests need, because a restart is modelled by constructing a
 * second cipher over the same key and a lost Keychain by constructing one over
 * a different key.
 */
export function createAesGcmCipher(key: Uint8Array, name = 'aes-256-gcm'): SecretCipher {
  if (key.length !== AES_KEY_BYTES) {
    throw new PilotError('invalid-request', `Secret key must be ${String(AES_KEY_BYTES)} bytes`, {
      userMessage: 'Pilot could not set up secure storage for your API key.',
    });
  }
  return {
    name,
    available: true,
    seal(plaintext: string): string {
      const iv = randomBytes(AES_IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    },
    open(sealed: string): string {
      const raw = Buffer.from(sealed, 'base64');
      if (raw.length < AES_IV_BYTES + AES_TAG_BYTES) {
        throw new Error('sealed credential is truncated');
      }
      const iv = raw.subarray(0, AES_IV_BYTES);
      const tag = raw.subarray(AES_IV_BYTES, AES_IV_BYTES + AES_TAG_BYTES);
      const body = raw.subarray(AES_IV_BYTES + AES_TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}

/** Constant-time comparison, so a fake provider does not leak a key by timing. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/* -------------------------------------------------------------------------- *
 * The medium seam
 * -------------------------------------------------------------------------- */

/**
 * Where the sealed text is kept.
 *
 * Same two-method shape as PR-020's `ProfileStorage`, on purpose: the app
 * supplies a file writer, tests supply memory, and neither knows anything about
 * encryption. Everything this seam ever sees is already ciphertext.
 */
export interface SecretStorage {
  /** Resolves `undefined` when nothing has been stored yet. */
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
  remove(): Promise<void>;
}

export interface MemorySecretStorage extends SecretStorage {
  /** Exactly the bytes on the medium. Tests grep this for the key. */
  readonly text: string | undefined;
  /** How many times {@link SecretStorage.write} was called. */
  readonly writes: number;
}

export function createMemorySecretStorage(initial?: string): MemorySecretStorage {
  let text = initial;
  let writes = 0;
  return {
    get text(): string | undefined {
      return text;
    },
    get writes(): number {
      return writes;
    },
    async read(): Promise<string | undefined> {
      return text;
    },
    async write(next: string): Promise<void> {
      writes += 1;
      text = next;
    },
    async remove(): Promise<void> {
      text = undefined;
    },
  };
}

/* -------------------------------------------------------------------------- *
 * The store
 * -------------------------------------------------------------------------- */

const STORE_VERSION = 1;

/** One provider's entry as it sits on the medium. `sealed` is opaque. */
interface SealedEntry {
  readonly providerId: string;
  readonly type: Credential['type'];
  readonly sealed: string;
}

interface SealedFile {
  readonly version: number;
  readonly cipher: string;
  readonly entries: readonly SealedEntry[];
}

function isSealedFile(value: unknown): value is SealedFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<SealedFile>;
  return (
    candidate.version === STORE_VERSION &&
    typeof candidate.cipher === 'string' &&
    Array.isArray(candidate.entries)
  );
}

/**
 * Pi's `CredentialStore`, plus the three non-secret questions Pilot's UI and
 * tests need answered.
 */
export interface PilotCredentialStore extends CredentialStore {
  readonly cipherName: string;
  readonly secureStorageAvailable: boolean;
  /**
   * What is stored, without opening anything. Same shape as
   * {@link CredentialStore.list}; named separately so a caller reading it for
   * display does not have to reason about whether `list` might decrypt.
   */
  inventory(): Promise<readonly CredentialInfo[]>;
  /** Exactly the text on the medium. Ciphertext by construction. */
  serialize(): Promise<string | undefined>;
  /**
   * Why the last credential could not be opened, or `null`. Non-secret: it
   * names the provider and the reason, never any part of the material.
   */
  lastOpenFailure(): string | null;
}

export interface CreateEncryptedCredentialStoreOptions {
  readonly cipher: SecretCipher;
  readonly storage?: SecretStorage;
  /**
   * Told about every secret that passes through, so the rest of the lane can
   * scrub it out of provider error text. Optional: the store works without one.
   */
  readonly scrubber?: SecretScrubber;
}

/**
 * A `CredentialStore` that writes only ciphertext.
 *
 * Writes are serialized through one promise chain. Pi asks for "mutual
 * exclusion per provider id"; one chain for the whole file is stricter than
 * that and is the correct granularity here, because the unit that is read,
 * modified and written is the whole file.
 */
export function createEncryptedCredentialStore(
  options: CreateEncryptedCredentialStoreOptions,
): PilotCredentialStore {
  const { cipher } = options;
  const storage = options.storage ?? createMemorySecretStorage();
  const scrubber = options.scrubber;
  let chain: Promise<unknown> = Promise.resolve();
  let openFailure: string | null = null;

  const load = async (): Promise<SealedFile> => {
    const text = await storage.read();
    if (text === undefined || text.trim() === '') {
      return { version: STORE_VERSION, cipher: cipher.name, entries: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      openFailure = 'the stored credential file is not valid JSON';
      return { version: STORE_VERSION, cipher: cipher.name, entries: [] };
    }
    if (!isSealedFile(parsed)) {
      openFailure = 'the stored credential file is not in a format this version understands';
      return { version: STORE_VERSION, cipher: cipher.name, entries: [] };
    }
    return parsed;
  };

  const persist = async (file: SealedFile): Promise<void> => {
    if (file.entries.length === 0) {
      await storage.remove();
      return;
    }
    await storage.write(JSON.stringify({ ...file, cipher: cipher.name }, null, 2));
  };

  /**
   * Opens one entry.
   *
   * A failure here is *not* an exception and is *not* a deletion. A Keychain
   * that has forgotten its key, or a file copied from another Mac, produces
   * exactly this — and the honest answer is "there is no credential Pilot can
   * use", reported through {@link PilotCredentialStore.lastOpenFailure}, with
   * the bytes left alone. Deleting them would destroy the one thing a user
   * might still recover by hand.
   */
  const openEntry = (entry: SealedEntry): Credential | undefined => {
    try {
      const parsed: unknown = JSON.parse(cipher.open(entry.sealed));
      if (typeof parsed !== 'object' || parsed === null) {
        openFailure = `${entry.providerId}: stored credential did not decode to an object`;
        return undefined;
      }
      const credential = parsed as Credential;
      if (credential.type === 'api_key') {
        scrubber?.remember(credential.key);
      }
      openFailure = null;
      return credential;
    } catch (cause) {
      // The reason, never the material. `cipher.open` throws on a wrong key,
      // a truncated blob or a failed GCM tag; all three read the same way to a
      // user and none of them may quote the bytes.
      openFailure =
        `${entry.providerId}: the stored credential could not be decrypted ` +
        `(${cause instanceof Error ? cause.name : 'error'}); it was written by a different ` +
        'machine or the system key has changed';
      return undefined;
    }
  };

  const enqueue = async <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const store: PilotCredentialStore = {
    cipherName: cipher.name,
    secureStorageAvailable: cipher.available,

    async read(
      providerId: string,
      _options?: AuthOperationOptions,
    ): Promise<Credential | undefined> {
      const file = await load();
      const entry = file.entries.find((candidate) => candidate.providerId === providerId);
      return entry === undefined ? undefined : openEntry(entry);
    },

    async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
      // Never opens anything: Pi's contract says listing must not resolve or
      // expose secrets, and `providerId`/`type` are stored in the clear
      // precisely so this can be answered without a key.
      const file = await load();
      return file.entries.map((entry) => ({ providerId: entry.providerId, type: entry.type }));
    },

    async modify(
      providerId: string,
      fn: (current: Credential | undefined) => Promise<Credential | undefined>,
      _options?: AuthOperationOptions,
    ): Promise<Credential | undefined> {
      return enqueue(async () => {
        const file = await load();
        const entry = file.entries.find((candidate) => candidate.providerId === providerId);
        const current = entry === undefined ? undefined : openEntry(entry);
        const next = await fn(current);
        if (next === undefined) {
          return current;
        }
        if (!cipher.available) {
          // Before `seal` is reached, so the refusal is about policy rather
          // than about a thrown cipher — and so the message names the store.
          throw secureStorageUnavailable(cipher.name);
        }
        if (next.type === 'api_key') {
          scrubber?.remember(next.key);
        }
        const sealed: SealedEntry = {
          providerId,
          type: next.type,
          sealed: cipher.seal(JSON.stringify(next)),
        };
        await persist({
          version: STORE_VERSION,
          cipher: cipher.name,
          entries: [
            ...file.entries.filter((candidate) => candidate.providerId !== providerId),
            sealed,
          ],
        });
        return next;
      });
    },

    async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
      await enqueue(async () => {
        const file = await load();
        await persist({
          version: STORE_VERSION,
          cipher: cipher.name,
          entries: file.entries.filter((candidate) => candidate.providerId !== providerId),
        });
      });
    },

    async inventory(): Promise<readonly CredentialInfo[]> {
      return store.list();
    },

    async serialize(): Promise<string | undefined> {
      return storage.read();
    },

    lastOpenFailure(): string | null {
      return openFailure;
    },
  };

  // Same defence `ProviderCredential` uses (PR-020): a store handed to a logger
  // or spread into a log field must not walk into the cipher or the medium.
  Object.defineProperty(store, inspect.custom, {
    value: () => `PilotCredentialStore(${cipher.name}, ${REDACTED_CREDENTIAL})`,
    enumerable: false,
  });

  return store;
}

/** Builds the one credential shape an API-key provider stores. */
export function apiKeyCredential(key: string): Credential {
  return { type: 'api_key', key };
}
