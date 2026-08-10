import { describe, expect, it } from 'vitest';
import { asFrameId, type CapturedFrame, type FrameEncoding } from '@pilot/shared';
import { FAKE_EPOCH_MS, FIXTURE_WINDOW_RETINA } from '@pilot/platform/fakes';
import {
  chunkHashes,
  contentChangeRatio,
  contentSignature,
  ContentFingerprinter,
  DEFAULT_CONTENT_CHANGE_THRESHOLD,
} from '../src/content-fingerprint.js';

/**
 * The fingerprint rule is a judgement call, so these tests pin both halves of
 * it: what it must notice, and what it is documented as being unable to
 * notice. A change to the rule that breaks the second group is as much of a
 * regression as one that breaks the first.
 */

const PAYLOAD = 32 * 1024;

function bytes(seed: number, length = PAYLOAD, into?: Uint8Array, offset = 0): Uint8Array {
  const buffer = into ?? new Uint8Array(length);
  let state = (seed * 2654435761) >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    buffer[offset + index] = (state >>> 24) & 0xff;
  }
  return buffer;
}

/**
 * Models an entropy-coded frame: everything after the first changed byte is
 * different, which is what a JPEG bit stream actually does.
 */
function divergedFrom(baseline: Uint8Array, keepFraction: number, seed: number): Uint8Array {
  const keep = Math.round(baseline.length * keepFraction);
  const next = new Uint8Array(baseline.length);
  next.set(baseline.subarray(0, keep), 0);
  bytes(seed, baseline.length - keep, next, keep);
  return next;
}

let frameCounter = 0;
function frame(
  payload: Uint8Array,
  encoding: FrameEncoding = 'jpeg',
  size?: number,
): CapturedFrame {
  frameCounter += 1;
  return {
    frameId: asFrameId(`fingerprint-${String(frameCounter)}`),
    windowId: FIXTURE_WINDOW_RETINA.windowId,
    capturedAt: FAKE_EPOCH_MS,
    size: { width: size ?? 2400, height: 1600 },
    scaleFactor: 2,
    encoding,
    bytes: payload,
  };
}

describe('content-defined chunking', () => {
  it('cuts the same payload the same way in every run', () => {
    const payload = bytes(1);
    expect(chunkHashes(payload, 256)).toStrictEqual(chunkHashes(payload, 256));
    expect(chunkHashes(payload, 256).length).toBeGreaterThan(50);
  });

  it('keeps the chunks of an unchanged prefix when the tail changes', () => {
    const baseline = bytes(2);
    const changed = divergedFrom(baseline, 0.9, 99);
    const before = new Set(chunkHashes(baseline, 256));
    const after = new Set(chunkHashes(changed, 256));
    let shared = 0;
    for (const chunk of after) {
      if (before.has(chunk)) {
        shared += 1;
      }
    }
    expect(shared / before.size).toBeGreaterThan(0.8);
  });
});

describe('ContentFingerprinter decisions', () => {
  it('mints on the first frame and reports why', () => {
    const fingerprinter = new ContentFingerprinter();
    const update = fingerprinter.observe(frame(bytes(3)));
    expect(update).toMatchObject({ changed: true, reason: 'first-frame', changeRatio: 1 });
    expect(update.fingerprint).toMatch(/^cf_[0-9a-f]{8}$/);
    expect(fingerprinter.fingerprint).toBe(update.fingerprint);
  });

  it('holds the fingerprint steady through encoder noise', () => {
    const fingerprinter = new ContentFingerprinter();
    const baseline = bytes(4);
    const first = fingerprinter.observe(frame(baseline));
    for (let index = 0; index < 10; index += 1) {
      const noisy = divergedFrom(baseline, 0.96, 500 + index);
      const update = fingerprinter.observe(frame(noisy));
      expect(update.changed).toBe(false);
      expect(update.reason).toBe('below-threshold');
      expect(update.changeRatio).toBeLessThan(DEFAULT_CONTENT_CHANGE_THRESHOLD);
      expect(update.fingerprint).toBe(first.fingerprint);
    }
    expect(fingerprinter.metrics()).toMatchObject({
      framesExamined: 11,
      fingerprintsMinted: 1,
      belowThreshold: 10,
    });
  });

  it('mints a new fingerprint when most of the payload changes', () => {
    const fingerprinter = new ContentFingerprinter();
    const first = fingerprinter.observe(frame(bytes(5)));
    const update = fingerprinter.observe(frame(bytes(6)));
    expect(update.changed).toBe(true);
    expect(update.reason).toBe('content-changed');
    expect(update.changeRatio).toBeGreaterThan(0.9);
    expect(update.fingerprint).not.toBe(first.fingerprint);
  });

  it('accumulates drift against the anchor, not against the previous frame', () => {
    // Each step changes 4% — below the threshold on its own. Compared with the
    // frame that minted the fingerprint they add up, and the rule notices.
    const fingerprinter = new ContentFingerprinter({ changeThreshold: 0.15 });
    let payload = bytes(7);
    fingerprinter.observe(frame(payload));
    const verdicts: boolean[] = [];
    for (let step = 1; step <= 6; step += 1) {
      payload = divergedFrom(payload, 1 - 0.04 * step, 700 + step);
      verdicts.push(fingerprinter.observe(frame(payload)).changed);
    }
    expect(verdicts).toContain(true);
    expect(verdicts.indexOf(true)).toBeGreaterThan(0);
  });

  it('always mints when the encoding or the capture size changes', () => {
    const fingerprinter = new ContentFingerprinter();
    const payload = bytes(8);
    fingerprinter.observe(frame(payload));
    expect(fingerprinter.observe(frame(payload, 'png'))).toMatchObject({
      changed: true,
      reason: 'encoding-changed',
    });
    expect(fingerprinter.observe(frame(payload, 'png', 1200))).toMatchObject({
      changed: true,
      reason: 'capture-size-changed',
    });
  });

  it('produces the same token for the same content in a fresh instance', () => {
    const payload = bytes(9);
    const first = new ContentFingerprinter().observe(frame(payload));
    const second = new ContentFingerprinter().observe(frame(payload));
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('drops the anchor on reset, so the next frame mints again', () => {
    const fingerprinter = new ContentFingerprinter();
    fingerprinter.observe(frame(bytes(10)));
    fingerprinter.reset();
    expect(fingerprinter.fingerprint).toBeNull();
    expect(fingerprinter.anchor).toBeNull();
    expect(fingerprinter.observe(frame(bytes(10)))).toMatchObject({ reason: 'first-frame' });
    expect(fingerprinter.metrics().resets).toBe(1);
  });
});

describe('documented blind spots', () => {
  it('cannot see a small-area change: the toggle that flips stays below the bar', () => {
    const fingerprinter = new ContentFingerprinter();
    const baseline = bytes(11);
    const before = fingerprinter.observe(frame(baseline));
    // 3% of the payload: one control repainting near the bottom of the window.
    const afterToggle = divergedFrom(baseline, 0.97, 1234);
    const update = fingerprinter.observe(frame(afterToggle));
    expect(update.changed).toBe(false);
    expect(update.fingerprint).toBe(before.fingerprint);
  });

  it('is position sensitive: the same edit near the top reads as a large change', () => {
    const baseline = bytes(12);
    const nearTop = divergedFrom(baseline, 0.05, 4321);
    const nearBottom = divergedFrom(baseline, 0.97, 4321);
    const anchor = contentSignature(frame(baseline));
    expect(contentChangeRatio(anchor, contentSignature(frame(nearTop)))).toBeGreaterThan(0.9);
    expect(contentChangeRatio(anchor, contentSignature(frame(nearBottom)))).toBeLessThan(0.1);
  });

  it('reports a full change for signatures that are not comparable', () => {
    const payload = bytes(13);
    const jpeg = contentSignature(frame(payload, 'jpeg'));
    const png = contentSignature(frame(payload, 'png'));
    const resized = contentSignature(frame(payload, 'jpeg', 1200));
    expect(contentChangeRatio(jpeg, png)).toBe(1);
    expect(contentChangeRatio(jpeg, resized)).toBe(1);
  });

  it('treats an empty payload as unchanged rather than throwing', () => {
    const empty = contentSignature(frame(new Uint8Array(0)));
    expect(contentChangeRatio(empty, empty)).toBe(0);
  });
});
