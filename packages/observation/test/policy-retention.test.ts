import { describe, expect, it } from 'vitest';
import { isPilotError } from '@pilot/shared';
import { createFakeClock } from '@pilot/platform/fakes';
import { ObservationCore } from '../src/observation-core.js';
import { ObservationRateLimiter } from '../src/observation-rate.js';
import {
  RETENTION_CLEAR_REASON,
  RETENTION_EVENTS,
  RetentionGuard,
  type RetentionClearReport,
  type RetentionEvent,
} from '../src/retention.js';
import { DEFAULT_SCREEN_CONTEXT_POLICY, defineScreenPolicy } from '../src/screen-policy.js';
import { createRecordedObservationFixture, replayRecordedFixture } from '../src/fixtures.js';

/**
 * PR-017 retention (§10 `localBuffer`, §14): the local buffer is bounded on
 * duration and bytes, and it is cleared on pause, lock, window loss and
 * shutdown. Every one of the four is exercised here, and the guard's
 * post-condition is what makes "cleared" mean "nothing is left".
 */

function primed(policy = DEFAULT_SCREEN_CONTEXT_POLICY) {
  const fixture = createRecordedObservationFixture();
  const clock = createFakeClock(fixture.startedAt);
  const core = new ObservationCore({ clock, policy });
  const rateLimiter = new ObservationRateLimiter({ clock, policy });
  const reports: RetentionClearReport[] = [];
  const guard = new RetentionGuard({
    core,
    policy,
    rateLimiter,
    onClear: (report) => reports.push(report),
  });
  replayRecordedFixture(core, fixture, clock, { until: fixture.questionAt });
  return { fixture, clock, core, guard, rateLimiter, reports };
}

describe('local buffer bounds', () => {
  it('holds no more than the policy duration of frames', () => {
    const { core, fixture } = primed();
    const stats = core.status().buffer;
    const span = (stats.newestFrameAt ?? 0) - (stats.oldestFrameAt ?? 0);

    expect(stats.frameCount).toBeGreaterThan(0);
    expect(span).toBeLessThanOrEqual(DEFAULT_SCREEN_CONTEXT_POLICY.localBuffer.durationMs);
    expect(stats.byteCount).toBeLessThanOrEqual(DEFAULT_SCREEN_CONTEXT_POLICY.localBuffer.maxBytes);
    expect(fixture.frames.length).toBeGreaterThan(stats.frameCount);
  });

  it('honours a byte ceiling that bites before the duration does', () => {
    const policy = defineScreenPolicy({ localBuffer: { maxBytes: 8192 } });
    const { core } = primed(policy);

    expect(core.status().buffer.byteCount).toBeLessThanOrEqual(8192);
    expect(core.metrics().frames.evictedByBytes).toBeGreaterThan(0);
    expect(core.metrics().frames.peakByteCount).toBeLessThanOrEqual(8192);
  });
});

describe('clearing for each policy event', () => {
  it.each(['pause', 'screen-lock', 'window-loss', 'shutdown'] as const)(
    'clears every buffer on %s',
    (event) => {
      const { core, guard } = primed();
      expect(core.isEmpty()).toBe(false);

      const report = guard.clearFor(event);

      expect(report.reason).toBe(RETENTION_CLEAR_REASON[event]);
      expect(report.clearedFrames).toBeGreaterThan(0);
      expect(report.clearedBytes).toBeGreaterThan(0);
      expect(report.clearedPointerSamples).toBeGreaterThan(0);
      expect(report.empty).toBe(true);
      expect(core.isEmpty()).toBe(true);
      expect(core.status().buffer.byteCount).toBe(0);
      expect(core.selectFrame(0, { scene: 'any' }).found).toBe(false);
    },
  );

  it('maps every policy event to a core clear reason', () => {
    for (const event of RETENTION_EVENTS) {
      expect(RETENTION_CLEAR_REASON[event as RetentionEvent]).toBeDefined();
    }
  });

  it('keeps the scene lineage on a pause or a lock, so a late result is refused', () => {
    const { core, guard } = primed();
    const sceneId = core.scene?.sceneId;
    guard.clearFor('screen-lock');

    expect(sceneId).toBeDefined();
    expect(core.checkScene({ sceneId: sceneId! })).toMatchObject({
      ok: false,
      status: 'superseded',
    });
  });

  it('drops the scene lineage on shutdown and logout', () => {
    const { core, guard } = primed();
    const sceneId = core.scene?.sceneId;
    const report = guard.clearFor('shutdown');

    expect(report.lineageReset).toBe(true);
    expect(core.lineage.episodes()).toHaveLength(0);
    expect(core.checkScene({ sceneId: sceneId! })).toMatchObject({
      ok: false,
      status: 'unknown',
    });
  });

  it('resets the observation rate limit alongside the buffers', () => {
    const { clock, guard, rateLimiter } = primed();
    rateLimiter.take(clock.now());
    rateLimiter.take(clock.now());
    expect(rateLimiter.check(clock.now()).allowed).toBe(false);

    guard.clearFor('pause');
    expect(rateLimiter.check(clock.now()).allowed).toBe(true);
  });

  it('reports each clear to the caller without any frame content', () => {
    const { guard, reports } = primed();
    guard.clearFor('window-loss');

    expect(reports).toHaveLength(1);
    expect(Object.keys(reports[0]!).sort()).toStrictEqual([
      'at',
      'clearedBytes',
      'clearedFrames',
      'clearedPointerSamples',
      'empty',
      'event',
      'lineageReset',
      'reason',
      'sceneEnded',
    ]);
  });

  it('throws rather than reporting a clear that did not empty the buffers', () => {
    // A core whose clear leaves something behind is a defect, not a warning:
    // "the clear was called" is not the same claim as "nothing is retained".
    const brokenCore = {
      clear: () => ({
        reason: 'paused' as const,
        at: 0,
        frames: { count: 2, bytes: 2048 },
        pointerSamples: 5,
        scene: null,
      }),
      resetLineage: () => undefined,
      isEmpty: () => false,
      status: () => ({
        scene: null,
        buffer: { frameCount: 2, byteCount: 2048, oldestFrameAt: 0, newestFrameAt: 1 },
        pointer: { sampleCount: 5, oldestSampleAt: 0, newestSampleAt: 1 },
        lastClear: null,
      }),
    } as unknown as ObservationCore;
    const brokenGuard = new RetentionGuard({ core: brokenCore });

    try {
      brokenGuard.clearFor('pause');
      throw new Error('expected a throw');
    } catch (error) {
      if (!isPilotError(error)) {
        throw error;
      }
      expect(error.code).toBe('internal');
      expect(error.details).toMatchObject({ event: 'pause', frameCount: 2 });
    }
  });
});
