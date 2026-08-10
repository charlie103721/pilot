import { describe, expect, it } from 'vitest';
import {
  asFrameId,
  asWindowId,
  buildGroundedPointer,
  createCounterIdSource,
  createIdFactory,
  isPilotError,
  normalizedToScreen,
  screenStatusSchema,
  type CapturedFrame,
} from '@pilot/shared';
import {
  createFakeClock,
  FAKE_EPOCH_MS,
  FIXTURE_GEOMETRY_RETINA,
  FIXTURE_WINDOW_RETINA,
  FIXTURE_WINDOW_SECONDARY,
  FakeObservationAdapter,
} from '@pilot/platform/fakes';
import { CLEAR_REASONS, ObservationCore, type ClearReason } from '../src/observation-core.js';
import { toScreenStatusBuffer } from '../src/frame-ring.js';
import { createRecordedObservationFixture, replayRecordedFixture } from '../src/fixtures.js';

function core(clock = createFakeClock()) {
  return {
    clock,
    core: new ObservationCore({ clock, ids: createIdFactory(createCounterIdSource()) }),
  };
}

function frame(
  index: number,
  capturedAt: number,
  windowId = FIXTURE_WINDOW_RETINA.windowId,
): CapturedFrame {
  return {
    frameId: asFrameId(`frame-${String(index)}`),
    windowId,
    capturedAt,
    size: FIXTURE_GEOMETRY_RETINA.captureSize,
    scaleFactor: 2,
    encoding: 'jpeg',
    bytes: new Uint8Array(512),
  };
}

describe('ObservationCore ingest gating', () => {
  it('refuses frames and pointer samples while no window is selected', () => {
    const { core: subject } = core();
    expect(subject.ingestFrame(frame(0, FAKE_EPOCH_MS))).toMatchObject({
      admitted: false,
      reason: 'no-window-selected',
    });
    expect(
      subject.ingestPointer({
        at: FAKE_EPOCH_MS,
        windowId: FIXTURE_WINDOW_RETINA.windowId,
        pointer: buildGroundedPointer({ x: 0, y: 0 }, FIXTURE_GEOMETRY_RETINA),
      }),
    ).toMatchObject({ admitted: false, reason: 'no-window-selected' });
  });

  it('refuses frames from a window that is not the selected one', () => {
    const { core: subject } = core();
    subject.selectWindow(FIXTURE_WINDOW_RETINA);
    const result = subject.ingestFrame(frame(0, FAKE_EPOCH_MS, FIXTURE_WINDOW_SECONDARY.windowId));
    expect(result).toMatchObject({ admitted: false, reason: 'foreign-window' });
    expect(subject.status().buffer.frameCount).toBe(0);
  });

  it('stamps admitted frames with the scene revision in force', () => {
    const { core: subject, clock } = core();
    subject.selectWindow({ window: FIXTURE_WINDOW_RETINA, contentFingerprint: 'a' });
    const first = subject.ingestFrame(frame(0, clock.now()));
    expect(first).toMatchObject({ admitted: true });

    subject.updateScene({ contentFingerprint: 'b' });
    clock.advance(100);
    const second = subject.ingestFrame(frame(1, clock.now()));
    if (!first.admitted || !second.admitted) {
      throw new Error('unreachable');
    }
    expect(first.record.sceneRevision).toBe(0);
    expect(second.record.sceneRevision).toBe(1);
  });

  it('clears the buffers when the selected window changes', () => {
    const { core: subject, clock } = core();
    subject.selectWindow(FIXTURE_WINDOW_RETINA);
    subject.ingestFrame(frame(0, clock.now()));
    expect(subject.status().buffer.frameCount).toBe(1);

    subject.selectWindow(FIXTURE_WINDOW_SECONDARY);
    expect(subject.status().buffer.frameCount).toBe(0);
    expect(subject.status().lastClear).toMatchObject({ reason: 'window-changed' });
    expect(subject.scene?.windowId).toBe(FIXTURE_WINDOW_SECONDARY.windowId);
  });

  it('accepts frames pushed through the ObservationAdapter contract', () => {
    const { core: subject, clock } = core();
    const adapter = new FakeObservationAdapter();
    subject.selectWindow(FIXTURE_WINDOW_RETINA);
    const unsubscribe = subject.attach(adapter);

    clock.advance(2000);
    adapter.emitNext();
    adapter.emitNext();
    // Fixture frames are stamped from FAKE_EPOCH_MS at 333 ms intervals, so
    // both fall inside the 3 s ring at t=+2000.
    expect(subject.status().buffer.frameCount).toBe(2);

    unsubscribe();
    adapter.emitNext();
    expect(subject.status().buffer.frameCount).toBe(2);
  });
});

describe('ObservationCore selection', () => {
  const seeded = () => {
    const { core: subject, clock } = core();
    subject.selectWindow({ window: FIXTURE_WINDOW_RETINA, geometry: FIXTURE_GEOMETRY_RETINA });
    for (let index = 0; index < 6; index += 1) {
      subject.ingestFrame(frame(index, FAKE_EPOCH_MS + index * 333));
      subject.ingestPointer({
        at: FAKE_EPOCH_MS + index * 333,
        windowId: FIXTURE_WINDOW_RETINA.windowId,
        pointer: buildGroundedPointer(
          normalizedToScreen({ x: 0.1 * index, y: 0.5 }, FIXTURE_GEOMETRY_RETINA),
          FIXTURE_GEOMETRY_RETINA,
        ),
      });
      clock.advance(333);
    }
    return { core: subject, clock };
  };

  it('anchors a question moment to the nearest frame and pointer sample', () => {
    const { core: subject } = seeded();
    const selection = subject.selectFrame(FAKE_EPOCH_MS + 1000);
    expect(selection).toMatchObject({ found: true });
    if (!selection.found) {
      throw new Error('unreachable');
    }
    expect(selection.record.capturedAt).toBe(FAKE_EPOCH_MS + 999);
    expect(subject.requireFrame(FAKE_EPOCH_MS + 1000)).toStrictEqual(selection.record);

    const pointer = subject.selectPointer(FAKE_EPOCH_MS + 1000);
    expect(pointer).toMatchObject({ found: true, skewMs: -1 });
    expect(subject.pointerPath(FAKE_EPOCH_MS, FAKE_EPOCH_MS + 1000)).toHaveLength(4);
  });

  it('throws a typed error instead of returning undefined when no frame is usable', () => {
    const { core: subject } = seeded();
    expect(() => subject.requireFrame(FAKE_EPOCH_MS - 60_000)).toThrowError(/frame buffer|close/);
    try {
      subject.requireFrame(FAKE_EPOCH_MS - 60_000);
      throw new Error('expected a throw');
    } catch (error) {
      expect(isPilotError(error)).toBe(true);
      if (!isPilotError(error)) {
        throw error;
      }
      expect(error.code).toBe('frame-unavailable');
      expect(error.domain).toBe('observation');
      expect(error.userMessage).not.toBe('');
      expect(error.details).toMatchObject({ reason: 'out-of-range' });
    }
  });

  it('throws observation-disabled when nothing is selected', () => {
    const { core: subject } = core();
    try {
      subject.requireFrame(FAKE_EPOCH_MS);
      throw new Error('expected a throw');
    } catch (error) {
      if (!isPilotError(error)) {
        throw error;
      }
      expect(error.code).toBe('observation-disabled');
    }
    try {
      subject.requirePointer(FAKE_EPOCH_MS);
      throw new Error('expected a throw');
    } catch (error) {
      if (!isPilotError(error)) {
        throw error;
      }
      expect(error.code).toBe('observation-disabled');
    }
  });

  it('reports an explicit empty selection rather than a silent undefined', () => {
    const { core: subject } = core();
    subject.selectWindow(FIXTURE_WINDOW_RETINA);
    expect(subject.selectFrame(FAKE_EPOCH_MS)).toStrictEqual({
      found: false,
      reason: 'empty',
      nearestDistanceMs: null,
      frameCount: 0,
    });
    expect(subject.pointerPath(0, Number.MAX_SAFE_INTEGER)).toStrictEqual([]);
  });
});

describe('ObservationCore deterministic clear', () => {
  it.each([...CLEAR_REASONS])('empties every buffer for reason %s', (reason: ClearReason) => {
    const clock = createFakeClock();
    const subject = new ObservationCore({
      clock,
      ids: createIdFactory(createCounterIdSource()),
    });
    const fixture = createRecordedObservationFixture();
    replayRecordedFixture(subject, fixture, clock);

    const before = subject.status();
    expect(before.buffer.frameCount).toBeGreaterThan(0);
    expect(before.pointer.sampleCount).toBeGreaterThan(0);
    expect(before.scene).not.toBeNull();

    const result = subject.clear(reason);
    expect(result.reason).toBe(reason);
    expect(result.frames.count).toBe(before.buffer.frameCount);
    expect(result.frames.bytes).toBe(before.buffer.byteCount);
    expect(result.pointerSamples).toBe(before.pointer.sampleCount);
    expect(result.scene?.sceneId).toBe(before.scene?.sceneId);

    // Nothing is retrievable afterwards, by any route.
    expect(subject.isEmpty()).toBe(true);
    const after = subject.status();
    expect(after.scene).toBeNull();
    expect(after.buffer).toStrictEqual({
      frameCount: 0,
      byteCount: 0,
      oldestFrameAt: null,
      newestFrameAt: null,
    });
    expect(after.pointer).toStrictEqual({
      sampleCount: 0,
      oldestSampleAt: null,
      newestSampleAt: null,
    });
    expect(subject.frames.records()).toStrictEqual([]);
    expect(subject.pointer.samples()).toStrictEqual([]);
    expect(subject.pointerPath(0, Number.MAX_SAFE_INTEGER)).toStrictEqual([]);
    expect(subject.selectFrame(fixture.questionAt)).toMatchObject({
      found: false,
      reason: 'empty',
    });
    expect(subject.selectPointer(fixture.questionAt)).toMatchObject({
      found: false,
      reason: 'empty',
    });
    for (const recorded of fixture.frames) {
      expect(subject.frames.has(recorded.frameId)).toBe(false);
    }
    expect(() => subject.requireFrame(fixture.questionAt)).toThrowError();
  });

  it('is idempotent and records the reason and time', () => {
    const { core: subject, clock } = core();
    subject.selectWindow(FIXTURE_WINDOW_RETINA);
    clock.advance(1234);

    const first = subject.clear('paused');
    expect(first.at).toBe(FAKE_EPOCH_MS + 1234);
    const second = subject.clear('shutdown');
    expect(second).toMatchObject({
      reason: 'shutdown',
      frames: { count: 0, bytes: 0 },
      pointerSamples: 0,
      scene: null,
    });
    expect(subject.status().lastClear).toStrictEqual({
      reason: 'shutdown',
      at: FAKE_EPOCH_MS + 1234,
    });
    expect(subject.metrics().clears).toBe(2);
  });

  it('refuses new ingest until a window is selected again', () => {
    const { core: subject, clock } = core();
    subject.selectWindow(FIXTURE_WINDOW_RETINA);
    subject.ingestFrame(frame(0, clock.now()));
    subject.clear('screen-locked');

    expect(subject.ingestFrame(frame(1, clock.now()))).toMatchObject({
      admitted: false,
      reason: 'no-window-selected',
    });
    expect(subject.isEmpty()).toBe(true);
  });
});

describe('ObservationCore status', () => {
  it('produces a buffer snapshot the ScreenStatus contract accepts', () => {
    const clock = createFakeClock();
    const subject = new ObservationCore({
      clock,
      ids: createIdFactory(createCounterIdSource()),
    });
    const fixture = createRecordedObservationFixture();
    replayRecordedFixture(subject, fixture, clock);

    const status = screenStatusSchema.parse({
      enabled: true,
      paused: false,
      selectedWindow: FIXTURE_WINDOW_RETINA,
      scene: subject.scene,
      permissions: { screenRecording: 'granted', accessibility: 'granted' },
      buffer: toScreenStatusBuffer(subject.status().buffer),
      lastError: null,
    });
    expect(status.buffer.frameCount).toBeGreaterThan(0);
    expect(status.scene?.windowId).toBe(FIXTURE_WINDOW_RETINA.windowId);
  });

  it('exposes the window id it was constructed against', () => {
    const { core: subject } = core();
    subject.selectWindow(FIXTURE_WINDOW_RETINA);
    expect(subject.scene?.windowId).toBe(asWindowId('window-retina'));
  });
});
