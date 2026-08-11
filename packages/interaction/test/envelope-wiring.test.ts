import { describe, expect, it } from 'vitest';
import {
  asConversationId,
  createCounterIdSource,
  createIdFactory,
  type PermissionSnapshot,
} from '@pilot/shared';
import {
  FIXTURE_ACCESSIBILITY_NODE,
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

/**
 * PR-044 — the permission reaches the envelope, and only through the machine.
 *
 * `PilotQuestionEnvelopeFactory` reads no permission of its own, exactly as it
 * reads no clock: the controller passes `accessibilityGrounding` off
 * `InteractionContext.permissions` at submission. These tests are the wiring,
 * end to end, on the same recording — so the difference between the two
 * envelopes is the permission and nothing else.
 */
describe('§16 degraded grounding, wired', () => {
  const DENIED: PermissionSnapshot = {
    ...FIXTURE_PERMISSIONS_GRANTED,
    accessibility: { kind: 'accessibility', state: 'denied', canRequest: false },
  };

  function createGroundedController() {
    const clock = createFakeClock();
    const conversationId = asConversationId('conv-degraded');
    const agent = new FakeAgentSession({
      conversationId,
      mode: 'manual',
      script: [{ deltas: [] }],
    });
    const anchors = new FakeQuestionAnchorSource({
      // Every sample carries an element, so a missing target is always Pilot's
      // decision rather than an empty recording.
      samples: recordPointerPath({
        startedAt: PTT_DOWN_AT,
        durationMs: 60_000,
        hz: 20,
        target: FIXTURE_ACCESSIBILITY_NODE,
        targetFrom: 0,
      }),
    });
    const controller = new PilotInteractionController({
      clock,
      ids: createIdFactory(createCounterIdSource()),
      conversationId,
      speechInput: new FakeSpeechInputAdapter({ script: [] }),
      speechOutput: new FakeSpeechOutputAdapter(),
      agent,
      envelopes: new PilotQuestionEnvelopeFactory({ anchors }),
      observation: new RecordingObservationPort(),
      permissions: FIXTURE_PERMISSIONS_GRANTED,
      windows: FIXTURE_WINDOWS,
    });
    controller.send({ type: 'select-window', windowId: FIXTURE_WINDOW_RETINA.windowId });
    return { controller, clock, agent };
  }

  it('degrades and upgrades within one session, with no relaunch and no re-selection', async () => {
    const { controller, clock, agent } = createGroundedController();

    clock.advance(50);
    controller.send({ type: 'submit-text', text: 'What is this?' });
    await controller.settled();

    // Revoked mid-session. Nothing is torn down; the controller is not rebuilt.
    controller.send({ type: 'permissions-changed', permissions: DENIED });
    await controller.settled();
    expect(controller.context.selectedWindow?.windowId).toBe(FIXTURE_WINDOW_RETINA.windowId);

    clock.advance(50);
    controller.send({ type: 'submit-text', text: 'and now?' });
    await controller.settled();

    // Granted again, same session.
    controller.send({ type: 'permissions-changed', permissions: FIXTURE_PERMISSIONS_GRANTED });
    await controller.settled();
    clock.advance(50);
    controller.send({ type: 'submit-text', text: 'and now?' });
    await controller.settled();

    const [before, during, after] = agent.submitted;
    expect(agent.submitted).toHaveLength(3);

    expect(before?.anchor?.targetAvailability).toBe('reported');
    expect(before?.pointer.targetRole).toBe(FIXTURE_ACCESSIBILITY_NODE.role);

    expect(during?.anchor?.targetAvailability).toBe('unavailable');
    expect(during?.pointer.targetRole).toBeUndefined();
    expect(during?.pointer.targetLabel).toBeUndefined();
    // The pointer §16 asks Pilot to continue with is still a real position —
    // the sentinel would be -1, and `pointer-in-window` is only reachable from
    // a sample the recording actually holds.
    expect(during?.anchor?.grounding).toBe('pointer-in-window');
    expect(during?.pointer.normalizedX).toBeGreaterThan(0);
    expect(during?.pointer.normalizedY).toBeGreaterThan(0);
    expect(during?.anchor?.pointerSampledAt).toBeDefined();

    // …and the upgrade needed nothing but the grant.
    expect(after?.anchor?.targetAvailability).toBe('reported');
    expect(after?.pointer.targetRole).toBe(FIXTURE_ACCESSIBILITY_NODE.role);
  });
});
