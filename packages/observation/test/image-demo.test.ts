import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runImagePipelineDemo, type ImageDemoResult } from '../src/image-demo.js';
import { decodePng } from '../src/image-codec.js';
import { countSecretPixels } from '../src/image-fixtures.js';
import type { Stopwatch } from '../src/image-processor.js';
import { SCREEN_REDACTION_CAVEAT } from '../src/screen-policy.js';

/**
 * The PR-018 demo is the documented verification procedure, so what it produces
 * is pinned here.
 *
 * The approval is on **decoded pixels**, not on encoded bytes: `zlib` and the
 * JPEG encoder are entitled to pack the same picture differently on a different
 * runtime, and pinning bytes would turn a Node upgrade into a failing suite
 * while still not noticing a marker drawn in the wrong place. A change to what
 * the pipeline *draws* moves these digests; a change to how a codec *packs* it
 * does not.
 */

/** Approved artefacts: name → decoded-pixel digest. */
const APPROVED: Readonly<Record<string, string>> = {
  'full-frame-standard-passthrough': 'px_a9655a64_1000x700',
  'full-frame-retina-resized': 'px_293a9e83_1440x960',
  'full-frame-retina-redacted': 'px_5722ce27_1440x960',
  'pointer-crop-retina': 'px_44052cbf_640x640',
  'pointer-crop-standard': 'px_c2285204_640x640',
  'pointer-crop-clamped-at-edge': 'px_a8f6e530_640x640',
  'pointer-crop-redacted': 'px_27bccbaf_640x640',
  'comparison-before': 'px_27912034_1000x700',
  'comparison-after': 'px_4159622c_1000x700',
  'photographic-window': 'px_143f4e1f_800x500',
};

/** Ticks one unit per reading, so the printed timings are the same every run. */
function fixedStopwatch(): Stopwatch {
  let ticks = 0;
  return {
    elapsed: () => {
      ticks += 1;
      return ticks;
    },
  };
}

describe('image pipeline demo', () => {
  let outDir = '';
  let result: ImageDemoResult;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'pilot-image-demo-'));
    result = await runImagePipelineDemo({
      outDir,
      stopwatch: fixedStopwatch(),
      budgetAttempts: 1,
    });
  }, 180_000);

  afterAll(async () => {
    if (outDir !== '') {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('produces exactly the approved artefacts', () => {
    expect(result.artifacts.map((artifact) => artifact.name)).toStrictEqual(Object.keys(APPROVED));
  });

  it('draws exactly the approved pixels', () => {
    const digests = Object.fromEntries(
      result.artifacts.map((artifact) => [artifact.name, artifact.pixelDigest]),
    );
    expect(digests).toStrictEqual(APPROVED);
  });

  it('writes every artefact to disk and prints its dimensions and byte size', async () => {
    const files = await readdir(outDir);
    expect(files).toHaveLength(result.artifacts.length);
    for (const artifact of result.artifacts) {
      const bytes = await readFile(artifact.file);
      expect(bytes.byteLength).toBe(artifact.bytes);
      expect(
        result.lines.some(
          (line) =>
            line.includes(artifact.name) &&
            line.includes(`${String(artifact.size.width)}×${String(artifact.size.height)}`) &&
            line.includes(String(artifact.bytes)),
        ),
      ).toBe(true);
    }
  });

  it('is deterministic: two runs print the same thing', async () => {
    const second = await runImagePipelineDemo({
      outDir,
      stopwatch: fixedStopwatch(),
      budgetAttempts: 1,
    });
    expect(second.lines).toStrictEqual(result.lines);
  }, 180_000);

  it('passes the full frame through untouched when nothing has to change', () => {
    const passthrough = result.artifacts.find(
      (artifact) => artifact.name === 'full-frame-standard-passthrough',
    );
    expect(passthrough?.path).toBe('pass-through');
    expect(passthrough?.bytes).toBe(passthrough?.sourceBytes);
    expect(passthrough?.mimeType).toBe('image/jpeg');
  });

  it('keeps every full frame inside the 1440 px policy edge and every crop at 640', () => {
    for (const artifact of result.artifacts) {
      const bound = artifact.purpose === 'pointer' ? 640 : 1440;
      expect(Math.max(artifact.size.width, artifact.size.height)).toBeLessThanOrEqual(bound);
    }
  });

  it('leaves no trace of the secret in either redacted artefact', async () => {
    for (const name of ['full-frame-retina-redacted', 'pointer-crop-redacted']) {
      const artifact = result.artifacts.find((candidate) => candidate.name === name);
      expect(artifact?.redactionsApplied).toBe(1);
      expect(artifact?.mimeType).toBe('image/png');
      const pixels = await decodePng(Uint8Array.from(await readFile(artifact?.file ?? '')));
      expect(countSecretPixels(pixels)).toBe(0);
    }
  });

  it('chooses lossless for interface content and JPEG for photographic content', () => {
    const byName = new Map(result.artifacts.map((artifact) => [artifact.name, artifact]));
    expect(byName.get('pointer-crop-retina')?.encodingReason).toBe('flat-interface-content');
    expect(byName.get('photographic-window')?.encodingReason).toBe('photographic-content');
    expect(byName.get('photographic-window')?.mimeType).toBe('image/jpeg');
  });

  it('shows the second JPEG generation costing legibility that PNG does not', () => {
    const section = result.lines.join('\n');
    expect(section).toContain('capture encodes once (JPEG q0.75)');
    expect(section).toContain('…then the pipeline encodes the crop again');
    expect(section).toContain('…or the pipeline encodes the crop as PNG');
  });

  it('states the preprocessing budget and the redaction caveat verbatim', () => {
    expect(result.lines.some((line) => line.includes('under 150 ms per observation'))).toBe(true);
    expect(result.lines).toContain(SCREEN_REDACTION_CAVEAT);
  });
});
