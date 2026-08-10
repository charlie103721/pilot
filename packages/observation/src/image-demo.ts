import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  normalizedRectToCapturedPixelRect,
  normalizedToCapturedPixel,
  pointerCropRect,
  type CapturedFrame,
  type FrameEncoding,
  type NormalizedPoint,
  type PixelRect,
  type PixelSize,
} from '@pilot/shared';
import { FIXTURE_WINDOW_RETINA, FIXTURE_WINDOW_SECONDARY } from '@pilot/platform/fakes';
import { fnv1a32Bytes, toHex32 } from './hashing.js';
import { decodeJpeg, decodePng, encodeJpeg } from './image-codec.js';
import {
  createImageFixtureFrame,
  IMAGE_FIXTURE_GEOMETRY_RETINA,
  IMAGE_FIXTURE_GEOMETRY_STANDARD,
  renderSyntheticScreen,
  toBgraBytes,
  type SyntheticScreen,
} from './image-fixtures.js';
import { PilotImageProcessor, performanceStopwatch, type Stopwatch } from './image-processor.js';
import type {
  ImageRenderRequest,
  ObservationImagePurpose,
  RenderedImage,
} from './image-pipeline.js';
import { cropPixels, measureContent, type IntegralRect, type PixelBuffer } from './pixel-buffer.js';
import { DEFAULT_SCREEN_CONTEXT_POLICY, SCREEN_REDACTION_CAVEAT } from './screen-policy.js';

/**
 * PR-018 demo: "generate approved full-frame and crop artifacts from fixture
 * images".
 *
 *     pnpm build && pnpm --filter @pilot/observation demo:image
 *
 * It renders the synthetic billing-settings window at a Retina and a
 * standard-DPI capture size, runs each §10 step-5 scenario through the real
 * pipeline, writes the resulting images to `packages/observation/artifacts/`
 * and prints, for each, its size in pixels, its size in bytes, the encoding the
 * pipeline chose and why, and what it cost. Nothing is captured, nothing is
 * random, and no image is retained anywhere else.
 *
 * The **approved** part is the digest column: an artefact is approved by its
 * decoded *pixels*, not by its bytes, because `zlib` and the JPEG encoder are
 * free to emit different bytes for the same picture on a different runtime.
 * `image-demo.test.ts` pins those digests, so a change in what the pipeline
 * draws fails the suite while a change in how a codec packs it does not.
 */

const POLICY = DEFAULT_SCREEN_CONTEXT_POLICY;

export interface ImageArtifact {
  readonly name: string;
  readonly file: string;
  readonly purpose: ObservationImagePurpose;
  readonly sourceEncoding: FrameEncoding;
  readonly sourceSize: PixelSize;
  readonly sourceBytes: number;
  readonly mimeType: RenderedImage['mimeType'];
  readonly size: PixelSize;
  readonly bytes: number;
  readonly encodingReason: string;
  readonly path: string;
  readonly redactionsApplied: number;
  /** Digest of the decoded pixels — what is actually approved. */
  readonly pixelDigest: string;
  readonly totalMs: number;
}

export interface ImageDemoResult {
  readonly lines: readonly string[];
  readonly artifacts: readonly ImageArtifact[];
  readonly outDir: string;
}

export interface ImageDemoOptions {
  /** Where artefacts are written. Defaults to `packages/observation/artifacts`. */
  readonly outDir?: string;
  /** Injected for the determinism test; the CLI uses the real timer. */
  readonly stopwatch?: Stopwatch;
  /** Skip the file writes (used by the tests that only inspect the numbers). */
  readonly write?: boolean;
  /**
   * Measured runs per row of the budget table, after one warm-up. Three is a
   * fair steady-state reading; the suite uses one so the demo test does not
   * dominate `pnpm test`.
   */
  readonly budgetAttempts?: number;
}

interface Scenario {
  readonly name: string;
  readonly why: string;
  readonly screen: SyntheticScreen;
  readonly frame: CapturedFrame;
  readonly request: ImageRenderRequest;
}

function digestOfPixels(pixels: PixelBuffer): string {
  return `px_${toHex32(fnv1a32Bytes(pixels.data))}_${String(pixels.width)}x${String(pixels.height)}`;
}

async function decodeArtifact(image: RenderedImage): Promise<PixelBuffer> {
  const bytes = Uint8Array.from(Buffer.from(image.base64, 'base64'));
  return image.mimeType === 'image/png' ? decodePng(bytes) : decodeJpeg(bytes);
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function maskRect(screen: SyntheticScreen, size: PixelSize): PixelRect {
  return normalizedRectToCapturedPixelRect(screen.regions.passwordField, size);
}

const TOGGLE_CENTRE: NormalizedPoint = { x: 0.5675, y: 0.4375 };
const PASSWORD_CENTRE: NormalizedPoint = { x: 0.47, y: 0.645 };

async function buildScenarios(): Promise<readonly Scenario[]> {
  const retinaSize = IMAGE_FIXTURE_GEOMETRY_RETINA.captureSize;
  const standardSize = IMAGE_FIXTURE_GEOMETRY_STANDARD.captureSize;

  const retina = await createImageFixtureFrame({
    windowId: FIXTURE_WINDOW_RETINA.windowId,
    frameId: 'demo-retina-0001',
    size: retinaSize,
    scaleFactor: 2,
    encoding: 'jpeg',
  });
  const standard = await createImageFixtureFrame({
    windowId: FIXTURE_WINDOW_SECONDARY.windowId,
    frameId: 'demo-standard-0001',
    size: standardSize,
    scaleFactor: 1,
    encoding: 'jpeg',
  });
  const toggledOff = await createImageFixtureFrame({
    windowId: FIXTURE_WINDOW_SECONDARY.windowId,
    frameId: 'demo-before-0001',
    size: standardSize,
    scaleFactor: 1,
    encoding: 'png',
  });
  const toggledOn = await createImageFixtureFrame({
    windowId: FIXTURE_WINDOW_SECONDARY.windowId,
    frameId: 'demo-after-0001',
    size: standardSize,
    scaleFactor: 1,
    encoding: 'png',
    toggleOn: true,
  });

  const photo = renderSyntheticScreen({ size: { width: 800, height: 500 }, photographic: true });
  const photoNoise = renderSyntheticScreen({ size: { width: 800, height: 500 } });
  // A window filled edge to edge with photographic content: the case where a
  // lossless encode would be several megabytes for no legibility gain.
  for (let index = 0; index < photoNoise.pixels.data.length; index += 4) {
    const hash = ((index * 2_654_435_761) ^ (index >>> 7)) >>> 0;
    photoNoise.pixels.data[index] = (hash >>> 5) & 0xff;
    photoNoise.pixels.data[index + 1] = (hash >>> 13) & 0xff;
    photoNoise.pixels.data[index + 2] = (hash >>> 21) & 0xff;
    photoNoise.pixels.data[index + 3] = 255;
  }
  const photoFrame: CapturedFrame = {
    frameId: retina.frame.frameId,
    windowId: FIXTURE_WINDOW_SECONDARY.windowId,
    capturedAt: retina.frame.capturedAt,
    size: { width: 800, height: 500 },
    scaleFactor: 1,
    encoding: 'bgra',
    bytes: toBgraBytes(photoNoise.pixels),
  };

  const base = (frame: CapturedFrame, overrides: Partial<ImageRenderRequest>): ImageRenderRequest =>
    ({
      frame,
      purpose: 'window',
      maxEdge: POLICY.image.fullFrameMaxEdge,
      redactions: [],
      jpegQuality: POLICY.image.jpegQuality,
      preferLossless: false,
      maxBytes: POLICY.image.maxImageBytes,
      ...overrides,
    }) as ImageRenderRequest;

  const retinaPointer = normalizedToCapturedPixel(TOGGLE_CENTRE, retinaSize);
  const standardPointer = normalizedToCapturedPixel(TOGGLE_CENTRE, standardSize);
  const cornerPointer = { x: 12, y: 9 };
  const secretPointer = normalizedToCapturedPixel(PASSWORD_CENTRE, standardSize);

  return [
    {
      name: 'full-frame-standard-passthrough',
      why: 'already inside the 1440 px bound and nothing to change: the capture’s own bytes',
      screen: standard.screen,
      frame: standard.frame,
      request: base(standard.frame, { purpose: 'window' }),
    },
    {
      name: 'full-frame-retina-resized',
      why: 'a 2× capture reduced to the §10 full-frame bound',
      screen: retina.screen,
      frame: retina.frame,
      request: base(retina.frame, { purpose: 'window' }),
    },
    {
      name: 'full-frame-retina-redacted',
      why: 'the password field masked BEFORE the resize (§10 step 4 then step 5)',
      screen: retina.screen,
      frame: retina.frame,
      request: base(retina.frame, {
        purpose: 'window',
        redactions: [maskRect(retina.screen, retinaSize)],
      }),
    },
    {
      name: 'pointer-crop-retina',
      why: 'a 640 px crop around the grounded pointer, marked so the model sees the target',
      screen: retina.screen,
      frame: retina.frame,
      request: base(retina.frame, {
        purpose: 'pointer',
        maxEdge: POLICY.image.pointerCropPixels,
        crop: pointerCropRect(retinaPointer, POLICY.image.pointerCropPixels, retinaSize),
        marker: retinaPointer,
      }),
    },
    {
      name: 'pointer-crop-standard',
      why: 'the same control on a 1× capture: the same crop covers more of the window',
      screen: standard.screen,
      frame: standard.frame,
      request: base(standard.frame, {
        purpose: 'pointer',
        maxEdge: POLICY.image.pointerCropPixels,
        crop: pointerCropRect(standardPointer, POLICY.image.pointerCropPixels, standardSize),
        marker: standardPointer,
      }),
    },
    {
      name: 'pointer-crop-clamped-at-edge',
      why: 'a pointer in the corner: the crop shifts inside the frame, the marker does not move',
      screen: retina.screen,
      frame: retina.frame,
      request: base(retina.frame, {
        purpose: 'pointer',
        maxEdge: POLICY.image.pointerCropPixels,
        crop: pointerCropRect(cornerPointer, POLICY.image.pointerCropPixels, retinaSize),
        marker: cornerPointer,
      }),
    },
    {
      name: 'pointer-crop-redacted',
      why: 'pointing AT the password field: the crop is of a region that was already masked',
      screen: standard.screen,
      frame: standard.frame,
      request: base(standard.frame, {
        purpose: 'pointer',
        maxEdge: POLICY.image.pointerCropPixels,
        crop: pointerCropRect(secretPointer, POLICY.image.pointerCropPixels, standardSize),
        marker: secretPointer,
        redactions: [maskRect(standard.screen, standardSize)],
      }),
    },
    {
      name: 'comparison-before',
      why: 'before-and-after, first half: Auto Renew is on',
      screen: toggledOff.screen,
      frame: toggledOff.frame,
      request: base(toggledOff.frame, { purpose: 'before', marker: standardPointer }),
    },
    {
      name: 'comparison-after',
      why: 'before-and-after, second half: the toggle has flipped',
      screen: toggledOn.screen,
      frame: toggledOn.frame,
      request: base(toggledOn.frame, { purpose: 'after', marker: standardPointer }),
    },
    {
      name: 'photographic-window',
      why: 'a window full of photographic content, where lossless would be pointless and huge',
      screen: photo,
      frame: photoFrame,
      request: base(photoFrame, { purpose: 'window' }),
    },
  ];
}

interface FidelityReport {
  readonly meanError: number;
  readonly maxError: number;
  /** Share of pixels whose luma moved by more than a just-visible amount. */
  readonly damagedShare: number;
}

/**
 * Luma error against the pixels the compositor produced. This is the
 * double-JPEG risk from `docs/handoff.md` §5, measured rather than argued
 * about: two images of the same size, one difference.
 */
function fidelity(reference: PixelBuffer, candidate: PixelBuffer): FidelityReport {
  const width = Math.min(reference.width, candidate.width);
  const height = Math.min(reference.height, candidate.height);
  let total = 0;
  let max = 0;
  let damaged = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = (y * reference.width + x) * 4;
      const b = (y * candidate.width + x) * 4;
      const lumaA =
        ((reference.data[a] ?? 0) * 306 +
          (reference.data[a + 1] ?? 0) * 601 +
          (reference.data[a + 2] ?? 0) * 117) >>
        10;
      const lumaB =
        ((candidate.data[b] ?? 0) * 306 +
          (candidate.data[b + 1] ?? 0) * 601 +
          (candidate.data[b + 2] ?? 0) * 117) >>
        10;
      const error = Math.abs(lumaA - lumaB);
      total += error;
      max = Math.max(max, error);
      if (error > 8) {
        damaged += 1;
      }
      count += 1;
    }
  }
  return {
    meanError: count === 0 ? 0 : total / count,
    maxError: max,
    damagedShare: count === 0 ? 0 : damaged / count,
  };
}

function cropOf(buffer: PixelBuffer, rect: IntegralRect): PixelBuffer {
  return cropPixels(buffer, rect);
}

export async function runImagePipelineDemo(
  options: ImageDemoOptions = {},
): Promise<ImageDemoResult> {
  const outDir = options.outDir ?? fileURLToPath(new URL('../artifacts/', import.meta.url));
  const write = options.write ?? true;
  const stopwatch = options.stopwatch ?? performanceStopwatch;
  const budgetAttempts = Math.max(1, options.budgetAttempts ?? 3);
  const lines: string[] = [];
  const out = (line = ''): void => {
    lines.push(line);
  };
  const heading = (text: string): void => {
    out();
    out(text);
    out('-'.repeat(text.length));
  };

  heading('1. The image parameters the policy hands to §10 step 5');
  out(`full frame longest edge  ${String(POLICY.image.fullFrameMaxEdge)} px`);
  out(`pointer crop             ${String(POLICY.image.pointerCropPixels)} px square`);
  out(`jpeg quality             ${String(POLICY.image.jpegQuality)}`);
  out(
    `byte ceilings            ${String(POLICY.image.maxImageBytes)} B per image, ${String(POLICY.image.maxObservationBytes)} B per observation`,
  );
  out('The pipeline decides HOW an image is produced. Whether one may be produced');
  out('at all — permission, window identity, lineage, counts, bytes — stays in the');
  out('policy enforcer, which calls this and then measures what it gets back.');

  heading('2. Fixture screens');
  out(
    `Retina    ${String(IMAGE_FIXTURE_GEOMETRY_RETINA.captureSize.width)}×${String(IMAGE_FIXTURE_GEOMETRY_RETINA.captureSize.height)} captured px at ${String(IMAGE_FIXTURE_GEOMETRY_RETINA.scaleFactor)}× — above the 1440 px bound, so always resized`,
  );
  out(
    `Standard  ${String(IMAGE_FIXTURE_GEOMETRY_STANDARD.captureSize.width)}×${String(IMAGE_FIXTURE_GEOMETRY_STANDARD.captureSize.height)} captured px at ${String(IMAGE_FIXTURE_GEOMETRY_STANDARD.scaleFactor)}× — already inside it, so never resized`,
  );
  out('Both draw the same synthetic billing-settings window: a sidebar, rows of');
  out('small text, an Auto Renew toggle and a password field whose contents are a');
  out('colour that appears nowhere else, so "was it masked?" has a real answer.');

  const scenarios = await buildScenarios();
  const processor = new PilotImageProcessor({ stopwatch });
  const artifacts: ImageArtifact[] = [];

  if (write) {
    await mkdir(outDir, { recursive: true });
  }

  heading('3. Artefacts');
  out(
    `${pad('artefact', 32)}${pad('source', 24)}${padStart('src B', 9)}  ${pad('out', 11)}${padStart('out B', 9)}  ${pad('encoding', 34)}pixel digest`,
  );
  // One throwaway pass so the first artefact's timing is not V8 warming up.
  const warmUp = scenarios[0];
  if (warmUp !== undefined) {
    await processor.render(warmUp.request);
  }

  for (const scenario of scenarios) {
    processor.clear();
    const image = await processor.render(scenario.request);
    const stats = image.stats;
    const pixels = await decodeArtifact(image);
    const extension = image.mimeType === 'image/png' ? 'png' : 'jpg';
    const file = `${outDir.replace(/\/$/, '')}/${scenario.name}.${extension}`;
    if (write) {
      await writeFile(file, Buffer.from(image.base64, 'base64'));
    }
    const artifact: ImageArtifact = {
      name: scenario.name,
      file,
      purpose: image.purpose,
      sourceEncoding: scenario.frame.encoding,
      sourceSize: scenario.frame.size,
      sourceBytes: scenario.frame.bytes.byteLength,
      mimeType: image.mimeType,
      size: image.size,
      bytes: image.byteLength,
      encodingReason: stats?.encoding.reason ?? 'unknown',
      path: stats?.path ?? 'unknown',
      redactionsApplied: image.redactionsApplied,
      pixelDigest: digestOfPixels(pixels),
      totalMs: stats?.totalMs ?? 0,
    };
    artifacts.push(artifact);
    out(
      `${pad(artifact.name, 32)}` +
        `${pad(`${artifact.sourceEncoding} ${String(artifact.sourceSize.width)}×${String(artifact.sourceSize.height)}`, 24)}` +
        `${padStart(String(artifact.sourceBytes), 9)}  ` +
        `${pad(`${String(artifact.size.width)}×${String(artifact.size.height)}`, 11)}` +
        `${padStart(String(artifact.bytes), 9)}  ` +
        `${pad(`${artifact.mimeType} (${artifact.encodingReason})`, 34)}${artifact.pixelDigest}`,
    );
    out(`${pad('', 32)}${scenario.why}`);
    out(
      `${pad('', 32)}path=${artifact.path} masks=${String(artifact.redactionsApplied)} ${artifact.totalMs.toFixed(1)} ms`,
    );
  }
  if (write) {
    out();
    out(`Artefacts written to ${outDir}`);
  }

  heading('4. Double-JPEG legibility (docs/handoff.md §5), measured');
  const reference = renderSyntheticScreen({ size: { width: 1000, height: 700 } });
  const captured = decodeJpeg(encodeJpeg(reference.pixels, POLICY.image.jpegQuality));
  // A pointer crop starts at whatever pixel the user pointed at, which is
  // almost never a multiple of 8. That is what makes the second encode cost
  // something: re-encoding a JPEG on its own block grid is nearly free, and
  // re-encoding it on a shifted grid is where glyph edges smear.
  const cropRect: IntegralRect = { x: 333, y: 205, width: 512, height: 384 };
  const referenceCrop = cropOf(reference.pixels, cropRect);
  const capturedCrop = cropOf(captured, cropRect);
  const secondGeneration = decodeJpeg(encodeJpeg(capturedCrop, POLICY.image.jpegQuality));

  const oneGeneration = fidelity(referenceCrop, capturedCrop);
  const twoGenerations = fidelity(referenceCrop, secondGeneration);
  const stats = measureContent(reference.pixels, 4);

  out(`Pointer crop at ${String(cropRect.x)},${String(cropRect.y)} — deliberately not on a JPEG`);
  out('block boundary, because a pointer never is. Error is luma against the pixels');
  out('the compositor produced; "damaged" is the share of pixels off by more than 8.');
  out(`${pad('', 46)}${padStart('mean', 8)}${padStart('max', 7)}${padStart('damaged', 10)}`);
  out(
    `${pad('capture encodes once (JPEG q0.75)', 46)}${padStart(oneGeneration.meanError.toFixed(2), 8)}${padStart(String(oneGeneration.maxError), 7)}${padStart(`${(oneGeneration.damagedShare * 100).toFixed(2)}%`, 10)}`,
  );
  out(
    `${pad('…then the pipeline encodes the crop again', 46)}${padStart(twoGenerations.meanError.toFixed(2), 8)}${padStart(String(twoGenerations.maxError), 7)}${padStart(`${(twoGenerations.damagedShare * 100).toFixed(2)}%`, 10)}`,
  );
  out(
    `${pad('…or the pipeline encodes the crop as PNG', 46)}${padStart(oneGeneration.meanError.toFixed(2), 8)}${padStart(String(oneGeneration.maxError), 7)}${padStart(`${(oneGeneration.damagedShare * 100).toFixed(2)}%`, 10)}`,
  );
  out('The third row is the second row of a lossless encode: identical to one');
  out('generation, because there is no second generation. That is the whole argument');
  out('for the encoding rule below.');
  out();
  out(
    `This window measures flatRunRatio=${stats.flatRunRatio.toFixed(3)}, hardEdgeRatio=${stats.hardEdgeRatio.toFixed(3)} —`,
  );
  out('interface content, so the pipeline encodes it losslessly. Photographic content');
  out('measures a flat-run ratio near zero and takes the JPEG branch, where lossless');
  out('would cost megabytes for no legibility gain.');

  heading('5. Preprocessing budget (system-design §17: under 150 ms per observation)');
  out('One observation = one full frame plus one pointer crop of the same frame,');
  out('which is the ordinary active context §10 budgets. Measured on this machine.');
  out();
  out(
    `${pad('capture', 25)}${pad('source', 7)}${pad('secure field', 14)}${padStart('full', 9)}${padStart('crop', 9)}${padStart('total', 9)}   verdict`,
  );
  for (const capture of BUDGET_CAPTURES) {
    for (const encoding of ['bgra', 'png', 'jpeg'] as const) {
      for (const secure of [false, true]) {
        const measured = await measureObservation(
          capture.size,
          encoding,
          secure,
          stopwatch,
          budgetAttempts,
        );
        out(
          `${pad(capture.label, 25)}${pad(encoding, 7)}${pad(secure ? 'in view' : 'none', 14)}` +
            `${padStart(`${measured.full.toFixed(0)} ms`, 9)}${padStart(`${measured.crop.toFixed(0)} ms`, 9)}` +
            `${padStart(`${measured.total.toFixed(0)} ms`, 9)}   ${measured.total <= 150 ? 'within budget' : 'OVER BUDGET'}`,
        );
      }
    }
  }
  out();
  out(
    `Best of ${String(budgetAttempts)} steady-state run(s) after a warm-up; the numbers move with machine load.`,
  );
  out('Read this table as four findings:');
  out('1. `toCaptureOptions` already bounds capture at the 1440 px policy edge, so');
  out('   the first block is the configuration Pilot actually runs. The second block');
  out('   is what an adapter that ignores the bound would cost.');
  out('2. An encoded frame with no secure field in view costs 0 ms for the full');
  out('   frame: the capture’s own bytes are passed through and no encoder runs.');
  out('   A `bgra` frame cannot be passed through — it is not a container a model');
  out('   accepts — so it always pays one encode.');
  out('3. The one number that misses the budget in the configuration Pilot runs is');
  out('   the pure-JS JPEG *decode*, at ~165 ms for a 1440×960 frame. Capture');
  out('   handing over `bgra` or `png` removes it, and removes the double-JPEG loss');
  out('   in section 4 at the same time. Failing that, `FrameCodec` takes a WASM or');
  out('   native decoder without any caller changing.');
  out('4. Whatever the codec, this work belongs off the main and renderer threads');
  out('   (§17, mvp-01 §10). The pipeline is a pure function of bytes and numbers,');
  out('   so PR-019 can host it in a worker without changing it.');

  heading('6. What redaction promises');
  out(SCREEN_REDACTION_CAVEAT);
  out('The pipeline paints the rectangles the policy hands it, before the crop and');
  out('before the resize, and reports any it could not paint. It does not detect');
  out('secrets and a frame with no masks is not a frame without secrets.');
  out();

  return { lines, artifacts, outDir };
}

interface ObservationTiming {
  readonly full: number;
  readonly crop: number;
  readonly total: number;
}

const BUDGET_CAPTURES: readonly { readonly label: string; readonly size: PixelSize }[] = [
  { label: 'policy-bounded 1440×960', size: { width: 1440, height: 960 } },
  { label: 'unbounded 2400×1600', size: IMAGE_FIXTURE_GEOMETRY_RETINA.captureSize },
];

async function measureObservation(
  size: PixelSize,
  encoding: FrameEncoding,
  secureFieldInView: boolean,
  stopwatch: Stopwatch,
  attempts: number,
): Promise<ObservationTiming> {
  const { frame, screen } = await createImageFixtureFrame({
    windowId: FIXTURE_WINDOW_RETINA.windowId,
    frameId: `budget-${encoding}-${String(size.width)}-0001`,
    size,
    scaleFactor: 2,
    encoding,
  });
  const processor = new PilotImageProcessor({ stopwatch });
  const redactions = secureFieldInView ? [maskRect(screen, size)] : [];
  const pointer = normalizedToCapturedPixel(TOGGLE_CENTRE, size);
  const shared = {
    frame,
    redactions,
    jpegQuality: POLICY.image.jpegQuality,
    preferLossless: false,
    maxBytes: POLICY.image.maxImageBytes,
  };

  // Best of three, after a warm-up pass: a budget is a steady-state claim, and
  // the first run through any of this is V8 compiling it.
  let best: ObservationTiming = {
    full: Number.POSITIVE_INFINITY,
    crop: Number.POSITIVE_INFINITY,
    total: Number.POSITIVE_INFINITY,
  };
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    processor.clear();
    const startedAt = stopwatch.elapsed();
    const full = await processor.render({
      ...shared,
      purpose: 'window',
      maxEdge: POLICY.image.fullFrameMaxEdge,
    });
    const afterFull = stopwatch.elapsed();
    const crop = await processor.render({
      ...shared,
      purpose: 'pointer',
      maxEdge: POLICY.image.pointerCropPixels,
      crop: pointerCropRect(pointer, POLICY.image.pointerCropPixels, size),
      marker: pointer,
    });
    const finishedAt = stopwatch.elapsed();
    // Referenced so the encoders cannot be elided and the sizes are real.
    void full.byteLength;
    void crop.byteLength;
    if (attempt > 0 && finishedAt - startedAt < best.total) {
      best = {
        full: afterFull - startedAt,
        crop: finishedAt - afterFull,
        total: finishedAt - startedAt,
      };
    }
  }
  processor.clear();
  return best;
}
