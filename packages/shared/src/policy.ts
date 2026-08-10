/**
 * Screen context policy.
 *
 * Two shapes are documented and both are exported here:
 * - {@link ScreenPolicy} — the structured interface from system-design §10,
 *   which is the type the observation engine and the policy enforcement code
 *   consume.
 * - {@link MVP_SCREEN_POLICY} — the flat constant from mvp-01 §10, reproduced
 *   verbatim. It also carries the sampling values (`sampleFps`,
 *   `pointerSampleHz`, `ringByteLimit`) that the structured interface omits.
 *
 * {@link toScreenPolicy} maps the constant onto the interface so there is one
 * source of truth for the numbers.
 */

export interface ScreenPolicy {
  capture: {
    selectedWindowOnly: true;
    maxRequestsPerSecond: number;
  };
  image: {
    fullFrameMaxEdge: number;
    pointerCropPixels: number;
    jpegQuality: number;
  };
  activeContext: {
    maxFullFrames: number;
    maxPointerCrops: number;
    maxComparisonFrames: number;
  };
  localBuffer: {
    durationMs: number;
    persist: false;
  };
}

export const MVP_SCREEN_POLICY = {
  sampleFps: 3,
  ringDurationMs: 3000,
  ringByteLimit: 16 * 1024 * 1024,
  pointerSampleHz: 30,
  fullFrameMaxEdge: 1440,
  pointerCropPixels: 640,
  jpegQuality: 0.75,
  maxObservationCallsPerSecond: 2,
  maxActiveFullFrames: 1,
  maxActivePointerCrops: 1,
  maxComparisonFrames: 2,
  persistRawFrames: false,
} as const;

export type MvpScreenPolicy = typeof MVP_SCREEN_POLICY;

export function toScreenPolicy(policy: MvpScreenPolicy = MVP_SCREEN_POLICY): ScreenPolicy {
  return {
    capture: {
      selectedWindowOnly: true,
      maxRequestsPerSecond: policy.maxObservationCallsPerSecond,
    },
    image: {
      fullFrameMaxEdge: policy.fullFrameMaxEdge,
      pointerCropPixels: policy.pointerCropPixels,
      jpegQuality: policy.jpegQuality,
    },
    activeContext: {
      maxFullFrames: policy.maxActiveFullFrames,
      maxPointerCrops: policy.maxActivePointerCrops,
      maxComparisonFrames: policy.maxComparisonFrames,
    },
    localBuffer: {
      durationMs: policy.ringDurationMs,
      persist: false,
    },
  };
}

/** The structured policy in force for MVP 01. */
export const MVP_SCREEN_CONTEXT_POLICY: ScreenPolicy = toScreenPolicy();
