import {
  MVP_SCREEN_POLICY,
  asDisplayId,
  asWindowId,
  type CaptureOptions,
  type ObservedWindow,
  type WindowGeometry,
  type WindowId,
} from '@pilot/shared';
import type { Unsubscribe, WindowAdapter, WindowEvent } from '@pilot/platform';

/**
 * PR-012 test fixtures.
 *
 * Kept out of `harness.ts` on purpose: PR-013 and PR-014 are running in this
 * package at the same time, and cross-lane issue 5 in `docs/runbook.md` is
 * exactly two lanes appending to one shared file and git merging both texts.
 */

/** The window the stub's desktop describes (`STUB_WINDOW_SAFARI`), as a domain window. */
export function captureWindow(overrides: Partial<ObservedWindow> = {}): ObservedWindow {
  return {
    windowId: asWindowId('mac-window-42'),
    displayId: asDisplayId('mac-display-1'),
    title: 'Billing Settings',
    applicationName: 'Safari',
    applicationBundleId: 'com.apple.Safari',
    bounds: { x: 100, y: 80, width: 1200, height: 800 },
    scaleFactor: 2,
    isOnScreen: true,
    ...overrides,
  };
}

/** The MVP screen policy as `CaptureOptions` (system-design §10). */
export const CAPTURE_OPTIONS: CaptureOptions = {
  sampleFps: MVP_SCREEN_POLICY.sampleFps,
  maxEdgePixels: MVP_SCREEN_POLICY.fullFrameMaxEdge,
  includeCursor: false,
};

/**
 * A `WindowAdapter` that only emits what a test tells it to.
 *
 * The capture adapter uses it for one thing — hearing that the window closed or
 * the screen locked — so `list`, `get` and `geometry` answer from a fixed table
 * rather than pretending to enumerate anything.
 */
export class ScriptedWindowAdapter implements WindowAdapter {
  readonly #listeners = new Set<(event: WindowEvent) => void>();
  #windows: readonly ObservedWindow[];

  subscriberCount = 0;

  constructor(windows: readonly ObservedWindow[] = [captureWindow()]) {
    this.#windows = windows;
  }

  subscribe = (listener: (event: WindowEvent) => void): Unsubscribe => {
    this.#listeners.add(listener);
    this.subscriberCount += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#listeners.delete(listener);
      this.subscriberCount -= 1;
    };
  };

  emit(event: WindowEvent): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }

  async list(): Promise<readonly ObservedWindow[]> {
    return this.#windows;
  }

  async get(windowId: WindowId): Promise<ObservedWindow | null> {
    return this.#windows.find((window) => window.windowId === windowId) ?? null;
  }

  async geometry(windowId: WindowId): Promise<WindowGeometry | null> {
    const window = await this.get(windowId);
    if (window === null) {
      return null;
    }
    return {
      windowId: window.windowId,
      displayId: window.displayId,
      bounds: window.bounds,
      scaleFactor: window.scaleFactor,
      captureSize: {
        width: window.bounds.width * window.scaleFactor,
        height: window.bounds.height * window.scaleFactor,
      },
    };
  }
}
