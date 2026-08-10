import {
  asDisplayId,
  asWindowId,
  type DisplayId,
  type DisplayInfo,
  type ObservedWindow,
  type WindowGeometry,
  type WindowId,
} from '@pilot/shared';
import type { NativeDisplay, NativeWindow } from '../protocol/window-ops.js';

/**
 * Mapping from window-server records to the domain's `ObservedWindow`.
 *
 * ## What a `WindowId` guarantees
 *
 * This matters more than it looks. `ObservationCore.ingestFrame` rejects any
 * frame whose `windowId` is not exactly the selected window's
 * (`packages/observation/src/observation-core.ts`), so an id that changes
 * without the window changing does not produce an error — it produces silence.
 * Capture keeps running, every frame is dropped as `foreign-window`, and the
 * only symptom is that the model never sees anything.
 *
 * So the id is a **pure function of one native fact**:
 *
 * ```text
 * WindowId = "mac-window-" + CGWindowID
 * ```
 *
 * Nothing else feeds it. No counter, no array index, no session nonce, no
 * hash of the title, no `Math.random`, no clock. The consequences follow from
 * that and are worth stating explicitly:
 *
 * | Event | Does the id change? |
 * | --- | --- |
 * | Window retitled, moved, resized, minimised, hidden | **No** |
 * | Window moved to another display or another Space | **No** |
 * | Helper crashes and is restarted by the supervisor | **No** |
 * | Pilot itself is relaunched | **No** |
 * | Owning application quits and is reopened | **Yes** — a new window |
 * | Window closed and a new one opened | **Yes** — a new window |
 *
 * The helper restart row is the one PR-012 depends on. A restart re-derives
 * every id from the same `CGWindowID`s the window server still holds, so the
 * selected window keeps its identity and ingest survives the reconnection.
 *
 * ## The recycling caveat, and what is done about it
 *
 * `CGWindowID`s are 32-bit and the window server may reuse one after the
 * window that held it is destroyed. Nothing in the API prevents a recycled id
 * from landing on an unrelated window of a different application, which would
 * silently redirect a selection.
 *
 * That is why `ownerPid` travels alongside. The diff
 * (`src/windows/window-diff.ts`) treats "same `CGWindowID`, different
 * `ownerPid`" as a close followed by an appearance, never as a change — so a
 * recycled id can never be inherited by a selection without a `window-closed`
 * being delivered first. Consumers that stop on `window-closed`
 * (system-design §16) therefore stop, rather than quietly observing a
 * stranger's window.
 */

/** Prefix that namespaces macOS window ids. Part of the wire contract; do not change. */
export const MAC_WINDOW_ID_PREFIX = 'mac-window-';

/** Prefix that namespaces macOS display ids. */
export const MAC_DISPLAY_ID_PREFIX = 'mac-display-';

/**
 * The stable id for a `CGWindowID`. Deterministic, total, and dependent on
 * nothing but its argument.
 */
export function macWindowId(windowNumber: number): WindowId {
  return asWindowId(`${MAC_WINDOW_ID_PREFIX}${String(windowNumber)}`);
}

/** The inverse of {@link macWindowId}; `null` when the id is not a macOS window id. */
export function macWindowNumber(windowId: WindowId): number | null {
  if (!windowId.startsWith(MAC_WINDOW_ID_PREFIX)) {
    return null;
  }
  const digits = windowId.slice(MAC_WINDOW_ID_PREFIX.length);
  if (!/^\d+$/.test(digits)) {
    return null;
  }
  const value = Number.parseInt(digits, 10);
  return Number.isSafeInteger(value) ? value : null;
}

export function macDisplayId(displayNumber: number): DisplayId {
  return asDisplayId(`${MAC_DISPLAY_ID_PREFIX}${String(displayNumber)}`);
}

/**
 * Fallback used when macOS withholds a window title, which it does for every
 * window when Screen Recording is not in force. Deliberately not an empty
 * string: a window genuinely can have no title, and the picker must be able to
 * tell "this window is called nothing" from "Pilot is not allowed to know".
 */
export const WITHHELD_TITLE = '(title unavailable — Screen Recording not granted)';

/** The display a window sits on: the one it names, else the primary, else none. */
export function displayForWindow(
  window: NativeWindow,
  displays: readonly NativeDisplay[],
): NativeDisplay | undefined {
  if (window.displayNumber !== null) {
    const named = displays.find((display) => display.displayNumber === window.displayNumber);
    if (named !== undefined) {
      return named;
    }
  }
  return displays.find((display) => display.isPrimary) ?? displays[0];
}

export function toDisplayInfo(display: NativeDisplay): DisplayInfo {
  return {
    displayId: macDisplayId(display.displayNumber),
    bounds: display.bounds,
    scaleFactor: display.scaleFactor,
    isPrimary: display.isPrimary,
  };
}

/**
 * Window-server record → domain window.
 *
 * `scaleFactor` comes from the display rather than the window because
 * `CGWindowListCopyWindowInfo` does not report one; a window has the backing
 * scale of whatever display it is on. When no display is known the scale is 1,
 * which is wrong on Retina but honest — and PR-012 replaces it with the
 * capture stream's real scale before any pixel maths depends on it.
 */
export function toObservedWindow(
  window: NativeWindow,
  displays: readonly NativeDisplay[],
): ObservedWindow {
  const display = displayForWindow(window, displays);
  const title = window.titleAvailable ? (window.title ?? '') : WITHHELD_TITLE;
  return {
    windowId: macWindowId(window.windowNumber),
    displayId: macDisplayId(display?.displayNumber ?? 0),
    title,
    applicationName: window.applicationName,
    ...(window.applicationBundleId === null
      ? {}
      : { applicationBundleId: window.applicationBundleId }),
    bounds: window.bounds,
    scaleFactor: display?.scaleFactor ?? 1,
    isOnScreen: window.isOnScreen,
  };
}

/**
 * Window-server record → geometry for the one geometry module.
 *
 * `captureSize` is the window's size in backing pixels. That is what a
 * full-resolution capture of it would be; PR-012 overrides it with the
 * stream's configured size once the policy downscale is applied, which is why
 * `WindowGeometry` carries `captureSize` separately from `scaleFactor` at all.
 */
export function toWindowGeometry(
  window: NativeWindow,
  displays: readonly NativeDisplay[],
): WindowGeometry {
  const display = displayForWindow(window, displays);
  const scaleFactor = display?.scaleFactor ?? 1;
  return {
    windowId: macWindowId(window.windowNumber),
    displayId: macDisplayId(display?.displayNumber ?? 0),
    bounds: window.bounds,
    scaleFactor,
    captureSize: {
      width: window.bounds.width * scaleFactor,
      height: window.bounds.height * scaleFactor,
    },
  };
}

/**
 * Windows worth offering as an observation target.
 *
 * The window server reports hundreds of surfaces: menu-bar extras, the Dock,
 * tooltips, shadows, the wallpaper. Layer 0 is the normal application layer;
 * a zero-area window has nothing to observe. Both are excluded so the picker
 * shows what a user would call "a window", and so the lifecycle diff is not
 * swamped by churn from surfaces nobody selected.
 */
export function isSelectableWindow(window: NativeWindow): boolean {
  return window.layer === 0 && window.bounds.width > 0 && window.bounds.height > 0;
}
