import { Type, type Api, type Model, type Models, type Tool } from '@earendil-works/pi-ai';
import { PilotError, asModelProfileId, type ModelProfile } from '@pilot/shared';
import {
  describeCapabilities,
  verifyProfileAgainstModel,
  type CapabilityRefusal,
  type CapabilityReport,
} from './capability.js';
import { toModelProfile } from './model-profile.js';
import type { SecretScrubber } from './api-key-credentials.js';

/**
 * The capability probe, and the failure taxonomy that goes with it (PR-038).
 *
 * ## The ordering is the requirement
 *
 * > "Unsupported vision/tool combinations are blocked **before screen data is
 * > sent**." — `docs/implementation.md`, Phase 4 gate
 *
 * > "Exact models are selected by successful capability probes rather than
 * > hard-coded assumptions." — Phase 4 preamble
 *
 * Those two sentences pull in opposite directions, and the resolution is the
 * whole design of {@link probeApiKeyModel}: the probe is allowed to make a
 * provider request, but it must never make one that carries an image. So the
 * stages run in this order and stop at the first failure:
 *
 * | # | stage    | costs a request? | decided by |
 * | - | -------- | ---------------- | ---------- |
 * | 1 | `model`  | no  | is the model in the provider's catalogue at all |
 * | 2 | `vision` | no  | `Model.input.includes("image")` — Pi metadata |
 * | 3 | `auth`   | no  | `Models.checkAuth` — is a credential resolvable |
 * | 4 | `tools`  | **one, text-only** | did the model actually call the offered tool |
 *
 * Stage 2 is free and comes before stage 4 on purpose: a text-only model is
 * refused with **zero** provider requests, so a user who picks one has not even
 * proved to the vendor that they were trying. Stage 4 costs exactly one request
 * and that request carries a sentence and a tool definition — never a frame.
 * {@link CapabilityProbeOutcome.imageBlocksSent} is a literal `0` in the type
 * so a change that broke this would fail to compile before it failed a test.
 *
 * ## Why the tool stage is a request and not a lookup
 *
 * `docs/pi-notes.md` §6.3, restated in system-design §12 and in
 * `capability.ts`: **Pi's `Model` carries no tool metadata of any kind.** There
 * is nothing to look up. Every profile before this PR therefore carried
 * `toolSupport: 'assumed'` — a default nobody had checked. One text-only round
 * trip turns that into `'verified'`, which is the only honest way to get there
 * and the reason the Phase 4 preamble asks for a probe rather than a table.
 */

/** The tool the probe offers. Named so it is obvious in a provider's logs. */
export const CAPABILITY_PROBE_TOOL_NAME = 'pilot_capability_probe';

/**
 * The probe prompt.
 *
 * Contains no screen text, no conversation content and no user data — it is a
 * fixed sentence, so a provider-side log of it reveals nothing about the user.
 */
export const CAPABILITY_PROBE_PROMPT =
  'Pilot is checking whether this model can call tools. ' +
  `Call the ${CAPABILITY_PROBE_TOOL_NAME} tool once, with no arguments, and say nothing else.`;

export const capabilityProbeTool: Tool = {
  name: CAPABILITY_PROBE_TOOL_NAME,
  description:
    'Capability check only. Call this once with no arguments so Pilot can confirm this model can call tools.',
  parameters: Type.Object({}, { additionalProperties: false }),
};

/* -------------------------------------------------------------------------- *
 * Failure taxonomy
 * -------------------------------------------------------------------------- */

export type ApiKeyFailureKind =
  /** The provider rejected the credential: 401/403, invalid or revoked key. */
  | 'invalid-key'
  /** No credential could be resolved at all. */
  | 'not-configured'
  /** 429 or a quota refusal. The key is fine; the account is not. */
  | 'rate-limited'
  /** DNS, connection or TLS failure. Nothing says the key is wrong. */
  | 'unreachable'
  /** Anything else the provider said. */
  | 'unknown';

export interface ApiKeyFailure {
  readonly kind: ApiKeyFailureKind;
  /** Already scrubbed. Safe to log, safe to show in diagnostics. */
  readonly error: PilotError;
  /** True when re-entering a key, or simply retrying, could fix it. */
  readonly recoverable: boolean;
  /** What the user should do. Short, imperative, no jargon. */
  readonly remedy: string;
}

const INVALID_KEY_PATTERNS: readonly RegExp[] = [
  /\b401\b/,
  /\b403\b/,
  /unauthorized/i,
  /authentication[_ -]?error/i,
  /invalid[_ -]?api[_ -]?key/i,
  /invalid[_ -]?x?[_ -]?api[_ -]?key/i,
  /permission[_ -]?error/i,
  /incorrect api key/i,
  /api key.{0,24}(invalid|expired|revoked|not valid)/i,
];

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /rate[_ -]?limit/i,
  /insufficient[_ -]?quota/i,
  /quota exceeded/i,
  /overloaded/i,
];

const UNREACHABLE_PATTERNS: readonly RegExp[] = [
  /ENOTFOUND/,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /EAI_AGAIN/,
  /fetch failed/i,
  /socket hang up/i,
  /network (error|request failed)/i,
  /certificate/i,
];

const NOT_CONFIGURED_PATTERNS: readonly RegExp[] = [
  /provider is not configured/i,
  /no credential is configured/i,
  /no api key provided/i,
];

function matches(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** The raw text of whatever the provider handed back. Never returned to a caller unscrubbed. */
function rawTextOf(cause: unknown): string {
  if (typeof cause === 'string') {
    return cause;
  }
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  return String(cause);
}

export interface ClassifyApiKeyFailureOptions {
  readonly providerId: string;
  readonly modelId?: string;
  /**
   * Applied to every string that ends up in the returned error. A provider
   * that echoes the rejected key in its 401 body is the ordinary case, not the
   * exotic one — see `api-key-provider-fixture.ts`.
   */
  readonly scrubber?: SecretScrubber;
}

/**
 * Turns whatever a provider said into a typed, scrubbed Pilot failure.
 *
 * Ordering matters: "not configured" is checked before "invalid key" because
 * Pi's own `ModelsError("auth", "Provider is not configured: x")` would
 * otherwise be read as a rejection by the vendor, which would tell the user to
 * replace a key they never entered.
 */
export function classifyApiKeyFailure(
  cause: unknown,
  options: ClassifyApiKeyFailureOptions,
): ApiKeyFailure {
  const raw = rawTextOf(cause);
  const text = options.scrubber === undefined ? raw : options.scrubber.scrub(raw);
  const where =
    options.modelId === undefined ? options.providerId : `${options.providerId}/${options.modelId}`;

  const build = (
    kind: ApiKeyFailureKind,
    code: PilotError['code'],
    userMessage: string,
    remedy: string,
    recoverable: boolean,
  ): ApiKeyFailure => ({
    kind,
    recoverable,
    remedy,
    error: new PilotError(code, `${where}: ${text}`, {
      userMessage,
      retryable: kind === 'rate-limited' || kind === 'unreachable',
      details: { providerId: options.providerId, failure: kind, remedy },
      // Deliberately no `cause`: the original Error carries the unscrubbed
      // message and a `cause` chain is exactly what a crash reporter walks.
    }),
  });

  if (matches(text, NOT_CONFIGURED_PATTERNS)) {
    return build(
      'not-configured',
      'authentication-required',
      'Pilot has no API key for this model provider yet.',
      'Add an API key for this provider in settings.',
      true,
    );
  }
  if (matches(text, INVALID_KEY_PATTERNS)) {
    return build(
      'invalid-key',
      'authentication-required',
      'This model provider rejected your API key. Enter a new key to continue.',
      'Enter a new API key. The old one has been kept until you replace it, in case the provider was wrong.',
      true,
    );
  }
  if (matches(text, RATE_LIMIT_PATTERNS)) {
    return build(
      'rate-limited',
      'rate-limited',
      'Your model provider is rate-limiting Pilot. Wait a moment and ask again.',
      'Wait and retry; your key is fine.',
      true,
    );
  }
  if (matches(text, UNREACHABLE_PATTERNS)) {
    return build(
      'unreachable',
      'provider-unavailable',
      'Pilot could not reach your model provider. Check your network and try again.',
      'Check the network, then try again; nothing is wrong with your key.',
      true,
    );
  }
  return build(
    'unknown',
    'provider-unavailable',
    'Your model provider could not answer. Try again in a moment.',
    'Try again; if it keeps happening, check the provider’s status page.',
    true,
  );
}

/* -------------------------------------------------------------------------- *
 * The probe
 * -------------------------------------------------------------------------- */

export type CapabilityProbeStage = 'model' | 'vision' | 'auth' | 'tools' | 'gate';

export interface CapabilityProbeOutcome {
  readonly ok: boolean;
  readonly providerId: string;
  readonly modelId: string;
  /** The stage the probe reached. On failure, the stage that refused. */
  readonly stage: CapabilityProbeStage;
  /** Probed from `Model.input`. */
  readonly vision: boolean;
  /** Measured, not assumed: did the model actually call the offered tool. */
  readonly tools: boolean;
  /** Provider requests this probe made. At most one. */
  readonly providerRequests: number;
  /**
   * Image blocks this probe sent. Literally `0`, in the type, forever.
   * The Phase 4 gate is "blocked *before* screen data is sent"; this is the
   * number that says so.
   */
  readonly imageBlocksSent: 0;
  /** Present when a capability was missing. */
  readonly refusal: CapabilityRefusal | null;
  /** Present when the provider itself failed. Already scrubbed. */
  readonly failure: ApiKeyFailure | null;
  /** The profile the probe verified, when it succeeded. */
  readonly profile: ModelProfile | null;
  /** Full provenance, for diagnostics. Never contains screen text. */
  readonly report: CapabilityReport | null;
  /** One line per stage, in order. Safe to print. */
  readonly evidence: readonly string[];
}

export interface ProbeApiKeyModelOptions {
  readonly models: Models;
  readonly providerId: string;
  readonly modelId: string;
  /** Stable Pilot-side id for the profile the probe builds. */
  readonly profileId: string;
  readonly scrubber?: SecretScrubber;
  readonly signal?: AbortSignal;
}

function unknownModelRefusal(providerId: string, modelId: string): CapabilityRefusal {
  return {
    reason: 'profile-model-mismatch',
    missing: [],
    userMessage: 'That model is not offered by this provider any more. Pick a different one.',
    remedy: 'Choose a model from the provider’s current list.',
    message: `Provider ${providerId} does not list a model ${modelId}`,
  };
}

function noVisionRefusal(model: Model<Api>): CapabilityRefusal {
  return {
    reason: 'no-vision',
    missing: ['vision'],
    userMessage:
      'This model cannot see images, so it cannot answer questions about your screen. Pick a different model to continue.',
    remedy: 'Choose a model whose provider lists image input.',
    message:
      `Probe stage "vision": ${model.provider}/${model.id} declares input [${model.input.join(', ')}]. ` +
      'A non-vision model silently ignores images, so the model is refused before any request is made.',
  };
}

function noToolsRefusal(model: Model<Api>, saw: string): CapabilityRefusal {
  return {
    reason: 'no-tools',
    missing: ['tools'],
    userMessage:
      'This model cannot use Pilot’s screen tool, so it cannot look at your screen. Pick a different model to continue.',
    remedy: 'Choose a model that supports tool calling.',
    message:
      `Probe stage "tools": ${model.provider}/${model.id} was offered ${CAPABILITY_PROBE_TOOL_NAME} ` +
      `and answered with ${saw} instead of a tool call. No image was sent.`,
  };
}

/**
 * Runs the probe. Never sends an image; see the table at the top of this file.
 *
 * Returns rather than throws, for the same reason `checkVisualConversation`
 * does: the caller has a UI to update and a choice to offer, and an exception
 * would flatten five distinguishable outcomes into one.
 */
export async function probeApiKeyModel(
  options: ProbeApiKeyModelOptions,
): Promise<CapabilityProbeOutcome> {
  const { models, providerId, modelId, scrubber } = options;
  const evidence: string[] = [];
  const base = {
    providerId,
    modelId,
    providerRequests: 0,
    imageBlocksSent: 0,
    profile: null,
    report: null,
  } as const;

  // ---- stage 1: is this model in the catalogue at all? (no request) --------
  const model = models.getModel(providerId, modelId);
  if (model === undefined) {
    evidence.push(`model: ${providerId}/${modelId} is not in the provider catalogue`);
    return {
      ...base,
      ok: false,
      stage: 'model',
      vision: false,
      tools: false,
      refusal: unknownModelRefusal(providerId, modelId),
      failure: null,
      evidence,
    };
  }
  evidence.push(
    `model: ${providerId}/${modelId} found; input [${model.input.join(', ')}], ` +
      `context window ${String(model.contextWindow)}`,
  );

  // ---- stage 2: vision, from Pi metadata (no request) ---------------------
  const vision = model.input.includes('image');
  evidence.push(
    `vision: ${vision ? 'yes' : 'NO'} — Pi Model.input ${vision ? 'includes' : 'does not include'} "image"`,
  );
  if (!vision) {
    evidence.push('refused before any provider request; 0 requests, 0 image blocks');
    return {
      ...base,
      ok: false,
      stage: 'vision',
      vision,
      tools: false,
      refusal: noVisionRefusal(model),
      failure: null,
      evidence,
    };
  }

  // ---- stage 3: is a credential resolvable at all? (no request) -----------
  let check: Awaited<ReturnType<Models['checkAuth']>>;
  try {
    check = await models.checkAuth(
      providerId,
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  } catch (cause) {
    const failure = classifyApiKeyFailure(cause, {
      providerId,
      modelId,
      ...(scrubber && { scrubber }),
    });
    evidence.push(`auth: check failed — ${failure.kind}`);
    return {
      ...base,
      ok: false,
      stage: 'auth',
      vision,
      tools: false,
      refusal: null,
      failure,
      evidence,
    };
  }
  if (check === undefined) {
    const failure = classifyApiKeyFailure('Provider is not configured', {
      providerId,
      modelId,
      ...(scrubber && { scrubber }),
    });
    evidence.push('auth: no credential is configured for this provider');
    return {
      ...base,
      ok: false,
      stage: 'auth',
      vision,
      tools: false,
      refusal: null,
      failure,
      evidence,
    };
  }
  evidence.push(`auth: configured — ${check.type} from ${check.source ?? 'an unnamed source'}`);

  // ---- stage 4: tools. ONE request. Text and a tool definition, no image. --
  let answer;
  try {
    answer = await models.completeSimple(
      model,
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: CAPABILITY_PROBE_PROMPT }],
            timestamp: Date.now(),
          },
        ],
        tools: [capabilityProbeTool],
      },
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  } catch (cause) {
    const failure = classifyApiKeyFailure(cause, {
      providerId,
      modelId,
      ...(scrubber && { scrubber }),
    });
    evidence.push(`tools: the request failed — ${failure.kind}`);
    return {
      ...base,
      ok: false,
      stage: 'tools',
      vision,
      tools: false,
      providerRequests: 1,
      refusal: null,
      failure,
      evidence,
    };
  }

  // Pi turns a provider/auth failure into a terminal assistant message rather
  // than a rejection (`api/lazy.ts` `createSetupErrorMessage`), so the error
  // path is here as well as in the catch above. Missing this is how a rejected
  // key would look like a model that simply declined to call the tool.
  if (answer.stopReason === 'error') {
    const failure = classifyApiKeyFailure(answer.errorMessage ?? 'Provider request failed', {
      providerId,
      modelId,
      ...(scrubber && { scrubber }),
    });
    evidence.push(`tools: the provider returned an error — ${failure.kind}`);
    return {
      ...base,
      ok: false,
      stage: 'tools',
      vision,
      tools: false,
      providerRequests: 1,
      refusal: null,
      failure,
      evidence,
    };
  }

  const calledProbeTool = answer.content.some(
    (block) => block.type === 'toolCall' && block.name === CAPABILITY_PROBE_TOOL_NAME,
  );
  evidence.push(
    `tools: ${calledProbeTool ? 'yes' : 'NO'} — one text-only request; the model answered ` +
      `stopReason="${answer.stopReason}"${calledProbeTool ? ` with a ${CAPABILITY_PROBE_TOOL_NAME} call` : ''}`,
  );
  if (!calledProbeTool) {
    return {
      ...base,
      ok: false,
      stage: 'tools',
      vision,
      tools: false,
      providerRequests: 1,
      refusal: noToolsRefusal(model, `stopReason="${answer.stopReason}"`),
      failure: null,
      evidence,
    };
  }

  // ---- stage 5: the gate, over the profile the probe just established -----
  const profile = toModelProfile(model, {
    id: options.profileId,
    authMode: 'api-key',
    // VERIFIED, not assumed: stage 4 watched it happen.
    supportsTools: true,
  });
  const decision = verifyProfileAgainstModel(profile, model, { toolSupport: 'verified' });
  evidence.push(
    `gate: ${decision.ok ? 'passed' : 'REFUSED'} — vision ${String(decision.report.vision)} ` +
      `(${decision.report.facts.vision.confidence}), tools ${String(decision.report.tools)} ` +
      `(${decision.report.facts.tools.confidence}), endpoint ` +
      `${decision.report.endpoint.isRemote ? 'remote' : 'local'}`,
  );

  return {
    providerId,
    modelId,
    ok: decision.ok,
    stage: 'gate',
    vision,
    tools: true,
    providerRequests: 1,
    imageBlocksSent: 0,
    refusal: decision.ok ? null : decision.refusal,
    failure: null,
    profile,
    report: decision.report,
    evidence,
  };
}

/** The report a refused probe still has to show in diagnostics. */
export function probeReportFor(outcome: CapabilityProbeOutcome): CapabilityReport | null {
  if (outcome.report !== null) {
    return outcome.report;
  }
  if (outcome.profile === null) {
    return null;
  }
  return describeCapabilities(outcome.profile, { toolSupport: 'verified' });
}

/** Convenience for the shipping path: the id a probed profile is stored under. */
export function apiKeyProfileId(providerId: string, modelId: string): ModelProfile['id'] {
  return asModelProfileId(`api-key:${providerId}:${modelId}`);
}
