import { describe, expect, it } from 'vitest';
import {
  asFrameId,
  createCounterIdSource,
  createIdFactory,
  isPilotError,
  MVP_SCREEN_POLICY,
  type CapturedFrame,
} from '@pilot/shared';
import {
  createFakeClock,
  FAKE_EPOCH_MS,
  FIXTURE_GEOMETRY_RETINA,
  FIXTURE_GEOMETRY_SECONDARY,
  FIXTURE_WINDOW_RETINA,
  FIXTURE_WINDOW_SECONDARY,
  FakeAccessibilityAdapter,
  FakeObservationAdapter,
  FakeWindowAdapter,
} from '@pilot/platform/fakes';
import { ObservationCore } from '../src/observation-core.js';
import { ObservationSession } from '../src/observation-session.js';
import {
  createSceneLineageFixture,
  createSessionReplayHarness,
  replayFixtureThroughAdapters,
  SCENE_FIXTURE_SECOND_TITLE,
} from '../src/fixtures.js';
import type { SceneTransition } from '../src/scene-tracker.js';

/**
 * PR-016 ingest: the core is driven entirely by the PR-001 platform fakes —
 * frames from `ObservationAdapter`, pointer from `AccessibilityAdapter`, and
 * window lifecycle from `WindowAdapter`.
 */

function subject(frames?: readonly CapturedFrame[]) {
  const clock = createFakeClock();
  const core = new ObservationCore({ clock, ids: createIdFactory(createCounterIdSource()) });
  const observation = new FakeObservationAdapter(frames === undefined ? {} : { frames });
  const accessibility = new FakeAccessibilityAdapter();
  const windows = new FakeWindowAdapter();
  const transitions: SceneTransition[] = [];
  const session = new ObservationSession({
    core,
    clock,
    observation,
    accessibility,
    windows,
    onSceneTransition: (transition) => transitions.push(transition),
  });
  return { clock, core, session, observation, accessibility, windows, transitions };
}

const SELECTION = {
  window: FIXTURE_WINDOW_RETINA,
  geometry: FIXTURE_GEOMETRY_RETINA,
  accessibilityRootId: 'ax-root-1',
};

describe('ObservationSession start and stop', () => {
  it('starts capture with the policy capture options and selects the scene', async () => {
    const { session, observation, core } = subject();
    const transition = await session.start(SELECTION);

    expect(transition.kind).toBe('started');
    expect(session.state).toBe('observing');
    expect(observation.started).toBe(true);
    expect(observation.startedWith?.options).toStrictEqual({
      sampleFps: MVP_SCREEN_POLICY.sampleFps,
      maxEdgePixels: MVP_SCREEN_POLICY.fullFrameMaxEdge,
      includeCursor: false,
    });
    expect(core.scene?.windowId).toBe(FIXTURE_WINDOW_RETINA.windowId);
  });

  it('ingests frames pushed through the adapter subscription', async () => {
    const { session, observation, core, clock } = subject();
    await session.start(SELECTION);
    clock.advance(2000);
    observation.emitNext();
    observation.emitNext();

    expect(core.status().buffer.frameCount).toBe(2);
    expect(session.metrics().framesIngested).toBe(2);
  });

  it('stops capture, clears the buffers and forgets the selection', async () => {
    const { session, observation, core, clock } = subject();
    await session.start(SELECTION);
    clock.advance(1000);
    observation.emitNext();
    await session.stop();

    expect(observation.stopCount).toBe(1);
    expect(core.isEmpty()).toBe(true);
    expect(session.state).toBe('idle');
    expect(session.selection).toBeNull();
    expect(core.status().lastClear).toMatchObject({ reason: 'observation-disabled' });
  });

  it('pulls pointer position and accessibility target from the platform', async () => {
    const { session, accessibility, core } = subject();
    await session.start(SELECTION);
    accessibility.setPointer({ x: 730, y: 495 });
    const outcome = await session.samplePointer(FAKE_EPOCH_MS);

    expect(outcome).toMatchObject({ sampled: true });
    const sample = core.pointer.newest();
    expect(sample?.pointer.accessibilityTarget?.label).toBe('Auto Renew');
    expect(sample?.insideWindow).toBe(true);
    expect(sample?.sceneId).toBe(core.scene?.sceneId);
  });

  it('refuses to sample the pointer when it is not observing', async () => {
    const { session } = subject();
    expect(await session.samplePointer()).toStrictEqual({
      sampled: false,
      reason: 'not-observing',
    });
  });
});

describe('ObservationSession window lifecycle', () => {
  it('turns a title change into a scene revision', async () => {
    const { session, windows, core, transitions } = subject();
    await session.start(SELECTION);
    windows.replaceWindow({ ...FIXTURE_WINDOW_RETINA, title: 'Renewal' });

    expect(core.scene?.revision).toBe(1);
    expect(core.scene?.windowTitle).toBe('Renewal');
    expect(transitions.at(-1)).toMatchObject({ kind: 'revised', changes: ['title'] });
  });

  it('turns a window move into a geometry revision and re-normalises the pointer', async () => {
    const { session, windows, core, accessibility } = subject();
    await session.start(SELECTION);
    windows.replaceWindow({
      ...FIXTURE_WINDOW_RETINA,
      bounds: { ...FIXTURE_WINDOW_RETINA.bounds, x: FIXTURE_WINDOW_RETINA.bounds.x + 600 },
    });
    expect(core.scene?.revision).toBe(1);

    accessibility.setPointer({ x: 700, y: 480 });
    await session.samplePointer(FAKE_EPOCH_MS);
    // 700 screen points is now 100 points inside a window that starts at 700.
    expect(core.pointer.newest()?.pointer.normalizedPoint.x).toBeCloseTo(0, 6);
  });

  it('ignores events for windows it is not observing', async () => {
    const { session, windows, core } = subject();
    await session.start(SELECTION);
    windows.replaceWindow({ ...FIXTURE_WINDOW_SECONDARY, title: 'Something else' });
    windows.closeWindow(FIXTURE_WINDOW_SECONDARY.windowId);
    windows.notifyWindowListChanged();

    expect(core.scene?.revision).toBe(0);
    expect(session.state).toBe('observing');
    // Four, not three: PR-011 made `closeWindow` emit `window-list-changed`
    // with `disappeared` alongside `window-closed`, because a window closing
    // really does change the list. So this is window-changed, window-closed,
    // window-list-changed (from the close), and the explicit one below.
    expect(session.metrics().ignoredWindowEvents).toBe(4);
  });

  it('clears and ends the session when the selected window closes', async () => {
    const { session, windows, core, clock } = subject();
    await session.start(SELECTION);
    clock.advance(500);
    windows.closeWindow(FIXTURE_WINDOW_RETINA.windowId);

    expect(session.state).toBe('ended');
    expect(core.isEmpty()).toBe(true);
    expect(core.status().lastClear).toMatchObject({ reason: 'window-lost' });
    expect(core.lineage.episodes()[0]?.end).toMatchObject({ reason: 'window-closed' });
  });

  it('suspends on lock, waits for an explicit resume, and starts a new scene', async () => {
    const { session, windows, core, observation, clock } = subject();
    await session.start(SELECTION);
    clock.advance(500);
    observation.emitNext();
    const firstScene = core.scene?.sceneId;

    windows.lockScreen();
    expect(session.state).toBe('suspended');
    expect(core.isEmpty()).toBe(true);
    expect(session.selection?.window.windowId).toBe(FIXTURE_WINDOW_RETINA.windowId);

    windows.unlockScreen();
    expect(session.state).toBe('resumable');
    // Nothing is observed again until the caller says so.
    expect(core.scene).toBeNull();

    await session.resume();
    expect(session.state).toBe('observing');
    expect(core.scene?.sceneId).not.toBe(firstScene);
    expect(core.scene?.revision).toBe(0);
    expect(core.lineage.chain()).toHaveLength(2);
  });

  it('refuses to resume when there is nothing to resume', async () => {
    const { session } = subject();
    try {
      await session.resume();
      throw new Error('expected a throw');
    } catch (error) {
      if (!isPilotError(error)) {
        throw error;
      }
      expect(error.code).toBe('observation-disabled');
    }
  });

  it('clears the buffers and starts a new scene when the window selection changes', async () => {
    const { session, core, observation, clock } = subject();
    await session.start(SELECTION);
    clock.advance(500);
    observation.emitNext();
    const first = core.scene?.sceneId;

    await session.start({
      window: FIXTURE_WINDOW_SECONDARY,
      geometry: FIXTURE_GEOMETRY_SECONDARY,
    });
    expect(core.scene?.sceneId).not.toBe(first);
    expect(core.status().buffer.frameCount).toBe(0);
    expect(core.status().lastClear).toMatchObject({ reason: 'window-changed' });
  });
});

describe('ObservationSession content fingerprint wiring', () => {
  it('only revises the scene when a frame carries meaningfully different content', async () => {
    const fixture = createSceneLineageFixture();
    const harness = createSessionReplayHarness(fixture);
    const report = await replayFixtureThroughAdapters(harness, fixture);

    expect(report.admittedFrames).toBe(fixture.frames.length);
    expect(report.rejectedFrames).toBe(0);
    // 13 frames, two of which changed the content: the first one, and the
    // confirmation sheet opening at +1667 ms.
    expect(report.contentRevisions).toBe(2);
    const decisions = harness.frameOutcomes.map((outcome) => outcome.fingerprint?.reason);
    expect(decisions[0]).toBe('first-frame');
    expect(decisions[5]).toBe('content-changed');
    expect(decisions.filter((reason) => reason === 'below-threshold')).toHaveLength(11);
  });

  it('stamps a frame with the revision its own content established', async () => {
    const fixture = createSceneLineageFixture();
    const harness = createSessionReplayHarness(fixture);
    await replayFixtureThroughAdapters(harness, fixture, {
      until: fixture.startedAt + 1667,
    });
    const outcome = harness.frameOutcomes[5];
    expect(outcome?.transition).toMatchObject({ kind: 'revised', changes: ['content'] });
    if (outcome?.ingest.admitted !== true) {
      throw new Error('unreachable');
    }
    expect(outcome.ingest.record.sceneRevision).toBe(harness.core.scene?.revision);
  });

  it('drives the scene through the revisions the recorded events imply', async () => {
    const fixture = createSceneLineageFixture();
    const harness = createSessionReplayHarness(fixture);
    await replayFixtureThroughAdapters(harness, fixture);

    const ladder = harness.transitions
      .filter((transition) => transition.kind === 'revised')
      .map((transition) => `${String(transition.scene.revision)}:${transition.changes.join('+')}`);
    expect(ladder).toStrictEqual(['1:content', '2:content', '3:title', '4:geometry']);
    expect(harness.core.scene?.windowTitle).toBe(SCENE_FIXTURE_SECOND_TITLE);
    expect(harness.core.lineage.current?.revisions).toHaveLength(5);
  });

  it('never fingerprints a frame from a window that is not selected', async () => {
    const { session, core, clock } = subject();
    await session.start(SELECTION);
    clock.advance(100);
    const outcome = session.ingestFrame({
      frameId: asFrameId('foreign-1'),
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      capturedAt: clock.now(),
      size: FIXTURE_GEOMETRY_SECONDARY.captureSize,
      scaleFactor: 1,
      encoding: 'jpeg',
      bytes: new Uint8Array(1024),
    });

    expect(outcome.ingest).toMatchObject({ admitted: false, reason: 'foreign-window' });
    expect(outcome.fingerprint).toBeNull();
    expect(session.fingerprinter.metrics().framesExamined).toBe(0);
    expect(core.scene?.revision).toBe(0);
  });
});
