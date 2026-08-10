import { describe, expect, it } from 'vitest';
import { asConversationId, createCounterIdSource, createIdFactory } from '@pilot/shared';
import {
  FIXTURE_PERMISSIONS_GRANTED,
  FIXTURE_WINDOWS,
  FIXTURE_WINDOW_RETINA,
  FakeAgentSession,
  FakeSpeechInputAdapter,
  FakeSpeechOutputAdapter,
  createFakeClock,
} from '@pilot/platform/fakes';
import {
  FakeQuestionAnchorSource,
  PilotInteractionController,
  PilotQuestionEnvelopeFactory,
  RecordingObservationPort,
  recordPointerPath,
} from '@pilot/interaction';

/**
 * The seam PR-006 left, now closed.
 *
 * The machine still decides only *when* a question is submitted; what it hands
 * the factory is the pair of timestamps system-design §6 says the interaction
 * controller records. These tests prove the real factory receives the utterance
 * interval from the machine's injected clock — not from a wall clock read when
 * the effect queue happened to drain.
 */

const PTT_DOWN_AT = 1_760_000_000_050;
const PTT_UP_AT = 1_760_000_000_150;

function createController() {
  const clock = createFakeClock();
  const conversationId = asConversationId('conv-wiring');
  const speechInput = new FakeSpeechInputAdapter({
    script: [{ partials: ['what'], final: 'What is this?' }],
  });
  const agent = new FakeAgentSession({ conversationId, mode: 'manual', script: [{ deltas: [] }] });
  // Samples cover the whole window and continue after it, so anchoring has to
  // choose rather than fall back.
  const anchors = new FakeQuestionAnchorSource({
    samples: recordPointerPath({
      startedAt: PTT_DOWN_AT,
      durationMs: 400,
      hz: 20,
    }),
  });
  const controller = new PilotInteractionController({
    clock,
    ids: createIdFactory(createCounterIdSource()),
    conversationId,
    speechInput,
    speechOutput: new FakeSpeechOutputAdapter(),
    agent,
    envelopes: new PilotQuestionEnvelopeFactory({ anchors }),
    observation: new RecordingObservationPort(),
    permissions: FIXTURE_PERMISSIONS_GRANTED,
    windows: FIXTURE_WINDOWS,
  });
  return { controller, clock, agent };
}

describe('machine → factory wiring', () => {
  it('anchors on push-to-talk up, using the machine clock', async () => {
    const { controller, clock, agent } = createController();
    controller.send({ type: 'select-window', windowId: FIXTURE_WINDOW_RETINA.windowId });

    clock.advance(50);
    controller.send({ type: 'push-to-talk-down' });
    clock.advance(100);
    controller.send({ type: 'push-to-talk-up' });
    // The effect queue drains later; time keeps moving while it does.
    clock.advance(5_000);
    await controller.settled();

    const envelope = agent.submitted[0];
    expect(envelope).toBeDefined();
    expect(envelope?.anchor?.utteranceStartedAt).toBe(PTT_DOWN_AT);
    expect(envelope?.anchor?.utteranceEndedAt).toBe(PTT_UP_AT);
    // Anchored inside the utterance, not at the drained-queue time.
    expect(envelope?.anchor?.pointerSampledAt).toBeLessThanOrEqual(PTT_UP_AT);
    expect(envelope?.anchor?.grounding).toBe('pointer-in-window');
    expect(envelope?.transcript).toBe('What is this?');
  });

  it('records the interval on the context, so PR-025 can read it', async () => {
    const { controller, clock } = createController();
    controller.send({ type: 'select-window', windowId: FIXTURE_WINDOW_RETINA.windowId });
    expect(controller.context.utteranceStartedAt).toBeNull();

    clock.advance(50);
    controller.send({ type: 'push-to-talk-down' });
    expect(controller.context.utteranceStartedAt).toBe(PTT_DOWN_AT);
    expect(controller.context.utteranceEndedAt).toBeNull();

    clock.advance(100);
    controller.send({ type: 'push-to-talk-up' });
    await controller.settled();
    expect(controller.context.utteranceEndedAt).toBe(PTT_UP_AT);
  });

  it('gives a typed question its own interval instead of the previous one', async () => {
    const { controller, clock, agent } = createController();
    controller.send({ type: 'select-window', windowId: FIXTURE_WINDOW_RETINA.windowId });
    clock.advance(50);
    controller.send({ type: 'push-to-talk-down' });
    clock.advance(100);
    controller.send({ type: 'push-to-talk-up' });
    await controller.settled();

    clock.advance(9_000);
    controller.send({ type: 'submit-text', text: 'and this one?' });
    await controller.settled();

    const typed = agent.submitted[1];
    expect(typed?.anchor?.utteranceStartedAt).toBe(PTT_UP_AT + 9_000);
    expect(typed?.anchor?.utteranceEndedAt).toBe(PTT_UP_AT + 9_000);
    // Nine seconds later the recorded pointer is far too old to anchor on.
    expect(typed?.anchor?.grounding).toBe('pointer-unknown');
    expect(typed?.anchor?.note).toMatch(/close enough/u);
  });
});
