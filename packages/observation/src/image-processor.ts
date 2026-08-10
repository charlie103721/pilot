import {
  fitWithinMaxEdge,
  nullLogger,
  PilotError,
  type FrameEncoding,
  type Logger,
  type PixelPoint,
  type PixelRect,
  type PixelSize,
} from '@pilot/shared';
import {
  createDefaultFrameCodec,
  mimeTypeForEncoding,
  type EncodedMimeType,
  type FrameCodec,
} from './image-codec.js';
import type { ImageProcessor, ImageRenderRequest, RenderedImage } from './image-pipeline.js';
import {
  clonePixelBuffer,
  cropPixels,
  DEFAULT_POINTER_MARKER_STYLE,
  drawPointerMarker,
  fillRect,
  inwardRect,
  measureContent,
  outwardRect,
  resizePixels,
  strokeRect,
  type PixelBuffer,
  type PointerMarkerStyle,
  type RgbaColor,
} from './pixel-buffer.js';

/**
 * The image pipeline — system-design §10 step 5, "crop, annotate, resize, and
 * encode" (PR-018).
 *
 * This module replaces `FakeImageProcessor` behind the seam PR-017 left. It
 * decides *how* an image is produced; it decides nothing about *whether* one
 * may be produced. Permission, window identity, scene lineage, which frame,
 * which regions are secure, and every count and byte limit stay in
 * `policy-enforcer.ts`, which calls this and enforces its output.
 *
 * ## The order, and why it is this order
 *
 * ```text
 *   decode → REDACT → crop → resize → annotate → encode
 * ```
 *
 * **Redaction is first, before the crop and before the resize, and that is a
 * correctness requirement rather than a preference.** Masking after a downscale
 * means the mask rectangle is rounded in output pixels while the secret was
 * averaged into neighbouring pixels on the way down: a rim of a password field
 * survives just outside the rounded mask, in an image that claims to be
 * redacted. Masking first, on source pixels, with rectangles rounded *outward*
 * ({@link outwardRect}), means every later step operates on pixels the secret
 * has already left. `image-processor.test.ts` proves both halves — that the
 * secret is gone, and that the same test would have caught it if it were not.
 *
 * Annotation is last, after the resize, for the opposite reason: a marker drawn
 * at source scale and then downscaled by 0.6 becomes a grey smudge.
 *
 * ## What the redaction guarantee is, exactly
 *
 * Precisely what `secure-content.ts` says and not one word more. This module
 * paints the rectangles it is handed. It does not detect secrets, it has no
 * opinion about what is sensitive, and a frame with no masks is not a frame
 * without secrets — see `SCREEN_REDACTION_CAVEAT`. The one thing it does
 * guarantee is that **a mask requested is a mask painted before anything is
 * encoded or handed out**, and that a rect it cannot paint is reported rather
 * than dropped.
 *
 * ## Encoding
 *
 * mvp-01 §10: "JPEG is the default. PNG is permitted when compression makes
 * small text unreadable." `docs/handoff.md` §5 records double-JPEG legibility
 * of small text as an open risk: capture encodes once, this pipeline encodes
 * again, and generation loss lands on exactly the glyph edges that grounding
 * depends on. Three rules follow, in order of how much they help:
 *
 * 1. **Pass through, and encode nothing.** When the request needs no crop, no
 *    mask and no marker, and the frame is already an acceptable format inside
 *    the policy's edge bound, the capture's own bytes are returned untouched.
 *    Zero generation loss, and no encoder runs at all. This is the ordinary
 *    `view: 'window'` case — §10 budgets one full frame and one pointer crop,
 *    and the full frame is usually exactly this.
 * 2. **Prefer PNG for interface content.** {@link measureContent} measures how
 *    flat the image is; a screenshot of an interface is mostly runs of
 *    identical pixels with hard glyph edges, which is both the content JPEG
 *    damages most and the content PNG compresses best. Lossless, and through
 *    `zlib` it is also an order of magnitude faster than the pure-JS JPEG
 *    encoder.
 * 3. **JPEG for photographic content**, at the policy's quality, where PNG
 *    would be several megabytes. If a PNG turns out to exceed the byte budget
 *    the policy passes down, the pipeline re-encodes as JPEG and says so.
 *
 * ## Cancellation and blocking
 *
 * system-design §15 requires `observe_screen` to respect the agent's abort, and
 * §17 forbids the main and renderer processes blocking on image encoding. Every
 * stage boundary checks the signal, and the two expensive stages yield to the
 * event loop first, so an abort raised while a render is in flight is honoured
 * and no payload is produced. PNG compression is `zlib`'s asynchronous form and
 * runs on the libuv thread pool, off the JavaScript thread entirely. The
 * pure-JS JPEG encoder cannot be interrupted mid-call, which is one more reason
 * the pipeline prefers not to reach it; the render is still refused at the next
 * boundary and its output discarded.
 *
 * The whole processor is a pure function of (bytes, geometry, parameters) →
 * bytes, holding no handles and no platform state, so PR-019 can host it in a
 * `worker_threads` worker without changing a line of it.
 */

/** Monotonic elapsed-time source. Injected, like the clock, so tests are exact. */
export interface Stopwatch {
  elapsed(): number;
}

/** The one place this module reads a real timer. */
export const performanceStopwatch: Stopwatch = {
  elapsed: () => performance.now(),
};

export type EncodingReason =
  /** The capture's own bytes were returned; no encoder ran. */
  | 'source-passthrough'
  /** The caller asked for a lossless result. */
  | 'lossless-requested'
  /** Flat interface content: PNG is lossless, smaller and faster here. */
  | 'flat-interface-content'
  /** Photographic content: PNG would be far larger than the JPEG. */
  | 'photographic-content'
  /** PNG was chosen but exceeded the byte budget, so JPEG was used instead. */
  | 'png-over-budget';

export interface EncodingSelection {
  readonly mimeType: EncodedMimeType;
  readonly reason: EncodingReason;
  readonly flatRunRatio: number;
  readonly hardEdgeRatio: number;
}

export interface ImageRenderStats {
  readonly path: 'pass-through' | 'decoded';
  readonly decodeCacheHit: boolean;
  readonly sourceEncoding: FrameEncoding;
  readonly sourceSize: PixelSize;
  readonly sourceByteLength: number;
  /** True when the payload's own header disagreed with `CapturedFrame.size`. */
  readonly declaredSizeMismatch: boolean;
  readonly encoding: EncodingSelection;
  readonly redactionsRequested: number;
  readonly redactionsApplied: number;
  /** Mask rects that lie entirely outside the captured frame; nothing to paint. */
  readonly redactionsOutsideFrame: number;
  readonly decodeMs: number;
  readonly redactMs: number;
  readonly cropMs: number;
  readonly resizeMs: number;
  readonly annotateMs: number;
  readonly encodeMs: number;
  readonly totalMs: number;
}

export interface EncodingSelectionConfig {
  /**
   * Fraction of pixels identical to their left neighbour at or above which the
   * image counts as interface content and is encoded losslessly. A screenshot
   * of an application sits well above 0.5; a photograph sits near zero.
   */
  readonly flatRunRatioForLossless: number;
  /** Row sampling stride for the measurement. 4 is ~4× cheaper and as decisive. */
  readonly measurementStride: number;
}

export const DEFAULT_ENCODING_SELECTION: EncodingSelectionConfig = Object.freeze({
  flatRunRatioForLossless: 0.5,
  measurementStride: 4,
});

/** Opaque fill painted over a secure region. */
export const REDACTION_FILL: RgbaColor = Object.freeze({ r: 24, g: 24, b: 27, a: 255 });
/** Border, so a mask reads as a deliberate mask rather than a dark UI panel. */
export const REDACTION_BORDER: RgbaColor = Object.freeze({ r: 160, g: 160, b: 168, a: 255 });

export interface PilotImageProcessorOptions {
  readonly codec?: FrameCodec;
  readonly stopwatch?: Stopwatch;
  readonly logger?: Logger;
  readonly marker?: PointerMarkerStyle;
  readonly encodingSelection?: Partial<EncodingSelectionConfig>;
}

interface DecodeCacheEntry {
  readonly frameId: string;
  readonly byteLength: number;
  readonly pixels: PixelBuffer;
}

export class PilotImageProcessor implements ImageProcessor {
  readonly #codec: FrameCodec;
  readonly #stopwatch: Stopwatch;
  readonly #logger: Logger;
  readonly #marker: PointerMarkerStyle;
  readonly #encodingSelection: EncodingSelectionConfig;

  /**
   * At most one decoded frame, so `view: 'both'` and `before-and-after` decode
   * each source frame once instead of twice. Memory-only, never written
   * anywhere (system-design §13), and dropped by {@link clear} — which PR-019
   * wires into the retention guard alongside the frame ring.
   */
  #cache: DecodeCacheEntry | null = null;

  constructor(options: PilotImageProcessorOptions = {}) {
    this.#codec = options.codec ?? createDefaultFrameCodec();
    this.#stopwatch = options.stopwatch ?? performanceStopwatch;
    this.#logger = options.logger ?? nullLogger;
    this.#marker = options.marker ?? DEFAULT_POINTER_MARKER_STYLE;
    this.#encodingSelection = { ...DEFAULT_ENCODING_SELECTION, ...options.encodingSelection };
  }

  /** Drops the decoded-frame cache. Called on pause, lock, window loss and clear. */
  clear(): void {
    this.#cache = null;
  }

  async render(request: ImageRenderRequest, signal?: AbortSignal): Promise<RenderedImage> {
    const startedAt = this.#stopwatch.elapsed();
    throwIfAborted(signal);

    const frame = request.frame;
    const declaredSize = frame.size;
    const probed = this.#codec.probe(frame.bytes, frame.encoding);
    const sourceSize = probed ?? declaredSize;
    const declaredSizeMismatch =
      probed !== null &&
      (Math.round(probed.width) !== Math.round(declaredSize.width) ||
        Math.round(probed.height) !== Math.round(declaredSize.height));

    if (declaredSizeMismatch) {
      // The adapter's `size` is what it said; the payload is what it sent. Every
      // rect and point the policy computed is in the *declared* space, so they
      // are rescaled rather than trusted, and the mismatch is reported.
      this.#logger.warn('captured frame size disagrees with its payload', {
        declaredWidth: declaredSize.width,
        declaredHeight: declaredSize.height,
        payloadWidth: sourceSize.width,
        payloadHeight: sourceSize.height,
      });
    }
    const scaleX = declaredSize.width > 0 ? sourceSize.width / declaredSize.width : 1;
    const scaleY = declaredSize.height > 0 ? sourceSize.height / declaredSize.height : 1;

    const redactions = request.redactions.map((rect) => scaleRect(rect, scaleX, scaleY));
    const crop = request.crop === undefined ? undefined : scaleRect(request.crop, scaleX, scaleY);
    const marker =
      request.marker === undefined ? undefined : scalePoint(request.marker, scaleX, scaleY);

    // ---- pass-through -----------------------------------------------------
    const passThrough = this.#tryPassThrough(request, sourceSize, redactions, crop, marker);
    if (passThrough !== null) {
      const totalMs = this.#stopwatch.elapsed() - startedAt;
      return {
        mimeType: passThrough,
        base64: toBase64(frame.bytes),
        byteLength: frame.bytes.byteLength,
        size: { width: Math.round(sourceSize.width), height: Math.round(sourceSize.height) },
        purpose: request.purpose,
        redactionsApplied: 0,
        stats: {
          path: 'pass-through',
          decodeCacheHit: false,
          sourceEncoding: frame.encoding,
          sourceSize,
          sourceByteLength: frame.bytes.byteLength,
          declaredSizeMismatch,
          encoding: {
            mimeType: passThrough,
            reason: 'source-passthrough',
            flatRunRatio: 0,
            hardEdgeRatio: 0,
          },
          redactionsRequested: 0,
          redactionsApplied: 0,
          redactionsOutsideFrame: 0,
          decodeMs: 0,
          redactMs: 0,
          cropMs: 0,
          resizeMs: 0,
          annotateMs: 0,
          encodeMs: 0,
          totalMs,
        },
      };
    }

    // ---- decode -----------------------------------------------------------
    await yieldToEventLoop();
    throwIfAborted(signal);
    const decodeStartedAt = this.#stopwatch.elapsed();
    const cached = this.#cachedPixels(frame.frameId, frame.bytes.byteLength);
    const decoded = cached ?? (await this.#codec.decode(frame.bytes, frame.encoding, declaredSize));
    if (cached === null) {
      this.#cache = {
        frameId: frame.frameId,
        byteLength: frame.bytes.byteLength,
        pixels: decoded,
      };
    }
    const decodeMs = this.#stopwatch.elapsed() - decodeStartedAt;
    throwIfAborted(signal);

    // The cached decode is shared with the next render of the same frame, so it
    // is never mutated: `owned` tracks whether we are holding a private copy.
    let image = decoded;
    let owned = false;

    // ---- 1. redact --------------------------------------------------------
    const redactStartedAt = this.#stopwatch.elapsed();
    let redactionsApplied = 0;
    let redactionsOutsideFrame = 0;
    if (redactions.length > 0) {
      image = clonePixelBuffer(image);
      owned = true;
      for (const rect of redactions) {
        const painted = outwardRect(rect, image);
        if (painted === null) {
          redactionsOutsideFrame += 1;
          continue;
        }
        fillRect(image, painted, REDACTION_FILL);
        strokeRect(image, painted, REDACTION_BORDER, 2);
        redactionsApplied += 1;
      }
    }
    const redactMs = this.#stopwatch.elapsed() - redactStartedAt;
    throwIfAborted(signal);

    // ---- 2. crop ----------------------------------------------------------
    const cropStartedAt = this.#stopwatch.elapsed();
    let cropOrigin: PixelPoint = { x: 0, y: 0 };
    if (crop !== undefined) {
      const rect = inwardRect(crop, image);
      if (rect === null) {
        throw new PilotError(
          'capture-failed',
          `Pointer crop ${describeRect(crop)} does not intersect the ${String(image.width)}×${String(image.height)} frame`,
          { userMessage: 'Pilot could not prepare a close-up of that part of the window.' },
        );
      }
      image = cropPixels(image, rect);
      owned = true;
      cropOrigin = { x: rect.x, y: rect.y };
    }
    const cropMs = this.#stopwatch.elapsed() - cropStartedAt;
    throwIfAborted(signal);

    // ---- 3. resize --------------------------------------------------------
    const resizeStartedAt = this.#stopwatch.elapsed();
    const target = fitWithinMaxEdge(image, request.maxEdge);
    const beforeResize = image;
    image = resizePixels(image, target);
    if (image !== beforeResize) {
      owned = true;
    }
    const resizeScale = beforeResize.width === 0 ? 1 : image.width / beforeResize.width;
    const resizeMs = this.#stopwatch.elapsed() - resizeStartedAt;
    throwIfAborted(signal);

    // ---- 4. annotate ------------------------------------------------------
    const annotateStartedAt = this.#stopwatch.elapsed();
    if (marker !== undefined) {
      if (!owned) {
        // Nothing has copied the frame yet, so `image` is still the shared
        // decode. The marker is the last stage, so this is the last chance to
        // stop it scribbling on the buffer the next render will reuse.
        image = clonePixelBuffer(image);
      }
      drawPointerMarker(
        image,
        {
          x: (marker.x - cropOrigin.x) * resizeScale,
          y: (marker.y - cropOrigin.y) * resizeScale,
        },
        this.#marker,
      );
    }
    const annotateMs = this.#stopwatch.elapsed() - annotateStartedAt;

    // ---- 5. encode --------------------------------------------------------
    await yieldToEventLoop();
    throwIfAborted(signal);
    const encodeStartedAt = this.#stopwatch.elapsed();
    const encoded = await this.#encode(image, request);
    const encodeMs = this.#stopwatch.elapsed() - encodeStartedAt;

    // An abort that fired while the encoder was running must not produce an
    // image: the answer is discarded here rather than returned late.
    throwIfAborted(signal);

    const totalMs = this.#stopwatch.elapsed() - startedAt;
    if (redactionsOutsideFrame > 0) {
      this.#logger.warn('secure region lies outside the captured frame', {
        purpose: request.purpose,
        redactionsOutsideFrame,
      });
    }

    return {
      mimeType: encoded.selection.mimeType,
      base64: toBase64(encoded.bytes),
      byteLength: encoded.bytes.byteLength,
      size: { width: image.width, height: image.height },
      purpose: request.purpose,
      redactionsApplied,
      stats: {
        path: 'decoded',
        decodeCacheHit: cached !== null,
        sourceEncoding: frame.encoding,
        sourceSize,
        sourceByteLength: frame.bytes.byteLength,
        declaredSizeMismatch,
        encoding: encoded.selection,
        redactionsRequested: redactions.length,
        redactionsApplied,
        redactionsOutsideFrame,
        decodeMs,
        redactMs,
        cropMs,
        resizeMs,
        annotateMs,
        encodeMs,
        totalMs,
      },
    };
  }

  // -------------------------------------------------------------------------

  #cachedPixels(frameId: string, byteLength: number): PixelBuffer | null {
    const cache = this.#cache;
    if (cache === null || cache.frameId !== frameId || cache.byteLength !== byteLength) {
      return null;
    }
    return cache.pixels;
  }

  /**
   * The capture's own bytes, when the request asks for nothing to be changed.
   *
   * Every condition is a *safety* condition, not an optimisation: a mask, a
   * crop, a marker, an unknown container, a payload bigger than the policy's
   * edge bound or a lossless request all mean the bytes are not the answer.
   */
  #tryPassThrough(
    request: ImageRenderRequest,
    sourceSize: PixelSize,
    redactions: readonly PixelRect[],
    crop: PixelRect | undefined,
    marker: PixelPoint | undefined,
  ): EncodedMimeType | null {
    if (redactions.length > 0 || crop !== undefined || marker !== undefined) {
      return null;
    }
    const mimeType = mimeTypeForEncoding(request.frame.encoding);
    if (mimeType === null) {
      return null;
    }
    if (request.preferLossless && mimeType !== 'image/png') {
      return null;
    }
    if (request.frame.bytes.byteLength === 0) {
      return null;
    }
    const longest = Math.max(sourceSize.width, sourceSize.height);
    if (!(longest > 0) || longest > request.maxEdge) {
      return null;
    }
    return mimeType;
  }

  async #encode(
    image: PixelBuffer,
    request: ImageRenderRequest,
  ): Promise<{ readonly bytes: Uint8Array; readonly selection: EncodingSelection }> {
    const stats = measureContent(image, this.#encodingSelection.measurementStride);
    const lossless =
      request.preferLossless ||
      stats.flatRunRatio >= this.#encodingSelection.flatRunRatioForLossless;
    const reason: EncodingReason = request.preferLossless
      ? 'lossless-requested'
      : lossless
        ? 'flat-interface-content'
        : 'photographic-content';

    if (!lossless) {
      return {
        bytes: await this.#codec.encodeJpeg(image, request.jpegQuality),
        selection: {
          mimeType: 'image/jpeg',
          reason,
          flatRunRatio: stats.flatRunRatio,
          hardEdgeRatio: stats.hardEdgeRatio,
        },
      };
    }

    const png = await this.#codec.encodePng(image);
    const budget = request.maxBytes;
    if (budget !== undefined && png.byteLength > budget && !request.preferLossless) {
      // Lossless would break the ceiling the policy will enforce. Falling back
      // is better than handing the enforcer an image it must reject outright.
      this.#logger.debug('lossless encode exceeded the byte budget; falling back to JPEG', {
        purpose: request.purpose,
        pngBytes: png.byteLength,
        maxBytes: budget,
      });
      return {
        bytes: await this.#codec.encodeJpeg(image, request.jpegQuality),
        selection: {
          mimeType: 'image/jpeg',
          reason: 'png-over-budget',
          flatRunRatio: stats.flatRunRatio,
          hardEdgeRatio: stats.hardEdgeRatio,
        },
      };
    }
    return {
      bytes: png,
      selection: {
        mimeType: 'image/png',
        reason,
        flatRunRatio: stats.flatRunRatio,
        hardEdgeRatio: stats.hardEdgeRatio,
      },
    };
  }
}

// ---------------------------------------------------------------------------

function scaleRect(rect: PixelRect, scaleX: number, scaleY: number): PixelRect {
  if (scaleX === 1 && scaleY === 1) {
    return rect;
  }
  return {
    x: rect.x * scaleX,
    y: rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
  };
}

function scalePoint(point: PixelPoint, scaleX: number, scaleY: number): PixelPoint {
  if (scaleX === 1 && scaleY === 1) {
    return point;
  }
  return { x: point.x * scaleX, y: point.y * scaleY };
}

function describeRect(rect: PixelRect): string {
  return `${String(Math.round(rect.width))}×${String(Math.round(rect.height))} at ${String(
    Math.round(rect.x),
  )},${String(Math.round(rect.y))}`;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** Throws the cancellation the whole pipeline agrees on (system-design §15). */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new PilotError('cancelled', 'Image rendering was cancelled', {
      userMessage: 'The request was cancelled.',
      retryable: true,
    });
  }
}

/**
 * Hands the event loop back before an expensive stage. On the JavaScript thread
 * this is what lets an abort, an IPC message or a timer be seen at all between
 * a decode and an encode; in a worker it costs one tick.
 *
 * `setImmediate` is a Node global and does not exist in a Chromium renderer.
 * This pipeline has no business running there (mvp-01 §10: "the encoder must
 * run off the Electron renderer"), but falling back rather than throwing means
 * a bundler that drags this module into the renderer produces a slow page, not
 * a broken one.
 */
async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof setImmediate === 'function') {
      setImmediate(resolve);
      return;
    }
    setTimeout(resolve, 0);
  });
}
