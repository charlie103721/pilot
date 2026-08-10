import {
  asDisplayId,
  asModelProfileId,
  asObservationId,
  asSceneId,
  asWindowId,
  createCounterIdSource,
  createIdFactory,
  type AccessibilityNode,
  type CapturedFrame,
  type DisplayInfo,
  type ModelProfile,
  type ObservedWindow,
  type PermissionSnapshot,
  type ScreenObservation,
  type ScreenRect,
  type SceneState,
  type WindowGeometry,
} from '@pilot/shared';
import { FAKE_EPOCH_MS } from './support.js';

/**
 * Deterministic fixtures shared by every fake.
 *
 * These describe a two-display setup: a 2× Retina primary display and a
 * standard-DPI secondary display placed to the left of it, so consumers get
 * Retina and negative-origin coordinates for free.
 */

export const PRIMARY_DISPLAY: DisplayInfo = {
  displayId: asDisplayId('display-primary'),
  bounds: { x: 0, y: 0, width: 1728, height: 1117 },
  scaleFactor: 2,
  isPrimary: true,
};

export const SECONDARY_DISPLAY: DisplayInfo = {
  displayId: asDisplayId('display-secondary'),
  bounds: { x: -1920, y: -120, width: 1920, height: 1080 },
  scaleFactor: 1,
  isPrimary: false,
};

export const FIXTURE_DISPLAYS: readonly DisplayInfo[] = [PRIMARY_DISPLAY, SECONDARY_DISPLAY];

const RETINA_WINDOW_BOUNDS: ScreenRect = { x: 100, y: 80, width: 1200, height: 800 };
const SECONDARY_WINDOW_BOUNDS: ScreenRect = { x: -1600, y: 40, width: 1000, height: 700 };

export const FIXTURE_WINDOW_RETINA: ObservedWindow = {
  windowId: asWindowId('window-retina'),
  displayId: PRIMARY_DISPLAY.displayId,
  title: 'Billing Settings',
  applicationName: 'Safari',
  applicationBundleId: 'com.apple.Safari',
  bounds: RETINA_WINDOW_BOUNDS,
  scaleFactor: 2,
  isOnScreen: true,
};

export const FIXTURE_WINDOW_SECONDARY: ObservedWindow = {
  windowId: asWindowId('window-secondary'),
  displayId: SECONDARY_DISPLAY.displayId,
  title: 'Untitled.txt',
  applicationName: 'TextEdit',
  applicationBundleId: 'com.apple.TextEdit',
  bounds: SECONDARY_WINDOW_BOUNDS,
  scaleFactor: 1,
  isOnScreen: true,
};

export const FIXTURE_WINDOWS: readonly ObservedWindow[] = [
  FIXTURE_WINDOW_RETINA,
  FIXTURE_WINDOW_SECONDARY,
];

export const FIXTURE_GEOMETRY_RETINA: WindowGeometry = {
  windowId: FIXTURE_WINDOW_RETINA.windowId,
  displayId: PRIMARY_DISPLAY.displayId,
  bounds: RETINA_WINDOW_BOUNDS,
  scaleFactor: 2,
  captureSize: { width: 2400, height: 1600 },
};

export const FIXTURE_GEOMETRY_SECONDARY: WindowGeometry = {
  windowId: FIXTURE_WINDOW_SECONDARY.windowId,
  displayId: SECONDARY_DISPLAY.displayId,
  bounds: SECONDARY_WINDOW_BOUNDS,
  scaleFactor: 1,
  captureSize: { width: 1000, height: 700 },
};

export const FIXTURE_GEOMETRY_BY_WINDOW: ReadonlyMap<string, WindowGeometry> = new Map([
  [FIXTURE_WINDOW_RETINA.windowId, FIXTURE_GEOMETRY_RETINA],
  [FIXTURE_WINDOW_SECONDARY.windowId, FIXTURE_GEOMETRY_SECONDARY],
]);

export const FIXTURE_SCENE: SceneState = {
  sceneId: asSceneId('scene-0001'),
  revision: 4,
  windowId: FIXTURE_WINDOW_RETINA.windowId,
  windowTitle: FIXTURE_WINDOW_RETINA.title,
  fingerprint: 'fingerprint-0001',
  updatedAt: FAKE_EPOCH_MS,
};

export const FIXTURE_ACCESSIBILITY_NODE: AccessibilityNode = {
  role: 'AXCheckBox',
  subrole: 'AXToggle',
  label: 'Auto Renew',
  value: 'off',
  bounds: { x: 700, y: 480, width: 60, height: 30 },
  isSecure: false,
};

export const FIXTURE_SECURE_NODE: AccessibilityNode = {
  role: 'AXTextField',
  subrole: 'AXSecureTextField',
  label: 'Password',
  value: 'hunter2',
  bounds: { x: 400, y: 600, width: 240, height: 28 },
  isSecure: true,
};

export const FIXTURE_PERMISSIONS_GRANTED: PermissionSnapshot = {
  'screen-recording': { kind: 'screen-recording', state: 'granted', canRequest: false },
  accessibility: { kind: 'accessibility', state: 'granted', canRequest: false },
  microphone: { kind: 'microphone', state: 'granted', canRequest: false },
  'speech-recognition': { kind: 'speech-recognition', state: 'granted', canRequest: false },
};

export const FIXTURE_PERMISSIONS_UNKNOWN: PermissionSnapshot = {
  'screen-recording': { kind: 'screen-recording', state: 'unknown', canRequest: true },
  accessibility: { kind: 'accessibility', state: 'unknown', canRequest: true },
  microphone: { kind: 'microphone', state: 'unknown', canRequest: true },
  'speech-recognition': { kind: 'speech-recognition', state: 'unknown', canRequest: true },
};

/**
 * Everything refused. `canRequest: false` throughout, because macOS only ever
 * prompts once per permission: after a denial the user must go to System
 * Settings, which is exactly the case system-design §16 asks the UI to handle.
 */
export const FIXTURE_PERMISSIONS_DENIED: PermissionSnapshot = {
  'screen-recording': { kind: 'screen-recording', state: 'denied', canRequest: false },
  accessibility: { kind: 'accessibility', state: 'denied', canRequest: false },
  microphone: { kind: 'microphone', state: 'denied', canRequest: false },
  'speech-recognition': { kind: 'speech-recognition', state: 'denied', canRequest: false },
};

/**
 * Withheld by policy rather than by the user — a managed device, a configuration
 * profile, or Screen Time. Distinct from `denied`: the user cannot fix it from
 * their own System Settings, so an "Open System Settings" shortcut is not the
 * answer and the UI must say something different.
 */
export const FIXTURE_PERMISSIONS_RESTRICTED: PermissionSnapshot = {
  'screen-recording': { kind: 'screen-recording', state: 'restricted', canRequest: false },
  accessibility: { kind: 'accessibility', state: 'restricted', canRequest: false },
  microphone: { kind: 'microphone', state: 'restricted', canRequest: false },
  'speech-recognition': { kind: 'speech-recognition', state: 'restricted', canRequest: false },
};

/**
 * The hard stop: no Screen Recording, everything else fine. Pilot cannot see
 * anything at all (system-design §16, "Screen permission denied").
 */
export const FIXTURE_PERMISSIONS_SCREEN_DENIED: PermissionSnapshot = {
  ...FIXTURE_PERMISSIONS_GRANTED,
  'screen-recording': { kind: 'screen-recording', state: 'denied', canRequest: false },
};

/**
 * The degraded mode: Pilot can see the window but cannot ask macOS what the
 * pointer is over, so it falls back to visual pointer coordinates
 * (system-design §16, "Accessibility denied"). Deliberately *not* the same
 * fixture as {@link FIXTURE_PERMISSIONS_SCREEN_DENIED}.
 */
export const FIXTURE_PERMISSIONS_ACCESSIBILITY_DENIED: PermissionSnapshot = {
  ...FIXTURE_PERMISSIONS_GRANTED,
  accessibility: { kind: 'accessibility', state: 'denied', canRequest: false },
};

/** One permission in each state, for exercising a partially-onboarded app. */
export const FIXTURE_PERMISSIONS_MIXED: PermissionSnapshot = {
  'screen-recording': { kind: 'screen-recording', state: 'granted', canRequest: false },
  accessibility: { kind: 'accessibility', state: 'denied', canRequest: false },
  microphone: { kind: 'microphone', state: 'unknown', canRequest: true },
  'speech-recognition': { kind: 'speech-recognition', state: 'restricted', canRequest: false },
};

export const FIXTURE_MODEL_PROFILE: ModelProfile = {
  id: asModelProfileId('profile-fake-vision'),
  provider: 'fake',
  model: 'fake-vision-1',
  authMode: 'local',
  supportsVision: true,
  supportsTools: true,
  isRemote: false,
};

export const FIXTURE_MODEL_PROFILE_NO_VISION: ModelProfile = {
  id: asModelProfileId('profile-fake-text'),
  provider: 'fake',
  model: 'fake-text-1',
  authMode: 'local',
  supportsVision: false,
  supportsTools: true,
  isRemote: false,
};

/**
 * Deterministic frame bytes. Not a real JPEG: fakes must never be mistaken for
 * a source of decodable pixels, and the first bytes encode the frame index so
 * assertions can identify a frame.
 */
export function createFixtureFrameBytes(index: number, byteLength = 64): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = index & 0xff;
  for (let i = 3; i < byteLength; i += 1) {
    bytes[i] = (index * 31 + i) & 0xff;
  }
  return bytes;
}

export interface FixtureFrameOptions {
  readonly index: number;
  readonly window?: ObservedWindow;
  readonly geometry?: WindowGeometry;
  readonly scene?: SceneState;
  readonly intervalMs?: number;
  readonly startedAt?: number;
}

export function createFixtureFrame(options: FixtureFrameOptions): CapturedFrame {
  const window = options.window ?? FIXTURE_WINDOW_RETINA;
  const geometry = options.geometry ?? FIXTURE_GEOMETRY_RETINA;
  const scene = options.scene ?? FIXTURE_SCENE;
  const intervalMs = options.intervalMs ?? 333;
  const startedAt = options.startedAt ?? FAKE_EPOCH_MS;
  return {
    frameId: createIdFactory(createCounterIdSource(options.index)).frame(),
    windowId: window.windowId,
    sceneId: scene.sceneId,
    capturedAt: startedAt + options.index * intervalMs,
    size: geometry.captureSize,
    scaleFactor: geometry.scaleFactor,
    encoding: 'jpeg',
    bytes: createFixtureFrameBytes(options.index),
  };
}

/** A short deterministic ring of frames for the selected window. */
export function createFixtureFrames(count = 9): readonly CapturedFrame[] {
  return Array.from({ length: count }, (_unused, index) => createFixtureFrame({ index }));
}

/** 1×1 transparent PNG — the smallest legitimate image payload for fixtures. */
export const FIXTURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export function createFixtureObservation(overrides: Partial<ScreenObservation> = {}) {
  const base: ScreenObservation = {
    observationId: asObservationId('obs-0001'),
    sceneId: FIXTURE_SCENE.sceneId,
    sceneRevision: FIXTURE_SCENE.revision,
    capturedAt: FAKE_EPOCH_MS,
    windowTitle: FIXTURE_WINDOW_RETINA.title,
    pointer: { x: 0.5, y: 0.5 },
    target: {
      role: FIXTURE_ACCESSIBILITY_NODE.role,
      label: FIXTURE_ACCESSIBILITY_NODE.label,
      value: FIXTURE_ACCESSIBILITY_NODE.value,
      normalizedBounds: { x: 0.5, y: 0.5, width: 0.05, height: 0.0375 },
      isSecure: false,
    },
    images: [{ mimeType: 'image/png', base64: FIXTURE_PNG_BASE64, purpose: 'window' }],
  };
  return { ...base, ...overrides } satisfies ScreenObservation;
}
