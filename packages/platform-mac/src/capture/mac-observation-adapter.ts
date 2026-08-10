import {
  MVP_SCREEN_POLICY,
  PilotError,
  cancelledError,
  nullLogger,
  toPilotError,
  type CaptureOptions,
  type CapturedFrame,
  type Logger,
  type ObservedWindow,
  type PixelSize,
  type WindowGeometry,
  type WindowId,
} from '@pilot/shared';
import type {
  CaptureStopReason,
  FrameDropReason,
  ObservationAdapter,
  ObservationEvent,
  Unsubscribe,
  WindowAdapter,
  WindowEvent,
} from '@pilot/platform';
import { Poller } from '../polling.js';
import {
  DEFAULT_CAPTURE_QUEUE_BYTE_LIMIT,
  DEFAULT_CAPTURE_QUEUE_DEPTH,
  capturePullOperation,
  captureStartOperation,
  captureStopOperation,
  type CaptureEncoding,
  type CaptureFrameHeader,
  type CaptureSession,
  type CaptureStreamState,
} from '../protocol/capture-ops.js';
import { TypedEmitter } from '../transport/emitter.js';
import type { HelperTransportState, NativeHelperTransport } from '../transport/helper-transport.js';
import { macWindowId, macWindowNumber, toWindowGeometry } from '../windows/window-model.js';
import {
  captureFrameId,
  decideCapturedAt,
  resolveCaptureStream,
  toStandaloneBytes,
  withCaptureSize,
  type ResolvedCaptureStream,
} from './capture-policy.js';

/**
 * macOS `ObservationAdapter` (system-design §5), backed by a ScreenCaptureKit
 * stream in the native helper.
 *
 * ## One window, never a display
 *
 * The helper builds `SCContentFilter(desktopIndependentWindow:)` from the
 * `CGWindowID` this adapter sends, and there is no code path in either language
 * that constructs a display-wide filter. If the compositor no longer lists the
 * window, capture fails as `window-closed`; it never falls back to the display,
 * to the frontmost window, or to anything else. system-design §14 forbids
 * silently widening, and PR-021's tool description promises the model that
 * "Pilot never captures the whole display as a substitute" — a fallback here
 * would make that promise false.
 *
 * Two further defences run on every frame, because the filter is the part that
 * cannot be tested on this machine:
 *
 * 1. Every frame header carries the `CGWindowID` it came from, and a frame
 *    whose id is not the selected window's is dropped rather than delivered.
 * 2. The delivered `windowId` is `macWindowId(windowNumber)` — the same pure
 *    function PR-011 uses — so it either equals the selection exactly or the
 *    frame was already dropped by (1).
 *
 * ## What it does not do
 *
 * No cropping, resizing, annotating or re-encoding: that is PR-018. This
 * adapter applies exactly one piece of policy, the capture size
 * (`src/capture/capture-policy.ts`), because it has to be applied before the
 * pixels exist.
 */

/** Frames drained in one tick before the adapter yields. */
export const DEFAULT_MAX_DRAIN_PER_TICK = 4;

/** How far the helper's clock may differ from the host's before it is distrusted. */
export const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 2_000;

/** Deadline for `captureFresh`. Four sample intervals at the policy rate. */
export const DEFAULT_FRESH_CAPTURE_TIMEOUT_MS = 1_500;

/** Stream restarts attempted after a helper restart before giving up. */
export const DEFAULT_MAX_STREAM_RESTARTS = 3;

export interface MacObservationAdapterOptions {
  readonly transport: NativeHelperTransport;
  /**
   * Window lifecycle source. Supplying it is what makes screen lock and window
   * loss stop capture (system-design §6, §16); without it the adapter still
   * reacts to the helper's own report, one drain interval later.
   */
  readonly windows?: WindowAdapter;
  readonly logger?: Logger;
  readonly clock?: () => number;
  /** Wire encoding. `png` trades ring bytes for a lossless first pass. */
  readonly encoding?: CaptureEncoding;
  /** JPEG quality. Higher than the model-facing 0.75 so the second encode has room. */
  readonly quality?: number;
  readonly queueDepth?: number;
  readonly queueByteLimit?: number;
  readonly maxDrainPerTick?: number;
  readonly clockSkewToleranceMs?: number;
  /** Frames larger than this are dropped: no buffer downstream could hold one. */
  readonly maxFrameBytes?: number;
  readonly freshCaptureTimeoutMs?: number;
  /** Drain interval. Defaults to the resolved sample interval. */
  readonly pollIntervalMs?: number;
  readonly maxStreamRestarts?: number;
}

export interface CaptureMetrics {
  readonly pulls: number;
  readonly framesDelivered: number;
  readonly bytesDelivered: number;
  readonly freshCaptures: number;
  readonly streamRestarts: number;
  /** Frames the helper's own bounded queue discarded, cumulative. */
  readonly helperDropped: number;
  readonly dropped: Readonly<Record<FrameDropReason, number>>;
  readonly lastCapturedAt: number | null;
  readonly lastState: CaptureStreamState;
}

interface CaptureEvents extends Record<string, unknown> {
  frame: CapturedFrame;
  event: ObservationEvent;
}

interface Selection {
  readonly window: ObservedWindow;
  readonly windowNumber: number;
  readonly resolved: ResolvedCaptureStream;
  readonly options: CaptureOptions;
}

interface PullOutcome {
  readonly state: CaptureStreamState;
  readonly frame: CapturedFrame | null;
  readonly remaining: number;
}

const DROP_REASONS: readonly FrameDropReason[] = [
  'foreign-window',
  'empty-bytes',
  'duplicate',
  'byte-length-mismatch',
  'too-large',
  'clock-skew',
  'producer-backpressure',
];

function emptyDropCounters(): Record<FrameDropReason, number> {
  const counters = {} as Record<FrameDropReason, number>;
  for (const reason of DROP_REASONS) {
    counters[reason] = 0;
  }
  return counters;
}

/** Maps a terminal stream state onto the typed error the caller must see. */
function stateError(state: CaptureStreamState, failure: string | null): PilotError {
  switch (state) {
    case 'protected':
      // system-design §16: "Capture returns protected/blank content → explain
      // that the application blocks capture". Never a black frame handed on as
      // if it were the application's real content.
      return new PilotError('protected-content', 'The window blocks screen capture', {
        userMessage:
          'This application does not allow Pilot to see its window. Try a different window.',
        retryable: false,
      });
    case 'window-lost':
      return new PilotError('window-closed', 'The selected window is gone', {
        userMessage: 'That window has closed. Pick another one for Pilot to watch.',
        retryable: false,
      });
    case 'screen-locked':
      return new PilotError('screen-locked', 'The screen is locked', {
        userMessage: 'Pilot stops looking while the screen is locked.',
        retryable: true,
      });
    case 'failed':
      return new PilotError('capture-failed', failure ?? 'The capture stream failed', {
        userMessage: 'Pilot could not capture that window.',
        retryable: true,
        ...(failure === null ? {} : { details: { failure } }),
      });
    case 'stopped':
      return new PilotError('observation-disabled', 'Capture is not running', {
        userMessage: 'Pilot is not observing a window right now.',
        retryable: false,
      });
    case 'starting':
    case 'streaming':
      return new PilotError('capture-failed', 'The capture stream produced no frame', {
        userMessage: 'Pilot could not capture that window.',
        retryable: true,
      });
  }
}

function stopReasonFor(state: CaptureStreamState): CaptureStopReason {
  switch (state) {
    case 'protected':
      return 'protected-content';
    case 'window-lost':
      return 'window-lost';
    case 'screen-locked':
      return 'screen-locked';
    default:
      return 'failed';
  }
}

function isTerminal(state: CaptureStreamState): boolean {
  return (
    state === 'protected' ||
    state === 'window-lost' ||
    state === 'screen-locked' ||
    state === 'failed'
  );
}

export class MacObservationAdapter implements ObservationAdapter {
  readonly #transport: NativeHelperTransport;
  readonly #emitter = new TypedEmitter<CaptureEvents>();
  readonly #logger: Logger;
  readonly #clock: () => number;
  readonly #encoding: CaptureEncoding;
  readonly #quality: number;
  readonly #queueDepth: number;
  readonly #queueByteLimit: number;
  readonly #maxDrainPerTick: number;
  readonly #clockSkewToleranceMs: number;
  readonly #maxFrameBytes: number;
  readonly #freshTimeoutMs: number;
  readonly #pollIntervalMs: number | undefined;
  readonly #maxStreamRestarts: number;
  readonly #windows: WindowAdapter | undefined;
  readonly #offTransportState: Unsubscribe;

  #poller: Poller | undefined;
  #offWindows: Unsubscribe | undefined;
  #selection: Selection | null = null;
  #session: CaptureSession | null = null;
  #lastSequence = 0;
  #state: CaptureStreamState = 'stopped';
  #resumeOnUnlock = false;
  #restarts = 0;
  #restarting: Promise<void> | undefined;
  #lastTransportState: HelperTransportState;

  #pulls = 0;
  #framesDelivered = 0;
  #bytesDelivered = 0;
  #freshCaptures = 0;
  #helperDropped = 0;
  #lastCapturedAt: number | null = null;
  readonly #dropped = emptyDropCounters();

  constructor(options: MacObservationAdapterOptions) {
    this.#transport = options.transport;
    this.#logger = (options.logger ?? nullLogger).child('mac-capture');
    this.#clock = options.clock ?? ((): number => Date.now());
    this.#encoding = options.encoding ?? 'jpeg';
    this.#quality = options.quality ?? 0.9;
    this.#queueDepth = options.queueDepth ?? DEFAULT_CAPTURE_QUEUE_DEPTH;
    this.#queueByteLimit = options.queueByteLimit ?? DEFAULT_CAPTURE_QUEUE_BYTE_LIMIT;
    this.#maxDrainPerTick = options.maxDrainPerTick ?? DEFAULT_MAX_DRAIN_PER_TICK;
    this.#clockSkewToleranceMs = options.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS;
    this.#maxFrameBytes = options.maxFrameBytes ?? MVP_SCREEN_POLICY.ringByteLimit;
    this.#freshTimeoutMs = options.freshCaptureTimeoutMs ?? DEFAULT_FRESH_CAPTURE_TIMEOUT_MS;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#maxStreamRestarts = options.maxStreamRestarts ?? DEFAULT_MAX_STREAM_RESTARTS;
    this.#windows = options.windows;

    this.#lastTransportState = options.transport.state;
    this.#offTransportState = options.transport.on('state', (state) => {
      const previous = this.#lastTransportState;
      this.#lastTransportState = state;
      if (state === 'ready' && previous !== 'ready' && this.#selection !== null) {
        // The helper was restarted by the supervisor, so its stream is gone —
        // but the window id is not, because PR-011 derives it from the
        // `CGWindowID` alone. Re-establish the stream rather than reporting a
        // window loss that did not happen.
        void this.#restartStream('helper restart');
      }
      if ((state === 'failed' || state === 'stopped') && this.#session !== null) {
        this.#teardown('helper-unavailable', this.#transport.lastError);
      }
    });
  }

  /** The running stream, or `null`. */
  get session(): CaptureSession | null {
    return this.#session;
  }

  get state(): CaptureStreamState {
    return this.#state;
  }

  get selectedWindowId(): WindowId | null {
    return this.#selection?.window.windowId ?? null;
  }

  /** Size the stream is configured at, after the policy downscale. */
  get captureSize(): PixelSize | null {
    const session = this.#session;
    return session === null ? null : { width: session.width, height: session.height };
  }

  /**
   * Geometry for the selected window with `captureSize` set to what the stream
   * actually produces, which is what pointer conversion needs (PR-013, PR-019).
   */
  get captureGeometry(): WindowGeometry | null {
    const selection = this.#selection;
    const size = this.captureSize;
    if (selection === null || size === null) {
      return null;
    }
    return withCaptureSize(this.#baseGeometry(selection), size);
  }

  metrics(): CaptureMetrics {
    return {
      pulls: this.#pulls,
      framesDelivered: this.#framesDelivered,
      bytesDelivered: this.#bytesDelivered,
      freshCaptures: this.#freshCaptures,
      streamRestarts: this.#restarts,
      helperDropped: this.#helperDropped,
      dropped: { ...this.#dropped },
      lastCapturedAt: this.#lastCapturedAt,
      lastState: this.#state,
    };
  }

  // -------------------------------------------------------------------------
  // ObservationAdapter
  // -------------------------------------------------------------------------

  subscribe = (listener: (frame: CapturedFrame) => void): Unsubscribe =>
    this.#emitter.on('frame', listener);

  subscribeEvents = (listener: (event: ObservationEvent) => void): Unsubscribe =>
    this.#emitter.on('event', listener);

  /**
   * Starts capturing the selected window.
   *
   * Starting while another stream runs replaces it: the old stream is stopped
   * first, so two filters never exist at once and the helper's queue cannot mix
   * two windows' frames.
   */
  async start(window: ObservedWindow, options: CaptureOptions): Promise<void> {
    const windowNumber = macWindowNumber(window.windowId);
    if (windowNumber === null) {
      throw new PilotError('window-not-found', 'Not a macOS window id', {
        userMessage: 'Pilot cannot watch that window.',
        retryable: false,
        details: { windowId: window.windowId },
      });
    }

    if (this.#session !== null) {
      await this.stop();
    }

    const resolved = resolveCaptureStream(window, windowNumber, options);
    this.#selection = { window, windowNumber, resolved, options };
    this.#restarts = 0;
    await this.#openStream(resolved);

    this.#offWindows ??= this.#windows?.subscribe((event) => {
      this.#onWindowEvent(event);
    });
  }

  async stop(): Promise<void> {
    this.#resumeOnUnlock = false;
    this.#selection = null;
    this.#offWindows?.();
    this.#offWindows = undefined;
    await this.#closeStream('requested');
  }

  /**
   * Captures on demand (system-design §9, `moment: 'current'`).
   *
   * Implemented as a bounded drain rather than a blocking helper call. The
   * helper's request loop is single-threaded: a call that waited inside it for
   * the compositor would stall `health` and every other operation, and the
   * supervisor would eventually kill a helper that was working correctly. So
   * the host stamps the instant it asked, tells the helper to discard anything
   * older, and pulls until a frame at or after that instant arrives.
   *
   * The abort signal is honoured between pulls *and* inside each one — it is
   * passed to the transport, which rejects the in-flight request immediately.
   */
  async captureFresh(signal?: AbortSignal): Promise<CapturedFrame> {
    const session = this.#session;
    const selection = this.#selection;
    if (session === null || selection === null) {
      throw new PilotError('observation-disabled', 'Capture is not running', {
        userMessage: 'Pilot is not observing a window right now.',
        retryable: false,
      });
    }
    throwIfAborted(signal);

    const notBefore = Math.trunc(this.#clock());
    const deadline = notBefore + this.#freshTimeoutMs;
    const interval = Math.max(
      10,
      Math.min(selection.resolved.frameIntervalMs, this.#freshTimeoutMs),
    );

    for (;;) {
      throwIfAborted(signal);
      const outcome = await this.#pull({
        notBefore,
        ...(signal === undefined ? {} : { signal }),
      });
      if (outcome.frame !== null) {
        this.#freshCaptures += 1;
        return outcome.frame;
      }
      if (isTerminal(outcome.state) || outcome.state === 'stopped') {
        throw stateError(outcome.state, null);
      }
      throwIfAborted(signal);
      if (this.#clock() >= deadline) {
        throw new PilotError(
          'capture-failed',
          `No frame arrived within ${String(this.#freshTimeoutMs)}ms`,
          {
            userMessage: 'Pilot could not capture that window in time.',
            retryable: true,
            details: { timeoutMs: this.#freshTimeoutMs, state: outcome.state },
          },
        );
      }
      await delay(interval, signal);
    }
  }

  /** Runs one drain immediately. Used by the demo and by tests. */
  async drain(): Promise<void> {
    await (this.#poller?.refresh() ?? Promise.resolve());
  }

  /**
   * Drops everything this adapter retains and stops the stream
   * (`PlatformAdapterLifecycle.clearBuffers`). The helper's queue is discarded
   * by the same `capture.stop`, so no captured byte survives on either side.
   */
  async clearBuffers(): Promise<void> {
    await this.#closeStream('requested');
  }

  /**
   * Releases every listener and timer synchronously, and asks the helper to
   * stop without waiting for it.
   *
   * `stop()` is the ordered shutdown; this is the one that runs when there is
   * nothing left to await on. The `capture.stop` is fire-and-forget because a
   * disposed adapter must not leave a stream encoding frames nobody will pull —
   * and because a helper that is already gone would make an awaited stop hang
   * the caller.
   */
  dispose(): void {
    const session = this.#session;
    this.#poller?.stop();
    this.#poller = undefined;
    this.#offWindows?.();
    this.#offWindows = undefined;
    this.#offTransportState();
    this.#selection = null;
    this.#session = null;
    this.#state = 'stopped';
    if (session !== null) {
      void this.#transport
        .request(captureStopOperation, { streamId: session.streamId })
        .catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Stream lifecycle
  // -------------------------------------------------------------------------

  async #openStream(resolved: ResolvedCaptureStream): Promise<void> {
    const response = await this.#transport.request(captureStartOperation, {
      windowNumber: resolved.windowNumber,
      width: resolved.size.width,
      height: resolved.size.height,
      sampleFps: resolved.sampleFps,
      includeCursor: this.#selection?.options.includeCursor ?? false,
      encoding: this.#encoding,
      quality: this.#quality,
      queueDepth: this.#queueDepth,
      queueByteLimit: this.#queueByteLimit,
      resendUnchangedAfterMs: resolved.frameIntervalMs,
      maxFrameAgeMs: MVP_SCREEN_POLICY.ringDurationMs,
    });

    const session = response.payload.session;
    if (session.windowNumber !== resolved.windowNumber) {
      // The helper answered for a different window. Nothing downstream could
      // detect this except by the frames being silently wrong, so it is fatal.
      await this.#transport
        .request(captureStopOperation, { streamId: session.streamId })
        .catch(() => undefined);
      throw new PilotError('capture-failed', 'Helper started a stream for the wrong window', {
        userMessage: 'Pilot could not watch that window.',
        retryable: false,
        details: { expected: resolved.windowNumber, received: session.windowNumber },
      });
    }

    this.#session = session;
    this.#lastSequence = 0;
    this.#state = 'starting';
    this.#poller?.stop();
    this.#poller = new Poller(() => this.#tick(), {
      intervalMs: this.#pollIntervalMs ?? resolved.frameIntervalMs,
      logger: this.#logger,
      name: 'capture',
    });
    this.#poller.start();

    this.#logger.info('capture started', {
      windowNumber: session.windowNumber,
      width: session.width,
      height: session.height,
      sampleFps: session.sampleFps,
      encoding: session.encoding,
    });
    this.#emitter.emit('event', {
      type: 'capture-started',
      windowId: macWindowId(session.windowNumber),
      captureSize: { width: session.width, height: session.height },
    });
  }

  async #closeStream(reason: CaptureStopReason, error?: PilotError): Promise<void> {
    const session = this.#session;
    this.#poller?.stop();
    this.#poller = undefined;
    this.#session = null;
    this.#state = 'stopped';
    this.#lastSequence = 0;
    if (session === null) {
      return;
    }
    try {
      await this.#transport.request(captureStopOperation, { streamId: session.streamId });
    } catch (cause) {
      // A helper that has already died has already dropped its queue.
      this.#logger.debug('capture stop failed', { code: toPilotError(cause).code });
    }
    this.#announceStop(reason, error);
  }

  /** Synchronous teardown for paths that cannot await (transport state changes). */
  #teardown(reason: CaptureStopReason, error?: PilotError): void {
    if (this.#session === null) {
      return;
    }
    this.#poller?.stop();
    this.#poller = undefined;
    this.#session = null;
    this.#state = 'stopped';
    this.#lastSequence = 0;
    this.#announceStop(reason, error);
  }

  #announceStop(reason: CaptureStopReason, error?: PilotError): void {
    this.#logger.info('capture stopped', { reason, code: error?.code });
    this.#emitter.emit('event', {
      type: 'capture-stopped',
      reason,
      ...(error === undefined ? {} : { error }),
    });
  }

  async #restartStream(why: string): Promise<void> {
    const inFlight = this.#restarting;
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }
    const selection = this.#selection;
    if (selection === null) {
      return;
    }
    if (this.#restarts >= this.#maxStreamRestarts) {
      this.#teardown(
        'failed',
        new PilotError('capture-failed', 'Capture could not be re-established', {
          userMessage: 'Pilot lost sight of that window.',
          retryable: false,
          details: { attempts: this.#restarts, why },
        }),
      );
      return;
    }
    this.#restarts += 1;
    this.#logger.warn('restarting capture stream', { why, attempt: this.#restarts });

    const promise = (async () => {
      this.#poller?.stop();
      this.#poller = undefined;
      this.#session = null;
      try {
        await this.#openStream(selection.resolved);
      } catch (error) {
        this.#logger.warn('capture restart failed', { code: toPilotError(error).code });
      }
    })().finally(() => {
      this.#restarting = undefined;
    });
    this.#restarting = promise;
    await promise;
  }

  // -------------------------------------------------------------------------
  // Draining
  // -------------------------------------------------------------------------

  async #tick(): Promise<void> {
    for (let drained = 0; drained < this.#maxDrainPerTick; drained += 1) {
      if (this.#session === null) {
        return;
      }
      let outcome: PullOutcome;
      try {
        outcome = await this.#pull({});
      } catch (error) {
        const pilot = toPilotError(error);
        if (pilot.code === 'helper-unavailable' || pilot.code === 'timeout') {
          // The supervisor will bring the helper back and the transport's
          // `ready` transition restarts the stream. Nothing to do but wait.
          this.#logger.debug('capture pull failed', { code: pilot.code });
          return;
        }
        this.#teardown('failed', pilot);
        return;
      }
      if (outcome.remaining <= 0) {
        return;
      }
    }
    // Backpressure: the queue is still not empty after a full burst. Stopping
    // here rather than looping keeps one slow consumer from monopolising the
    // event loop, and the helper's bounded queue drops the excess and says so.
    this.#logger.debug('capture drain hit its per-tick bound', {
      maxDrainPerTick: this.#maxDrainPerTick,
    });
  }

  async #pull(options: { notBefore?: number; signal?: AbortSignal }): Promise<PullOutcome> {
    const session = this.#session;
    if (session === null) {
      return { state: 'stopped', frame: null, remaining: 0 };
    }

    const response = await this.#transport.request(
      capturePullOperation,
      {
        streamId: session.streamId,
        ...(options.notBefore === undefined ? {} : { notBefore: options.notBefore }),
      },
      options.signal === undefined ? {} : { signal: options.signal },
    );
    this.#pulls += 1;

    const payload = response.payload;
    this.#state = payload.state;
    this.#noteHelperDrops(payload.dropped);

    if (payload.state === 'stopped' && payload.frame === null) {
      // The helper does not know this stream: it restarted underneath us.
      void this.#restartStream('helper forgot the stream');
      return { state: payload.state, frame: null, remaining: 0 };
    }
    if (isTerminal(payload.state)) {
      this.#onTerminalState(payload.state, payload.failure);
      return { state: payload.state, frame: null, remaining: 0 };
    }
    if (payload.frame === null) {
      return { state: payload.state, frame: null, remaining: payload.remaining };
    }

    const frame = this.#accept(payload.frame, response.binary);
    if (frame !== null) {
      this.#emitter.emit('frame', frame);
    }
    return { state: payload.state, frame, remaining: payload.remaining };
  }

  #noteHelperDrops(cumulative: number): void {
    if (cumulative <= this.#helperDropped) {
      return;
    }
    const delta = cumulative - this.#helperDropped;
    this.#helperDropped = cumulative;
    this.#dropped['producer-backpressure'] += delta;
    this.#logger.debug('helper dropped frames to stay bounded', { count: delta });
    this.#emitter.emit('event', {
      type: 'frames-dropped',
      reason: 'producer-backpressure',
      count: delta,
    });
  }

  #onTerminalState(state: CaptureStreamState, failure: string | null): void {
    const error = stateError(state, failure);
    if (state === 'screen-locked') {
      this.#resumeOnUnlock = true;
    }
    this.#teardown(stopReasonFor(state), error);
  }

  // -------------------------------------------------------------------------
  // Frame admission
  // -------------------------------------------------------------------------

  /**
   * Turns a header plus a binary body into a `CapturedFrame`, or drops it.
   *
   * Every check here exists because PR-004's ring turns the corresponding
   * mistake into *silence* rather than an error: a foreign window id is
   * rejected as `foreign-window`, a repeat as `duplicate`, an empty payload as
   * `empty-bytes`, a mistimed frame as `stale`. Catching them at the boundary
   * means the reason is counted and reported instead of inferred from an
   * observation that never happens.
   */
  #accept(header: CaptureFrameHeader, binary: Uint8Array): CapturedFrame | null {
    const selection = this.#selection;
    if (selection === null) {
      return null;
    }

    if (header.windowNumber !== selection.windowNumber) {
      return this.#drop('foreign-window', {
        expected: selection.windowNumber,
        received: header.windowNumber,
      });
    }
    if (header.byteLength !== binary.byteLength) {
      return this.#drop('byte-length-mismatch', {
        declared: header.byteLength,
        received: binary.byteLength,
      });
    }
    if (binary.byteLength === 0) {
      return this.#drop('empty-bytes', { sequence: header.sequence });
    }
    if (binary.byteLength > this.#maxFrameBytes) {
      return this.#drop('too-large', {
        byteLength: binary.byteLength,
        limit: this.#maxFrameBytes,
      });
    }
    if (header.sequence <= this.#lastSequence) {
      return this.#drop('duplicate', {
        sequence: header.sequence,
        lastSequence: this.#lastSequence,
      });
    }

    const decision = decideCapturedAt(header.capturedAt, this.#clock(), this.#clockSkewToleranceMs);
    if (decision.substituted) {
      this.#dropped['clock-skew'] += 1;
      this.#logger.warn('helper frame timestamp was implausible; using the host clock', {
        skewMs: decision.skewMs,
        toleranceMs: this.#clockSkewToleranceMs,
      });
    }

    this.#lastSequence = header.sequence;
    this.#framesDelivered += 1;
    this.#bytesDelivered += binary.byteLength;
    this.#lastCapturedAt = decision.capturedAt;

    return {
      frameId: captureFrameId(header.streamId, header.sequence),
      // The one pure function PR-011 defines. Not a re-key, not a copy of the
      // selection's string: if these ever disagreed the frame was already
      // dropped above.
      windowId: macWindowId(header.windowNumber),
      capturedAt: decision.capturedAt,
      size: { width: header.width, height: header.height },
      scaleFactor: header.scaleFactor,
      encoding: header.encoding,
      // Detached from the decoder's buffer, so `byteLength` is the whole cost.
      bytes: toStandaloneBytes(binary),
    };
  }

  #drop(reason: FrameDropReason, details: Record<string, unknown>): null {
    this.#dropped[reason] += 1;
    this.#logger.debug('dropped a captured frame', { reason, ...details });
    this.#emitter.emit('event', { type: 'frames-dropped', reason, count: 1 });
    return null;
  }

  // -------------------------------------------------------------------------
  // Window lifecycle
  // -------------------------------------------------------------------------

  #onWindowEvent(event: WindowEvent): void {
    const selection = this.#selection;
    if (selection === null) {
      return;
    }
    switch (event.type) {
      case 'window-closed':
        if (event.windowId === selection.window.windowId) {
          // system-design §16: selected window closed → stop observation and
          // clear the buffer. The consumer's own `window-closed` handler clears
          // the ring; this end stops producing.
          this.#resumeOnUnlock = false;
          this.#selection = null;
          this.#offWindows?.();
          this.#offWindows = undefined;
          this.#teardown('window-lost', stateError('window-lost', null));
        }
        return;
      case 'screen-locked':
        this.#resumeOnUnlock = this.#session !== null;
        this.#teardown('screen-locked', stateError('screen-locked', null));
        return;
      case 'screen-unlocked':
        if (this.#resumeOnUnlock) {
          this.#resumeOnUnlock = false;
          this.#restarts = 0;
          void this.#restartStream('screen unlocked');
        }
        return;
      case 'window-list-changed':
      case 'window-changed':
        return;
    }
  }

  #baseGeometry(selection: Selection): WindowGeometry {
    return toWindowGeometry(
      {
        windowNumber: selection.windowNumber,
        ownerPid: 0,
        applicationName: selection.window.applicationName,
        applicationBundleId: selection.window.applicationBundleId ?? null,
        title: selection.window.title,
        titleAvailable: true,
        bounds: selection.window.bounds,
        displayNumber: null,
        isOnScreen: selection.window.isOnScreen,
        layer: 0,
      },
      [
        {
          displayNumber: 0,
          bounds: selection.window.bounds,
          scaleFactor: selection.window.scaleFactor,
          isPrimary: true,
        },
      ],
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw cancelledError('Fresh capture');
  }
}

/** Abortable sleep. Rejects with `cancelled` rather than resolving late. */
function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelledError('Fresh capture'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
