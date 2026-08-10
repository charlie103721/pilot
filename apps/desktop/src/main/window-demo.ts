import { PilotError, type ObservedWindow } from '@pilot/shared';
import type { FakeWindowAdapter } from '@pilot/platform/fakes';
import { FIXTURE_GEOMETRY_BY_WINDOW, FIXTURE_WINDOWS } from '@pilot/platform/fakes';
import type { WindowDemoEvent } from '../ipc/schemas.js';

/**
 * Runtime controls for the *fake* window adapter.
 *
 * This is the surviving half of PR-009's `main/window-feed.ts`. The other half
 * — an `ObservationInteraction` port that reproduced `@pilot/interaction`'s
 * `windows-changed` and `window-closed` rows against the fake controller — was
 * deleted by PR-029 (runbook follow-up 10): with the real controller in place
 * the port is `(event) => controller.send(event)` and the §16 behaviour lives
 * only in the transition table.
 *
 * What is left is the reviewer's ability to close or retitle the selected
 * window without editing source. PR-011's real enumeration cannot run on Linux
 * (runbook §5 amendment 8) and §16's behaviour is exactly what needs
 * demonstrating, so these stay until PR-028 puts a real window adapter behind
 * the shell.
 */

/**
 * Asynchronous because restoring the fixture list has to read the current one
 * first: a caller that wants the settled result — the IPC handler does — can
 * await it before re-listing.
 */
export type WindowDemoDriver = (event: WindowDemoEvent) => Promise<void>;

const DEMO_TITLES: readonly string[] = [
  'Billing Settings — Invoice 4172',
  'Billing Settings — Payment methods',
  'Billing Settings',
];

/**
 * Drives the fake window adapter from the panel.
 *
 * Every event needs a selected window except `restore-windows`, and asking for
 * one without a selection is refused with a typed reason rather than quietly
 * doing nothing.
 */
export function createFakeWindowDemoDriver(options: {
  readonly adapter: FakeWindowAdapter;
  readonly selected: () => ObservedWindow | null;
}): WindowDemoDriver {
  let titleIndex = 0;

  const requireSelection = (event: WindowDemoEvent): ObservedWindow => {
    const selected = options.selected();
    if (selected === null) {
      throw new PilotError('window-not-found', 'No window is selected', {
        userMessage: 'Choose a window first — this control acts on the selected window.',
        details: { event },
      });
    }
    return selected;
  };

  return async (event: WindowDemoEvent): Promise<void> => {
    switch (event) {
      case 'close-selected': {
        options.adapter.closeWindow(requireSelection(event).windowId);
        return;
      }
      case 'retitle-selected': {
        const title = DEMO_TITLES[titleIndex % DEMO_TITLES.length] ?? DEMO_TITLES[0] ?? '';
        titleIndex += 1;
        options.adapter.changeWindow(requireSelection(event).windowId, { title }, ['title']);
        return;
      }
      case 'hide-selected': {
        options.adapter.changeWindow(requireSelection(event).windowId, { isOnScreen: false }, [
          'visibility',
        ]);
        return;
      }
      case 'restore-windows': {
        await restoreFixtureWindows(options.adapter);
        return;
      }
    }
  };
}

/**
 * Puts the fake adapter back to the fixture list — re-opening anything the demo
 * closed and undoing any retitle — so the walkthrough can be run again without
 * restarting the app.
 */
export async function restoreFixtureWindows(adapter: FakeWindowAdapter): Promise<void> {
  const present = await adapter.list();
  for (const window of FIXTURE_WINDOWS) {
    const current = present.find((entry) => entry.windowId === window.windowId);
    if (current === undefined) {
      const geometry = FIXTURE_GEOMETRY_BY_WINDOW.get(window.windowId);
      // `openWindow` emits `window-list-changed` with `appeared`; `replaceWindow`
      // emits `window-changed`. Both are PR-011 controls — neither is new here.
      if (geometry === undefined) {
        adapter.openWindow(window);
      } else {
        adapter.openWindow(window, geometry);
      }
    } else if (
      current.title !== window.title ||
      current.isOnScreen !== window.isOnScreen ||
      current.applicationName !== window.applicationName
    ) {
      adapter.replaceWindow(window);
    }
  }
}
