import { z } from 'zod';
import { serializedPilotErrorSchema } from './errors.js';
import {
  isInsideWindow,
  normalizedPointSchema,
  normalizedRectSchema,
  pixelPointSchema,
  screenPointSchema,
  screenRectSchema,
  screenToCapturedPixel,
  screenToNormalized,
  type NormalizedPoint,
  type PixelSize,
  type ScreenPoint,
  type WindowGeometry,
} from './geometry.js';
import {
  displayIdSchema,
  observationIdSchema,
  sceneIdSchema,
  windowIdSchema,
  type FrameId,
  type SceneId,
  type WindowId,
} from './ids.js';
import { permissionStateSchema } from './permissions.js';
import { sceneStateSchema } from './scene.js';

/** A window that can be selected for observation. */
export const observedWindowSchema = z.strictObject({
  windowId: windowIdSchema,
  displayId: displayIdSchema,
  title: z.string(),
  applicationName: z.string(),
  applicationBundleId: z.string().optional(),
  /** Window frame in global screen points. */
  bounds: screenRectSchema,
  scaleFactor: z.number().finite().positive(),
  isOnScreen: z.boolean(),
});

export type ObservedWindow = z.infer<typeof observedWindowSchema>;

/** Capture parameters handed to the platform adapter. Bounded by the screen policy. */
export const captureOptionsSchema = z.strictObject({
  sampleFps: z.number().finite().positive(),
  /** Longest edge in captured pixels; the adapter must not exceed it. */
  maxEdgePixels: z.number().int().positive(),
  includeCursor: z.boolean(),
});

export type CaptureOptions = z.infer<typeof captureOptionsSchema>;

export const FRAME_ENCODINGS = ['jpeg', 'png', 'bgra'] as const;
export type FrameEncoding = (typeof FRAME_ENCODINGS)[number];

/**
 * One captured frame.
 *
 * `bytes` never crosses the IPC envelope schemas and must never be logged;
 * there is deliberately no zod schema for it. Frames are memory-only
 * (system-design §13).
 */
export interface CapturedFrame {
  readonly frameId: FrameId;
  readonly windowId: WindowId;
  readonly sceneId?: SceneId;
  readonly capturedAt: number;
  readonly size: PixelSize;
  readonly scaleFactor: number;
  readonly encoding: FrameEncoding;
  readonly bytes: Uint8Array;
}

/** Accessibility element under the pointer, as reported by the platform. */
export const accessibilityNodeSchema = z.strictObject({
  role: z.string().optional(),
  subrole: z.string().optional(),
  label: z.string().optional(),
  value: z.string().optional(),
  /** Element frame in global screen points, when the platform reports one. */
  bounds: screenRectSchema.optional(),
  /** True for password and other secure fields; their content must be redacted. */
  isSecure: z.boolean(),
});

export type AccessibilityNode = z.infer<typeof accessibilityNodeSchema>;

/** Window-relative summary of an accessibility element, safe to send to a model. */
export const accessibilityNodeSummarySchema = z.strictObject({
  role: z.string().optional(),
  label: z.string().optional(),
  value: z.string().optional(),
  normalizedBounds: normalizedRectSchema.optional(),
  isSecure: z.boolean(),
});

export type AccessibilityNodeSummary = z.infer<typeof accessibilityNodeSummarySchema>;

/**
 * Grounded pointer (mvp-01 §8), verbatim.
 *
 * `normalizedPoint` may fall outside `[0, 1]`; that means the pointer was
 * outside the selected window and the model must be told so rather than given
 * an invented target. Use {@link isPointerInsideWindow}.
 */
export const groundedPointerSchema = z.strictObject({
  screenPoint: screenPointSchema,
  normalizedPoint: normalizedPointSchema,
  capturedPixelPoint: pixelPointSchema.optional(),
  accessibilityTarget: z
    .strictObject({
      role: z.string().optional(),
      label: z.string().optional(),
      value: z.string().optional(),
      normalizedBounds: normalizedRectSchema.optional(),
    })
    .optional(),
});

export type GroundedPointer = z.infer<typeof groundedPointerSchema>;

export function isPointerInsideWindow(pointer: GroundedPointer): boolean {
  return isInsideWindow(pointer.normalizedPoint);
}

/**
 * Builds a `GroundedPointer` from a raw screen point using the one geometry
 * module. Secure accessibility values are dropped here, before any consumer
 * can forward them.
 */
export function buildGroundedPointer(
  screenPoint: ScreenPoint,
  geometry: WindowGeometry,
  target?: AccessibilityNode,
): GroundedPointer {
  const normalizedPoint: NormalizedPoint = screenToNormalized(screenPoint, geometry);
  const base: GroundedPointer = {
    screenPoint: { x: screenPoint.x, y: screenPoint.y },
    normalizedPoint,
    capturedPixelPoint: screenToCapturedPixel(screenPoint, geometry),
  };
  if (target === undefined) {
    return base;
  }
  return {
    ...base,
    accessibilityTarget: {
      ...(target.role === undefined ? {} : { role: target.role }),
      ...(target.label === undefined ? {} : { label: target.label }),
      ...(target.isSecure || target.value === undefined ? {} : { value: target.value }),
      ...(target.bounds === undefined
        ? {}
        : {
            normalizedBounds: {
              x: screenToNormalized({ x: target.bounds.x, y: target.bounds.y }, geometry).x,
              y: screenToNormalized({ x: target.bounds.x, y: target.bounds.y }, geometry).y,
              width: target.bounds.width / geometry.bounds.width,
              height: target.bounds.height / geometry.bounds.height,
            },
          }),
    },
  };
}

/** `observe_screen` input (system-design §9), verbatim. */
export const observeScreenRequestSchema = z.strictObject({
  view: z.enum(['pointer', 'window', 'both']),
  moment: z.enum(['question', 'current', 'before-and-after']),
});

export type ObserveScreenRequest = z.infer<typeof observeScreenRequestSchema>;

export const observationImageSchema = z.strictObject({
  mimeType: z.enum(['image/jpeg', 'image/png']),
  base64: z.string(),
  purpose: z.enum(['window', 'pointer', 'before', 'after']),
});

export type ObservationImage = z.infer<typeof observationImageSchema>;

/** `observe_screen` output (system-design §9), verbatim. */
export const screenObservationSchema = z.strictObject({
  observationId: observationIdSchema,
  sceneId: sceneIdSchema,
  sceneRevision: z.number().int().nonnegative(),
  capturedAt: z.number().int().nonnegative(),
  windowTitle: z.string(),
  pointer: normalizedPointSchema,
  target: accessibilityNodeSummarySchema.optional(),
  images: z.array(observationImageSchema),
});

export type ScreenObservation = z.infer<typeof screenObservationSchema>;

/** Snapshot returned by `ScreenContextService.status()`. */
export const screenStatusSchema = z.strictObject({
  enabled: z.boolean(),
  paused: z.boolean(),
  selectedWindow: observedWindowSchema.nullable(),
  scene: sceneStateSchema.nullable(),
  permissions: z.strictObject({
    screenRecording: permissionStateSchema,
    accessibility: permissionStateSchema,
  }),
  buffer: z.strictObject({
    frameCount: z.number().int().nonnegative(),
    byteCount: z.number().int().nonnegative(),
    oldestFrameAt: z.number().int().nonnegative().nullable(),
    newestFrameAt: z.number().int().nonnegative().nullable(),
  }),
  lastError: serializedPilotErrorSchema.nullable(),
});

export type ScreenStatus = z.infer<typeof screenStatusSchema>;
