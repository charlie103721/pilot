import { describe, expect, it } from 'vitest';
import {
  asFrameId,
  buildGroundedPointer,
  createCounterIdSource,
  createIdFactory,
  normalizedRectToCapturedPixelRect,
  normalizedToCapturedPixel,
  normalizedToScreen,
  PilotError,
  pointerCropRect,
  type CapturedFrame,
  type NormalizedRect,
  type PixelRect,
  type PixelSize,
} from '@pilot/shared';
import {
  createFakeClock,
  FAKE_EPOCH_MS,
  FIXTURE_WINDOW_RETINA,
  FIXTURE_WINDOW_SECONDARY,
} from '@pilot/platform/fakes';
import {
  createDefaultFrameCodec,
  decodePng,
  encodePng,
  type FrameCodec,
} from '../src/image-codec.js';
import {
  countSecretPixels,
  createImageFixtureFrame,
  IMAGE_FIXTURE_GEOMETRY_RETINA,
  IMAGE_FIXTURE_GEOMETRY_STANDARD,
  renderSyntheticScreen,
  toBgraBytes,
} from '../src/image-fixtures.js';
import {
  PilotImageProcessor,
  REDACTION_FILL,
  type ImageRenderStats,
  type Stopwatch,
} from '../src/image-processor.js';
import type { ImageRenderRequest, RenderedImage } from '../src/image-pipeline.js';
import { createPixelBuffer, type PixelBuffer } from '../src/pixel-buffer.js';
import { ObservationCore } from '../src/observation-core.js';
import { ScreenPolicyEnforcer } from '../src/policy-enforcer.js';
import { DEFAULT_SCREEN_CONTEXT_POLICY, defineScreenPolicy } from '../src/screen-policy.js';

/**
 * PR-018 — the image pipeline (system-design §10 step 5).
 *
 * Every test here works on **real pixels**: a deterministic synthetic
 * screenshot is encoded, run through the pipeline, and decoded again, so an
 * assertion about redaction or about a crop is an assertion about what the
 * model would actually receive rather than about a call record.
 */

const RETINA_SIZE: PixelSize = { width: 1200, height: 800 };

/** A stopwatch that ticks one millisecond per reading: timings stay exact. */
function countingStopwatch(): Stopwatch {
  let ticks = 0;
  return {
    elapsed: () => {
      ticks += 1;
      return ticks;
    },
  };
}

async function fixtureFrame(
  options: Parameters<typeof createImageFixtureFrame>[0],
): ReturnType<typeof createImageFixtureFrame> {
  return createImageFixtureFrame(options);
}

function baseRequest(frame: CapturedFrame, overrides: Partial<ImageRenderRequest> = {}) {
  return {
    frame,
    purpose: 'window' as const,
    maxEdge: 1440,
    redactions: [] as readonly PixelRect[],
    jpegQuality: 0.75,
    preferLossless: false,
    ...overrides,
  } satisfies ImageRenderRequest;
}

async function decodeRendered(image: RenderedImage): Promise<PixelBuffer> {
  const bytes = Uint8Array.from(Buffer.from(image.base64, 'base64'));
  expect(bytes.byteLength).toBe(image.byteLength);
  if (image.mimeType === 'image/png') {
    return decodePng(bytes);
  }
  const { decodeJpeg } = await import('../src/image-codec.js');
  return decodeJpeg(bytes);
}

function statsOf(image: RenderedImage): ImageRenderStats {
  const stats = image.stats;
  if (stats === undefined) {
    throw new Error('the real processor always reports stats');
  }
  return stats;
}

function pixelRect(region: NormalizedRect, size: PixelSize): PixelRect {
  return normalizedRectToCapturedPixelRect(region, size);
}

// ---------------------------------------------------------------------------
// Redaction — the one ordering guarantee the whole PR exists to make
// ---------------------------------------------------------------------------

describe('redaction happens before the resize', () => {
  it('leaves no trace of a secure field in a frame downscaled 3×', async () => {
    const { frame, screen } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_RETINA.windowId,
      size: RETINA_SIZE,
      encoding: 'png',
    });
    const processor = new PilotImageProcessor();

    const redacted = await processor.render(
      baseRequest(frame, {
        maxEdge: 400,
        redactions: [pixelRect(screen.regions.passwordField, frame.size)],
      }),
    );
    const pixels = await decodeRendered(redacted);

    expect(redacted.redactionsApplied).toBe(1);
    expect(pixels.width).toBe(400);
    expect(countSecretPixels(pixels)).toBe(0);
  });

  it('would have caught the failure: the same secret survives when nothing is masked', async () => {
    // Without this the assertion above proves only that the test cannot see.
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_RETINA.windowId,
      size: RETINA_SIZE,
      encoding: 'png',
    });
    const processor = new PilotImageProcessor();
    const unredacted = await processor.render(baseRequest(frame, { maxEdge: 400 }));
    expect(countSecretPixels(await decodeRendered(unredacted))).toBeGreaterThan(50);
  });

  it('paints the mask so that nothing of the secret is left around its rounded edge', async () => {
    const { frame, screen } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_RETINA.windowId,
      size: RETINA_SIZE,
      encoding: 'png',
    });
    const processor = new PilotImageProcessor();
    const rendered = await processor.render(
      baseRequest(frame, {
        maxEdge: 400,
        redactions: [pixelRect(screen.regions.passwordField, frame.size)],
      }),
    );
    const pixels = await decodeRendered(rendered);

    // The centre of the masked area is the mask fill, not a downscaled average
    // of the fill and whatever leaked in from the edges.
    const region = screen.regions.passwordField;
    const centreX = Math.round((region.x + region.width / 2) * pixels.width);
    const centreY = Math.round((region.y + region.height / 2) * pixels.height);
    const at = (centreY * pixels.width + centreX) * 4;
    expect(pixels.data[at]).toBe(REDACTION_FILL.r);
    expect(pixels.data[at + 1]).toBe(REDACTION_FILL.g);
    expect(pixels.data[at + 2]).toBe(REDACTION_FILL.b);
  });

  it('masks the visible part of a region that runs off the edge of the frame', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_RETINA.windowId,
      size: { width: 400, height: 300 },
      encoding: 'png',
    });
    const processor = new PilotImageProcessor();
    const rendered = await processor.render(
      baseRequest(frame, { redactions: [{ x: -80, y: -60, width: 200, height: 200 }] }),
    );
    expect(rendered.redactionsApplied).toBe(1);
    const pixels = await decodeRendered(rendered);
    const at = (10 * pixels.width + 10) * 4;
    expect(pixels.data[at]).toBe(REDACTION_FILL.r);
  });

  it('reports, rather than silently drops, a region wholly outside the frame', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_RETINA.windowId,
      size: { width: 400, height: 300 },
      encoding: 'png',
    });
    const processor = new PilotImageProcessor();
    const rendered = await processor.render(
      baseRequest(frame, { redactions: [{ x: 900, y: 900, width: 40, height: 20 }] }),
    );
    expect(rendered.redactionsApplied).toBe(0);
    expect(statsOf(rendered).redactionsOutsideFrame).toBe(1);
    expect(statsOf(rendered).redactionsRequested).toBe(1);
  });

  it('never passes the capture through untouched when there is anything to mask', async () => {
    const { frame, screen } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      size: { width: 600, height: 400 },
      encoding: 'png',
    });
    const processor = new PilotImageProcessor();
    const rendered = await processor.render(
      baseRequest(frame, { redactions: [pixelRect(screen.regions.passwordField, frame.size)] }),
    );
    expect(statsOf(rendered).path).toBe('decoded');
    expect(countSecretPixels(await decodeRendered(rendered))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pointer crop and marker
// ---------------------------------------------------------------------------

describe('pointer crop', () => {
  it('clamps at the top-left corner and still marks the true pointer position', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_RETINA.windowId,
      size: RETINA_SIZE,
      encoding: 'png',
    });
    const marker = { x: 5, y: 5 };
    const crop = pointerCropRect(marker, 640, frame.size);
    expect(crop).toStrictEqual({ x: 0, y: 0, width: 640, height: 640 });

    const processor = new PilotImageProcessor();
    const rendered = await processor.render(
      baseRequest(frame, { purpose: 'pointer', maxEdge: 640, crop, marker }),
    );
    expect(rendered.size).toStrictEqual({ width: 640, height: 640 });

    const pixels = await decodeRendered(rendered);
    const at = (5 * pixels.width + 5) * 4;
    // The marker's centre dot is the core colour, which nothing in the
    // synthetic interface uses.
    expect(pixels.data[at]).toBeGreaterThan(200);
    expect(pixels.data[at + 1]).toBeLessThan(90);
  });

  it('clamps at the bottom-right corner', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_RETINA.windowId,
      size: RETINA_SIZE,
      encoding: 'png',
    });
    const marker = { x: 1195, y: 795 };
    const crop = pointerCropRect(marker, 640, frame.size);
    expect(crop).toStrictEqual({ x: 560, y: 160, width: 640, height: 640 });

    const processor = new PilotImageProcessor();
    const rendered = await processor.render(
      baseRequest(frame, { purpose: 'pointer', maxEdge: 640, crop, marker }),
    );
    const pixels = await decodeRendered(rendered);
    const at = (635 * pixels.width + 635) * 4;
    expect(pixels.data[at]).toBeGreaterThan(200);
    expect(pixels.data[at + 1]).toBeLessThan(90);
  });

  it('reduces the crop when the whole frame is smaller than the crop size', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      size: { width: 500, height: 320 },
      encoding: 'png',
    });
    const marker = { x: 250, y: 160 };
    const crop = pointerCropRect(marker, 640, frame.size);
    const processor = new PilotImageProcessor();
    const rendered = await processor.render(
      baseRequest(frame, { purpose: 'pointer', maxEdge: 640, crop, marker }),
    );
    // Never upscaled to 640: §10 caps the crop, it does not demand it.
    expect(rendered.size).toStrictEqual({ width: 500, height: 320 });
  });

  it('refuses a crop that does not intersect the frame at all', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      size: { width: 320, height: 240 },
      encoding: 'png',
    });
    const processor = new PilotImageProcessor();
    await expect(
      processor.render(
        baseRequest(frame, {
          purpose: 'pointer',
          maxEdge: 640,
          crop: { x: 900, y: 900, width: 640, height: 640 },
        }),
      ),
    ).rejects.toThrowError(PilotError);
  });
});

// ---------------------------------------------------------------------------
// Scale factors
// ---------------------------------------------------------------------------

describe('Retina and non-Retina captures', () => {
  it('reduces a 2× capture to the policy edge and leaves a 1× capture alone', async () => {
    const processor = new PilotImageProcessor();

    const retina = await fixtureFrame({
      windowId: FIXTURE_WINDOW_RETINA.windowId,
      size: IMAGE_FIXTURE_GEOMETRY_RETINA.captureSize,
      scaleFactor: 2,
      encoding: 'bgra',
    });
    const standard = await fixtureFrame({
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      size: IMAGE_FIXTURE_GEOMETRY_STANDARD.captureSize,
      scaleFactor: 1,
      encoding: 'bgra',
    });

    const fullFrameEdge = DEFAULT_SCREEN_CONTEXT_POLICY.image.fullFrameMaxEdge;
    const retinaImage = await processor.render(
      baseRequest(retina.frame, { maxEdge: fullFrameEdge }),
    );
    const standardImage = await processor.render(
      baseRequest(standard.frame, { maxEdge: fullFrameEdge }),
    );

    // 2400×1600 → 1440×960 (the long edge exactly at the policy bound).
    expect(retinaImage.size).toStrictEqual({ width: 1440, height: 960 });
    // 1000×700 is already inside the bound and is not touched.
    expect(standardImage.size).toStrictEqual({ width: 1000, height: 700 });
  });

  it('shows a control at twice the linear size in the same 640 px crop on Retina', async () => {
    const processor = new PilotImageProcessor();
    const accent = { r: 20, g: 110, b: 220 };
    const toggleCentre = { x: 0.5675, y: 0.4375 };

    const counts: number[] = [];
    for (const size of [
      IMAGE_FIXTURE_GEOMETRY_RETINA.captureSize,
      IMAGE_FIXTURE_GEOMETRY_STANDARD.captureSize,
    ]) {
      const { frame } = await fixtureFrame({
        windowId: FIXTURE_WINDOW_RETINA.windowId,
        size,
        encoding: 'bgra',
        toggleOn: true,
      });
      const marker = normalizedToCapturedPixel(toggleCentre, frame.size);
      const crop = pointerCropRect(marker, 640, frame.size);
      const rendered = await processor.render(
        baseRequest(frame, { purpose: 'pointer', maxEdge: 640, crop, marker }),
      );
      expect(rendered.size).toStrictEqual({ width: 640, height: 640 });
      const pixels = await decodeRendered(rendered);
      let count = 0;
      for (let index = 0; index < pixels.data.length; index += 4) {
        if (
          Math.abs((pixels.data[index] ?? 0) - accent.r) <= 12 &&
          Math.abs((pixels.data[index + 1] ?? 0) - accent.g) <= 12 &&
          Math.abs((pixels.data[index + 2] ?? 0) - accent.b) <= 12
        ) {
          count += 1;
        }
      }
      counts.push(count);
    }

    const [retinaCount = 0, standardCount = 0] = counts;
    expect(standardCount).toBeGreaterThan(0);
    // The crop is a fixed 640 px window on the *capture*, so a 2.4× denser
    // capture shows the same control at 2.4× the linear size — roughly 5.8× the
    // area. The band is wide because the sidebar accent is outside both crops
    // and only the toggle contributes.
    expect(retinaCount / standardCount).toBeGreaterThan(3);
    expect(retinaCount / standardCount).toBeLessThan(9);
  });
});

// ---------------------------------------------------------------------------
// Resize bounds
// ---------------------------------------------------------------------------

describe('resize', () => {
  it('brings an oversized frame inside the policy bound and keeps the aspect ratio', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_RETINA.windowId,
      size: { width: 3000, height: 2000 },
      encoding: 'bgra',
    });
    const processor = new PilotImageProcessor();
    const rendered = await processor.render(baseRequest(frame, { maxEdge: 1440 }));
    expect(Math.max(rendered.size.width, rendered.size.height)).toBe(1440);
    expect(rendered.size).toStrictEqual({ width: 1440, height: 960 });
  });

  it('never upscales a small frame to the policy bound', async () => {
    const { frame, screen } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      size: { width: 300, height: 200 },
      encoding: 'png',
    });
    const processor = new PilotImageProcessor();
    const rendered = await processor.render(
      baseRequest(frame, {
        maxEdge: 1440,
        redactions: [pixelRect(screen.regions.passwordField, frame.size)],
      }),
    );
    expect(rendered.size).toStrictEqual({ width: 300, height: 200 });
  });
});

// ---------------------------------------------------------------------------
// Pass-through
// ---------------------------------------------------------------------------

describe('pass-through', () => {
  it('returns the capture’s own bytes when nothing has to change', async () => {
    for (const encoding of ['png', 'jpeg'] as const) {
      const { frame } = await fixtureFrame({
        windowId: FIXTURE_WINDOW_SECONDARY.windowId,
        size: { width: 1000, height: 700 },
        encoding,
      });
      const processor = new PilotImageProcessor();
      const rendered = await processor.render(baseRequest(frame, { maxEdge: 1440 }));

      expect(statsOf(rendered).path).toBe('pass-through');
      expect(rendered.mimeType).toBe(encoding === 'png' ? 'image/png' : 'image/jpeg');
      expect(rendered.byteLength).toBe(frame.bytes.byteLength);
      expect(Array.from(Uint8Array.from(Buffer.from(rendered.base64, 'base64')))).toStrictEqual(
        Array.from(frame.bytes),
      );
      expect(rendered.size).toStrictEqual({ width: 1000, height: 700 });
    }
  });

  it('declines when the payload is larger than the policy edge bound', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_RETINA.windowId,
      size: { width: 2000, height: 1200 },
      encoding: 'png',
    });
    const processor = new PilotImageProcessor();
    const rendered = await processor.render(baseRequest(frame, { maxEdge: 1440 }));
    expect(statsOf(rendered).path).toBe('decoded');
    expect(rendered.size).toStrictEqual({ width: 1440, height: 864 });
  });

  it('declines for a raw BGRA frame, which is not a container the model accepts', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      size: { width: 320, height: 200 },
      encoding: 'bgra',
    });
    const processor = new PilotImageProcessor();
    const rendered = await processor.render(baseRequest(frame));
    expect(statsOf(rendered).path).toBe('decoded');
    expect(rendered.mimeType).toBe('image/png');
  });

  it('declines a JPEG source when the caller asked for lossless', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      size: { width: 320, height: 200 },
      encoding: 'jpeg',
    });
    const processor = new PilotImageProcessor();
    const rendered = await processor.render(baseRequest(frame, { preferLossless: true }));
    expect(statsOf(rendered).path).toBe('decoded');
    expect(rendered.mimeType).toBe('image/png');
  });
});

// ---------------------------------------------------------------------------
// Encoding selection
// ---------------------------------------------------------------------------

function noiseFrame(size: PixelSize): CapturedFrame {
  const pixels = createPixelBuffer(size.width, size.height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const hash = (index * 2_654_435_761) >>> 0;
    pixels.data[index] = (hash >>> 5) & 0xff;
    pixels.data[index + 1] = (hash >>> 13) & 0xff;
    pixels.data[index + 2] = (hash >>> 21) & 0xff;
    pixels.data[index + 3] = 255;
  }
  return {
    frameId: asFrameId('noise-0001'),
    windowId: FIXTURE_WINDOW_RETINA.windowId,
    capturedAt: FAKE_EPOCH_MS,
    size,
    scaleFactor: 1,
    encoding: 'bgra',
    bytes: toBgraBytes(pixels),
  };
}

describe('encoding selection', () => {
  it('chooses lossless PNG for interface content, which is what small text needs', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      size: { width: 640, height: 400 },
      encoding: 'bgra',
    });
    const processor = new PilotImageProcessor();
    const rendered = await processor.render(baseRequest(frame));
    expect(rendered.mimeType).toBe('image/png');
    expect(statsOf(rendered).encoding.reason).toBe('flat-interface-content');
    expect(statsOf(rendered).encoding.flatRunRatio).toBeGreaterThan(0.5);
  });

  it('chooses JPEG for photographic content, where PNG would be enormous', async () => {
    const processor = new PilotImageProcessor();
    const rendered = await processor.render(baseRequest(noiseFrame({ width: 320, height: 240 })));
    expect(rendered.mimeType).toBe('image/jpeg');
    expect(statsOf(rendered).encoding.reason).toBe('photographic-content');
    expect(statsOf(rendered).encoding.flatRunRatio).toBeLessThan(0.1);
  });

  it('honours an explicit lossless request even on photographic content', async () => {
    const processor = new PilotImageProcessor();
    const rendered = await processor.render(
      baseRequest(noiseFrame({ width: 160, height: 120 }), { preferLossless: true }),
    );
    expect(rendered.mimeType).toBe('image/png');
    expect(statsOf(rendered).encoding.reason).toBe('lossless-requested');
  });

  it('falls back to JPEG when the lossless result would break the policy byte ceiling', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      size: { width: 640, height: 400 },
      encoding: 'bgra',
    });
    const processor = new PilotImageProcessor();
    const rendered = await processor.render(baseRequest(frame, { maxBytes: 512 }));
    expect(rendered.mimeType).toBe('image/jpeg');
    expect(statsOf(rendered).encoding.reason).toBe('png-over-budget');
  });

  it('reports a byte length that matches the payload the policy will measure', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      size: { width: 320, height: 240 },
      encoding: 'bgra',
    });
    const processor = new PilotImageProcessor();
    const rendered = await processor.render(baseRequest(frame));
    expect(Buffer.from(rendered.base64, 'base64').byteLength).toBe(rendered.byteLength);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('cancellation', () => {
  it('refuses a render whose signal has already fired', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      size: { width: 200, height: 160 },
      encoding: 'png',
    });
    const controller = new AbortController();
    controller.abort();
    const processor = new PilotImageProcessor();
    await expect(processor.render(baseRequest(frame), controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
      retryable: true,
    });
  });

  it('discards the result when the abort fires during the encode', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      size: { width: 320, height: 240 },
      encoding: 'bgra',
    });
    const controller = new AbortController();
    const base = createDefaultFrameCodec();
    let encodeCalls = 0;
    const codec: FrameCodec = {
      ...base,
      async encodePng(pixels) {
        encodeCalls += 1;
        // The abort lands while the encoder is running, which is the case §15
        // cares about: encoding is the slow step an agent aborts during.
        controller.abort();
        return base.encodePng(pixels);
      },
    };
    const processor = new PilotImageProcessor({ codec });
    await expect(processor.render(baseRequest(frame), controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(encodeCalls).toBe(1);
  });

  it('honours an abort raised between the decode and the encode', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      size: { width: 320, height: 240 },
      encoding: 'bgra',
    });
    const controller = new AbortController();
    const base = createDefaultFrameCodec();
    const codec: FrameCodec = {
      ...base,
      async decode(bytes, encoding, declaredSize) {
        const pixels = await base.decode(bytes, encoding, declaredSize);
        controller.abort();
        return pixels;
      },
    };
    const processor = new PilotImageProcessor({ codec });
    await expect(processor.render(baseRequest(frame), controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
  });
});

// ---------------------------------------------------------------------------
// Decode reuse, measurement, and honesty about the declared size
// ---------------------------------------------------------------------------

describe('decoding', () => {
  it('decodes one frame once even when an observation asks for two images of it', async () => {
    const { frame, screen } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_RETINA.windowId,
      size: RETINA_SIZE,
      encoding: 'png',
    });
    let decodes = 0;
    const base = createDefaultFrameCodec();
    const codec: FrameCodec = {
      ...base,
      async decode(bytes, encoding, declaredSize) {
        decodes += 1;
        return base.decode(bytes, encoding, declaredSize);
      },
    };
    const processor = new PilotImageProcessor({ codec });
    const redactions = [pixelRect(screen.regions.passwordField, frame.size)];

    const full = await processor.render(baseRequest(frame, { maxEdge: 400, redactions }));
    const marker = { x: 600, y: 400 };
    const crop = await processor.render(
      baseRequest(frame, {
        purpose: 'pointer',
        maxEdge: 640,
        crop: pointerCropRect(marker, 640, frame.size),
        marker,
        redactions,
      }),
    );

    expect(decodes).toBe(1);
    expect(statsOf(full).decodeCacheHit).toBe(false);
    expect(statsOf(crop).decodeCacheHit).toBe(true);

    processor.clear();
    await processor.render(baseRequest(frame, { maxEdge: 400, redactions }));
    expect(decodes).toBe(2);
  });

  it('does not let one render scribble on the decode the next one reuses', async () => {
    const { frame, screen } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_RETINA.windowId,
      size: { width: 600, height: 400 },
      encoding: 'png',
    });
    const processor = new PilotImageProcessor();
    const redactions = [pixelRect(screen.regions.passwordField, frame.size)];

    await processor.render(baseRequest(frame, { redactions }));
    const second = await processor.render(baseRequest(frame, { redactions: [] }));
    // The second render asked for no mask, so the secret is back: proof that
    // the first render's mask was painted on a copy and not on the cache.
    expect(countSecretPixels(await decodeRendered(second))).toBeGreaterThan(50);
  });

  it('rescales the policy’s rectangles when the payload disagrees with the declared size', async () => {
    const screen = renderSyntheticScreen({ size: { width: 300, height: 200 } });
    const bytes = await encodePng(screen.pixels);
    const frame: CapturedFrame = {
      frameId: asFrameId('mismatch-0001'),
      windowId: FIXTURE_WINDOW_RETINA.windowId,
      capturedAt: FAKE_EPOCH_MS,
      // The adapter claims twice the size the payload actually carries.
      size: { width: 600, height: 400 },
      scaleFactor: 2,
      encoding: 'png',
      bytes,
    };
    const processor = new PilotImageProcessor();
    const rendered = await processor.render(
      baseRequest(frame, {
        redactions: [pixelRect(screen.regions.passwordField, { width: 600, height: 400 })],
      }),
    );
    expect(statsOf(rendered).declaredSizeMismatch).toBe(true);
    expect(rendered.size).toStrictEqual({ width: 300, height: 200 });
    // Rescaled correctly, so the secret is still covered.
    expect(countSecretPixels(await decodeRendered(rendered))).toBe(0);
  });

  it('reports a stage breakdown that adds up to the total', async () => {
    const { frame } = await fixtureFrame({
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      size: { width: 200, height: 160 },
      encoding: 'bgra',
    });
    const processor = new PilotImageProcessor({ stopwatch: countingStopwatch() });
    const stats = statsOf(await processor.render(baseRequest(frame)));
    expect(stats.decodeMs).toBeGreaterThan(0);
    expect(stats.encodeMs).toBeGreaterThan(0);
    expect(stats.totalMs).toBeGreaterThanOrEqual(
      stats.decodeMs + stats.redactMs + stats.cropMs + stats.resizeMs + stats.encodeMs,
    );
  });
});

// ---------------------------------------------------------------------------
// Through the policy, which is the only way the app ever calls this
// ---------------------------------------------------------------------------

describe('behind the §10 policy enforcer', () => {
  it('produces a full frame and a masked pointer crop for view: both', async () => {
    const clock = createFakeClock(FAKE_EPOCH_MS);
    const geometry = IMAGE_FIXTURE_GEOMETRY_STANDARD;
    const window = FIXTURE_WINDOW_SECONDARY;
    const core = new ObservationCore({ clock, ids: createIdFactory(createCounterIdSource()) });
    const policy = defineScreenPolicy();
    const processor = new PilotImageProcessor();
    const enforcer = new ScreenPolicyEnforcer({
      clock,
      policy,
      images: processor,
      ids: createIdFactory(createCounterIdSource()),
    });

    const { frame, screen } = await fixtureFrame({
      windowId: window.windowId,
      size: geometry.captureSize,
      scaleFactor: 1,
      encoding: 'png',
      capturedAt: FAKE_EPOCH_MS,
    });
    core.selectWindow({ window, geometry, accessibilityRootId: 'ax-root-1' });
    core.ingestFrame(frame);
    const secureCentre = {
      x: screen.regions.passwordField.x + screen.regions.passwordField.width / 2,
      y: screen.regions.passwordField.y + screen.regions.passwordField.height / 2,
    };
    core.ingestPointer({
      at: FAKE_EPOCH_MS,
      windowId: window.windowId,
      pointer: buildGroundedPointer(normalizedToScreen(secureCentre, geometry), geometry),
    });

    const decision = await enforcer.evaluate({
      request: { view: 'both', moment: 'question' },
      at: FAKE_EPOCH_MS,
      questionAt: FAKE_EPOCH_MS,
      state: {
        enabled: true,
        paused: false,
        screenLocked: false,
        permissions: { screenRecording: 'granted', accessibility: 'granted' },
        selectedWindow: window,
        geometry,
        scene: core.scene,
        captureSource: 'selected-window',
      },
      source: {
        selectFrame: (at, query) => core.selectFrame(at, query),
        selectPointer: (at, query) => core.selectPointer(at, query),
        checkScene: (ref) => core.checkScene(ref),
      },
      // PR-013 supplies this flag; the pipeline only ever sees the rectangle.
      pointerTarget: {
        role: 'AXTextField',
        label: 'Password',
        value: 'hunter2',
        bounds: {
          x: geometry.bounds.x + screen.regions.passwordField.x * geometry.bounds.width,
          y: geometry.bounds.y + screen.regions.passwordField.y * geometry.bounds.height,
          width: screen.regions.passwordField.width * geometry.bounds.width,
          height: screen.regions.passwordField.height * geometry.bounds.height,
        },
        isSecure: true,
      },
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) {
      return;
    }
    expect(decision.redaction.maskedRegions).toBe(1);
    expect(decision.redaction.guarantee).toBe('best-effort');
    expect(decision.observation.images.map((image) => image.purpose)).toStrictEqual([
      'window',
      'pointer',
    ]);
    // The secure field's value never leaves the policy layer either.
    expect(decision.observation.target?.value).toBeUndefined();

    for (const image of decision.images) {
      expect(countSecretPixels(await decodeRendered(image))).toBe(0);
      expect(Math.max(image.size.width, image.size.height)).toBeLessThanOrEqual(
        image.purpose === 'pointer'
          ? policy.image.pointerCropPixels
          : policy.image.fullFrameMaxEdge,
      );
    }
  });
});
