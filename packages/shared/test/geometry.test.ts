import { describe, expect, it } from 'vitest';
import {
  asDisplayId,
  asWindowId,
  capturedPixelToNormalized,
  capturedPixelToScreen,
  clampNormalizedPoint,
  displayContaining,
  displayLocalToScreen,
  fitWithinMaxEdge,
  isInsideWindow,
  isPointInRect,
  normalizedRectToCapturedPixelRect,
  normalizedToCapturedPixel,
  normalizedToScreen,
  pointerCropRect,
  screenRectToNormalizedRect,
  screenToBackingPixel,
  screenToCapturedPixel,
  screenToDisplayLocal,
  screenToNormalized,
  type DisplayInfo,
  type WindowGeometry,
} from '@pilot/shared';

/**
 * Fixtures: a 2× Retina primary display at the origin and a standard-DPI
 * secondary display placed above and to the left of it, so every test that
 * follows exercises both a Retina scale factor and a negative display origin.
 */
const PRIMARY: DisplayInfo = {
  displayId: asDisplayId('display-primary'),
  bounds: { x: 0, y: 0, width: 1728, height: 1117 },
  scaleFactor: 2,
  isPrimary: true,
};

const SECONDARY: DisplayInfo = {
  displayId: asDisplayId('display-secondary'),
  bounds: { x: -1920, y: -120, width: 1920, height: 1080 },
  scaleFactor: 1,
  isPrimary: false,
};

const DISPLAYS = [PRIMARY, SECONDARY];

/** 1200×800 pt window on the Retina display, captured at 2400×1600 px. */
const RETINA_WINDOW: WindowGeometry = {
  windowId: asWindowId('window-retina'),
  displayId: PRIMARY.displayId,
  bounds: { x: 100, y: 80, width: 1200, height: 800 },
  scaleFactor: 2,
  captureSize: { width: 2400, height: 1600 },
};

/** 1000×700 pt window on the secondary display at a negative origin, 1× capture. */
const SECONDARY_WINDOW: WindowGeometry = {
  windowId: asWindowId('window-secondary'),
  displayId: SECONDARY.displayId,
  bounds: { x: -1600, y: 40, width: 1000, height: 700 },
  scaleFactor: 1,
  captureSize: { width: 1000, height: 700 },
};

/** Retina window whose capture was downscaled by policy to a 1440 px long edge. */
const DOWNSCALED_WINDOW: WindowGeometry = {
  ...RETINA_WINDOW,
  captureSize: { width: 1440, height: 960 },
};

describe('geometry — Retina (2×) conversions', () => {
  it('converts the window centre to normalized and captured pixels', () => {
    const centre = { x: 700, y: 480 };
    const normalized = screenToNormalized(centre, RETINA_WINDOW);
    expect(normalized).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizedToCapturedPixel(normalized, RETINA_WINDOW.captureSize)).toEqual({
      x: 1200,
      y: 800,
    });
    expect(screenToCapturedPixel(centre, RETINA_WINDOW)).toEqual({ x: 1200, y: 800 });
  });

  it('maps the window origin and far corner onto the capture bounds', () => {
    expect(screenToCapturedPixel({ x: 100, y: 80 }, RETINA_WINDOW)).toEqual({ x: 0, y: 0 });
    expect(screenToCapturedPixel({ x: 1300, y: 880 }, RETINA_WINDOW)).toEqual({
      x: 2400,
      y: 1600,
    });
  });

  it('doubles offsets when converting to native backing pixels', () => {
    expect(screenToBackingPixel({ x: 400, y: 280 }, RETINA_WINDOW)).toEqual({ x: 600, y: 400 });
  });

  it('round-trips screen → captured pixels → screen', () => {
    const point = { x: 431.5, y: 322.25 };
    const back = capturedPixelToScreen(screenToCapturedPixel(point, RETINA_WINDOW), RETINA_WINDOW);
    expect(back.x).toBeCloseTo(point.x, 10);
    expect(back.y).toBeCloseTo(point.y, 10);
  });

  it('uses captureSize, not scaleFactor, when the capture was downscaled', () => {
    // Same 2× display, but the policy capped the long edge at 1440 px.
    expect(screenToCapturedPixel({ x: 700, y: 480 }, DOWNSCALED_WINDOW)).toEqual({
      x: 720,
      y: 480,
    });
    // The native backing-pixel conversion is unaffected by the downscale.
    expect(screenToBackingPixel({ x: 700, y: 480 }, DOWNSCALED_WINDOW)).toEqual({
      x: 1200,
      y: 800,
    });
  });
});

describe('geometry — multi-display origins', () => {
  it('normalizes a point inside a window with a negative origin', () => {
    const normalized = screenToNormalized({ x: -1100, y: 390 }, SECONDARY_WINDOW);
    expect(normalized).toEqual({ x: 0.5, y: 0.5 });
    expect(screenToCapturedPixel({ x: -1100, y: 390 }, SECONDARY_WINDOW)).toEqual({
      x: 500,
      y: 350,
    });
  });

  it('round-trips normalized → screen on a negative-origin display', () => {
    const screen = normalizedToScreen({ x: 0.25, y: 0.75 }, SECONDARY_WINDOW);
    expect(screen).toEqual({ x: -1350, y: 565 });
    expect(screenToNormalized(screen, SECONDARY_WINDOW)).toEqual({ x: 0.25, y: 0.75 });
  });

  it('reports points outside the selected window instead of clamping them', () => {
    // A point on the primary display, while the secondary window is selected.
    const outside = screenToNormalized({ x: 400, y: 300 }, SECONDARY_WINDOW);
    expect(isInsideWindow(outside)).toBe(false);
    expect(outside.x).toBeGreaterThan(1);
    // Clamping is opt-in and never happens implicitly.
    const clamped = clampNormalizedPoint(outside);
    expect(clamped.x).toBe(1);
    expect(clamped.y).toBeCloseTo(0.371_428_571, 6);
  });

  it('finds the display containing a point across both origins', () => {
    expect(displayContaining({ x: 10, y: 10 }, DISPLAYS)?.displayId).toBe(PRIMARY.displayId);
    expect(displayContaining({ x: -1000, y: 0 }, DISPLAYS)?.displayId).toBe(SECONDARY.displayId);
    expect(displayContaining({ x: 99_999, y: 0 }, DISPLAYS)).toBeUndefined();
  });

  it('converts between global screen space and display-local space', () => {
    const global = { x: -1000, y: 200 };
    const local = screenToDisplayLocal(global, SECONDARY);
    expect(local).toEqual({ x: 920, y: 320 });
    expect(displayLocalToScreen(local, SECONDARY)).toEqual(global);
  });

  it('treats display bounds as half-open rectangles', () => {
    expect(isPointInRect({ x: -1920, y: -120 }, SECONDARY.bounds)).toBe(true);
    expect(isPointInRect({ x: 0, y: -120 }, SECONDARY.bounds)).toBe(false);
  });
});

describe('geometry — rects, crops and resizing', () => {
  it('converts an accessibility rect into normalized and captured-pixel space', () => {
    const normalized = screenRectToNormalizedRect(
      { x: 700, y: 480, width: 60, height: 30 },
      RETINA_WINDOW,
    );
    expect(normalized).toEqual({ x: 0.5, y: 0.5, width: 0.05, height: 0.0375 });
    expect(normalizedRectToCapturedPixelRect(normalized, RETINA_WINDOW.captureSize)).toEqual({
      x: 1200,
      y: 800,
      width: 120,
      height: 60,
    });
  });

  it('centres a pointer crop and keeps it inside the frame', () => {
    const frame = { width: 2400, height: 1600 };
    expect(pointerCropRect({ x: 1200, y: 800 }, 640, frame)).toEqual({
      x: 880,
      y: 480,
      width: 640,
      height: 640,
    });
    // Near the top-left corner the crop shifts rather than clipping.
    expect(pointerCropRect({ x: 10, y: 10 }, 640, frame)).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 640,
    });
    // Near the bottom-right corner it shifts the other way.
    expect(pointerCropRect({ x: 2399, y: 1599 }, 640, frame)).toEqual({
      x: 1760,
      y: 960,
      width: 640,
      height: 640,
    });
  });

  it('shrinks the crop when the frame is smaller than the requested size', () => {
    expect(pointerCropRect({ x: 100, y: 100 }, 640, { width: 400, height: 300 })).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
  });

  it('caps the long edge without upscaling', () => {
    expect(fitWithinMaxEdge({ width: 2400, height: 1600 }, 1440)).toEqual({
      width: 1440,
      height: 960,
    });
    expect(fitWithinMaxEdge({ width: 800, height: 600 }, 1440)).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('round-trips captured pixels through normalized space', () => {
    const normalized = capturedPixelToNormalized({ x: 600, y: 400 }, RETINA_WINDOW.captureSize);
    expect(normalized).toEqual({ x: 0.25, y: 0.25 });
    expect(normalizedToCapturedPixel(normalized, RETINA_WINDOW.captureSize)).toEqual({
      x: 600,
      y: 400,
    });
  });
});

describe('geometry — invalid input', () => {
  it('refuses to convert against a zero-sized window', () => {
    const degenerate: WindowGeometry = {
      ...RETINA_WINDOW,
      bounds: { x: 0, y: 0, width: 0, height: 800 },
    };
    expect(() => screenToNormalized({ x: 0, y: 0 }, degenerate)).toThrowError(
      /positive window width/,
    );
  });

  it('refuses to convert against a zero-sized capture', () => {
    expect(() =>
      normalizedToCapturedPixel({ x: 0.5, y: 0.5 }, { width: 0, height: 0 }),
    ).toThrowError(/positive capture width/);
  });
});
