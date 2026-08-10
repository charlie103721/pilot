import { describe, expect, it } from 'vitest';
import {
  PilotError,
  asConversationId,
  asSpeechId,
  asUtteranceId,
  buildGroundedPointer,
  questionEnvelopeSchema,
  screenObservationSchema,
  type QuestionEnvelope,
} from '@pilot/shared';
import type {
  AccessibilityAdapter,
  AgentEvent,
  AgentSession,
  InteractionController,
  ObservationAdapter,
  PermissionAdapter,
  PlatformAdapter,
  ScreenContextService,
  SpeechInputAdapter,
  SpeechInputEvent,
  SpeechOutputAdapter,
  SpeechOutputEvent,
} from '@pilot/platform';
import {
  FIXTURE_GEOMETRY_RETINA,
  FIXTURE_PERMISSIONS_ACCESSIBILITY_DENIED,
  FIXTURE_PERMISSIONS_DENIED,
  FIXTURE_PERMISSIONS_GRANTED,
  FIXTURE_PERMISSIONS_RESTRICTED,
  FIXTURE_PERMISSIONS_SCREEN_DENIED,
  FIXTURE_PERMISSIONS_UNKNOWN,
  FIXTURE_WINDOW_RETINA,
  FakeAgentSession,
  FakeAgentSessionFactory,
  FakeInteractionController,
  FakeObservationAdapter,
  FakePermissionAdapter,
  FakeScreenContextService,
  FakeSpeechInputAdapter,
  FakeSpeechOutputAdapter,
  createFakePlatformAdapter,
  createFixtureObservation,
} from '@pilot/platform/fakes';

const CAPTURE_OPTIONS = { sampleFps: 3, maxEdgePixels: 1440, includeCursor: false };

function makeEnvelope(transcript: string): QuestionEnvelope {
  const pointer = buildGroundedPointer({ x: 730, y: 495 }, FIXTURE_GEOMETRY_RETINA);
  return questionEnvelopeSchema.parse({
    utteranceId: 'utt-0001',
    transcript,
    conversationId: 'conv-0001',
    scene: { id: 'scene-0001', revision: 4, windowTitle: FIXTURE_WINDOW_RETINA.title },
    pointer: { normalizedX: pointer.normalizedPoint.x, normalizedY: pointer.normalizedPoint.y },
  });
}

/**
 * Each block below binds the fake to the *interface* it must satisfy, so the
 * test fails to compile if a fake drifts from the contract a real
 * implementation will have to meet.
 */

describe('fake platform adapter — PlatformAdapter contract', () => {
  it('exposes every adapter named in system-design §5', () => {
    const platform: PlatformAdapter = createFakePlatformAdapter();
    expect(Object.keys(platform)).toEqual(
      expect.arrayContaining([
        'permissions',
        'windows',
        'observation',
        'accessibility',
        'speechInput',
        'speechOutput',
        'credentials',
      ]),
    );
  });

  it('clears buffers on dispose', async () => {
    const platform = createFakePlatformAdapter();
    await platform.start();
    await platform.observation.start(FIXTURE_WINDOW_RETINA, CAPTURE_OPTIONS);
    await platform.dispose();
    expect(platform.clearBufferCount).toBe(1);
    expect(platform.observation.started).toBe(false);
    expect(platform.disposed).toBe(true);
  });

  it('drives permission state through the PermissionAdapter contract', async () => {
    const permissions: PermissionAdapter = new FakePermissionAdapter(FIXTURE_PERMISSIONS_UNKNOWN);
    const seen: string[] = [];
    const unsubscribe = permissions.subscribe((status) =>
      seen.push(`${status.kind}:${status.state}`),
    );

    expect((await permissions.status('screen-recording')).state).toBe('unknown');
    expect((await permissions.request('screen-recording')).state).toBe('granted');
    expect((await permissions.snapshot())['screen-recording'].state).toBe('granted');
    await permissions.openSettings('accessibility');

    unsubscribe();
    await permissions.request('microphone');
    expect(seen).toEqual(['screen-recording:granted']);
  });

  it('replaces the whole permission snapshot and notifies only what changed', async () => {
    // The external-change path: the user edits System Settings while the app is
    // running. PR-008's onboarding recovers from this without a restart, so the
    // fake has to reproduce it — including not re-announcing what stayed put.
    const permissions = new FakePermissionAdapter(FIXTURE_PERMISSIONS_DENIED);
    const seen: string[] = [];
    permissions.subscribe((status) => seen.push(`${status.kind}:${status.state}`));

    permissions.setSnapshot(FIXTURE_PERMISSIONS_SCREEN_DENIED);

    expect(seen).toEqual([
      'accessibility:granted',
      'microphone:granted',
      'speech-recognition:granted',
    ]);
    expect((await permissions.snapshot())['screen-recording'].state).toBe('denied');

    seen.length = 0;
    permissions.setSnapshot(FIXTURE_PERMISSIONS_SCREEN_DENIED);
    expect(seen).toEqual([]);
  });

  it('reports a prompt that policy refuses, not just a user refusal', async () => {
    const permissions = new FakePermissionAdapter(FIXTURE_PERMISSIONS_UNKNOWN);
    permissions.requestOutcomes.set('accessibility', 'restricted');

    expect((await permissions.request('accessibility')).state).toBe('restricted');
    expect((await permissions.request('microphone')).state).toBe('granted');
  });

  it('can fail an openSettings call instead of always succeeding', async () => {
    const permissions = new FakePermissionAdapter(FIXTURE_PERMISSIONS_DENIED);
    permissions.openSettingsError = new Error('no such pane');

    await expect(permissions.openSettings('microphone')).rejects.toThrow('no such pane');
    await permissions.openSettings('microphone');
    expect(permissions.openedSettings).toEqual(['microphone']);
  });

  it('offers a fixture for each state the permission contract models', () => {
    const states = [
      FIXTURE_PERMISSIONS_UNKNOWN,
      FIXTURE_PERMISSIONS_GRANTED,
      FIXTURE_PERMISSIONS_DENIED,
      FIXTURE_PERMISSIONS_RESTRICTED,
    ].map((snapshot) => snapshot['screen-recording'].state);

    expect(states).toEqual(['unknown', 'granted', 'denied', 'restricted']);
    // …and the two §16 failures are separate fixtures, not one "denied" blob.
    expect(FIXTURE_PERMISSIONS_SCREEN_DENIED['screen-recording'].state).toBe('denied');
    expect(FIXTURE_PERMISSIONS_SCREEN_DENIED.accessibility.state).toBe('granted');
    expect(FIXTURE_PERMISSIONS_ACCESSIBILITY_DENIED['screen-recording'].state).toBe('granted');
    expect(FIXTURE_PERMISSIONS_ACCESSIBILITY_DENIED.accessibility.state).toBe('denied');
  });

  it('resolves accessibility hit tests and reports misses honestly', async () => {
    const platform = createFakePlatformAdapter();
    const accessibility: AccessibilityAdapter = platform.accessibility;
    expect(await accessibility.getPointer()).toEqual({ x: 730, y: 495 });
    expect((await accessibility.elementAt({ x: 730, y: 495 }))?.label).toBe('Auto Renew');
    expect(await accessibility.elementAt({ x: 0, y: 0 })).toBeNull();
  });
});

describe('fake observation adapter — ObservationAdapter contract', () => {
  it('emits fixture frames only when told to', async () => {
    const fake = new FakeObservationAdapter();
    const observation: ObservationAdapter = fake;
    const frames: number[] = [];
    const unsubscribe = observation.subscribe((frame) => frames.push(frame.capturedAt));

    await observation.start(FIXTURE_WINDOW_RETINA, CAPTURE_OPTIONS);
    expect(frames).toHaveLength(0);

    fake.emitNext();
    fake.emitNext();
    expect(frames).toHaveLength(2);
    expect(frames[1]! - frames[0]!).toBe(333);

    unsubscribe();
    fake.emitNext();
    expect(frames).toHaveLength(2);

    await observation.stop();
    expect(fake.stopCount).toBe(1);
  });

  it('refuses a fresh capture while not observing', async () => {
    const observation: ObservationAdapter = new FakeObservationAdapter();
    await expect(observation.captureFresh()).rejects.toMatchObject({
      code: 'observation-disabled',
    });
  });

  it('honours an abort signal', async () => {
    const observation: ObservationAdapter = new FakeObservationAdapter();
    await observation.start(FIXTURE_WINDOW_RETINA, CAPTURE_OPTIONS);
    const controller = new AbortController();
    controller.abort();
    await expect(observation.captureFresh(controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('reports protected content instead of returning a blank frame', async () => {
    const observation: ObservationAdapter = new FakeObservationAdapter({ protectedContent: true });
    await observation.start(FIXTURE_WINDOW_RETINA, CAPTURE_OPTIONS);
    await expect(observation.captureFresh()).rejects.toMatchObject({ code: 'protected-content' });
  });

  it('produces frames that carry bytes but no persistable payload shape', async () => {
    const observation: ObservationAdapter = new FakeObservationAdapter();
    await observation.start(FIXTURE_WINDOW_RETINA, CAPTURE_OPTIONS);
    const frame = await observation.captureFresh();
    expect(frame.bytes).toBeInstanceOf(Uint8Array);
    expect(frame.size).toEqual({ width: 2400, height: 1600 });
    expect(frame.scaleFactor).toBe(2);
  });
});

describe('fake screen context service — ScreenContextService contract', () => {
  it('returns a fixture observation that satisfies the documented schema', async () => {
    const service: ScreenContextService = new FakeScreenContextService();
    const observation = await service.observe({ view: 'pointer', moment: 'question' });
    expect(() => screenObservationSchema.parse(observation)).not.toThrow();
    expect(observation.images).toHaveLength(1);
    expect(service.status().enabled).toBe(true);
  });

  it('rejects with typed errors for paused and disabled observation', async () => {
    const fake = new FakeScreenContextService();
    const service: ScreenContextService = fake;

    fake.paused = true;
    await expect(service.observe({ view: 'window', moment: 'current' })).rejects.toMatchObject({
      code: 'observation-paused',
    });

    fake.paused = false;
    fake.loseWindow();
    await expect(service.observe({ view: 'window', moment: 'current' })).rejects.toMatchObject({
      code: 'observation-disabled',
    });
    expect(service.status().selectedWindow).toBeNull();
  });

  it('reports an empty buffer once cleared', () => {
    const fake = new FakeScreenContextService();
    const service: ScreenContextService = fake;
    service.clear();
    expect(fake.clearCount).toBe(1);
    fake.paused = true;
    expect(service.status().buffer.frameCount).toBe(0);
  });

  it('supports a scripted lineage failure', async () => {
    const fake = new FakeScreenContextService({
      observations: [createFixtureObservation({ sceneRevision: 9 })],
    });
    fake.failWith = new PilotError('scene-mismatch', 'Frame no longer matches the selected window');
    await expect(fake.observe({ view: 'both', moment: 'question' })).rejects.toMatchObject({
      code: 'scene-mismatch',
    });
  });
});

describe('fake agent session — AgentSession contract', () => {
  it('streams a scripted turn and completes', async () => {
    const session: AgentSession = new FakeAgentSession({
      conversationId: asConversationId('conv-0001'),
    });
    const events: AgentEvent[] = [];
    session.subscribe((event) => events.push(event));

    const handle = await session.submit(makeEnvelope('What is this?'));
    await handle.completed;

    expect(events.map((event) => event.type)).toEqual([
      'run-started',
      'tool-started',
      'tool-succeeded',
      'text-delta',
      'text-delta',
      'run-completed',
    ]);
    const completed = events.at(-1);
    expect(completed?.type === 'run-completed' && completed.text).toBe(
      'That is the Auto Renew toggle. It is currently off.',
    );
  });

  it('allows only one active run per conversation', async () => {
    const fake = new FakeAgentSession({
      conversationId: asConversationId('conv-0001'),
      mode: 'manual',
    });
    await fake.submit(makeEnvelope('first'));
    await expect(fake.submit(makeEnvelope('second'))).rejects.toMatchObject({
      code: 'run-already-active',
    });
  });

  it('aborts an in-flight run and resolves its handle', async () => {
    const fake = new FakeAgentSession({
      conversationId: asConversationId('conv-0001'),
      mode: 'manual',
    });
    const events: AgentEvent[] = [];
    fake.subscribe((event) => events.push(event));

    const handle = await fake.submit(makeEnvelope('What is this?'));
    await fake.interrupt('abort', 'new push-to-talk');
    await handle.completed;

    expect(events.map((event) => event.type)).toEqual(['run-started', 'run-aborted']);
    expect(fake.activeRunId).toBeNull();
    // Late output cannot resurface: stepping after an abort is a no-op.
    expect(fake.step()).toBe(false);
  });

  it('refuses to run on a profile without vision and tools', async () => {
    const factory = new FakeAgentSessionFactory();
    const session = await factory.create(asConversationId('conv-0002'), {
      id: 'profile-text' as never,
      provider: 'fake',
      model: 'fake-text-1',
      authMode: 'local',
      supportsVision: false,
      supportsTools: true,
      isRemote: false,
    });
    await expect(session.submit(makeEnvelope('What is this?'))).rejects.toMatchObject({
      code: 'unsupported-capability',
    });
  });
});

describe('fake speech adapters — SpeechInputAdapter / SpeechOutputAdapter contracts', () => {
  it('emits partials then a final transcript on stop', async () => {
    const fake = new FakeSpeechInputAdapter();
    const speech: SpeechInputAdapter = fake;
    const events: SpeechInputEvent[] = [];
    speech.subscribe((event) => events.push(event));

    const utteranceId = asUtteranceId('utt-0001');
    await speech.start({ utteranceId, requireOnDevice: true });
    expect(events).toHaveLength(0);

    await speech.stop(utteranceId);
    expect(events.map((event) => event.type)).toEqual(['partial', 'partial', 'final']);
    const final = events.at(-1);
    expect(final?.type === 'final' && final.transcript).toBe('What is this?');
  });

  it('emits nothing for a cancelled utterance', async () => {
    const fake = new FakeSpeechInputAdapter();
    const speech: SpeechInputAdapter = fake;
    const events: SpeechInputEvent[] = [];
    speech.subscribe((event) => events.push(event));

    const utteranceId = asUtteranceId('utt-0002');
    await speech.start({ utteranceId, requireOnDevice: true });
    await speech.cancel(utteranceId);
    expect(events).toHaveLength(0);
    expect(fake.cancelled).toEqual([utteranceId]);
  });

  it('refuses to start when on-device recognition is required but unavailable', async () => {
    const speech: SpeechInputAdapter = new FakeSpeechInputAdapter({
      availability: { available: true, onDevice: false },
    });
    await expect(
      speech.start({ utteranceId: asUtteranceId('utt-0003'), requireOnDevice: true }),
    ).rejects.toMatchObject({ code: 'speech-unavailable' });
  });

  it('starts, interrupts and reports speech output events', async () => {
    const fake = new FakeSpeechOutputAdapter();
    const speech: SpeechOutputAdapter = fake;
    const events: SpeechOutputEvent[] = [];
    speech.subscribe((event) => events.push(event));

    const speechId = asSpeechId('speech-0001');
    await speech.speak({ speechId, text: 'That is the Auto Renew toggle.' });
    expect(fake.activeSpeechId).toBe(speechId);

    await speech.stop();
    expect(events.map((event) => event.type)).toEqual(['started', 'stopped']);
    expect(fake.activeSpeechId).toBeNull();
    expect(fake.spokenText).toBe('That is the Auto Renew toggle.');
  });
});

describe('fake interaction controller — InteractionController contract', () => {
  it('moves through the documented states in response to commands', () => {
    const fake = new FakeInteractionController();
    const controller: InteractionController = fake;
    const states: string[] = [];
    controller.subscribe((view) => states.push(view.state));

    controller.dispatch({ type: 'select-window', windowId: FIXTURE_WINDOW_RETINA.windowId });
    controller.dispatch({ type: 'push-to-talk-down' });
    controller.dispatch({ type: 'push-to-talk-up' });
    controller.dispatch({ type: 'submit-text', text: 'What is this?' });
    controller.dispatch({ type: 'pause' });

    expect(states).toEqual(['observing', 'listening', 'transcribing', 'thinking', 'paused']);
    expect(controller.snapshot().selectedWindow?.windowId).toBe(FIXTURE_WINDOW_RETINA.windowId);
    expect(fake.commands).toHaveLength(5);
  });

  it('exposes an explicit error state rather than failing silently', () => {
    const fake = new FakeInteractionController();
    const view = fake.fail(new PilotError('permission-denied', 'Screen recording denied').toJSON());
    expect(view.state).toBe('error');
    expect(view.lastError?.code).toBe('permission-denied');
  });
});
