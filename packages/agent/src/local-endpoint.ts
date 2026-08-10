import { deflateSync } from 'node:zlib';
import { PilotError, isLoopbackUrl } from '@pilot/shared';
import { z } from 'zod';

/**
 * The local OpenAI-compatible endpoint: settings, health, and the capability
 * probe (PR-039).
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * A hosted provider's catalogue is curated: when `pi-ai` says
 * `gpt-5.4` accepts images, it does. A local endpoint's catalogue is whatever
 * the person running llama.cpp typed. `GET /v1/models` on a local server
 * reports *ids and nothing else* — no `input`, no context window, no tool
 * support — so `toModelProfile`'s one verified derivation
 * (`Model.input.includes("image")`) has no input to derive from. Everything on
 * a local profile would be Pilot configuration, i.e. a guess.
 *
 * `docs/pi-notes.md` §2.3 is why a guess is not survivable here: "If you pass
 * images to a non-vision model, they are **silently ignored**." A local model
 * that claims vision and cannot do it produces a confident answer about a
 * screen it never saw, with no error anywhere.
 *
 * So this module *asks the endpoint*, with real requests, before Pilot builds
 * a session. Every probe request carries synthetic content generated in this
 * file — an 8×8 solid-colour swatch and one sentence. **No screen data is ever
 * part of a probe**, and no screen data can be sent at all until the capability
 * gate in `capability.ts` has seen the answers.
 *
 * WHAT IS PROBED AND WHAT IS INFERRED
 * -----------------------------------
 *  - reachability, OpenAI-compatibility, model presence — PROBED (`GET /models`)
 *  - loaded context window — READ BACK when the server reports it, otherwise
 *    unknown. See {@link LocalContextWindowFinding}: this is the one number a
 *    local endpoint can state as a fact rather than as an advertisement.
 *  - vision — PROBED twice: does the endpoint *accept* an image content block,
 *    and can the model *read* one. The second question is the one that matters
 *    and the one a catalogue cannot answer.
 *  - tools — PROBED. This is the interesting one: `docs/pi-notes.md` §6.3 says
 *    `supportsTools` "cannot be derived" because Pi's `Model` carries no tool
 *    metadata. That is true of *metadata*. A local endpoint can simply be
 *    asked, and the answer is `'verified'` rather than `'assumed'`.
 *
 * NOTHING HERE HAS EVER RUN AGAINST A REAL INFERENCE SERVER. There is none on
 * this machine. The probe is exercised against `stub-openai-endpoint.ts`, a
 * fixture written for this PR, and `docs/handoff.md` §1 step 17 asks the user
 * to run it against llama.cpp / Ollama / LM Studio.
 */

/* -------------------------------------------------------------------------- *
 * Settings
 * -------------------------------------------------------------------------- */

/**
 * What a user configures for a local endpoint.
 *
 * `apiKey` is deliberately *not* part of `ModelProfile` and is never persisted
 * by {@link toLocalProfileRecordInput}: many local servers accept any string,
 * some are configured with a real one, and system-design §13 permits only
 * credential *references* on disk.
 */
export const localEndpointSettingsSchema = z.strictObject({
  /** Base URL including the OpenAI path prefix, e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl: z.string().min(1).max(2048),
  /** Model id exactly as the endpoint reports it in `GET /models`. */
  model: z.string().min(1).max(200),
  /** Sent as `Authorization: Bearer`. Runtime only; never persisted. */
  apiKey: z.string().min(1).max(4096).optional(),
  /** Per-request budget for probe calls. Defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}. */
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  /**
   * Whether the vision probe must show the model *reading* the image, rather
   * than merely accepting it. Defaults to `true`, which is the point of the
   * probe; set it to `false` if your model is vision-capable but bad at naming
   * colours, and accept that Pilot is then trusting a claim again.
   */
  requireVisionComprehension: z.boolean().optional(),
});

export type LocalEndpointSettings = z.infer<typeof localEndpointSettingsSchema>;

/** Long enough for a cold model load on a laptop, short enough to fail visibly. */
export const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

/**
 * Reads local-endpoint settings from the environment.
 *
 * Returns `null` when `PILOT_LOCAL_BASE_URL` is absent, which is how the app
 * decides between this profile and the development source — an unset variable
 * means "not configured", never "configured and broken".
 */
export function readLocalEndpointSettings(
  env: Readonly<Record<string, string | undefined>>,
): LocalEndpointSettings | null {
  const baseUrl = env['PILOT_LOCAL_BASE_URL'];
  if (baseUrl === undefined || baseUrl.trim() === '') {
    return null;
  }
  const model = env['PILOT_LOCAL_MODEL'];
  const apiKey = env['PILOT_LOCAL_API_KEY'];
  const timeout = Number(env['PILOT_LOCAL_TIMEOUT_MS'] ?? '');
  const comprehension = env['PILOT_LOCAL_VISION_COMPREHENSION'];
  return localEndpointSettingsSchema.parse({
    // Trailing slashes only: anything more is `normalizeLocalBaseUrl`'s job at
    // probe time, where a bad URL can be *diagnosed* rather than silently
    // rewritten.
    baseUrl: baseUrl.trim().replace(/\/+$/u, ''),
    // An empty model is a real configuration: the probe then reports what the
    // endpoint is serving instead of refusing, which is more useful than
    // demanding the user guess an id first.
    model: model === undefined || model.trim() === '' ? AUTO_SELECT_MODEL : model.trim(),
    ...(apiKey === undefined || apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
    ...(Number.isSafeInteger(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
    ...(comprehension === undefined
      ? {}
      : { requireVisionComprehension: comprehension !== '0' && comprehension !== 'false' }),
  });
}

/**
 * Model id meaning "whichever one the endpoint is serving".
 *
 * A local server usually has exactly one model loaded, and asking the user to
 * type its id before Pilot has ever spoken to the server is the wrong order.
 */
export const AUTO_SELECT_MODEL = '(auto)';

/* -------------------------------------------------------------------------- *
 * Diagnoses
 * -------------------------------------------------------------------------- */

/**
 * Everything that can be wrong with a local endpoint, as a closed set.
 *
 * "Clear diagnostics for unsupported models" is this PR's centre, so each
 * member exists because it needs a *different sentence*, not because it is a
 * different exception.
 */
export const LOCAL_DIAGNOSIS_CODES = [
  /** The base URL is not a URL, or not http(s). */
  'base-url-invalid',
  /** A valid URL that is not on this machine. Not fatal; it changes the label. */
  'endpoint-not-local',
  /** Nothing answered: connection refused, DNS failure, reset. */
  'endpoint-unreachable',
  /** Something is there but did not answer inside the budget. */
  'endpoint-timeout',
  /** An HTTP server answered, but not with an OpenAI-compatible model list. */
  'endpoint-not-openai-compatible',
  /** 404 on `/models` and the base URL has no `/v1` — almost always the cause. */
  'endpoint-path-missing-v1',
  /** 401/403. A local server configured with a key, or a proxy in front of it. */
  'endpoint-unauthorized',
  /** Compatible and empty: the server is up with no model loaded. */
  'no-model-loaded',
  /** The configured model id is not one of the ids the endpoint serves. */
  'model-not-served',
  /** The endpoint rejected an image content block outright. */
  'vision-rejected',
  /** The endpoint accepted the image and the model could not read it. */
  'vision-claimed-but-blind',
  /** The endpoint rejected a request carrying tool definitions. */
  'tools-rejected',
  /** The endpoint accepted the tools and the model ignored them. */
  'tools-ignored',
  /** The loaded context is below Pi's fixed compaction reserve. Not fatal. */
  'context-window-below-reserve',
  /** A probe request failed for a reason none of the above describes. */
  'probe-failed',
] as const;

export type LocalDiagnosisCode = (typeof LOCAL_DIAGNOSIS_CODES)[number];

export interface LocalDiagnosis {
  readonly code: LocalDiagnosisCode;
  /** The only string that may be rendered to a user. One or two sentences. */
  readonly userMessage: string;
  /** What the user can actually do. Rendered under {@link userMessage}. */
  readonly remedy: string;
  /** Technical detail for logs. Never contains screen data or a credential. */
  readonly detail: string;
  /** True when Pilot cannot build a working session from this endpoint. */
  readonly fatal: boolean;
}

/**
 * Diagnoses that describe the *model*, not the connection.
 *
 * They map to `unsupported-capability` rather than `provider-unavailable`
 * because that is what they are, and because the two codes route differently:
 * one invites a retry, the other invites choosing a different model.
 */
const CAPABILITY_DIAGNOSES: ReadonlySet<LocalDiagnosisCode> = new Set([
  'vision-rejected',
  'vision-claimed-but-blind',
  'tools-rejected',
  'tools-ignored',
]);

/** Turns a diagnosis into the error the rest of Pilot already routes. */
export function toLocalEndpointError(diagnosis: LocalDiagnosis): PilotError {
  const code = CAPABILITY_DIAGNOSES.has(diagnosis.code)
    ? 'unsupported-capability'
    : 'provider-unavailable';
  return new PilotError(code, diagnosis.detail, {
    userMessage: diagnosis.userMessage,
    // Reachability problems are worth another try; a model that cannot see is
    // not going to start.
    retryable:
      diagnosis.code === 'endpoint-unreachable' ||
      diagnosis.code === 'endpoint-timeout' ||
      diagnosis.code === 'no-model-loaded',
    details: { reason: diagnosis.code, remedy: diagnosis.remedy },
  });
}

/* -------------------------------------------------------------------------- *
 * Base URL
 * -------------------------------------------------------------------------- */

export interface NormalizedBaseUrl {
  /** Trailing slash removed. `null` when the input is unusable. */
  readonly baseUrl: string | null;
  readonly host: string | null;
  readonly loopback: boolean;
  /** True when the path does not end in `/v1`, which the 404 diagnosis uses. */
  readonly hasVersionPrefix: boolean;
  readonly diagnosis: LocalDiagnosis | null;
}

/**
 * Validates and tidies a base URL without guessing at it.
 *
 * Note what this deliberately does *not* do: append `/v1`. LM Studio, Ollama,
 * llama.cpp and vLLM all want it and some proxies do not, so a silent append
 * turns one wrong URL into a different wrong URL. The missing prefix is instead
 * *named* if and when `/models` 404s, where there is evidence for it.
 */
export function normalizeLocalBaseUrl(raw: string): NormalizedBaseUrl {
  const trimmed = raw.trim().replace(/\/+$/u, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      baseUrl: null,
      host: null,
      loopback: false,
      hasVersionPrefix: false,
      diagnosis: {
        code: 'base-url-invalid',
        userMessage: `“${raw}” is not a valid address for a local model server.`,
        remedy:
          'Enter the full address including the scheme and port, for example http://127.0.0.1:11434/v1.',
        detail: `base URL ${JSON.stringify(raw)} did not parse as a URL`,
        fatal: true,
      },
    };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // `new URL` accepts anything with a colon in it, so `localhost:11434`
    // parses happily with protocol `localhost:`. That is by far the most common
    // way to get this wrong, and it deserves the example rather than a lecture
    // about schemes.
    const missingScheme = !trimmed.includes('//');
    return {
      baseUrl: null,
      host: url.hostname,
      loopback: false,
      hasVersionPrefix: false,
      diagnosis: {
        code: 'base-url-invalid',
        userMessage: missingScheme
          ? `“${raw}” is missing the http:// prefix, so Pilot cannot tell what to connect to.`
          : `Pilot can only talk to a local model server over http or https, not ${url.protocol.replace(':', '')}.`,
        remedy:
          'Enter the full address including the scheme and port, for example http://127.0.0.1:11434/v1.',
        detail: `base URL scheme ${url.protocol} is not http(s)`,
        fatal: true,
      },
    };
  }
  const loopback = isLoopbackUrl(trimmed);
  return {
    baseUrl: trimmed,
    host: url.hostname,
    loopback,
    hasVersionPrefix: /\/v\d+$/u.test(url.pathname),
    diagnosis: loopback
      ? null
      : {
          code: 'endpoint-not-local',
          userMessage: `${url.hostname} is not this Mac. Screen images sent to this model leave the machine.`,
          remedy:
            'Use a loopback address (127.0.0.1 or localhost) if the server runs here, or accept that this profile is not private.',
          detail: `base URL host ${url.hostname} is not loopback; the profile is labelled remote`,
          fatal: false,
        },
  };
}

/* -------------------------------------------------------------------------- *
 * The probe
 * -------------------------------------------------------------------------- */

export interface LocalContextWindowFinding {
  /** What the server said it loaded, or `null` when it said nothing. */
  readonly tokens: number | null;
  /** Which field it came from, e.g. `meta.n_ctx`. `null` when unreported. */
  readonly field: string | null;
  /**
   * True when the number describes what this *server process* has allocated —
   * a fact — rather than what the model was trained for, which is a claim.
   */
  readonly measured: boolean;
  readonly note: string;
}

export interface LocalCapabilityFinding {
  readonly supported: boolean;
  /** False when the probe could not run at all (the endpoint was already down). */
  readonly probed: boolean;
  /** Plain-language provenance, safe to show in diagnostics. */
  readonly evidence: string;
  readonly diagnosis: LocalDiagnosis | null;
}

export interface LocalEndpointHealth {
  readonly baseUrl: string;
  readonly host: string | null;
  readonly loopback: boolean;
  readonly reachable: boolean;
  /** Ids the endpoint reports serving, in the order it reported them. */
  readonly modelIds: readonly string[];
  /** The id Pilot will use, after resolving {@link AUTO_SELECT_MODEL}. */
  readonly selectedModel: string | null;
  readonly latencyMs: number;
  readonly contextWindow: LocalContextWindowFinding;
  readonly diagnosis: LocalDiagnosis | null;
}

export interface LocalEndpointReport {
  readonly settings: LocalEndpointSettings;
  readonly health: LocalEndpointHealth;
  readonly vision: LocalCapabilityFinding;
  readonly tools: LocalCapabilityFinding;
  /** Everything found, fatal or not, in the order it was found. */
  readonly diagnoses: readonly LocalDiagnosis[];
  /** The first fatal diagnosis, or `null`. */
  readonly blocking: LocalDiagnosis | null;
  /** True when a visual conversation is possible: reachable, vision and tools. */
  readonly usable: boolean;
  /** HTTP requests the probe itself made. */
  readonly probeRequests: number;
  /**
   * Image bytes the probe sent. Every one of them is a swatch generated by
   * {@link solidColourPng}; the number exists so a test can assert that the
   * only pixels that left this machine were ones Pilot drew.
   */
  readonly probeImageBytes: number;
}

export interface LocalProbeDeps {
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected for determinism. Defaults to `Math.random`. */
  readonly random?: () => number;
  /** Injected for determinism. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Pi's `shouldCompact` has a hard-coded 16 384-token reserve and degenerates to
 * "always compact" at or below it (`docs/pi-notes.md` §2.7 note 4). A llama.cpp
 * server started without `-c` loads 4096, so this is the common case, not the
 * corner.
 */
export const PI_COMPACTION_RESERVE_TOKENS = 16_384;

/**
 * The vision probe's palette.
 *
 * Six, and the residual risk is stated rather than hidden: a model that cannot
 * see the swatch and guesses from the list in the prompt is right one time in
 * six. That is the probe's false-*pass* rate, and it is why
 * `requireVisionComprehension` exists in both directions — a user whose
 * vision-capable model is simply bad at naming colours can turn the
 * comprehension bar off, and a user who wants certainty can re-run the probe.
 * Reducing it further means a second request or a richer image, neither of
 * which a small local model handles reliably; `docs/handoff.md` §1 step 17 asks
 * for real-model evidence before that trade is made.
 */
const PROBE_COLOURS = [
  { name: 'red', rgb: [220, 30, 30] },
  { name: 'green', rgb: [30, 170, 60] },
  { name: 'blue', rgb: [30, 60, 220] },
  { name: 'yellow', rgb: [235, 215, 40] },
  { name: 'magenta', rgb: [210, 40, 190] },
  { name: 'cyan', rgb: [40, 200, 210] },
] as const;

const PROBE_TOOL_NAME = 'pilot_probe_ping';

async function readBodyText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 600);
  } catch {
    return '(response body could not be read)';
  }
}

/**
 * Node's `fetch` hides the real cause one level down.
 *
 * Two shapes, both observed here: `TypeError: fetch failed` with
 * `cause.code = 'ECONNREFUSED'`, and — on a dual-stack name like `localhost` —
 * `cause` as an `AggregateError` whose `errors` carry the per-family codes.
 */
function fetchFailureKind(error: unknown): 'timeout' | 'refused' | 'dns' | 'tls' | 'other' {
  const named = error as {
    name?: unknown;
    cause?: { code?: unknown; errors?: readonly { code?: unknown }[] };
  };
  if (named.name === 'AbortError' || named.name === 'TimeoutError') {
    return 'timeout';
  }
  const nested = named.cause?.errors?.find((entry) => typeof entry.code === 'string')?.code;
  const code =
    typeof named.cause?.code === 'string'
      ? named.cause.code
      : typeof nested === 'string'
        ? nested
        : '';
  if (code === 'ECONNREFUSED') {
    return 'refused';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'dns';
  }
  if (code.startsWith('UND_ERR_CONNECT_TIMEOUT') || code.startsWith('UND_ERR_HEADERS_TIMEOUT')) {
    return 'timeout';
  }
  if (code.includes('CERT') || code === 'EPROTO' || code.startsWith('ERR_TLS')) {
    return 'tls';
  }
  return 'other';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unreachableDiagnosis(
  baseUrl: string,
  host: string | null,
  error: unknown,
): LocalDiagnosis {
  const where = host ?? baseUrl;
  const detailSuffix = `: ${messageOf(error)}`;
  switch (fetchFailureKind(error)) {
    case 'timeout':
      return {
        code: 'endpoint-timeout',
        userMessage: `${where} accepted the connection but did not answer in time.`,
        remedy:
          'The model may still be loading. Wait for it to finish loading and try again, or raise the timeout.',
        detail: `GET ${baseUrl}/models timed out${detailSuffix}`,
        fatal: true,
      };
    case 'refused':
      return {
        code: 'endpoint-unreachable',
        userMessage: `Nothing is listening at ${baseUrl}. Pilot could not reach your local model.`,
        remedy:
          'Start your model server (for example `ollama serve` or `llama-server`), then check the port in the address.',
        detail: `GET ${baseUrl}/models refused the connection${detailSuffix}`,
        fatal: true,
      };
    case 'dns':
      return {
        code: 'endpoint-unreachable',
        userMessage: `Pilot could not find a machine called “${where}”.`,
        remedy: 'Check the host name in the address. For a server on this Mac, use 127.0.0.1.',
        detail: `GET ${baseUrl}/models could not resolve the host${detailSuffix}`,
        fatal: true,
      };
    case 'tls':
      return {
        code: 'endpoint-unreachable',
        userMessage: `${where} answered, but Pilot could not establish a secure connection to it.`,
        remedy:
          'A local server usually serves plain http. Try the http:// address, or install the server’s certificate.',
        detail: `GET ${baseUrl}/models failed TLS negotiation${detailSuffix}`,
        fatal: true,
      };
    default:
      return {
        code: 'endpoint-unreachable',
        userMessage: `Pilot could not reach your local model at ${baseUrl}.`,
        remedy: 'Check that the server is running and that the address and port are right.',
        detail: `GET ${baseUrl}/models failed${detailSuffix}`,
        fatal: true,
      };
  }
}

/** Fields local servers use for "the context this process actually loaded". */
const CONTEXT_FIELDS: readonly (readonly [string, boolean])[] = [
  // llama.cpp `/v1/models` → `meta.n_ctx`: the KV cache it allocated.
  ['meta.n_ctx', true],
  // LM Studio `/api/v0/models`, mirrored on some builds of `/v1/models`.
  ['loaded_context_length', true],
  // Advertised, not loaded — believed only when nothing better is present.
  ['max_context_length', false],
  ['context_length', false],
  ['context_window', false],
];

function readNumber(entry: Record<string, unknown>, path: string): number | null {
  const parts = path.split('.');
  let current: unknown = entry;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'number' && Number.isSafeInteger(current) && current > 0
    ? current
    : null;
}

function findContextWindow(entry: Record<string, unknown> | undefined): LocalContextWindowFinding {
  if (entry !== undefined) {
    for (const [field, measured] of CONTEXT_FIELDS) {
      const tokens = readNumber(entry, field);
      if (tokens !== null) {
        return {
          tokens,
          field,
          measured,
          note: measured
            ? `the server reported ${String(tokens)} tokens of context loaded (${field}); this is what it has allocated, not what the model was trained for`
            : `the model entry advertises ${String(tokens)} tokens (${field}); this is a claim about the model, not a measurement of the server`,
        };
      }
    }
  }
  return {
    tokens: null,
    field: null,
    measured: false,
    note: 'the endpoint reported no context window at all; Pilot falls back to its conservative default',
  };
}

interface ModelListOutcome {
  readonly ids: readonly string[];
  readonly entries: readonly Record<string, unknown>[];
  readonly diagnosis: LocalDiagnosis | null;
}

function parseModelList(baseUrl: string, status: number, body: string): ModelListOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const looksLikeHtml = /^\s*<(?:!doctype|html)/iu.test(body);
    return {
      ids: [],
      entries: [],
      diagnosis: {
        code: 'endpoint-not-openai-compatible',
        userMessage: `Something is running at ${baseUrl}, but it is not an OpenAI-compatible model server.`,
        remedy: looksLikeHtml
          ? 'That address served a web page. Point Pilot at the server’s API address instead — usually the same host with /v1 on the end.'
          : 'Check that the address is the OpenAI-compatible endpoint of your model server, usually ending in /v1.',
        detail: `GET ${baseUrl}/models returned ${String(status)} with a body that is not JSON (${body.slice(0, 120).replace(/\s+/gu, ' ')})`,
        fatal: true,
      },
    };
  }
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return {
      ids: [],
      entries: [],
      diagnosis: {
        code: 'endpoint-not-openai-compatible',
        userMessage: `${baseUrl} answered, but not with a list of models Pilot can read.`,
        remedy:
          'Check that the address is your model server’s OpenAI-compatible endpoint, usually ending in /v1.',
        detail: `GET ${baseUrl}/models returned JSON with no "data" array (keys: ${Object.keys(parsed as object).join(', ') || 'none'})`,
        fatal: true,
      },
    };
  }
  const entries = data.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
  const ids = entries
    .map((item) => item['id'])
    .filter((id): id is string => typeof id === 'string' && id !== '');
  return { ids, entries, diagnosis: null };
}

/* -------------------------------------------------------------------------- *
 * A PNG the probe draws itself
 * -------------------------------------------------------------------------- */

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xed88_8320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffff_ffff;
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(body.length + 8);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(out.length - 4, crc32(body));
  return out;
}

/**
 * A solid-colour PNG, drawn here rather than shipped as a base64 blob.
 *
 * Small on purpose (8×8 is ~70 bytes) so a probe costs nothing, and generated
 * so the colour can be chosen at probe time — a fixed image would let a model
 * that memorised one probe pass the next one.
 */
export function solidColourPng(r: number, g: number, b: number, size = 8): Uint8Array {
  const raw = new Uint8Array(size * (size * 3 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < size; x += 1) {
      const p = rowStart + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, size);
  header.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/* -------------------------------------------------------------------------- *
 * probeLocalEndpoint
 * -------------------------------------------------------------------------- */

interface ChatOutcome {
  readonly status: number;
  readonly body: string;
  readonly json: Record<string, unknown> | null;
  readonly error: unknown;
}

function firstChoiceMessage(json: Record<string, unknown> | null): Record<string, unknown> | null {
  const choices = json?.['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const first = choices[0] as { message?: unknown } | undefined;
  return typeof first?.message === 'object' && first.message !== null
    ? (first.message as Record<string, unknown>)
    : null;
}

function assistantText(json: Record<string, unknown> | null): string {
  const content = firstChoiceMessage(json)?.['content'];
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'object' &&
        block !== null &&
        typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : '',
      )
      .join(' ');
  }
  return '';
}

/**
 * Runs the whole ladder: reachability → compatibility → model → vision → tools.
 *
 * It never throws. Every failure is a {@link LocalDiagnosis} with a sentence a
 * user can act on, because the alternative — a stack trace from `undici` about
 * `ECONNREFUSED` — is exactly what this PR exists to replace.
 */
export async function probeLocalEndpoint(
  settings: LocalEndpointSettings,
  deps: LocalProbeDeps = {},
): Promise<LocalEndpointReport> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const timeoutMs = settings.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const diagnoses: LocalDiagnosis[] = [];
  let probeRequests = 0;
  let probeImageBytes = 0;

  const normalized = normalizeLocalBaseUrl(settings.baseUrl);
  if (normalized.diagnosis !== null) {
    diagnoses.push(normalized.diagnosis);
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (settings.apiKey !== undefined) {
    headers['authorization'] = `Bearer ${settings.apiKey}`;
  }

  const finish = (
    health: LocalEndpointHealth,
    vision: LocalCapabilityFinding,
    tools: LocalCapabilityFinding,
  ): LocalEndpointReport => {
    for (const finding of [vision, tools]) {
      if (finding.diagnosis !== null) {
        diagnoses.push(finding.diagnosis);
      }
    }
    const blocking = diagnoses.find((entry) => entry.fatal) ?? null;
    return {
      settings,
      health,
      vision,
      tools,
      diagnoses,
      blocking,
      usable: blocking === null && vision.supported && tools.supported,
      probeRequests,
      probeImageBytes,
    };
  };

  const unprobed = (what: string): LocalCapabilityFinding => ({
    supported: false,
    probed: false,
    evidence: `not probed: ${what}`,
    diagnosis: null,
  });

  if (normalized.baseUrl === null) {
    return finish(
      {
        baseUrl: settings.baseUrl,
        host: normalized.host,
        loopback: false,
        reachable: false,
        modelIds: [],
        selectedModel: null,
        latencyMs: 0,
        contextWindow: findContextWindow(undefined),
        diagnosis: normalized.diagnosis,
      },
      unprobed('the base URL is not usable'),
      unprobed('the base URL is not usable'),
    );
  }
  const baseUrl = normalized.baseUrl;

  const call = async (path: string, init?: RequestInit): Promise<ChatOutcome> => {
    probeRequests += 1;
    try {
      const response = await doFetch(`${baseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await readBodyText(response);
      let json: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(body);
        json =
          typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)
            : null;
      } catch {
        json = null;
      }
      return { status: response.status, body, json, error: null };
    } catch (error) {
      return { status: 0, body: '', json: null, error };
    }
  };

  // ---- 1. Reachability -----------------------------------------------------
  const startedAt = now();
  const list = await call('/models');
  const latencyMs = Math.max(0, now() - startedAt);

  const downHealth = (diagnosis: LocalDiagnosis): LocalEndpointHealth => ({
    baseUrl,
    host: normalized.host,
    loopback: normalized.loopback,
    reachable: false,
    modelIds: [],
    selectedModel: null,
    latencyMs,
    contextWindow: findContextWindow(undefined),
    diagnosis,
  });

  if (list.error !== null) {
    const diagnosis = unreachableDiagnosis(baseUrl, normalized.host, list.error);
    diagnoses.push(diagnosis);
    return finish(
      downHealth(diagnosis),
      unprobed('the endpoint did not answer'),
      unprobed('the endpoint did not answer'),
    );
  }

  // ---- 2. Is it an OpenAI-compatible API? ----------------------------------
  if (list.status === 401 || list.status === 403) {
    const diagnosis: LocalDiagnosis = {
      code: 'endpoint-unauthorized',
      userMessage: `${normalized.host ?? baseUrl} refused Pilot’s request${settings.apiKey === undefined ? ' because it needs a key' : ' with the key it was given'}.`,
      remedy:
        settings.apiKey === undefined
          ? 'Set PILOT_LOCAL_API_KEY to the key your server expects. Many local servers accept any non-empty string.'
          : 'Check the key your server expects, or remove the key if the server does not want one.',
      detail: `GET ${baseUrl}/models returned ${String(list.status)}`,
      fatal: true,
    };
    diagnoses.push(diagnosis);
    return finish(
      downHealth(diagnosis),
      unprobed('the endpoint refused the request'),
      unprobed('the endpoint refused the request'),
    );
  }

  if (list.status === 404 && !normalized.hasVersionPrefix) {
    const diagnosis: LocalDiagnosis = {
      code: 'endpoint-path-missing-v1',
      userMessage: `${baseUrl} is answering, but there is no model list at that address.`,
      remedy: `Most local servers put their OpenAI-compatible API under /v1. Try ${baseUrl}/v1.`,
      detail: `GET ${baseUrl}/models returned 404 and the base URL has no version prefix`,
      fatal: true,
    };
    diagnoses.push(diagnosis);
    return finish(
      downHealth(diagnosis),
      unprobed('the model list was not found'),
      unprobed('the model list was not found'),
    );
  }

  if (list.status < 200 || list.status >= 300) {
    const diagnosis: LocalDiagnosis = {
      code: 'endpoint-not-openai-compatible',
      userMessage: `${baseUrl} answered with an error instead of a list of models.`,
      remedy:
        'Check that the address is your model server’s OpenAI-compatible endpoint, usually ending in /v1.',
      detail: `GET ${baseUrl}/models returned ${String(list.status)}: ${list.body.slice(0, 200).replace(/\s+/gu, ' ')}`,
      fatal: true,
    };
    diagnoses.push(diagnosis);
    return finish(
      downHealth(diagnosis),
      unprobed('the model list could not be read'),
      unprobed('the model list could not be read'),
    );
  }

  const parsed = parseModelList(baseUrl, list.status, list.body);
  if (parsed.diagnosis !== null) {
    diagnoses.push(parsed.diagnosis);
    return finish(
      downHealth(parsed.diagnosis),
      unprobed('the model list could not be read'),
      unprobed('the model list could not be read'),
    );
  }

  // ---- 3. Is a model loaded, and is it the one that was asked for? ---------
  if (parsed.ids.length === 0) {
    const diagnosis: LocalDiagnosis = {
      code: 'no-model-loaded',
      userMessage: `Your model server at ${normalized.host ?? baseUrl} is running, but it has no model loaded.`,
      remedy:
        'Load a model in your server (for example `ollama pull` then `ollama run`, or open a model in LM Studio) and try again.',
      detail: `GET ${baseUrl}/models returned an empty model list`,
      fatal: true,
    };
    diagnoses.push(diagnosis);
    return finish(
      {
        ...downHealth(diagnosis),
        reachable: true,
      },
      unprobed('no model is loaded'),
      unprobed('no model is loaded'),
    );
  }

  const wantsAuto = settings.model === AUTO_SELECT_MODEL;
  const selectedModel = wantsAuto
    ? (parsed.ids[0] ?? null)
    : (parsed.ids.find((id) => id === settings.model) ?? null);

  if (selectedModel === null) {
    const shown = parsed.ids.slice(0, 8).join(', ');
    const diagnosis: LocalDiagnosis = {
      code: 'model-not-served',
      userMessage: `Your model server is running, but it is not serving a model called “${settings.model}”.`,
      remedy: `It is serving: ${shown}${parsed.ids.length > 8 ? `, and ${String(parsed.ids.length - 8)} more` : ''}. Pick one of those.`,
      detail: `model ${JSON.stringify(settings.model)} is not among the ${String(parsed.ids.length)} ids at ${baseUrl}`,
      fatal: true,
    };
    diagnoses.push(diagnosis);
    return finish(
      { ...downHealth(diagnosis), reachable: true, modelIds: parsed.ids },
      unprobed('the configured model is not served'),
      unprobed('the configured model is not served'),
    );
  }

  const entry = parsed.entries.find((item) => item['id'] === selectedModel);
  const contextWindow = findContextWindow(entry);
  if (
    contextWindow.tokens !== null &&
    contextWindow.measured &&
    contextWindow.tokens <= PI_COMPACTION_RESERVE_TOKENS
  ) {
    diagnoses.push({
      code: 'context-window-below-reserve',
      userMessage: `Your model server has only ${String(contextWindow.tokens)} tokens of context loaded, so Pilot will summarise the conversation very often.`,
      remedy: `Restart the server with a larger context (llama.cpp: -c ${String(PI_COMPACTION_RESERVE_TOKENS * 2)}; Ollama: OLLAMA_CONTEXT_LENGTH) if answers start losing earlier turns.`,
      detail: `${contextWindow.field ?? 'context'} = ${String(contextWindow.tokens)} is at or below Pi's fixed ${String(PI_COMPACTION_RESERVE_TOKENS)}-token compaction reserve, so the provider-headroom trigger is always true`,
      fatal: false,
    });
  }

  const health: LocalEndpointHealth = {
    baseUrl,
    host: normalized.host,
    loopback: normalized.loopback,
    reachable: true,
    modelIds: parsed.ids,
    selectedModel,
    latencyMs,
    contextWindow,
    diagnosis: null,
  };

  // ---- 4. Vision ----------------------------------------------------------
  const colour =
    PROBE_COLOURS[
      Math.min(PROBE_COLOURS.length - 1, Math.floor(random() * PROBE_COLOURS.length))
    ] ?? PROBE_COLOURS[0];
  const swatch = solidColourPng(colour.rgb[0], colour.rgb[1], colour.rgb[2]);
  probeImageBytes += swatch.length;
  const swatchUrl = `data:image/png;base64,${Buffer.from(swatch).toString('base64')}`;
  const visionCall = await call('/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: selectedModel,
      max_tokens: 16,
      temperature: 0,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `This image is one solid colour. Reply with that colour and nothing else. Choose exactly one of: ${PROBE_COLOURS.map((entry) => entry.name).join(', ')}.`,
            },
            { type: 'image_url', image_url: { url: swatchUrl } },
          ],
        },
      ],
    }),
  });

  const vision = ((): LocalCapabilityFinding => {
    if (visionCall.error !== null) {
      return {
        supported: false,
        probed: false,
        evidence: 'the vision probe request failed before an answer arrived',
        diagnosis: {
          code: 'probe-failed',
          userMessage: `Pilot could not check whether ${selectedModel} can see images.`,
          remedy: 'Check the server is still running, then try again.',
          detail: `vision probe to ${baseUrl}/chat/completions failed: ${messageOf(visionCall.error)}`,
          fatal: true,
        },
      };
    }
    if (visionCall.status < 200 || visionCall.status >= 300) {
      return {
        supported: false,
        probed: true,
        evidence: `the endpoint rejected an image with HTTP ${String(visionCall.status)}`,
        diagnosis: {
          code: 'vision-rejected',
          userMessage: `${selectedModel} cannot accept images, so it cannot answer questions about your screen.`,
          remedy:
            'Load a vision model (for example a *-VL or llava build) in your server and select it in Pilot.',
          detail: `vision probe returned ${String(visionCall.status)}: ${visionCall.body.slice(0, 200).replace(/\s+/gu, ' ')}`,
          fatal: false,
        },
      };
    }
    const answer = assistantText(visionCall.json).toLowerCase();
    const named = PROBE_COLOURS.filter((entry) => answer.includes(entry.name));
    const correct = named.length === 1 && named[0]?.name === colour.name;
    if (correct) {
      return {
        supported: true,
        probed: true,
        evidence: `the model read an ${String(8)}×8 ${colour.name} swatch and named it correctly`,
        diagnosis: null,
      };
    }
    if (settings.requireVisionComprehension === false) {
      return {
        supported: true,
        probed: true,
        evidence:
          'the endpoint accepted an image content block; comprehension was not required (requireVisionComprehension=false)',
        diagnosis: null,
      };
    }
    return {
      supported: false,
      probed: true,
      evidence: `the endpoint accepted the image but the model answered ${JSON.stringify(answer.slice(0, 60))} for a ${colour.name} swatch`,
      diagnosis: {
        code: 'vision-claimed-but-blind',
        userMessage: `${selectedModel} accepted an image but could not tell Pilot what was in it, so it cannot answer questions about your screen.`,
        remedy:
          'Load a vision model in your server. If you believe this model can see, set PILOT_LOCAL_VISION_COMPREHENSION=0 to accept its claim instead.',
        detail: `vision probe: sent a ${colour.name} swatch, model replied ${JSON.stringify(answer.slice(0, 120))}`,
        fatal: false,
      },
    };
  })();

  // ---- 5. Tools -----------------------------------------------------------
  const toolCall = await call('/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: selectedModel,
      max_tokens: 64,
      temperature: 0,
      stream: false,
      messages: [
        {
          role: 'user',
          content: `Call the ${PROBE_TOOL_NAME} tool now. Do not answer in words.`,
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: PROBE_TOOL_NAME,
            description: 'Answers "pong". Call it whenever you are asked to.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
      ],
      tool_choice: 'auto',
    }),
  });

  const tools = ((): LocalCapabilityFinding => {
    if (toolCall.error !== null) {
      return {
        supported: false,
        probed: false,
        evidence: 'the tool probe request failed before an answer arrived',
        diagnosis: {
          code: 'probe-failed',
          userMessage: `Pilot could not check whether ${selectedModel} can use tools.`,
          remedy: 'Check the server is still running, then try again.',
          detail: `tool probe to ${baseUrl}/chat/completions failed: ${messageOf(toolCall.error)}`,
          fatal: true,
        },
      };
    }
    if (toolCall.status < 200 || toolCall.status >= 300) {
      return {
        supported: false,
        probed: true,
        evidence: `the endpoint rejected tool definitions with HTTP ${String(toolCall.status)}`,
        diagnosis: {
          code: 'tools-rejected',
          userMessage: `${selectedModel} cannot use Pilot’s screen tool, so it cannot look at your screen.`,
          remedy:
            'Load a model with tool-calling support, or use a server build that supports the OpenAI tools field.',
          detail: `tool probe returned ${String(toolCall.status)}: ${toolCall.body.slice(0, 200).replace(/\s+/gu, ' ')}`,
          fatal: false,
        },
      };
    }
    const calls = firstChoiceMessage(toolCall.json)?.['tool_calls'];
    const called =
      Array.isArray(calls) &&
      calls.some(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { function?: { name?: unknown } }).function?.name === 'string',
      );
    if (called) {
      return {
        supported: true,
        probed: true,
        evidence: `the model answered a tool prompt with a tool_calls entry for ${PROBE_TOOL_NAME}`,
        diagnosis: null,
      };
    }
    return {
      supported: false,
      probed: true,
      evidence: `the endpoint accepted the tool definition and the model replied in words instead: ${JSON.stringify(assistantText(toolCall.json).slice(0, 60))}`,
      diagnosis: {
        code: 'tools-ignored',
        userMessage: `${selectedModel} accepted Pilot’s screen tool but did not use it, so it cannot look at your screen.`,
        remedy:
          'Load a model that supports tool calling. Small local models frequently advertise it and never emit a call.',
        detail: `tool probe: model was told to call ${PROBE_TOOL_NAME} and returned no tool_calls`,
        fatal: false,
      },
    };
  })();

  return finish(health, vision, tools);
}
