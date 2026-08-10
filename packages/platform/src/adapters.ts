import type {
  AccessibilityNode,
  CaptureOptions,
  CapturedFrame,
  CredentialRef,
  ObservedWindow,
  PermissionKind,
  PermissionSnapshot,
  PermissionStatus,
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
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export type WindowEvent =
  | { readonly type: 'window-list-changed' }
  | { readonly type: 'window-changed'; readonly window: ObservedWindow }
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
