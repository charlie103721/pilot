import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeWindowAdapter,
  FIXTURE_PERMISSIONS_GRANTED,
  FIXTURE_PERMISSIONS_ACCESSIBILITY_DENIED,
  FIXTURE_PERMISSIONS_SCREEN_DENIED,
  FIXTURE_WINDOWS,
  FIXTURE_WINDOW_RETINA,
  FIXTURE_WINDOW_SECONDARY,
} from '@pilot/platform/fakes';
import type { WindowGateState } from '../../src/ipc/schemas.js';
import { permissionHarness, windowHarness, type WindowHarness } from './support.js';
import type { PermissionHarness } from './support.js';

/**
 * The main-process owner of the window list and the observation controls.
 *
 * These drive the real {@link WindowGate} over the PR-001 fakes, wired the way
 * `main/index.ts` wires it. The cases that matter are the ones that must hold
 * whether or not the panel is open: the selected window closing (system-design
 * §16), Screen Recording being withdrawn mid-observation (§6), and a renderer
 * that asks for something permissions forbid (§14).
 */

interface Harness extends WindowHarness {
  readonly permissions: PermissionHarness;
}

async function harness(
  options: { fixture?: 'granted' | 'screen-denied'; adapter?: FakeWindowAdapter } = {},
): Promise<Harness> {
  const permissions = permissionHarness({
    fixture: options.fixture ?? 'granted',
    now: () => 1_700_000_000_000,
  });
  await permissions.gate.refresh();
  const windows = windowHarness({
    permissions: permissions.gate,
    ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
    now: () => 1_700_000_000_000,
  });
  await windows.gate.refresh();
  return { ...windows, permissions };
}

/**
 * Lets the gate's own re-listing settle. Window events arrive synchronously
 * from the adapter; re-reading the list is a promise, so the assertions that
 * are about the *list* wait a turn. The assertions that are about stopping
 * observation deliberately do not — that has to be immediate.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let test: Harness;

beforeEach(async () => {
  test = await harness();
});

describe('the window list', () => {
  it('is unread until it has been read', () => {
    const fresh = windowHarness({ permissions: permissionHarness().gate });
    const before: WindowGateState = fresh.gate.snapshot();

    expect(before.listedAt).toBeNull();
    expect(before.windows).toEqual([]);
  });

  it('reads the platform list and reports when', () => {
    const state = test.gate.snapshot();

    expect(state.windows).toEqual(FIXTURE_WINDOWS);
    expect(state.listedAt).toBe(1_700_000_000_000);
    expect(state.listing).toBe(false);
  });

  it('follows a window opening and closing without being asked', async () => {
    const seen: number[] = [];
    test.gate.subscribe((state) => seen.push(state.windows.length));

    test.adapter.closeWindow(FIXTURE_WINDOW_SECONDARY.windowId);
    await flush();

    expect(seen.at(-1)).toBe(1);
    expect(test.gate.snapshot().windows).toEqual([FIXTURE_WINDOW_RETINA]);
  });

  it('follows a retitle in place, so the picker never shows a stale title', () => {
    test.adapter.changeWindow(
      FIXTURE_WINDOW_RETINA.windowId,
      { title: 'Billing Settings — Invoice 4172' },
      ['title'],
    );

    expect(test.gate.snapshot().windows[0]?.title).toBe('Billing Settings — Invoice 4172');
  });
});

describe('selection', () => {
  it('selects a listed window and tells the controller', async () => {
    await test.gate.act({ type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId });

    expect(test.commands).toEqual([
      { type: 'select-window', windowId: FIXTURE_WINDOW_RETINA.windowId },
    ]);
    expect(test.controller.snapshot().selectedWindow).toEqual(FIXTURE_WINDOW_RETINA);
    expect(test.gate.snapshot().lastError).toBeNull();
  });

  it('refuses a window that is no longer listed instead of pretending', async () => {
    test.adapter.closeWindow(FIXTURE_WINDOW_SECONDARY.windowId);
    await flush();

    const state = await test.gate.act({
      type: 'select',
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
    });

    expect(state.lastError?.code).toBe('window-not-found');
    expect(state.lastError?.userMessage).toContain('no longer open');
    expect(test.commands).toEqual([]);
  });

  it('refuses a window that is not on screen', async () => {
    test.adapter.changeWindow(FIXTURE_WINDOW_SECONDARY.windowId, { isOnScreen: false }, [
      'visibility',
    ]);

    const state = await test.gate.act({
      type: 'select',
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
    });

    expect(state.lastError?.code).toBe('window-not-found');
    expect(state.lastError?.userMessage).toContain('minimised or hidden');
  });

  it('changes the observed window to another one', async () => {
    await test.gate.act({ type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId });
    await test.gate.act({ type: 'select', windowId: FIXTURE_WINDOW_SECONDARY.windowId });

    expect(test.controller.snapshot().selectedWindow).toEqual(FIXTURE_WINDOW_SECONDARY);
  });
});

describe('start, stop, pause and resume', () => {
  beforeEach(async () => {
    await test.gate.act({ type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId });
  });

  it('starts and stops observation', async () => {
    await test.gate.act({ type: 'start' });
    expect(test.controller.snapshot().observationEnabled).toBe(true);

    await test.gate.act({ type: 'stop' });
    expect(test.controller.snapshot().observationEnabled).toBe(false);
  });

  it('pauses and resumes, and never refuses the way out of paused', async () => {
    await test.gate.act({ type: 'start' });
    await test.gate.act({ type: 'pause' });
    expect(test.controller.snapshot().state).toBe('paused');

    // While paused, changing what Pilot watches is refused — the interaction
    // table denies those commands in that state, so offering them would lie.
    const refused = await test.gate.act({ type: 'stop' });
    expect(refused.lastError?.code).toBe('observation-paused');

    const resumed = await test.gate.act({ type: 'resume' });
    expect(resumed.lastError).toBeNull();
    expect(test.controller.snapshot().state).not.toBe('paused');
    expect(test.controller.snapshot().observationEnabled).toBe(true);
  });

  it('refuses to pause twice or resume when not paused', async () => {
    expect((await test.gate.act({ type: 'resume' })).lastError?.userMessage).toContain(
      'not paused',
    );
    await test.gate.act({ type: 'pause' });
    expect((await test.gate.act({ type: 'pause' })).lastError?.userMessage).toContain(
      'already paused',
    );
  });

  it('refuses to start with nothing selected', async () => {
    const empty = await harness();
    const state = await empty.gate.act({ type: 'start' });

    expect(state.lastError?.code).toBe('window-not-found');
    expect(state.lastError?.userMessage).toContain('Choose a window');
    expect(empty.controller.snapshot().observationEnabled).toBe(false);
  });
});

describe('permissions gate the main process too, not only the panel', () => {
  it('refuses selection and start while Screen Recording is refused', async () => {
    const blocked = await harness({ fixture: 'screen-denied' });

    expect(blocked.gate.allowsObservation()).toBe(false);
    const selected = await blocked.gate.act({
      type: 'select',
      windowId: FIXTURE_WINDOW_RETINA.windowId,
    });
    expect(selected.lastError?.code).toBe('permission-denied');
    expect(blocked.commands).toEqual([]);
  });

  it('allows selection when only Accessibility is refused', async () => {
    const degraded = await harness();
    degraded.permissions.adapter.set({ kind: 'accessibility', state: 'denied', canRequest: false });

    expect(degraded.gate.allowsObservation()).toBe(true);
    await degraded.gate.act({ type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId });
    await degraded.gate.act({ type: 'start' });

    expect(degraded.controller.snapshot().observationEnabled).toBe(true);
  });

  it('stops observing when Screen Recording is withdrawn mid-observation', async () => {
    await test.gate.act({ type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId });
    await test.gate.act({ type: 'start' });
    expect(test.controller.snapshot().observationEnabled).toBe(true);

    test.permissions.adapter.setSnapshot(FIXTURE_PERMISSIONS_SCREEN_DENIED);

    expect(test.controller.snapshot().observationEnabled).toBe(false);
    const notice = test.gate.snapshot().notice;
    expect(notice?.reason).toBe('observation-permission-lost');
    expect(notice?.wasObserving).toBe(true);
  });

  it('does not mistake a permission being re-read for one withdrawn', async () => {
    // PR-040. `PermissionGate.refresh()` marks every kind pending and publishes
    // *before* it asks the platform, and `permissionsAllowObservation` answers
    // `false` for `readiness: 'checking'` — so the gate used to stop an
    // observation that was running and tell the user Screen Recording had been
    // withdrawn, every time anything refreshed. `DesktopShell.reveal()`
    // refreshes on every panel open, which is exactly when someone who had just
    // been to System Settings comes back.
    await test.gate.act({ type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId });
    await test.gate.act({ type: 'start' });

    await test.permissions.gate.refresh();

    expect(test.controller.snapshot().observationEnabled).toBe(true);
    expect(test.gate.snapshot().notice).toBeNull();
  });

  it('does not raise a notice when nothing was at stake', async () => {
    test.permissions.adapter.setSnapshot(FIXTURE_PERMISSIONS_SCREEN_DENIED);

    expect(test.gate.snapshot().notice).toBeNull();
  });

  /**
   * PR-044, system-design §16. `permissionsAllowObservation` has always
   * answered `true` for Accessibility denied — `degrades`, not `blocks` — so
   * this gate needs no change. It is asserted anyway, because the gate is one
   * of the four callers `REQUIRED_PERMISSIONS`' narrowing had to be checked
   * against, and "no change was needed" is only worth anything if something
   * fails when it stops being true.
   */
  it('keeps watching when Accessibility alone is withdrawn', async () => {
    await test.gate.act({ type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId });
    await test.gate.act({ type: 'start' });

    test.permissions.adapter.setSnapshot(FIXTURE_PERMISSIONS_ACCESSIBILITY_DENIED);

    expect(test.gate.allowsObservation()).toBe(true);
    expect(test.controller.snapshot().observationEnabled).toBe(true);
    // No "Pilot stopped watching, choose another window" prompt: it did not.
    expect(test.gate.snapshot().notice).toBeNull();
  });
});

describe('the selected window closing (system-design §16)', () => {
  beforeEach(async () => {
    await test.gate.act({ type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId });
    await test.gate.act({ type: 'start' });
  });

  it('stops observation, clears the selection and prompts for a new one', async () => {
    test.adapter.closeWindow(FIXTURE_WINDOW_RETINA.windowId);

    const view = test.controller.snapshot();
    expect(view.observationEnabled).toBe(false);
    expect(view.selectedWindow).toBeNull();
    expect(view.lastError?.code).toBe('window-closed');
    // The exact sentence `@pilot/interaction`'s `window-closed` row writes.
    // PR-029 deleted PR-009's copy of that row, so this is the only place it is
    // stated outside the table itself.
    expect(view.lastError?.userMessage).toBe(
      'The window Pilot was watching closed. Choose another window.',
    );

    const notice = test.gate.snapshot().notice;
    expect(notice?.reason).toBe('selected-window-closed');
    expect(notice?.window).toEqual(FIXTURE_WINDOW_RETINA);
    // Recorded as it was *before* the controller cleared everything, so the
    // prompt can say whether the screen had actually been captured.
    expect(notice?.wasObserving).toBe(true);

    await flush();
    expect(test.gate.snapshot().windows).toEqual([FIXTURE_WINDOW_SECONDARY]);
  });

  it('says nothing when a window Pilot was not watching closes', () => {
    test.adapter.closeWindow(FIXTURE_WINDOW_SECONDARY.windowId);

    expect(test.gate.snapshot().notice).toBeNull();
    expect(test.controller.snapshot().selectedWindow).toEqual(FIXTURE_WINDOW_RETINA);
    expect(test.controller.snapshot().observationEnabled).toBe(true);
  });

  it('notices a window that vanishes from the list without a close event', async () => {
    const adapter = new FakeWindowAdapter();
    const quiet = await harness({ adapter });
    await quiet.gate.act({ type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId });
    await quiet.gate.act({ type: 'start' });

    // A list that simply no longer holds it: no `window-closed` was emitted.
    adapter.list = async () => [FIXTURE_WINDOW_SECONDARY];
    await quiet.gate.refresh();

    expect(quiet.gate.snapshot().notice?.reason).toBe('selected-window-closed');
    expect(quiet.controller.snapshot().selectedWindow).toBeNull();
    expect(quiet.controller.snapshot().observationEnabled).toBe(false);
  });

  it('clears the prompt when the user picks another window', async () => {
    test.adapter.closeWindow(FIXTURE_WINDOW_RETINA.windowId);
    expect(test.gate.snapshot().notice).not.toBeNull();

    await test.gate.act({ type: 'select', windowId: FIXTURE_WINDOW_SECONDARY.windowId });

    expect(test.gate.snapshot().notice).toBeNull();
    expect(test.controller.snapshot().selectedWindow).toEqual(FIXTURE_WINDOW_SECONDARY);
  });

  it('lets the prompt be dismissed without choosing anything', async () => {
    test.adapter.closeWindow(FIXTURE_WINDOW_RETINA.windowId);

    const state = await test.gate.act({ type: 'dismiss-notice' });

    expect(state.notice).toBeNull();
    expect(test.controller.snapshot().selectedWindow).toBeNull();
  });
});

describe('the fake window-event controls', () => {
  it('closes, retitles, hides and restores the selected window', async () => {
    await test.gate.act({ type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId });

    await test.demo('retitle-selected');
    expect(test.controller.snapshot().selectedWindow?.title).toBe(
      'Billing Settings — Invoice 4172',
    );

    await test.demo('hide-selected');
    expect(test.controller.snapshot().selectedWindow?.isOnScreen).toBe(false);

    await test.demo('close-selected');
    expect(test.controller.snapshot().selectedWindow).toBeNull();
    await flush();
    expect(test.gate.snapshot().windows).toEqual([FIXTURE_WINDOW_SECONDARY]);

    await test.demo('restore-windows');
    await test.gate.refresh();
    expect(
      test.gate
        .snapshot()
        .windows.map((window) => window.windowId)
        .sort(),
    ).toEqual(FIXTURE_WINDOWS.map((window) => window.windowId).sort());
  });

  it('refuses an event that needs a selection when there is none', async () => {
    await expect(test.demo('close-selected')).rejects.toThrow(/No window is selected/);
  });
});

describe('reporting a fully granted, watching Pilot over the wire', () => {
  it('carries no image bytes and no secrets', async () => {
    await test.gate.act({ type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId });
    await test.gate.act({ type: 'start' });

    const state = test.gate.snapshot();
    expect(Object.keys(state).sort()).toEqual([
      'demoEvents',
      'lastError',
      'listedAt',
      'listing',
      'notice',
      'windows',
    ]);
    expect(JSON.stringify(state)).not.toContain('bytes');
  });

  it('refuses to work after disposal rather than silently doing nothing', async () => {
    test.gate.dispose();
    await expect(test.gate.act({ type: 'refresh' })).rejects.toThrow(/disposed/);
  });

  it('is unaffected by permissions it does not need', async () => {
    const state = await harness();
    state.permissions.adapter.setSnapshot(FIXTURE_PERMISSIONS_GRANTED);
    expect(state.gate.allowsObservation()).toBe(true);
  });
});

/**
 * Runbook follow-up 11, closed by PR-029. PR-009 logged these two events and
 * acted on neither, because the fake controller had no event input and
 * duplicating the table's rows in the shell was the wrong fix.
 */
describe('the screen locking (system-design §6, §14)', () => {
  it('stops capture and clears the buffers, and resumes on unlock', async () => {
    await test.gate.act({ type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId });
    expect(test.controller.snapshot().state).toBe('observing');
    const before = test.observation.calls.length;

    test.adapter.lockScreen();
    // Effects are performed on the controller's queue, so the calls land a tick
    // after the transition does.
    await test.controller.settled();

    // Nothing may be captured while the screen is locked, whatever else is true.
    expect(test.controller.snapshot().state).toBe('paused');
    expect(test.observation.calls.slice(before)).toContain('stop');
    expect(test.observation.calls.slice(before)).toContain('clear');
    // The selection survives: the user has not changed what Pilot watches.
    expect(test.controller.snapshot().selectedWindow).toEqual(FIXTURE_WINDOW_RETINA);
    // A lock is not an error.
    expect(test.controller.snapshot().lastError).toBeNull();

    test.adapter.unlockScreen();
    await test.controller.settled();

    expect(test.controller.snapshot().state).toBe('observing');
    expect(test.observation.calls.at(-1)).toBe('start');
  });

  it('ignores a second lock rather than clearing twice', async () => {
    await test.gate.act({ type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId });
    test.adapter.lockScreen();
    await test.controller.settled();
    const after = test.observation.calls.length;

    test.adapter.lockScreen();
    await test.controller.settled();

    expect(test.observation.calls).toHaveLength(after);
    expect(test.controller.snapshot().state).toBe('paused');
  });
});
