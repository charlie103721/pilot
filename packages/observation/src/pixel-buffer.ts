import { PilotError, type PixelPoint, type PixelRect, type PixelSize } from '@pilot/shared';

/**
 * Raster primitives for the image pipeline (PR-018).
 *
 * One representation — 8-bit RGBA, row-major, no padding — and a handful of
 * pure operations over it. Nothing here knows about policy, frames, secure
 * fields or encodings; it moves and paints bytes. That separation is what lets
 * the ordering guarantees in `image-processor.ts` be argued from a few lines.
 *
 * Two conventions matter and are load-bearing:
 *
 * 1. **Every operation that changes pixels mutates in place; every operation
 *    that changes the geometry returns a new buffer.** The processor therefore
 *    knows exactly when it owns a buffer and when it is looking at the shared,
 *    pristine decode of a frame it must not scribble on.
 * 2. **Redaction rects round *outward*.** A mask that is half a pixel short is
 *    a mask that leaked. {@link outwardRect} floors the origin, ceils the far
 *    edge, and takes a configurable bleed on top, so the painted region is
 *    never smaller than the region the platform reported.
 */

/** 8-bit RGBA, row-major, `width * height * 4` bytes, no row padding. */
export interface PixelBuffer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface RgbaColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Integral rect in pixels. Distinct from `PixelRect`, which is real-valued. */
export interface IntegralRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function createPixelBuffer(width: number, height: number): PixelBuffer {
  assertUsableSize(width, height);
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function pixelBufferFrom(width: number, height: number, data: Uint8Array): PixelBuffer {
  assertUsableSize(width, height);
  const expected = width * height * 4;
  if (data.byteLength !== expected) {
    throw new PilotError(
      'capture-failed',
      `Pixel buffer is ${String(data.byteLength)} B, expected ${String(expected)} B for ${String(width)}×${String(height)} RGBA`,
      { userMessage: 'Pilot could not read the captured image.' },
    );
  }
  return { width, height, data };
}

export function clonePixelBuffer(buffer: PixelBuffer): PixelBuffer {
  return { width: buffer.width, height: buffer.height, data: Uint8Array.from(buffer.data) };
}

export function pixelBufferSize(buffer: PixelBuffer): PixelSize {
  return { width: buffer.width, height: buffer.height };
}

function assertUsableSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new PilotError(
      'capture-failed',
      `Unusable image size ${String(width)}×${String(height)}`,
      { userMessage: 'The captured window has no usable size.' },
    );
  }
}

// ---------------------------------------------------------------------------
// Rectangles
// ---------------------------------------------------------------------------

/**
 * Integral rect that **contains** `rect`, clamped to the buffer.
 *
 * Used for redaction: `bleed` widens the painted region by whole pixels so a
 * mask derived from real-valued accessibility bounds cannot leave a rim of the
 * secret visible. Returns `null` when the rect does not intersect the buffer at
 * all — a secure field entirely outside the captured window is not in the
 * picture, so there is nothing to paint and nothing has leaked.
 */
export function outwardRect(rect: PixelRect, bounds: PixelSize, bleed = 1): IntegralRect | null {
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
    return null;
  }
  const left = Math.floor(rect.x) - bleed;
  const top = Math.floor(rect.y) - bleed;
  const right = Math.ceil(rect.x + rect.width) + bleed;
  const bottom = Math.ceil(rect.y + rect.height) + bleed;
  const x = Math.max(0, left);
  const y = Math.max(0, top);
  const width = Math.min(bounds.width, right) - x;
  const height = Math.min(bounds.height, bottom) - y;
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

/**
 * Integral rect **contained by** `rect`, clamped to the buffer. Used for the
 * pointer crop, where rounding inward keeps the crop inside the frame and the
 * caller has already clamped the centre with `pointerCropRect`.
 */
export function inwardRect(rect: PixelRect, bounds: PixelSize): IntegralRect | null {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const width = Math.min(bounds.width - x, Math.round(rect.width));
  const height = Math.min(bounds.height - y, Math.round(rect.height));
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/** Fills `rect` with an opaque colour. Mutates `buffer`. */
export function fillRect(buffer: PixelBuffer, rect: IntegralRect, color: RgbaColor): void {
  const { data, width } = buffer;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    let index = (y * width + rect.x) * 4;
    for (let x = 0; x < rect.width; x += 1) {
      data[index] = color.r;
      data[index + 1] = color.g;
      data[index + 2] = color.b;
      data[index + 3] = color.a;
      index += 4;
    }
  }
}

/** Draws a `thickness`-pixel border just inside `rect`. Mutates `buffer`. */
export function strokeRect(
  buffer: PixelBuffer,
  rect: IntegralRect,
  color: RgbaColor,
  thickness: number,
): void {
  const t = Math.max(1, Math.min(thickness, Math.floor(Math.min(rect.width, rect.height) / 2)));
  fillRect(buffer, { x: rect.x, y: rect.y, width: rect.width, height: t }, color);
  fillRect(buffer, { x: rect.x, y: rect.y + rect.height - t, width: rect.width, height: t }, color);
  fillRect(buffer, { x: rect.x, y: rect.y, width: t, height: rect.height }, color);
  fillRect(buffer, { x: rect.x + rect.width - t, y: rect.y, width: t, height: rect.height }, color);
}

function blendPixel(buffer: PixelBuffer, x: number, y: number, color: RgbaColor): void {
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) {
    return;
  }
  const index = (y * buffer.width + x) * 4;
  const alpha = color.a / 255;
  const data = buffer.data;
  data[index] = Math.round((data[index] ?? 0) * (1 - alpha) + color.r * alpha);
  data[index + 1] = Math.round((data[index + 1] ?? 0) * (1 - alpha) + color.g * alpha);
  data[index + 2] = Math.round((data[index + 2] ?? 0) * (1 - alpha) + color.b * alpha);
  data[index + 3] = 255;
}

/**
 * How the pointer marker is drawn.
 *
 * The ring is deliberately **open in the middle**: the whole point of the
 * annotation is to say "the user was pointing here", and a filled marker would
 * hide the control the model has been asked about. The halo makes it legible on
 * a light and a dark interface without knowing which one it is looking at.
 */
export interface PointerMarkerStyle {
  readonly radius: number;
  readonly thickness: number;
  readonly haloThickness: number;
  readonly core: RgbaColor;
  readonly halo: RgbaColor;
  /** Length of the four tick marks pointing at the centre. */
  readonly tickLength: number;
  readonly centerDotRadius: number;
}

export const DEFAULT_POINTER_MARKER_STYLE: PointerMarkerStyle = Object.freeze({
  radius: 26,
  thickness: 3,
  haloThickness: 2,
  core: Object.freeze({ r: 255, g: 45, b: 60, a: 255 }),
  halo: Object.freeze({ r: 255, g: 255, b: 255, a: 235 }),
  tickLength: 9,
  centerDotRadius: 2,
});

/**
 * Draws the pointer reticle centred on `center`. Mutates `buffer`.
 *
 * Drawn **after** the resize so the stroke is exactly `thickness` pixels in the
 * image the model receives; annotating before a downscale produces a marker
 * that thins to a grey smudge at 1440 px.
 */
export function drawPointerMarker(
  buffer: PixelBuffer,
  center: PixelPoint,
  style: PointerMarkerStyle = DEFAULT_POINTER_MARKER_STYLE,
): void {
  const cx = Math.round(center.x);
  const cy = Math.round(center.y);
  const outer = style.radius + style.thickness / 2 + style.haloThickness;
  const inner = style.radius - style.thickness / 2 - style.haloThickness;
  const from = Math.floor(-outer - 1);
  const to = Math.ceil(outer + 1);

  for (let dy = from; dy <= to; dy += 1) {
    for (let dx = from; dx <= to; dx += 1) {
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > outer || distance < inner) {
        continue;
      }
      const offset = Math.abs(distance - style.radius);
      const color = offset <= style.thickness / 2 ? style.core : style.halo;
      blendPixel(buffer, cx + dx, cy + dy, color);
    }
  }

  // Four ticks aimed at the centre, so the exact point is unambiguous even when
  // the ring sits on a busy background.
  const tickFrom = Math.round(style.radius - style.tickLength - style.thickness);
  const tickTo = Math.round(style.radius - style.thickness);
  for (let offset = tickFrom; offset <= tickTo; offset += 1) {
    for (let width = -1; width <= 1; width += 1) {
      const color = width === 0 ? style.core : style.halo;
      blendPixel(buffer, cx + offset, cy + width, color);
      blendPixel(buffer, cx - offset, cy + width, color);
      blendPixel(buffer, cx + width, cy + offset, color);
      blendPixel(buffer, cx + width, cy - offset, color);
    }
  }

  for (let dy = -style.centerDotRadius; dy <= style.centerDotRadius; dy += 1) {
    for (let dx = -style.centerDotRadius; dx <= style.centerDotRadius; dx += 1) {
      if (dx * dx + dy * dy <= style.centerDotRadius * style.centerDotRadius) {
        blendPixel(buffer, cx + dx, cy + dy, style.core);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Copies `rect` out of `buffer` into a new buffer. */
export function cropPixels(buffer: PixelBuffer, rect: IntegralRect): PixelBuffer {
  const out = createPixelBuffer(rect.width, rect.height);
  const srcStride = buffer.width * 4;
  const dstStride = rect.width * 4;
  for (let y = 0; y < rect.height; y += 1) {
    const from = (rect.y + y) * srcStride + rect.x * 4;
    out.data.set(buffer.data.subarray(from, from + dstStride), y * dstStride);
  }
  return out;
}

/**
 * Area-average downscale to exactly `target`.
 *
 * Box-averaging every contributing source pixel is the right filter for
 * screenshots: nearest-neighbour drops whole glyph strokes at 0.6× and is the
 * single fastest way to make small UI text unreadable, which is precisely what
 * grounding depends on. One pass over the source, integer accumulators.
 *
 * **Never upscales** — a target larger than the source in either axis is a
 * programming error, not a resize, and is refused.
 */
export function resizePixels(buffer: PixelBuffer, target: PixelSize): PixelBuffer {
  const width = Math.max(1, Math.round(target.width));
  const height = Math.max(1, Math.round(target.height));
  if (width === buffer.width && height === buffer.height) {
    return buffer;
  }
  if (width > buffer.width || height > buffer.height) {
    throw new PilotError(
      'capture-failed',
      `Refusing to upscale ${String(buffer.width)}×${String(buffer.height)} to ${String(width)}×${String(height)}`,
      { userMessage: 'Pilot could not prepare a picture of the window.' },
    );
  }

  const columnBin = new Int32Array(buffer.width);
  for (let x = 0; x < buffer.width; x += 1) {
    columnBin[x] = Math.min(width - 1, Math.floor((x * width) / buffer.width));
  }
  const total = width * height;
  const sums = new Uint32Array(total * 4);
  const counts = new Uint32Array(total);
  // Unchecked indexing in the accumulation loop: every index is derived from
  // the buffers' own dimensions, and this runs once per source pixel — several
  // million times for a Retina frame, against a 150 ms budget for the whole
  // observation (system-design §17).
  const source = buffer.data;

  for (let y = 0; y < buffer.height; y += 1) {
    const rowBin = Math.min(height - 1, Math.floor((y * height) / buffer.height)) * width;
    let at = y * buffer.width * 4;
    for (let x = 0; x < buffer.width; x += 1) {
      const bin = rowBin + (columnBin[x] as number);
      const into = bin * 4;
      sums[into] = (sums[into] as number) + (source[at] as number);
      sums[into + 1] = (sums[into + 1] as number) + (source[at + 1] as number);
      sums[into + 2] = (sums[into + 2] as number) + (source[at + 2] as number);
      sums[into + 3] = (sums[into + 3] as number) + (source[at + 3] as number);
      counts[bin] = (counts[bin] as number) + 1;
      at += 4;
    }
  }

  const out = createPixelBuffer(width, height);
  const result = out.data;
  for (let bin = 0, at = 0; bin < total; bin += 1, at += 4) {
    const count = counts[bin] as number;
    if (count === 0) {
      result[at + 3] = 255;
      continue;
    }
    result[at] = ((sums[at] as number) / count + 0.5) | 0;
    result[at + 1] = ((sums[at + 1] as number) / count + 0.5) | 0;
    result[at + 2] = ((sums[at + 2] as number) / count + 0.5) | 0;
    result[at + 3] = ((sums[at + 3] as number) / count + 0.5) | 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Cheap, deterministic description of what an image *is*, used to choose an
 * encoding. No semantics, no OCR: two ratios over horizontally adjacent pixels.
 */
export interface ContentStats {
  /** Fraction of pixels identical to their left neighbour. High on flat UI. */
  readonly flatRunRatio: number;
  /** Fraction of pixels across a hard luma edge. Text and borders, not photos. */
  readonly hardEdgeRatio: number;
  /** False when any pixel is translucent; the PNG encoder needs to know. */
  readonly opaque: boolean;
  readonly sampledPixels: number;
}

/** Luma delta that counts as a hard edge — a glyph stroke, not a gradient. */
export const HARD_EDGE_LUMA_DELTA = 48;

export function measureContent(buffer: PixelBuffer, stride = 1): ContentStats {
  const step = Math.max(1, Math.trunc(stride));
  const data = buffer.data;
  let flat = 0;
  let hard = 0;
  let sampled = 0;
  let opaque = true;

  for (let y = 0; y < buffer.height; y += step) {
    const row = y * buffer.width * 4;
    let previousLuma = -1;
    let previousR = -1;
    let previousG = -1;
    let previousB = -1;
    for (let x = 0, at = row; x < buffer.width; x += 1, at += 4) {
      const r = data[at] as number;
      const g = data[at + 1] as number;
      const b = data[at + 2] as number;
      if ((data[at + 3] as number) !== 255) {
        opaque = false;
      }
      // Integer luma, Rec. 601 weights scaled by 1024.
      const luma = (r * 306 + g * 601 + b * 117) >> 10;
      if (x > 0) {
        sampled += 1;
        if (r === previousR && g === previousG && b === previousB) {
          flat += 1;
        }
        if (Math.abs(luma - previousLuma) >= HARD_EDGE_LUMA_DELTA) {
          hard += 1;
        }
      }
      previousLuma = luma;
      previousR = r;
      previousG = g;
      previousB = b;
    }
  }

  if (sampled === 0) {
    return { flatRunRatio: 1, hardEdgeRatio: 0, opaque, sampledPixels: 0 };
  }
  return {
    flatRunRatio: flat / sampled,
    hardEdgeRatio: hard / sampled,
    opaque,
    sampledPixels: sampled,
  };
}
