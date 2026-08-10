import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { asConversationId, PilotError } from '@pilot/shared';
import { probeLocalEndpoint, type LocalEndpointReport } from '../src/local-endpoint.js';
import {
  LOCAL_PROVIDER_ID,
  createLocalModelSource,
  describeLocalModelSource,
  isLocalModelSource,
  localityStatement,
  settingsFromProfile,
  toLocalProfileRecordInput,
} from '../src/local-model-source.js';
import { createDevelopmentModelSource } from '../src/development-model.js';
import { createModelProfileStore } from '../src/profile-store.js';
import { assertSupportsVisualConversation } from '../src/model-profile.js';
import { checkVisualConversation } from '../src/capability.js';
import { PiAgentSession, asSessionTool } from '../src/session.js';
import { createObserveScreenTool } from '../src/observe-screen.js';
import { buildSystemPrompt } from '../src/system-prompt.js';
import { startStubOpenAiEndpoint, type StubOpenAiEndpoint } from '../src/stub-openai-endpoint.js';
import { envelope, observation, scriptedScreenContext } from './support.js';
import type { AgentEvent } from '@pilot/platform';

/**
 * PR-039 — the local profile as a `ModelSource`, and a real Pi run over it.
 *
 * The endpoint is `stub-openai-endpoint.ts` — a fixture, not an inference
 * server. Everything *above* the socket is the code that ships: Pi's own
 * `openai-completions` provider, `Models`, `Agent`, `PiAgentSession`, the
 * capability gate.
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

async function report(endpoint: StubOpenAiEndpoint): Promise<LocalEndpointReport> {
  return probeLocalEndpoint(
    { baseUrl: endpoint.baseUrl, model: endpoint.modelId, timeoutMs: 5_000 },
    { random: () => 0.5 },
  );
}

describe('the local model source', () => {
  it('satisfies the same ModelSource interface the development source does', async () => {
    const endpoint = await stub();
    const source = createLocalModelSource(await report(endpoint));
    const development = createDevelopmentModelSource();

    for (const key of ['profile', 'models', 'model', 'toolSupport', 'description'] as const) {
      expect(source[key], `local source is missing ${key}`).toBeDefined();
      expect(development[key]).toBeDefined();
    }
    expect(typeof source.requestCount).toBe('function');
    expect(source.requestCount()).toBe(0);
    expect(isLocalModelSource(source)).toBe(true);
    expect(isLocalModelSource(development)).toBe(false);
  });

  it('builds a loopback profile whose capabilities came from the probe', async () => {
    const endpoint = await stub({ modelId: 'qwen2.5-vl-7b' });
    const source = createLocalModelSource(await report(endpoint));

    expect(source.profile).toMatchObject({
      provider: LOCAL_PROVIDER_ID,
      model: 'qwen2.5-vl-7b',
      authMode: 'local',
      supportsVision: true,
      supportsTools: true,
      isRemote: false,
    });
    expect(source.profile.baseUrl).toBe(endpoint.baseUrl);
    // The whole point: tool support is a measurement here, not a default.
    expect(source.toolSupport).toBe('verified');
    expect(source.model.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    });
  });

  it('reports tool support as ASSUMED when the probe never got to run', async () => {
    // An endpoint that never answered has shown Pilot nothing, so `false` is
    // right and `verified` would be a lie about a check that did not happen.
    const closed = await closedLoopbackUrl();
    const unreachable = await probeLocalEndpoint({ baseUrl: closed, model: 'anything' });
    const source = createLocalModelSource(unreachable);
    expect(source.report.tools.probed).toBe(false);
    expect(source.profile.supportsTools).toBe(false);
    expect(source.toolSupport).toBe('assumed');
    expect(source.description).toContain('UNUSABLE (endpoint-unreachable)');
  });

  it('says the screen stays on this Mac, in words a user can read', async () => {
    const endpoint = await stub();
    const source = createLocalModelSource(await report(endpoint));
    expect(source.endpoint.isRemote).toBe(false);
    expect(localityStatement(source)).toContain('Nothing about your screen is sent to a company');
    expect(source.description).toContain('this Mac, screen images stay here');
    expect(describeLocalModelSource(source.profile, source.report)).toContain('reachable');
  });

  it('refuses to call a LAN endpoint local, because it is not this Mac', async () => {
    const endpoint = await stub();
    const probed = await report(endpoint);
    // Same probe, rewritten to a network host: the only thing that changes is
    // the address, and the privacy claim must change with it.
    const lan: LocalEndpointReport = {
      ...probed,
      health: {
        ...probed.health,
        baseUrl: 'http://192.168.1.40:8000/v1',
        host: '192.168.1.40',
        loopback: false,
      },
    };
    const source = createLocalModelSource(lan);
    expect(source.profile.isRemote).toBe(true);
    expect(localityStatement(source)).toContain('not this Mac');
    expect(source.description).toContain('screen images leave the machine');
  });
});

describe('the capability gate over a local profile', () => {
  it('refuses a model the endpoint said cannot see, before anything is built', async () => {
    const endpoint = await stub({ behaviour: 'vision-rejected' });
    const source = createLocalModelSource(await report(endpoint));

    expect(source.profile.supportsVision).toBe(false);
    expect(source.model.input).toEqual(['text']);
    const decision = checkVisualConversation(source.profile, { toolSupport: source.toolSupport });
    expect(decision.ok).toBe(false);
    expect(() => assertSupportsVisualConversation(source.profile)).toThrow(PilotError);
  });

  it('refuses a model that ignored the tool probe', async () => {
    const endpoint = await stub({ behaviour: 'tools-ignored' });
    const source = createLocalModelSource(await report(endpoint));
    expect(source.profile.supportsTools).toBe(false);
    expect(checkVisualConversation(source.profile).ok).toBe(false);
  });

  it('sends no screen data at all when the gate refuses', async () => {
    const endpoint = await stub({ behaviour: 'vision-blind' });
    const source = createLocalModelSource(await report(endpoint));

    expect(() => {
      new PiAgentSession({
        conversationId: asConversationId('conv-local-refused'),
        profile: source.profile,
        models: source.models,
        model: source.model,
        toolSupport: source.toolSupport,
        systemPrompt: buildSystemPrompt(),
      });
    }).toThrow(PilotError);

    // The probe's swatch and nothing else. No streamed request was ever made.
    expect(source.requestCount()).toBe(0);
    expect(endpoint.requests.some((entry) => entry.streamed)).toBe(false);
    const bytes = endpoint.requests.reduce((sum, entry) => sum + entry.imageBytes, 0);
    expect(bytes).toBe(source.report.probeImageBytes);
    expect(bytes).toBeLessThan(200);
  });
});

describe('a real Pi run against a local OpenAI-compatible endpoint', () => {
  it('streams an answer through Pi’s own openai-completions provider', async () => {
    const endpoint = await stub({
      script: [{ say: 'That switch turns on automatic renewal for your plan.' }],
    });
    const source = createLocalModelSource(await report(endpoint));
    const session = new PiAgentSession({
      conversationId: asConversationId('conv-local-run'),
      profile: source.profile,
      models: source.models,
      model: source.model,
      toolSupport: source.toolSupport,
      systemPrompt: buildSystemPrompt(),
    });
    const events: AgentEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    const handle = await session.submit(envelope({ transcript: 'What does this switch do?' }));
    await handle.completed;

    const kinds = events.map((event) => event.type);
    expect(kinds).toContain('run-started');
    expect(kinds).toContain('text-delta');
    expect(kinds).toContain('run-completed');
    const deltas = events
      .filter(
        (event): event is Extract<typeof event, { type: 'text-delta' }> =>
          event.type === 'text-delta',
      )
      .map((event) => event.text)
      .join('');
    expect(deltas).toContain('automatic renewal');
    // More than one delta: the answer really was streamed, not delivered whole.
    expect(kinds.filter((kind) => kind === 'text-delta').length).toBeGreaterThan(1);
    expect(source.requestCount()).toBe(1);

    const streamed = endpoint.requests.filter((entry) => entry.streamed);
    expect(streamed).toHaveLength(1);
    expect(streamed[0]?.body?.['model']).toBe(endpoint.modelId);
    await session.dispose();
  });

  it('carries an observe_screen tool call and its image over the wire', async () => {
    const endpoint = await stub({
      script: [
        { tool: { name: 'observe_screen', arguments: { view: 'pointer', moment: 'question' } } },
        { say: 'It turns automatic renewal on.' },
      ],
    });
    const source = createLocalModelSource(await report(endpoint));
    const screenContext = scriptedScreenContext([observation()]);
    const session = new PiAgentSession({
      conversationId: asConversationId('conv-local-tool'),
      profile: source.profile,
      models: source.models,
      model: source.model,
      toolSupport: source.toolSupport,
      systemPrompt: buildSystemPrompt(),
      tools: [asSessionTool(createObserveScreenTool({ screenContext }))],
    });
    const events: AgentEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    await (
      await session.submit(envelope({ transcript: 'What is this?' }))
    ).completed;

    const kinds = events.map((event) => event.type);
    expect(kinds).toContain('tool-started');
    expect(kinds).toContain('tool-succeeded');
    expect(kinds).toContain('run-completed');
    expect(screenContext.requests).toHaveLength(1);

    // The screen image reached the endpoint only on the SECOND streamed
    // request — the one after the model asked for it. The first carried none.
    const streamed = endpoint.requests.filter((entry) => entry.streamed);
    expect(streamed.map((entry) => entry.imageBytes > 0)).toEqual([false, true]);
    await session.dispose();
  });

  it('counts provider requests so “nothing was sent” is a number, not a claim', async () => {
    const endpoint = await stub({ script: [{ say: 'One.' }, { say: 'Two.' }] });
    const source = createLocalModelSource(await report(endpoint));
    const session = new PiAgentSession({
      conversationId: asConversationId('conv-local-count'),
      profile: source.profile,
      models: source.models,
      model: source.model,
      toolSupport: source.toolSupport,
      systemPrompt: buildSystemPrompt(),
    });
    expect(source.requestCount()).toBe(0);
    await (
      await session.submit(envelope({ transcript: 'First?' }))
    ).completed;
    expect(source.requestCount()).toBe(1);
    await (
      await session.submit(envelope({ transcript: 'Second?' }))
    ).completed;
    expect(source.requestCount()).toBe(2);
    await session.dispose();
  });
});

describe('the context window a local endpoint reports', () => {
  it('passes a measured, loaded context straight through as the advertised number', async () => {
    const endpoint = await stub({ contextWindow: 8_192 });
    const source = createLocalModelSource(await report(endpoint));
    expect(source.measuredContextWindow).toBe(8_192);
    expect(source.model.contextWindow).toBe(8_192);
  });

  it('advertises nothing — literally zero — when the endpoint reported nothing', async () => {
    const endpoint = await stub();
    const source = createLocalModelSource(await report(endpoint));
    expect(source.measuredContextWindow).toBeNull();
    // `resolveContextWindow` reads a non-positive advertised window as
    // `unknown` and answers with its conservative ceiling. That is the truth:
    // the endpoint said nothing.
    expect(source.model.contextWindow).toBe(0);
  });
});

describe('persisting a local profile', () => {
  it('stores the base URL and a credential reference, never a key', async () => {
    const endpoint = await stub();
    const source = createLocalModelSource(await report(endpoint), {
      apiKey: 'sk-not-a-real-key-123456789',
    });
    const store = createModelProfileStore();
    const record = await store.save(toLocalProfileRecordInput(source));

    expect(record.credentialRef).toBe(LOCAL_PROVIDER_ID);
    expect(record.toolSupport).toBe('verified');
    const serialized = await store.serialize();
    expect(serialized).toContain(endpoint.baseUrl);
    expect(serialized).not.toContain('sk-not-a-real-key-123456789');
  });

  it('round-trips settings out of a stored profile', async () => {
    const endpoint = await stub();
    const source = createLocalModelSource(await report(endpoint));
    const settings = settingsFromProfile(source.profile);
    expect(settings).toEqual({ baseUrl: endpoint.baseUrl, model: endpoint.modelId });
    // An api-key profile is not a local endpoint, whatever its base URL says.
    expect(settingsFromProfile({ ...source.profile, authMode: 'api-key' })).toBeNull();
  });
});
