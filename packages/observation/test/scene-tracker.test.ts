import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createIdFactory,
  isSameSceneLineage,
  isSceneObserved,
  sceneStateSchema,
} from '@pilot/shared';
import {
  createFakeClock,
  FAKE_EPOCH_MS,
  FIXTURE_GEOMETRY_RETINA,
  FIXTURE_WINDOW_RETINA,
  FIXTURE_WINDOW_SECONDARY,
} from '@pilot/platform/fakes';
import { SceneTracker, type SceneTransition } from '../src/scene-tracker.js';

function tracker(): { tracker: SceneTracker; clock: ReturnType<typeof createFakeClock> } {
  const clock = createFakeClock();
  return {
    clock,
    tracker: new SceneTracker({ clock, ids: createIdFactory(createCounterIdSource()) }),
  };
}

function sceneOf(transition: SceneTransition) {
  if (transition.kind === 'started' || transition.kind === 'revised') {
    return transition.scene;
  }
  if (transition.kind === 'unchanged') {
    return transition.scene;
  }
  throw new Error(`expected a scene, got ${transition.kind}`);
}

describe('SceneTracker identity', () => {
  it('starts at revision 0 and produces a contract-valid SceneState', () => {
    const { tracker: scenes } = tracker();
    const transition = scenes.select({
      window: FIXTURE_WINDOW_RETINA,
      geometry: FIXTURE_GEOMETRY_RETINA,
    });
    expect(transition.kind).toBe('started');
    const scene = sceneOf(transition);
    expect(scene.revision).toBe(0);
    expect(scene.windowId).toBe(FIXTURE_WINDOW_RETINA.windowId);
    expect(scene.windowTitle).toBe(FIXTURE_WINDOW_RETINA.title);
    expect(scene.updatedAt).toBe(FAKE_EPOCH_MS);
    expect(sceneStateSchema.parse(scene)).toStrictEqual(scene);
  });

  it('is idle before anything is selected', () => {
    const { tracker: scenes } = tracker();
    expect(scenes.current).toBeNull();
    expect(scenes.update({ contentFingerprint: 'x' })).toStrictEqual({ kind: 'idle' });
    expect(scenes.markObserved()).toBeNull();
    expect(scenes.end('deselected')).toStrictEqual({ kind: 'idle' });
  });

  it('mints a new scene id and resets the revision when the window changes', () => {
    const { tracker: scenes } = tracker();
    const first = sceneOf(scenes.select({ window: FIXTURE_WINDOW_RETINA }));
    scenes.update({ contentFingerprint: 'a' });
    scenes.update({ contentFingerprint: 'b' });
    expect(scenes.current?.revision).toBe(2);

    const transition = scenes.select({ window: FIXTURE_WINDOW_SECONDARY });
    expect(transition.kind).toBe('started');
    if (transition.kind !== 'started') {
      throw new Error('unreachable');
    }
    expect(transition.previous?.sceneId).toBe(first.sceneId);
    expect(transition.scene.sceneId).not.toBe(first.sceneId);
    expect(transition.scene.revision).toBe(0);
    expect(isSameSceneLineage(first, transition.scene)).toBe(false);
  });

  it('treats re-selecting the same window as an update, not a new scene', () => {
    const { tracker: scenes } = tracker();
    const first = sceneOf(scenes.select({ window: FIXTURE_WINDOW_RETINA }));
    const again = scenes.select({ window: FIXTURE_WINDOW_RETINA });
    expect(again.kind).toBe('unchanged');
    expect(sceneOf(again).sceneId).toBe(first.sceneId);
    expect(isSameSceneLineage(first, sceneOf(again))).toBe(true);
  });
});

describe('SceneTracker revisions', () => {
  it('bumps the revision for each kind of tracked change', () => {
    const { tracker: scenes, clock } = tracker();
    scenes.select({
      window: FIXTURE_WINDOW_RETINA,
      geometry: FIXTURE_GEOMETRY_RETINA,
      accessibilityRootId: 'ax-1',
      contentFingerprint: 'content-1',
    });

    clock.advance(10);
    const content = scenes.update({ contentFingerprint: 'content-2' });
    expect(content).toMatchObject({ kind: 'revised', changes: ['content'] });
    expect(sceneOf(content).revision).toBe(1);
    expect(sceneOf(content).updatedAt).toBe(FAKE_EPOCH_MS + 10);

    clock.advance(10);
    const geometry = scenes.update({
      geometry: { ...FIXTURE_GEOMETRY_RETINA, captureSize: { width: 1200, height: 800 } },
    });
    expect(geometry).toMatchObject({ kind: 'revised', changes: ['geometry'] });
    expect(sceneOf(geometry).revision).toBe(2);

    const axRoot = scenes.update({ accessibilityRootId: 'ax-2' });
    expect(axRoot).toMatchObject({ kind: 'revised', changes: ['accessibility-root'] });
    expect(sceneOf(axRoot).revision).toBe(3);

    const title = scenes.update({
      window: { ...FIXTURE_WINDOW_RETINA, title: 'Account Settings' },
    });
    expect(title).toMatchObject({ kind: 'revised', changes: ['title'] });
    expect(sceneOf(title).revision).toBe(4);
    expect(sceneOf(title).windowTitle).toBe('Account Settings');
  });

  it('reports several changes in one transition', () => {
    const { tracker: scenes } = tracker();
    scenes.select({
      window: FIXTURE_WINDOW_RETINA,
      geometry: FIXTURE_GEOMETRY_RETINA,
      accessibilityRootId: 'ax-1',
      contentFingerprint: 'content-1',
    });
    const transition = scenes.update({
      window: { ...FIXTURE_WINDOW_RETINA, title: 'Renamed' },
      contentFingerprint: 'content-2',
    });
    expect(transition).toMatchObject({ kind: 'revised', changes: ['title', 'content'] });
  });

  it('does not bump the revision, fingerprint or timestamp when nothing changed', () => {
    const { tracker: scenes, clock } = tracker();
    const started = sceneOf(
      scenes.select({ window: FIXTURE_WINDOW_RETINA, contentFingerprint: 'c' }),
    );
    clock.advance(5000);
    const transition = scenes.update({ contentFingerprint: 'c' });
    expect(transition.kind).toBe('unchanged');
    const scene = sceneOf(transition);
    expect(scene.revision).toBe(0);
    expect(scene.fingerprint).toBe(started.fingerprint);
    expect(scene.updatedAt).toBe(FAKE_EPOCH_MS);
  });

  it('moves the fingerprint whenever the revision moves', () => {
    const { tracker: scenes } = tracker();
    const first = sceneOf(scenes.select({ window: FIXTURE_WINDOW_RETINA }));
    const second = sceneOf(scenes.update({ contentFingerprint: 'moved' }));
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.fingerprint).toMatch(/^sc_[0-9a-f]{8}$/);
  });
});

describe('SceneTracker observation marking', () => {
  it('tracks whether the model has seen the current revision', () => {
    const { tracker: scenes } = tracker();
    scenes.select({ window: FIXTURE_WINDOW_RETINA });
    expect(isSceneObserved(scenes.current!)).toBe(false);

    const observed = scenes.markObserved();
    expect(observed).not.toBeNull();
    expect(isSceneObserved(observed!)).toBe(true);
    expect(sceneStateSchema.parse(observed)).toStrictEqual(observed);

    scenes.update({ contentFingerprint: 'changed' });
    expect(isSceneObserved(scenes.current!)).toBe(false);
    expect(scenes.current?.lastObservedRevision).toBe(0);
  });
});

describe('SceneTracker end', () => {
  it('ends the scene and reports what was dropped', () => {
    const { tracker: scenes } = tracker();
    const started = sceneOf(scenes.select({ window: FIXTURE_WINDOW_RETINA }));
    const ended = scenes.end('window-closed');
    expect(ended).toStrictEqual({ kind: 'ended', previous: started, reason: 'window-closed' });
    expect(scenes.current).toBeNull();
    expect(scenes.signals).toBeNull();
    expect(scenes.end('window-closed')).toStrictEqual({ kind: 'idle' });
  });

  it('mints a fresh scene id after a clear so old results fail lineage checks', () => {
    const { tracker: scenes } = tracker();
    const first = sceneOf(scenes.select({ window: FIXTURE_WINDOW_RETINA }));
    scenes.clear();
    const second = sceneOf(scenes.select({ window: FIXTURE_WINDOW_RETINA }));
    expect(second.sceneId).not.toBe(first.sceneId);
    expect(isSameSceneLineage(first, second)).toBe(false);
  });
});
