import {
  asFrameId,
  type CapturedFrame,
  type FrameEncoding,
  type NormalizedRect,
  type PixelSize,
  type WindowGeometry,
  type WindowId,
} from '@pilot/shared';
import {
  FAKE_EPOCH_MS,
  FIXTURE_GEOMETRY_RETINA,
  FIXTURE_GEOMETRY_SECONDARY,
} from '@pilot/platform/fakes';
import { encodeJpeg, encodePng } from './image-codec.js';
import {
  createPixelBuffer,
  fillRect,
  strokeRect,
  type PixelBuffer,
  type RgbaColor,
} from './pixel-buffer.js';

/**
 * Fixture *images* (PR-018).
 *
 * The PR-004 fixture frames carry deterministic pseudo-random bytes and are
 * explicitly "not a real JPEG … never mistaken for a source of decodable
 * pixels". They are exactly right for the ring, the fingerprint and the policy,
 * and useless to a pipeline whose job is pixels. This module supplies the other
 * kind: a deterministic synthetic *screenshot* that really encodes and really
 * decodes, on the same window identities and geometries every other package
 * uses.
 *
 * The synthetic window is the one the whole project's examples describe — a
 * billing settings page with an Auto Renew toggle and a password field. Two
 * details are load-bearing rather than decorative:
 *
 * - The password field is filled with a **unique, high-frequency colour**
 *   ({@link SECRET_COLOR}). Nothing else in the frame is anywhere near it, so a
 *   test can assert "no pixel of the output is close to the secret" and mean
 *   it, and can assert the counterfactual — that the same secret *does* survive
 *   a downscale when redaction is switched off — which is what makes the first
 *   assertion evidence rather than decoration.
 * - The layout is expressed in **normalised window coordinates**, so the same
 *   scene renders at Retina and non-Retina capture sizes and the tests can
 *   convert with the one geometry module rather than with local arithmetic.
 */

/** Nothing else in the synthetic frame is within 100 of this in any channel. */
export const SECRET_COLOR: RgbaColor = Object.freeze({ r: 255, g: 0, b: 255, a: 255 });

const CANVAS: RgbaColor = { r: 247, g: 247, b: 249, a: 255 };
const SIDEBAR: RgbaColor = { r: 233, g: 233, b: 238, a: 255 };
const TOOLBAR: RgbaColor = { r: 252, g: 252, b: 253, a: 255 };
const RULE: RgbaColor = { r: 214, g: 214, b: 220, a: 255 };
const TEXT: RgbaColor = { r: 34, g: 34, b: 38, a: 255 };
const ACCENT: RgbaColor = { r: 20, g: 110, b: 220, a: 255 };
const FIELD: RgbaColor = { r: 255, g: 255, b: 255, a: 255 };

/** Where the interesting elements are, in normalised window coordinates. */
export interface SyntheticScreenRegions {
  readonly toggle: NormalizedRect;
  readonly passwordField: NormalizedRect;
  readonly photograph: NormalizedRect | null;
}

export interface SyntheticScreen {
  readonly pixels: PixelBuffer;
  readonly regions: SyntheticScreenRegions;
}

export interface SyntheticScreenOptions {
  readonly size: PixelSize;
  /** Adds a photographic panel, whose content JPEG suits and PNG does not. */
  readonly photographic?: boolean;
  /** Renders the toggle in its "on" position — a change the eye sees and the
   *  encoded-payload fingerprint does not (PR-016). */
  readonly toggleOn?: boolean;
  /** Fills the password field with plain background instead of the secret. */
  readonly emptyPasswordField?: boolean;
}

const TOGGLE_REGION: NormalizedRect = { x: 0.54, y: 0.42, width: 0.055, height: 0.035 };
const PASSWORD_REGION: NormalizedRect = { x: 0.34, y: 0.62, width: 0.26, height: 0.05 };
const PHOTO_REGION: NormalizedRect = { x: 0.62, y: 0.06, width: 0.34, height: 0.3 };

function toPixels(rect: NormalizedRect, size: PixelSize) {
  return {
    x: Math.round(rect.x * size.width),
    y: Math.round(rect.y * size.height),
    width: Math.max(1, Math.round(rect.width * size.width)),
    height: Math.max(1, Math.round(rect.height * size.height)),
  };
}

/**
 * Renders the synthetic window. Pure and deterministic: the same options
 * produce byte-identical pixels in every process and on every platform.
 */
export function renderSyntheticScreen(options: SyntheticScreenOptions): SyntheticScreen {
  const size: PixelSize = {
    width: Math.round(options.size.width),
    height: Math.round(options.size.height),
  };
  const image = createPixelBuffer(size.width, size.height);
  const unit = Math.max(1, Math.round(size.height / 200));

  fillRect(image, { x: 0, y: 0, width: size.width, height: size.height }, CANVAS);
  const sidebarWidth = Math.round(size.width * 0.18);
  fillRect(image, { x: 0, y: 0, width: sidebarWidth, height: size.height }, SIDEBAR);
  fillRect(image, { x: 0, y: 0, width: size.width, height: unit * 6 }, TOOLBAR);
  fillRect(image, { x: 0, y: unit * 6, width: size.width, height: unit }, RULE);

  // Sidebar items.
  for (let item = 0; item < 7; item += 1) {
    const y = unit * (12 + item * 9);
    fillRect(
      image,
      { x: unit * 3, y, width: Math.round(sidebarWidth * 0.6), height: unit * 2 },
      item === 3 ? ACCENT : TEXT,
    );
  }

  // Body rows of small "text": one-pixel-scale glyph runs, which is the content
  // JPEG generation loss destroys first.
  const bodyLeft = sidebarWidth + unit * 6;
  const bodyRight = size.width - unit * 6;
  for (let row = 0; row < 22; row += 1) {
    const y = unit * (14 + row * 7);
    if (y + unit * 3 >= size.height) {
      break;
    }
    fillRect(image, { x: bodyLeft, y: y + unit * 5, width: bodyRight - bodyLeft, height: 1 }, RULE);
    const runWidth = Math.round((bodyRight - bodyLeft) * (0.35 + ((row * 7) % 11) / 30));
    for (let x = bodyLeft; x < bodyLeft + runWidth; x += unit * 2) {
      const glyph = (x + row) % 5 === 0 ? 0 : Math.min(unit, bodyLeft + runWidth - x);
      if (glyph > 0) {
        fillRect(image, { x, y, width: glyph, height: unit * 2 }, TEXT);
      }
    }
  }

  // The Auto Renew toggle.
  const toggle = toPixels(TOGGLE_REGION, size);
  fillRect(image, toggle, options.toggleOn === true ? ACCENT : RULE);
  strokeRect(image, toggle, TEXT, Math.max(1, Math.round(unit / 2)));
  const knobWidth = Math.round(toggle.width / 2);
  fillRect(
    image,
    {
      x: options.toggleOn === true ? toggle.x + toggle.width - knobWidth : toggle.x,
      y: toggle.y,
      width: knobWidth,
      height: toggle.height,
    },
    FIELD,
  );

  // The password field. Its contents are the "secret" the redaction tests hunt.
  const field = toPixels(PASSWORD_REGION, size);
  fillRect(image, field, FIELD);
  strokeRect(image, field, RULE, Math.max(1, Math.round(unit / 2)));
  if (options.emptyPasswordField !== true) {
    const inset = Math.max(1, unit);
    for (let y = field.y + inset; y < field.y + field.height - inset; y += 1) {
      for (let x = field.x + inset; x < field.x + field.width - inset; x += 1) {
        const at = (y * size.width + x) * 4;
        // Two shades of the same hue rather than a sparse pattern on white: an
        // area-averaged downscale must still land on the secret colour, or the
        // "was it really masked?" assertions could not tell masking from
        // ordinary resampling loss.
        const dark = (x + y) % 3 === 0;
        image.data[at] = dark ? SECRET_COLOR.r - 40 : SECRET_COLOR.r;
        image.data[at + 1] = SECRET_COLOR.g;
        image.data[at + 2] = dark ? SECRET_COLOR.b - 40 : SECRET_COLOR.b;
        image.data[at + 3] = 255;
      }
    }
  }

  let photograph: NormalizedRect | null = null;
  if (options.photographic === true) {
    photograph = PHOTO_REGION;
    const rect = toPixels(PHOTO_REGION, size);
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const at = (y * size.width + x) * 4;
        // Deterministic pseudo-photographic noise: no two adjacent pixels alike,
        // which is what pushes `flatRunRatio` to zero and selects JPEG.
        const hash = ((x * 73_856_093) ^ (y * 19_349_663) ^ ((x * y) & 0xffff)) >>> 0;
        image.data[at] = (hash >>> 3) & 0xff;
        image.data[at + 1] = (hash >>> 11) & 0xff;
        image.data[at + 2] = (hash >>> 19) & 0xff;
        image.data[at + 3] = 255;
      }
    }
  }

  return {
    pixels: image,
    regions: { toggle: TOGGLE_REGION, passwordField: PASSWORD_REGION, photograph },
  };
}

export interface ImageFixtureFrameOptions extends SyntheticScreenOptions {
  readonly windowId: WindowId;
  readonly frameId?: string;
  readonly capturedAt?: number;
  readonly scaleFactor?: number;
  readonly encoding?: FrameEncoding;
  /** Quality used when `encoding` is `'jpeg'`. Defaults to the policy's 0.75. */
  readonly jpegQuality?: number;
}

/** Packs RGBA pixels into the BGRA byte order ScreenCaptureKit hands over. */
export function toBgraBytes(pixels: PixelBuffer): Uint8Array {
  const out = new Uint8Array(pixels.data.length);
  for (let index = 0; index < pixels.data.length; index += 4) {
    out[index] = pixels.data[index + 2] ?? 0;
    out[index + 1] = pixels.data[index + 1] ?? 0;
    out[index + 2] = pixels.data[index] ?? 0;
    out[index + 3] = pixels.data[index + 3] ?? 255;
  }
  return out;
}

export async function encodeSyntheticScreen(
  pixels: PixelBuffer,
  encoding: FrameEncoding,
  jpegQuality = 0.75,
): Promise<Uint8Array> {
  switch (encoding) {
    case 'png':
      return encodePng(pixels);
    case 'jpeg':
      return encodeJpeg(pixels, jpegQuality);
    case 'bgra':
      return toBgraBytes(pixels);
  }
}

/**
 * A `CapturedFrame` carrying a real, decodable synthetic screenshot.
 *
 * Shape-compatible with the PR-004 fixture frames, so it drops into the frame
 * ring, the policy harness and the enforcer unchanged.
 */
export async function createImageFixtureFrame(
  options: ImageFixtureFrameOptions,
): Promise<{ readonly frame: CapturedFrame; readonly screen: SyntheticScreen }> {
  const screen = renderSyntheticScreen(options);
  const encoding = options.encoding ?? 'jpeg';
  const bytes = await encodeSyntheticScreen(screen.pixels, encoding, options.jpegQuality ?? 0.75);
  return {
    screen,
    frame: {
      frameId: asFrameId(options.frameId ?? 'image-fixture-0001'),
      windowId: options.windowId,
      capturedAt: options.capturedAt ?? FAKE_EPOCH_MS,
      size: { width: screen.pixels.width, height: screen.pixels.height },
      scaleFactor: options.scaleFactor ?? 2,
      encoding,
      bytes,
    },
  };
}

/**
 * The two capture geometries every image test uses: the Retina window from the
 * shared fixtures (2400×1600 captured pixels at 2×, above the 1440 px policy
 * edge and therefore always resized) and the standard-DPI secondary window
 * (1000×700 at 1×, already inside the bound and therefore never resized).
 */
export const IMAGE_FIXTURE_GEOMETRY_RETINA: WindowGeometry = FIXTURE_GEOMETRY_RETINA;
export const IMAGE_FIXTURE_GEOMETRY_STANDARD: WindowGeometry = FIXTURE_GEOMETRY_SECONDARY;

/** True when a pixel is close enough to {@link SECRET_COLOR} to be the secret. */
export function looksLikeSecret(r: number, g: number, b: number, tolerance = 90): boolean {
  return (
    Math.abs(r - SECRET_COLOR.r) <= tolerance &&
    Math.abs(g - SECRET_COLOR.g) <= tolerance &&
    Math.abs(b - SECRET_COLOR.b) <= tolerance
  );
}

/** Counts pixels of `buffer` that look like the secret. */
export function countSecretPixels(buffer: PixelBuffer, tolerance = 90): number {
  let count = 0;
  for (let index = 0; index < buffer.data.length; index += 4) {
    if (
      looksLikeSecret(
        buffer.data[index] ?? 0,
        buffer.data[index + 1] ?? 0,
        buffer.data[index + 2] ?? 0,
        tolerance,
      )
    ) {
      count += 1;
    }
  }
  return count;
}
