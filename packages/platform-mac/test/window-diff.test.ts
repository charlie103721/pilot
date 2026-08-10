import { describe, expect, it } from 'vitest';
import { asWindowId } from '@pilot/shared';
import type { WindowEvent } from '@pilot/platform';
import {
  MAC_WINDOW_ID_PREFIX,
  WITHHELD_TITLE,
  changesBetween,
  diffWindowSnapshots,
  isSelectableWindow,
  macDisplayId,
  macWindowId,
  macWindowNumber,
  snapshotContains,
  toObservedWindow,
  toWindowGeometry,
  type NativeDisplay,
  type NativeWindow,
  type WindowSnapshot,
} from '@pilot/platform-mac';

/**
 * Window identity and lifecycle. All pure, all executable here.
 *
 * The id rules in the first block are the ones PR-004's frame ring depends on:
 * `ObservationCore.ingestFrame` drops any frame whose `windowId` is not
 * exactly the selected window's, so an id that drifts stops ingest without
 * raising anything.
 */

const PRIMARY: NativeDisplay = {
  displayNumber: 1,
  bounds: { x: 0, y: 0, width: 1728, height: 1117 },
  scaleFactor: 2,
  isPrimary: true,
};

const SECONDARY: NativeDisplay = {
  displayNumber: 2,
  bounds: { x: -1920, y: -120, width: 1920, height: 1080 },
  scaleFactor: 1,
  isPrimary: false,
};

function nativeWindow(overrides: Partial<NativeWindow> = {}): NativeWindow {
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

function snapshot(
  windows: NativeWindow[],
  overrides: Partial<WindowSnapshot> = {},
): WindowSnapshot {
  return {
    windows,
    displays: [PRIMARY, SECONDARY],
    screenLocked: false,
    titlesWithheld: windows.length > 0 && windows.every((window) => !window.titleAvailable),
    capturedAt: 1_700_000_000_000,
    ...overrides,
  };
}

const typesOf = (events: readonly WindowEvent[]): string[] => events.map((event) => event.type);

describe('window ids', () => {
  it('is a pure function of the CGWindowID', () => {
    expect(macWindowId(42)).toBe(`${MAC_WINDOW_ID_PREFIX}42`);
    expect(macWindowId(42)).toBe(macWindowId(42));
  });

  it('does not change when the window is retitled, moved, resized or hidden', () => {
    // The guarantee PR-012 relies on. Nothing but the CGWindowID feeds the id,
    // so nothing else can perturb it.
    const before = toObservedWindow(nativeWindow(), [PRIMARY]);
    const after = toObservedWindow(
      nativeWindow({
        title: 'Something Else',
        bounds: { x: 900, y: 12, width: 640, height: 480 },
        isOnScreen: false,
        displayNumber: 2,
      }),
      [PRIMARY, SECONDARY],
    );
    expect(after.windowId).toBe(before.windowId);
  });

  it('is derived identically by two independent runs, so a helper restart cannot re-key it', () => {
    // A restart re-enumerates from the same window server. Because the id is
    // computed and never allocated, the new process produces the same string —
    // which is what keeps an in-flight observation ingesting across a crash.
    const first = toObservedWindow(nativeWindow(), [PRIMARY]);
    const second = toObservedWindow(nativeWindow({ title: 'Billing Settings' }), [PRIMARY]);
    expect(second.windowId).toBe(first.windowId);
  });

  it('round-trips back to the CGWindowID', () => {
    expect(macWindowNumber(macWindowId(31_337))).toBe(31_337);
  });

  it('rejects ids that did not come from this platform', () => {
    // `get()` answers `null` for these rather than throwing: another
    // platform's id is not an error, it is simply not a window here.
    expect(macWindowNumber(asWindowId('window-retina'))).toBeNull();
    expect(macWindowNumber(asWindowId('mac-window-'))).toBeNull();
    expect(macWindowNumber(asWindowId('mac-window-1e3'))).toBeNull();
    expect(macWindowNumber(asWindowId('mac-window--1'))).toBeNull();
  });

  it('namespaces display ids the same way', () => {
    expect(macDisplayId(1)).toBe('mac-display-1');
  });
});

describe('mapping to the domain', () => {
  it('carries title, application name and bundle id through', () => {
    const window = toObservedWindow(nativeWindow(), [PRIMARY]);
    expect(window).toMatchObject({
      title: 'Billing Settings',
      applicationName: 'Safari',
      applicationBundleId: 'com.apple.Safari',
      isOnScreen: true,
    });
  });

  it('distinguishes a withheld title from an empty one', () => {
    // Without Screen Recording macOS omits every title. Rendering that as ""
    // would give the user a list of blank rows and no clue why.
    const withheld = toObservedWindow(nativeWindow({ title: null, titleAvailable: false }), [
      PRIMARY,
    ]);
    expect(withheld.title).toBe(WITHHELD_TITLE);

    const empty = toObservedWindow(nativeWindow({ title: '', titleAvailable: true }), [PRIMARY]);
    expect(empty.title).toBe('');
  });

  it('omits the bundle id rather than inventing one', () => {
    const window = toObservedWindow(nativeWindow({ applicationBundleId: null }), [PRIMARY]);
    expect(window.applicationBundleId).toBeUndefined();
  });

  it('takes the scale factor from the display the window is on', () => {
    expect(toObservedWindow(nativeWindow(), [PRIMARY, SECONDARY]).scaleFactor).toBe(2);
    expect(
      toObservedWindow(nativeWindow({ displayNumber: 2 }), [PRIMARY, SECONDARY]).scaleFactor,
    ).toBe(1);
  });

  it('falls back to a scale of 1 when no display is known', () => {
    expect(toObservedWindow(nativeWindow({ displayNumber: null }), []).scaleFactor).toBe(1);
  });

  it('produces geometry whose capture size is the window in backing pixels', () => {
    const geometry = toWindowGeometry(nativeWindow(), [PRIMARY]);
    expect(geometry.bounds).toEqual({ x: 100, y: 80, width: 1200, height: 800 });
    expect(geometry.scaleFactor).toBe(2);
    expect(geometry.captureSize).toEqual({ width: 2400, height: 1600 });
  });

  it('excludes surfaces that are not selectable windows', () => {
    expect(isSelectableWindow(nativeWindow())).toBe(true);
    // Menu-bar extras, the Dock and other chrome sit above layer 0.
    expect(isSelectableWindow(nativeWindow({ layer: 25 }))).toBe(false);
    expect(isSelectableWindow(nativeWindow({ bounds: { x: 0, y: 0, width: 0, height: 0 } }))).toBe(
      false,
    );
  });
});

describe('lifecycle diff', () => {
  it('emits nothing for the first snapshot', () => {
    // A subscriber joining midway must not receive "everything just appeared".
    const diff = diffWindowSnapshots(null, snapshot([nativeWindow()]));
    expect(diff.events).toEqual([]);
    expect(diff.windows).toHaveLength(1);
  });

  it('emits nothing when nothing changed', () => {
    const before = snapshot([nativeWindow()]);
    expect(diffWindowSnapshots(before, snapshot([nativeWindow()])).events).toEqual([]);
  });

  it('reports an appeared window', () => {
    const before = snapshot([nativeWindow()]);
    const after = snapshot([nativeWindow(), nativeWindow({ windowNumber: 77, ownerPid: 502 })]);
    const events = diffWindowSnapshots(before, after).events;

    expect(typesOf(events)).toEqual(['window-list-changed']);
    const [event] = events;
    expect(event?.type === 'window-list-changed' && event.appeared?.[0]?.windowId).toBe(
      macWindowId(77),
    );
  });

  it('reports a closed window, and reports it before anything else', () => {
    // A consumer that stops observation on `window-closed` must have stopped
    // before it hears about whatever replaced the window.
    const before = snapshot([nativeWindow()]);
    const after = snapshot([nativeWindow({ windowNumber: 77, ownerPid: 502 })]);
    const events = diffWindowSnapshots(before, after).events;

    expect(typesOf(events)).toEqual(['window-closed', 'window-list-changed']);
    expect(events[0]?.type === 'window-closed' && events[0].windowId).toBe(macWindowId(42));
  });

  it('reports a retitle', () => {
    const events = diffWindowSnapshots(
      snapshot([nativeWindow()]),
      snapshot([nativeWindow({ title: 'Invoices' })]),
    ).events;

    expect(typesOf(events)).toEqual(['window-changed']);
    const [event] = events;
    expect(event?.type === 'window-changed' && event.changes).toEqual(['title']);
    expect(event?.type === 'window-changed' && event.previous?.title).toBe('Billing Settings');
    expect(event?.type === 'window-changed' && event.window.title).toBe('Invoices');
  });

  it('separates a move from a resize', () => {
    const moved = diffWindowSnapshots(
      snapshot([nativeWindow()]),
      snapshot([nativeWindow({ bounds: { x: 300, y: 200, width: 1200, height: 800 } })]),
    ).events;
    expect(moved[0]?.type === 'window-changed' && moved[0].changes).toEqual(['position']);

    const resized = diffWindowSnapshots(
      snapshot([nativeWindow()]),
      snapshot([nativeWindow({ bounds: { x: 100, y: 80, width: 640, height: 480 } })]),
    ).events;
    expect(resized[0]?.type === 'window-changed' && resized[0].changes).toEqual(['size']);
  });

  it('reports every simultaneous change rather than picking a winner', () => {
    const events = diffWindowSnapshots(
      snapshot([nativeWindow()]),
      snapshot([
        nativeWindow({
          title: 'Invoices',
          bounds: { x: -1500, y: 100, width: 900, height: 600 },
          displayNumber: 2,
          isOnScreen: false,
        }),
      ]),
    ).events;

    const [event] = events;
    expect(event?.type === 'window-changed' && event.changes).toEqual([
      'title',
      'position',
      'size',
      'display',
      'visibility',
    ]);
  });

  it('reports a move between displays', () => {
    const events = diffWindowSnapshots(
      snapshot([nativeWindow()]),
      snapshot([nativeWindow({ displayNumber: 2 })]),
    ).events;
    expect(events[0]?.type === 'window-changed' && events[0].changes).toEqual(['display']);
  });

  it('treats a recycled CGWindowID as a close and an appearance, never a change', () => {
    // The window server may reuse an id once its window is destroyed. Matching
    // on the id alone would turn that into `window-changed` and silently point
    // a live selection at another application's window.
    const before = snapshot([nativeWindow()]);
    const after = snapshot([
      nativeWindow({
        ownerPid: 999,
        applicationName: 'Mail',
        applicationBundleId: 'com.apple.mail',
      }),
    ]);
    const events = diffWindowSnapshots(before, after).events;

    expect(typesOf(events)).toEqual(['window-closed', 'window-list-changed']);
    expect(events[0]?.type === 'window-closed' && events[0].windowId).toBe(macWindowId(42));
    const listChanged = events[1];
    expect(listChanged?.type === 'window-list-changed' && listChanged.appeared?.[0]?.windowId).toBe(
      macWindowId(42),
    );
    expect(events.some((event) => event.type === 'window-changed')).toBe(false);
  });

  it('reports screen lock and unlock', () => {
    const unlocked = snapshot([nativeWindow()]);
    const locked = snapshot([nativeWindow()], { screenLocked: true });

    expect(typesOf(diffWindowSnapshots(unlocked, locked).events)).toEqual(['screen-locked']);
    expect(typesOf(diffWindowSnapshots(locked, unlocked).events)).toEqual(['screen-unlocked']);
  });

  it('reports the lock before any window event in the same tick', () => {
    const events = diffWindowSnapshots(
      snapshot([nativeWindow()]),
      snapshot([], { screenLocked: true }),
    ).events;
    expect(typesOf(events)).toEqual(['screen-locked', 'window-closed', 'window-list-changed']);
  });

  it('ignores non-selectable surfaces entirely', () => {
    // Menu-bar extras churn constantly; if they reached the diff the lifecycle
    // stream would be noise and a real window event would be lost in it.
    const before = snapshot([nativeWindow()]);
    const after = snapshot([nativeWindow(), nativeWindow({ windowNumber: 900, layer: 25 })]);
    expect(diffWindowSnapshots(before, after).events).toEqual([]);
    expect(diffWindowSnapshots(before, after).windows).toHaveLength(1);
  });

  it('coalesces one tick with several appearances and closures', () => {
    const before = snapshot([nativeWindow(), nativeWindow({ windowNumber: 77, ownerPid: 502 })]);
    const after = snapshot([
      nativeWindow({ title: 'Invoices' }),
      nativeWindow({ windowNumber: 88, ownerPid: 503 }),
      nativeWindow({ windowNumber: 89, ownerPid: 503 }),
    ]);
    const events = diffWindowSnapshots(before, after).events;

    expect(typesOf(events)).toEqual(['window-closed', 'window-list-changed', 'window-changed']);
    const listChanged = events[1];
    expect(listChanged?.type === 'window-list-changed' && listChanged.appeared).toHaveLength(2);
    expect(listChanged?.type === 'window-list-changed' && listChanged.disappeared).toEqual([
      macWindowId(77),
    ]);
  });

  it('answers whether a selection survived into a snapshot', () => {
    const current = snapshot([nativeWindow()]);
    expect(snapshotContains(current, macWindowId(42))).toBe(true);
    expect(snapshotContains(current, macWindowId(77))).toBe(false);
    expect(snapshotContains(snapshot([nativeWindow({ layer: 25 })]), macWindowId(42))).toBe(false);
  });
});

describe('changesBetween', () => {
  it('finds nothing between a window and itself', () => {
    const window = toObservedWindow(nativeWindow(), [PRIMARY]);
    expect(changesBetween(window, window)).toEqual([]);
  });
});
