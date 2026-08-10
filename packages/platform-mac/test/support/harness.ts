import { fileURLToPath } from 'node:url';
import { NativeHelperTransport, type HelperTransportOptions } from '@pilot/platform-mac';
import type { WindowGeometry } from '@pilot/shared';
import type { StubAxElement, StubConfig, StubDisplay, StubWindow } from './helper-stub.js';

/** Absolute path to the Node stub that speaks the helper protocol. */
export const HELPER_STUB_PATH = fileURLToPath(new URL('./helper-stub.ts', import.meta.url));

/**
 * Builds a transport pointed at the Node stub instead of the Swift helper.
 *
 * Timeouts default to small values so the failure paths run in milliseconds
 * rather than seconds; every test that exercises a deadline sets its own.
 */
export function createStubTransport(
  stub: StubConfig = {},
  options: Partial<HelperTransportOptions> = {},
): NativeHelperTransport {
  return new NativeHelperTransport({
    command: process.execPath,
    args: [HELPER_STUB_PATH],
    env: { ...process.env, PILOT_HELPER_STUB: JSON.stringify(stub) },
    requestTimeoutMs: 2_000,
    handshakeTimeoutMs: 2_000,
    readyTimeoutMs: 4_000,
    shutdownGraceMs: 250,
    restart: { enabled: false },
    ...options,
  });
}

/** Deterministic pseudo-random bytes; the binary fixture for round-trip tests. */
export function deterministicBytes(length: number, seed = 0x9e3779b9): Buffer {
  const bytes = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// PR-011 fixtures
//
// A two-display desktop — a 2× Retina primary and a standard-DPI secondary
// with a negative origin — matching the fixtures in `@pilot/platform/fakes`,
// so a test that swaps the fake adapter for the macOS one is comparing like
// with like.
// ---------------------------------------------------------------------------

export const STUB_PRIMARY_DISPLAY: StubDisplay = {
  displayNumber: 1,
  bounds: { x: 0, y: 0, width: 1728, height: 1117 },
  scaleFactor: 2,
  isPrimary: true,
};

export const STUB_SECONDARY_DISPLAY: StubDisplay = {
  displayNumber: 2,
  bounds: { x: -1920, y: -120, width: 1920, height: 1080 },
  scaleFactor: 1,
  isPrimary: false,
};

export const STUB_DISPLAYS: StubDisplay[] = [STUB_PRIMARY_DISPLAY, STUB_SECONDARY_DISPLAY];

export function stubWindow(overrides: Partial<StubWindow> = {}): StubWindow {
  return {
    windowNumber: 42,
    ownerPid: 501,
    applicationName: 'Safari',
    applicationBundleId: 'com.apple.Safari',
    title: 'Billing Settings',
    titleAvailable: true,
    bounds: { x: 100, y: 80, width: 1200, height: 800 },
    displayNumber: 1,
    isOnScreen: true,
    layer: 0,
    ...overrides,
  };
}

export const STUB_WINDOW_SAFARI = stubWindow();

export const STUB_WINDOW_TEXTEDIT = stubWindow({
  windowNumber: 77,
  ownerPid: 502,
  applicationName: 'TextEdit',
  applicationBundleId: 'com.apple.TextEdit',
  title: 'Untitled.txt',
  bounds: { x: -1600, y: 40, width: 1000, height: 700 },
  displayNumber: 2,
});

// ---------------------------------------------------------------------------
// PR-013 fixtures
//
// Two windows on two displays with different backing scales, so every geometry
// assertion is made twice against materially different numbers:
//
// - Safari, 1200×800 pt at (100, 80) on the 2× primary display — captured at
//   2400×1600 px.
// - TextEdit, 1000×700 pt at (−1600, 40) on the 1× secondary display, whose own
//   origin is negative — captured at 1000×700 px.
//
// Both derive from `STUB_WINDOW_*` above rather than restating the bounds, so a
// change to one window cannot silently desynchronise the geometry used to
// normalise pointers over it.
// ---------------------------------------------------------------------------

function geometryFor(window: StubWindow, display: StubDisplay): WindowGeometry {
  return {
    windowId: `mac-window-${String(window.windowNumber)}` as WindowGeometry['windowId'],
    displayId: `mac-display-${String(display.displayNumber)}` as WindowGeometry['displayId'],
    bounds: window.bounds,
    scaleFactor: display.scaleFactor,
    captureSize: {
      width: window.bounds.width * display.scaleFactor,
      height: window.bounds.height * display.scaleFactor,
    },
  };
}

/** 1200×800 pt at (100, 80) on the 2× primary display. */
export const RETINA_GEOMETRY: WindowGeometry = geometryFor(
  STUB_WINDOW_SAFARI,
  STUB_PRIMARY_DISPLAY,
);

/** 1000×700 pt at (−1600, 40) on the 1× display whose origin is (−1920, −120). */
export const SECONDARY_GEOMETRY: WindowGeometry = geometryFor(
  STUB_WINDOW_TEXTEDIT,
  STUB_SECONDARY_DISPLAY,
);

/** A plain button inside the Retina window: (700, 480) → (760, 510) in screen points. */
export const STUB_AX_BUTTON: StubAxElement = {
  bounds: { x: 700, y: 480, width: 60, height: 30 },
  role: 'AXButton',
  subrole: null,
  label: 'Auto Renew',
  value: 'on',
  ownerPid: STUB_WINDOW_SAFARI.ownerPid,
};

/** A password field: macOS marks it by subrole, which is how AppKit and WebKit do it. */
export const STUB_AX_SECURE_FIELD: StubAxElement = {
  bounds: { x: 400, y: 300, width: 220, height: 24 },
  role: 'AXTextField',
  subrole: 'AXSecureTextField',
  label: 'Password',
  value: 'hunter2',
  ownerPid: STUB_WINDOW_SAFARI.ownerPid,
};

/**
 * An element belonging to a *different* application, overlapping the Retina
 * window — a floating palette or a notification sitting on top of it.
 */
export const STUB_AX_FOREIGN_ELEMENT: StubAxElement = {
  bounds: { x: 900, y: 500, width: 200, height: 100 },
  role: 'AXStaticText',
  subrole: null,
  label: 'Message from Bob',
  value: 'see you at six',
  ownerPid: 999,
};

/** An element in the secondary, standard-DPI window. */
export const STUB_AX_SECONDARY_ELEMENT: StubAxElement = {
  bounds: { x: -1500, y: 140, width: 300, height: 40 },
  role: 'AXTextArea',
  subrole: null,
  label: 'Draft',
  value: 'dear sir',
  ownerPid: STUB_WINDOW_TEXTEDIT.ownerPid,
};

/** Resolves with the next payload emitted for `event`, or rejects on timeout. */
export function once<T>(
  subscribe: (listener: (payload: T) => void) => () => void,
  timeoutMs = 4_000,
  predicate: (payload: T) => boolean = () => true,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out after ${String(timeoutMs)}ms waiting for an event`));
    }, timeoutMs);
    const unsubscribe = subscribe((payload) => {
      if (!predicate(payload)) {
        return;
      }
      clearTimeout(timer);
      unsubscribe();
      resolve(payload);
    });
  });
}
