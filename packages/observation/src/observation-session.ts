import {
  buildGroundedPointer,
  MVP_SCREEN_POLICY,
  nullLogger,
  PilotError,
  type CaptureOptions,
  type CapturedFrame,
  type Logger,
  type ObservedWindow,
  type SceneState,
  type WindowGeometry,
} from '@pilot/shared';
import type {
  AccessibilityAdapter,
  ObservationAdapter,
  Unsubscribe,
  WindowAdapter,
  WindowEvent,
} from '@pilot/platform';
import { toTimestamp, type Clock } from './clock.js';
import {
  ContentFingerprinter,
  type ContentFingerprintConfig,
  type ContentFingerprintUpdate,
} from './content-fingerprint.js';
import type {
  ClearReason,
  FrameIngestResult,
  ObservationCore,
  PointerIngestResult,
} from './observation-core.js';
import {
  toCaptureOptions,
  toContentFingerprintConfig,
  type ScreenContextPolicy,
} from './screen-policy.js';
import type { SceneTransition } from './scene-tracker.js';

/**
 * Platform event ingest (system-design §6, §16).
 *
 * `ObservationCore` owns observation *state*; this owns the wiring from the
 * platform adapters into it:
 *
 * - frames from `ObservationAdapter.subscribe`, fingerprinted for meaningful
 *   visual change before they are stamped with a revision;
 * - pointer and accessibility grounding pulled from `AccessibilityAdapter`;
 * - window lifecycle from `WindowAdapter.subscribe` — title and geometry
 *   changes become scene revisions, window loss and screen lock clear the
 *   buffers and end the scene.
 *
 * Nothing here runs on a timer. The frame cadence belongs to the platform
 * adapter and the pointer cadence to the caller ({@link
 * ObservationSession.samplePointer}), so a test drives the whole session
 * exactly and library code never reads `Date.now()`.
 */

export type ObservationSessionState =
  /** No window selected; nothing subscribed. */
  | 'idle'
  /** Capturing the selected window. */
  | 'observing'
  /** Screen locked or paused: buffers cleared, selection remembered. */
  | 'suspended'
  /** Resumable: the reason for suspension is gone, awaiting `resume()`. */
  | 'resumable'
  /** The selected window went away; a new selection is required. */
  | 'ended';

export interface ObservationSessionOptions {
  readonly core: ObservationCore;
  readonly clock: Clock;
  readonly observation?: ObservationAdapter;
  readonly accessibility?: AccessibilityAdapter;
  readonly windows?: WindowAdapter;
  readonly logger?: Logger;
  /**
   * Screen policy (PR-017). When given it supplies the capture parameters and
   * the content-fingerprint tuning; explicit `capture`/`fingerprint` still win.
   * Retention bounds belong to the core, which takes the same policy.
   */
  readonly policy?: ScreenContextPolicy;
  /** Tuning for the content fingerprint rule. */
  readonly fingerprint?: ContentFingerprintConfig;
  /** Capture parameters passed to the adapter. Defaults to the MVP policy. */
  readonly capture?: CaptureOptions;
  /** Called for every scene transition the session causes. */
  readonly onSceneTransition?: (transition: SceneTransition) => void;
  /** Called for every frame the session ingests, admitted or not. */
  readonly onFrame?: (outcome: FrameIngestOutcome) => void;
}

export interface ObservationSessionSelection {
  readonly window: ObservedWindow;
  readonly geometry: WindowGeometry;
  readonly accessibilityRootId?: string;
}

export interface FrameIngestOutcome {
  readonly ingest: FrameIngestResult;
  /** `null` when the frame never reached the fingerprinter. */
  readonly fingerprint: ContentFingerprintUpdate | null;
  /** The revision bump the frame's own content caused, if any. */
  readonly transition: SceneTransition | null;
}

export type PointerSampleOutcome =
  | { readonly sampled: true; readonly ingest: PointerIngestResult }
  | { readonly sampled: false; readonly reason: 'no-accessibility-adapter' | 'not-observing' };

export interface ObservationSessionStatus {
  readonly state: ObservationSessionState;
  readonly window: ObservedWindow | null;
  readonly geometry: WindowGeometry | null;
  readonly scene: SceneState | null;
  readonly contentFingerprint: string | null;
}

export interface ObservationSessionMetrics {
  readonly framesIngested: number;
  readonly framesRejected: number;
  readonly pointerSamples: number;
  readonly windowEvents: number;
  readonly contentRevisions: number;
  readonly ignoredWindowEvents: number;
}

const DEFAULT_CAPTURE: CaptureOptions = {
  sampleFps: MVP_SCREEN_POLICY.sampleFps,
  maxEdgePixels: MVP_SCREEN_POLICY.fullFrameMaxEdge,
  includeCursor: false,
};

export class ObservationSession {
  readonly #core: ObservationCore;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #policy: ScreenContextPolicy | null;
  readonly #capture: CaptureOptions;
  readonly #fingerprinter: ContentFingerprinter;
  readonly #observation: ObservationAdapter | null;
  readonly #accessibility: AccessibilityAdapter | null;
  readonly #windows: WindowAdapter | null;
  readonly #onSceneTransition: ((transition: SceneTransition) => void) | null;
  readonly #onFrame: ((outcome: FrameIngestOutcome) => void) | null;

  #state: ObservationSessionState = 'idle';
  #selection: ObservationSessionSelection | null = null;
  #unsubscribeFrames: Unsubscribe | null = null;
  #unsubscribeWindows: Unsubscribe | null = null;

  #framesIngested = 0;
  #framesRejected = 0;
  #pointerSamples = 0;
  #windowEvents = 0;
  #contentRevisions = 0;
  #ignoredWindowEvents = 0;

  constructor(options: ObservationSessionOptions) {
    this.#core = options.core;
    this.#clock = options.clock;
    this.#logger = options.logger ?? nullLogger;
    this.#policy = options.policy ?? null;
    this.#capture =
      options.capture ??
      (options.policy === undefined ? DEFAULT_CAPTURE : toCaptureOptions(options.policy));
    this.#fingerprinter = new ContentFingerprinter(
      options.fingerprint ??
        (options.policy === undefined ? {} : toContentFingerprintConfig(options.policy)),
    );
    this.#observation = options.observation ?? null;
    this.#accessibility = options.accessibility ?? null;
    this.#windows = options.windows ?? null;
    this.#onSceneTransition = options.onSceneTransition ?? null;
    this.#onFrame = options.onFrame ?? null;
  }

  get state(): ObservationSessionState {
    return this.#state;
  }

  get core(): ObservationCore {
    return this.#core;
  }

  get fingerprinter(): ContentFingerprinter {
    return this.#fingerprinter;
  }

  /** Capture parameters the adapter was started with, bounded by policy. */
  get capture(): CaptureOptions {
    return this.#capture;
  }

  /** The screen policy in force, when one was injected. */
  get policy(): ScreenContextPolicy | null {
    return this.#policy;
  }

  /** The window the session is observing, or `null`. */
  get selection(): ObservationSessionSelection | null {
    return this.#selection;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Selects a window and starts capture. Selecting a different window clears
   * the buffers and starts a new scene, so nothing from the previous selection
   * survives the call.
   */
  async start(selection: ObservationSessionSelection): Promise<SceneTransition> {
    if (this.#selection !== null && this.#selection.window.windowId !== selection.window.windowId) {
      this.#fingerprinter.reset();
    }
    this.#selection = selection;
    const transition = this.#emit(
      this.#core.selectWindow({
        window: selection.window,
        geometry: selection.geometry,
        ...(selection.accessibilityRootId === undefined
          ? {}
          : { accessibilityRootId: selection.accessibilityRootId }),
        ...(this.#fingerprinter.fingerprint === null
          ? {}
          : { contentFingerprint: this.#fingerprinter.fingerprint }),
      }),
    );

    this.#subscribeWindows();
    if (this.#observation !== null) {
      await this.#observation.start(selection.window, this.#capture);
      this.#unsubscribeFrames?.();
      this.#unsubscribeFrames = this.#observation.subscribe((frame) => {
        this.ingestFrame(frame);
      });
    }
    this.#state = 'observing';
    return transition;
  }

  /**
   * Stops capture and clears every buffer. The default reason is an explicit
   * user action; lock, pause and window loss pass their own.
   *
   * The state change is synchronous — it happens before the adapter is awaited
   * — so a lifecycle event can never be followed by an ingest that slips into
   * the buffers while a promise settles.
   */
  async stop(reason: ClearReason = 'observation-disabled'): Promise<void> {
    this.#teardown(reason, reason === 'window-lost' ? 'ended' : 'idle');
    if (this.#observation !== null) {
      await this.#observation.stop();
    }
  }

  /**
   * Re-selects the remembered window after a suspension (screen unlock). The
   * result is a **new scene**: the buffers were cleared while suspended, so
   * nothing from before it may be answered from.
   */
  async resume(): Promise<SceneTransition> {
    const selection = this.#selection;
    if (selection === null) {
      throw new PilotError('observation-disabled', 'No window is selected', {
        userMessage: 'Pilot is not observing a window right now.',
      });
    }
    return this.start(selection);
  }

  /** Unsubscribes from every adapter. Does not clear — call {@link stop} first. */
  dispose(): void {
    this.#unsubscribeFrames?.();
    this.#unsubscribeFrames = null;
    this.#unsubscribeWindows?.();
    this.#unsubscribeWindows = null;
  }

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------

  /**
   * Ingests one captured frame.
   *
   * Order matters: the fingerprint is judged *before* the frame is stamped, so
   * a frame that carries new visual content is stamped with the revision its
   * own content established rather than with the one it replaced.
   */
  ingestFrame(frame: CapturedFrame): FrameIngestOutcome {
    const scene = this.#core.scene;
    if (scene === null || frame.windowId !== scene.windowId) {
      // Let the core produce the typed rejection; never fingerprint a frame
      // from a window that is not the selected one.
      const ingest = this.#core.ingestFrame(frame);
      this.#framesRejected += 1;
      return this.#reportFrame({ ingest, fingerprint: null, transition: null });
    }

    const fingerprint = this.#fingerprinter.observe(frame);
    let transition: SceneTransition | null = null;
    if (fingerprint.changed) {
      transition = this.#emit(
        this.#core.updateScene({ contentFingerprint: fingerprint.fingerprint }),
      );
      if (transition.kind === 'revised') {
        this.#contentRevisions += 1;
      }
    }

    const ingest = this.#core.ingestFrame(frame);
    if (ingest.admitted) {
      this.#framesIngested += 1;
    } else {
      this.#framesRejected += 1;
      this.#logger.debug('frame not admitted', {
        reason: ingest.reason,
        capturedAt: frame.capturedAt,
      });
    }
    return this.#reportFrame({ ingest, fingerprint, transition });
  }

  #reportFrame(outcome: FrameIngestOutcome): FrameIngestOutcome {
    this.#onFrame?.(outcome);
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Pointer and accessibility
  // -------------------------------------------------------------------------

  /**
   * Pulls one pointer position and its accessibility target from the platform
   * and records it. The caller owns the cadence (~30 Hz per system-design §17);
   * this keeps the session free of timers and the tests time-exact.
   */
  async samplePointer(at?: number): Promise<PointerSampleOutcome> {
    const accessibility = this.#accessibility;
    const selection = this.#selection;
    if (accessibility === null) {
      return { sampled: false, reason: 'no-accessibility-adapter' };
    }
    if (selection === null || this.#state !== 'observing') {
      return { sampled: false, reason: 'not-observing' };
    }

    const point = await accessibility.getPointer();
    const node = await accessibility.elementAt(point);
    const pointer = buildGroundedPointer(point, selection.geometry, node ?? undefined);
    const ingest = this.#core.ingestPointer({
      at: at ?? toTimestamp(this.#clock.now()),
      windowId: selection.window.windowId,
      pointer,
    });
    if (ingest.admitted) {
      this.#pointerSamples += 1;
    }
    return { sampled: true, ingest };
  }

  // -------------------------------------------------------------------------
  // Window lifecycle
  // -------------------------------------------------------------------------

  /**
   * Applies one window lifecycle event (system-design §16). Public so a caller
   * that owns its own subscription can feed events without a `WindowAdapter`.
   */
  handleWindowEvent(event: WindowEvent): void {
    this.#windowEvents += 1;
    const selection = this.#selection;

    switch (event.type) {
      case 'window-changed': {
        if (selection === null || event.window.windowId !== selection.window.windowId) {
          this.#ignoredWindowEvents += 1;
          return;
        }
        // The event carries authoritative bounds and title. `captureSize` is
        // only known to the capture adapter, so it is carried forward until
        // `updateGeometry` supplies a fresh one.
        const geometry: WindowGeometry = {
          ...selection.geometry,
          bounds: event.window.bounds,
          scaleFactor: event.window.scaleFactor,
        };
        this.#selection = { ...selection, window: event.window, geometry };
        this.#emit(this.#core.updateScene({ window: event.window, geometry }));
        return;
      }
      case 'window-closed': {
        if (selection === null || event.windowId !== selection.window.windowId) {
          this.#ignoredWindowEvents += 1;
          return;
        }
        this.#teardown('window-lost', 'ended');
        void this.#observation?.stop();
        return;
      }
      case 'screen-locked': {
        if (selection === null || this.#state !== 'observing') {
          this.#ignoredWindowEvents += 1;
          return;
        }
        // Suspension keeps the selection so `resume()` can re-select the same
        // window; everything captured is still dropped.
        this.#teardown('screen-locked', 'suspended');
        void this.#observation?.stop();
        return;
      }
      case 'screen-unlocked': {
        if (this.#state !== 'suspended') {
          this.#ignoredWindowEvents += 1;
          return;
        }
        // Never resume silently: the caller re-checks permission and the window
        // still being on screen, then calls `resume()` for a new scene.
        this.#state = 'resumable';
        return;
      }
      case 'window-list-changed':
        this.#ignoredWindowEvents += 1;
        return;
    }
  }

  /** Replaces the capture geometry, e.g. after the adapter re-negotiated it. */
  updateGeometry(geometry: WindowGeometry): SceneTransition {
    const selection = this.#selection;
    if (selection === null) {
      return { kind: 'idle' };
    }
    this.#selection = { ...selection, geometry };
    return this.#emit(this.#core.updateScene({ geometry }));
  }

  /** Records a new accessibility root for the selected window (PR-013). */
  updateAccessibilityRoot(accessibilityRootId: string): SceneTransition {
    const selection = this.#selection;
    if (selection === null) {
      return { kind: 'idle' };
    }
    this.#selection = { ...selection, accessibilityRootId };
    return this.#emit(this.#core.updateScene({ accessibilityRootId }));
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  status(): ObservationSessionStatus {
    return {
      state: this.#state,
      window: this.#selection?.window ?? null,
      geometry: this.#selection?.geometry ?? null,
      scene: this.#core.scene,
      contentFingerprint: this.#fingerprinter.fingerprint,
    };
  }

  metrics(): ObservationSessionMetrics {
    return {
      framesIngested: this.#framesIngested,
      framesRejected: this.#framesRejected,
      pointerSamples: this.#pointerSamples,
      windowEvents: this.#windowEvents,
      contentRevisions: this.#contentRevisions,
      ignoredWindowEvents: this.#ignoredWindowEvents,
    };
  }

  /** Synchronous half of every stop: detach, clear, forget. */
  #teardown(reason: ClearReason, nextState: ObservationSessionState): void {
    this.#unsubscribeFrames?.();
    this.#unsubscribeFrames = null;
    this.#core.clear(reason);
    this.#fingerprinter.reset();
    this.#state = nextState;
    if (nextState === 'ended' || nextState === 'idle') {
      this.#selection = null;
    }
  }

  #subscribeWindows(): void {
    if (this.#windows === null || this.#unsubscribeWindows !== null) {
      return;
    }
    this.#unsubscribeWindows = this.#windows.subscribe((event) => {
      this.handleWindowEvent(event);
    });
  }

  #emit(transition: SceneTransition): SceneTransition {
    this.#onSceneTransition?.(transition);
    return transition;
  }
}
