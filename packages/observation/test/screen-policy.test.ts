import { describe, expect, it } from 'vitest';
import { isPilotError, MVP_SCREEN_CONTEXT_POLICY, MVP_SCREEN_POLICY } from '@pilot/shared';
import { createFakeClock } from '@pilot/platform/fakes';
import {
  DEFAULT_SCREEN_CONTEXT_POLICY,
  defineScreenPolicy,
  toCaptureOptions,
  toContentFingerprintConfig,
  toFrameRingConfig,
  toPointerTimelineConfig,
  toScreenPolicyContract,
} from '../src/screen-policy.js';
import { ObservationCore } from '../src/observation-core.js';
import { ObservationSession } from '../src/observation-session.js';
import { RetentionGuard } from '../src/retention.js';

/**
 * PR-017: the policy is data. Everything here reads or validates the record —
 * nothing constructs a pipeline.
 */

function expectPilotError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    if (!isPilotError(error)) {
      throw error;
    }
    expect(error.code).toBe(code);
    return;
  }
  throw new Error('expected a PilotError');
}

describe('the §10 policy record', () => {
  it('carries the §10 initial values', () => {
    const policy = DEFAULT_SCREEN_CONTEXT_POLICY;
    expect(policy.capture.selectedWindowOnly).toBe(true);
    expect(policy.capture.maxRequestsPerSecond).toBe(2);
    expect(policy.image.fullFrameMaxEdge).toBe(1440);
    expect(policy.image.pointerCropPixels).toBe(640);
    expect(policy.image.jpegQuality).toBe(0.75);
    expect(policy.activeContext.maxFullFrames).toBe(1);
    expect(policy.activeContext.maxPointerCrops).toBe(1);
    expect(policy.activeContext.maxComparisonFrames).toBe(2);
    expect(policy.localBuffer.durationMs).toBe(3000);
    expect(policy.localBuffer.maxBytes).toBe(MVP_SCREEN_POLICY.ringByteLimit);
    expect(policy.localBuffer.persist).toBe(false);
  });

  it('projects onto the ScreenPolicy interface printed in the design document', () => {
    expect(toScreenPolicyContract(DEFAULT_SCREEN_CONTEXT_POLICY)).toStrictEqual(
      MVP_SCREEN_CONTEXT_POLICY,
    );
  });

  it('is frozen, so a shared limit cannot be edited at runtime', () => {
    expect(Object.isFrozen(DEFAULT_SCREEN_CONTEXT_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SCREEN_CONTEXT_POLICY.image)).toBe(true);
    expect(() => {
      // @ts-expect-error the policy is readonly; this proves it at runtime too.
      DEFAULT_SCREEN_CONTEXT_POLICY.image.fullFrameMaxEdge = 4000;
    }).toThrow(TypeError);
  });
});

describe('defineScreenPolicy', () => {
  it('returns the defaults when nothing is overridden', () => {
    expect(defineScreenPolicy()).toStrictEqual(DEFAULT_SCREEN_CONTEXT_POLICY);
  });

  it('merges overrides group by group', () => {
    const policy = defineScreenPolicy({
      capture: { maxRequestsPerSecond: 5 },
      localBuffer: { durationMs: 1500 },
    });
    expect(policy.capture.maxRequestsPerSecond).toBe(5);
    expect(policy.localBuffer.durationMs).toBe(1500);
    expect(policy.image.fullFrameMaxEdge).toBe(1440);
  });

  it('refuses to widen capture beyond the selected window', () => {
    expectPilotError(
      () => defineScreenPolicy({ capture: { selectedWindowOnly: false } }),
      'invalid-request',
    );
  });

  it('refuses to persist raw frames', () => {
    expectPilotError(
      () => defineScreenPolicy({ localBuffer: { persist: true } }),
      'invalid-request',
    );
  });

  it('refuses to forward secure field values', () => {
    expectPilotError(
      () => defineScreenPolicy({ secureContent: { withholdSecureValues: false } }),
      'invalid-request',
    );
  });

  it('rejects unusable numbers rather than silently clamping them', () => {
    expectPilotError(() => defineScreenPolicy({ image: { jpegQuality: 0 } }), 'invalid-request');
    expectPilotError(() => defineScreenPolicy({ image: { jpegQuality: 1.5 } }), 'invalid-request');
    expectPilotError(
      () => defineScreenPolicy({ image: { fullFrameMaxEdge: -1 } }),
      'invalid-request',
    );
    expectPilotError(
      () => defineScreenPolicy({ capture: { maxRequestsPerSecond: 0 } }),
      'invalid-request',
    );
    expectPilotError(
      () => defineScreenPolicy({ localBuffer: { durationMs: Number.NaN } }),
      'invalid-request',
    );
  });

  it('refuses a per-image ceiling larger than the per-observation ceiling', () => {
    expectPilotError(
      () => defineScreenPolicy({ image: { maxImageBytes: 32 * 1024 * 1024 } }),
      'invalid-request',
    );
  });
});

describe('policy projections', () => {
  it('bounds capture at the policy sample rate and full-frame edge', () => {
    expect(toCaptureOptions(DEFAULT_SCREEN_CONTEXT_POLICY)).toStrictEqual({
      sampleFps: 3,
      maxEdgePixels: 1440,
      includeCursor: false,
    });
  });

  it('bounds the ring on duration, bytes and count', () => {
    expect(toFrameRingConfig(DEFAULT_SCREEN_CONTEXT_POLICY)).toStrictEqual({
      maxAgeMs: 3000,
      maxBytes: MVP_SCREEN_POLICY.ringByteLimit,
      maxFrames: 256,
    });
  });

  it('bounds the pointer timeline and its coalescing interval', () => {
    const config = toPointerTimelineConfig(DEFAULT_SCREEN_CONTEXT_POLICY);
    expect(config.maxAgeMs).toBe(30_000);
    expect(config.minIntervalMs).toBeCloseTo(1000 / 30, 9);
  });

  it('hands the fingerprint its threshold', () => {
    expect(toContentFingerprintConfig(DEFAULT_SCREEN_CONTEXT_POLICY)).toStrictEqual({
      chunkTargetBytes: 256,
      changeThreshold: 0.15,
    });
  });
});

describe('injecting the policy into the observation engine', () => {
  it('builds the ring and the pointer timeline from the policy', () => {
    const clock = createFakeClock();
    const policy = defineScreenPolicy({
      localBuffer: { durationMs: 1500, maxBytes: 4096, maxFrames: 12, pointerDurationMs: 9000 },
    });
    const core = new ObservationCore({ clock, policy });

    expect(core.frames.maxAgeMs).toBe(1500);
    expect(core.frames.maxBytes).toBe(4096);
    expect(core.frames.maxFrames).toBe(12);
    expect(core.pointer.maxAgeMs).toBe(9000);
    expect(new RetentionGuard({ core, policy }).verifyBounds().ok).toBe(true);
  });

  it('reports a core whose bounds do not match the policy', () => {
    const clock = createFakeClock();
    const policy = defineScreenPolicy({ localBuffer: { durationMs: 1500 } });
    const core = new ObservationCore({ clock, policy, frames: { maxAgeMs: 60_000 } });
    const check = new RetentionGuard({ core, policy }).verifyBounds();

    expect(check.ok).toBe(false);
    expect(check.mismatches).toStrictEqual(['frameDurationMs: expected 1500, got 60000']);
  });

  it('starts capture with the policy capture options and the policy threshold', () => {
    const clock = createFakeClock();
    const policy = defineScreenPolicy({
      sampling: { sampleFps: 2, contentChangeThreshold: 0.4 },
      image: { fullFrameMaxEdge: 1080 },
    });
    const core = new ObservationCore({ clock, policy });
    const session = new ObservationSession({ core, clock, policy });

    expect(session.capture).toStrictEqual({
      sampleFps: 2,
      maxEdgePixels: 1080,
      includeCursor: false,
    });
    expect(session.fingerprinter.threshold).toBe(0.4);
    expect(session.policy).toBe(policy);
  });
});
