import { describe, expect, it } from 'vitest';
import { asFrameId, asWindowId, type CapturedFrame } from '@pilot/shared';
import { createFakeClock, FAKE_EPOCH_MS } from '@pilot/platform/fakes';
import {
  DEFAULT_FRAME_MAX_AGE_MS,
  DEFAULT_FRAME_MAX_BYTES,
  FrameRing,
  toScreenStatusBuffer,
} from '../src/frame-ring.js';

const WINDOW_ID = asWindowId('window-retina');

function frame(index: number, capturedAt: number, byteLength = 1024): CapturedFrame {
  return {
    frameId: asFrameId(`frame-${String(index).padStart(4, '0')}`),
    windowId: WINDOW_ID,
    capturedAt,
    size: { width: 2400, height: 1600 },
    scaleFactor: 2,
    encoding: 'jpeg',
    bytes: new Uint8Array(byteLength),
  };
}

describe('FrameRing bounds', () => {
  it('defaults to the policy age and byte bounds', () => {
    const ring = new FrameRing({ clock: createFakeClock() });
    expect(ring.maxAgeMs).toBe(DEFAULT_FRAME_MAX_AGE_MS);
    expect(ring.maxAgeMs).toBe(3000);
    expect(ring.maxBytes).toBe(DEFAULT_FRAME_MAX_BYTES);
    expect(ring.maxBytes).toBe(16 * 1024 * 1024);
  });

  it('rejects an unusable bound instead of silently defaulting', () => {
    expect(() => new FrameRing({ clock: createFakeClock(), maxAgeMs: 0 })).toThrowError(
      /maxAgeMs must be a positive/,
    );
  });
});

describe('FrameRing time-based eviction', () => {
  it('evicts frames older than the age bound when time advances', () => {
    const clock = createFakeClock();
    const ring = new FrameRing({ clock, maxAgeMs: 3000 });

    for (let index = 0; index < 9; index += 1) {
      ring.push(frame(index, clock.now()));
      clock.advance(333);
    }
    expect(ring.stats().frameCount).toBe(9);

    // Push nothing; just move past the age bound for the first four frames.
    clock.advance(1000);
    const stats = ring.stats();
    expect(stats.frameCount).toBe(6);
    expect(stats.oldestFrameAt).toBe(FAKE_EPOCH_MS + 3 * 333);
  });

  it('evicts on read as well as on write, so an aged frame is never retrievable', () => {
    const clock = createFakeClock();
    const ring = new FrameRing({ clock, maxAgeMs: 1000 });
    const first = frame(0, clock.now());
    ring.push(first);
    expect(ring.has(first.frameId)).toBe(true);

    clock.advance(1001);
    expect(ring.has(first.frameId)).toBe(false);
    expect(ring.records()).toHaveLength(0);
    expect(ring.newest()).toBeNull();
    expect(ring.oldest()).toBeNull();
    expect(ring.select(FAKE_EPOCH_MS)).toMatchObject({ found: false, reason: 'empty' });
    expect(ring.metrics().evictedByAge).toBe(1);
  });

  it('refuses a frame that is already older than the age bound', () => {
    const clock = createFakeClock();
    const ring = new FrameRing({ clock, maxAgeMs: 1000 });
    clock.advance(5000);

    const result = ring.push(frame(0, FAKE_EPOCH_MS));
    expect(result.admitted).toBe(false);
    expect(result).toMatchObject({ reason: 'stale' });
    expect(ring.stats().frameCount).toBe(0);
    expect(ring.metrics().rejected.stale).toBe(1);
  });
});

describe('FrameRing byte-based eviction', () => {
  it('evicts oldest frames until the byte bound holds', () => {
    const clock = createFakeClock();
    const ring = new FrameRing({ clock, maxBytes: 3000, maxAgeMs: 60_000 });

    ring.push(frame(0, clock.now(), 1000));
    clock.advance(100);
    ring.push(frame(1, clock.now(), 1000));
    clock.advance(100);
    ring.push(frame(2, clock.now(), 1000));
    expect(ring.stats()).toMatchObject({ frameCount: 3, byteCount: 3000 });

    clock.advance(100);
    const result = ring.push(frame(3, clock.now(), 1000));
    expect(result.admitted).toBe(true);
    expect(result).toMatchObject({ evicted: { byBytes: 1, bytes: 1000 } });

    const stats = ring.stats();
    expect(stats.frameCount).toBe(3);
    expect(stats.byteCount).toBe(3000);
    expect(stats.byteCount).toBeLessThanOrEqual(ring.maxBytes);
    expect(ring.records()[0]?.frame.frameId).toBe('frame-0001');
  });

  it('evicts several frames at once for a large arrival', () => {
    const clock = createFakeClock();
    const ring = new FrameRing({ clock, maxBytes: 4000, maxAgeMs: 60_000 });
    for (let index = 0; index < 4; index += 1) {
      ring.push(frame(index, clock.now(), 1000));
      clock.advance(10);
    }
    const result = ring.push(frame(4, clock.now(), 3500));
    expect(result).toMatchObject({ admitted: true, evicted: { byBytes: 4, bytes: 4000 } });
    expect(ring.stats()).toMatchObject({ frameCount: 1, byteCount: 3500 });
    expect(ring.stats().byteCount).toBeLessThanOrEqual(4000);
  });

  it('refuses a frame larger than the whole budget rather than emptying the ring', () => {
    const clock = createFakeClock();
    const ring = new FrameRing({ clock, maxBytes: 2000, maxAgeMs: 60_000 });
    ring.push(frame(0, clock.now(), 1000));

    const result = ring.push(frame(1, clock.now(), 4000));
    expect(result).toMatchObject({ admitted: false, reason: 'too-large' });
    expect(ring.stats().frameCount).toBe(1);
  });

  it('enforces the frame-count bound', () => {
    const clock = createFakeClock();
    const ring = new FrameRing({ clock, maxFrames: 3, maxAgeMs: 60_000 });
    for (let index = 0; index < 10; index += 1) {
      ring.push(frame(index, clock.now(), 8));
      clock.advance(10);
    }
    expect(ring.stats().frameCount).toBe(3);
    expect(ring.metrics().evictedByCount).toBe(7);
  });

  it('rejects an empty payload and a duplicate frame id', () => {
    const clock = createFakeClock();
    const ring = new FrameRing({ clock });
    expect(ring.push(frame(0, clock.now(), 0))).toMatchObject({
      admitted: false,
      reason: 'empty-bytes',
    });
    ring.push(frame(1, clock.now()));
    expect(ring.push(frame(1, clock.now()))).toMatchObject({
      admitted: false,
      reason: 'duplicate',
    });
    expect(ring.stats().frameCount).toBe(1);
  });
});

describe('FrameRing nearest-frame selection', () => {
  const setup = (): FrameRing => {
    const clock = createFakeClock();
    const ring = new FrameRing({ clock, maxAgeMs: 60_000 });
    // Frames at +0, +100, +200, +300, +400.
    for (let index = 0; index < 5; index += 1) {
      ring.push(frame(index, FAKE_EPOCH_MS + index * 100), { sceneRevision: index });
    }
    return ring;
  };

  it('selects the closest frame to the requested moment', () => {
    const ring = setup();
    const selection = ring.select(FAKE_EPOCH_MS + 220);
    expect(selection.found).toBe(true);
    if (!selection.found) {
      throw new Error('unreachable');
    }
    expect(selection.record.capturedAt).toBe(FAKE_EPOCH_MS + 200);
    expect(selection.skewMs).toBe(-20);
    expect(selection.distanceMs).toBe(20);
    expect(selection.record.sceneRevision).toBe(2);
  });

  it('breaks an exact tie towards the earlier frame', () => {
    const ring = setup();
    const selection = ring.select(FAKE_EPOCH_MS + 150);
    expect(selection.found).toBe(true);
    if (!selection.found) {
      throw new Error('unreachable');
    }
    expect(selection.record.capturedAt).toBe(FAKE_EPOCH_MS + 100);
    expect(selection.skewMs).toBe(-50);
    expect(selection.distanceMs).toBe(50);
  });

  it('returns an exact hit with zero skew', () => {
    const ring = setup();
    const selection = ring.select(FAKE_EPOCH_MS + 300);
    expect(selection).toMatchObject({ found: true, skewMs: 0, distanceMs: 0 });
  });

  it('honours direction for before-and-after selection', () => {
    const ring = setup();
    const before = ring.select(FAKE_EPOCH_MS + 250, { direction: 'at-or-before' });
    const after = ring.select(FAKE_EPOCH_MS + 250, { direction: 'at-or-after' });
    expect(before).toMatchObject({ found: true });
    expect(after).toMatchObject({ found: true });
    if (!before.found || !after.found) {
      throw new Error('unreachable');
    }
    expect(before.record.capturedAt).toBe(FAKE_EPOCH_MS + 200);
    expect(after.record.capturedAt).toBe(FAKE_EPOCH_MS + 300);
  });

  it('reports no-frame-in-direction rather than an unrelated frame', () => {
    const ring = setup();
    const selection = ring.select(FAKE_EPOCH_MS - 1000, { direction: 'at-or-before' });
    expect(selection).toMatchObject({
      found: false,
      reason: 'no-frame-in-direction',
      nearestDistanceMs: null,
      frameCount: 5,
    });
  });

  it('reports out-of-range with the distance it found', () => {
    const ring = setup();
    const selection = ring.select(FAKE_EPOCH_MS + 5000, { maxSkewMs: 100 });
    expect(selection).toMatchObject({
      found: false,
      reason: 'out-of-range',
      nearestDistanceMs: 4600,
      frameCount: 5,
    });
  });

  it('defaults maxSkewMs to the age bound', () => {
    const clock = createFakeClock();
    const ring = new FrameRing({ clock, maxAgeMs: 3000 });
    ring.push(frame(0, FAKE_EPOCH_MS));
    expect(ring.select(FAKE_EPOCH_MS + 2999)).toMatchObject({ found: true });
    expect(ring.select(FAKE_EPOCH_MS + 3001)).toMatchObject({
      found: false,
      reason: 'out-of-range',
    });
    expect(
      ring.select(FAKE_EPOCH_MS + 3001, { maxSkewMs: Number.POSITIVE_INFINITY }),
    ).toMatchObject({ found: true });
  });

  it('reports empty on an empty ring instead of undefined', () => {
    const ring = new FrameRing({ clock: createFakeClock() });
    const selection = ring.select(FAKE_EPOCH_MS);
    expect(selection).toStrictEqual({
      found: false,
      reason: 'empty',
      nearestDistanceMs: null,
      frameCount: 0,
    });
  });

  it('keeps ordering when frames arrive out of order', () => {
    const clock = createFakeClock();
    const ring = new FrameRing({ clock, maxAgeMs: 60_000 });
    ring.push(frame(0, FAKE_EPOCH_MS + 300));
    ring.push(frame(1, FAKE_EPOCH_MS + 100));
    ring.push(frame(2, FAKE_EPOCH_MS + 200));
    expect(ring.records().map((record) => record.capturedAt)).toStrictEqual([
      FAKE_EPOCH_MS + 100,
      FAKE_EPOCH_MS + 200,
      FAKE_EPOCH_MS + 300,
    ]);
    const selection = ring.select(FAKE_EPOCH_MS + 190);
    expect(selection).toMatchObject({ found: true, skewMs: 10 });
  });
});

describe('FrameRing clear', () => {
  it('empties content and leaves nothing retrievable', () => {
    const clock = createFakeClock();
    const ring = new FrameRing({ clock, maxAgeMs: 60_000 });
    const first = frame(0, FAKE_EPOCH_MS);
    ring.push(first);
    ring.push(frame(1, FAKE_EPOCH_MS + 100));

    const dropped = ring.clear();
    expect(dropped).toStrictEqual({ frameCount: 2, byteCount: 2048 });
    expect(ring.stats()).toStrictEqual({
      frameCount: 0,
      byteCount: 0,
      oldestFrameAt: null,
      newestFrameAt: null,
    });
    expect(ring.records()).toStrictEqual([]);
    expect(ring.has(first.frameId)).toBe(false);
    expect(ring.select(FAKE_EPOCH_MS)).toMatchObject({ found: false, reason: 'empty' });
    expect(ring.metrics().clears).toBe(1);
  });
});

describe('toScreenStatusBuffer', () => {
  it('projects onto the ScreenStatus.buffer shape', () => {
    const clock = createFakeClock();
    const ring = new FrameRing({ clock, maxAgeMs: 60_000 });
    ring.push(frame(0, FAKE_EPOCH_MS + 0.6));
    expect(toScreenStatusBuffer(ring.stats())).toStrictEqual({
      frameCount: 1,
      byteCount: 1024,
      oldestFrameAt: FAKE_EPOCH_MS,
      newestFrameAt: FAKE_EPOCH_MS,
    });
    expect(
      toScreenStatusBuffer({
        frameCount: 0,
        byteCount: 0,
        oldestFrameAt: null,
        newestFrameAt: null,
      }),
    ).toMatchObject({ oldestFrameAt: null, newestFrameAt: null });
  });
});
