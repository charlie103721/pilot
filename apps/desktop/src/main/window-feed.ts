import { PilotError, type ObservedWindow, type WindowId } from '@pilot/shared';
import type { PilotViewState } from '@pilot/platform';
import type { FakeInteractionController, FakeWindowAdapter } from '@pilot/platform/fakes';
import { FIXTURE_GEOMETRY_BY_WINDOW, FIXTURE_WINDOWS } from '@pilot/platform/fakes';
import type { WindowDemoEvent } from '../ipc/schemas.js';
import type { ObservationInteraction, WindowFeedEvent } from './window-gate.js';

/**
 * The fake half of the window-picker wiring.
 *
 * Two things live here, both temporary by design:
 *
 *  1. {@link createFakeObservationInteraction} — the {@link ObservationInteraction}
 *     port over the PR-001 fake controller. The fake controller has no event
 *     input, so the two window events are applied to its view state directly.
 *     The patches below are the ones `@pilot/interaction`'s transition table
 *     applies for `windows-changed` and `window-closed`; PR-029 deletes this
 *     file and passes `(event) => controller.send(event)` instead.
 *  2. {@link createFakeWindowDemoDriver} — the runtime controls that let a
 *     reviewer close or retitle the selected window without editing source.
 *     PR-011's real enumeration cannot be exercised on Linux (runbook §5
 *     amendment 8), and the §16 behaviour is exactly what needs demonstrating.
 */

/**
 * `@pilot/interaction`'s `window-closed` row, reproduced against the fake:
 * stop, clear the selection, and say why (mvp-01 §7 recoverable failure,
 * system-design §16).
 */
export function windowClosedError(windowId: WindowId): PilotError {
  return new PilotError('window-closed', 'The selected window closed', {
    userMessage: 'The window Pilot was watching closed. Choose another window.',
    details: { windowId },
  });
}

export function createFakeObservationInteraction(
  controller: FakeInteractionController,
): ObservationInteraction {
  return {
    snapshot: () => controller.snapshot(),
    subscribe: controller.subscribe,
    dispatch: (command) => controller.dispatch(command),
    report: (event: WindowFeedEvent) => {
      switch (event.type) {
        case 'windows-changed': {
          const selected = controller.snapshot().selectedWindow;
          if (selected === null) {
            return;
          }
          // A window still in the list is replaced by its current form, so a
          // retitle reaches the summary. One that has left the list is kept
          // until `window-closed` arrives, exactly as the real table does.
          const fresh = event.windows.find((entry) => entry.windowId === selected.windowId);
          if (fresh !== undefined && fresh !== selected) {
            controller.set({ selectedWindow: fresh });
          }
          return;
        }
        case 'window-closed': {
          const patch: Partial<PilotViewState> = {
            state: 'error',
            selectedWindow: null,
            observationEnabled: false,
            speaking: false,
            liveTranscript: null,
            lastError: windowClosedError(event.windowId).toJSON(),
          };
          controller.set(patch);
          return;
        }
      }
    },
  };
}

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
