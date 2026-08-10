import { inspect } from 'node:util';
import type {
  Api,
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  Model,
  ModelAuth,
  Models,
} from '@earendil-works/pi-ai';
import { PilotError, type ModelProfile } from '@pilot/shared';
import type { PilotAuthMode } from './model-profile.js';

/**
 * Provider-neutral auth facade (PR-020).
 *
 * SCOPE. This is the *seam*, plus a fake. The real flows are PR-037 (Codex
 * subscription), PR-038 (API key) and PR-039 (local endpoint). Nothing here
 * requires credentials, opens a browser, or touches the network, so the whole
 * module is testable today — which is the point, because the user has not
 * signed in to Codex yet.
 *
 * WHY IT WRAPS PI RATHER THAN INVENTING A STORE (`docs/pi-notes.md` §8).
 * Pi already owns the hard part: `CredentialStore` is `read`/`list`/`modify`/
 * `delete` keyed by *provider* id, and `Models.getAuth()` performs OAuth
 * refresh inside `modify` under the store lock so two concurrent requests
 * cannot double-refresh a rotated token. Re-implementing that would be a bug
 * farm. So Pilot's facade is a narrow, provider-neutral face over it.
 *
 * TWO INVARIANTS THIS MODULE EXISTS TO ENFORCE
 * (system-design §12 "never sent to the renderer", §13 "never logged"):
 *
 *  1. Everything renderer-bound is a {@link CredentialStatus} — booleans,
 *     enums, a human-readable source label. There is no field that can hold a
 *     token.
 *  2. Secret material lives in {@link ProviderCredential}, in a `#private`
 *     field. It is unreachable by `JSON.stringify`, by `Object.entries`, by
 *     `structuredClone`, by `util.inspect`, and therefore by the structured
 *     logger in `@pilot/shared` (which walks own enumerable properties). The
 *     only way out is the deliberately greppable {@link
 *     ProviderCredential.reveal}.
 *
 * Auth mode is a Pilot-side statement, not a Pi fact: Pi attaches auth to the
 * provider and one provider can offer both `apiKey` and `oauth` at once
 * (`anthropic` does). `ModelProfile.authMode` records which one Pilot chose.
 */

/** Pi's credential kinds. Re-stated so callers need not import from Pi. */
export type CredentialKind = 'api_key' | 'oauth';

export const REDACTED_SECRET = '[redacted:credential]';

/**
 * Non-secret credential state. This is the only auth shape allowed to cross
 * the IPC boundary to the renderer.
 */
export interface CredentialStatus {
  readonly providerId: string;
  /** Whether a credential is stored or resolvable from the ambient environment. */
  readonly configured: boolean;
  readonly kind: CredentialKind | null;
  /**
   * Human-readable provenance for status UI, e.g. `ANTHROPIC_API_KEY` or
   * `OAuth`. Pi supplies this; it is a label, never a value.
   */
  readonly source: string | null;
  /** Unix ms for OAuth expiry, when known. Never present for api keys. */
  readonly expiresAt: number | null;
  /** True for subscription-backed access, e.g. the Codex ChatGPT plan. */
  readonly isSubscription: boolean;
}

/**
 * Request-time auth material, exactly Pi's `ModelAuth` shape (`apiKey`,
 * `headers`, `baseUrl`). Pi's own rule: "if a value cannot be expressed as
 * `apiKey`, `headers`, or `baseUrl`, it is provider config, not auth."
 */
export interface AuthMaterial {
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string | null>>;
  readonly baseUrl?: string;
}

/**
 * A resolved credential. Constructed in the main process at request time and
 * never serialised.
 */
export class ProviderCredential {
  readonly providerId: string;
  readonly authMode: PilotAuthMode;
  readonly kind: CredentialKind;
  readonly source: string | null;
  readonly expiresAt: number | null;
  readonly isSubscription: boolean;

  readonly #material: AuthMaterial;

  constructor(input: {
    readonly providerId: string;
    readonly authMode: PilotAuthMode;
    readonly kind: CredentialKind;
    readonly material: AuthMaterial;
    readonly source?: string | null;
    readonly expiresAt?: number | null;
    readonly isSubscription?: boolean;
  }) {
    this.providerId = input.providerId;
    this.authMode = input.authMode;
    this.kind = input.kind;
    this.source = input.source ?? null;
    this.expiresAt = input.expiresAt ?? null;
    this.isSubscription = input.isSubscription ?? false;
    this.#material = input.material;
  }

  /**
   * The one exit for secret material. Call it at the moment of the request and
   * do not store the result. Grep for `.reveal(` to audit every use.
   */
  reveal(): AuthMaterial {
    return this.#material;
  }

  /** Renderer-safe projection. */
  describe(): CredentialStatus {
    return {
      providerId: this.providerId,
      configured: true,
      kind: this.kind,
      source: this.source,
      expiresAt: this.expiresAt,
      isSubscription: this.isSubscription,
    };
  }

  /** Makes accidental serialisation harmless rather than catastrophic. */
  toJSON(): CredentialStatus & { readonly secret: string } {
    return { ...this.describe(), secret: REDACTED_SECRET };
  }

  toString(): string {
    return `ProviderCredential(${this.providerId}, ${this.kind}, ${REDACTED_SECRET})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export interface AuthFacade {
  /** Renderer-safe status for one provider. Never resolves secret material. */
  status(providerId: string, options?: AuthOperationOptions): Promise<CredentialStatus>;
  /** Renderer-safe status for every provider Pilot knows about. */
  statuses(options?: AuthOperationOptions): Promise<readonly CredentialStatus[]>;
  /**
   * Retrieves credentials for a request. MAIN PROCESS ONLY.
   *
   * Rejects with `authentication-required` when the provider is not
   * configured — an explicit failure, per the delivery rules, rather than a
   * request that quietly goes out unauthenticated.
   */
  authorize(profile: ModelProfile, options?: AuthOperationOptions): Promise<ProviderCredential>;
  /** Forgets stored credentials for a provider (logout). */
  forget(providerId: string, options?: AuthOperationOptions): Promise<void>;
}

function unconfigured(providerId: string): CredentialStatus {
  return {
    providerId,
    configured: false,
    kind: null,
    source: null,
    expiresAt: null,
    isSubscription: false,
  };
}

function authenticationRequired(providerId: string, detail: string): PilotError {
  return new PilotError('authentication-required', `${providerId}: ${detail}`, {
    userMessage: 'Pilot needs to sign in to this model provider before it can answer.',
    retryable: false,
    details: { providerId },
  });
}

/** Maps a Pi credential kind onto Pilot's `authMode` axis, given the profile. */
function authModeFor(profile: ModelProfile, kind: CredentialKind): PilotAuthMode {
  // The profile is authoritative: it records what Pilot chose. The kind is only
  // a fallback for profiles created before a credential existed.
  if (profile.authMode === 'local' && !profile.isRemote) {
    return 'local';
  }
  return kind === 'oauth' ? 'subscription' : 'api-key';
}

export interface PiAuthFacadeOptions {
  readonly models: Models;
  /**
   * The same store handed to `createModels({ credentials })`. Optional: without
   * it, `status()` still works through `Models.checkAuth`, but expiry and
   * stored-kind reporting fall back to what the provider reports.
   */
  readonly credentials?: CredentialStore;
}

/**
 * The real seam. PR-037/038/039 use this unchanged; they add *providers* and
 * *login flows*, not a second auth path.
 */
export function createPiAuthFacade(options: PiAuthFacadeOptions): AuthFacade {
  const { models, credentials } = options;

  const storedFor = async (
    providerId: string,
    operation?: AuthOperationOptions,
  ): Promise<Credential | undefined> => {
    if (credentials === undefined) {
      return undefined;
    }
    return credentials.read(providerId, operation);
  };

  const isSubscriptionProvider = (providerId: string): boolean =>
    models.getProvider(providerId)?.auth.oauth?.isSubscription === true;

  const status = async (
    providerId: string,
    operation?: AuthOperationOptions,
  ): Promise<CredentialStatus> => {
    const check = await models.checkAuth(providerId, operation);
    if (check === undefined) {
      return unconfigured(providerId);
    }
    const stored = await storedFor(providerId, operation);
    const expiresAt =
      stored !== undefined && stored.type === 'oauth' && typeof stored.expires === 'number'
        ? stored.expires
        : null;
    return {
      providerId,
      configured: true,
      kind: check.type,
      source: check.source ?? null,
      expiresAt,
      isSubscription: check.type === 'oauth' && isSubscriptionProvider(providerId),
    };
  };

  return {
    status,

    async statuses(operation?: AuthOperationOptions): Promise<readonly CredentialStatus[]> {
      const providerIds = new Set(models.getProviders().map((provider) => provider.id));
      if (credentials !== undefined) {
        const listed: readonly CredentialInfo[] = await credentials.list(operation);
        for (const entry of listed) {
          providerIds.add(entry.providerId);
        }
      }
      return Promise.all([...providerIds].sort().map((id) => status(id, operation)));
    },

    async authorize(
      profile: ModelProfile,
      operation?: AuthOperationOptions,
    ): Promise<ProviderCredential> {
      const provider = models.getProvider(profile.provider);
      if (provider === undefined) {
        throw authenticationRequired(profile.provider, 'provider is not registered');
      }
      const model: Model<Api> | undefined = models.getModel(profile.provider, profile.model);
      // Resolving through the model also folds in static per-model headers.
      const resolved =
        model === undefined ? await models.getAuth(profile.provider) : await models.getAuth(model);
      if (resolved === undefined) {
        throw authenticationRequired(profile.provider, 'no credential is configured');
      }
      const stored = await storedFor(profile.provider, operation);
      const kind: CredentialKind =
        stored?.type ?? (profile.authMode === 'subscription' ? 'oauth' : 'api_key');
      const auth: ModelAuth = resolved.auth;
      return new ProviderCredential({
        providerId: profile.provider,
        authMode: authModeFor(profile, kind),
        kind,
        material: toAuthMaterial(auth),
        source: resolved.source ?? null,
        expiresAt:
          stored !== undefined && stored.type === 'oauth' && typeof stored.expires === 'number'
            ? stored.expires
            : null,
        isSubscription: kind === 'oauth' && isSubscriptionProvider(profile.provider),
      });
    },

    async forget(providerId: string, operation?: AuthOperationOptions): Promise<void> {
      await models.logout(providerId, operation);
    },
  };
}

function toAuthMaterial(auth: ModelAuth): AuthMaterial {
  return {
    ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
    ...(auth.headers === undefined ? {} : { headers: { ...auth.headers } }),
    ...(auth.baseUrl === undefined ? {} : { baseUrl: auth.baseUrl }),
  };
}

export interface FakeCredentialEntry {
  readonly kind: CredentialKind;
  readonly material: AuthMaterial;
  readonly source?: string;
  readonly expiresAt?: number;
  readonly isSubscription?: boolean;
}

export interface FakeAuthFacade extends AuthFacade {
  /** Adds or replaces a provider's credential. */
  set(providerId: string, entry: FakeCredentialEntry): void;
  /** Providers `authorize` was called for, in order. Never contains secrets. */
  readonly authorized: readonly string[];
}

/**
 * Deterministic fake for tests and the PR demo. Same public contract as
 * {@link createPiAuthFacade}, per the delivery rule that fakes sit behind the
 * contract the real implementation uses.
 */
export function createFakeAuthFacade(
  initial: Readonly<Record<string, FakeCredentialEntry>> = {},
): FakeAuthFacade {
  const entries = new Map<string, FakeCredentialEntry>(Object.entries(initial));
  const authorized: string[] = [];

  const status = (providerId: string): CredentialStatus => {
    const entry = entries.get(providerId);
    if (entry === undefined) {
      return unconfigured(providerId);
    }
    return {
      providerId,
      configured: true,
      kind: entry.kind,
      source: entry.source ?? null,
      expiresAt: entry.expiresAt ?? null,
      isSubscription: entry.isSubscription ?? false,
    };
  };

  return {
    authorized,
    set(providerId: string, entry: FakeCredentialEntry): void {
      entries.set(providerId, entry);
    },
    async status(providerId: string): Promise<CredentialStatus> {
      return status(providerId);
    },
    async statuses(): Promise<readonly CredentialStatus[]> {
      return [...entries.keys()].sort().map((id) => status(id));
    },
    async authorize(profile: ModelProfile): Promise<ProviderCredential> {
      const entry = entries.get(profile.provider);
      if (entry === undefined) {
        throw authenticationRequired(profile.provider, 'no credential is configured');
      }
      authorized.push(profile.provider);
      return new ProviderCredential({
        providerId: profile.provider,
        authMode: authModeFor(profile, entry.kind),
        kind: entry.kind,
        material: entry.material,
        source: entry.source ?? null,
        expiresAt: entry.expiresAt ?? null,
        isSubscription: entry.isSubscription ?? false,
      });
    },
    async forget(providerId: string): Promise<void> {
      entries.delete(providerId);
    },
  };
}
