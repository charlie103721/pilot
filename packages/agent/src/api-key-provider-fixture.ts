import {
  envApiKeyAuth,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Provider,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { secretsMatch } from './api-key-credentials.js';

/**
 * A **recorded** API-key provider surface (PR-038).
 *
 * ## Why this exists rather than a real provider
 *
 * There is no API key in this environment and none may be obtained
 * (`docs/handoff.md` §2). Everything PR-038 builds therefore has to be verified
 * against a provider that behaves the way a hosted, key-authenticated one does
 * — including the two behaviours the shipping code is *only* interesting
 * because of:
 *
 *  1. it **rejects a wrong key**, with a 401 whose body echoes the key back, the
 *     way real vendors do; and
 *  2. it **answers differently per model** — one that calls tools, one that will
 *     not, and one that does not accept images at all — so a capability probe
 *     has something to discover rather than something to assume.
 *
 * Pi's own `fauxProvider` supplies the stream machinery (`docs/pi-notes.md`
 * §2.8: scripted responses, `state.callCount`, `tokensPerSecond` throttling), so
 * everything above the wire is Pi's real `Models` path: auth is resolved from
 * the credential store, `Models.applyAuth` puts the resolved key in
 * `options.apiKey`, and this provider is handed it exactly as `anthropic` would
 * be. What is faked is the vendor, not the plumbing.
 *
 * `baseUrl` is a **public HTTPS host on purpose**. It makes `isRemote` true,
 * which is what `describeEndpoint` labels and what
 * `apps/desktop/src/main/context-window.ts` keys on — an API-key profile takes
 * the *hosted* branch and keeps the advertised context window, and this fixture
 * is how that is asserted without a network.
 *
 * ## The echoed key is deliberate
 *
 * `INVALID_KEY_MESSAGE` interpolates the rejected key. That is not sloppiness:
 * it is the single most common way a credential escapes into a log, because the
 * provider's error body becomes `AssistantMessage.errorMessage`, then
 * `PilotError.message`, then a log line and a panel string. The fixture
 * reproduces it so `createSecretScrubber` is tested against the real shape of
 * the leak rather than against a hypothetical one.
 */

export const RECORDED_PROVIDER_ID = 'recorded-vendor';
export const RECORDED_BASE_URL = 'https://api.recorded-vendor.example/v1';
export const RECORDED_ENV_VAR = 'PILOT_RECORDED_VENDOR_API_KEY';

/** The model that passes every check: images in, tool calls out. */
export const RECORDED_VISION_TOOL_MODEL = 'recorded-vision-pro';
/** Accepts images, but never calls a tool. Fails the probe at the tool stage. */
export const RECORDED_VISION_ONLY_MODEL = 'recorded-vision-lite';
/** Text only. Fails the probe at the vision stage — before any request. */
export const RECORDED_TEXT_MODEL = 'recorded-text-mini';

/** What a real vendor's 401 body looks like, key and all. */
export function invalidKeyMessage(key: string): string {
  return (
    `401 Unauthorized: {"error":{"type":"authentication_error",` +
    `"message":"Invalid API key provided: ${key}. ` +
    `Check your key at https://recorded-vendor.example/keys"}}`
  );
}

export const MISSING_KEY_MESSAGE =
  '401 Unauthorized: {"error":{"type":"authentication_error",' +
  '"message":"No API key provided. Set an Authorization header."}}';

export const RATE_LIMIT_MESSAGE =
  '429 Too Many Requests: {"error":{"type":"rate_limit_error","message":"Rate limit reached"}}';

/** Counts a test or a demo can assert on. Contains no key and no screen data. */
export interface RecordedProviderState {
  /** Requests that reached the "vendor", authenticated or not. */
  requests: number;
  /** Requests rejected for a bad or missing key. */
  rejections: number;
  /** Image blocks the "vendor" ever received. The number that must stay 0. */
  imageBlocks: number;
  /** Model ids the "vendor" was asked for, in order. */
  models: string[];
  /** Whether the newest request offered any tool definitions. */
  lastToolNames: string[];
}

export interface RecordedApiKeyProviderOptions {
  /** The key the "vendor" accepts. Anything else is a 401. */
  readonly acceptedKey: string;
  readonly providerId?: string;
  readonly baseUrl?: string;
  readonly envVar?: string;
  readonly tokensPerSecond?: number;
  /** Makes every authenticated request fail with a 429 instead. */
  readonly rateLimited?: boolean;
  /** Makes every request fail as if the host could not be reached. */
  readonly unreachable?: boolean;
}

export interface RecordedApiKeyProvider {
  readonly provider: Provider;
  readonly providerId: string;
  readonly models: readonly Model<Api>[];
  readonly state: RecordedProviderState;
  /** The key the vendor currently accepts. Rotating it models a revoked key. */
  rotateKey(next: string): void;
  model(id: string): Model<Api>;
}

function countImageBlocks(messages: readonly Message[]): number {
  let count = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'image'
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * The answer the vendor gives when a tool was offered and the model calls it.
 *
 * The probe asks for a single call to a named tool with no arguments; a model
 * that can call tools produces `stopReason: "toolUse"`. Nothing about this
 * requires an image, which is the whole point — the tool half of the capability
 * gate is settled before the vision half is ever exercised with real bytes.
 */
function toolCallAnswer(toolName: string, args: Record<string, unknown> = {}): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(toolName, args)], { stopReason: 'toolUse' });
}

/** True when the newest message is a tool result, i.e. the model has just looked. */
function lastMessageIsToolResult(messages: readonly Message[]): boolean {
  return messages.at(-1)?.role === 'toolResult';
}

/**
 * The vendor's prose.
 *
 * Several sentences, for the reason `@pilot/agent`'s `answerFor` gives: the
 * response buffer releases one completed sentence at a time, so a one-line
 * answer would never show the panel filling in. It says what it is, so nobody
 * can mistake a rehearsal transcript for a model's.
 */
export function recordedAnswer(modelId: string, looked: boolean): string {
  return (
    `Recorded vendor reply from ${modelId}. ` +
    `${looked ? 'It called observe_screen first and answered from the tool result. ' : ''}` +
    'This text was written by `createRecordedApiKeyProvider` in @pilot/agent, not by a ' +
    'language model, and no request left this machine. What is real is everything above ' +
    'the wire: the encrypted credential store, Pi’s auth resolution, the capability probe, ' +
    'and the capability gate.'
  );
}

export function createRecordedApiKeyProvider(
  options: RecordedApiKeyProviderOptions,
): RecordedApiKeyProvider {
  const providerId = options.providerId ?? RECORDED_PROVIDER_ID;
  const baseUrl = options.baseUrl ?? RECORDED_BASE_URL;
  let acceptedKey = options.acceptedKey;

  const state: RecordedProviderState = {
    requests: 0,
    rejections: 0,
    imageBlocks: 0,
    models: [],
    lastToolNames: [],
  };

  const faux = fauxProvider({
    provider: providerId,
    models: [
      { id: RECORDED_VISION_TOOL_MODEL, input: ['text', 'image'], contextWindow: 200_000 },
      { id: RECORDED_VISION_ONLY_MODEL, input: ['text', 'image'], contextWindow: 128_000 },
      { id: RECORDED_TEXT_MODEL, input: ['text'], contextWindow: 64_000 },
    ],
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
  });

  // The faux core answers from a queue. This one re-arms itself and decides its
  // answer from the model, the offered tools and what it has already been told,
  // so one provider serves the probe, a refused model and a real conversation:
  //
  //   probe             → offered `pilot_capability_probe` → calls it
  //   first turn        → offered `observe_screen`         → calls it
  //   after a result    → text
  //   vision-only model → text, always: it does not call tools
  const step = (
    context: Context,
    _options: unknown,
    _state: unknown,
    model: Model<string>,
  ): AssistantMessage => {
    faux.appendResponses([step]);
    const toolNames = (context.tools ?? []).map((tool) => tool.name);
    state.lastToolNames = toolNames;
    const looked = lastMessageIsToolResult(context.messages);
    if (model.id === RECORDED_VISION_ONLY_MODEL || toolNames.length === 0 || looked) {
      return fauxAssistantMessage(recordedAnswer(model.id, looked), { stopReason: 'stop' });
    }
    const first = toolNames[0];
    if (first === undefined) {
      return fauxAssistantMessage(recordedAnswer(model.id, false), { stopReason: 'stop' });
    }
    // `observe_screen` has required arguments; a call with none would be
    // refused by the tool's own schema, which is a defect in this fixture
    // rather than a finding about Pilot. `window`/`current` is the combination
    // PR-030's walkthrough uses, and the one that needs nothing of the caller
    // beyond a selected window and a frame in the ring.
    return first === 'observe_screen'
      ? toolCallAnswer(first, { view: 'window', moment: 'current' })
      : toolCallAnswer(first);
  };
  faux.setResponses([step]);

  const guard = (
    model: Model<Api>,
    context: Context,
    streamOptions?: SimpleStreamOptions,
  ): void => {
    state.requests += 1;
    state.models.push(model.id);
    state.imageBlocks += countImageBlocks(context.messages);
    if (options.unreachable === true) {
      throw new Error(
        `fetch failed: getaddrinfo ENOTFOUND api.recorded-vendor.example (${model.provider})`,
      );
    }
    const key = streamOptions?.apiKey;
    if (key === undefined || key === '') {
      state.rejections += 1;
      throw new Error(MISSING_KEY_MESSAGE);
    }
    if (!secretsMatch(key, acceptedKey)) {
      state.rejections += 1;
      throw new Error(invalidKeyMessage(key));
    }
    if (options.rateLimited === true) {
      throw new Error(RATE_LIMIT_MESSAGE);
    }
  };

  const provider: Provider = {
    ...faux.provider,
    id: providerId,
    name: 'Recorded Vendor',
    baseUrl,
    // A real hosted provider's api-key auth, verbatim from Pi's own helper:
    // a stored credential wins, otherwise the named environment variable.
    auth: {
      apiKey: envApiKeyAuth('Recorded Vendor API key', [options.envVar ?? RECORDED_ENV_VAR]),
    },
    stream: (model, context, streamOptions) => {
      guard(model, context, streamOptions as SimpleStreamOptions | undefined);
      return faux.provider.stream(model, context, streamOptions);
    },
    streamSimple: (model, context, streamOptions) => {
      guard(model, context, streamOptions);
      return faux.provider.streamSimple(model, context, streamOptions);
    },
  };

  // `Model.baseUrl` is what `toModelProfile` reads for locality, and the faux
  // core does not know about ours.
  const models: Model<Api>[] = faux.models.map((model) => ({ ...model, baseUrl }) as Model<Api>);

  return {
    provider: {
      ...provider,
      getModels: () => models,
    },
    providerId,
    models,
    state,
    rotateKey(next: string): void {
      acceptedKey = next;
    },
    model(id: string): Model<Api> {
      const found = models.find((candidate) => candidate.id === id);
      if (found === undefined) {
        throw new Error(`recorded provider has no model ${id}`);
      }
      return found;
    },
  };
}
