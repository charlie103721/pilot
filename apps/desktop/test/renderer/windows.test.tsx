// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  FakeInteractionController,
  FIXTURE_PERMISSIONS_SCREEN_DENIED,
  FIXTURE_WINDOW_RETINA,
  FIXTURE_WINDOW_SECONDARY,
} from '@pilot/platform/fakes';
import { App } from '../../src/renderer/App.js';
import type { BridgeResult, PilotBridge } from '../../src/ipc/bridge.js';
import {
  interactionDispatchChannel,
  viewStateChangedEvent,
  viewStateGetChannel,
} from '../../src/ipc/channels.js';
import { WINDOW_DEMO_EVENTS, type PermissionFixtureName } from '../../src/ipc/schemas.js';
import { OBSERVATION_INDICATORS } from '../../src/observation/view-model.js';
import { conversationBridge } from './conversation-bridge.js';
import { permissionBridge } from './permission-bridge.js';
import { windowBridge } from './window-bridge.js';

/**
 * The window picker and the observation controls, rendered.
 *
 * Every case drives the panel through the real {@link WindowGate} and the real
 * {@link PermissionGate} over the PR-001 fakes, so what is asserted is what a
 * reviewer sees when they click the same buttons. The privacy-critical cases —
 * blocked, degraded, the selected window closing mid-observation, pause and
 * resume — each have one here.
 */

interface Harness {
  readonly bridge: PilotBridge;
  readonly controller: FakeInteractionController;
  readonly windows: ReturnType<typeof windowBridge>;
  readonly permissions: ReturnType<typeof permissionBridge>;
}

function harness(options: { fixture?: PermissionFixtureName } = {}): Harness {
  const controller = new FakeInteractionController();
  const permissions = permissionBridge({ fixture: options.fixture ?? 'granted' });
  const windows = windowBridge({ controller, permissions: permissions.gate });
  const conversation = conversationBridge({ controller });
  const listeners = new Set<(payload: unknown) => void>();

  controller.subscribe((view) => {
    for (const listener of [...listeners]) {
      listener(view);
    }
  });

  const bridge: PilotBridge = {
    protocolVersion: 1,
    invoke(channelName: string, payload: unknown): Promise<BridgeResult<unknown>> {
      const served =
        permissions.invoke(channelName, payload) ??
        windows.invoke(channelName, payload) ??
        conversation.invoke(channelName, payload);
      if (served !== null) {
        return served;
      }
      switch (channelName) {
        case viewStateGetChannel.name:
          return Promise.resolve({ ok: true, payload: controller.snapshot() });
        case interactionDispatchChannel.name:
          controller.dispatch(payload as never);
          return Promise.resolve({ ok: true, payload: controller.snapshot() });
        default:
          return Promise.resolve({ ok: true, payload: {} });
      }
    },
    subscribe(channelName: string, listener: (payload: unknown) => void): () => void {
      const served =
        permissions.subscribe(channelName, listener) ??
        windows.subscribe(channelName, listener) ??
        conversation.subscribe(channelName, listener);
      if (served !== null) {
        return served;
      }
      if (channelName !== viewStateChangedEvent.name) {
        return () => undefined;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return { bridge, controller, windows, permissions };
}

function connect(bridge: PilotBridge | undefined): void {
  Object.defineProperty(window, 'pilotBridge', {
    value: bridge,
    configurable: true,
    writable: true,
  });
}

async function renderPanel(options: { fixture?: PermissionFixtureName } = {}): Promise<Harness> {
  const test = harness(options);
  connect(test.bridge);
  render(<App />);
  await screen.findByTestId('observation');
  return test;
}

function indicator(): string {
  return screen.getByTestId('observation').getAttribute('data-indicator') ?? '';
}

function capturing(): string {
  return screen.getByTestId('observation').getAttribute('data-capturing') ?? '';
}

function control(id: string): HTMLElement {
  return screen.getByTestId(`observation-${id}`);
}

const RETINA = FIXTURE_WINDOW_RETINA.windowId;
const SECONDARY = FIXTURE_WINDOW_SECONDARY.windowId;

async function selectRetina(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId(`window-select-${RETINA}`)).toBeTruthy());
  await waitFor(() =>
    expect(screen.getByTestId(`window-select-${RETINA}`).hasAttribute('disabled')).toBe(false),
  );
  screen.getByTestId(`window-select-${RETINA}`).click();
  await waitFor(() => expect(screen.getByTestId('observation-summary-title')).toBeTruthy());
}

afterEach(() => {
  cleanup();
  connect(undefined);
});

describe('window picker', () => {
  it('lists the windows Pilot can watch, with enough detail to tell them apart', async () => {
    await renderPanel();

    await waitFor(() => expect(screen.getByTestId(`window-${RETINA}`)).toBeTruthy());
    expect(screen.getByTestId(`window-title-${RETINA}`).textContent).toBe('Billing Settings');
    expect(screen.getByTestId(`window-title-${SECONDARY}`).textContent).toBe('Untitled.txt');
    expect(screen.getByTestId(`window-select-${RETINA}`).textContent).toBe('Watch this window');
  });

  it('summarises the selected window so the user can be sure it is the right one', async () => {
    await renderPanel();
    await selectRetina();

    expect(screen.getByTestId('observation-summary-title').textContent).toBe('Billing Settings');
    expect(screen.getByTestId('observation-summary-app').textContent).toContain('Safari');
    expect(screen.getByTestId('observation-summary-app').textContent).toContain('com.apple.Safari');
    expect(screen.getByTestId('observation-summary-size').textContent).toBe(
      '1200 × 800 at (100, 80)',
    );
    expect(screen.getByTestId(`window-badge-${RETINA}`).textContent).toBe('Selected');
  });

  it('changes the window on a second choice', async () => {
    const test = await renderPanel();
    await selectRetina();

    expect(screen.getByTestId(`window-select-${SECONDARY}`).textContent).toBe(
      'Switch to this window',
    );
    screen.getByTestId(`window-select-${SECONDARY}`).click();

    await waitFor(() =>
      expect(screen.getByTestId('observation-summary-title').textContent).toBe('Untitled.txt'),
    );
    expect(test.controller.snapshot().selectedWindow?.windowId).toBe(SECONDARY);
  });

  it('follows a retitle while the window is selected', async () => {
    await renderPanel();
    await selectRetina();
    screen.getByTestId('observation-start').click();
    await waitFor(() => expect(capturing()).toBe('true'));

    screen.getByTestId('window-demo-retitle-selected').click();

    await waitFor(() =>
      expect(screen.getByTestId('observation-summary-title').textContent).toBe(
        'Billing Settings — Invoice 4172',
      ),
    );
    expect(screen.getByTestId(`window-title-${RETINA}`).textContent).toBe(
      'Billing Settings — Invoice 4172',
    );
    // Retitling is not a reason to stop watching.
    expect(capturing()).toBe('true');
  });
});

describe('the observation indicator', () => {
  it('says nothing is captured before a window is chosen', async () => {
    await renderPanel();

    await waitFor(() => expect(indicator()).toBe('no-window'));
    expect(capturing()).toBe('false');
    expect(screen.getByTestId('observation-capture-state').textContent).toBe('not capturing');
    expect(screen.getByTestId('observation-no-selection')).toBeTruthy();
  });

  it('reaches every declared state through the panel, and only one is capture', async () => {
    const test = await renderPanel({ fixture: 'granted' });
    const seen: string[] = [];

    await waitFor(() => expect(indicator()).toBe('no-window'));
    seen.push(indicator());

    await selectRetina();
    await waitFor(() => expect(indicator()).toBe('stopped'));
    seen.push(indicator());

    screen.getByTestId('observation-start').click();
    await waitFor(() => expect(indicator()).toBe('observing'));
    seen.push(indicator());
    expect(capturing()).toBe('true');

    screen.getByTestId('observation-pause').click();
    await waitFor(() => expect(indicator()).toBe('paused'));
    seen.push(indicator());
    // Paused is not capture, even though observation is still switched on.
    expect(capturing()).toBe('false');
    expect(test.controller.snapshot().observationEnabled).toBe(true);

    screen.getByTestId('observation-resume').click();
    await waitFor(() => expect(indicator()).toBe('observing'));
    expect(capturing()).toBe('true');

    cleanup();

    // The one state that need a different permission fixture.
    await renderPanel({ fixture: 'screen-denied' });
    await waitFor(() => expect(indicator()).toBe('blocked'));
    seen.push(indicator());
    expect(capturing()).toBe('false');

    expect(new Set(seen)).toEqual(
      new Set(OBSERVATION_INDICATORS.filter((entry) => entry !== 'checking')),
    );
  });
});

describe('permissions', () => {
  it('never offers observation while Screen Recording is refused, and says why', async () => {
    await renderPanel({ fixture: 'screen-denied' });

    await waitFor(() => expect(indicator()).toBe('blocked'));
    for (const id of ['start', 'stop', 'change']) {
      expect(control(id).hasAttribute('disabled')).toBe(true);
      expect(screen.getByTestId(`observation-why-${id}`).textContent).toContain(
        'Screen Recording is not allowed',
      );
      // The reason is tied to the control for assistive technology, not merely
      // printed somewhere on the page.
      expect(control(id).getAttribute('aria-describedby')).toBe(`observation-reason-${id}`);
    }
    await waitFor(() =>
      expect(screen.getByTestId(`window-select-${RETINA}`).hasAttribute('disabled')).toBe(true),
    );
    expect(screen.getByTestId(`window-why-${RETINA}`).textContent).toContain('Screen Recording');
  });

  it('still allows selection and observation when only Accessibility is refused', async () => {
    await renderPanel({ fixture: 'accessibility-denied' });

    await waitFor(() => expect(indicator()).toBe('no-window'));
    await selectRetina();
    screen.getByTestId('observation-start').click();

    await waitFor(() => expect(capturing()).toBe('true'));
    // …and the reduced grounding is disclosed rather than glossed over (§16).
    expect(screen.getByTestId('observation-detail').textContent).toContain(
      'Accessibility is not allowed',
    );
    expect(screen.getByTestId('observation-grounding').textContent).toContain('pointer position');
  });

  it('stops watching, visibly, when Screen Recording is withdrawn mid-observation', async () => {
    const test = await renderPanel();
    await selectRetina();
    screen.getByTestId('observation-start').click();
    await waitFor(() => expect(capturing()).toBe('true'));

    // The user switches Screen Recording off in System Settings.
    test.permissions.adapter.setSnapshot(FIXTURE_PERMISSIONS_SCREEN_DENIED);

    await waitFor(() => expect(indicator()).toBe('blocked'));
    expect(capturing()).toBe('false');
    expect(screen.getByTestId('observation-notice').getAttribute('data-reason')).toBe(
      'observation-permission-lost',
    );
  });
});

describe('the selected window closing (system-design §16)', () => {
  it('stops, clears and prompts for a new selection, visibly', async () => {
    const test = await renderPanel();
    await selectRetina();
    screen.getByTestId('observation-start').click();
    await waitFor(() => expect(capturing()).toBe('true'));

    screen.getByTestId('window-demo-close-selected').click();

    await waitFor(() => expect(screen.getByTestId('observation-notice')).toBeTruthy());
    expect(screen.getByTestId('observation-notice-headline').textContent).toBe(
      'Pilot stopped watching',
    );
    expect(screen.getByTestId('observation-notice-message').textContent).toContain(
      'Choose another window',
    );
    expect(indicator()).toBe('no-window');
    expect(capturing()).toBe('false');
    expect(screen.getByTestId('observation-no-selection')).toBeTruthy();
    expect(test.controller.snapshot().observationEnabled).toBe(false);
    // The closed window is gone from the picker, so it cannot be chosen again.
    await waitFor(() => expect(screen.queryByTestId(`window-${RETINA}`)).toBeNull());
  });

  it('lets the user answer the prompt by choosing another window', async () => {
    await renderPanel();
    await selectRetina();
    screen.getByTestId('observation-start').click();
    await waitFor(() => expect(capturing()).toBe('true'));

    screen.getByTestId('window-demo-close-selected').click();
    await waitFor(() => expect(screen.getByTestId('observation-notice')).toBeTruthy());

    screen.getByTestId(`window-select-${SECONDARY}`).click();

    await waitFor(() => expect(screen.queryByTestId('observation-notice')).toBeNull());
    expect(screen.getByTestId('observation-summary-title').textContent).toBe('Untitled.txt');
    // Choosing a window does not silently resume capture.
    expect(indicator()).toBe('stopped');
  });
});

describe('controls', () => {
  it('explains every control it disables', async () => {
    await renderPanel();

    await waitFor(() => expect(indicator()).toBe('no-window'));
    expect(screen.getByTestId('observation-why-start').textContent).toContain('Choose a window');
    expect(screen.getByTestId('observation-why-resume').textContent).toContain('not paused');
    expect(control('pause').hasAttribute('disabled')).toBe(false);
  });

  it('keeps resume reachable while paused, and refuses to change the window', async () => {
    await renderPanel();
    await selectRetina();
    screen.getByTestId('observation-pause').click();

    await waitFor(() => expect(indicator()).toBe('paused'));
    expect(control('resume').hasAttribute('disabled')).toBe(false);
    expect(control('start').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('observation-why-start').textContent).toContain('Pilot is paused');
    expect(screen.getByTestId(`window-select-${SECONDARY}`).hasAttribute('disabled')).toBe(true);

    screen.getByTestId('observation-resume').click();
    await waitFor(() => expect(indicator()).toBe('stopped'));
  });

  it('offers every fake window event a reviewer needs', async () => {
    await renderPanel();

    await waitFor(() => expect(screen.getByTestId('window-demo-bar')).toBeTruthy());
    for (const event of WINDOW_DEMO_EVENTS) {
      expect(screen.getByTestId(`window-demo-${event}`)).toBeTruthy();
    }
  });

  it('reports a refused action instead of dropping it', async () => {
    await renderPanel();

    await waitFor(() => expect(indicator()).toBe('no-window'));
    // Nothing is selected, so the fake event has nothing to act on.
    screen.getByTestId('window-demo-close-selected').click();

    await waitFor(() => expect(screen.getByTestId('observation-transport-error')).toBeTruthy());
    expect(screen.getByTestId('observation-transport-error').textContent).toContain(
      'Choose a window first',
    );
  });
});
