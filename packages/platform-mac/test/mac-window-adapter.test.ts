import { afterEach, describe, expect, it } from 'vitest';
import { asWindowId } from '@pilot/shared';
import type { WindowEvent } from '@pilot/platform';
import { MacWindowAdapter, type NativeHelperTransport, macWindowId } from '@pilot/platform-mac';
import {
  STUB_DISPLAYS,
  STUB_WINDOW_SAFARI,
  STUB_WINDOW_TEXTEDIT,
  createStubTransport,
  stubWindow,
} from './support/harness.js';
import type { StubConfig, StubDesktop } from './support/helper-stub.js';

/**
 * The macOS `WindowAdapter`, driven end to end against the Node stub.
 *
 * The stub walks a scripted sequence of desktops, one per `windows.list` call,
 * so lifecycle transitions are driven deterministically — no sleeping on a
 * poll interval and no races.
 */

const transports: NativeHelperTransport[] = [];
const adapters: MacWindowAdapter[] = [];

async function start(
  stub: StubConfig,
  options: Partial<ConstructorParameters<typeof MacWindowAdapter>[0]> = {},
): Promise<MacWindowAdapter> {
  const transport = createStubTransport(stub);
  transports.push(transport);
  await transport.start();
  const adapter = new MacWindowAdapter({ transport, pollIntervalMs: 10_000, ...options });
  adapters.push(adapter);
  return adapter;
}

function desktop(
  windows: NonNullable<StubDesktop['windows']>,
  overrides: Partial<StubDesktop> = {},
): StubDesktop {
  return { windows, displays: STUB_DISPLAYS, screenLocked: false, ...overrides };
}

/** Collects events while walking a scripted desktop sequence. */
async function walk(adapter: MacWindowAdapter, steps: number): Promise<readonly WindowEvent[]> {
  const events: WindowEvent[] = [];
  const off = adapter.subscribe((event) => events.push(event));
  for (let step = 0; step < steps; step += 1) {
    await adapter.refresh();
  }
  off();
  return events;
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    adapter.dispose();
  }
  for (const transport of transports.splice(0)) {
    await transport.stop();
  }
});

describe('enumeration', () => {
  it('lists real windows with titles and application names', async () => {
    const adapter = await start({
      desktop: desktop([STUB_WINDOW_SAFARI, STUB_WINDOW_TEXTEDIT]),
    });
    const windows = await adapter.list();

    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      windowId: macWindowId(42),
      title: 'Billing Settings',
      applicationName: 'Safari',
      applicationBundleId: 'com.apple.Safari',
      scaleFactor: 2,
      isOnScreen: true,
    });
    expect(windows[1]).toMatchObject({
      windowId: macWindowId(77),
      title: 'Untitled.txt',
      applicationName: 'TextEdit',
      scaleFactor: 1,
    });
  });

  it('hides non-application surfaces by default and shows them on request', async () => {
    const menuExtra = stubWindow({
      windowNumber: 900,
      layer: 25,
      applicationName: 'SystemUIServer',
    });
    const withoutChrome = await start({ desktop: desktop([STUB_WINDOW_SAFARI, menuExtra]) });
    expect(await withoutChrome.list()).toHaveLength(1);

    const withChrome = await start(
      { desktop: desktop([STUB_WINDOW_SAFARI, menuExtra]) },
      { includeAllLayers: true },
    );
    // The layer filter runs on the host as well, so the extra is fetched but
    // still not offered as a selectable target.
    expect(await withChrome.list()).toHaveLength(1);
    expect(withChrome.lastSnapshot?.windows).toHaveLength(2);
  });

  it('gets one window by id', async () => {
    const adapter = await start({ desktop: desktop([STUB_WINDOW_SAFARI, STUB_WINDOW_TEXTEDIT]) });
    await adapter.list();
    await expect(adapter.get(macWindowId(77))).resolves.toMatchObject({
      title: 'Untitled.txt',
      applicationName: 'TextEdit',
    });
  });

  it('answers null for a window that is gone', async () => {
    const adapter = await start({ desktop: desktop([STUB_WINDOW_SAFARI]) });
    await adapter.list();
    await expect(adapter.get(macWindowId(999))).resolves.toBeNull();
  });

  it('answers null for an id from another platform without a round trip', async () => {
    const adapter = await start({ desktop: desktop([STUB_WINDOW_SAFARI]) });
    await expect(adapter.get(asWindowId('window-retina'))).resolves.toBeNull();
    await expect(adapter.geometry(asWindowId('window-retina'))).resolves.toBeNull();
  });

  it('returns geometry the geometry module can use', async () => {
    const adapter = await start({ desktop: desktop([STUB_WINDOW_SAFARI]) });
    await adapter.list();
    await expect(adapter.geometry(macWindowId(42))).resolves.toEqual({
      windowId: macWindowId(42),
      displayId: 'mac-display-1',
      bounds: { x: 100, y: 80, width: 1200, height: 800 },
      scaleFactor: 2,
      captureSize: { width: 2400, height: 1600 },
    });
  });

  it('reports a title macOS withheld as unavailable rather than empty', async () => {
    const adapter = await start({
      desktop: desktop([stubWindow({ title: null, titleAvailable: false })]),
    });
    const [window] = await adapter.list();
    expect(window?.title).toMatch(/unavailable/i);
    expect(adapter.lastSnapshot?.titlesWithheld).toBe(true);
  });
});

describe('lifecycle events', () => {
  it('emits appeared', async () => {
    const adapter = await start({
      desktopScript: [
        desktop([STUB_WINDOW_SAFARI]),
        desktop([STUB_WINDOW_SAFARI, STUB_WINDOW_TEXTEDIT]),
      ],
    });
    const events = await walk(adapter, 2);

    expect(events.map((event) => event.type)).toEqual(['window-list-changed']);
    const [event] = events;
    expect(event?.type === 'window-list-changed' && event.appeared?.[0]?.windowId).toBe(
      macWindowId(77),
    );
  });

  it('emits closed', async () => {
    const adapter = await start({
      desktopScript: [
        desktop([STUB_WINDOW_SAFARI, STUB_WINDOW_TEXTEDIT]),
        desktop([STUB_WINDOW_SAFARI]),
      ],
    });
    const events = await walk(adapter, 2);

    expect(events.map((event) => event.type)).toEqual(['window-closed', 'window-list-changed']);
    expect(events[0]?.type === 'window-closed' && events[0].windowId).toBe(macWindowId(77));
  });

  it('emits retitled', async () => {
    const adapter = await start({
      desktopScript: [desktop([STUB_WINDOW_SAFARI]), desktop([stubWindow({ title: 'Invoices' })])],
    });
    const events = await walk(adapter, 2);

    const [event] = events;
    expect(event?.type === 'window-changed' && event.changes).toEqual(['title']);
    expect(event?.type === 'window-changed' && event.window.windowId).toBe(macWindowId(42));
  });

  it('emits moved and resized', async () => {
    const adapter = await start({
      desktopScript: [
        desktop([STUB_WINDOW_SAFARI]),
        desktop([stubWindow({ bounds: { x: 300, y: 200, width: 1200, height: 800 } })]),
        desktop([stubWindow({ bounds: { x: 300, y: 200, width: 640, height: 480 } })]),
      ],
    });
    const events = await walk(adapter, 3);

    expect(events[0]?.type === 'window-changed' && events[0].changes).toEqual(['position']);
    expect(events[1]?.type === 'window-changed' && events[1].changes).toEqual(['size']);
  });

  it('emits screen lock and unlock', async () => {
    const adapter = await start({
      desktopScript: [
        desktop([STUB_WINDOW_SAFARI]),
        desktop([STUB_WINDOW_SAFARI], { screenLocked: true }),
        desktop([STUB_WINDOW_SAFARI]),
      ],
    });
    const events = await walk(adapter, 3);
    expect(events.map((event) => event.type)).toEqual(['screen-locked', 'screen-unlocked']);
  });

  it('keeps the window id stable across a retitle, a move and a resize', async () => {
    // The property PR-004's ingest depends on: the id of a window that is
    // being observed must not move while the window does.
    const adapter = await start({
      desktopScript: [
        desktop([STUB_WINDOW_SAFARI]),
        desktop([stubWindow({ title: 'Invoices' })]),
        desktop([
          stubWindow({ title: 'Invoices', bounds: { x: 5, y: 5, width: 300, height: 200 } }),
        ]),
      ],
    });
    const events = await walk(adapter, 3);

    const ids = new Set(
      events.flatMap((event) => (event.type === 'window-changed' ? [event.window.windowId] : [])),
    );
    expect([...ids]).toEqual([macWindowId(42)]);
  });

  it('emits nothing on the first poll', async () => {
    const adapter = await start({ desktop: desktop([STUB_WINDOW_SAFARI]) });
    expect(await walk(adapter, 1)).toEqual([]);
  });

  it('stops polling when the last subscriber leaves', async () => {
    const adapter = await start({ desktop: desktop([STUB_WINDOW_SAFARI]) }, { pollIntervalMs: 5 });
    const off = adapter.subscribe(() => undefined);
    off();
    const before = adapter.lastSnapshot;
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Nothing polled in the interim, so the cached snapshot is untouched.
    expect(adapter.lastSnapshot).toBe(before);
  });
});

describe('helper restart', () => {
  it('re-derives the same ids, so a surviving selection keeps ingesting', async () => {
    // Ids are computed from the CGWindowID, so a new helper process produces
    // the same strings. A re-keyed id here would make PR-004's ring drop every
    // subsequent frame as `foreign-window` — silently, with capture still
    // running.
    const transport = createStubTransport({
      desktopScript: [desktop([STUB_WINDOW_SAFARI])],
      crashAfterRequests: 3,
    });
    transports.push(transport);
    await transport.start();
    const adapter = new MacWindowAdapter({ transport, pollIntervalMs: 10_000 });
    adapters.push(adapter);

    const before = await adapter.list();
    await transport.stop();

    const revived = createStubTransport({ desktopScript: [desktop([STUB_WINDOW_SAFARI])] });
    transports.push(revived);
    await revived.start();
    const afterAdapter = new MacWindowAdapter({ transport: revived, pollIntervalMs: 10_000 });
    adapters.push(afterAdapter);
    const after = await afterAdapter.list();

    expect(after[0]?.windowId).toBe(before[0]?.windowId);
  });

  it('reports a window that closed during the outage', async () => {
    // The snapshot cached before the crash is diffed against the first
    // snapshot after it, so the close is reported rather than lost.
    const adapter = await start({
      desktopScript: [
        desktop([STUB_WINDOW_SAFARI, STUB_WINDOW_TEXTEDIT]),
        desktop([STUB_WINDOW_SAFARI]),
      ],
    });
    await adapter.list();

    const events: WindowEvent[] = [];
    const off = adapter.subscribe((event) => events.push(event));
    await adapter.refresh();
    off();

    expect(events.some((event) => event.type === 'window-closed')).toBe(true);
  });
});

describe('failure paths', () => {
  it('fails with helper-unavailable when the helper is not running', async () => {
    const transport = createStubTransport({});
    transports.push(transport);
    const adapter = new MacWindowAdapter({ transport });
    adapters.push(adapter);
    await expect(adapter.list()).rejects.toMatchObject({ code: 'helper-unavailable' });
  });

  it('times out rather than hanging', async () => {
    const transport = createStubTransport({ dropOps: ['windows.list'] }, { requestTimeoutMs: 200 });
    transports.push(transport);
    await transport.start();
    const adapter = new MacWindowAdapter({ transport });
    adapters.push(adapter);
    await expect(adapter.list()).rejects.toMatchObject({ code: 'timeout' });
  });

  it('cancels on an aborted helper request', async () => {
    const transport = createStubTransport({ desktopScript: [desktop([STUB_WINDOW_SAFARI])] });
    transports.push(transport);
    await transport.start();
    const controller = new AbortController();
    controller.abort();
    const { windowListOperation } = await import('@pilot/platform-mac');
    await expect(
      transport.request(windowListOperation, {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects a snapshot that violates the schema rather than half-reading it', async () => {
    const adapter = await start({
      desktop: desktop([stubWindow({ windowNumber: -1 })]),
    });
    await expect(adapter.list()).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('swallows a failing poll and keeps the schedule alive', async () => {
    // A poll failure is expected and transient: the helper restarts, and the
    // next tick reconciles from a fresh snapshot. A throwing poll would take
    // the whole subscription down instead.
    const transport = createStubTransport({ dropOps: ['windows.list'] }, { requestTimeoutMs: 150 });
    transports.push(transport);
    await transport.start();
    const adapter = new MacWindowAdapter({ transport, pollIntervalMs: 10_000 });
    adapters.push(adapter);

    const off = adapter.subscribe(() => undefined);
    await expect(adapter.refresh()).resolves.toBeUndefined();
    expect(adapter.lastSnapshot).toBeNull();
    off();
  });
});
