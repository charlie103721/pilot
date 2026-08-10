import { describe, expect, it } from 'vitest';
import { buildGroundedPointer, normalizedToScreen } from '@pilot/shared';
import {
  createFakeClock,
  FAKE_EPOCH_MS,
  FIXTURE_ACCESSIBILITY_NODE,
  FIXTURE_GEOMETRY_RETINA,
  FIXTURE_SECURE_NODE,
} from '@pilot/platform/fakes';
import {
  DEFAULT_POINTER_MIN_INTERVAL_MS,
  PointerTimeline,
  type PointerSampleInput,
} from '../src/pointer-timeline.js';

const WINDOW_ID = FIXTURE_GEOMETRY_RETINA.windowId;

function sample(at: number, x = 0.5, y = 0.5): PointerSampleInput {
  return {
    at,
    windowId: WINDOW_ID,
    pointer: buildGroundedPointer(
      normalizedToScreen({ x, y }, FIXTURE_GEOMETRY_RETINA),
      FIXTURE_GEOMETRY_RETINA,
    ),
  };
}

describe('PointerTimeline coalescing', () => {
  it('bounds retained samples to ~30 Hz by replacing the previous sample', () => {
    const clock = createFakeClock();
    const timeline = new PointerTimeline({ clock });
    expect(timeline.minIntervalMs).toBeCloseTo(1000 / 30, 6);
    expect(DEFAULT_POINTER_MIN_INTERVAL_MS).toBeCloseTo(33.333, 3);

    // 1000 samples inside a 100 ms burst; a 30 Hz bound keeps one per bucket.
    for (let index = 0; index < 1000; index += 1) {
      const at = FAKE_EPOCH_MS + Math.floor((index * 100) / 1000);
      clock.advance(at - clock.now());
      timeline.push(sample(at, index / 1000, 0.5));
    }

    const stats = timeline.stats();
    expect(stats.sampleCount).toBe(3);
    expect(stats.sampleCount).toBeLessThanOrEqual(Math.ceil(100 / timeline.minIntervalMs));
    expect(timeline.metrics().coalesced).toBe(1000 - stats.sampleCount);
    // Coalescing keeps the newest position, never an older one.
    expect(timeline.newest()?.at).toBe(FAKE_EPOCH_MS + 99);
  });

  it('keeps every sample that is spaced at or beyond the minimum interval', () => {
    const clock = createFakeClock();
    const timeline = new PointerTimeline({ clock, minIntervalMs: 33 });
    for (let index = 0; index < 10; index += 1) {
      const at = FAKE_EPOCH_MS + index * 33;
      clock.advance(at - clock.now());
      const result = timeline.push(sample(at));
      expect(result).toMatchObject({ admitted: true, coalesced: false });
    }
    expect(timeline.stats().sampleCount).toBe(10);
  });
});

describe('PointerTimeline admission', () => {
  it('rejects a sample that precedes the newest retained one', () => {
    const clock = createFakeClock();
    const timeline = new PointerTimeline({ clock, minIntervalMs: 1 });
    clock.advance(100);
    timeline.push(sample(FAKE_EPOCH_MS + 100));

    const result = timeline.push(sample(FAKE_EPOCH_MS + 50));
    expect(result).toMatchObject({ admitted: false, reason: 'out-of-order' });
    expect(timeline.stats().sampleCount).toBe(1);
  });

  it('rejects a sample older than the retention window', () => {
    const clock = createFakeClock();
    const timeline = new PointerTimeline({ clock, maxAgeMs: 1000 });
    clock.advance(5000);
    expect(timeline.push(sample(FAKE_EPOCH_MS))).toMatchObject({
      admitted: false,
      reason: 'stale',
    });
    expect(timeline.metrics().rejected.stale).toBe(1);
  });

  it('evicts by age on read', () => {
    const clock = createFakeClock();
    const timeline = new PointerTimeline({ clock, maxAgeMs: 1000, minIntervalMs: 1 });
    timeline.push(sample(FAKE_EPOCH_MS));
    clock.advance(1001);
    expect(timeline.stats().sampleCount).toBe(0);
    expect(timeline.samples()).toStrictEqual([]);
    expect(timeline.select(FAKE_EPOCH_MS)).toMatchObject({ found: false, reason: 'empty' });
  });

  it('enforces the sample-count bound', () => {
    const clock = createFakeClock();
    const timeline = new PointerTimeline({
      clock,
      maxSamples: 5,
      minIntervalMs: 1,
      maxAgeMs: 600_000,
    });
    for (let index = 0; index < 100; index += 1) {
      clock.advance(10);
      timeline.push(sample(clock.now()));
    }
    expect(timeline.stats().sampleCount).toBe(5);
    expect(timeline.metrics().evictedByCount).toBe(95);
  });

  it('records whether the pointer was inside the window and preserves the target', () => {
    const clock = createFakeClock();
    const timeline = new PointerTimeline({ clock, minIntervalMs: 1 });

    const inside = timeline.push({
      at: FAKE_EPOCH_MS,
      windowId: WINDOW_ID,
      pointer: buildGroundedPointer(
        normalizedToScreen({ x: 0.5, y: 0.5 }, FIXTURE_GEOMETRY_RETINA),
        FIXTURE_GEOMETRY_RETINA,
        FIXTURE_ACCESSIBILITY_NODE,
      ),
    });
    expect(inside).toMatchObject({ admitted: true });
    if (!inside.admitted) {
      throw new Error('unreachable');
    }
    expect(inside.sample.insideWindow).toBe(true);
    expect(inside.sample.pointer.accessibilityTarget?.label).toBe('Auto Renew');

    clock.advance(50);
    const outside = timeline.push({
      at: clock.now(),
      windowId: WINDOW_ID,
      pointer: buildGroundedPointer(
        normalizedToScreen({ x: 1.4, y: 0.5 }, FIXTURE_GEOMETRY_RETINA),
        FIXTURE_GEOMETRY_RETINA,
        FIXTURE_SECURE_NODE,
      ),
    });
    if (!outside.admitted) {
      throw new Error('unreachable');
    }
    expect(outside.sample.insideWindow).toBe(false);
    // Secure values are dropped by `buildGroundedPointer`; the timeline must
    // not reintroduce them.
    expect(outside.sample.pointer.accessibilityTarget?.value).toBeUndefined();
  });
});

describe('PointerTimeline selection', () => {
  const setup = (): PointerTimeline => {
    const clock = createFakeClock();
    const timeline = new PointerTimeline({ clock, minIntervalMs: 1, maxAgeMs: 600_000 });
    for (let index = 0; index < 5; index += 1) {
      clock.advance(index === 0 ? 0 : 100);
      timeline.push(sample(FAKE_EPOCH_MS + index * 100));
    }
    return timeline;
  };

  it('selects the nearest sample and breaks ties towards the earlier one', () => {
    const timeline = setup();
    expect(timeline.select(FAKE_EPOCH_MS + 230)).toMatchObject({ found: true, skewMs: -30 });
    expect(timeline.select(FAKE_EPOCH_MS + 150)).toMatchObject({ found: true, skewMs: -50 });
  });

  it('reports out-of-range and no-sample-in-direction explicitly', () => {
    const timeline = setup();
    expect(timeline.select(FAKE_EPOCH_MS + 10_000, { maxSkewMs: 50 })).toMatchObject({
      found: false,
      reason: 'out-of-range',
      nearestDistanceMs: 9600,
    });
    expect(timeline.select(FAKE_EPOCH_MS - 10, { direction: 'at-or-before' })).toMatchObject({
      found: false,
      reason: 'no-sample-in-direction',
      sampleCount: 5,
    });
  });

  it('returns the pointer path over an utterance window', () => {
    const timeline = setup();
    const path = timeline.between(FAKE_EPOCH_MS + 100, FAKE_EPOCH_MS + 300);
    expect(path.map((entry) => entry.at)).toStrictEqual([
      FAKE_EPOCH_MS + 100,
      FAKE_EPOCH_MS + 200,
      FAKE_EPOCH_MS + 300,
    ]);
    expect(timeline.between(FAKE_EPOCH_MS + 300, FAKE_EPOCH_MS + 100)).toHaveLength(3);
    expect(timeline.between(FAKE_EPOCH_MS + 5000, FAKE_EPOCH_MS + 6000)).toStrictEqual([]);
  });
});

describe('PointerTimeline clear', () => {
  it('empties the timeline', () => {
    const clock = createFakeClock();
    const timeline = new PointerTimeline({ clock, minIntervalMs: 1 });
    timeline.push(sample(FAKE_EPOCH_MS));
    clock.advance(100);
    timeline.push(sample(clock.now()));

    expect(timeline.clear()).toStrictEqual({ sampleCount: 2 });
    expect(timeline.stats()).toStrictEqual({
      sampleCount: 0,
      oldestSampleAt: null,
      newestSampleAt: null,
    });
    expect(timeline.samples()).toStrictEqual([]);
    expect(timeline.newest()).toBeNull();
    expect(timeline.between(0, Number.MAX_SAFE_INTEGER)).toStrictEqual([]);
    expect(timeline.select(FAKE_EPOCH_MS)).toMatchObject({ found: false, reason: 'empty' });
  });
});
