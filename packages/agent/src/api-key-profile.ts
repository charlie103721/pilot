import {
  createModels,
  type Api,
  type Model,
  type Models,
  type Provider,
} from '@earendil-works/pi-ai';
import {
  PilotError,
  endpointHost,
  isLoopbackUrl,
  nullLogger,
  type Logger,
  type ModelProfile,
  type SerializedPilotError,
} from '@pilot/shared';
import type { CapabilityConfidence } from './capability.js';
import type { ModelSource } from './development-model.js';
import {
  createEncryptedCredentialStore,
  createSecretScrubber,
  type PilotCredentialStore,
  type SecretCipher,
  type SecretScrubber,
  type SecretStorage,
} from './api-key-credentials.js';
import {
  apiKeyProfileId,
  classifyApiKeyFailure,
  probeApiKeyModel,
  type ApiKeyFailure,
  type CapabilityProbeOutcome,
} from './api-key-probe.js';
import { createPiAuthFacade, type AuthFacade, type CredentialStatus } from './auth-facade.js';
import {
  describeDisclosureLine,
  describeModelDataDisclosure,
  type ModelDataDisclosure,
} from './data-disclosure.js';
import {
  createModelProfileStore,
  type ModelProfileStore,
  type ProfileStorage,
} from './profile-store.js';

/**
 * The API-key provider profile (PR-038).
 *
 * ## What this module is
 *
 * One object — {@link ApiKeyProfileManager} — that owns the five things the PR
 * asks for and nothing else:
 *
 *  1. **safe credential storage** — delegated whole to
 *     `api-key-credentials.ts`; this module never sees a key except as an
 *     argument to {@link ApiKeyProfileManager.saveKey}, and immediately hands it
 *     to the encrypted store and the scrubber.
 *  2. **provider/model selection** — {@link listApiKeyProviders} and
 *     {@link listApiKeyModels} read Pi's live catalogue rather than a table of
 *     names, so nothing here goes stale when a vendor adds a model.
 *  3. **capability probe** — `api-key-probe.ts`, run on selection and on demand.
 *  4. **invalid-key recovery** — {@link ApiKeyProfileManager.noteRunFailure}
 *     takes a failure from a *live conversation* and puts the profile back into
 *     a state where the app stops pretending it works.
 *  5. **remote-data labelling** — `data-disclosure.ts`, recomputed on every
 *     state change so a banner can never describe an older selection.
 *
 * ## The one rule that shapes the whole state machine
 *
 * > "Keep the app honest: a profile that is **configured but not verified** must
 * > not silently look like a working model."
 *
 * So {@link ApiKeyProfileManager.source} returns `null` in every state except
 * `verified`, and the composition root falls back to the development source
 * rather than booting an agent over an unverified profile. There is no state in
 * which Pilot answers a screen question through a model it has not probed.
 *
 * ## Provider neutrality
 *
 * The interface this hands to everything downstream is `ModelSource` — PR-029's
 * shape, unchanged: `profile`, `models`, `model`, `toolSupport`,
 * `requestCount()`, `description`. {@link ApiKeyModelSource} adds three
 * read-only fields on top and adds no method, so anything typed against
 * `ModelSource` accepts it as-is. That is the Phase 4 gate's "one
 * provider-neutral session interface", and PR-037/PR-039 satisfy it by
 * returning the same shape.
 */

/**
 * Pi's `Provider`, re-exported under a Pilot name.
 *
 * `apps/desktop` deliberately has no `@earendil-works/pi-ai` dependency
 * (`development-model.ts`: "apps/desktop has no Pi dependency and should not
 * grow one"), and the composition root still has to name the providers it
 * registers. This alias is the only thing it needs.
 */
export type { Provider as ApiKeyProvider } from '@earendil-works/pi-ai';

/**
 * Pi's 38 built-in vendor providers, loaded on demand.
 *
 * Behind a dynamic import and behind an explicit call, because
 * `@earendil-works/pi-ai/providers/all` reaches the Anthropic, OpenAI, Google,
 * Mistral and Bedrock SDKs, and `apps/desktop/electron.vite.config.ts` inlines
 * everything the main process imports (`ssr.noExternal: true`,
 * `inlineDynamicImports: true`). Nothing in Pilot calls this unless a user asks
 * for a real vendor, and whether a shipped bundle should carry the catalogue is
 * a packaging decision that belongs to PR-042.
 *
 * **Never executed in this environment.** Registering a provider is offline and
 * safe, but there is no key here, so nothing downstream of it has run.
 */
export async function loadBuiltinApiKeyProviders(): Promise<readonly Provider[]> {
  const { builtinProviders } = await import('@earendil-works/pi-ai/providers/all');
  return builtinProviders();
}

/* -------------------------------------------------------------------------- *
 * Provider and model selection
 * -------------------------------------------------------------------------- */

export interface ApiKeyProviderChoice {
  readonly providerId: string;
  /** The provider's display name, or its api-key auth's, whichever exists. */
  readonly displayName: string;
  /** What the key is called on the provider's own site, e.g. "Anthropic API key". */
  readonly credentialName: string;
  /** True when Pi offers an interactive key prompt for this provider. */
  readonly supportsInteractiveLogin: boolean;
  readonly baseUrl: string | null;
  readonly host: string | null;
  /** False only for a provider served from loopback (that is PR-039's case). */
  readonly isRemote: boolean;
  /** Models currently in the provider's catalogue. */
  readonly modelCount: number;
  /** Of those, how many *declare* image input. Not a probe result. */
  readonly visionModelCount: number;
}

export interface ApiKeyModelChoice {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  /**
   * `Model.input` includes `"image"`. A necessary condition for a screen
   * question, never a sufficient one — tool support is not knowable from
   * metadata (`docs/pi-notes.md` §6.3), which is what the probe is for.
   */
  readonly acceptsImages: boolean;
  readonly contextWindow: number;
  readonly isRemote: boolean;
  readonly host: string | null;
}

function providerIsRemote(provider: Provider, models: readonly Model<Api>[]): boolean {
  const url = provider.baseUrl ?? models[0]?.baseUrl;
  return url === undefined ? true : !isLoopbackUrl(url);
}

/**
 * Every registered provider that authenticates with an API key.
 *
 * Reads `Provider.auth.apiKey`, which Pi guarantees is present on every
 * provider that has one — including subscription providers that offer *both*
 * (`anthropic` does). That overlap is exactly why `ModelProfile.authMode` is a
 * Pilot statement rather than a Pi fact (system-design §12, PR-005 correction):
 * a provider appearing in this list does not mean the user must use a key,
 * only that they may.
 */
export function listApiKeyProviders(models: Models): readonly ApiKeyProviderChoice[] {
  return models
    .getProviders()
    .filter((provider) => provider.auth.apiKey !== undefined)
    .map((provider) => {
      const catalogue = models.getModels(provider.id);
      const apiKey = provider.auth.apiKey;
      const baseUrl = provider.baseUrl ?? catalogue[0]?.baseUrl ?? null;
      return {
        providerId: provider.id,
        displayName: provider.name,
        credentialName: apiKey?.name ?? `${provider.name} API key`,
        supportsInteractiveLogin: apiKey?.login !== undefined,
        baseUrl,
        host: endpointHost(baseUrl ?? undefined),
        isRemote: providerIsRemote(provider, catalogue),
        modelCount: catalogue.length,
        visionModelCount: catalogue.filter((model) => model.input.includes('image')).length,
      };
    })
    .sort((left, right) => left.providerId.localeCompare(right.providerId));
}

/** Every model one provider currently lists, with the one fact metadata can give. */
export function listApiKeyModels(models: Models, providerId: string): readonly ApiKeyModelChoice[] {
  return models.getModels(providerId).map((model) => ({
    providerId,
    modelId: model.id,
    displayName: model.name,
    acceptsImages: model.input.includes('image'),
    contextWindow: model.contextWindow,
    isRemote: !isLoopbackUrl(model.baseUrl),
    host: endpointHost(model.baseUrl),
  }));
}

/**
 * The models worth probing, best first.
 *
 * Ordering only; it removes nothing except models that cannot possibly work.
 * "Exact models are selected by successful capability probes rather than
 * hard-coded assumptions" (Phase 4 preamble) — so this ranks candidates and the
 * probe decides, rather than a list of vendor model names deciding here.
 */
export function rankApiKeyModels(
  choices: readonly ApiKeyModelChoice[],
): readonly ApiKeyModelChoice[] {
  return choices
    .filter((choice) => choice.acceptsImages)
    .toSorted((left, right) => right.contextWindow - left.contextWindow);
}

/* -------------------------------------------------------------------------- *
 * Request counting
 * -------------------------------------------------------------------------- */

export interface CountingModels {
  readonly models: Models;
  /** Provider requests dispatched through this wrapper. */
  count(): number;
}

/**
 * A `Models` that counts requests.
 *
 * `ModelSource.requestCount()` exists so "the gate refused *before anything was
 * sent*" can be a number a test asserts on rather than a claim about control
 * flow (PR-029). `createDevelopmentModelSource` gets that number free from the
 * faux provider's `state.callCount`; a real provider has no such counter, so it
 * is counted at the one place every request passes through.
 *
 * Delegation is explicit rather than a `Proxy` so that a future `Models` method
 * fails to compile here instead of silently going uncounted.
 */
export function createCountingModels(inner: Models): CountingModels {
  let count = 0;
  const tick = (): void => {
    count += 1;
  };
  const models: Models = {
    getProviders: () => inner.getProviders(),
    getProvider: (id) => inner.getProvider(id),
    getModels: (provider) => inner.getModels(provider),
    getModel: (provider, id) => inner.getModel(provider, id),
    refresh: (refreshOptions) => inner.refresh(refreshOptions),
    checkAuth: (id, authOptions) => inner.checkAuth(id, authOptions),
    getAvailable: (id, authOptions) => inner.getAvailable(id, authOptions),
    getAuth: inner.getAuth.bind(inner),
    login: (id, type, interaction) => inner.login(id, type, interaction),
    logout: (id, authOptions) => inner.logout(id, authOptions),
    stream: (model, context, streamOptions) => {
      tick();
      return inner.stream(model, context, streamOptions);
    },
    complete: async (model, context, streamOptions) => {
      tick();
      return inner.complete(model, context, streamOptions);
    },
    streamSimple: (model, context, streamOptions) => {
      tick();
      return inner.streamSimple(model, context, streamOptions);
    },
    completeSimple: async (model, context, streamOptions) => {
      tick();
      return inner.completeSimple(model, context, streamOptions);
    },
    fetchDeferred: (model, handle, fetchOptions) =>
      inner.fetchDeferred(model, handle, fetchOptions),
    cancelDeferred: (model, handle, cancelOptions) =>
      inner.cancelDeferred(model, handle, cancelOptions),
  };
  return { models, count: () => count };
}

/* -------------------------------------------------------------------------- *
 * The source
 * -------------------------------------------------------------------------- */

/**
 * A verified API-key model, in the shape everything downstream already
 * consumes.
 *
 * Structurally a `ModelSource` plus three read-only facts. Nothing is added to
 * the *methods*, so `createAgentRuntime`, `resolveContextWindow` and
 * `PiAgentSession` take it without a line changing.
 */
export interface ApiKeyModelSource extends ModelSource {
  /** Renderer-safe credential state (PR-020). No field can hold a token. */
  readonly credential: CredentialStatus;
  /** What the user must be shown before an observation is sent (§14). */
  readonly disclosure: ModelDataDisclosure;
  /** The probe that produced this source. `toolSupport` is `'verified'`. */
  readonly probe: CapabilityProbeOutcome;
}

/* -------------------------------------------------------------------------- *
 * Assembling the collection
 * -------------------------------------------------------------------------- */

/**
 * A `Models` collection, its encrypted credential store, and the scrubber that
 * has been told about every key either of them has seen.
 *
 * The three are built together because the wiring between them is the whole
 * point and is silently useless when it is skipped: `createModels({
 * credentials })` is what makes Pi's own `envApiKeyAuth.resolve` read the
 * *stored* credential ("a stored credential key wins, otherwise the first set
 * env var resolves") rather than only the environment. Build the collection
 * without the store and the encrypted file is written, never read, and the app
 * silently depends on an environment variable being present at every launch —
 * which looks exactly like working software until the user closes their
 * terminal.
 */
export interface ApiKeyModelsBundle {
  readonly models: Models;
  readonly credentials: PilotCredentialStore;
  readonly scrubber: SecretScrubber;
}

export interface CreateApiKeyModelsOptions {
  /** Encrypts the credential. The app supplies a Keychain-backed one. */
  readonly cipher: SecretCipher;
  /** Where the sealed credential is kept. Defaults to memory. */
  readonly secretStorage?: SecretStorage;
  /** Providers to register. Everything with `auth.apiKey` becomes selectable. */
  readonly providers?: readonly Provider[];
}

export function createApiKeyModels(options: CreateApiKeyModelsOptions): ApiKeyModelsBundle {
  const scrubber = createSecretScrubber();
  const credentials = createEncryptedCredentialStore({
    cipher: options.cipher,
    ...(options.secretStorage === undefined ? {} : { storage: options.secretStorage }),
    scrubber,
  });
  const models = createModels({ credentials });
  for (const provider of options.providers ?? []) {
    models.setProvider(provider);
  }
  return { models, credentials, scrubber };
}

/* -------------------------------------------------------------------------- *
 * The manager
 * -------------------------------------------------------------------------- */

export type ApiKeyProfileState =
  /** No provider/model chosen, or no credential at all. */
  | 'unconfigured'
  /** A selection and a credential exist; no probe has succeeded. */
  | 'configured-unverified'
  /** A probe succeeded against this exact model. The only usable state. */
  | 'verified'
  /** The provider rejected the credential, at probe time or mid-conversation. */
  | 'invalid-key'
  /** The probe ran and the model cannot do the job. */
  | 'unsupported-model'
  /** The provider could not be reached, or refused for a reason that is not the key. */
  | 'provider-unavailable';

export interface ApiKeyProfileStatus {
  readonly state: ApiKeyProfileState;
  /** True only in `verified`. The one thing the composition root branches on. */
  readonly usable: boolean;
  readonly providerId: string | null;
  readonly modelId: string | null;
  /** Renderer-safe. Never a token. */
  readonly credential: CredentialStatus;
  /** Null until a provider and model are chosen. */
  readonly disclosure: ModelDataDisclosure | null;
  /** The most recent probe, or null. */
  readonly probe: CapabilityProbeOutcome | null;
  /** The most recent provider failure, serialised and already scrubbed. */
  readonly failure: SerializedPilotError | null;
  /** What the user should do next. Empty when there is nothing to do. */
  readonly remedy: string;
  /** One line for a log or a demo. Contains no secret and no screen text. */
  readonly summary: string;
  /** Name of the store holding the credential, for the disclosure. */
  readonly storageName: string;
  /** True when this machine can store a credential at all. */
  readonly secureStorageAvailable: boolean;
}

export interface ApiKeyProfileManager {
  status(): ApiKeyProfileStatus;
  /** Re-reads credential state and the persisted selection. Makes no request. */
  refresh(): Promise<ApiKeyProfileStatus>;
  /** Stores a key, encrypted. Does **not** verify it — call {@link verify}. */
  saveKey(key: string): Promise<ApiKeyProfileStatus>;
  /** Forgets the stored key (logout). Leaves the selection alone. */
  forgetKey(): Promise<ApiKeyProfileStatus>;
  /**
   * Names the provider and model without probing them.
   *
   * Separate from {@link select} because entering a key requires knowing which
   * provider it is for, and probing requires the key: choose → saveKey →
   * verify is the order the app actually needs.
   */
  choose(providerId: string, modelId: string): Promise<ApiKeyProfileStatus>;
  /** {@link choose} followed by {@link verify}. Persists only on success. */
  select(providerId: string, modelId: string): Promise<ApiKeyProfileStatus>;
  /** Re-probes the current selection. This is the invalid-key recovery step. */
  verify(): Promise<ApiKeyProfileStatus>;
  /**
   * Reports a failure that happened during a real conversation.
   *
   * The probe is not the only place a key can turn out to be bad — a key
   * revoked between the probe and the third question fails in the middle of an
   * answer. Feeding that failure back here is what stops the app continuing to
   * present a model it can no longer reach.
   */
  noteRunFailure(error: SerializedPilotError | PilotError | string): ApiKeyProfileStatus;
  /** `null` unless {@link ApiKeyProfileStatus.usable}. Never a half-working source. */
  source(): ApiKeyModelSource | null;
  providers(): readonly ApiKeyProviderChoice[];
  modelsFor(providerId: string): readonly ApiKeyModelChoice[];
  /** The encrypted store, for the composition root's diagnostics only. */
  readonly credentials: PilotCredentialStore;
  /** Told about every key that passes through. Wire it into error paths. */
  readonly scrubber: SecretScrubber;
  readonly auth: AuthFacade;
}

export interface CreateApiKeyProfileManagerOptions {
  /** From {@link createApiKeyModels}: the collection, the store and the scrubber. */
  readonly bundle: ApiKeyModelsBundle;
  /** Where the chosen profile is kept. Defaults to memory (PR-020's store). */
  readonly profileStorage?: ProfileStorage;
  /** Human-readable name of the secure store, for the disclosure line. */
  readonly storageName?: string;
  readonly logger?: Logger;
}

function unconfiguredCredential(providerId: string | null): CredentialStatus {
  return {
    providerId: providerId ?? '(none)',
    configured: false,
    kind: null,
    source: null,
    expiresAt: null,
    isSubscription: false,
  };
}

const STATE_REMEDIES: Readonly<Record<ApiKeyProfileState, string>> = {
  unconfigured: 'Choose a model provider and enter an API key.',
  'configured-unverified': 'Verify the model so Pilot can confirm it answers screen questions.',
  verified: '',
  'invalid-key': 'Enter a new API key for this provider.',
  'unsupported-model': 'Choose a different model: this one cannot see images or cannot call tools.',
  'provider-unavailable': 'Check the network, then verify again.',
};

/**
 * Builds the manager.
 *
 * Nothing here makes a network request or reads a credential at construction —
 * {@link ApiKeyProfileManager.refresh} does that, and it is `async` so the
 * composition root awaits it explicitly rather than getting a half-initialised
 * object.
 */
export function createApiKeyProfileManager(
  options: CreateApiKeyProfileManagerOptions,
): ApiKeyProfileManager {
  const logger = options.logger ?? nullLogger;
  const { credentials, scrubber } = options.bundle;
  const storageName = options.storageName ?? credentials.cipherName;

  // Counted once, around the collection everything downstream uses: the probe,
  // the session and any diagnostics all go through the same counter, so
  // `requestCount()` is the number of requests this profile has ever caused.
  const counting = createCountingModels(options.bundle.models);
  const models = counting.models;
  const auth = createPiAuthFacade({ models, credentials });
  const profiles: ModelProfileStore = createModelProfileStore({
    ...(options.profileStorage === undefined ? {} : { storage: options.profileStorage }),
  });

  let state: ApiKeyProfileState = 'unconfigured';
  let providerId: string | null = null;
  let modelId: string | null = null;
  let credential: CredentialStatus = unconfiguredCredential(null);
  let probe: CapabilityProbeOutcome | null = null;
  let failure: SerializedPilotError | null = null;
  let profile: ModelProfile | null = null;
  let toolSupport: CapabilityConfidence = 'assumed';

  const disclosureNow = (): ModelDataDisclosure | null =>
    profile === null
      ? null
      : describeModelDataDisclosure({
          profile,
          credential,
          storageName: credential.configured ? storageName : null,
          verification:
            state === 'verified'
              ? 'verified'
              : state === 'unsupported-model'
                ? 'rejected'
                : 'unverified',
        });

  const status = (): ApiKeyProfileStatus => {
    const disclosure = disclosureNow();
    const where = providerId === null ? 'no provider' : `${providerId}/${modelId ?? 'no model'}`;
    return {
      state,
      usable: state === 'verified',
      providerId,
      modelId,
      credential,
      disclosure,
      probe,
      failure,
      remedy: STATE_REMEDIES[state],
      storageName,
      secureStorageAvailable: credentials.secureStorageAvailable,
      summary:
        `api-key profile: ${state} · ${where} · credential ` +
        `${credential.configured ? `configured (${credential.source ?? 'stored'})` : 'absent'}` +
        (disclosure === null ? '' : ` · ${describeDisclosureLine(disclosure)}`),
    };
  };

  const setFailure = (apiFailure: ApiKeyFailure, nextState: ApiKeyProfileState): void => {
    state = nextState;
    failure = apiFailure.error.toJSON();
    // The message is already scrubbed by `classifyApiKeyFailure`; the code and
    // the kind are the only things logged, because a provider's error body is
    // the single most likely place for a key to appear.
    logger.warn('api-key profile failure', {
      code: apiFailure.error.code,
      kind: apiFailure.kind,
      providerId,
      state: nextState,
    });
  };

  const readCredentialStatus = async (): Promise<CredentialStatus> => {
    if (providerId === null) {
      return unconfiguredCredential(null);
    }
    try {
      return await auth.status(providerId);
    } catch {
      return unconfiguredCredential(providerId);
    }
  };

  const refresh = async (): Promise<ApiKeyProfileStatus> => {
    const record = await profiles.selected();
    if (record !== null) {
      providerId = record.profile.provider;
      modelId = record.profile.model;
      profile = record.profile;
      toolSupport = record.toolSupport;
    }
    credential = await readCredentialStatus();
    if (providerId === null || modelId === null) {
      state = 'unconfigured';
    } else if (!credential.configured) {
      // A saved selection with no credential is *not* verified, whatever it
      // was last time: the key is what the verification was about.
      state = 'unconfigured';
    } else if (state === 'verified' && probe === null) {
      // Restored from disk. The last run's probe does not survive a relaunch,
      // and a probe that has not run in this process has not run.
      state = 'configured-unverified';
    } else if (state === 'unconfigured') {
      state = 'configured-unverified';
    }
    return status();
  };

  const probeCurrent = async (): Promise<ApiKeyProfileStatus> => {
    if (providerId === null || modelId === null) {
      state = 'unconfigured';
      return status();
    }
    const outcome = await probeApiKeyModel({
      models,
      providerId,
      modelId,
      profileId: apiKeyProfileId(providerId, modelId),
      scrubber,
    });
    probe = outcome;
    credential = await readCredentialStatus();

    if (outcome.ok && outcome.profile !== null) {
      profile = outcome.profile;
      toolSupport = 'verified';
      state = 'verified';
      failure = null;
      await profiles.save({
        profile: outcome.profile,
        displayName: `${providerId} / ${modelId}`,
        toolSupport: 'verified',
        credentialRef: providerId,
      });
      await profiles.select(outcome.profile.id);
      logger.info('api-key profile verified', {
        providerId,
        modelId,
        vision: outcome.vision,
        tools: outcome.tools,
        providerRequests: outcome.providerRequests,
        // `screenDataSent`, not `imageBlocksSent`: `@pilot/shared`'s redactor
        // replaces the value of any field whose key matches /image/, and this
        // number — always 0 — is the evidence for the Phase 4 gate.
        screenDataSent: outcome.imageBlocksSent,
      });
      return status();
    }

    if (outcome.failure !== null) {
      setFailure(
        outcome.failure,
        outcome.failure.kind === 'invalid-key'
          ? 'invalid-key'
          : outcome.failure.kind === 'not-configured'
            ? 'unconfigured'
            : 'provider-unavailable',
      );
      return status();
    }

    // A refusal rather than a failure: the credential worked, the model does
    // not. Keep the selection so the user can see what was rejected and why,
    // but never hand it out as a source.
    if (outcome.profile === null && outcome.refusal !== null) {
      profile = provisionalProfile(models, providerId, modelId);
    }
    state = 'unsupported-model';
    failure = null;
    logger.warn('api-key profile rejected by the capability probe', {
      providerId,
      modelId,
      stage: outcome.stage,
      reason: outcome.refusal?.reason ?? 'unknown',
      providerRequests: outcome.providerRequests,
      screenDataSent: outcome.imageBlocksSent,
    });
    return status();
  };

  return {
    credentials,
    scrubber,
    auth,
    status,
    refresh,
    providers: () => listApiKeyProviders(models),
    modelsFor: (id) => listApiKeyModels(models, id),

    async saveKey(key: string): Promise<ApiKeyProfileStatus> {
      if (providerId === null) {
        throw new PilotError(
          'invalid-request',
          'Choose a model provider before entering an API key',
          { userMessage: 'Choose a model provider first.' },
        );
      }
      scrubber.remember(key);
      await credentials.modify(providerId, async () => ({ type: 'api_key', key }));
      credential = await readCredentialStatus();
      // A new key invalidates whatever the last probe concluded.
      probe = null;
      failure = null;
      state = credential.configured ? 'configured-unverified' : 'unconfigured';
      logger.info('api-key credential stored', {
        providerId,
        cipher: credentials.cipherName,
        // Never the key, never its length: a length narrows a search space.
        stored: true,
      });
      return status();
    },

    async forgetKey(): Promise<ApiKeyProfileStatus> {
      if (providerId !== null) {
        await credentials.delete(providerId);
      }
      scrubber.forget();
      credential = await readCredentialStatus();
      probe = null;
      failure = null;
      state = 'unconfigured';
      return status();
    },

    async choose(nextProvider: string, nextModel: string): Promise<ApiKeyProfileStatus> {
      providerId = nextProvider;
      modelId = nextModel;
      // Provisional, so the disclosure banner can say "remote, unverified"
      // *before* the probe runs. §14 asks the user be shown where their screen
      // would go before observation begins, and "before" includes before Pilot
      // has decided whether the model works at all.
      profile = provisionalProfile(models, nextProvider, nextModel);
      probe = null;
      failure = null;
      credential = await readCredentialStatus();
      state = credential.configured ? 'configured-unverified' : 'unconfigured';
      return status();
    },

    async select(nextProvider: string, nextModel: string): Promise<ApiKeyProfileStatus> {
      providerId = nextProvider;
      modelId = nextModel;
      profile = null;
      probe = null;
      failure = null;
      state = 'configured-unverified';
      credential = await readCredentialStatus();
      return probeCurrent();
    },

    verify: probeCurrent,

    noteRunFailure(error): ApiKeyProfileStatus {
      const text =
        typeof error === 'string'
          ? error
          : error instanceof PilotError
            ? error.message
            : `${error.code}: ${error.message}`;
      const apiFailure = classifyApiKeyFailure(text, {
        providerId: providerId ?? '(none)',
        ...(modelId === null ? {} : { modelId }),
        scrubber,
      });
      if (apiFailure.kind === 'invalid-key' || apiFailure.kind === 'not-configured') {
        // The important half: the profile stops being `verified`, so
        // `source()` stops handing it out and the disclosure banner stops
        // claiming the model is confirmed.
        setFailure(apiFailure, 'invalid-key');
      } else if (apiFailure.kind === 'unreachable') {
        setFailure(apiFailure, 'provider-unavailable');
      } else {
        // A rate limit or an unclassified provider error is not a reason to
        // tear down a profile that was verified: the key is fine and the next
        // question may well work. Record it, change nothing.
        failure = apiFailure.error.toJSON();
      }
      return status();
    },

    source(): ApiKeyModelSource | null {
      if (state !== 'verified' || profile === null || providerId === null || modelId === null) {
        return null;
      }
      const model = models.getModel(providerId, modelId);
      const outcome = probe;
      const disclosure = disclosureNow();
      if (model === undefined || outcome === null || disclosure === null) {
        return null;
      }
      return {
        profile,
        models,
        model,
        toolSupport,
        credential,
        disclosure,
        probe: outcome,
        requestCount: counting.count,
        description:
          `${providerId}/${modelId} over an API key — ` +
          `${disclosure.sendsScreenOffDevice ? `REMOTE: screen images are sent to ${disclosure.destination}` : `local endpoint ${disclosure.destination}`}` +
          `; key held in ${storageName}; capability probe verified (vision ${String(outcome.vision)}, tools ${String(outcome.tools)})`,
      };
    },
  };
}

/**
 * A profile for a model that has been *chosen* but not *verified*.
 *
 * There is still a banner to render — "this is the model you picked, it is
 * remote, and Pilot has not confirmed it works" is what §14 asks for before an
 * observation, and "this one was rejected and nothing was sent" is what a user
 * needs after a refusal. Neither is ever handed to a session:
 * {@link ApiKeyProfileManager.source} keys on the state, not on this.
 *
 * `supportsTools: false` deliberately. Nothing has watched this model call a
 * tool, and the pessimistic value is the one that cannot cause a capability
 * gate somewhere else to pass by accident if this object ever escapes.
 */
function provisionalProfile(
  models: Models,
  providerId: string,
  modelId: string,
): ModelProfile | null {
  const model = models.getModel(providerId, modelId);
  if (model === undefined) {
    return null;
  }
  return {
    id: apiKeyProfileId(providerId, modelId),
    provider: providerId,
    model: modelId,
    authMode: 'api-key',
    ...(model.baseUrl === '' ? {} : { baseUrl: model.baseUrl }),
    supportsVision: model.input.includes('image'),
    supportsTools: false,
    isRemote: !isLoopbackUrl(model.baseUrl),
  };
}
