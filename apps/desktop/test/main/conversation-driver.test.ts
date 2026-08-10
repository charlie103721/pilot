import { describe, expect, it } from 'vitest';
import { asConversationId } from '@pilot/shared';
import { FakeSpeechInputAdapter } from '@pilot/platform/fakes';
import { createScriptedModelSource } from '@pilot/agent';
import { ConversationGate } from '../../src/main/conversation-gate.js';
import { createAgentRuntime } from '../../src/main/agent-runtime.js';
import {
  createLiveConversationDriver,
  DEMO_TYPED_QUESTION,
} from '../../src/main/conversation-driver.js';
import { createInteractionRuntime } from '../../src/main/interaction-runtime.js';
import { testClock } from './support.js';

/**
 * The panel's "Replay" bar, after PR-029.
 *
 * PR-010's replay patched view states onto a fake controller because nothing in
 * that build could cause a conversation. These cases prove the replacement does
 * the real thing: the same commands the panel's buttons send, into the real
 * controller, answered by a real `PiAgentSession`. The provider is faux (there
 * is no model access — `docs/handoff.md` §2) and the recogniser is mocked.
 */

const CONVERSATION = asConversationId('conv-replay-test');

function rig(script: readonly { readonly say: string }[]) {
  const source = createScriptedModelSource({ script, tokensPerSecond: 200 });
  const runtime = createAgentRuntime({ conversationId: CONVERSATION, source });
  const speech = new FakeSpeechInputAdapter();
  const { controller } = createInteractionRuntime({
    agent: runtime.session,
    conversationId: CONVERSATION,
    speechInput: speech,
  });
  const clock = testClock();
  const gate = new ConversationGate({ interaction: controller, now: () => clock.now() });
  const replay = createLiveConversationDriver({ controller, gate, speech });
  return {
    controller,
    gate,
    replay,
    source,
    dispose: async () => {
      gate.dispose();
      await controller.dispose();
      await runtime.dispose();
    },
  };
}

describe('the live conversation replay', () => {
  it('types a question and gets a real streamed answer back', async () => {
    const test = rig([{ say: 'Auto Renew keeps the subscription going. It can be switched off.' }]);

    await test.replay('typed-question');

    const view = test.controller.snapshot();
    expect(view.transcript.map((entry) => entry.role)).toEqual(['user', 'assistant']);
    expect(view.transcript[0]?.text).toBe(DEMO_TYPED_QUESTION);
    expect(view.transcript[1]?.text).toContain('Auto Renew keeps the subscription going');
    expect(view.transcript[1]?.pending).toBe(false);
    expect(view.lastError).toBeNull();
    // The question really did reach a provider request.
    expect(test.source.requestCount()).toBe(1);
    // And the §17 metrics were derived from the real view-state stream, exactly
    // as they will be from a real model.
    const metrics = test.gate.snapshot().telemetry.samples.map((sample) => sample.metric);
    expect(metrics).toContain('time-to-first-token');

    await test.dispose();
  }, 30_000);

  it('speaks a question through the mocked recogniser and submits what it heard', async () => {
    const test = rig([{ say: 'That is the Auto Renew switch.' }]);

    await test.replay('spoken-question');

    const view = test.controller.snapshot();
    // `FakeSpeechInputAdapter`'s first scripted utterance.
    expect(view.transcript[0]?.text).toBe('What is this?');
    expect(view.transcript[1]?.text).toContain('That is the Auto Renew switch.');
    expect(view.lastError).toBeNull();

    await test.dispose();
  }, 30_000);

  it('reports a recogniser failure and leaves the text box as the way out', async () => {
    const test = rig([]);

    await test.replay('stt-failure');

    const view = test.controller.snapshot();
    expect(view.state).toBe('error');
    expect(view.lastError?.code).toBe('speech-input-failed');
    // Nothing was asked of the model: recognition never produced a question.
    expect(test.source.requestCount()).toBe(0);

    await test.dispose();
  }, 30_000);

  it('clears the conversation and the telemetry together', async () => {
    const test = rig([{ say: 'One.' }]);
    await test.replay('typed-question');
    expect(test.controller.snapshot().transcript.length).toBeGreaterThan(0);

    await test.replay('reset');

    expect(test.controller.snapshot().transcript).toHaveLength(0);
    expect(test.gate.snapshot().telemetry.samples).toHaveLength(0);

    await test.dispose();
  }, 30_000);
});
