import { describe, expect, it } from 'vitest';
import {
  asWindowId,
  MVP_SCREEN_POLICY,
  PilotError,
  type CaptureOptions,
  type ObservedWindow,
} from '@pilot/shared';
import {
  captureFrameId,
  decideCapturedAt,
  isFrameForWindow,
  MAX_CAPTURE_EDGE_PIXELS,
  resolveCaptureStream,
  toStandaloneBytes,
  withCaptureSize,
  type CaptureFrameHeader,
} from '@pilot/platform-mac';

/**
 * The screen policy as it applies to capture (system-design §10), and the four
 * frame-admission helpers PR-004's ring depends on. All pure: no transport, no
 * clock, no helper.
 */

const OPTIONS: CaptureOptions = {
  sampleFps: MVP_SCREEN_POLICY.sampleFps,
  maxEdgePixels: MVP_SCREEN_POLICY.fullFrameMaxEdge,
  includeCursor: false,
};

function window(overrides: Partial<ObservedWindow> = {}): ObservedWindow {
  return {
    windowId: asWindowId('mac-window-42'),
    displayId: asWindowId('mac-display-1') as unknown as ObservedWindow['displayId'],
    title: 'Billing Settings',
    applicationName: 'Safari',
    bounds: { x: 100, y: 80, width: 1200, height: 800 },
    scaleFactor: 2,
    isOnScreen: true,
    ...overrides,
  };
}

describe('resolveCaptureStream', () => {
  it('caps the longest edge at the policy value and keeps the aspect ratio', () => {
    const resolved = resolveCaptureStream(window(), 42, OPTIONS);

    // 1200×800 pt at 2× is 2400×1600 backing pixels; 1440 is the cap.
    expect(resolved.sourceSize).toEqual({ width: 2400, height: 1600 });
    expect(resolved.size).toEqual({ width: 1440, height: 960 });
    expect(Math.max(resolved.size.width, resolved.size.height)).toBe(
      MVP_SCREEN_POLICY.fullFrameMaxEdge,
    );
  });

  it('reports the effective scale of the downscaled capture, not the display scale', () => {
    const resolved = resolveCaptureStream(window(), 42, OPTIONS);

    // 1440 captured pixels across 1200 window points.
    expect(resolved.scaleFactor).toBeCloseTo(1.2, 10);
    expect(resolved.scaleFactor).not.toBe(2);
  });

  it('never upscales a window smaller than the cap', () => {
    const small = window({ bounds: { x: 0, y: 0, width: 300, height: 200 }, scaleFactor: 1 });
    const resolved = resolveCaptureStream(small, 42, OPTIONS);

    expect(resolved.size).toEqual({ width: 300, height: 200 });
    expect(resolved.scaleFactor).toBe(1);
  });

  it('caps a tall window on its height', () => {
    const tall = window({ bounds: { x: 0, y: 0, width: 400, height: 1200 }, scaleFactor: 2 });
    const resolved = resolveCaptureStream(tall, 42, OPTIONS);

    expect(resolved.size).toEqual({ width: 480, height: 1440 });
  });

  it('clamps a request above the protocol edge bound', () => {
    const huge = window({ bounds: { x: 0, y: 0, width: 9000, height: 9000 }, scaleFactor: 2 });
    const resolved = resolveCaptureStream(huge, 42, { ...OPTIONS, maxEdgePixels: 100_000 });

    expect(resolved.size.width).toBeLessThanOrEqual(MAX_CAPTURE_EDGE_PIXELS);
    expect(resolved.size.height).toBeLessThanOrEqual(MAX_CAPTURE_EDGE_PIXELS);
  });

  it('derives the drain interval from the sample rate', () => {
    const resolved = resolveCaptureStream(window(), 42, OPTIONS);

    expect(resolved.sampleFps).toBe(3);
    expect(resolved.frameIntervalMs).toBe(333);
  });

  it('clamps an out-of-range sample rate rather than configuring nonsense', () => {
    expect(resolveCaptureStream(window(), 42, { ...OPTIONS, sampleFps: 1_000 }).sampleFps).toBe(30);
    expect(
      resolveCaptureStream(window(), 42, { ...OPTIONS, sampleFps: 0.000_1 }).sampleFps,
    ).toBeCloseTo(0.2, 10);
  });

  it('refuses a window with no area', () => {
    const empty = window({ bounds: { x: 0, y: 0, width: 0, height: 800 } });

    expect(() => resolveCaptureStream(empty, 42, OPTIONS)).toThrowError(PilotError);
    expect(() => resolveCaptureStream(empty, 42, OPTIONS)).toThrowError(/no area/);
  });
});

describe('withCaptureSize', () => {
  it('replaces only the capture size, so geometry conversions follow the stream', () => {
    const geometry = {
      windowId: asWindowId('mac-window-42'),
      displayId: asWindowId('mac-display-1') as never,
      bounds: { x: 100, y: 80, width: 1200, height: 800 },
      scaleFactor: 2,
      captureSize: { width: 2400, height: 1600 },
    };

    const overridden = withCaptureSize(geometry, { width: 1440, height: 960 });

    expect(overridden.captureSize).toEqual({ width: 1440, height: 960 });
    expect(overridden.scaleFactor).toBe(2);
    expect(overridden.bounds).toEqual(geometry.bounds);
    expect(geometry.captureSize).toEqual({ width: 2400, height: 1600 });
  });
});

describe('captureFrameId', () => {
  it('is a pure function of the stream id and sequence', () => {
    expect(captureFrameId('s1', 7)).toBe(captureFrameId('s1', 7));
    expect(captureFrameId('s1', 7)).not.toBe(captureFrameId('s1', 8));
    expect(captureFrameId('s1', 7)).not.toBe(captureFrameId('s2', 7));
  });
});

describe('decideCapturedAt', () => {
  it('keeps a timestamp within tolerance', () => {
    const decision = decideCapturedAt(1_000_050, 1_000_000, 2_000);

    expect(decision).toEqual({ capturedAt: 1_000_050, substituted: false, skewMs: 50 });
  });

  it('substitutes the host clock when the helper is implausibly far ahead', () => {
    const decision = decideCapturedAt(1_100_000, 1_000_000, 2_000);

    expect(decision.substituted).toBe(true);
    expect(decision.capturedAt).toBe(1_000_000);
  });

  it('substitutes the host clock when the helper is implausibly far behind', () => {
    expect(decideCapturedAt(900_000, 1_000_000, 2_000).substituted).toBe(true);
  });

  it('rejects a non-positive or non-finite timestamp', () => {
    expect(decideCapturedAt(0, 1_000_000, 2_000).substituted).toBe(true);
    expect(decideCapturedAt(Number.NaN, 1_000_000, 2_000).substituted).toBe(true);
  });
});

describe('toStandaloneBytes', () => {
  it('leaves a buffer that already owns its whole ArrayBuffer alone', () => {
    const owned = new Uint8Array(64).fill(7);

    expect(toStandaloneBytes(owned)).toBe(owned);
  });

  it('detaches a view so byteLength is the entire retained cost', () => {
    const pool = new Uint8Array(1024).fill(3);
    const view = pool.subarray(100, 164);

    const detached = toStandaloneBytes(view);

    expect(detached).not.toBe(view);
    expect(detached.byteLength).toBe(64);
    expect(detached.buffer.byteLength).toBe(64);
    expect([...detached]).toEqual([...view]);
  });

  it('detaches a pooled Node Buffer, which is a view onto a shared pool', () => {
    const pooled = Buffer.from([1, 2, 3, 4]);
    const detached = toStandaloneBytes(pooled);

    expect(detached.buffer.byteLength).toBe(detached.byteLength);
  });
});

describe('isFrameForWindow', () => {
  const header: CaptureFrameHeader = {
    streamId: 's1',
    sequence: 1,
    windowNumber: 42,
    capturedAt: 1_000,
    timestampFallback: false,
    width: 10,
    height: 10,
    scaleFactor: 1,
    encoding: 'jpeg',
    byteLength: 4,
    contentChanged: true,
  };

  it('accepts only the exact window number', () => {
    expect(isFrameForWindow(header, 42)).toBe(true);
    expect(isFrameForWindow(header, 43)).toBe(false);
  });
});
