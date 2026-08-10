import { describe, expect, it } from 'vitest';
import {
  asFrameId,
  buildGroundedPointer,
  createCounterIdSource,
  createIdFactory,
  MVP_SCREEN_POLICY,
  normalizedToScreen,
  type CapturedFrame,
} from '@pilot/shared';
import {
  createFakeClock,
  FAKE_EPOCH_MS,
  FIXTURE_GEOMETRY_RETINA,
  FIXTURE_WINDOW_RETINA,
} from '@pilot/platform/fakes';
import { ObservationCore } from '../src/observation-core.js';

/**
 * Buffer bounds must hold under sustained pressure: the observation core is
 * the only thing standing between a 3 FPS capture stream and unbounded memory
 * growth in the main process (system-design §17).
 *
 * The payload here is deliberately far larger and far faster than the policy
 * allows, so a missing bound shows up as a failure rather than as a slow leak
 * in production.
 */

const FRAME_BYTES = 16 * 1024;

function frame(index: number, capturedAt: number): CapturedFrame {
  return {
    frameId: asFrameId(`stress-${String(index)}`),
    windowId: FIXTURE_WINDOW_RETINA.windowId,
    capturedAt,
    size: FIXTURE_GEOMETRY_RETINA.captureSize,
    scaleFactor: 2,
    encoding: 'jpeg',
    bytes: new Uint8Array(FRAME_BYTES),
  };
}

describe('observation buffer bounds under load', () => {
  it('holds the age, byte and count bounds across 20k frames at 60 FPS', () => {
    const clock = createFakeClock();
    const core = new ObservationCore({
      clock,
      ids: createIdFactory(createCounterIdSource()),
    });
    core.selectWindow(FIXTURE_WINDOW_RETINA);

    const pushes = 20_000;
    for (let index = 0; index < pushes; index += 1) {
      clock.advance(16);
      const result = core.ingestFrame(frame(index, clock.now()));
      expect(result.admitted).toBe(true);

      const stats = core.status().buffer;
      expect(stats.byteCount).toBeLessThanOrEqual(core.frames.maxBytes);
      expect(stats.frameCount).toBeLessThanOrEqual(core.frames.maxFrames);
      if (stats.oldestFrameAt !== null && stats.newestFrameAt !== null) {
        expect(stats.newestFrameAt - stats.oldestFrameAt).toBeLessThanOrEqual(core.frames.maxAgeMs);
      }
    }

    const metrics = core.metrics().frames;
    expect(metrics.admitted).toBe(pushes);
    expect(metrics.peakByteCount).toBeLessThanOrEqual(MVP_SCREEN_POLICY.ringByteLimit);
    expect(metrics.peakFrameCount).toBeLessThanOrEqual(core.frames.maxFrames);
    // 60 FPS × 3 s = 188 frames of 16 KiB — under both the 256-frame and the
    // 16 MiB bounds — so age is what bounds this run, and every frame is
    // either retained or accounted for as evicted.
    expect(metrics.evictedByAge).toBeGreaterThan(0);
    expect(metrics.evictedByBytes).toBe(0);
    expect(metrics.evictedByCount).toBe(0);
    expect(metrics.evictedByAge + core.status().buffer.frameCount).toBe(pushes);
  });

  it('holds the byte bound when frames are large enough to hit it first', () => {
    const clock = createFakeClock();
    const core = new ObservationCore({
      clock,
      ids: createIdFactory(createCounterIdSource()),
      frames: { maxBytes: 1024 * 1024, maxAgeMs: 60_000, maxFrames: 10_000 },
    });
    core.selectWindow(FIXTURE_WINDOW_RETINA);

    for (let index = 0; index < 5000; index += 1) {
      clock.advance(1);
      core.ingestFrame(frame(index, clock.now()));
    }
    const retained = Math.floor((1024 * 1024) / FRAME_BYTES);
    const stats = core.status().buffer;
    expect(stats.byteCount).toBeLessThanOrEqual(1024 * 1024);
    expect(stats.frameCount).toBe(retained);
    expect(core.metrics().frames.evictedByBytes).toBe(5000 - retained);
  });

  it('bounds the pointer timeline under a 1 kHz feed', () => {
    const clock = createFakeClock();
    const core = new ObservationCore({
      clock,
      ids: createIdFactory(createCounterIdSource()),
    });
    core.selectWindow(FIXTURE_WINDOW_RETINA);

    const seconds = 120;
    for (let index = 0; index < seconds * 1000; index += 1) {
      clock.advance(1);
      core.ingestPointer({
        at: clock.now(),
        windowId: FIXTURE_WINDOW_RETINA.windowId,
        pointer: buildGroundedPointer(
          normalizedToScreen({ x: (index % 100) / 100, y: 0.5 }, FIXTURE_GEOMETRY_RETINA),
          FIXTURE_GEOMETRY_RETINA,
        ),
      });
    }

    const stats = core.status().pointer;
    // 30 s retention at 30 Hz ≈ 900 samples, never 120 000.
    expect(stats.sampleCount).toBeLessThanOrEqual(
      Math.ceil((core.pointer.maxAgeMs / 1000) * MVP_SCREEN_POLICY.pointerSampleHz) + 5,
    );
    expect(core.metrics().pointer.peakSampleCount).toBeLessThanOrEqual(core.pointer.maxSamples);
    if (stats.oldestSampleAt !== null && stats.newestSampleAt !== null) {
      expect(stats.newestSampleAt - stats.oldestSampleAt).toBeLessThanOrEqual(
        core.pointer.maxAgeMs,
      );
    }
    expect(stats.newestSampleAt).toBe(FAKE_EPOCH_MS + seconds * 1000);
  });
});
