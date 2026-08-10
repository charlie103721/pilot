import { describe, expect, it } from 'vitest';
import { asSceneId, createCounterIdSource, createIdFactory } from '@pilot/shared';
import {
  createFakeClock,
  FAKE_EPOCH_MS,
  FIXTURE_GEOMETRY_RETINA,
  FIXTURE_WINDOW_RETINA,
  FIXTURE_WINDOW_SECONDARY,
} from '@pilot/platform/fakes';
import { ObservationCore } from '../src/observation-core.js';

/**
 * Lineage is what tells a stale window selection from a stale revision of the
 * current one — the difference between "answer it, but say the screen moved"
 * and "refuse, the evidence belongs to another window".
 */

function subject(maxEpisodes?: number) {
  const clock = createFakeClock();
  const core = new ObservationCore({
    clock,
    ids: createIdFactory(createCounterIdSource()),
    ...(maxEpisodes === undefined ? {} : { lineage: { maxEpisodes } }),
  });
  return { clock, core };
}

describe('scene lineage: revision vs. scene', () => {
  it('keeps one episode across revisions of the same selection', () => {
    const { core, clock } = subject();
    core.selectWindow({ window: FIXTURE_WINDOW_RETINA, contentFingerprint: 'a' });
    clock.advance(100);
    core.updateScene({ contentFingerprint: 'b' });
    clock.advance(100);
    core.updateScene({ accessibilityRootId: 'ax-2' });

    const episodes = core.lineage.episodes();
    expect(episodes).toHaveLength(1);
    const episode = episodes[0];
    expect(episode?.latestRevision).toBe(2);
    expect(episode?.revisions.map((entry) => entry.changes)).toStrictEqual([
      [],
      ['content'],
      ['accessibility-root'],
    ]);
    expect(episode?.end).toBeNull();
  });

  it('starts a new episode when the selected window changes, and links it', () => {
    const { core } = subject();
    core.selectWindow(FIXTURE_WINDOW_RETINA);
    const first = core.scene?.sceneId;
    core.selectWindow(FIXTURE_WINDOW_SECONDARY);
    const second = core.scene?.sceneId;

    expect(first).not.toBe(second);
    const episodes = core.lineage.episodes();
    expect(episodes.map((episode) => episode.sceneId)).toStrictEqual([second, first]);
    expect(episodes[0]?.previousSceneId).toBe(first);
    expect(episodes[1]?.end).toMatchObject({ reason: 'deselected', detail: 'window-changed' });
    expect(core.lineage.chain()).toStrictEqual([second, first]);
  });

  it('records the clear reason that ended an episode', () => {
    const { core } = subject();
    core.selectWindow(FIXTURE_WINDOW_RETINA);
    core.clear('screen-locked');
    expect(core.lineage.episodes()[0]?.end).toMatchObject({
      reason: 'cleared',
      detail: 'screen-locked',
      at: FAKE_EPOCH_MS,
    });

    core.selectWindow(FIXTURE_WINDOW_RETINA);
    core.clear('window-lost');
    expect(core.lineage.episodes()[0]?.end).toMatchObject({
      reason: 'window-closed',
      detail: 'window-lost',
    });
  });

  it('re-selecting the same window is an update, not a new scene', () => {
    const { core } = subject();
    core.selectWindow({ window: FIXTURE_WINDOW_RETINA, geometry: FIXTURE_GEOMETRY_RETINA });
    const sceneId = core.scene?.sceneId;
    core.selectWindow({
      window: FIXTURE_WINDOW_RETINA,
      geometry: { ...FIXTURE_GEOMETRY_RETINA, bounds: { x: 0, y: 0, width: 800, height: 600 } },
    });
    expect(core.scene?.sceneId).toBe(sceneId);
    expect(core.lineage.episodes()).toHaveLength(1);
    expect(core.scene?.revision).toBe(1);
  });
});

describe('scene lineage: queries', () => {
  it('answers current, stale-revision, future-revision, superseded and unknown', () => {
    const { core } = subject();
    core.selectWindow({ window: FIXTURE_WINDOW_RETINA, contentFingerprint: 'a' });
    const scene = core.scene;
    if (scene === null) {
      throw new Error('unreachable');
    }
    core.updateScene({ contentFingerprint: 'b' });
    core.updateScene({ contentFingerprint: 'c' });

    expect(core.checkScene({ sceneId: scene.sceneId, revision: 2 })).toMatchObject({
      ok: true,
      status: 'current',
      revisionsBehind: 0,
      currentRevision: 2,
    });
    expect(core.checkScene({ sceneId: scene.sceneId, revision: 0 })).toMatchObject({
      ok: true,
      status: 'stale-revision',
      revisionsBehind: 2,
    });
    expect(core.checkScene({ sceneId: scene.sceneId, revision: 9 })).toMatchObject({
      ok: false,
      status: 'future-revision',
    });
    expect(core.checkScene({ sceneId: asSceneId('scene-never-seen') })).toMatchObject({
      ok: false,
      status: 'unknown',
      episode: null,
    });

    core.selectWindow(FIXTURE_WINDOW_SECONDARY);
    expect(core.checkScene({ sceneId: scene.sceneId, revision: 2 })).toMatchObject({
      ok: false,
      status: 'superseded',
    });
  });

  it('defaults a reference without a revision to the latest one', () => {
    const { core } = subject();
    core.selectWindow({ window: FIXTURE_WINDOW_RETINA, contentFingerprint: 'a' });
    core.updateScene({ contentFingerprint: 'b' });
    const scene = core.scene;
    if (scene === null) {
      throw new Error('unreachable');
    }
    expect(core.checkScene({ sceneId: scene.sceneId })).toMatchObject({
      ok: true,
      status: 'current',
    });
  });

  it('exposes individual revisions and the observed marker', () => {
    const { core, clock } = subject();
    core.selectWindow({ window: FIXTURE_WINDOW_RETINA, contentFingerprint: 'a' });
    clock.advance(250);
    core.updateScene({ contentFingerprint: 'b' });
    const scene = core.scene;
    if (scene === null) {
      throw new Error('unreachable');
    }
    core.markObserved();

    expect(core.lineage.revision(scene.sceneId, 1)).toMatchObject({
      revision: 1,
      changes: ['content'],
      at: FAKE_EPOCH_MS + 250,
    });
    expect(core.lineage.revision(scene.sceneId, 7)).toBeNull();
    expect(core.lineage.get(scene.sceneId)?.lastObservedRevision).toBe(1);
    expect(core.lineage.current?.sceneId).toBe(scene.sceneId);
  });

  it('bounds the history and reports evicted scenes as unknown', () => {
    const { core } = subject(2);
    core.selectWindow(FIXTURE_WINDOW_RETINA);
    const first = core.scene?.sceneId;
    core.selectWindow(FIXTURE_WINDOW_SECONDARY);
    core.selectWindow(FIXTURE_WINDOW_RETINA);
    core.selectWindow(FIXTURE_WINDOW_SECONDARY);

    expect(core.lineage.episodes()).toHaveLength(2);
    if (first === undefined) {
      throw new Error('unreachable');
    }
    expect(core.checkScene({ sceneId: first })).toMatchObject({ status: 'unknown' });
  });

  it('keeps the history across a clear and drops it on resetLineage', () => {
    const { core } = subject();
    core.selectWindow(FIXTURE_WINDOW_RETINA);
    const scene = core.scene;
    if (scene === null) {
      throw new Error('unreachable');
    }
    core.clear('shutdown');
    // Scene metadata only: a late result must still be rejectable by name.
    expect(core.checkScene({ sceneId: scene.sceneId })).toMatchObject({ status: 'superseded' });
    core.resetLineage();
    expect(core.checkScene({ sceneId: scene.sceneId })).toMatchObject({ status: 'unknown' });
    expect(core.lineage.current).toBeNull();
  });
});
