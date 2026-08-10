import {
  MVP_SCREEN_POLICY,
  PilotError,
  type CaptureOptions,
  type ScreenPolicy,
} from '@pilot/shared';
import type { ContentFingerprintConfig } from './content-fingerprint.js';
import type { FrameRingConfig } from './frame-ring.js';
import type { PointerTimelineConfig } from './pointer-timeline.js';

/**
 * Screen context policy (system-design §10), as data.
 *
 * §10 prints a plain configuration object and a list of initial values. This
 * module is that object: one frozen, declarative, injectable record plus the
 * validation that keeps a hand-written override honest. Nothing here enforces
 * anything — {@link ScreenPolicyEnforcer} (policy-enforcer.ts) does that, and
 * it takes a policy rather than owning one, so PR-041 can verify the limits and
 * a test can exercise a single rule without building a pipeline.
 *
 * Relationship to `@pilot/shared`
 * ------------------------------
 * `@pilot/shared` owns the two shapes the documents print verbatim:
 * `MVP_SCREEN_POLICY` (mvp-01 §10, flat) and `ScreenPolicy` (system-design §10,
 * grouped). {@link ScreenContextPolicy} is the *enforcement* view: the same
 * numbers, grouped the same way, plus the four things §10's printed interface
 * leaves out but §14/§17 require —
 *
 * 1. `localBuffer.maxBytes` / `maxFrames` — §17 bounds ring memory to "three
 *    seconds **and a configured byte ceiling**"; §10's printed interface carries
 *    only the duration.
 * 2. `localBuffer.pointerDurationMs` — the pointer timeline outlives the frame
 *    ring by design (an utterance is longer than three seconds).
 * 3. `image.maxImageBytes` / `maxObservationBytes` — §14 requires size *and*
 *    count limits on image tool results; §10 prints only the count limits and
 *    the pixel bounds that indirectly imply size.
 * 4. `secureContent` — §10 step 4 and §14 require a redaction rule; §10's
 *    printed interface has no field for it.
 *
 * {@link toScreenPolicyContract} projects back onto the printed `ScreenPolicy`,
 * and a test asserts the projection of {@link DEFAULT_SCREEN_CONTEXT_POLICY}
 * equals `MVP_SCREEN_CONTEXT_POLICY`, so the two can never drift.
 */

/** What the redaction rule does when a secure field is in view. */
export type SecureContentMode =
  /** Mask the field's pixels and withhold its value; the observation proceeds. */
  | 'redact'
  /** Refuse the observation entirely. */
  | 'reject';

export interface ScreenContextPolicy {
  readonly capture: {
    /**
     * §9/§14: Pilot captures the selected window and never widens to a display.
     * The type admits only `true`; {@link defineScreenPolicy} also refuses a
     * `false` arriving from an untyped configuration source.
     */
    readonly selectedWindowOnly: true;
    /** §10 initial value: no more than two observation calls per second. */
    readonly maxRequestsPerSecond: number;
    /** Width of the sliding window the rate is measured over. */
    readonly rateWindowMs: number;
  };
  /** Local sampling rates. Not outgoing limits — these bound what is captured. */
  readonly sampling: {
    readonly sampleFps: number;
    readonly pointerSampleHz: number;
    /** Fraction of the encoded payload that must change to mint a revision. */
    readonly contentChangeThreshold: number;
    readonly contentChunkTargetBytes: number;
  };
  readonly image: {
    readonly fullFrameMaxEdge: number;
    readonly pointerCropPixels: number;
    /** JPEG quality in `(0, 1]`. */
    readonly jpegQuality: number;
    /** Ceiling for one encoded image, in bytes. */
    readonly maxImageBytes: number;
    /** Ceiling for every image of one observation, in bytes. */
    readonly maxObservationBytes: number;
  };
  readonly activeContext: {
    readonly maxFullFrames: number;
    readonly maxPointerCrops: number;
    readonly maxComparisonFrames: number;
  };
  readonly localBuffer: {
    readonly durationMs: number;
    readonly maxBytes: number;
    readonly maxFrames: number;
    /** Pointer retention; longer than the frame ring, because an utterance is. */
    readonly pointerDurationMs: number;
    /** Raw frames are never written to disk (§2.10, §13). Always `false`. */
    readonly persist: false;
  };
  readonly secureContent: {
    readonly onSecureTarget: SecureContentMode;
    /**
     * Refuse rather than proceed when a secure field is known to be on screen
     * but the platform did not report bounds to mask. Masking nothing and
     * claiming redaction would be a lie; see {@link SCREEN_REDACTION_CAVEAT}.
     */
    readonly requireMaskableBounds: boolean;
    /** A secure field's value never reaches the model. Always `true`. */
    readonly withholdSecureValues: true;
  };
}

/**
 * The honest statement of what redaction buys, quoted from system-design §14.
 * Every allowed decision carries it so PR-021 can put it in front of the model
 * and the user, whether or not anything was actually masked.
 */
export const SCREEN_REDACTION_CAVEAT =
  'Accessibility-based redaction is best effort: only fields the platform reports ' +
  'as secure are masked. A screenshot can still contain secrets outside recognised ' +
  'fields — treat every observation as potentially sensitive.';

/**
 * Ceiling for one encoded image. A 1440-px JPEG at quality 0.75 is a few
 * hundred kilobytes; 4 MiB only fires on a pathological encode, and it bounds
 * the base64 payload (4/3 inflation) at well under 6 MiB.
 */
export const DEFAULT_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Ceiling for one observation: two comparison frames at the per-image bound. */
export const DEFAULT_MAX_OBSERVATION_BYTES = 8 * 1024 * 1024;

/** Belt-and-braces count bound on the ring; see `frame-ring.ts`. */
export const DEFAULT_LOCAL_BUFFER_MAX_FRAMES = 256;

/**
 * Pointer retention. Long enough to cover a push-to-talk utterance and the
 * tool call that follows it, and deliberately longer than the frame ring.
 */
export const DEFAULT_POINTER_RETENTION_MS = 30_000;

/** The rate is measured per second (§10, "two observation calls per second"). */
export const DEFAULT_RATE_WINDOW_MS = 1000;

/** Fraction of the encoded payload that counts as meaningful visual change. */
export const DEFAULT_CONTENT_CHANGE_THRESHOLD_POLICY = 0.15;

export const DEFAULT_CONTENT_CHUNK_TARGET_BYTES = 256;

/**
 * The policy in force for MVP 01, at the §10 initial values.
 *
 * Frozen group by group: policy is read in many places and written in none, and
 * an accidental mutation of a shared limit is exactly the kind of privacy
 * regression that is invisible until it ships.
 */
export const DEFAULT_SCREEN_CONTEXT_POLICY: ScreenContextPolicy = Object.freeze({
  capture: Object.freeze({
    selectedWindowOnly: true as const,
    maxRequestsPerSecond: MVP_SCREEN_POLICY.maxObservationCallsPerSecond,
    rateWindowMs: DEFAULT_RATE_WINDOW_MS,
  }),
  sampling: Object.freeze({
    sampleFps: MVP_SCREEN_POLICY.sampleFps,
    pointerSampleHz: MVP_SCREEN_POLICY.pointerSampleHz,
    contentChangeThreshold: DEFAULT_CONTENT_CHANGE_THRESHOLD_POLICY,
    contentChunkTargetBytes: DEFAULT_CONTENT_CHUNK_TARGET_BYTES,
  }),
  image: Object.freeze({
    fullFrameMaxEdge: MVP_SCREEN_POLICY.fullFrameMaxEdge,
    pointerCropPixels: MVP_SCREEN_POLICY.pointerCropPixels,
    jpegQuality: MVP_SCREEN_POLICY.jpegQuality,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    maxObservationBytes: DEFAULT_MAX_OBSERVATION_BYTES,
  }),
  activeContext: Object.freeze({
    maxFullFrames: MVP_SCREEN_POLICY.maxActiveFullFrames,
    maxPointerCrops: MVP_SCREEN_POLICY.maxActivePointerCrops,
    maxComparisonFrames: MVP_SCREEN_POLICY.maxComparisonFrames,
  }),
  localBuffer: Object.freeze({
    durationMs: MVP_SCREEN_POLICY.ringDurationMs,
    maxBytes: MVP_SCREEN_POLICY.ringByteLimit,
    maxFrames: DEFAULT_LOCAL_BUFFER_MAX_FRAMES,
    pointerDurationMs: DEFAULT_POINTER_RETENTION_MS,
    persist: false as const,
  }),
  secureContent: Object.freeze({
    onSecureTarget: 'redact' as SecureContentMode,
    requireMaskableBounds: true,
    withholdSecureValues: true as const,
  }),
});

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

/**
 * Partial policy, as a settings file or a test would write it. `boolean` rather
 * than the literal types on the two invariants, so the validation below has
 * something to refuse instead of the compiler silently making the check
 * unreachable.
 */
export interface ScreenPolicyOverrides {
  readonly capture?: {
    readonly selectedWindowOnly?: boolean;
    readonly maxRequestsPerSecond?: number;
    readonly rateWindowMs?: number;
  };
  readonly sampling?: Partial<ScreenContextPolicy['sampling']>;
  readonly image?: Partial<ScreenContextPolicy['image']>;
  readonly activeContext?: Partial<ScreenContextPolicy['activeContext']>;
  readonly localBuffer?: {
    readonly durationMs?: number;
    readonly maxBytes?: number;
    readonly maxFrames?: number;
    readonly pointerDurationMs?: number;
    readonly persist?: boolean;
  };
  readonly secureContent?: {
    readonly onSecureTarget?: SecureContentMode;
    readonly requireMaskableBounds?: boolean;
    readonly withholdSecureValues?: boolean;
  };
}

function policyError(what: string, value: unknown, why: string): PilotError {
  return new PilotError('invalid-request', `Screen policy: ${what} ${why}`, {
    userMessage: 'Pilot was configured with an unusable screen policy.',
    details: { what, value },
  });
}

function positive(value: number, what: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw policyError(what, value, 'must be a positive finite number');
  }
  return value;
}

function positiveInt(value: number, what: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw policyError(what, value, 'must be a positive integer');
  }
  return value;
}

function nonNegativeInt(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw policyError(what, value, 'must be a non-negative integer');
  }
  return value;
}

function fraction(value: number, what: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw policyError(what, value, 'must be a fraction in (0, 1]');
  }
  return value;
}

/**
 * Builds a validated policy from partial overrides.
 *
 * Two values are not negotiable and are refused rather than merged:
 * `capture.selectedWindowOnly` may not be turned off (§9/§14 — widening to a
 * display is a privacy breach, not a configuration choice) and
 * `localBuffer.persist` may not be turned on (§2.10/§13 — raw frames are never
 * written to disk).
 */
export function defineScreenPolicy(overrides: ScreenPolicyOverrides = {}): ScreenContextPolicy {
  const base = DEFAULT_SCREEN_CONTEXT_POLICY;

  if (overrides.capture?.selectedWindowOnly === false) {
    throw policyError(
      'capture.selectedWindowOnly',
      false,
      'cannot be disabled — Pilot never widens capture to a whole display',
    );
  }
  if (overrides.localBuffer?.persist === true) {
    throw policyError(
      'localBuffer.persist',
      true,
      'cannot be enabled — raw frames are never written to disk',
    );
  }
  if (overrides.secureContent?.withholdSecureValues === false) {
    throw policyError(
      'secureContent.withholdSecureValues',
      false,
      'cannot be disabled — a secure field’s value never reaches the model',
    );
  }

  const mode = overrides.secureContent?.onSecureTarget ?? base.secureContent.onSecureTarget;
  if (mode !== 'redact' && mode !== 'reject') {
    throw policyError('secureContent.onSecureTarget', mode, "must be 'redact' or 'reject'");
  }

  const policy: ScreenContextPolicy = {
    capture: Object.freeze({
      selectedWindowOnly: true as const,
      maxRequestsPerSecond: positive(
        overrides.capture?.maxRequestsPerSecond ?? base.capture.maxRequestsPerSecond,
        'capture.maxRequestsPerSecond',
      ),
      rateWindowMs: positive(
        overrides.capture?.rateWindowMs ?? base.capture.rateWindowMs,
        'capture.rateWindowMs',
      ),
    }),
    sampling: Object.freeze({
      sampleFps: positive(overrides.sampling?.sampleFps ?? base.sampling.sampleFps, 'sampleFps'),
      pointerSampleHz: positive(
        overrides.sampling?.pointerSampleHz ?? base.sampling.pointerSampleHz,
        'sampling.pointerSampleHz',
      ),
      contentChangeThreshold: fraction(
        overrides.sampling?.contentChangeThreshold ?? base.sampling.contentChangeThreshold,
        'sampling.contentChangeThreshold',
      ),
      contentChunkTargetBytes: positiveInt(
        overrides.sampling?.contentChunkTargetBytes ?? base.sampling.contentChunkTargetBytes,
        'sampling.contentChunkTargetBytes',
      ),
    }),
    image: Object.freeze({
      fullFrameMaxEdge: positiveInt(
        overrides.image?.fullFrameMaxEdge ?? base.image.fullFrameMaxEdge,
        'image.fullFrameMaxEdge',
      ),
      pointerCropPixels: positiveInt(
        overrides.image?.pointerCropPixels ?? base.image.pointerCropPixels,
        'image.pointerCropPixels',
      ),
      jpegQuality: fraction(
        overrides.image?.jpegQuality ?? base.image.jpegQuality,
        'image.jpegQuality',
      ),
      maxImageBytes: positiveInt(
        overrides.image?.maxImageBytes ?? base.image.maxImageBytes,
        'image.maxImageBytes',
      ),
      maxObservationBytes: positiveInt(
        overrides.image?.maxObservationBytes ?? base.image.maxObservationBytes,
        'image.maxObservationBytes',
      ),
    }),
    activeContext: Object.freeze({
      maxFullFrames: nonNegativeInt(
        overrides.activeContext?.maxFullFrames ?? base.activeContext.maxFullFrames,
        'activeContext.maxFullFrames',
      ),
      maxPointerCrops: nonNegativeInt(
        overrides.activeContext?.maxPointerCrops ?? base.activeContext.maxPointerCrops,
        'activeContext.maxPointerCrops',
      ),
      maxComparisonFrames: nonNegativeInt(
        overrides.activeContext?.maxComparisonFrames ?? base.activeContext.maxComparisonFrames,
        'activeContext.maxComparisonFrames',
      ),
    }),
    localBuffer: Object.freeze({
      durationMs: positive(
        overrides.localBuffer?.durationMs ?? base.localBuffer.durationMs,
        'localBuffer.durationMs',
      ),
      maxBytes: positiveInt(
        overrides.localBuffer?.maxBytes ?? base.localBuffer.maxBytes,
        'localBuffer.maxBytes',
      ),
      maxFrames: positiveInt(
        overrides.localBuffer?.maxFrames ?? base.localBuffer.maxFrames,
        'localBuffer.maxFrames',
      ),
      pointerDurationMs: positive(
        overrides.localBuffer?.pointerDurationMs ?? base.localBuffer.pointerDurationMs,
        'localBuffer.pointerDurationMs',
      ),
      persist: false as const,
    }),
    secureContent: Object.freeze({
      onSecureTarget: mode,
      requireMaskableBounds:
        overrides.secureContent?.requireMaskableBounds ?? base.secureContent.requireMaskableBounds,
      withholdSecureValues: true as const,
    }),
  };

  if (policy.image.maxImageBytes > policy.image.maxObservationBytes) {
    throw policyError(
      'image.maxImageBytes',
      policy.image.maxImageBytes,
      'cannot exceed image.maxObservationBytes',
    );
  }
  return Object.freeze(policy);
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/** Capture parameters for `ObservationAdapter.start` (system-design §5). */
export function toCaptureOptions(policy: ScreenContextPolicy): CaptureOptions {
  return {
    sampleFps: policy.sampling.sampleFps,
    maxEdgePixels: policy.image.fullFrameMaxEdge,
    includeCursor: false,
  };
}

/** Retention bounds for the frame ring (§10 `localBuffer`, §17). */
export function toFrameRingConfig(policy: ScreenContextPolicy): FrameRingConfig {
  return {
    maxAgeMs: policy.localBuffer.durationMs,
    maxBytes: policy.localBuffer.maxBytes,
    maxFrames: policy.localBuffer.maxFrames,
  };
}

/** Retention bounds and coalescing interval for the pointer timeline. */
export function toPointerTimelineConfig(policy: ScreenContextPolicy): PointerTimelineConfig {
  return {
    maxAgeMs: policy.localBuffer.pointerDurationMs,
    minIntervalMs: 1000 / policy.sampling.pointerSampleHz,
  };
}

/** Tuning for the content fingerprint (PR-016 left the threshold to policy). */
export function toContentFingerprintConfig(policy: ScreenContextPolicy): ContentFingerprintConfig {
  return {
    chunkTargetBytes: policy.sampling.contentChunkTargetBytes,
    changeThreshold: policy.sampling.contentChangeThreshold,
  };
}

/**
 * Projects the enforcement policy back onto the interface printed in
 * system-design §10, so the two shapes provably carry the same numbers.
 */
export function toScreenPolicyContract(policy: ScreenContextPolicy): ScreenPolicy {
  return {
    capture: {
      selectedWindowOnly: true,
      maxRequestsPerSecond: policy.capture.maxRequestsPerSecond,
    },
    image: {
      fullFrameMaxEdge: policy.image.fullFrameMaxEdge,
      pointerCropPixels: policy.image.pointerCropPixels,
      jpegQuality: policy.image.jpegQuality,
    },
    activeContext: {
      maxFullFrames: policy.activeContext.maxFullFrames,
      maxPointerCrops: policy.activeContext.maxPointerCrops,
      maxComparisonFrames: policy.activeContext.maxComparisonFrames,
    },
    localBuffer: {
      durationMs: policy.localBuffer.durationMs,
      persist: false,
    },
  };
}
