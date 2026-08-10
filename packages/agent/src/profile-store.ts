import {
  PilotError,
  modelProfileSchema,
  type ModelProfile,
  type ModelProfileId,
} from '@pilot/shared';
import { z } from 'zod';
import type { CapabilityConfidence } from './capability.js';

/**
 * Provider-neutral model profile store (PR-020).
 *
 * WHAT MAY BE PERSISTED (system-design §13, "Persisted"):
 *   - "Selected model profiles **without plaintext secrets**"
 *   - "Provider credential **references**"
 *
 * So this store holds the profile, a display name, capability provenance, and
 * a *reference* to a credential. It never holds the credential. The reference
 * is simply the provider id, because that is exactly how Pi keys its
 * `CredentialStore` — one credential per `Provider.id`. Inventing a second
 * identifier would create a mapping that can go stale.
 *
 * The store is deliberately provider-neutral: nothing in this file knows what
 * `openai-codex`, `anthropic` or `local` mean. PR-037/038/039 add profiles;
 * they do not add cases here.
 *
 * PERSISTENCE. {@link ProfileStorage} is a two-method seam over a text blob.
 * PR-023 replaces the in-memory implementation with a real file/preferences
 * writer without touching this module.
 */

/** Where `supportsTools` came from — see `capability.ts` for why it matters. */
export const modelProfileRecordSchema = z.strictObject({
  profile: modelProfileSchema,
  /** Name shown in the model picker. */
  displayName: z.string().min(1).max(200),
  /**
   * `'verified'` when an operator or a provider PR explicitly asserted tool
   * support; `'assumed'` when it was defaulted. Pi reports nothing either way
   * (`docs/pi-notes.md` §6.3), so this is the only record of which it was.
   */
  toolSupport: z.enum(['verified', 'assumed']),
  /**
   * Non-secret pointer to the credential for this profile: the Pi provider id.
   * Never a key, never a token, never a keychain password.
   */
  credentialRef: z.string().min(1).max(200),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export type ModelProfileRecord = z.infer<typeof modelProfileRecordSchema> & {
  readonly toolSupport: CapabilityConfidence;
};

export interface ModelProfileRecordInput {
  readonly profile: ModelProfile;
  readonly displayName?: string;
  readonly toolSupport?: CapabilityConfidence;
  /** Defaults to `profile.provider`. */
  readonly credentialRef?: string;
}

const storeFileSchema = z.strictObject({
  version: z.literal(1),
  selectedId: z.string().min(1).max(200).nullable(),
  profiles: z.array(modelProfileRecordSchema),
});

type StoreFile = z.infer<typeof storeFileSchema>;

const EMPTY_FILE: StoreFile = { version: 1, selectedId: null, profiles: [] };

/* -------------------------------------------------------------------------- *
 * Plaintext-secret guard
 * -------------------------------------------------------------------------- */

/**
 * Well-known credential prefixes. Precise on purpose: an entropy heuristic
 * would reject legitimate model ids like
 * `accounts/fireworks/models/llama-v3p1-70b-instruct`.
 */
const SECRET_TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bya29\.[A-Za-z0-9_-]{10,}/,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
];

/** Query/userinfo parameter names that carry secrets in a URL. */
const SECRET_QUERY_KEYS = /^(api[-_]?key|apikey|key|token|access[-_]?token|secret|password|auth)$/i;

function findSecretIn(value: string): string | null {
  for (const pattern of SECRET_TOKEN_PATTERNS) {
    if (pattern.test(value)) {
      return `matches a known credential format (${String(pattern)})`;
    }
  }
  return null;
}

function findSecretInUrl(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') {
    return 'base URL embeds userinfo credentials (user:password@host)';
  }
  for (const [key] of url.searchParams) {
    if (SECRET_QUERY_KEYS.test(key)) {
      return `base URL carries a credential in the "${key}" query parameter`;
    }
  }
  return null;
}

function rejectSecret(field: string, why: string): never {
  // Reuses the existing validation-failure code rather than widening
  // PILOT_ERROR_CODES while other lanes are mid-flight. The message
  // deliberately does NOT echo the offending value.
  throw new PilotError('invalid-request', `Refusing to persist model profile: ${field} ${why}`, {
    userMessage: 'That model profile could not be saved because it contains a secret.',
    retryable: false,
    details: { field, reason: why },
  });
}

/**
 * Fails loudly if a record would write plaintext secret material to disk.
 *
 * `modelProfileSchema` is a `strictObject`, so an unexpected `apiKey` field is
 * already rejected at parse time. This catches the subtler shapes: a key
 * smuggled inside `baseUrl`, or pasted into a display name.
 */
export function assertNoPlaintextSecrets(record: ModelProfileRecord): void {
  const scalars: readonly (readonly [string, string])[] = [
    ['profile.id', record.profile.id],
    ['profile.provider', record.profile.provider],
    ['profile.model', record.profile.model],
    ['displayName', record.displayName],
    ['credentialRef', record.credentialRef],
    ...(record.profile.baseUrl === undefined
      ? []
      : ([['profile.baseUrl', record.profile.baseUrl]] as const)),
  ];
  for (const [field, value] of scalars) {
    const why = findSecretIn(value);
    if (why !== null) {
      rejectSecret(field, why);
    }
  }
  if (record.profile.baseUrl !== undefined) {
    const why = findSecretInUrl(record.profile.baseUrl);
    if (why !== null) {
      rejectSecret('profile.baseUrl', why);
    }
  }
}

/* -------------------------------------------------------------------------- *
 * Storage seam
 * -------------------------------------------------------------------------- */

export interface ProfileStorage {
  /** Resolves `undefined` when nothing has been stored yet. */
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
}

export function createMemoryProfileStorage(initial?: string): ProfileStorage {
  let text = initial;
  return {
    async read(): Promise<string | undefined> {
      return text;
    },
    async write(next: string): Promise<void> {
      text = next;
    },
  };
}

export interface ModelProfileStore {
  list(): Promise<readonly ModelProfileRecord[]>;
  get(id: ModelProfileId): Promise<ModelProfileRecord | undefined>;
  /** Inserts or replaces by `profile.id`. Rejects records carrying secrets. */
  save(input: ModelProfileRecordInput): Promise<ModelProfileRecord>;
  remove(id: ModelProfileId): Promise<void>;
  /** The profile the user picked, or `null`. */
  selected(): Promise<ModelProfileRecord | null>;
  select(id: ModelProfileId | null): Promise<void>;
  /** Serialised form, exactly as it would be written. Handy for assertions. */
  serialize(): Promise<string>;
}

export interface CreateModelProfileStoreOptions {
  readonly storage?: ProfileStorage;
  readonly clock?: () => number;
}

export function createModelProfileStore(
  options: CreateModelProfileStoreOptions = {},
): ModelProfileStore {
  const storage = options.storage ?? createMemoryProfileStorage();
  const now = options.clock ?? ((): number => Date.now());

  const load = async (): Promise<StoreFile> => {
    const text = await storage.read();
    if (text === undefined || text.trim() === '') {
      return EMPTY_FILE;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new PilotError('invalid-request', 'Model profile store is not valid JSON', {
        userMessage: 'Pilot could not read its saved model settings.',
        cause,
      });
    }
    const result = storeFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new PilotError('invalid-request', 'Model profile store failed validation', {
        userMessage: 'Pilot could not read its saved model settings.',
        details: { issues: result.error.issues.length },
      });
    }
    return result.data;
  };

  const persist = async (file: StoreFile): Promise<void> => {
    await storage.write(JSON.stringify(file, null, 2));
  };

  return {
    async list(): Promise<readonly ModelProfileRecord[]> {
      return (await load()).profiles as readonly ModelProfileRecord[];
    },

    async get(id: ModelProfileId): Promise<ModelProfileRecord | undefined> {
      return (await load()).profiles.find((record) => record.profile.id === id) as
        ModelProfileRecord | undefined;
    },

    async save(input: ModelProfileRecordInput): Promise<ModelProfileRecord> {
      const file = await load();
      const existing = file.profiles.find((record) => record.profile.id === input.profile.id);
      const timestamp = now();
      const candidate = modelProfileRecordSchema.parse({
        // Re-parse the profile so a hand-built object cannot smuggle extra keys
        // past the strict schema.
        profile: modelProfileSchema.parse(input.profile),
        displayName: input.displayName ?? `${input.profile.provider} / ${input.profile.model}`,
        toolSupport: input.toolSupport ?? existing?.toolSupport ?? 'assumed',
        credentialRef: input.credentialRef ?? input.profile.provider,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }) as ModelProfileRecord;

      assertNoPlaintextSecrets(candidate);

      const profiles = file.profiles.filter((record) => record.profile.id !== candidate.profile.id);
      profiles.push(candidate);
      await persist({ ...file, profiles });
      return candidate;
    },

    async remove(id: ModelProfileId): Promise<void> {
      const file = await load();
      await persist({
        ...file,
        selectedId: file.selectedId === id ? null : file.selectedId,
        profiles: file.profiles.filter((record) => record.profile.id !== id),
      });
    },

    async selected(): Promise<ModelProfileRecord | null> {
      const file = await load();
      if (file.selectedId === null) {
        return null;
      }
      return (
        (file.profiles.find((record) => record.profile.id === file.selectedId) as
          ModelProfileRecord | undefined) ?? null
      );
    },

    async select(id: ModelProfileId | null): Promise<void> {
      const file = await load();
      if (id !== null && !file.profiles.some((record) => record.profile.id === id)) {
        throw new PilotError('invalid-request', `No stored model profile with id ${id}`, {
          userMessage: 'That model is no longer available. Choose another one.',
        });
      }
      await persist({ ...file, selectedId: id });
    },

    async serialize(): Promise<string> {
      return JSON.stringify(await load(), null, 2);
    },
  };
}
