import { z } from 'zod';
import { defineHelperOperation, type HelperOperationRequest } from './operation-kit.js';

/**
 * Selected-window capture operations (PR-012).
 *
 * Appended to the closed operation set PR-003 established and PR-011 extended.
 * Nothing here bumps `HELPER_PROTOCOL_VERSION`: adding operations is backwards
 * compatible in both directions.
 *
 * These are the **first operations that carry a binary body**. PR-003 built the
 * length-prefixed payload into the frame format from day one precisely so a
 * captured frame could ride alongside its metadata without a base64 detour
 * through JSON; `capture.pull` is that consumer.
 *
 * ## Why the host pulls instead of the helper pushing
 *
 * The helper's stdio loop is a single blocking read/answer cycle
 * (`native/Sources/PilotHelperCore/HelperServer.swift`). A ScreenCaptureKit
 * stream delivers on its own dispatch queue, so a helper that *pushed* frames
 * would need a second writer racing the request loop for stdout: a write lock,
 * an interleaving hazard on a binary body, and a failure surface that cannot be
 * compiled or run on the development machine (runbook amendment 8). PR-011 made
 * the same call for window lifecycle events and stated the reasoning in
 * `window-ops.ts`.
 *
 * So the stream callback only ever *enqueues* into a bounded in-helper queue,
 * and `capture.pull` — an ordinary request, answered by the same single thread
 * that answers `health` — drains it. Consequences, all of them wanted:
 *
 * - There is exactly one writer to stdout, as in PR-003.
 * - Backpressure is explicit: the queue drops its oldest entry and reports
 *   `dropped`, rather than growing without bound behind a slow host.
 * - The host controls the sample cadence it actually ingests at, which is what
 *   the screen policy bounds (system-design §10).
 *
 * ## Why the *host* resolves the capture size
 *
 * `capture.start` is told `width` and `height` in pixels rather than a policy
 * to apply. The policy rule — longest edge capped at 1440 px, never upscaled
 * (system-design §10) — lives in `src/capture/capture-policy.ts`, in TypeScript,
 * where it is executed by tests on this machine. The Swift side owns mechanism
 * only: it configures the stream at the size it is given. One implementation of
 * the rule, and it is the one that runs.
 */

/**
 * Wire encodings for a captured frame.
 *
 * A subset of `@pilot/shared`'s `FRAME_ENCODINGS`: `bgra` is deliberately not
 * offered. A 1440×900 BGRA frame is 5.2 MB, so a three-second ring at 3 FPS
 * would need ~47 MB and blow the 16 MiB byte bound before any policy ran.
 * Capture therefore always encodes, and PR-018 re-encodes for the model — the
 * double-encode noted as a risk in `docs/handoff.md` §5.
 *
 * `png` exists as the lever for that risk: if PR-043 finds small on-screen text
 * illegible after two lossy passes, switching capture to `png` removes the
 * first one without touching anything else.
 */
export const CAPTURE_ENCODINGS = ['jpeg', 'png'] as const;
export type CaptureEncoding = (typeof CAPTURE_ENCODINGS)[number];

/**
 * Lifecycle of the helper-side stream, as reported by every `capture.pull`.
 *
 * `protected`, `window-lost` and `screen-locked` are the three that must never
 * be delivered as pixels (system-design §16, §14). A window that blocks capture
 * hands ScreenCaptureKit a black frame; describing that to a model as if it
 * were the application's real content is worse than reporting a failure, so it
 * is reported as a failure.
 */
export const CAPTURE_STREAM_STATES = [
  /** Started; no frame has arrived from the compositor yet. */
  'starting',
  /** Delivering frames. */
  'streaming',
  /** The window blocks capture (`SCFrameStatus.blank`). No pixels are usable. */
  'protected',
  /** The window is gone from shareable content. */
  'window-lost',
  /** The session is locked; capture must not run (system-design §14). */
  'screen-locked',
  /** No stream is running. */
  'stopped',
  /** The stream stopped with an error. */
  'failed',
] as const;

export type CaptureStreamState = (typeof CAPTURE_STREAM_STATES)[number];

/** Hard bound on either edge of a capture, well above the 1440 px policy cap. */
export const MAX_CAPTURE_EDGE_PIXELS = 8192;

/** Sampling bounds. The policy value is 3 (`MVP_SCREEN_POLICY.sampleFps`). */
export const MIN_CAPTURE_FPS = 0.2;
export const MAX_CAPTURE_FPS = 30;

/** Frames the helper may hold before it starts dropping the oldest. */
export const DEFAULT_CAPTURE_QUEUE_DEPTH = 4;
export const MAX_CAPTURE_QUEUE_DEPTH = 32;

/** Bytes the helper's queue may hold before it starts dropping the oldest. */
export const DEFAULT_CAPTURE_QUEUE_BYTE_LIMIT = 8 * 1024 * 1024;

/** Length bound on a helper-minted stream id. */
export const CAPTURE_STREAM_ID_MAX_LENGTH = 64;

const streamIdSchema = z.string().min(1).max(CAPTURE_STREAM_ID_MAX_LENGTH);

/**
 * Metadata for one captured frame. The pixels ride in the frame's binary body;
 * `byteLength` states how many, and the host refuses a response whose binary
 * body disagrees with it.
 */
export const captureFrameHeaderSchema = z.strictObject({
  streamId: streamIdSchema,
  /** Monotonic within a stream, starting at 1. Feeds the frame id. */
  sequence: z.number().int().positive(),
  /** `CGWindowID` the pixels came from. Checked against the selection host-side. */
  windowNumber: z.number().int().nonnegative(),
  /**
   * Milliseconds since the Unix epoch — the same base as `Date.now()`, and so
   * the same base as `@pilot/observation`'s injected clock.
   *
   * The helper converts from the sample buffer's presentation timestamp, which
   * is on the mach host clock, before the value ever leaves the process. A
   * frame timestamped on any other base is rejected by the ring as `stale`
   * (PR-004), which is silence rather than an error, so the conversion happens
   * once and as early as possible.
   */
  capturedAt: z.number().int().nonnegative(),
  /** True when the conversion above was implausible and wall-clock time was used. */
  timestampFallback: z.boolean(),
  width: z.number().int().positive().max(MAX_CAPTURE_EDGE_PIXELS),
  height: z.number().int().positive().max(MAX_CAPTURE_EDGE_PIXELS),
  /** Captured pixels per window point, after the policy downscale. */
  scaleFactor: z.number().finite().positive(),
  encoding: z.enum(CAPTURE_ENCODINGS),
  /** Length of the binary body. Must equal it exactly. */
  byteLength: z.number().int().nonnegative(),
  /**
   * False when the compositor reported no change and the helper re-sent the
   * retained encoding to keep the cadence steady.
   *
   * ScreenCaptureKit only produces new pixels when something moves. Without the
   * re-send a motionless window would fill the ring once and then let it empty,
   * so a question asked thirty seconds into reading a static page would find no
   * frame at all. The re-sent frame is honest: that really is what the window
   * looked like at that moment.
   */
  contentChanged: z.boolean(),
});

export type CaptureFrameHeader = z.infer<typeof captureFrameHeaderSchema>;

export const captureSessionSchema = z.strictObject({
  streamId: streamIdSchema,
  windowNumber: z.number().int().nonnegative(),
  width: z.number().int().positive().max(MAX_CAPTURE_EDGE_PIXELS),
  height: z.number().int().positive().max(MAX_CAPTURE_EDGE_PIXELS),
  scaleFactor: z.number().finite().positive(),
  sampleFps: z.number().finite().positive(),
  encoding: z.enum(CAPTURE_ENCODINGS),
  startedAt: z.number().int().nonnegative(),
});

export type CaptureSession = z.infer<typeof captureSessionSchema>;

/**
 * Starts a ScreenCaptureKit stream over **one window**.
 *
 * `windowNumber` is a `CGWindowID` and the helper builds
 * `SCContentFilter(desktopIndependentWindow:)` from it. There is no display
 * variant of this operation and no fallback that widens to one: a request for a
 * window the compositor no longer lists fails as `window-lost` rather than
 * capturing something else (system-design §14; PR-021's tool text promises the
 * model that "Pilot never captures the whole display as a substitute").
 */
export const captureStartOperation = defineHelperOperation({
  name: 'capture.start',
  request: z.strictObject({
    windowNumber: z.number().int().nonnegative(),
    /** Stream width in pixels, already reduced by the screen policy. */
    width: z.number().int().positive().max(MAX_CAPTURE_EDGE_PIXELS),
    height: z.number().int().positive().max(MAX_CAPTURE_EDGE_PIXELS),
    sampleFps: z.number().finite().min(MIN_CAPTURE_FPS).max(MAX_CAPTURE_FPS),
    includeCursor: z.boolean(),
    encoding: z.enum(CAPTURE_ENCODINGS),
    /** Encoder quality for `jpeg`. Ignored for `png`. */
    quality: z.number().finite().min(0.1).max(1),
    queueDepth: z.number().int().positive().max(MAX_CAPTURE_QUEUE_DEPTH).optional(),
    queueByteLimit: z.number().int().positive().optional(),
    /**
     * How long a motionless window may go without a frame before the helper
     * re-sends its retained encoding. Defaults to one sample interval.
     */
    resendUnchangedAfterMs: z.number().int().positive().optional(),
    /** Frames older than this are discarded in the helper rather than delivered stale. */
    maxFrameAgeMs: z.number().int().positive().optional(),
  }),
  response: z.strictObject({ session: captureSessionSchema }),
  requestBinary: false,
  responseBinary: false,
});

export type CaptureStartRequest = HelperOperationRequest<typeof captureStartOperation>;

/** Stops the stream and drops everything queued. Idempotent. */
export const captureStopOperation = defineHelperOperation({
  name: 'capture.stop',
  request: z.strictObject({
    /** Stops only this stream. `null` stops whatever is running. */
    streamId: streamIdSchema.nullable(),
  }),
  response: z.strictObject({
    stopped: z.boolean(),
    /** Frames handed to the host over the stream's life. */
    delivered: z.number().int().nonnegative(),
    /** Frames the helper dropped rather than queue without bound. */
    dropped: z.number().int().nonnegative(),
    /** Frames discarded from the queue by this stop. */
    discarded: z.number().int().nonnegative(),
  }),
  requestBinary: false,
  responseBinary: false,
});

/**
 * Takes the oldest queued frame, if there is one.
 *
 * The response's binary body is the frame's encoded pixels — the only place in
 * the protocol where bytes flow helper → host. `frame` is null whenever there
 * was nothing to take, and `state` always says why.
 */
export const capturePullOperation = defineHelperOperation({
  name: 'capture.pull',
  request: z.strictObject({
    streamId: streamIdSchema,
    /**
     * Discard queued frames captured before this instant (epoch ms) and answer
     * only with one at or after it. This is what makes a fresh capture fresh:
     * the host stamps the moment it asked and refuses anything the stream
     * produced beforehand.
     */
    notBefore: z.number().int().nonnegative().optional(),
  }),
  response: z.strictObject({
    state: z.enum(CAPTURE_STREAM_STATES),
    frame: captureFrameHeaderSchema.nullable(),
    /** Frames still queued after this one. Lets the host drain a backlog. */
    remaining: z.number().int().nonnegative(),
    /** Cumulative frames dropped by the helper's bounded queue. */
    dropped: z.number().int().nonnegative(),
    /** Cumulative frames handed to the host. */
    delivered: z.number().int().nonnegative(),
    /** Diagnostic text for `failed`. Never frame content. */
    failure: z.string().max(300).nullable(),
  }),
  requestBinary: false,
  responseBinary: true,
});

export type CapturePullResponse = z.infer<(typeof capturePullOperation)['response']>;
