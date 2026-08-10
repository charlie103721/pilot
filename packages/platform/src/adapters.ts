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
  ScreenPoint,
  SpeechId,
  SpeechRecognitionDestination,
  SpeechRecognitionDisclosure,
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

/** system-design §5, verbatim. */
export interface ObservationAdapter {
  start(window: ObservedWindow, options: CaptureOptions): Promise<void>;
  stop(): Promise<void>;
  captureFresh(signal?: AbortSignal): Promise<CapturedFrame>;
  subscribe(listener: (frame: CapturedFrame) => void): () => void;
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
  /**
   * Where the audio would be turned into text (PR-014). Optional and additive:
   * an adapter written before this field existed still satisfies the
   * interface, and a caller that needs the answer must treat `undefined` as
   * "this platform does not report it" — which is not the same as `on-device`.
   */
  readonly destination?: SpeechRecognitionDestination;
  /** The renderable form of the same answer. See `@pilot/shared`'s `speech.ts`. */
  readonly disclosure?: SpeechRecognitionDisclosure;
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
  /**
   * Ends capture; a `final` event follows unless recognition failed.
   *
   * Must be a no-op for an utterance that is not recording. A recogniser is
   * allowed to finalise on its own before push-to-talk is released, so this
   * call routinely arrives for an utterance the adapter has already closed —
   * throwing then would turn a successfully submitted question into a failure
   * (PR-025 found exactly that defect one layer up).
   */
  stop(utteranceId: UtteranceId): Promise<void>;
  /** Ends capture and discards the utterance; no `final` event follows. Also idempotent. */
  cancel(utteranceId: UtteranceId): Promise<void>;
  subscribe: Subscribe<SpeechInputEvent>;
  /**
   * Where recognition would send the audio if it started now, in a form the
   * UI can render (PR-014, system-design §14).
   *
   * Optional so adapters written before this method existed still satisfy the
   * interface — the same shape as `PermissionAdapter.attribution?()`. A caller
   * that needs the answer must handle `undefined` as "this platform does not
   * disclose it", and must not read that as "recognition is local".
   */
  disclosure?(): Promise<SpeechRecognitionDisclosure>;
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
  /**
   * Stops one utterance, or everything when no id is given. Must be immediate
   * (system-design §17 targets interruption below 300 ms).
   *
   * Platform note, documented rather than contracted (PR-014): a platform with
   * a single synthesis queue — macOS `AVSpeechSynthesizer` is one — cannot
   * remove a middle utterance without flushing the queue, so stopping any
   * utterance stops all of them. Such an adapter must emit a `stopped` event
   * for **every** utterance it discarded, so a caller tracking several ids
   * never waits on one that will now never speak.
   */
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
