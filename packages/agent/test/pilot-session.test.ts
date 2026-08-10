import { describe, expect, it } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { asConversationId, PilotError, type ModelProfile } from '@pilot/shared';
import type { AgentEvent } from '@pilot/platform';
import {
  PiAgentSession,
  buildSystemPrompt,
  createObserveScreenTool,
  createSanitisingTranscriptSink,
  describeObservation,
  renderQuestionEnvelope,
  toModelProfile,
} from '../src/index.js';
import {
  createFauxHarness,
  envelope,
  FAUX_PROFILE,
  fakeScreenContext,
  fauxAssistantMessage,
  fauxToolCall,
  observation,
  PNG_1PX_BASE64,
} from './support.js';

function newSession(options: {
  readonly profile?: ModelProfile;
  readonly tools?: AgentTool<never>[];
  readonly transcript?: { append(message: unknown): Promise<void> };
  readonly tokensPerSecond?: number;
}): {
  session: PiAgentSession;
  harness: ReturnType<typeof createFauxHarness>;
  events: AgentEvent[];
} {
  const harness = createFauxHarness(
    options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond },
  );
  const session = new PiAgentSession({
    conversationId: asConversationId('conv-1'),
    profile: options.profile ?? FAUX_PROFILE,
    models: harness.models,
    model: harness.model,
    systemPrompt: buildSystemPrompt(),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.transcript === undefined ? {} : { transcript: options.transcript as never }),
  });
  const events: AgentEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
  });
  return { session, harness, events };
}

describe('PiAgentSession', () => {
  it('maps a full observe_screen round trip onto Pilot events', async () => {
    const screen = fakeScreenContext(observation());
    const tool = createObserveScreenTool({ screenContext: screen });
    const { session, harness, events } = newSession({
      tools: [tool as unknown as AgentTool<never>],
    });
    harness.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('observe_screen', { view: 'pointer', moment: 'question' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('It renews your plan automatically.', { stopReason: 'stop' }),
    ]);

    const run = await session.submit(envelope());
    await run.completed;

    expect(events.map((event) => event.type)).toEqual([
      'run-started',
      'tool-started',
      // PR-021: the tool reports "looking at the window" through Pi's
      // `onUpdate`, which becomes `tool_execution_update` → `tool-progress`.
      'tool-progress',
      'tool-succeeded',
      ...events.filter((event) => event.type === 'text-delta').map(() => 'text-delta' as const),
      'run-completed',
    ]);
    expect(events[0]).toMatchObject({ type: 'run-started', utteranceId: 'utt-1' });
    expect(events.at(-1)).toMatchObject({
      type: 'run-completed',
      text: 'It renews your plan automatically.',
    });
    expect(screen.requests).toEqual([{ view: 'pointer', moment: 'question' }]);

    // The image reached the model context, as a Pi image content block.
    const toolResult = session.messages.find((message) => message.role === 'toolResult');
    expect(toolResult?.content).toContainEqual({
      type: 'image',
      data: PNG_1PX_BASE64,
      mimeType: 'image/png',
    });
  });

  it('reports a failing tool as tool-failed and still completes the run', async () => {
    const screen = fakeScreenContext(new PilotError('observation-paused', 'Observation is paused'));
    const tool = createObserveScreenTool({ screenContext: screen });
    const { session, harness, events } = newSession({
      tools: [tool as unknown as AgentTool<never>],
    });
    harness.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('observe_screen', { view: 'window', moment: 'current' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('I cannot see your screen right now.', { stopReason: 'stop' }),
    ]);

    await (
      await session.submit(envelope())
    ).completed;

    const failed = events.find((event) => event.type === 'tool-failed');
    expect(failed).toMatchObject({ toolName: 'observe_screen' });
    expect(failed?.type === 'tool-failed' && failed.error.message).toContain(
      'Observation is paused',
    );
    expect(events.at(-1)?.type).toBe('run-completed');
  });

  it('rejects a second submit while a run is active', async () => {
    const { session, harness } = newSession({});
    harness.setResponses([
      fauxAssistantMessage('one', { stopReason: 'stop' }),
      fauxAssistantMessage('two', { stopReason: 'stop' }),
    ]);

    const run = await session.submit(envelope());
    await expect(session.submit(envelope())).rejects.toMatchObject({
      code: 'run-already-active',
    });
    await run.completed;
  });

  /**
   * Regression, found by PR-022a's repeated-observation demo. `agent_end` fires
   * before `Agent.prompt()` unwinds, so `completed` used to resolve a tick
   * before Pi was ready — and the obvious sequential loop below failed on the
   * second question with "Agent is already processing a prompt", and on every
   * question after it. Three turns, because two would pass even if only the
   * first hand-off were fixed.
   */
  it('accepts the next question as soon as the previous run completes', async () => {
    const { session, harness, events } = newSession({});
    harness.setResponses([
      fauxAssistantMessage('one', { stopReason: 'stop' }),
      fauxAssistantMessage('two', { stopReason: 'stop' }),
      fauxAssistantMessage('three', { stopReason: 'stop' }),
    ]);

    for (let turn = 0; turn < 3; turn += 1) {
      await (
        await session.submit(envelope())
      ).completed;
    }

    expect(events.filter((event) => event.type === 'run-failed')).toEqual([]);
    expect(events.flatMap((event) => (event.type === 'run-completed' ? [event.text] : []))).toEqual(
      ['one', 'two', 'three'],
    );
  });

  it('interrupt("abort") ends the run with run-aborted', async () => {
    const { session, harness, events } = newSession({ tokensPerSecond: 20 });
    harness.setResponses([fauxAssistantMessage('a '.repeat(500), { stopReason: 'stop' })]);

    const run = await session.submit(envelope());
    setTimeout(() => {
      void session.interrupt('abort', 'user pressed escape');
    }, 20);
    await run.completed;

    expect(events.at(-1)?.type).toBe('run-aborted');
  });

  it('refuses to construct a session for a profile without vision or tools', () => {
    const blind: ModelProfile = { ...FAUX_PROFILE, supportsVision: false };
    expect(() => newSession({ profile: blind })).toThrow(
      expect.objectContaining({ code: 'unsupported-capability' }),
    );
  });

  it('persists text but never image bytes through the sanitising sink', async () => {
    const persisted: unknown[] = [];
    const sink = createSanitisingTranscriptSink({
      append: async (message) => {
        persisted.push(message);
      },
    });
    const screen = fakeScreenContext(observation());
    const tool = createObserveScreenTool({ screenContext: screen });
    const { session, harness } = newSession({
      tools: [tool as unknown as AgentTool<never>],
      transcript: sink,
    });
    harness.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('observe_screen', { view: 'pointer', moment: 'question' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Done.', { stopReason: 'stop' }),
    ]);

    await (
      await session.submit(envelope())
    ).completed;

    expect(persisted.length).toBeGreaterThan(0);
    const dump = JSON.stringify(persisted);
    expect(dump).not.toContain(PNG_1PX_BASE64);
    expect(dump).toContain('[image withheld: image/png');
    // …while the live model context still had the pixels.
    expect(JSON.stringify(session.messages)).toContain(PNG_1PX_BASE64);
  });
});

describe('envelope and observation rendering', () => {
  it('includes scene revision and pointer target in the user turn', () => {
    const text = renderQuestionEnvelope(envelope());
    expect(text).toContain('What does this toggle do?');
    expect(text).toContain('scene: scene-17 revision 4');
    expect(text).toContain('last observed revision: 3');
    expect(text).toContain('Auto Renew');
  });

  it('tells the model plainly when the pointer was outside the window', () => {
    const text = describeObservation(observation({ pointer: { x: 1.4, y: -0.2 } }), {
      view: 'pointer',
      moment: 'question',
    });
    expect(text).toContain('outside the selected window');
    expect(text).not.toMatch(/pointer target:/);
  });
});

describe('toModelProfile', () => {
  it('derives vision from Pi model metadata and locality from the base URL', () => {
    const harness = createFauxHarness();
    const profile = toModelProfile(harness.model, { id: 'profile-1', authMode: 'local' });
    expect(profile).toMatchObject({
      provider: 'pilot-faux',
      model: 'faux-model',
      supportsVision: true,
      isRemote: false,
      // Not derivable from Pi — defaulted, and documented as such.
      supportsTools: true,
    });
  });

  it('reports a text-only model as lacking vision', () => {
    const harness = createFauxHarness({ vision: false });
    expect(
      toModelProfile(harness.model, { id: 'profile-2', authMode: 'api-key' }).supportsVision,
    ).toBe(false);
  });
});
