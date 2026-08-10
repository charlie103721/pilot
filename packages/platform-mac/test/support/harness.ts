import { fileURLToPath } from 'node:url';
import { NativeHelperTransport, type HelperTransportOptions } from '@pilot/platform-mac';
import type { StubConfig, StubDisplay, StubWindow } from './helper-stub.js';

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
