import type {
  AccessibilityNode,
  CaptureOptions,
  CapturedFrame,
  CredentialRef,
  ObservedWindow,
  PermissionAttribution,
  PermissionKind,
  PermissionSnapshot,
  PermissionStatus,
  PilotError,
  PixelSize,
  ScreenPoint,
  SpeechId,
  UtteranceId,
  WindowGeometry,
  WindowId,
} from '@pilot/shared';
import type { Subscribe, Unsubscribe } from './common.js';

/**
 * Platform adapter interfaces (system-design §5).
 *
 * PROVISIONAL (runbook §5 amendment 4): the four signatures printed in
 * system-design §5 — `PlatformAdapter`, `ObservationAdapter`,
 * `AccessibilityAdapter`, `ScreenContextService` — are reproduced verbatim.
 * The remaining adapters are not specified in the design document and are
 * deliberately thin; PR-011…PR-015 will reshape them against real TCC,
 * ScreenCaptureKit, Speech and Keychain behaviour. Keep consumers dependent on
 * the smallest useful subset.
 *
 * No macOS-specific type may appear in these signatures. The Windows
 * implementation later satisfies them unchanged (system-design §19).
 */

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export interface PermissionAdapter {
  /** Current status of one permission, without prompting. */
  status(kind: PermissionKind): Promise<PermissionStatus>;
  /** Current status of every permission Pilot may request. */
  snapshot(): Promise<PermissionSnapshot>;
  /**
   * Requests a permission. Resolves with the resulting status. On platforms
   * where a permission can only be granted in system settings, this resolves
   * with `canRequest: false` instead of prompting.
   */
  request(kind: PermissionKind): Promise<PermissionStatus>;
  /** Opens the platform settings pane for a permission, when one exists. */
  openSettings(kind: PermissionKind): Promise<void>;
  subscribe: Subscribe<PermissionStatus>;
  /**
   * Reports which process the operating system credits permission grants to
   * (PR-011). Optional so that adapters written before this method existed
   * still satisfy the interface; a caller that needs the answer must handle
   * `undefined` as "this platform does not report attribution".
   *
   * An adapter that implements it must never let a failing verdict pass as a
   * normal permission state — see `@pilot/shared`'s `isAttributionFailure`.
   */
  attribution?(): Promise<PermissionAttribution>;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * What changed about a window that is still open (PR-011).
 *
 * Reported as a set rather than a single winner: a window dragged to another
 * display while its document title changed produces `['title', 'position',
 * 'display']`, and collapsing that into one label would lose information a
 * consumer may need. "Retitled" is `title`; "moved" is `position`; "resized"
 * is `size`.
 */
export const WINDOW_CHANGE_KINDS = ['title', 'position', 'size', 'display', 'visibility'] as const;

export type WindowChangeKind = (typeof WINDOW_CHANGE_KINDS)[number];

/**
 * Window lifecycle events.
 *
 * The five variants are unchanged from PR-001. PR-011 added the optional
 * detail fields — the union itself did not grow a member, so an existing
 * exhaustive `switch` still compiles and still handles every case.
 *
 * - **appeared**: `window-list-changed` carrying `appeared`.
 * - **closed**: `window-closed` per window, and `disappeared` on the
 *   accompanying `window-list-changed`.
 * - **retitled / moved / resized**: `window-changed` carrying `changes`.
 */
export type WindowEvent =
  | {
      readonly type: 'window-list-changed';
      /** Windows present now that were absent before. */
      readonly appeared?: readonly ObservedWindow[];
      /** Windows absent now that were present before. */
      readonly disappeared?: readonly WindowId[];
    }
  | {
      readonly type: 'window-changed';
      readonly window: ObservedWindow;
      /** What changed. Absent when the producer does not distinguish. */
      readonly changes?: readonly WindowChangeKind[];
      /** The window as it was immediately before this change. */
      readonly previous?: ObservedWindow;
    }
  | { readonly type: 'window-closed'; readonly windowId: WindowId }
  | { readonly type: 'screen-locked' }
  | { readonly type: 'screen-unlocked' };

export interface WindowAdapter {
  /** Windows that can be observed, in platform z-order where available. */
  list(): Promise<readonly ObservedWindow[]>;
  get(windowId: WindowId): Promise<ObservedWindow | null>;
  /** Geometry required by the geometry module to convert pointer positions. */
  geometry(windowId: WindowId): Promise<WindowGeometry | null>;
  subscribe: Subscribe<WindowEvent>;
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/**
 * Why capture stopped (PR-012).
 *
 * `window-lost`, `screen-locked` and `protected-content` are the three the
 * design names explicitly (system-design §16), and each one means the consumer
 * must clear its buffers as well as stop reading — a frame of a window that no
 * longer exists is not a stale frame, it is a frame of somebody else's screen.
 */
export const CAPTURE_STOP_REASONS = [
  /** `stop()` was called. */
  'requested',
  /** The selected window is gone. */
  'window-lost',
  /** The session locked (system-design §14). */
  'screen-locked',
  /** The application blocks capture; its pixels are blank, not black. */
  'protected-content',
  /** The native helper died or became unreachable. */
  'helper-unavailable',
  /** Any other capture failure. */
  'failed',
] as const;

export type CaptureStopReason = (typeof CAPTURE_STOP_REASONS)[number];

/** Why a frame the platform received never reached the consumer (PR-012). */
export const FRAME_DROP_REASONS = [
  /** The frame belonged to a window that is not the selected one. */
  'foreign-window',
  /** Zero-length payload. The ring rejects these; they never leave the adapter. */
  'empty-bytes',
  /** The producer repeated a sequence number already delivered. */
  'duplicate',
  /** Declared byte length disagreed with the payload actually received. */
  'byte-length-mismatch',
  /** Larger than any buffer configured to hold it. */
  'too-large',
  /** The producer's timestamp was implausible and was replaced. */
  'clock-skew',
  /** Dropped by the producer's own bounded queue, before the host saw it. */
  'producer-backpressure',
] as const;

export type FrameDropReason = (typeof FRAME_DROP_REASONS)[number];

/**
 * Capture lifecycle, separate from the frames themselves (PR-012).
 *
 * Frames flow through `ObservationAdapter.subscribe`; this is everything else a
 * consumer needs in order to obey system-design §6 and §16 — start, stop and
 * the reason, plus the drops it would otherwise have to infer from silence.
 */
export type ObservationEvent =
  | {
      readonly type: 'capture-started';
      readonly windowId: WindowId;
      /** Pixel size the stream was configured at, after the policy downscale. */
      readonly captureSize: PixelSize;
    }
  | {
      readonly type: 'capture-stopped';
      readonly reason: CaptureStopReason;
      /** Present for every reason but `requested`. */
      readonly error?: PilotError;
    }
  | {
      readonly type: 'frames-dropped';
      readonly reason: FrameDropReason;
      readonly count: number;
    };

/**
 * system-design §5, verbatim — plus one optional member added by PR-012.
 *
 * `subscribeEvents` is optional for the same reason `PermissionAdapter.
 * attribution` is: adapters written before it existed still satisfy the
 * interface, and a caller that needs the answer handles `undefined` as "this
 * platform does not report capture lifecycle". Adding an optional member is
 * source-compatible; the four verbatim methods are untouched.
 */
export interface ObservationAdapter {
  start(window: ObservedWindow, options: CaptureOptions): Promise<void>;
  stop(): Promise<void>;
  captureFresh(signal?: AbortSignal): Promise<CapturedFrame>;
  subscribe(listener: (frame: CapturedFrame) => void): () => void;
  /** Capture lifecycle and drop notifications (PR-012). */
  subscribeEvents?: Subscribe<ObservationEvent>;
}

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

/** system-design §5, verbatim. */
export interface AccessibilityAdapter {
  getPointer(): Promise<ScreenPoint>;
  elementAt(point: ScreenPoint): Promise<AccessibilityNode | null>;
}

// ---------------------------------------------------------------------------
// Speech input
// ---------------------------------------------------------------------------

export interface SpeechInputAvailability {
  readonly available: boolean;
  /** True when recognition runs entirely on device. */
  readonly onDevice: boolean;
  /** Locale identifier the recogniser will use, when known. */
  readonly locale?: string;
}

export type SpeechInputEvent =
  | { readonly type: 'partial'; readonly utteranceId: UtteranceId; readonly transcript: string }
  | { readonly type: 'final'; readonly utteranceId: UtteranceId; readonly transcript: string }
  | { readonly type: 'error'; readonly utteranceId: UtteranceId; readonly error: Error };

export interface SpeechInputRequest {
  readonly utteranceId: UtteranceId;
  /** Refuse to start when on-device recognition is unavailable. */
  readonly requireOnDevice: boolean;
  readonly locale?: string;
}

export interface SpeechInputAdapter {
  availability(): Promise<SpeechInputAvailability>;
  /** Begins capture and recognition for one utterance. */
  start(request: SpeechInputRequest): Promise<void>;
  /** Ends capture; a `final` event follows unless recognition failed. */
  stop(utteranceId: UtteranceId): Promise<void>;
  /** Ends capture and discards the utterance; no `final` event follows. */
  cancel(utteranceId: UtteranceId): Promise<void>;
  subscribe: Subscribe<SpeechInputEvent>;
}

// ---------------------------------------------------------------------------
// Speech output
// ---------------------------------------------------------------------------

export type SpeechOutputEvent =
  | { readonly type: 'started'; readonly speechId: SpeechId }
  | { readonly type: 'finished'; readonly speechId: SpeechId }
  | { readonly type: 'stopped'; readonly speechId: SpeechId }
  | { readonly type: 'error'; readonly speechId: SpeechId; readonly error: Error };

export interface SpeechOutputRequest {
  readonly speechId: SpeechId;
  readonly text: string;
  readonly voice?: string;
  readonly rate?: number;
}

export interface SpeechOutputAdapter {
  availability(): Promise<{ readonly available: boolean; readonly voices: readonly string[] }>;
  speak(request: SpeechOutputRequest): Promise<void>;
  /** Stops one utterance, or everything when no id is given. Must be immediate. */
  stop(speechId?: SpeechId): Promise<void>;
  subscribe: Subscribe<SpeechOutputEvent>;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Secret storage. Secrets are read in the main process at request time and
 * never sent to the renderer (system-design §12).
 */
export interface CredentialAdapter {
  isAvailable(): boolean;
  get(ref: CredentialRef): Promise<string | null>;
  set(ref: CredentialRef, secret: string): Promise<void>;
  delete(ref: CredentialRef): Promise<void>;
  list(): Promise<readonly CredentialRef[]>;
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

/** system-design §5, verbatim. */
export interface PlatformAdapter {
  permissions: PermissionAdapter;
  windows: WindowAdapter;
  observation: ObservationAdapter;
  accessibility: AccessibilityAdapter;
  speechInput: SpeechInputAdapter;
  speechOutput: SpeechOutputAdapter;
  credentials: CredentialAdapter;
}

/**
 * Lifecycle for concrete platform adapters (helper spawn/supervision on macOS).
 * Kept separate so `PlatformAdapter` matches the design document exactly.
 */
export interface PlatformAdapterLifecycle {
  start(): Promise<void>;
  dispose(): Promise<void>;
  /** Called on pause, lock, logout and shutdown; must clear frame and audio buffers. */
  clearBuffers(): Promise<void>;
}

export type ManagedPlatformAdapter = PlatformAdapter & PlatformAdapterLifecycle;

export type { Unsubscribe };
