import { afterEach, describe, expect, it } from 'vitest';
import { asConversationId, nullLogger, PilotError } from '@pilot/shared';
import {
  createDevelopmentModelSource,
  probeLocalEndpoint,
  startStubOpenAiEndpoint,
  type StubEndpointBehaviour,
  type StubOpenAiEndpoint,
} from '@pilot/agent';
import { createAgentRuntime } from '../../src/main/agent-runtime.js';
import { blockingDiagnosisFor, resolveLocalModelSource } from '../../src/main/local-model.js';
import {
  contextWindowInputOf,
  resolveContextWindow,
  CONSERVATIVE_CONTEXT_WINDOW,
} from '../../src/main/context-window.js';

/**
 * PR-039 — the local profile at the composition root.
 *
 * The endpoint is `stub-openai-endpoint.ts`, a fixture written for this PR, not
 * an inference server. What is pinned here is the three-outcome rule: not
 * configured, configured and usable, configured and NOT usable — and above all
 * that the third never looks like the second.
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

/** Fixed swatch colour: a blind model guessing is right one time in six. */
const probe: typeof probeLocalEndpoint = (settings, deps = {}) =>
  probeLocalEndpoint(settings, { random: () => 0.5, ...deps });

describe('resolveLocalModelSource', () => {
  it('reports "not configured" when no base URL is set, and takes no action', async () => {
    const resolution = await resolveLocalModelSource({ env: {} });
    expect(resolution).toEqual({
      configured: false,
      source: null,
      blockedBy: null,
      report: null,
      lines: [],
    });
  });

  it('falls back on a malformed environment, but says so in the log', async () => {
    const warnings: string[] = [];
    const resolution = await resolveLocalModelSource({
      // Past the schema's 2048-character limit: a paste accident, not a URL.
      env: { PILOT_LOCAL_BASE_URL: `http://127.0.0.1/${'x'.repeat(3000)}` },
      logger: {
        ...nullLogger,
        warn: (message: string) => {
          warnings.push(message);
        },
      },
      probe: async () => {
        throw new Error('the probe must not run for settings that did not parse');
      },
    });
    expect(resolution.configured).toBe(false);
    expect(warnings).toContain('local model settings could not be read');
  });

  it('resolves a healthy endpoint into a usable source with no blocker', async () => {
    const endpoint = await stub({ modelId: 'qwen2.5-vl-7b', contextWindow: 32_768 });
    const resolution = await resolveLocalModelSource({
      env: { PILOT_LOCAL_BASE_URL: endpoint.baseUrl, PILOT_LOCAL_MODEL: endpoint.modelId },
      probe,
    });

    expect(resolution.configured).toBe(true);
    expect(resolution.blockedBy).toBeNull();
    expect(resolution.source?.profile.model).toBe('qwen2.5-vl-7b');
    expect(resolution.source?.profile.isRemote).toBe(false);
    expect(resolution.source?.toolSupport).toBe('verified');
    // Locality first: §14 wants it before observation begins.
    expect(resolution.lines[0]).toContain('Local model on this Mac');
  });

  it('picks the served model when none is named', async () => {
    const endpoint = await stub({ modelId: 'llava-v1.6' });
    const resolution = await resolveLocalModelSource({
      env: { PILOT_LOCAL_BASE_URL: endpoint.baseUrl },
      probe,
    });
    expect(resolution.source?.profile.model).toBe('llava-v1.6');
  });

  const blockingCases: readonly (readonly [StubEndpointBehaviour, string, string])[] = [
    ['no-model-loaded', 'provider-unavailable', 'no model loaded'],
    ['not-openai', 'provider-unavailable', 'not an OpenAI-compatible model server'],
    ['unauthorized', 'provider-unavailable', 'needs a key'],
    ['vision-rejected', 'unsupported-capability', 'cannot accept images'],
    ['vision-blind', 'unsupported-capability', 'could not tell Pilot what was in it'],
    ['tools-rejected', 'unsupported-capability', 'cannot use Pilot'],
    ['tools-ignored', 'unsupported-capability', 'did not use it'],
  ];

  for (const [behaviour, code, phrase] of blockingCases) {
    it(`blocks a ${behaviour} endpoint with a ${code} the user can read`, async () => {
      const endpoint = await stub({ behaviour });
      const resolution = await resolveLocalModelSource({
        env: { PILOT_LOCAL_BASE_URL: endpoint.baseUrl },
        probe,
      });
      expect(resolution.configured).toBe(true);
      // The source still exists: the app names the model the user configured
      // rather than quietly booting into a different one.
      expect(resolution.source).not.toBeNull();
      expect(resolution.blockedBy?.code).toBe(code);
      expect(resolution.blockedBy?.userMessage).toContain(phrase);
      expect(resolution.blockedBy?.toJSON().details).toHaveProperty('remedy');
    });
  }

  it('does not block on a warning, and still reports it', async () => {
    const endpoint = await stub({ contextWindow: 4_096 });
    const resolution = await resolveLocalModelSource({
      env: { PILOT_LOCAL_BASE_URL: endpoint.baseUrl },
      probe,
    });
    expect(resolution.blockedBy).toBeNull();
    expect(resolution.lines.join('\n')).toContain('4096 tokens of context');
  });

  it('never puts a key in the startup lines', async () => {
    const endpoint = await stub({ apiKey: 'top-secret-value-1234' });
    const resolution = await resolveLocalModelSource({
      env: {
        PILOT_LOCAL_BASE_URL: endpoint.baseUrl,
        PILOT_LOCAL_API_KEY: 'top-secret-value-1234',
      },
      probe,
    });
    expect(resolution.blockedBy).toBeNull();
    expect(resolution.lines.join('\n')).not.toContain('top-secret-value-1234');
  });

  it('prefers a fatal diagnosis over a capability one', async () => {
    const endpoint = await stub({ behaviour: 'no-model-loaded' });
    const report = await probe({ baseUrl: endpoint.baseUrl, model: '(auto)' });
    expect(blockingDiagnosisFor(report)?.code).toBe('no-model-loaded');
  });
});

describe('a blocked provider at the agent runtime', () => {
  it('refuses every question with the endpoint’s own reason, and sends nothing', async () => {
    const endpoint = await stub({ behaviour: 'vision-blind', modelId: 'gemma-3-4b' });
    const resolution = await resolveLocalModelSource({
      env: { PILOT_LOCAL_BASE_URL: endpoint.baseUrl },
      probe,
    });
    const source = resolution.source!;
    const runtime = createAgentRuntime({
      conversationId: asConversationId('conv-blocked'),
      source,
      blockedBy: resolution.blockedBy!,
    });

    expect(runtime.capability.ok).toBe(false);
    await expect(
      runtime.session.submit({
        utteranceId: 'utt-1' as never,
        transcript: 'What is this?',
        conversationId: asConversationId('conv-blocked'),
        scene: null,
        pointer: null,
      } as never),
    ).rejects.toBeInstanceOf(PilotError);

    // Nothing streamed: the probe's three requests and no more.
    expect(source.requestCount()).toBe(0);
    expect(endpoint.requests.filter((entry) => entry.streamed)).toHaveLength(0);
    expect(endpoint.requests.reduce((sum, entry) => sum + entry.imageBytes, 0)).toBe(
      source.report.probeImageBytes,
    );
    await runtime.dispose();
  });

  it('leaves a healthy source alone — blockedBy is optional and additive', async () => {
    const endpoint = await stub({ script: [{ say: 'Hello.' }] });
    const resolution = await resolveLocalModelSource({
      env: { PILOT_LOCAL_BASE_URL: endpoint.baseUrl },
      probe,
    });
    const runtime = createAgentRuntime({
      conversationId: asConversationId('conv-ok'),
      source: resolution.source!,
    });
    expect(runtime.capability.ok).toBe(true);
    await runtime.dispose();
  });

  it('still refuses a development source when nothing is blocked but the gate fails', async () => {
    // Guards the interaction between the two refusal routes: `blockedBy` must
    // not have replaced the capability gate, only joined it.
    const runtime = createAgentRuntime({
      conversationId: asConversationId('conv-gate'),
      source: createDevelopmentModelSource({ fixture: 'faux-text-only' }),
    });
    expect(runtime.capability.ok).toBe(false);
    await runtime.dispose();
  });
});

describe('the context budget for a local endpoint', () => {
  it('believes a smaller loaded context and caps a larger one', async () => {
    const small = await stub({ contextWindow: 8_192 });
    const large = await stub({ contextWindow: 131_072 });
    const silent = await stub();

    const resolve = async (
      endpoint: StubOpenAiEndpoint,
    ): Promise<ReturnType<typeof resolveContextWindow>> => {
      const resolution = await resolveLocalModelSource({
        env: { PILOT_LOCAL_BASE_URL: endpoint.baseUrl },
        probe,
      });
      return resolveContextWindow(contextWindowInputOf(resolution.source!));
    };

    expect(await resolve(small)).toMatchObject({ contextWindow: 8_192, source: 'model' });
    expect(await resolve(large)).toMatchObject({
      contextWindow: CONSERVATIVE_CONTEXT_WINDOW,
      source: 'local-ceiling',
    });
    expect(await resolve(silent)).toMatchObject({
      contextWindow: CONSERVATIVE_CONTEXT_WINDOW,
      source: 'unknown',
      advertised: null,
    });
  });
});
