import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type ProviderStreams,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { describeEndpoint, type EndpointDescription, type ModelProfile } from '@pilot/shared';
import type { CapabilityConfidence } from './capability.js';
import type { ModelSource } from './development-model.js';
import { toModelProfileWithProvenance } from './model-profile.js';
import type { LocalEndpointReport, LocalEndpointSettings } from './local-endpoint.js';
import type { ModelProfileRecordInput } from './profile-store.js';

/**
 * A {@link ModelSource} over the user's own OpenAI-compatible endpoint
 * (PR-039).
 *
 * `docs/runbook.md` follow-up 22: `apps/desktop/src/main/index.ts` consumes a
 * `ModelSource` — profile, `Models`, `Model`, `toolSupport`, a request counter
 * and one line of description — "and nothing else, so a real provider is one
 * call site". This is that call site for the local profile. Nothing downstream
 * of `createAgentRuntime` knows the difference between this and the faux
 * development source, which is the Phase 4 gate's "one provider-neutral session
 * interface" stated as code rather than as an aspiration.
 *
 * THREE THINGS ARE DECIDED HERE AND THEY ARE ALL ABOUT HONESTY
 * -----------------------------------------------------------
 *  1. **`input` is what the probe found, not what the user hoped.** A local
 *     `GET /models` reports no capabilities at all, so `Model.input` — the one
 *     field `toModelProfile` derives `supportsVision` from — has to be filled
 *     in by *someone*. It is filled in from
 *     {@link LocalEndpointReport.vision}, which is an answer the endpoint gave.
 *     A blind model therefore reaches the capability gate as `input: ['text']`
 *     and is refused there, before `observe_screen` is ever registered.
 *  2. **`toolSupport` is `'verified'` here.** `docs/pi-notes.md` §6.3 says tool
 *     support "cannot be derived" from Pi metadata, and that is still true —
 *     but a local endpoint can be *asked*, and PR-039 asks it. This is the
 *     first profile in the project whose `supportsTools` is a measurement.
 *  3. **`contextWindow` is 0 when the endpoint reported nothing.** That is not
 *     a bug and it is not a magic number: `resolveContextWindow`
 *     (`apps/desktop/src/main/context-window.ts`) treats a non-positive
 *     advertised window as `'unknown'` and answers with its conservative
 *     ceiling, which is precisely the truth — the endpoint advertised nothing.
 *     When the server *does* report what it loaded, that number is passed
 *     through and PR-036's rule applies to it unchanged: below the ceiling it
 *     is believed, above it it is capped. See the note on
 *     {@link LocalModelSource.measuredContextWindow}.
 */

/** Pi provider id for the user's own endpoint. One provider, many models. */
export const LOCAL_PROVIDER_ID = 'local';

/**
 * The string sent as `Authorization: Bearer` when the user configured no key.
 *
 * **It is not a credential and it is not a secret.** It exists because
 * `docs/pi-notes.md` §9.3's recorded snippet — `resolve: async () => ({ auth:
 * {} })`, taken from pi-ai's own README — does not actually work: the
 * `openai-completions` implementation calls `getClientApiKey`, which throws
 * `No API key for provider: local` unless it has a non-empty key *or* an
 * `authorization` header (`pi-ai/dist/api/openai-completions.js`). Resolving to
 * an empty `ModelAuth` therefore fails at the first stream with an error that
 * reads like a Pilot bug. Found by running it; recorded in `docs/runbook.md`.
 *
 * Keyless local servers ignore the header. A user who *does* have a key sets
 * `PILOT_LOCAL_API_KEY`, and that value replaces this one.
 */
export const LOCAL_PLACEHOLDER_KEY = 'no-key-required';

export interface LocalModelSource extends ModelSource {
  /** The probe this source was built from. */
  readonly report: LocalEndpointReport;
  /** Locality, for the label §14 requires before observation begins. */
  readonly endpoint: EndpointDescription;
  /**
   * The context the *server process* said it had loaded, or `null`.
   *
   * Deliberately reported separately from `Model.contextWindow`: this is the
   * only number in the local profile that is a measurement rather than a claim,
   * and PR-036's ceiling rule is about claims. It is **not** used to raise the
   * ceiling — a server that allocated a 128k KV cache has not made a 7B model
   * good at 128k — but it is used to *lower* the budget, which llama.cpp's
   * 4096-token default makes the common case.
   */
  readonly measuredContextWindow: number | null;
}

export interface CreateLocalModelSourceOptions {
  /** Overrides the generated profile id. Defaults to `local-<model id>`. */
  readonly profileId?: string;
  /** Sent as `Authorization: Bearer`. Never persisted. */
  readonly apiKey?: string;
}

/**
 * Builds the Pi provider, model and profile from a completed probe.
 *
 * Total by construction: it is called for an unreachable endpoint too, so the
 * app can show *which* local model is misconfigured rather than falling back to
 * something that works and saying nothing. `LocalEndpointReport.blocking` is
 * what stops such a source being used; see `main/local-model.ts`.
 */
export function createLocalModelSource(
  report: LocalEndpointReport,
  options: CreateLocalModelSourceOptions = {},
): LocalModelSource {
  const settings = report.settings;
  const baseUrl = report.health.baseUrl;
  const modelId = report.health.selectedModel ?? settings.model;
  const measured = report.health.contextWindow.measured ? report.health.contextWindow.tokens : null;
  const advertised = report.health.contextWindow.tokens;

  const model: Model<'openai-completions'> = {
    id: modelId,
    name: `${modelId} (local)`,
    api: 'openai-completions',
    provider: LOCAL_PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: report.vision.supported ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // See the header note (3). 0 means "the endpoint advertised nothing".
    contextWindow: advertised ?? 0,
    maxTokens: 4096,
    // `docs/pi-notes.md` §9.3: Ollama, vLLM and SGLang understand neither the
    // `developer` role nor `reasoning_effort`. Sending them turns a working
    // endpoint into a 400 that looks like a Pilot bug.
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  };

  const api = openAICompletionsApi();
  let requests = 0;
  const counted: ProviderStreams = {
    stream: (target, context, streamOptions) => {
      requests += 1;
      return api.stream(target, context, streamOptions);
    },
    streamSimple: (target, context, streamOptions) => {
      requests += 1;
      return api.streamSimple(target, context, streamOptions);
    },
    ...(api.fetchDeferred === undefined ? {} : { fetchDeferred: api.fetchDeferred.bind(api) }),
    ...(api.cancelDeferred === undefined ? {} : { cancelDeferred: api.cancelDeferred.bind(api) }),
  };

  const apiKey = options.apiKey ?? settings.apiKey;
  const provider = createProvider<'openai-completions'>({
    id: LOCAL_PROVIDER_ID,
    name: 'Local model',
    baseUrl,
    // `docs/pi-notes.md` §9.3: "Keyless local servers still declare auth."
    // See {@link LOCAL_PLACEHOLDER_KEY} for why the keyless branch cannot
    // resolve to an empty `ModelAuth`, contrary to what §9.3 recorded.
    auth: {
      apiKey: {
        name: 'Local endpoint',
        resolve: async () => ({
          auth: { apiKey: apiKey ?? LOCAL_PLACEHOLDER_KEY },
          source: apiKey === undefined ? 'no credential (local endpoint)' : 'PILOT_LOCAL_API_KEY',
        }),
      },
    },
    models: [model],
    api: counted,
  });

  const models = createModels();
  models.setProvider(provider);

  const { profile } = toModelProfileWithProvenance(model, {
    id: options.profileId ?? `local-${modelId}`,
    authMode: 'local',
    // See the header note (2). `false` is also the right value when the probe
    // never ran — an endpoint that did not answer has not shown Pilot a tool
    // call — but the *confidence* is different, and saying `verified` for a
    // capability nobody checked would be exactly the lie this module exists to
    // avoid. `toModelProfileWithProvenance` infers confidence from whether the
    // flag was supplied, which cannot express "supplied, but unprobed", so the
    // confidence is stated here instead.
    supportsTools: report.tools.supported,
  });
  const toolSupport: CapabilityConfidence = report.tools.probed ? 'verified' : 'assumed';

  return {
    profile,
    models,
    model,
    toolSupport,
    report,
    endpoint: describeEndpoint(profile),
    measuredContextWindow: measured,
    requestCount: () => requests,
    description: describeLocalModelSource(profile, report),
  };
}

/**
 * One line for a log or a demo header. Never contains a credential.
 *
 * It always names the endpoint, because "which machine is this answer coming
 * from" is the question the whole profile exists to let a user answer.
 */
export function describeLocalModelSource(
  profile: ModelProfile,
  report: LocalEndpointReport,
): string {
  const where = report.health.host ?? report.health.baseUrl;
  const locality = profile.isRemote
    ? `${where} — NOT this Mac, screen images leave the machine`
    : `${where} — this Mac, screen images stay here`;
  const capabilities = `vision ${report.vision.supported ? 'probed ok' : 'unavailable'}, tools ${
    report.tools.supported ? 'probed ok' : 'unavailable'
  }`;
  const state = report.blocking === null ? 'reachable' : `UNUSABLE (${report.blocking.code})`;
  return `Local OpenAI-compatible endpoint ${profile.model} at ${locality}; ${state}; ${capabilities}`;
}

/**
 * The label §14 asks the UI to show before observation begins.
 *
 * Two sentences, no jargon, and it distinguishes the case this PR is *for*
 * (loopback: nothing leaves the Mac) from the case that looks like it
 * (a model on the LAN, which is somebody else's computer).
 */
export function localityStatement(source: LocalModelSource): string {
  const { endpoint } = source;
  return endpoint.isRemote
    ? `${endpoint.label} This is a network address, not this Mac — a local profile does not make it private.`
    : `${endpoint.label} Nothing about your screen is sent to a company, a service or the internet.`;
}

/**
 * Turns settings plus a probe into a record the existing profile store accepts.
 *
 * Note what is *not* here: `apiKey`. `ModelProfile` has no field for it, the
 * store's `assertNoPlaintextSecrets` would reject one smuggled into the base
 * URL, and system-design §13 permits only credential *references* on disk. The
 * reference is the provider id, which is what `credentialRef` defaults to.
 */
export function toLocalProfileRecordInput(source: LocalModelSource): ModelProfileRecordInput {
  return {
    profile: source.profile,
    displayName: `${source.profile.model} (local)`,
    toolSupport: source.toolSupport satisfies CapabilityConfidence,
    credentialRef: LOCAL_PROVIDER_ID,
  };
}

/** Rebuilds settings from a stored profile, for a relaunch that skips the UI. */
export function settingsFromProfile(
  profile: ModelProfile,
  extra: { readonly apiKey?: string } = {},
): LocalEndpointSettings | null {
  if (profile.authMode !== 'local' || profile.baseUrl === undefined) {
    return null;
  }
  return {
    baseUrl: profile.baseUrl,
    model: profile.model,
    ...(extra.apiKey === undefined ? {} : { apiKey: extra.apiKey }),
  };
}

/** Narrowing helper: `unknown` → `LocalModelSource` for a `ModelSource` union. */
export function isLocalModelSource(source: ModelSource): source is LocalModelSource {
  return (
    'report' in source &&
    (source as { report?: unknown }).report !== null &&
    typeof (source as { report?: unknown }).report === 'object'
  );
}

/** Convenience for callers that only have a Pi `Model`. */
export function isLocalModel(model: Model<Api>): boolean {
  return model.provider === LOCAL_PROVIDER_ID;
}
