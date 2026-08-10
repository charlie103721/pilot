import {
  PilotError,
  type CapturedFrame,
  type ObservationImage,
  type PixelPoint,
  type PixelRect,
  type PixelSize,
} from '@pilot/shared';
// Type-only, and therefore erased: the real processor imports this module for
// the contract, and this module names its statistics type. No runtime cycle.
import type { ImageRenderStats } from './image-processor.js';

/**
 * The image-pipeline seam.
 *
 * §10 step 5 — "crop, annotate, resize, and encode" — is the image pipeline.
 * PR-017 owns the order the steps run in, the parameters policy hands to step
 * 5, and the limits its output has to satisfy; PR-018 owns the pixels.
 *
 * The seam is one interface plus a deterministic fake, exactly as PR-016 did
 * for the content fingerprint: everything upstream could be built, tested and
 * demonstrated before a single pixel was touched, and PR-018 replaced the fake
 * without any caller changing.
 *
 * **PR-018 has landed.** {@link PilotImageProcessor} in `image-processor.ts` is
 * the real implementation; {@link FakeImageProcessor} stays, because the policy
 * tests exercise counts, byte ceilings and rejection paths and have no business
 * paying for a JPEG decode to do it. The contract PR-018 was written against,
 * and still honours:
 *
 * - Honour `crop`, then `maxEdge`, then encode. Never upscale.
 * - Paint every rect in `redactions` **before** anything is encoded or handed
 *   out. A mask that is applied late is a mask that leaked.
 * - Respect `signal` and throw `cancelled` promptly (system-design §15).
 * - Return the real `byteLength` of the decoded payload. The policy's byte
 *   limits are enforced on that number, so a wrong one defeats them.
 * - Never log or persist the payload (system-design §13).
 */

export type ObservationImagePurpose = ObservationImage['purpose'];

export interface ImageRenderRequest {
  /** Source frame. Memory-only; the processor must not retain it. */
  readonly frame: CapturedFrame;
  readonly purpose: ObservationImagePurpose;
  /** Crop in captured pixels. Absent means the whole frame. */
  readonly crop?: PixelRect;
  /** Longest edge of the encoded result, in pixels. Never upscales. */
  readonly maxEdge: number;
  /**
   * Regions to paint over, in captured pixels of the **source frame** — before
   * cropping, so a mask stays put whatever the crop does.
   */
  readonly redactions: readonly PixelRect[];
  /** Where to draw the pointer marker, in captured pixels of the source frame. */
  readonly marker?: PixelPoint;
  /** JPEG quality in `(0, 1]`. */
  readonly jpegQuality: number;
  /**
   * Ask for a lossless encode. mvp-01 §10: "JPEG is the default. PNG is
   * permitted when compression makes small text unreadable."
   */
  readonly preferLossless: boolean;
  /**
   * Byte ceiling the policy will enforce on the result (PR-018, additive).
   *
   * The *number* stays a policy decision — it is `image.maxImageBytes` — and
   * the policy still rejects an image that exceeds it. Passing it down lets the
   * pipeline choose an encoding that fits instead of producing a lossless image
   * the enforcer must then throw away. Absent means "no hint"; the pipeline
   * then optimises purely for legibility.
   */
  readonly maxBytes?: number;
}

export interface RenderedImage {
  readonly mimeType: ObservationImage['mimeType'];
  /** Base64 without a `data:` prefix, as Pi's image content block expects. */
  readonly base64: string;
  /** Decoded size in bytes. The policy's byte limits are enforced on this. */
  readonly byteLength: number;
  readonly size: PixelSize;
  readonly purpose: ObservationImagePurpose;
  /** How many redaction rects were actually painted. */
  readonly redactionsApplied: number;
  /**
   * What the pipeline did and what it cost (PR-018, additive and optional).
   *
   * Content-free by construction — sizes, byte counts, stage timings and the
   * encoding decision, never a pixel. The demo prints it, and it is how the
   * §17 150 ms preprocessing budget is *measured* rather than assumed. The fake
   * below does not supply it, so every reader must handle `undefined`.
   */
  readonly stats?: ImageRenderStats;
}

export interface ImageProcessor {
  render(request: ImageRenderRequest, signal?: AbortSignal): Promise<RenderedImage>;
}

/** Projects a rendered image onto the wire shape of system-design §9. */
export function toObservationImage(image: RenderedImage): ObservationImage {
  return { mimeType: image.mimeType, base64: image.base64, purpose: image.purpose };
}

// ---------------------------------------------------------------------------
// Deterministic fake
// ---------------------------------------------------------------------------

export interface FakeImageProcessorOptions {
  /**
   * Encoded bytes per output pixel. The default puts a 1440-px frame at a few
   * tens of kilobytes — the right order of magnitude for a JPEG, and cheap
   * enough that a test suite can render hundreds of them.
   */
  readonly bytesPerPixel?: number;
  /** Fail every render with this error, to exercise the failure path. */
  readonly failWith?: PilotError;
}

export interface FakeRenderCall {
  readonly purpose: ObservationImagePurpose;
  readonly maxEdge: number;
  readonly crop: PixelRect | null;
  readonly redactions: number;
  readonly marker: PixelPoint | null;
  readonly jpegQuality: number;
  readonly preferLossless: boolean;
}

/**
 * Deterministic `ImageProcessor`.
 *
 * It does not decode anything — the fixture frames are not real JPEGs and must
 * never be mistaken for a source of pixels. It computes the output size the way
 * the real pipeline will (crop, then fit within `maxEdge`), synthesises a
 * payload of a plausible length from a fixed seed, and records the call so a
 * test can assert that the masks and the crop actually reached step 5.
 */
export class FakeImageProcessor implements ImageProcessor {
  readonly #bytesPerPixel: number;
  readonly #failWith: PilotError | null;

  readonly calls: FakeRenderCall[] = [];

  constructor(options: FakeImageProcessorOptions = {}) {
    this.#bytesPerPixel = options.bytesPerPixel ?? 0.01;
    this.#failWith = options.failWith ?? null;
  }

  async render(request: ImageRenderRequest, signal?: AbortSignal): Promise<RenderedImage> {
    if (signal?.aborted === true) {
      throw new PilotError('cancelled', 'Image rendering was cancelled', {
        userMessage: 'The request was cancelled.',
        retryable: true,
      });
    }
    if (this.#failWith !== null) {
      throw this.#failWith;
    }

    this.calls.push({
      purpose: request.purpose,
      maxEdge: request.maxEdge,
      crop: request.crop ?? null,
      redactions: request.redactions.length,
      marker: request.marker ?? null,
      jpegQuality: request.jpegQuality,
      preferLossless: request.preferLossless,
    });

    const source: PixelSize =
      request.crop === undefined
        ? request.frame.size
        : { width: request.crop.width, height: request.crop.height };
    const size = fitWithin(source, request.maxEdge);
    const byteLength = Math.max(
      32,
      Math.round(size.width * size.height * this.#bytesPerPixel) + 32,
    );
    const bytes = seededPayload(request.purpose, byteLength);

    return {
      mimeType: request.preferLossless ? 'image/png' : 'image/jpeg',
      base64: Buffer.from(bytes).toString('base64'),
      byteLength,
      size,
      purpose: request.purpose,
      redactionsApplied: request.redactions.length,
    };
  }
}

/** Longest-edge fit, integral, never upscaling. Mirrors `fitWithinMaxEdge`. */
function fitWithin(size: PixelSize, maxEdge: number): PixelSize {
  const longest = Math.max(size.width, size.height);
  if (longest <= maxEdge || longest === 0) {
    return { width: Math.round(size.width), height: Math.round(size.height) };
  }
  const factor = maxEdge / longest;
  return { width: Math.round(size.width * factor), height: Math.round(size.height * factor) };
}

/** Fixed-seed bytes so the demo prints the same payload on every machine. */
function seededPayload(purpose: string, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x9e3779b9;
  for (let index = 0; index < purpose.length; index += 1) {
    state = (Math.imul(state ^ purpose.charCodeAt(index), 16777619) + 1) >>> 0;
  }
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = (state >>> 24) & 0xff;
  }
  return bytes;
}
