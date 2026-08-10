import { describe, expect, it } from 'vitest';
import {
  asFrameId,
  buildGroundedPointer,
  createCounterIdSource,
  createIdFactory,
  isPilotError,
  normalizedToScreen,
  type CapturedFrame,
  type SceneId,
} from '@pilot/shared';
import {
  createFakeClock,
  FAKE_EPOCH_MS,
  FIXTURE_GEOMETRY_RETINA,
  FIXTURE_GEOMETRY_SECONDARY,
  FIXTURE_WINDOW_RETINA,
  FIXTURE_WINDOW_SECONDARY,
} from '@pilot/platform/fakes';
import { ObservationCore } from '../src/observation-core.js';

/**
 * Window-change invalidation (system-design §10 step 3, §15).
 *
 * Ingest already refuses a foreign window's frames and a window change clears
 * the buffers. These tests cover the other side: a caller that still holds a
 * moment, a scene id or a revision from a previous selection must not be able
 * to select anything with it.
 */

function frame(index: number, capturedAt: number, windowId = FIXTURE_WINDOW_RETINA.windowId) {
  return {
    frameId: asFrameId(`inv-${String(index)}`),
    windowId,
    capturedAt,
    size: FIXTURE_GEOMETRY_RETINA.captureSize,
    scaleFactor: 2,
    encoding: 'jpeg' as const,
    bytes: new Uint8Array(512),
  } satisfies CapturedFrame;
}

function subject() {
  const clock = createFakeClock();
  const core = new ObservationCore({ clock, ids: createIdFactory(createCounterIdSource()) });
  return { clock, core };
}

/** Selects the retina window, records one frame and one pointer sample. */
function seeded() {
  const { core, clock } = subject();
  core.selectWindow({ window: FIXTURE_WINDOW_RETINA, geometry: FIXTURE_GEOMETRY_RETINA });
  core.ingestFrame(frame(0, clock.now()));
  core.ingestPointer({
    at: clock.now(),
    windowId: FIXTURE_WINDOW_RETINA.windowId,
    pointer: buildGroundedPointer(
      normalizedToScreen({ x: 0.5, y: 0.5 }, FIXTURE_GEOMETRY_RETINA),
      FIXTURE_GEOMETRY_RETINA,
    ),
  });
  const sceneId = core.scene?.sceneId;
  if (sceneId === undefined) {
    throw new Error('unreachable');
  }
  return { core, clock, sceneId };
}

describe('scene stamping', () => {
  it('stamps every admitted frame and pointer sample with the scene it belongs to', () => {
    const { core, sceneId } = seeded();
    expect(core.frames.newest()?.sceneId).toBe(sceneId);
    expect(core.frames.newest()?.sceneRevision).toBe(0);
    expect(core.pointer.newest()?.sceneId).toBe(sceneId);
  });
});

describe('selection refuses a superseded scene', () => {
  it('reports scene-mismatch rather than the new window’s pixels', () => {
    const { core, clock, sceneId } = seeded();

    clock.advance(100);
    core.selectWindow({ window: FIXTURE_WINDOW_SECONDARY, geometry: FIXTURE_GEOMETRY_SECONDARY });
    core.ingestFrame(frame(1, clock.now(), FIXTURE_WINDOW_SECONDARY.windowId));
    core.ingestPointer({
      at: clock.now(),
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      pointer: buildGroundedPointer(
        normalizedToScreen({ x: 0.5, y: 0.5 }, FIXTURE_GEOMETRY_SECONDARY),
        FIXTURE_GEOMETRY_SECONDARY,
      ),
    });

    expect(core.selectFrame(clock.now(), { scene: sceneId })).toMatchObject({
      found: false,
      reason: 'scene-mismatch',
      frameCount: 1,
    });
    expect(core.selectPointer(clock.now(), { scene: sceneId })).toMatchObject({
      found: false,
      reason: 'scene-mismatch',
    });
    expect(core.pointerPath(FAKE_EPOCH_MS, clock.now(), sceneId)).toStrictEqual([]);
    // The new selection answers normally.
    expect(core.selectFrame(clock.now())).toMatchObject({ found: true });
  });

  it('throws a typed scene-mismatch instead of a retryable frame-unavailable', () => {
    const { core, clock, sceneId } = seeded();
    clock.advance(100);
    core.selectWindow({ window: FIXTURE_WINDOW_SECONDARY, geometry: FIXTURE_GEOMETRY_SECONDARY });
    core.ingestFrame(frame(1, clock.now(), FIXTURE_WINDOW_SECONDARY.windowId));

    try {
      core.requireFrame(clock.now(), { scene: sceneId });
      throw new Error('expected a throw');
    } catch (error) {
      if (!isPilotError(error)) {
        throw error;
      }
      expect(error.code).toBe('scene-mismatch');
      expect(error.domain).toBe('observation');
      expect(error.retryable).toBe(false);
      expect(error.userMessage).not.toBe('');
    }
  });

  it('scopes to the current scene by default, so an unscoped query is safe too', () => {
    const { core, clock, sceneId } = seeded();
    clock.advance(100);
    core.selectWindow({ window: FIXTURE_WINDOW_SECONDARY, geometry: FIXTURE_GEOMETRY_SECONDARY });
    core.ingestFrame(frame(1, clock.now(), FIXTURE_WINDOW_SECONDARY.windowId));

    const selection = core.selectFrame(clock.now());
    expect(selection).toMatchObject({ found: true });
    if (!selection.found) {
      throw new Error('unreachable');
    }
    expect(selection.record.sceneId).not.toBe(sceneId);
    expect(selection.record.frame.windowId).toBe(FIXTURE_WINDOW_SECONDARY.windowId);
  });

  it('lets diagnostics opt out with scene: any', () => {
    const { core, clock } = seeded();
    clock.advance(100);
    core.selectWindow({ window: FIXTURE_WINDOW_SECONDARY, geometry: FIXTURE_GEOMETRY_SECONDARY });
    core.ingestFrame(frame(1, clock.now(), FIXTURE_WINDOW_SECONDARY.windowId));

    expect(core.selectFrame(clock.now(), { scene: 'any' })).toMatchObject({ found: true });
    expect(core.frames.records()).toHaveLength(1);
  });

  it('filters on the revision as well, for a comparison bounded to new content', () => {
    const { core, clock } = subject();
    core.selectWindow({ window: FIXTURE_WINDOW_RETINA, contentFingerprint: 'a' });
    core.ingestFrame(frame(0, clock.now()));
    clock.advance(100);
    core.updateScene({ contentFingerprint: 'b' });
    core.ingestFrame(frame(1, clock.now()));

    const after = core.selectFrame(FAKE_EPOCH_MS, { minSceneRevision: 1 });
    expect(after).toMatchObject({ found: true });
    if (!after.found) {
      throw new Error('unreachable');
    }
    expect(after.record.sceneRevision).toBe(1);
    expect(core.selectFrame(FAKE_EPOCH_MS, { minSceneRevision: 5 })).toMatchObject({
      found: false,
      reason: 'scene-mismatch',
    });
  });

  it('keeps reporting empty, not scene-mismatch, when nothing is selected', () => {
    const { core, clock } = seeded();
    core.clear('paused');
    expect(core.selectFrame(clock.now())).toMatchObject({ found: false, reason: 'empty' });
    expect(core.selectPointer(clock.now())).toMatchObject({ found: false, reason: 'empty' });
  });

  it('never answers a question anchored before a window change', () => {
    const { core, clock, sceneId } = seeded();
    const questionAt = clock.now();
    clock.advance(100);
    core.selectWindow({ window: FIXTURE_WINDOW_SECONDARY, geometry: FIXTURE_GEOMETRY_SECONDARY });
    core.ingestFrame(frame(1, clock.now(), FIXTURE_WINDOW_SECONDARY.windowId));

    const held: SceneId = sceneId;
    expect(core.checkScene({ sceneId: held, revision: 0 })).toMatchObject({
      ok: false,
      status: 'superseded',
    });
    expect(core.selectFrame(questionAt, { scene: held })).toMatchObject({
      found: false,
      reason: 'scene-mismatch',
    });
  });
});
