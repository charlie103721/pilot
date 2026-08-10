import { z } from 'zod';
import { PilotError } from './errors.js';
import { displayIdSchema, windowIdSchema, type DisplayId } from './ids.js';

/**
 * The one geometry module (system-design §5).
 *
 * Every conversion between display-independent screen points, normalised
 * window coordinates and captured device pixels happens here. UI code, prompt
 * code, the image pipeline and the native bridge must call these functions
 * instead of doing their own arithmetic.
 *
 * Coordinate spaces
 * -----------------
 * - **Screen points** (`ScreenPoint`): display-independent points in the global
 *   desktop space. The origin is the top-left of the primary display, and
 *   displays placed to the left of or above it have negative origins.
 * - **Normalised window coordinates** (`NormalizedPoint`): fraction of the
 *   selected window's frame; `{x: 0, y: 0}` is its top-left corner and
 *   `{x: 1, y: 1}` its bottom-right. Values outside `[0, 1]` mean the point is
 *   outside the window and must be reported as such, never clamped silently.
 * - **Captured pixels** (`PixelPoint`): pixels of the captured image for the
 *   selected window. On a 2× Retina display a 1200×800 pt window is normally
 *   captured at 2400×1600 px, but the capture may also be downscaled by policy,
 *   so conversions use `captureSize` rather than `scaleFactor` wherever the
 *   captured image is involved.
 */

const finite = z.number().finite();
const nonNegative = z.number().finite().nonnegative();

export const screenPointSchema = z.strictObject({ x: finite, y: finite });
export const screenRectSchema = z.strictObject({
  x: finite,
  y: finite,
  width: nonNegative,
  height: nonNegative,
});
export const normalizedPointSchema = z.strictObject({ x: finite, y: finite });
export const normalizedRectSchema = z.strictObject({
  x: finite,
  y: finite,
  width: nonNegative,
  height: nonNegative,
});
export const pixelPointSchema = z.strictObject({ x: finite, y: finite });
export const pixelRectSchema = z.strictObject({
  x: finite,
  y: finite,
  width: nonNegative,
  height: nonNegative,
});
export const pixelSizeSchema = z.strictObject({ width: nonNegative, height: nonNegative });

export type ScreenPoint = z.infer<typeof screenPointSchema>;
export type ScreenRect = z.infer<typeof screenRectSchema>;
export type NormalizedPoint = z.infer<typeof normalizedPointSchema>;
export type NormalizedRect = z.infer<typeof normalizedRectSchema>;
export type PixelPoint = z.infer<typeof pixelPointSchema>;
export type PixelRect = z.infer<typeof pixelRectSchema>;
export type PixelSize = z.infer<typeof pixelSizeSchema>;

export const displayInfoSchema = z.strictObject({
  displayId: displayIdSchema,
  /** Display frame in global screen points; may have a negative origin. */
  bounds: screenRectSchema,
  /** Backing scale factor: 1 for standard DPI, 2 for Retina. */
  scaleFactor: z.number().finite().positive(),
  isPrimary: z.boolean(),
});

export type DisplayInfo = z.infer<typeof displayInfoSchema>;

export const windowGeometrySchema = z.strictObject({
  windowId: windowIdSchema,
  displayId: displayIdSchema,
  /** Window frame in global screen points. */
  bounds: screenRectSchema,
  /** Backing scale factor of the display the window is on. */
  scaleFactor: z.number().finite().positive(),
  /** Pixel size of the captured image for this window. */
  captureSize: pixelSizeSchema,
});

export type WindowGeometry = z.infer<typeof windowGeometrySchema>;

function assertPositiveExtent(value: number, what: string): void {
  if (!(value > 0)) {
    throw new PilotError('invalid-request', `Geometry conversion requires a positive ${what}`, {
      userMessage: 'The selected window has no usable size.',
      details: { what, value },
    });
  }
}

/** Screen points → normalised window coordinates. Values may fall outside `[0, 1]`. */
export function screenToNormalized(point: ScreenPoint, geometry: WindowGeometry): NormalizedPoint {
  assertPositiveExtent(geometry.bounds.width, 'window width');
  assertPositiveExtent(geometry.bounds.height, 'window height');
  return {
    x: (point.x - geometry.bounds.x) / geometry.bounds.width,
    y: (point.y - geometry.bounds.y) / geometry.bounds.height,
  };
}

/** Normalised window coordinates → screen points. */
export function normalizedToScreen(point: NormalizedPoint, geometry: WindowGeometry): ScreenPoint {
  return {
    x: geometry.bounds.x + point.x * geometry.bounds.width,
    y: geometry.bounds.y + point.y * geometry.bounds.height,
  };
}

/** Normalised window coordinates → captured image pixels. */
export function normalizedToCapturedPixel(
  point: NormalizedPoint,
  captureSize: PixelSize,
): PixelPoint {
  assertPositiveExtent(captureSize.width, 'capture width');
  assertPositiveExtent(captureSize.height, 'capture height');
  return { x: point.x * captureSize.width, y: point.y * captureSize.height };
}

/** Captured image pixels → normalised window coordinates. */
export function capturedPixelToNormalized(
  point: PixelPoint,
  captureSize: PixelSize,
): NormalizedPoint {
  assertPositiveExtent(captureSize.width, 'capture width');
  assertPositiveExtent(captureSize.height, 'capture height');
  return { x: point.x / captureSize.width, y: point.y / captureSize.height };
}

/**
 * Screen points → captured image pixels.
 *
 * Uses `captureSize`, so a policy-downscaled capture converts correctly even
 * when the capture is not `bounds × scaleFactor`.
 */
export function screenToCapturedPixel(point: ScreenPoint, geometry: WindowGeometry): PixelPoint {
  return normalizedToCapturedPixel(screenToNormalized(point, geometry), geometry.captureSize);
}

/** Captured image pixels → screen points. */
export function capturedPixelToScreen(point: PixelPoint, geometry: WindowGeometry): ScreenPoint {
  return normalizedToScreen(capturedPixelToNormalized(point, geometry.captureSize), geometry);
}

/**
 * Screen points → native backing pixels of the window's display, ignoring any
 * capture downscale. Use this only when talking to a native API that works in
 * backing pixels; anything touching the captured image uses
 * {@link screenToCapturedPixel}.
 */
export function screenToBackingPixel(point: ScreenPoint, geometry: WindowGeometry): PixelPoint {
  return {
    x: (point.x - geometry.bounds.x) * geometry.scaleFactor,
    y: (point.y - geometry.bounds.y) * geometry.scaleFactor,
  };
}

export function screenRectToNormalizedRect(
  rect: ScreenRect,
  geometry: WindowGeometry,
): NormalizedRect {
  const origin = screenToNormalized({ x: rect.x, y: rect.y }, geometry);
  return {
    x: origin.x,
    y: origin.y,
    width: rect.width / geometry.bounds.width,
    height: rect.height / geometry.bounds.height,
  };
}

export function normalizedRectToCapturedPixelRect(
  rect: NormalizedRect,
  captureSize: PixelSize,
): PixelRect {
  const origin = normalizedToCapturedPixel({ x: rect.x, y: rect.y }, captureSize);
  return {
    x: origin.x,
    y: origin.y,
    width: rect.width * captureSize.width,
    height: rect.height * captureSize.height,
  };
}

export function isPointInRect(point: ScreenPoint, rect: ScreenRect): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x < rect.x + rect.width &&
    point.y < rect.y + rect.height
  );
}

/** True when a normalised point lies inside the window it was normalised against. */
export function isInsideWindow(point: NormalizedPoint): boolean {
  return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}

export function clampNormalizedPoint(point: NormalizedPoint): NormalizedPoint {
  return { x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) };
}

/**
 * Multi-display lookup: the display whose bounds contain the screen point.
 * Returns `undefined` when the point is on no known display.
 */
export function displayContaining(
  point: ScreenPoint,
  displays: readonly DisplayInfo[],
): DisplayInfo | undefined {
  return displays.find((display) => isPointInRect(point, display.bounds));
}

/** Global screen point → point local to a display's own origin. */
export function screenToDisplayLocal(point: ScreenPoint, display: DisplayInfo): ScreenPoint {
  return { x: point.x - display.bounds.x, y: point.y - display.bounds.y };
}

/** Point local to a display's origin → global screen point. */
export function displayLocalToScreen(point: ScreenPoint, display: DisplayInfo): ScreenPoint {
  return { x: point.x + display.bounds.x, y: point.y + display.bounds.y };
}

export function scaleFactorForDisplay(
  displayId: DisplayId,
  displays: readonly DisplayInfo[],
): number | undefined {
  return displays.find((display) => display.displayId === displayId)?.scaleFactor;
}

/**
 * Square crop of `size` captured pixels centred on `center`, shifted (not
 * clipped) to stay inside the frame, and reduced when the frame is smaller
 * than the requested size. Used for the pointer crop in the image pipeline.
 */
export function pointerCropRect(center: PixelPoint, size: number, frame: PixelSize): PixelRect {
  assertPositiveExtent(frame.width, 'frame width');
  assertPositiveExtent(frame.height, 'frame height');
  assertPositiveExtent(size, 'crop size');
  const width = Math.min(size, frame.width);
  const height = Math.min(size, frame.height);
  const x = clamp(center.x - width / 2, 0, frame.width - width);
  const y = clamp(center.y - height / 2, 0, frame.height - height);
  return { x, y, width, height };
}

/** Longest-edge resize factor honouring `maxEdge`; never upscales. */
export function fitWithinMaxEdge(size: PixelSize, maxEdge: number): PixelSize {
  assertPositiveExtent(maxEdge, 'max edge');
  const longest = Math.max(size.width, size.height);
  if (longest <= maxEdge || longest === 0) {
    return { width: size.width, height: size.height };
  }
  const factor = maxEdge / longest;
  return { width: Math.round(size.width * factor), height: Math.round(size.height * factor) };
}

export function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}
