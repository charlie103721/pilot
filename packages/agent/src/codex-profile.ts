import type {
  Api,
  AssistantMessageEventStream,
  Context,
  CredentialStore,
  Model,
  Models,
  MutableModels,
} from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import {
  PilotError,
  nullLogger,
  type Logger,
  type ModelProfile,
  type SerializedPilotError,
} from '@pilot/shared';
import type { AgentEvent, AgentRunHandle, AgentSession, InterruptMode } from '@pilot/platform';
import type { QuestionEnvelope } from '@pilot/shared';
import { verifyProfileAgainstModel, type CapabilityDecision } from './capability.js';
import { toModelProfileWithProvenance } from './model-profile.js';
import type { ModelSource } from './development-model.js';
import {
  CODEX_PROVIDER_ID,
  classifyCodexAuthFailure,
  codexAuthFailure,
  describeCodexAuth,
  readCodexAuthStatus,
  signInToCodex,
  signOutOfCodex,
  signedOutCodexStatus,
  type CodexAuthFailure,
  type CodexAuthStatus,
  type CodexSignInObserver,
  type CodexSignInResult,
} from './codex-auth.js';

/**
 * The Codex subscription profile (PR-037).
 *
 * WHAT THIS PRODUCES. A {@link ModelSource} — the provider-neutral interface
 * PR-029 introduced and runbook follow-up 22 names: profile, `Models`, `Model`,
 * `toolSupport`, a request counter and one line of description. Everything
 * downstream of `main/index.ts` consumes that interface and nothing else, so
 * this file is the "one call site" the follow-up promised, and PR-038's and
 * PR-039's are the same shape.
 *
 * WHAT IT ADDS ON TOP, and why each is not optional:
 *
 *  - **{@link CodexModelSource.auth}** — the auth axis. Subscription access has
 *    a lifecycle an API key does not: a token that expires, a refresh that can
 *    fail, and a sign-out. `ModelSource` deliberately says nothing about
 *    credentials, so the controller lives here.
 *  - **{@link CodexModelSource.capability}** — the gate's decision, kept rather
 *    than thrown. `gpt-5.3-codex-spark` is text-only (`docs/pi-notes.md` §9.1)
 *    and Pi silently ignores images for a non-vision model, so an unsupported
 *    model must be refused *before* a screen is read, and the caller has to be
 *    able to say why without catching an exception.
 *  - **A counting, guarding `Models`** — see {@link createGuardedModels}.
 *
 * VISION IS PROBED, TOOLS ARE CONFIGURED. `Model.input` is real provider
 * metadata shipped in the pinned package, so `supportsVision` is ground truth.
 * Pi carries no tool metadata at all (`capability.ts`), so `supportsTools` is a
 * Pilot statement — here an explicit `true`, recorded as `'verified'`, because
 * every model in this catalogue is a Codex Responses model and the Responses
 * API is a tool-calling API. That claim is the one thing in this file the first
 * real session must check, and `docs/handoff.md` §2 says so.
 */

/**
 * Codex models Pilot will offer, most capable first.
 *
 * Read from the pinned catalogue (`pi-ai/dist/providers/data/openai-codex.json`)
 * rather than invented, and filtered by `Model.input` at runtime rather than
 * trusted from this list — the list only decides *preference*.
 * `docs/pi-notes.md` §9.1 recorded `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5` and
 * `gpt-5.6-luna` as vision-capable; the pinned catalogue also carries
 * `gpt-5.6-sol`, and the runtime filter is what admits it.
 */
export const CODEX_PREFERRED_MODELS = [
  'gpt-5.5',
  'gpt-5.6-sol',
  'gpt-5.4',
  'gpt-5.6-luna',
  'gpt-5.4-mini',
] as const;

/**
 * The one model in the catalogue that must never be chosen for a visual
 * conversation. Named so a test can assert the gate refuses it rather than
 * asserting that nothing happens.
 */
export const CODEX_TEXT_ONLY_MODEL = 'gpt-5.3-codex-spark';

export interface CodexModelChoice {
  readonly model: Model<Api>;
  /** Ids the provider offered that accept images, in catalogue order. */
  readonly visionModels: readonly string[];
}

/**
 * Picks the model to run on.
 *
 * Preference order, then any other vision model, and **never** a text-only one
 * unless the caller named it explicitly — a caller that names
 * {@link CODEX_TEXT_ONLY_MODEL} gets it, and the capability gate then refuses
 * it, which is the behaviour `docs/handoff.md` §2 asks to be demonstrable.
 */
export function selectCodexModel(models: Models, preferred?: string): CodexModelChoice {
  const catalogue = models.getModels(CODEX_PROVIDER_ID);
  if (catalogue.length === 0) {
    throw new PilotError('provider-unavailable', `No models registered for ${CODEX_PROVIDER_ID}`, {
      userMessage: 'Pilot could not find any ChatGPT models to use.',
      retryable: false,
    });
  }
  const visionModels = catalogue
    .filter((model) => model.input.includes('image'))
    .map((model) => model.id);

  if (preferred !== undefined) {
    const named = catalogue.find((model) => model.id === preferred);
    if (named === undefined) {
      throw new PilotError(
        'provider-unavailable',
        `${CODEX_PROVIDER_ID} has no model "${preferred}" (offered: ${catalogue.map((model) => model.id).join(', ')})`,
        {
          userMessage: 'That ChatGPT model is not available. Pick another one.',
          retryable: false,
        },
      );
    }
    return { model: named, visionModels };
  }

  for (const id of CODEX_PREFERRED_MODELS) {
    const match = catalogue.find((model) => model.id === id && model.input.includes('image'));
    if (match !== undefined) {
      return { model: match, visionModels };
    }
  }
  const anyVision = catalogue.find((model) => model.input.includes('image'));
  if (anyVision !== undefined) {
    return { model: anyVision, visionModels };
  }
  // Nothing in the catalogue can see. Hand back the first model anyway: the
  // capability gate is the one place that refuses, and it says why.
  return { model: catalogue[0] as Model<Api>, visionModels };
}

/** Stable Pilot-side profile id for a Codex model. */
export function codexProfileId(modelId: string): string {
  return `codex-${modelId}`;
}

/* -------------------------------------------------------------------------- *
 * The auth controller
 * -------------------------------------------------------------------------- */

export interface CodexAuthController {
  /** Last known status, synchronously. Refreshed by {@link refresh}. */
  snapshot(): CodexAuthStatus;
  /** Re-reads the credential store. Never resolves or refreshes a token. */
  refresh(signal?: AbortSignal): Promise<CodexAuthStatus>;
  /** Device-code sign-in. See `codex-auth.ts` for why it is never the browser flow. */
  signIn(observer: CodexSignInObserver, signal?: AbortSignal): Promise<CodexSignInResult>;
  /** Forgets the stored credential. */
  signOut(signal?: AbortSignal): Promise<CodexAuthStatus>;
  /**
   * Throws unless the *cached* snapshot says a question can be answered.
   *
   * Synchronous on purpose: it is called from inside `Models.streamSimple`,
   * which Pi requires to return a stream rather than a promise. A cached answer
   * is sound here because Pilot owns the credential store — nothing else
   * rotates or deletes the credential behind its back — and because the only
   * time-dependent part of the decision, hard expiry, is a comparison against a
   * timestamp this process already has.
   */
  assertUsable(): void;
  /**
   * Authoritative pre-flight: re-reads the store, then {@link assertUsable}.
   * Called before a run starts, which is before any screen is captured.
   */
  ensureUsable(signal?: AbortSignal): Promise<CodexAuthStatus>;
  /** Classifies a provider/session failure as a Codex auth failure, or `null`. */
  classify(error: unknown): CodexAuthFailure | null;
}

export interface CodexAuthControllerOptions {
  readonly models: Models;
  readonly credentials?: CredentialStore;
  readonly providerId?: string;
  readonly now?: () => number;
  readonly logger?: Logger;
}

export function createCodexAuthController(
  options: CodexAuthControllerOptions,
): CodexAuthController {
  const providerId = options.providerId ?? CODEX_PROVIDER_ID;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? nullLogger;
  let snapshot: CodexAuthStatus = signedOutCodexStatus(providerId);

  const read = async (signal?: AbortSignal): Promise<CodexAuthStatus> => {
    const status = await readCodexAuthStatus({
      models: options.models,
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      providerId,
      now,
      ...(signal === undefined ? {} : { signal }),
    });
    snapshot = status;
    return status;
  };

  const assertUsable = (): void => {
    // Re-derived against the current clock rather than trusted as stored: a
    // snapshot taken twenty minutes ago said `active` and is now wrong.
    const current = describeCodexAuth(snapshot, now());
    snapshot = current;
    if (!current.signInRequired) {
      return;
    }
    throw codexAuthFailure(
      current.state === 'expired' ? 'expired' : 'signed-out',
      current.state === 'expired'
        ? `${providerId}: the stored sign-in expired at ${String(current.expiresAt)}`
        : `${providerId}: no credential is configured`,
    ).error;
  };

  return {
    snapshot: () => snapshot,
    refresh: (signal) => read(signal),
    async signIn(observer, signal): Promise<CodexSignInResult> {
      const result = await signInToCodex({
        models: options.models,
        observer,
        providerId,
        logger,
        ...(signal === undefined ? {} : { signal }),
      });
      // Re-read rather than trusting the login's own status: `signInToCodex`
      // has no credential store to read the expiry from, and a status with no
      // expiry would report "signed in, forever".
      const status = await read(signal);
      return { ...result, status };
    },
    async signOut(signal): Promise<CodexAuthStatus> {
      const status = await signOutOfCodex({
        models: options.models,
        providerId,
        ...(signal === undefined ? {} : { signal }),
      });
      snapshot = status;
      logger.info('signed out of the model provider', { providerId });
      return status;
    },
    assertUsable,
    async ensureUsable(signal): Promise<CodexAuthStatus> {
      await read(signal);
      assertUsable();
      return snapshot;
    },
    classify: (error) => classifyCodexAuthFailure(error),
  };
}

/* -------------------------------------------------------------------------- *
 * The counting, guarding `Models`
 * -------------------------------------------------------------------------- */

export interface GuardedModelsOptions {
  readonly auth?: Pick<CodexAuthController, 'assertUsable'>;
}

export interface GuardedModels {
  readonly models: Models;
  /** Provider requests actually started. Zero is what "nothing was sent" means. */
  requestCount(): number;
}

/**
 * Wraps a `Models` so Pilot can say two things it otherwise cannot.
 *
 * 1. **How many provider requests were made.** `ModelSource.requestCount()`
 *    exists so "the capability gate refused before anything was sent" is a
 *    number a test asserts rather than a claim about control flow. Pi's faux
 *    provider counts its own calls; a real provider does not, so the count has
 *    to be taken here, at the only two methods `PiAgentSession` can reach the
 *    network through.
 * 2. **That an unusable credential costs zero requests.** The guard throws
 *    *before* delegating, so a signed-out or expired profile never opens a
 *    socket — and, because the throw happens on the first provider request of a
 *    run, before the model has had any chance to call `observe_screen`, no
 *    screen is ever captured for a question that cannot be answered.
 *
 * A `Proxy` rather than a hand-written delegate: `Models` has seventeen members
 * and two of them are overloaded, and the same idiom is already used for the
 * helper transport in `src/observation/observe-rig.ts`. Methods are bound to
 * the target, which is what makes the count exact: Pi's own `completeSimple`
 * calls `this.streamSimple` on the *target*, so intercepting all four request
 * entry points counts each request once and never twice.
 */
const REQUEST_METHODS: ReadonlySet<string> = new Set([
  'stream',
  'streamSimple',
  'complete',
  'completeSimple',
]);

export function createGuardedModels(
  inner: Models,
  options: GuardedModelsOptions = {},
): GuardedModels {
  let requests = 0;
  const guard = options.auth;

  const models = new Proxy(inner, {
    get(target, property): unknown {
      if (typeof property === 'string' && REQUEST_METHODS.has(property)) {
        return (
          model: Model<Api>,
          context: Context,
          streamOptions?: unknown,
        ): AssistantMessageEventStream => {
          guard?.assertUsable();
          requests += 1;
          const method = Reflect.get(target, property) as (
            a: unknown,
            b: unknown,
            c: unknown,
          ) => AssistantMessageEventStream;
          return method.call(target, model, context, streamOptions);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Models;

  return { models, requestCount: () => requests };
}

/* -------------------------------------------------------------------------- *
 * The model source
 * -------------------------------------------------------------------------- */

export interface CodexModelSource extends ModelSource {
  readonly providerId: string;
  readonly auth: CodexAuthController;
  /**
   * The gate's decision for this profile and model, computed once at
   * construction with zero provider requests made.
   */
  readonly capability: CapabilityDecision;
  /** Ids in the catalogue that accept images. Empty is a real, reportable state. */
  readonly visionModels: readonly string[];
}

export interface CodexModelSourceOptions {
  /**
   * The collection to register the Codex provider into. Defaults to a fresh
   * `createModels({ credentials })`. The fake auth surface passes its own,
   * already carrying a provider with the same id, and nothing is re-registered
   * over it.
   */
  readonly models?: MutableModels;
  /** Where the refresh token lives. Omit to run entirely in memory. */
  readonly credentials?: CredentialStore;
  /** Overrides {@link selectCodexModel}'s preference order. */
  readonly model?: string;
  readonly now?: () => number;
  readonly logger?: Logger;
}

/**
 * Builds the Codex `ModelSource`.
 *
 * **Constructing it makes no network request and needs no credential**, which
 * is what lets `main/index.ts` build it at startup and report an honest status
 * instead of either hanging or pretending. The catalogue is static data in the
 * pinned package; auth is read from the store, and the *absence* of a
 * credential is a state, not an error.
 */
export function createCodexModelSource(options: CodexModelSourceOptions = {}): CodexModelSource {
  const logger = options.logger ?? nullLogger;
  const models =
    options.models ??
    createModels(options.credentials === undefined ? {} : { credentials: options.credentials });
  if (models.getProvider(CODEX_PROVIDER_ID) === undefined) {
    models.setProvider(openaiCodexProvider());
  }

  const { model, visionModels } = selectCodexModel(models, options.model);
  const { profile, toolSupport } = toModelProfileWithProvenance(model, {
    id: codexProfileId(model.id),
    authMode: 'subscription',
    // Configured, not probed. See the module comment.
    supportsTools: true,
  });

  const auth = createCodexAuthController({
    models,
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    ...(options.now === undefined ? {} : { now: options.now }),
    logger,
  });

  const guarded = createGuardedModels(models, { auth });
  const capability = verifyProfileAgainstModel(profile, model, { toolSupport });

  return {
    providerId: CODEX_PROVIDER_ID,
    profile,
    models: guarded.models,
    model,
    toolSupport,
    capability,
    visionModels,
    requestCount: guarded.requestCount,
    get description(): string {
      return describeCodexModelSource(profile, auth.snapshot(), capability);
    },
    auth,
  };
}

/**
 * The startup line, and the demo header.
 *
 * Runbook follow-up 22: "a Codex profile that is configured but not signed in
 * must not silently look like a working model". So the description names the
 * auth state and the capability decision, not only the provider and the model —
 * the same honesty `createDevelopmentModelSource`'s "not a language model"
 * line carries, applied to the state this profile is actually in today.
 */
export function describeCodexModelSource(
  profile: ModelProfile,
  status: CodexAuthStatus,
  capability: CapabilityDecision,
): string {
  const where = `${profile.provider}/${profile.model}`;
  const auth =
    status.state === 'signed-out'
      ? 'NOT SIGNED IN — no question can be answered until you sign in'
      : status.state === 'expired'
        ? 'SIGN-IN EXPIRED — sign in again'
        : status.state === 'refresh-due'
          ? 'signed in (token renews on the next request)'
          : 'signed in';
  const gate = capability.ok
    ? 'vision+tools ok'
    : `REFUSED BY THE CAPABILITY GATE — ${capability.refusal.reason}`;
  return `ChatGPT subscription (${where}, ${gate}) — ${auth}`;
}

/* -------------------------------------------------------------------------- *
 * The session decorator
 * -------------------------------------------------------------------------- */

/**
 * Wraps an `AgentSession` with Codex's auth lifecycle.
 *
 * Two jobs, and neither belongs in `PiAgentSession` (which is provider-neutral
 * and stays that way) nor in `main/agent-runtime.ts` (which PR-038 and PR-039
 * are editing at the same time):
 *
 *  1. **Pre-flight.** `submit()` re-reads the credential store and refuses
 *     before the run starts. That is *before* `run-started`, before the first
 *     provider request and before the model can call `observe_screen`, so a
 *     question asked with an expired sign-in captures nothing.
 *  2. **Translation.** Pi reports a failed token refresh as a `ModelsError`
 *     that `PiAgentSession` turns into
 *     `run-failed: provider-unavailable "OAuth refresh failed for
 *     openai-codex: …"`. Correct, and useless to a user. This rewrites such an
 *     event into `authentication-required` with the sentence that tells them to
 *     sign in again — which is what makes the `error` state's live text box
 *     (system-design §16) and the panel's sign-in control add up to a recovery
 *     rather than a dead end.
 *
 * Everything else is forwarded untouched, including the optional
 * `clearConversation` — present only when the inner session has it, so the
 * `?.` compatibility story PR-036 relies on is unchanged.
 */
export function createCodexAgentSession(
  inner: AgentSession,
  auth: Pick<CodexAuthController, 'ensureUsable' | 'classify'>,
  options: { readonly logger?: Logger } = {},
): AgentSession {
  const logger = options.logger ?? nullLogger;

  const translate = (event: AgentEvent): AgentEvent => {
    if (event.type !== 'run-failed') {
      return event;
    }
    const failure = auth.classify(event.error);
    if (failure === null) {
      return event;
    }
    const rewritten: SerializedPilotError = failure.error.toJSON();
    if (rewritten.code === event.error.code && rewritten.userMessage === event.error.userMessage) {
      return event;
    }
    logger.warn('a run failed on model authentication', {
      reason: failure.reason,
      signInFixesIt: failure.signInFixesIt,
    });
    return { ...event, error: rewritten };
  };

  const session: AgentSession = {
    get conversationId() {
      return inner.conversationId;
    },
    get profile(): ModelProfile {
      return inner.profile;
    },
    ...(inner.capabilities === undefined ? {} : { capabilities: inner.capabilities }),
    async submit(envelope: QuestionEnvelope, signal?: AbortSignal): Promise<AgentRunHandle> {
      await auth.ensureUsable(signal);
      return inner.submit(envelope, signal);
    },
    interrupt: (mode: InterruptMode, detail: string) => inner.interrupt(mode, detail),
    subscribe: (listener) => inner.subscribe((event) => listener(translate(event))),
    ...(inner.clearConversation === undefined
      ? {}
      : { clearConversation: () => inner.clearConversation?.() ?? Promise.resolve() }),
    dispose: () => inner.dispose(),
  };
  return session;
}
