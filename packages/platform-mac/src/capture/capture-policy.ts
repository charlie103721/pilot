import {
  PilotError,
  asFrameId,
  fitWithinMaxEdge,
  type CaptureOptions,
  type FrameId,
  type ObservedWindow,
  type PixelSize,
  type WindowGeometry,
} from '@pilot/shared';
import {
  MAX_CAPTURE_EDGE_PIXELS,
  MAX_CAPTURE_FPS,
  MIN_CAPTURE_FPS,
  type CaptureFrameHeader,
} from '../protocol/capture-ops.js';

/**
 * The pure half of capture (PR-012).
 *
 * Everything here is a total function of its arguments: no transport, no
 * clock, no helper. That is deliberate — this is where the screen policy is
 * actually *applied* (system-design §10), and the Swift side receives the
 * result rather than the rule, so the rule is executed by tests on the
 * development machine instead of being written blind (runbook amendment 8).
 */

/** The stream parameters the helper is told to configure. */
export interface ResolvedCaptureStream {
  /** `CGWindowID` of the selected window, and nothing else. */
  readonly windowNumber: number;
  /** Stream size in pixels, after the longest-edge cap. */
  readonly size: PixelSize;
  /**
   * Captured pixels per window point *after* the downscale. This is the value
   * `CapturedFrame.scaleFactor` carries, and it is generally **not** the
   * display's backing scale: a 1200×800 pt window on a 2× display is 2400×1600
   * backing pixels, capped to 1440×960, so the effective scale is 1.2.
   */
  readonly scaleFactor: number;
  readonly sampleFps: number;
  /** `1000 / sampleFps`, rounded — the drain interval and the re-send cadence. */
  readonly frameIntervalMs: number;
  /** Backing-pixel size before the cap, for diagnostics. */
  readonly sourceSize: PixelSize;
}

function invalid(message: string, details: Record<string, unknown>): PilotError {
  return new PilotError('invalid-request', message, {
    userMessage: 'Pilot could not start looking at that window.',
    retryable: false,
    details,
  });
}

/**
 * Applies the screen policy to a selected window.
 *
 * `maxEdgePixels` comes from `CaptureOptions` (the caller's policy; the MVP
 * value is `MVP_SCREEN_POLICY.fullFrameMaxEdge` = 1440). Never upscales: a
 * small window is captured at its own backing size, because inventing pixels
 * costs bytes and adds nothing a model can read.
 */
export function resolveCaptureStream(
  window: ObservedWindow,
  windowNumber: number,
  options: CaptureOptions,
): ResolvedCaptureStream {
  if (!(window.bounds.width > 0) || !(window.bounds.height > 0)) {
    throw invalid('The selected window has no area to capture', {
      windowId: window.windowId,
      width: window.bounds.width,
      height: window.bounds.height,
    });
  }
  if (!(options.maxEdgePixels > 0)) {
    throw invalid('Capture policy must allow at least one pixel', {
      maxEdgePixels: options.maxEdgePixels,
    });
  }

  const sourceSize: PixelSize = {
    width: window.bounds.width * window.scaleFactor,
    height: window.bounds.height * window.scaleFactor,
  };
  const capped = fitWithinMaxEdge(
    sourceSize,
    Math.min(options.maxEdgePixels, MAX_CAPTURE_EDGE_PIXELS),
  );
  const size: PixelSize = {
    width: clampEdge(Math.round(capped.width)),
    height: clampEdge(Math.round(capped.height)),
  };

  return {
    windowNumber,
    size,
    // Derived from the width the stream will actually produce, so a rounded
    // edge cannot make pointer maths drift from the pixels it lands on.
    scaleFactor: size.width / window.bounds.width,
    sampleFps: clampFps(options.sampleFps),
    frameIntervalMs: Math.max(1, Math.round(1000 / clampFps(options.sampleFps))),
    sourceSize,
  };
}

function clampEdge(value: number): number {
  return Math.min(Math.max(1, value), MAX_CAPTURE_EDGE_PIXELS);
}

function clampFps(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return MIN_CAPTURE_FPS;
  }
  return Math.min(Math.max(value, MIN_CAPTURE_FPS), MAX_CAPTURE_FPS);
}

/**
 * Replaces a geometry's `captureSize` with the size the stream is producing.
 *
 * `WindowGeometry` carries `captureSize` separately from `scaleFactor` for
 * exactly this: `toWindowGeometry` (PR-011) fills it with the window's backing
 * size, which is what a *full-resolution* capture would be, and the policy
 * downscale then makes that wrong. Every conversion that touches captured
 * pixels goes through `captureSize`
 * (`packages/shared/src/geometry.ts`), so overriding it here is enough — no
 * conversion code changes, and the one geometry module keeps its monopoly.
 */
export function withCaptureSize(geometry: WindowGeometry, captureSize: PixelSize): WindowGeometry {
  return { ...geometry, captureSize: { width: captureSize.width, height: captureSize.height } };
}

/**
 * The frame id.
 *
 * Derived from two helper facts — the stream's id and the frame's sequence
 * number — and nothing else. PR-004's ring rejects a repeated `frameId` as
 * `duplicate`, so uniqueness is a hard requirement; a stream id that changes on
 * every `capture.start` plus a sequence that only increases within a stream
 * gives it without a counter the host has to keep in step across restarts.
 */
export function captureFrameId(streamId: string, sequence: number): FrameId {
  return asFrameId(`frame-mac-${streamId}-${String(sequence)}`);
}

export interface CapturedAtDecision {
  readonly capturedAt: number;
  /** True when the helper's timestamp was rejected and the host clock used. */
  readonly substituted: boolean;
  /** `reported - now`; positive means the helper's clock is ahead. */
  readonly skewMs: number;
}

/**
 * Validates the helper's timestamp against the host clock.
 *
 * Both sides read milliseconds since the Unix epoch, so they should agree to
 * within transport latency. They can still disagree: a clock step (NTP, a
 * laptop waking) moves one and not the other, and the helper's mach → wall
 * conversion could in principle produce nonsense. Either way the failure is
 * invisible — the ring would reject every frame as `stale` and the model would
 * simply never see anything — so an implausible timestamp is replaced by the
 * host's own reading and counted, rather than trusted.
 */
export function decideCapturedAt(
  reported: number,
  now: number,
  toleranceMs: number,
): CapturedAtDecision {
  const skewMs = reported - now;
  if (!Number.isFinite(reported) || reported <= 0 || Math.abs(skewMs) > toleranceMs) {
    return { capturedAt: Math.trunc(now), substituted: true, skewMs };
  }
  return { capturedAt: Math.trunc(reported), substituted: false, skewMs };
}

/**
 * Detaches frame bytes from the transport's read buffer.
 *
 * PR-004 requires `bytes.byteLength` to reflect the frame's real retained cost,
 * because byte eviction trusts it and a view that understates memory makes the
 * 16 MiB ring bound meaningless. A `Buffer` handed up by the decoder can be a
 * window onto a larger `ArrayBuffer` — Node also pools small allocations — and
 * retaining such a view pins everything behind it while reporting only its own
 * length.
 *
 * So: if the buffer already owns its `ArrayBuffer` exactly, it is returned
 * untouched (no copy per frame, which requirement 6 cares about); otherwise it
 * is copied into an exactly-sized one, once, at the boundary.
 */
export function toStandaloneBytes(buffer: Uint8Array): Uint8Array {
  if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
    return buffer;
  }
  const exact = new Uint8Array(buffer.byteLength);
  exact.set(buffer);
  return exact;
}

/** Whether a header describes a frame of the window that is actually selected. */
export function isFrameForWindow(header: CaptureFrameHeader, windowNumber: number): boolean {
  return header.windowNumber === windowNumber;
}
