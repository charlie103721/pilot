import { describe, expect, it } from 'vitest';
import {
  Agent,
  AgentHarness,
  DEFAULT_COMPACTION_SETTINGS,
  HarnessNotImplemented,
  InMemorySessionRepo,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type AgentEvent as PiAgentEvent,
  type AgentTool,
  type Entry,
} from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import {
  createFauxHarness,
  fauxAssistantMessage,
  fauxToolCall,
  PNG_1PX_BASE64,
} from './support.js';

/**
 * Facts about `@earendil-works/pi-agent-core@0.84.1` that `docs/pi-notes.md`
 * asserts. If Pi is bumped and any of these change, this file fails and the
 * notes must be rewritten before product code moves.
 *
 * Everything here runs against Pi's built-in faux provider: no network, no
 * credentials.
 */

const echoTool: AgentTool<ReturnType<typeof Type.Object>> = {
  name: 'observe_screen',
  label: 'Observe screen',
  description: 'Return a fixture observation.',
  parameters: Type.Object({ reason: Type.String() }),
  execute: async (_id, params) => ({
    content: [
      { type: 'text', text: `observed: ${String((params as { reason: string }).reason)}` },
      { type: 'image', data: PNG_1PX_BASE64, mimeType: 'image/png' },
    ],
    details: { sceneId: 'scene-17' },
  }),
};

function newAgent(
  tools: AgentTool<never>[] = [],
  harnessOptions: { readonly tokensPerSecond?: number } = {},
): {
  agent: Agent;
  harness: ReturnType<typeof createFauxHarness>;
  events: PiAgentEvent[];
} {
  const harness = createFauxHarness(harnessOptions);
  const events: PiAgentEvent[] = [];
  const agent = new Agent({
    streamFn: (model, context, options) => harness.models.streamSimple(model, context, options),
    initialState: { systemPrompt: 'sys', model: harness.model, tools },
  });
  agent.subscribe((event) => {
    events.push(event);
  });
  return { agent, harness, events };
}

describe('Pi session creation and streaming', () => {
  it('streams text deltas and completes with stopReason "stop"', async () => {
    const { agent, harness, events } = newAgent();
    harness.setResponses([fauxAssistantMessage('hello there', { stopReason: 'stop' })]);

    await agent.prompt('hi');
    await agent.waitForIdle();

    expect(events.map((event) => event.type)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_end',
      'message_start',
      ...events
        .filter((event) => event.type === 'message_update')
        .map(() => 'message_update' as const),
      'message_end',
      'turn_end',
      'agent_end',
    ]);

    const deltas = events.flatMap((event) =>
      event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta'
        ? [event.assistantMessageEvent.delta]
        : [],
    );
    expect(deltas.join('')).toBe('hello there');

    const last = agent.state.messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', stopReason: 'stop' });
  });

  it('rejects a second concurrent prompt instead of queueing it', async () => {
    const { agent, harness } = newAgent();
    harness.setResponses([
      fauxAssistantMessage('one', { stopReason: 'stop' }),
      fauxAssistantMessage('two', { stopReason: 'stop' }),
    ]);

    const first = agent.prompt('a');
    await expect(agent.prompt('b')).rejects.toThrow(/already processing a prompt/i);
    await first;
    await agent.waitForIdle();
  });
});

describe('Pi typed tools and image tool results', () => {
  it('validates arguments, runs the tool, and puts an image block on the transcript', async () => {
    const { agent, harness, events } = newAgent([echoTool as unknown as AgentTool<never>]);
    harness.setResponses([
      fauxAssistantMessage([fauxToolCall('observe_screen', { reason: 'need pixels' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('The toggle is on.', { stopReason: 'stop' }),
    ]);

    await agent.prompt('what is this?');
    await agent.waitForIdle();

    const started = events.find((event) => event.type === 'tool_execution_start');
    const ended = events.find((event) => event.type === 'tool_execution_end');
    expect(started).toMatchObject({ toolName: 'observe_screen', args: { reason: 'need pixels' } });
    expect(ended).toMatchObject({ toolName: 'observe_screen', isError: false });

    const toolResult = agent.state.messages.find((message) => message.role === 'toolResult');
    expect(toolResult?.content).toEqual([
      { type: 'text', text: 'observed: need pixels' },
      // VERIFIED image tool-result shape: bare base64 in `data`, no data: URI.
      { type: 'image', data: PNG_1PX_BASE64, mimeType: 'image/png' },
    ]);
    expect(toolResult?.details).toEqual({ sceneId: 'scene-17' });
  });

  it('turns a thrown tool error into an error tool result and keeps the loop alive', async () => {
    const failing: AgentTool<ReturnType<typeof Type.Object>> = {
      name: 'observe_screen',
      label: 'Observe screen',
      description: 'always fails',
      parameters: Type.Object({}),
      execute: async () => {
        throw new Error('window closed');
      },
    };
    const { agent, harness, events } = newAgent([failing as unknown as AgentTool<never>]);
    harness.setResponses([
      fauxAssistantMessage([fauxToolCall('observe_screen', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('I could not look.', { stopReason: 'stop' }),
    ]);

    await agent.prompt('look');
    await agent.waitForIdle();

    const ended = events.find((event) => event.type === 'tool_execution_end');
    expect(ended).toMatchObject({ isError: true });
    const toolResult = agent.state.messages.find((message) => message.role === 'toolResult');
    expect(toolResult).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'window closed' }],
    });
    expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: 'stop' });
  });
});

describe('Pi abort and steer', () => {
  it('abort() produces stopReason "aborted" and no dedicated abort event', async () => {
    // Throttled so the abort lands mid-stream deterministically.
    const { agent, harness, events } = newAgent([], { tokensPerSecond: 20 });
    harness.setResponses([fauxAssistantMessage('a '.repeat(500), { stopReason: 'stop' })]);

    const run = agent.prompt('go');
    setTimeout(() => {
      agent.abort();
    }, 20);
    await run;
    await agent.waitForIdle();

    expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: 'aborted' });
    expect(agent.state.errorMessage).toMatch(/abort/i);
    // There is no `agent_abort` / `run_aborted` event to listen for.
    expect(events.map((event) => event.type)).not.toContain('agent_abort');
  });

  it('abort() during tool execution aborts the tool through its AbortSignal', async () => {
    let sawSignal = false;
    const slow: AgentTool<ReturnType<typeof Type.Object>> = {
      name: 'slow',
      label: 'slow',
      description: 'slow',
      parameters: Type.Object({}),
      execute: (_id, _params, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            sawSignal = true;
            reject(new Error('aborted by signal'));
          });
        }),
    };
    const { agent, harness } = newAgent([slow as unknown as AgentTool<never>]);
    harness.setResponses([
      fauxAssistantMessage([fauxToolCall('slow', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('unused', { stopReason: 'stop' }),
    ]);

    const run = agent.prompt('go');
    setTimeout(() => {
      agent.abort();
    }, 20);
    await run;
    await agent.waitForIdle();

    expect(sawSignal).toBe(true);
    expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: 'error' });
  });

  it('steer() injects a user message that the run continues from', async () => {
    const noop: AgentTool<ReturnType<typeof Type.Object>> = {
      name: 'noop',
      label: 'noop',
      description: 'noop',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: null }),
    };
    const { agent, harness } = newAgent([noop as unknown as AgentTool<never>]);
    harness.setResponses([
      fauxAssistantMessage([fauxToolCall('noop', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('answered the new question', { stopReason: 'stop' }),
    ]);

    const run = agent.prompt('first question');
    agent.steer({ role: 'user', content: 'actually, this instead', timestamp: Date.now() });
    await run;
    await agent.waitForIdle();

    const userTexts = agent.state.messages
      .filter((message) => message.role === 'user')
      .map((message) =>
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      );
    expect(userTexts.some((text) => text.includes('actually, this instead'))).toBe(true);
    expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: 'stop' });
  });
});

describe('Pi context transformation', () => {
  it('transformContext changes what the provider sees without mutating the transcript', async () => {
    const harness = createFauxHarness();
    const agent = new Agent({
      streamFn: (model, context, options) => harness.models.streamSimple(model, context, options),
      initialState: { systemPrompt: 'sys', model: harness.model, tools: [] },
      transformContext: async (messages) =>
        messages.map((message) => {
          const content: unknown = 'content' in message ? message.content : undefined;
          if (!Array.isArray(content)) {
            return message;
          }
          return {
            ...message,
            content: (content as { type: string }[]).map((block) =>
              block.type === 'image' ? { type: 'text' as const, text: '[removed]' } : block,
            ),
          } as typeof message;
        }),
    });
    harness.setResponses([fauxAssistantMessage('ok', { stopReason: 'stop' })]);
    agent.state.messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', data: PNG_1PX_BASE64, mimeType: 'image/png' },
        ],
        timestamp: Date.now(),
      },
    ];

    await agent.continue();
    await agent.waitForIdle();

    const sent = JSON.stringify(harness.seenContexts.at(-1));
    expect(sent).not.toContain(PNG_1PX_BASE64);
    expect(sent).toContain('[removed]');
    // The agent's own transcript is untouched — the image is still available
    // to the app for a later turn.
    expect(JSON.stringify(agent.state.messages)).toContain(PNG_1PX_BASE64);
  });
});

describe('Pi compaction primitives', () => {
  it('exposes local, pure threshold helpers that need no provider call', () => {
    const messages = [
      { role: 'user' as const, content: 'hello '.repeat(200), timestamp: 1 },
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'hi' }],
        api: 'faux',
        provider: 'pilot-faux',
        model: 'faux-model',
        usage: {
          input: 5000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop' as const,
        timestamp: 2,
      },
    ];

    expect(estimateContextTokens(messages).tokens).toBe(5100);
    expect(DEFAULT_COMPACTION_SETTINGS).toMatchObject({ enabled: true });
    expect(shouldCompact(5100, 8000, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
    expect(shouldCompact(1000, 128000, DEFAULT_COMPACTION_SETTINGS)).toBe(false);

    const entries: Entry[] = messages.map((message, index) => ({
      type: 'message',
      id: `e${String(index)}`,
      seq: index,
      parentId: index === 0 ? null : `e${String(index - 1)}`,
      timestamp: index,
      message,
    }));
    const prepared = prepareCompaction(entries, {
      ...DEFAULT_COMPACTION_SETTINGS,
      keepRecentTokens: 10,
    });
    expect(prepared.ok).toBe(true);
  });
});

describe('Pi AgentHarness (the durable, session-backed API)', () => {
  it('is a stub in 0.84.1: create() succeeds but every operation throws', async () => {
    const harness = createFauxHarness();
    const session = await new InMemorySessionRepo().create({});
    const created = await AgentHarness.create({
      session,
      models: harness.models,
      model: harness.model,
    });

    expect(created.suspended).toEqual([]);
    await expect(created.harness.prompt('hello')).rejects.toBeInstanceOf(HarnessNotImplemented);
    await expect(created.harness.compact()).rejects.toBeInstanceOf(HarnessNotImplemented);
    await expect(created.harness.abort()).rejects.toBeInstanceOf(HarnessNotImplemented);
    await expect(created.harness.waitForIdle()).rejects.toBeInstanceOf(HarnessNotImplemented);
  });
});
