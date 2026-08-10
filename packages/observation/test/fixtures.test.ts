import { describe, expect, it } from 'vitest';
import { createCounterIdSource, createIdFactory } from '@pilot/shared';
import { createFakeClock, FAKE_EPOCH_MS } from '@pilot/platform/fakes';
import { ObservationCore } from '../src/observation-core.js';
import { createRecordedObservationFixture, replayRecordedFixture } from '../src/fixtures.js';

/**
 * The recorded fixture is the deterministic harness PR-016…PR-019 replay
 * against, and the demo prints exactly what these assertions check.
 */

function subject() {
  const clock = createFakeClock();
  return {
    clock,
    core: new ObservationCore({ clock, ids: createIdFactory(createCounterIdSource()) }),
  };
}

describe('recorded observation fixture', () => {
  it('is byte-identical across builds', () => {
    const first = createRecordedObservationFixture();
    const second = createRecordedObservationFixture();
    expect(first.frames.map((frame) => frame.frameId)).toStrictEqual(
      second.frames.map((frame) => frame.frameId),
    );
    expect(first.frames[4]?.bytes).toStrictEqual(second.frames[4]?.bytes);
    expect(first.startedAt).toBe(FAKE_EPOCH_MS);
    expect(first.frames).toHaveLength(13);
    expect(first.pointerSamples).toHaveLength(121);
  });

  it('replays into a core with a bounded ring and a coalesced timeline', () => {
    const { core, clock } = subject();
    const fixture = createRecordedObservationFixture();
    const report = replayRecordedFixture(core, fixture, clock);

    expect(report.admittedFrames).toBe(fixture.frames.length);
    expect(report.rejectedFrames).toBe(0);
    expect(report.coalescedPointerSamples).toBeGreaterThan(0);

    const status = core.status();
    // Only the last three seconds survive.
    expect(status.buffer.frameCount).toBe(10);
    expect(status.buffer.oldestFrameAt).toBe(FAKE_EPOCH_MS + 1000);
    expect(status.buffer.newestFrameAt).toBe(FAKE_EPOCH_MS + 4000);
    expect(status.pointer.sampleCount).toBeLessThan(fixture.pointerSamples.length);
  });

  it('drives the scene through its recorded revisions', () => {
    const { core, clock } = subject();
    const fixture = createRecordedObservationFixture();
    const report = replayRecordedFixture(core, fixture, clock);

    const kinds = report.sceneTransitions.map((transition) => transition.kind);
    expect(kinds).toStrictEqual(['started', 'revised', 'revised', 'revised']);
    expect(core.scene?.revision).toBe(3);
    expect(core.scene?.windowId).toBe(fixture.window.windowId);
  });

  it('anchors the question moment to the frame and pointer that preceded it', () => {
    const { core, clock } = subject();
    const fixture = createRecordedObservationFixture();
    replayRecordedFixture(core, fixture, clock);

    const selection = core.selectFrame(fixture.questionAt);
    expect(selection).toMatchObject({ found: true });
    if (!selection.found) {
      throw new Error('unreachable');
    }
    // 3 FPS frames land on 3000 and 3333; 3200 is closer to 3333.
    expect(selection.record.capturedAt).toBe(FAKE_EPOCH_MS + 3333);
    expect(selection.record.sceneRevision).toBe(3);

    const before = core.selectFrame(fixture.questionAt, { direction: 'at-or-before' });
    expect(before).toMatchObject({ found: true });
    if (!before.found) {
      throw new Error('unreachable');
    }
    expect(before.record.capturedAt).toBe(FAKE_EPOCH_MS + 3000);

    const pointer = core.selectPointer(fixture.questionAt);
    expect(pointer).toMatchObject({ found: true });
    if (!pointer.found) {
      throw new Error('unreachable');
    }
    expect(Math.abs(pointer.skewMs)).toBeLessThanOrEqual(34);
    expect(pointer.sample.insideWindow).toBe(true);
    expect(core.pointerPath(fixture.utteranceStartedAt, fixture.questionAt).length).toBeGreaterThan(
      0,
    );
  });

  it('stops at the requested moment when replaying part of a session', () => {
    const { core, clock } = subject();
    const fixture = createRecordedObservationFixture();
    replayRecordedFixture(core, fixture, clock, { until: fixture.startedAt + 1000 });
    expect(clock.now()).toBe(FAKE_EPOCH_MS + 1000);
    expect(core.status().buffer.newestFrameAt).toBe(FAKE_EPOCH_MS + 1000);
    expect(core.scene?.revision).toBe(0);
  });
});
