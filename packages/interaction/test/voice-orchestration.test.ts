import { describe, expect, it } from 'vitest';
import {
  asConversationId,
  createCounterIdSource,
  createIdFactory,
  type QuestionEnvelope,
  type UtteranceId,
} from '@pilot/shared';
import {
  FAKE_EPOCH_MS,
  FIXTURE_ACCESSIBILITY_NODE,
  FIXTURE_PERMISSIONS_GRANTED,
  FIXTURE_WINDOWS,
  FIXTURE_WINDOW_RETINA,
  FakeAgentSession,
  FakeSpeechInputAdapter,
  FakeSpeechOutputAdapter,
  createFakeClock,
  type FakeUtteranceScript,
} from '@pilot/platform/fakes';
import {
  FakeQuestionAnchorSource,
  PilotInteractionController,
  PilotQuestionEnvelopeFactory,
  RecordingObservationPort,
  isTextFallbackAvailable,
  recordPointerPath,
  type VoiceDiagnostic,
} from '@pilot/interaction';

/**
 * PR-025 — push-to-talk and speech-to-text bound to `SpeechInputAdapter`.
 *
 * `docs/implementation.md` names the cases this must cover: a late transcript
 * after cancellation, two overlapping push-to-talk presses, an STT failure with
 * the user typing instead, and a finalize that arrives twice. Each is a test
 * below, driven through the public controller with the PR-001 fakes and the
 * PR-024 envelope factory — no adapter is stubbed out of the path.
 */

const WINDOW = FIXTURE_WINDOW_RETINA;

/** Long enough that a typed question anchors as well as a spoken one. */
const POINTER_TIMELINE = recordPointerPath({
  startedAt: FAKE_EPOCH_MS,
  durationMs: 30_000,
  hz: 10,
  target: FIXTURE_ACCESSIBILITY_NODE,
  targetFrom: 0,
});

function createHarness(
  options: {
    readonly script?: readonly FakeUtteranceScript[];
    readonly agentMode?: 'auto' | 'manual';
  } = {},
) {
  const clock = createFakeClock();
  const conversationId = asConversationId('conv-voice');
  const speechInput = new FakeSpeechInputAdapter({
    script: options.script ?? [
      { partials: ['what', 'what is'], final: 'What is this?' },
      { partials: ['and what'], final: 'And what happens if I turn it off?' },
    ],
  });
  const speechOutput = new FakeSpeechOutputAdapter();
  const agent = new FakeAgentSession({
    conversationId,
    mode: options.agentMode ?? 'auto',
    script: [{ deltas: ['That is the Auto Renew toggle.'] }],
  });
  const observation = new RecordingObservationPort();
  const controller = new PilotInteractionController({
    clock,
    ids: createIdFactory(createCounterIdSource()),
    conversationId,
    speechInput,
    speechOutput,
    agent,
    envelopes: new PilotQuestionEnvelopeFactory({
      anchors: new FakeQuestionAnchorSource({ samples: POINTER_TIMELINE }),
    }),
    observation,
    permissions: FIXTURE_PERMISSIONS_GRANTED,
    windows: FIXTURE_WINDOWS,
  });

  const diagnostics: VoiceDiagnostic[] = [];
  controller.subscribeVoiceDiagnostics((diagnostic) => diagnostics.push(diagnostic));
  const rejections: string[] = [];
  controller.subscribeRejections((rejection) => rejections.push(rejection.reason));

  return {
    controller,
    clock,
    speechInput,
    speechOutput,
    agent,
    observation,
    diagnostics,
    rejections,
  };
}

function utteranceOf(controller: PilotInteractionController): UtteranceId {
  const utteranceId = controller.context.activeUtteranceId;
  expect(utteranceId).not.toBeNull();
  return utteranceId!;
}

function discarded(diagnostics: readonly VoiceDiagnostic[]): readonly string[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.kind === 'discarded-event')
    .map((diagnostic) => `${diagnostic.event}:${diagnostic.reason}`);
}

describe('push-to-talk drives the recogniser', () => {
  it('turns a held key and a released key into one agent submission', async () => {
    const { controller, clock, speechInput, agent, speechOutput } = createHarness();
    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    await controller.settled();

    clock.advance(50);
    controller.dispatch({ type: 'push-to-talk-down' });
    await controller.settled();
    const utteranceId = utteranceOf(controller);
    expect(controller.snapshot().state).toBe('listening');
    expect(controller.liveUtteranceId).toBe(utteranceId);
    expect(speechInput.started.map((request) => request.utteranceId)).toEqual([utteranceId]);
    expect(speechInput.started[0]?.requireOnDevice).toBe(true);

    // A live hypothesis while the key is still held reaches the view state.
    speechInput.emitPartial(utteranceId, 'what is');
    expect(controller.snapshot().liveTranscript).toBe('what is');

    clock.advance(100);
    controller.dispatch({ type: 'push-to-talk-up' });
    await controller.settled();

    expect(speechInput.stopped).toEqual([utteranceId]);
    expect(speechInput.cancelled).toEqual([]);
    expect(agent.submitted).toHaveLength(1);
    expect(agent.submitted[0]?.transcript).toBe('What is this?');
    expect(agent.submitted[0]?.utteranceId).toBe(utteranceId);
    expect(agent.submitted[0]?.anchor?.grounding).toBe('pointer-in-window');
    expect(speechOutput.spokenText).toBe('That is the Auto Renew toggle.');
    expect(controller.liveUtteranceId).toBeNull();
    await controller.dispose();
  });

  it('honours the on-device requirement and the locale it was configured with', async () => {
    const conversationId = asConversationId('conv-locale');
    const speechInput = new FakeSpeechInputAdapter();
    const controller = new PilotInteractionController({
      clock: createFakeClock(),
      ids: createIdFactory(createCounterIdSource()),
      conversationId,
      speechInput,
      speechOutput: new FakeSpeechOutputAdapter(),
      agent: new FakeAgentSession({ conversationId, mode: 'manual' }),
      envelopes: new PilotQuestionEnvelopeFactory({ anchors: new FakeQuestionAnchorSource() }),
      permissions: FIXTURE_PERMISSIONS_GRANTED,
      windows: FIXTURE_WINDOWS,
      requireOnDeviceSpeech: false,
      speechLocale: 'en-GB',
    });
    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'push-to-talk-down' });
    await controller.settled();

    expect(speechInput.started[0]).toMatchObject({ requireOnDevice: false, locale: 'en-GB' });
    await controller.dispose();
  });

  it('releases the microphone when the controller is disposed mid-utterance', async () => {
    const { controller, speechInput } = createHarness();
    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'push-to-talk-down' });
    await controller.settled();
    expect(speechInput.activeUtteranceId).not.toBeNull();

    await controller.dispose();
    expect(speechInput.activeUtteranceId).toBeNull();
    expect(speechInput.cancelled).toHaveLength(1);
  });
});

describe('a dead utterance cannot be resurrected', () => {
  it('discards a transcript that arrives after the utterance was cancelled', async () => {
    const { controller, speechInput, agent, diagnostics } = createHarness();
    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'push-to-talk-down' });
    await controller.settled();
    const abandoned = utteranceOf(controller);

    controller.dispatch({ type: 'interrupt' });
    await controller.settled();
    expect(speechInput.cancelled).toEqual([abandoned]);
    expect(controller.snapshot().state).toBe('observing');

    // The recogniser answers a question nobody is asking any more.
    speechInput.emitLateFinal(abandoned, 'the abandoned question');
    await controller.settled();

    expect(agent.submitted).toEqual([]);
    expect(controller.snapshot().state).toBe('observing');
    expect(controller.snapshot().transcript).toEqual([]);
    // Dropped by the binding, so the machine was never asked.
    expect(discarded(diagnostics)).toEqual(['final:cancelled']);
    await controller.dispose();
  });

  it('discards a second finalize for the same utterance', async () => {
    const { controller, speechInput, agent, diagnostics, rejections } = createHarness();
    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'push-to-talk-down' });
    await controller.settled();
    const utteranceId = utteranceOf(controller);

    controller.dispatch({ type: 'push-to-talk-up' });
    await controller.settled();
    expect(agent.submitted).toHaveLength(1);

    speechInput.emitLateFinal(utteranceId, 'What is this?');
    await controller.settled();

    expect(agent.submitted).toHaveLength(1);
    expect(controller.snapshot().transcript.filter((entry) => entry.role === 'user')).toHaveLength(
      1,
    );
    expect(discarded(diagnostics)).toEqual(['final:already-finalized']);
    expect(rejections).toEqual([]);
    await controller.dispose();
  });

  it('handles two overlapping push-to-talk presses', async () => {
    const { controller, speechInput, agent, diagnostics, rejections } = createHarness({
      script: [
        { partials: ['what'], final: 'What is this?' },
        { partials: ['no wait'], final: 'No wait — what is that?' },
      ],
    });
    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'push-to-talk-down' });
    await controller.settled();
    const first = utteranceOf(controller);

    // A repeat press (key repeat, or the other hand) must not disturb the
    // utterance that is already recording.
    const repeat = controller.send({ type: 'push-to-talk-down' });
    expect(repeat.kind === 'rejected' && repeat.rejection.reason).toBe('illegal-transition');
    expect(controller.liveUtteranceId).toBe(first);
    expect(speechInput.started).toHaveLength(1);

    // Release and press again in the same tick: the second press supersedes the
    // first before its transcript has been delivered.
    controller.send({ type: 'push-to-talk-up' });
    controller.send({ type: 'push-to-talk-down' });
    await controller.settled();

    const second = utteranceOf(controller);
    expect(second).not.toBe(first);
    expect(controller.liveUtteranceId).toBe(second);
    // The first utterance's transcript was still in flight; it must not become
    // a question, whichever layer notices first.
    expect(rejections).toContain('stale-utterance');
    expect(agent.submitted).toEqual([]);

    controller.dispatch({ type: 'push-to-talk-up' });
    await controller.settled();

    expect(agent.submitted).toHaveLength(1);
    expect(agent.submitted[0]?.transcript).toBe('No wait — what is that?');
    expect(agent.submitted[0]?.utteranceId).toBe(second);
    // Exactly one recogniser was ever open: two starts, and the abandoned one
    // was never left recording.
    expect(speechInput.started).toHaveLength(2);
    expect(speechInput.activeUtteranceId).toBeNull();
    expect(
      diagnostics.every(
        (diagnostic) => !('utteranceId' in diagnostic) || diagnostic.utteranceId !== second,
      ),
      'nothing about the live utterance was discarded',
    ).toBe(true);
    await controller.dispose();
  });

  it('cannot revive an utterance that failed', async () => {
    const { controller, speechInput, agent, diagnostics } = createHarness();
    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'push-to-talk-down' });
    await controller.settled();
    const failed = utteranceOf(controller);

    speechInput.emitError(failed, 'the recogniser lost the audio session');
    await controller.settled();
    speechInput.emitLateFinal(failed, 'a transcript from beyond the grave');
    await controller.settled();

    expect(agent.submitted).toEqual([]);
    expect(discarded(diagnostics)).toEqual(['final:already-failed']);
    await controller.dispose();
  });

  it('does not fail the question when the recogniser finalises before the key is released', async () => {
    const { controller, speechInput, agent } = createHarness();
    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'push-to-talk-down' });
    await controller.settled();
    const utteranceId = utteranceOf(controller);

    // Endpointing: recognition completes while the user is still holding the
    // key, so the machine emits `stop-listening` for an utterance the adapter
    // has already closed. Forwarding that would throw and lose the question.
    speechInput.emitLateFinal(utteranceId, 'What is this?');
    await controller.settled();

    expect(agent.submitted).toHaveLength(1);
    expect(controller.snapshot().lastError).toBeNull();
    expect(controller.snapshot().state).toBe('speaking');
    expect(speechInput.stopped).toEqual([]);
    await controller.dispose();
  });
});

describe('text input is the fallback for a failed recogniser (system-design §16)', () => {
  it('offers typing in exactly the states the table accepts it in', () => {
    expect(isTextFallbackAvailable('error')).toBe(true);
    expect(isTextFallbackAvailable('observing')).toBe(true);
    expect(isTextFallbackAvailable('listening')).toBe(true);
    expect(isTextFallbackAvailable('needs-permission')).toBe(false);
    expect(isTextFallbackAvailable('paused')).toBe(false);
  });

  it('lets the user type after STT fails mid-utterance, releasing the audio first', async () => {
    const { controller, speechInput, agent, speechOutput } = createHarness();
    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'push-to-talk-down' });
    await controller.settled();
    const failed = utteranceOf(controller);

    speechInput.emitError(failed, 'the recogniser lost the audio session');
    await controller.settled();

    expect(controller.snapshot().state).toBe('error');
    expect(controller.snapshot().lastError?.code).toBe('speech-input-failed');
    // "Preserve audio only until failure handling completes" — the session is
    // released rather than left open.
    expect(speechInput.cancelled).toEqual([failed]);
    expect(speechInput.activeUtteranceId).toBeNull();
    expect(isTextFallbackAvailable(controller.snapshot().state)).toBe(true);

    const typed = controller.send({ type: 'submit-text', text: 'What is this?' });
    expect(typed.kind).toBe('accepted');
    await controller.settled();

    expect(agent.submitted).toHaveLength(1);
    expect(agent.submitted[0]?.transcript).toBe('What is this?');
    // Answering the question is what dismisses the failure.
    expect(controller.snapshot().lastError).toBeNull();
    expect(speechOutput.spokenText).toBe('That is the Auto Renew toggle.');
    await controller.dispose();
  });

  it('still refuses an empty typed question from the error state', async () => {
    const { controller, speechInput } = createHarness();
    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'push-to-talk-down' });
    await controller.settled();
    speechInput.emitError(utteranceOf(controller), 'failed');
    await controller.settled();

    const outcome = controller.send({ type: 'submit-text', text: '   ' });
    expect(outcome.kind === 'rejected' && outcome.rejection.reason).toBe('empty-input');
    expect(controller.snapshot().state).toBe('error');
    await controller.dispose();
  });

  it('produces an equivalent envelope whether the question was spoken or typed', async () => {
    const spokenHarness = createHarness();
    spokenHarness.controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    spokenHarness.controller.dispatch({ type: 'push-to-talk-down' });
    spokenHarness.controller.dispatch({ type: 'push-to-talk-up' });
    await spokenHarness.controller.settled();

    const typedHarness = createHarness();
    typedHarness.controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    typedHarness.controller.dispatch({ type: 'submit-text', text: 'What is this?' });
    await typedHarness.controller.settled();

    const spoken = spokenHarness.agent.submitted[0];
    const typed = typedHarness.agent.submitted[0];
    expect(spoken).toBeDefined();
    expect(typed).toBeDefined();
    const comparable = (envelope: QuestionEnvelope): unknown => ({
      keys: Object.keys(envelope).sort(),
      transcript: envelope.transcript,
      conversationId: envelope.conversationId,
      scene: envelope.scene,
      pointer: envelope.pointer,
      grounding: envelope.anchor?.grounding,
      target: envelope.anchor?.target,
      targetAvailability: envelope.anchor?.targetAvailability,
    });
    expect(comparable(typed!)).toEqual(comparable(spoken!));

    // The typed path never touches the speech adapter.
    expect(typedHarness.speechInput.started).toEqual([]);
    await spokenHarness.controller.dispose();
    await typedHarness.controller.dispose();
  });
});
