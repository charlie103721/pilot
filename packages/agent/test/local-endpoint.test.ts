import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PilotError } from '@pilot/shared';
import {
  AUTO_SELECT_MODEL,
  DEFAULT_PROBE_TIMEOUT_MS,
  PI_COMPACTION_RESERVE_TOKENS,
  localEndpointSettingsSchema,
  normalizeLocalBaseUrl,
  probeLocalEndpoint,
  readLocalEndpointSettings,
  solidColourPng,
  toLocalEndpointError,
  type LocalEndpointReport,
} from '../src/local-endpoint.js';
import {
  startStubOpenAiEndpoint,
  type StubEndpointBehaviour,
  type StubOpenAiEndpoint,
} from '../src/stub-openai-endpoint.js';

/**
 * PR-039 — the probe ladder and its diagnostics.
 *
 * The endpoint under test is `stub-openai-endpoint.ts`, a fixture written for
 * this PR. It is NOT an inference server; see that file's header. What these
 * tests pin is the ladder, the classification of each failure, and the exact
 * sentence a user would see — not the behaviour of llama.cpp.
 */

const open: StubOpenAiEndpoint[] = [];

async function stub(
  options: Parameters<typeof startStubOpenAiEndpoint>[0] = {},
): Promise<StubOpenAiEndpoint> {
  const endpoint = await startStubOpenAiEndpoint(options);
  open.push(endpoint);
  return endpoint;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((endpoint) => endpoint.close()));
});

/** Deterministic colour choice so a failing assertion names one swatch. */
const fixedRandom = (): number => 0.5;

/** A loopback URL whose port was bound and released, so connecting is refused. */
async function closedLoopbackUrl(): Promise<string> {
  const server = createNetServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return `http://127.0.0.1:${String(port)}/v1`;
}

async function probe(
  baseUrl: string,
  model: string,
  overrides: Partial<Parameters<typeof probeLocalEndpoint>[0]> = {},
): Promise<LocalEndpointReport> {
  return probeLocalEndpoint(
    { baseUrl, model, timeoutMs: 5_000, ...overrides },
    { random: fixedRandom },
  );
}

describe('local endpoint settings', () => {
  it('reads nothing when PILOT_LOCAL_BASE_URL is absent', () => {
    expect(readLocalEndpointSettings({})).toBeNull();
    expect(readLocalEndpointSettings({ PILOT_LOCAL_BASE_URL: '   ' })).toBeNull();
  });

  it('reads a full configuration from the environment', () => {
    const settings = readLocalEndpointSettings({
      PILOT_LOCAL_BASE_URL: ' http://127.0.0.1:8080/v1 ',
      PILOT_LOCAL_MODEL: 'qwen2.5-vl-7b',
      PILOT_LOCAL_API_KEY: 'not-a-real-key',
      PILOT_LOCAL_TIMEOUT_MS: '4000',
      PILOT_LOCAL_VISION_COMPREHENSION: '0',
    });
    expect(settings).toEqual({
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'qwen2.5-vl-7b',
      apiKey: 'not-a-real-key',
      timeoutMs: 4000,
      requireVisionComprehension: false,
    });
  });

  it('falls back to auto model selection rather than demanding an id first', () => {
    const settings = readLocalEndpointSettings({
      PILOT_LOCAL_BASE_URL: 'http://127.0.0.1:1234/v1',
    });
    expect(settings?.model).toBe(AUTO_SELECT_MODEL);
    expect(settings?.timeoutMs).toBeUndefined();
  });

  it('ignores a nonsense timeout instead of treating it as zero', () => {
    const settings = readLocalEndpointSettings({
      PILOT_LOCAL_BASE_URL: 'http://127.0.0.1:1234/v1',
      PILOT_LOCAL_TIMEOUT_MS: 'soon',
    });
    expect(settings?.timeoutMs).toBeUndefined();
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('rejects an unknown settings key rather than silently dropping it', () => {
    expect(() =>
      localEndpointSettingsSchema.parse({ baseUrl: 'http://x', model: 'm', apikey: 'oops' }),
    ).toThrow();
  });
});

describe('base URL normalisation', () => {
  it('accepts a loopback URL and strips trailing slashes', () => {
    const result = normalizeLocalBaseUrl('http://127.0.0.1:11434/v1/');
    expect(result.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(result.loopback).toBe(true);
    expect(result.hasVersionPrefix).toBe(true);
    expect(result.diagnosis).toBeNull();
  });

  it('refuses a URL that is not a URL, and says what a good one looks like', () => {
    const result = normalizeLocalBaseUrl('localhost:11434');
    expect(result.baseUrl).toBeNull();
    expect(result.diagnosis?.code).toBe('base-url-invalid');
    expect(result.diagnosis?.remedy).toContain('http://127.0.0.1:11434/v1');
    expect(result.diagnosis?.fatal).toBe(true);
  });

  it('refuses a non-http scheme', () => {
    expect(normalizeLocalBaseUrl('file:///models').diagnosis?.code).toBe('base-url-invalid');
  });

  it('does NOT invent a /v1 suffix', () => {
    const result = normalizeLocalBaseUrl('http://127.0.0.1:11434');
    expect(result.baseUrl).toBe('http://127.0.0.1:11434');
    expect(result.hasVersionPrefix).toBe(false);
  });

  it('warns without refusing when the endpoint is on the network, not this Mac', () => {
    const result = normalizeLocalBaseUrl('http://192.168.1.40:8000/v1');
    expect(result.loopback).toBe(false);
    expect(result.diagnosis?.code).toBe('endpoint-not-local');
    expect(result.diagnosis?.fatal).toBe(false);
    expect(result.diagnosis?.userMessage).toContain('leave the machine');
  });
});

describe('the probe swatch', () => {
  it('is a real PNG, small, and different for different colours', () => {
    const red = solidColourPng(220, 30, 30);
    const blue = solidColourPng(30, 60, 220);
    expect([...red.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(red.length).toBeLessThan(200);
    expect(Buffer.from(red).equals(Buffer.from(blue))).toBe(false);
  });
});

describe('a healthy local endpoint', () => {
  it('probes reachability, model, vision and tools, and reports them all as facts', async () => {
    const endpoint = await stub({ contextWindow: 32_768 });
    const report = await probe(endpoint.baseUrl, endpoint.modelId);

    expect(report.blocking).toBeNull();
    expect(report.usable).toBe(true);
    expect(report.health.reachable).toBe(true);
    expect(report.health.selectedModel).toBe(endpoint.modelId);
    expect(report.health.loopback).toBe(true);
    expect(report.vision).toMatchObject({ supported: true, probed: true });
    expect(report.tools).toMatchObject({ supported: true, probed: true });
    // Three requests: the model list, the vision probe, the tool probe.
    expect(report.probeRequests).toBe(3);
  });

  it('selects the served model when the settings say “auto”', async () => {
    const endpoint = await stub({ modelId: 'llava-v1.6' });
    const report = await probe(endpoint.baseUrl, AUTO_SELECT_MODEL);
    expect(report.health.selectedModel).toBe('llava-v1.6');
    expect(report.usable).toBe(true);
  });

  it('sends only its own swatch — the endpoint never sees screen pixels', async () => {
    const endpoint = await stub();
    const report = await probe(endpoint.baseUrl, endpoint.modelId);
    const bytesReceived = endpoint.requests.reduce((sum, entry) => sum + entry.imageBytes, 0);
    expect(report.probeImageBytes).toBeGreaterThan(0);
    expect(report.probeImageBytes).toBeLessThan(200);
    expect(bytesReceived).toBe(report.probeImageBytes);
  });

  it('reads back the context the server says it loaded', async () => {
    const endpoint = await stub({ contextWindow: 8_192 });
    const report = await probe(endpoint.baseUrl, endpoint.modelId);
    expect(report.health.contextWindow).toMatchObject({
      tokens: 8_192,
      field: 'meta.n_ctx',
      measured: true,
    });
  });

  it('says so, without refusing, when the loaded context is below Pi’s compaction reserve', async () => {
    const endpoint = await stub({ contextWindow: 4_096 });
    const report = await probe(endpoint.baseUrl, endpoint.modelId);
    const warning = report.diagnoses.find((entry) => entry.code === 'context-window-below-reserve');
    expect(warning?.fatal).toBe(false);
    expect(warning?.userMessage).toContain('4096 tokens of context');
    expect(warning?.remedy).toContain('-c ');
    expect(report.usable).toBe(true);
    expect(PI_COMPACTION_RESERVE_TOKENS).toBe(16_384);
  });

  it('reports no context window at all rather than inventing one', async () => {
    const endpoint = await stub();
    const report = await probe(endpoint.baseUrl, endpoint.modelId);
    expect(report.health.contextWindow.tokens).toBeNull();
    expect(report.health.contextWindow.note).toContain('no context window at all');
  });
});

describe('diagnostics for an endpoint that is not there', () => {
  it('names a refused connection and tells the user to start their server', async () => {
    // A port that was bound and released: nothing is listening, and unlike a
    // low port number Node's fetch will actually try to connect to it.
    const closed = await closedLoopbackUrl();
    const report = await probe(closed, 'anything');
    expect(report.blocking?.code).toBe('endpoint-unreachable');
    expect(report.blocking?.userMessage).toContain(`Nothing is listening at ${closed}`);
    expect(report.blocking?.remedy).toContain('ollama serve');
    expect(report.health.reachable).toBe(false);
    expect(report.vision.probed).toBe(false);
    expect(report.tools.probed).toBe(false);
  });

  it('names an unresolvable host', async () => {
    const report = await probe('http://pilot-no-such-host.invalid:9/v1', 'anything');
    expect(report.blocking?.code).toBe('endpoint-unreachable');
    expect(report.blocking?.userMessage).toContain('pilot-no-such-host.invalid');
  });

  it('refuses an unusable base URL before making any request at all', async () => {
    const report = await probe('not a url', 'anything');
    expect(report.blocking?.code).toBe('base-url-invalid');
    expect(report.probeRequests).toBe(0);
    expect(report.probeImageBytes).toBe(0);
  });
});

describe('diagnostics for an endpoint that is there but wrong', () => {
  const cases: readonly {
    readonly name: string;
    readonly behaviour: StubEndpointBehaviour;
    readonly code: string;
    readonly message: RegExp;
    readonly fatal: boolean;
  }[] = [
    {
      name: 'a web server that is not an API',
      behaviour: 'not-openai',
      code: 'endpoint-not-openai-compatible',
      message: /not an OpenAI-compatible model server/u,
      fatal: true,
    },
    {
      name: 'a server with no model loaded',
      behaviour: 'no-model-loaded',
      code: 'no-model-loaded',
      message: /running, but it has no model loaded/u,
      fatal: true,
    },
    {
      name: 'a server that wants a key',
      behaviour: 'unauthorized',
      code: 'endpoint-unauthorized',
      message: /refused Pilot’s request because it needs a key/u,
      fatal: true,
    },
    {
      name: 'a model that cannot accept images',
      behaviour: 'vision-rejected',
      code: 'vision-rejected',
      message: /cannot accept images, so it cannot answer questions about your screen/u,
      fatal: false,
    },
    {
      name: 'a model that accepts images and cannot read them',
      behaviour: 'vision-blind',
      code: 'vision-claimed-but-blind',
      message: /accepted an image but could not tell Pilot what was in it/u,
      fatal: false,
    },
    {
      name: 'a model whose server rejects tool definitions',
      behaviour: 'tools-rejected',
      code: 'tools-rejected',
      message: /cannot use Pilot’s screen tool/u,
      fatal: false,
    },
    {
      name: 'a model that accepts tools and ignores them',
      behaviour: 'tools-ignored',
      code: 'tools-ignored',
      message: /accepted Pilot’s screen tool but did not use it/u,
      fatal: false,
    },
  ];

  for (const testCase of cases) {
    it(`diagnoses ${testCase.name} with a message the user can act on`, async () => {
      const endpoint = await stub({ behaviour: testCase.behaviour });
      const report = await probe(endpoint.baseUrl, endpoint.modelId);
      const found = report.diagnoses.find((entry) => entry.code === testCase.code);
      expect(
        found,
        `expected a ${testCase.code} diagnosis, got ${report.diagnoses.map((d) => d.code).join(', ') || 'none'}`,
      ).toBeDefined();
      expect(found?.userMessage).toMatch(testCase.message);
      expect(found?.remedy.length).toBeGreaterThan(10);
      expect(found?.fatal).toBe(testCase.fatal);
      expect(report.usable).toBe(false);
    });
  }

  it('names the missing /v1 when the model list 404s and the URL has no version prefix', async () => {
    const endpoint = await stub();
    const report = await probe(endpoint.rootUrl, 'anything');
    expect(report.blocking?.code).toBe('endpoint-path-missing-v1');
    expect(report.blocking?.remedy).toContain(`${endpoint.rootUrl}/v1`);
  });

  it('lists what the endpoint IS serving when the configured model is not among them', async () => {
    const endpoint = await stub({ modelId: 'llava-v1.6' });
    const report = await probe(endpoint.baseUrl, 'qwen2.5-vl-7b');
    expect(report.blocking?.code).toBe('model-not-served');
    expect(report.blocking?.userMessage).toContain('qwen2.5-vl-7b');
    expect(report.blocking?.remedy).toContain('llava-v1.6');
  });

  it('accepts a key when the server wants one, and refuses when it is wrong', async () => {
    const endpoint = await stub({ apiKey: 'secret-token' });
    const bad = await probe(endpoint.baseUrl, endpoint.modelId);
    expect(bad.blocking?.code).toBe('endpoint-unauthorized');

    const good = await probeLocalEndpoint(
      {
        baseUrl: endpoint.baseUrl,
        model: endpoint.modelId,
        apiKey: 'secret-token',
        timeoutMs: 5_000,
      },
      { random: fixedRandom },
    );
    expect(good.blocking).toBeNull();
    expect(good.usable).toBe(true);
  });

  it('does not leak the key into any diagnosis', async () => {
    const endpoint = await stub({ apiKey: 'secret-token' });
    const report = await probeLocalEndpoint(
      {
        baseUrl: endpoint.baseUrl,
        model: endpoint.modelId,
        apiKey: 'wrong-token-abcdefgh',
        timeoutMs: 5_000,
      },
      { random: fixedRandom },
    );
    const text = JSON.stringify(report.diagnoses);
    expect(text).not.toContain('wrong-token-abcdefgh');
  });

  it('can be told to accept a vision claim it could not confirm', async () => {
    const endpoint = await stub({ behaviour: 'vision-blind' });
    const report = await probeLocalEndpoint(
      {
        baseUrl: endpoint.baseUrl,
        model: endpoint.modelId,
        timeoutMs: 5_000,
        requireVisionComprehension: false,
      },
      { random: fixedRandom },
    );
    expect(report.vision.supported).toBe(true);
    expect(report.vision.evidence).toContain('comprehension was not required');
  });

  it('stops the ladder rather than probing capabilities of an endpoint that is down', async () => {
    const endpoint = await stub({ behaviour: 'no-model-loaded' });
    const report = await probe(endpoint.baseUrl, endpoint.modelId);
    expect(report.probeRequests).toBe(1);
    expect(report.probeImageBytes).toBe(0);
    expect(endpoint.requests.every((entry) => entry.imageBytes === 0)).toBe(true);
  });
});

describe('diagnoses as Pilot errors', () => {
  it('maps to provider-unavailable and keeps the remedy', async () => {
    const report = await probe(await closedLoopbackUrl(), 'anything');
    const error = toLocalEndpointError(report.blocking!);
    expect(error).toBeInstanceOf(PilotError);
    expect(error.code).toBe('provider-unavailable');
    expect(error.retryable).toBe(true);
    expect(error.userMessage).toBe(report.blocking?.userMessage);
    expect(error.toJSON().details).toMatchObject({ reason: 'endpoint-unreachable' });
  });

  it('does not offer a retry for a model that cannot see', async () => {
    const endpoint = await stub({ behaviour: 'vision-rejected' });
    const report = await probe(endpoint.baseUrl, endpoint.modelId);
    const diagnosis = report.diagnoses.find((entry) => entry.code === 'vision-rejected');
    expect(toLocalEndpointError(diagnosis!).retryable).toBe(false);
  });
});
