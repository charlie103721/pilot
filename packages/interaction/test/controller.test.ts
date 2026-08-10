import { describe, expect, it } from 'vitest';
import {
  asConversationId,
  createCounterIdSource,
  createIdFactory,
  type ObservedWindow,
  type RunId,
} from '@pilot/shared';
import {
  FIXTURE_PERMISSIONS_GRANTED,
  FIXTURE_WINDOWS,
  FIXTURE_WINDOW_RETINA,
  FakeAgentSession,
  FakeSpeechInputAdapter,
  FakeSpeechOutputAdapter,
  createFakeClock,
} from '@pilot/platform/fakes';
import type { PilotViewState } from '@pilot/platform';
import {
  FakeQuestionEnvelopeFactory,
  PilotInteractionController,
  RecordingObservationPort,
} from '@pilot/interaction';

const WINDOW: ObservedWindow = FIXTURE_WINDOW_RETINA;

function createController(options: { readonly agentMode?: 'auto' | 'manual' } = {}) {
  const clock = createFakeClock();
  const ids = createIdFactory(createCounterIdSource());
  const conversationId = asConversationId('conv-test');
  const speechInput = new FakeSpeechInputAdapter({
    script: [
      { partials: ['what', 'what is'], final: 'What is this?' },
      { partials: ['and what'], final: 'And what happens if I turn it off?' },
    ],
  });
  const speechOutput = new FakeSpeechOutputAdapter();
  const agent = new FakeAgentSession({
    conversationId,
    mode: options.agentMode ?? 'manual',
    script: [
      { toolCalls: [{ name: 'observe_screen' }], deltas: ['That is the Auto Renew toggle.'] },
      { deltas: ['It renews the plan each month.'] },
    ],
  });
  const observation = new RecordingObservationPort();
  const envelopes = new FakeQuestionEnvelopeFactory();
  const controller = new PilotInteractionController({
    clock,
    ids,
    conversationId,
    speechInput,
    speechOutput,
    agent,
    envelopes,
    observation,
    permissions: FIXTURE_PERMISSIONS_GRANTED,
    windows: FIXTURE_WINDOWS,
  });
  const views: PilotViewState[] = [];
  controller.subscribe((view) => views.push(view));
  const runIds: RunId[] = [];
  agent.subscribe((event) => {
    if (event.type === 'run-started') {
      runIds.push(event.runId);
    }
  });
  return {
    controller,
    clock,
    speechInput,
    speechOutput,
    agent,
    observation,
    envelopes,
    views,
    runIds,
  };
}

describe('PilotInteractionController', () => {
  it('runs a whole spoken turn against the fakes', async () => {
    const harness = createController();
    const { controller, agent, speechOutput, envelopes, observation } = harness;

    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    await controller.settled();
    expect(controller.snapshot().state).toBe('observing');
    expect(observation.callTypes).toEqual(['stop', 'clear', 'start']);

    controller.dispatch({ type: 'push-to-talk-down' });
    await controller.settled();
    expect(controller.snapshot().state).toBe('listening');

    controller.dispatch({ type: 'push-to-talk-up' });
    await controller.settled();
    // The fake recogniser finalised, so the question is already with the agent.
    expect(controller.snapshot().state).toBe('thinking');
    expect(envelopes.requests.map((request) => request.transcript)).toEqual(['What is this?']);
    expect(envelopes.requests[0]?.selectedWindow?.windowId).toBe(WINDOW.windowId);

    agent.step();
    await controller.settled();
    expect(controller.snapshot().state).toBe('speaking');
    expect(speechOutput.spokenText).toBe('That is the Auto Renew toggle.');

    speechOutput.finish();
    await controller.settled();
    expect(controller.snapshot().state).toBe('observing');
    expect(controller.snapshot().transcript.map((entry) => entry.role)).toEqual([
      'user',
      'assistant',
    ]);
    await controller.dispose();
  });

  it('passes through observing-screen while the model uses the screen tool', async () => {
    const harness = createController();
    const { controller, agent } = harness;
    const states: string[] = [];
    controller.subscribe((view) => {
      if (states[states.length - 1] !== view.state) {
        states.push(view.state);
      }
    });

    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'push-to-talk-down' });
    controller.dispatch({ type: 'push-to-talk-up' });
    await controller.settled();
    agent.step();
    await controller.settled();

    expect(states).toEqual([
      'observing',
      'listening',
      'transcribing',
      'thinking',
      'observing-screen',
      'thinking',
      'speaking',
    ]);
    await controller.dispose();
  });

  it('performs interruption effects in order and drops the old run', async () => {
    const harness = createController();
    const { controller, agent, speechInput, speechOutput, runIds } = harness;

    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'push-to-talk-down' });
    controller.dispatch({ type: 'push-to-talk-up' });
    await controller.settled();
    agent.step();
    await controller.settled();
    expect(controller.snapshot().state).toBe('speaking');
    const supersededRun = runIds[0]!;
    const spokenBefore = speechOutput.spokenText;

    const outcome = controller.send({ type: 'push-to-talk-down' });
    expect(outcome.kind).toBe('accepted');
    if (outcome.kind === 'accepted') {
      expect(outcome.effects.map((effect) => effect.type)).toEqual([
        'stop-speech',
        'interrupt-run',
        'start-listening',
      ]);
    }
    await controller.settled();

    expect(speechOutput.stopCalls).toHaveLength(1);
    expect(agent.interrupts).toEqual([{ mode: 'abort', reason: 'superseded by a new question' }]);
    expect(speechInput.started).toHaveLength(2);
    expect(controller.snapshot().state).toBe('listening');

    // A late event from the superseded run cannot add to the answer.
    const late = controller.send({
      type: 'run-text-delta',
      runId: supersededRun,
      text: ' and one more thing',
    });
    expect(late.kind === 'rejected' && late.rejection.reason).toBe('stale-run');
    expect(speechOutput.spokenText).toBe(spokenBefore);
    await controller.dispose();
  });

  it('reports adapter failures as an error state instead of throwing', async () => {
    const clock = createFakeClock();
    const ids = createIdFactory(createCounterIdSource());
    const conversationId = asConversationId('conv-fail');
    const controller = new PilotInteractionController({
      clock,
      ids,
      conversationId,
      speechInput: new FakeSpeechInputAdapter({
        availability: { available: false, onDevice: false },
      }),
      speechOutput: new FakeSpeechOutputAdapter(),
      agent: new FakeAgentSession({ conversationId, mode: 'manual' }),
      envelopes: new FakeQuestionEnvelopeFactory(),
      observation: new RecordingObservationPort(),
      permissions: FIXTURE_PERMISSIONS_GRANTED,
      windows: FIXTURE_WINDOWS,
    });

    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'push-to-talk-down' });
    await controller.settled();

    expect(controller.snapshot().state).toBe('error');
    expect(controller.snapshot().lastError?.code).toBe('speech-unavailable');
    await controller.dispose();
  });

  it('refuses everything once disposed', async () => {
    const { controller } = createController();
    await controller.dispose();
    const outcome = controller.send({ type: 'push-to-talk-down' });
    expect(outcome.kind === 'rejected' && outcome.rejection.reason).toBe('disposed');
  });

  it('publishes a view state only when something visible changed', async () => {
    const { controller, views } = createController();
    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    await controller.settled();
    const emitted = views.length;
    // A discarded stale result changes nothing the renderer can see.
    controller.send({ type: 'run-completed', runId: 'run-ghost' as RunId, text: 'ignored' });
    expect(views).toHaveLength(emitted);
    await controller.dispose();
  });

  it('asks the agent session to forget when the conversation is cleared', async () => {
    // PR-036, runbook follow-up 21. The `clear-conversation` effect was a
    // comment until PR-036: the table emptied the machine's own transcript and
    // minted a new conversation id, and the model went on holding every turn.
    const harness = createController({ agentMode: 'auto' });
    const { controller, agent } = harness;
    const cleared: string[] = [];
    // `AgentSession.clearConversation?` is optional (system-design §13), so a
    // session that implements it is the interesting case and a session that
    // does not is the one below.
    const withClear = agent as typeof agent & { clearConversation?: () => Promise<void> };
    withClear.clearConversation = async (): Promise<void> => {
      cleared.push('cleared');
    };

    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'submit-text', text: 'what is this?' });
    await controller.settled();
    expect(controller.snapshot().transcript.length).toBeGreaterThan(0);

    controller.dispatch({ type: 'clear-conversation' });
    await controller.settled();

    expect(cleared).toEqual(['cleared']);
    expect(controller.snapshot().transcript).toEqual([]);
    expect(controller.snapshot().lastError).toBeNull();
    await controller.dispose();
  });

  it('clears without an agent that can forget, because the member is optional', async () => {
    // `FakeAgentSession` does not implement `clearConversation`. The command
    // must still empty the panel rather than fail the turn — the whole reason
    // the facade member is optional.
    const harness = createController({ agentMode: 'auto' });
    const { controller } = harness;

    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'submit-text', text: 'what is this?' });
    await controller.settled();

    controller.dispatch({ type: 'clear-conversation' });
    await controller.settled();

    expect(controller.snapshot().transcript).toEqual([]);
    expect(controller.snapshot().lastError).toBeNull();
    await controller.dispose();
  });

  it('supports the typed text fallback without any speech adapter involvement', async () => {
    const harness = createController({ agentMode: 'auto' });
    const { controller, speechInput, speechOutput } = harness;

    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'submit-text', text: 'what is this?' });
    await controller.settled();

    expect(speechInput.started).toHaveLength(0);
    expect(controller.snapshot().state).toBe('speaking');
    expect(speechOutput.spokenText).toBe('That is the Auto Renew toggle.');
    await controller.dispose();
  });
});
