// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { FakeInteractionController, FIXTURE_PERMISSIONS_GRANTED } from '@pilot/platform/fakes';
import { App } from '../../src/renderer/App.js';
import type { BridgeResult, PilotBridge } from '../../src/ipc/bridge.js';
import {
  interactionDispatchChannel,
  viewStateChangedEvent,
  viewStateGetChannel,
} from '../../src/ipc/channels.js';
import { PERMISSION_FIXTURES, type PermissionFixtureName } from '../../src/ipc/schemas.js';
import { conversationBridge } from './conversation-bridge.js';
import { permissionBridge, type PermissionBridgeOptions } from './permission-bridge.js';
import { windowBridge } from './window-bridge.js';

/**
 * Permission onboarding, rendered.
 *
 * Every one of these drives the panel through a real {@link PermissionGate}
 * over the PR-001 fake adapter, so what is asserted is what a reviewer sees
 * when they click the same buttons. The four contract states, the two §16
 * failure modes, the unavailable System Settings shortcut and the
 * denied → granted recovery each have a case here.
 */

interface Harness {
  readonly bridge: PilotBridge;
  readonly permissions: ReturnType<typeof permissionBridge>;
}

function harness(options: PermissionBridgeOptions = {}): Harness {
  const controller = new FakeInteractionController();
  const permissions = permissionBridge(options);
  // The panel now also draws the window picker (PR-009), so the bridge has to
  // serve its channels for the onboarding cases to render at all.
  const windows = windowBridge({ controller, permissions: permissions.gate });
  const conversation = conversationBridge({ controller });
  const listeners = new Set<(payload: unknown) => void>();
  controller.subscribe((view) => {
    for (const listener of listeners) {
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

  return { bridge, permissions };
}

function connect(bridge: PilotBridge | undefined): void {
  Object.defineProperty(window, 'pilotBridge', {
    value: bridge,
    configurable: true,
    writable: true,
  });
}

async function renderPanel(options: PermissionBridgeOptions = {}): Promise<Harness> {
  const test = harness(options);
  connect(test.bridge);
  render(<App />);
  await screen.findByTestId('permission-onboarding');
  return test;
}

function status(kind: string): string {
  return screen.getByTestId(`permission-status-${kind}`).textContent ?? '';
}

function readiness(): string {
  return screen.getByTestId('permission-onboarding').getAttribute('data-readiness') ?? '';
}

afterEach(() => {
  cleanup();
  connect(undefined);
});

describe('permission onboarding', () => {
  it('lists all four permissions with a reason for each', async () => {
    await renderPanel({ fixture: 'unknown' });

    await waitFor(() => expect(readiness()).toBe('blocked'));

    for (const kind of ['screen-recording', 'accessibility', 'microphone', 'speech-recognition']) {
      expect(screen.getByTestId(`permission-${kind}`)).toBeTruthy();
      expect(
        (screen.getByTestId(`permission-why-${kind}`).textContent ?? '').length,
      ).toBeGreaterThan(20);
    }
  });

  it('shows an unrequested permission as not asked for, not as refused', async () => {
    await renderPanel({ fixture: 'unknown' });

    await waitFor(() => expect(status('microphone')).toBe('Not asked for yet'));
    expect(status('microphone')).not.toBe('Refused');
    // …and it offers the prompt, because macOS will still show one.
    expect(screen.getByTestId('permission-request-microphone').textContent).toBe('Allow…');
  });

  it('keeps a check in flight visibly distinct from a denial', async () => {
    const test = await renderPanel({ fixture: 'denied', stallFirstRead: true });

    expect(readiness()).toBe('checking');
    for (const kind of ['screen-recording', 'accessibility', 'microphone']) {
      expect(status(kind)).toBe('Checking…');
      expect(screen.getByTestId(`permission-waiting-${kind}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('permission-settings-screen-recording')).toBeNull();

    test.permissions.releaseFirstRead();

    await waitFor(() => expect(status('screen-recording')).toBe('Refused'));
    expect(readiness()).toBe('blocked');
  });

  it('renders a denial with its consequence and the pane to open', async () => {
    await renderPanel({ fixture: 'denied' });

    await waitFor(() => expect(readiness()).toBe('blocked'));
    expect(status('screen-recording')).toBe('Refused');
    expect(screen.getByTestId('permission-impact-screen-recording').textContent).toContain(
      'Pilot cannot see anything',
    );
    expect(screen.getByTestId('permission-settings-note-screen-recording').textContent).toContain(
      'System Settings › Privacy & Security › Screen Recording',
    );
  });

  it('renders a restricted permission as a different thing from a refusal', async () => {
    await renderPanel({ fixture: 'restricted' });

    await waitFor(() => expect(status('accessibility')).toBe('Not available on this Mac'));
    expect(screen.getByTestId('permission-impact-accessibility').textContent).toContain(
      'manages this Mac',
    );
    // Nothing to click: neither a prompt nor System Settings can move this.
    expect(screen.queryByTestId('permission-request-accessibility')).toBeNull();
    expect(screen.queryByTestId('permission-settings-accessibility')).toBeNull();
  });

  it('renders a fully granted app as ready, with the conversation surface present', async () => {
    await renderPanel({ fixture: 'granted' });

    await waitFor(() => expect(readiness()).toBe('ready'));
    expect(status('screen-recording')).toBe('Allowed');
    expect(screen.queryByTestId('grounding-disclosure')).toBeNull();
    expect(screen.queryByTestId('controls-withheld')).toBeNull();
    expect(screen.getByText('Look now')).toBeTruthy();
  });

  it('withholds the conversation controls while Screen Recording is refused', async () => {
    await renderPanel({ fixture: 'screen-denied' });

    await waitFor(() => expect(readiness()).toBe('blocked'));
    expect(screen.getByTestId('controls-withheld').textContent).toContain('Screen Recording');
    expect(screen.queryByText('Look now')).toBeNull();
  });

  it('treats Accessibility refused as a degraded mode, not a hard stop', async () => {
    await renderPanel({ fixture: 'accessibility-denied' });

    await waitFor(() => expect(readiness()).toBe('degraded'));
    // Pilot still works…
    expect(screen.getByText('Look now')).toBeTruthy();
    expect(screen.queryByTestId('controls-withheld')).toBeNull();
    // …and it discloses the reduced grounding, as system-design §16 requires.
    expect(screen.getByTestId('grounding-disclosure').textContent).toContain('pointer position');
    expect(status('accessibility')).toBe('Refused');
    expect(status('screen-recording')).toBe('Allowed');
  });

  it('recovers from denied to granted with no restart and no remount', async () => {
    const test = await renderPanel({ fixture: 'denied' });
    await waitFor(() => expect(readiness()).toBe('blocked'));
    const node = screen.getByTestId('permission-onboarding');

    // The user allows everything in System Settings. Nothing reloads the panel:
    // the adapter emits, the gate publishes, the open panel follows.
    test.permissions.adapter.setSnapshot(FIXTURE_PERMISSIONS_GRANTED);

    await waitFor(() => expect(readiness()).toBe('ready'));
    for (const kind of ['screen-recording', 'accessibility', 'microphone', 'speech-recognition']) {
      expect(status(kind)).toBe('Allowed');
    }
    expect(screen.getByText('Look now')).toBeTruthy();
    // Same DOM node throughout: the view updated in place rather than the panel
    // being torn down and rebuilt.
    expect(screen.getByTestId('permission-onboarding')).toBe(node);
  });

  it('recovers one permission at a time', async () => {
    const test = await renderPanel({ fixture: 'denied' });
    await waitFor(() => expect(readiness()).toBe('blocked'));

    test.permissions.adapter.set({
      kind: 'screen-recording',
      state: 'granted',
      canRequest: false,
    });
    await waitFor(() => expect(status('screen-recording')).toBe('Allowed'));
    // Screen Recording is back but Accessibility is not: still not "ready", and
    // no longer "blocked" either.
    expect(readiness()).toBe('degraded');
    expect(screen.getByTestId('grounding-disclosure')).toBeTruthy();

    test.permissions.adapter.set({ kind: 'accessibility', state: 'granted', canRequest: false });
    await waitFor(() => expect(readiness()).toBe('limited'));
    expect(screen.queryByTestId('grounding-disclosure')).toBeNull();
  });

  it('grants through the in-app prompt without a reload', async () => {
    await renderPanel({ fixture: 'unknown' });
    await waitFor(() => expect(status('microphone')).toBe('Not asked for yet'));

    screen.getByTestId('permission-request-microphone').click();

    await waitFor(() => expect(status('microphone')).toBe('Allowed'));
  });

  it('offers a disabled, explained System Settings control where it cannot work', async () => {
    await renderPanel({ fixture: 'denied', platform: 'linux' });
    await waitFor(() => expect(readiness()).toBe('blocked'));

    const button = screen.getByTestId('permission-settings-screen-recording');
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('settings-unavailable').textContent).toContain('running on linux');
    expect(button.getAttribute('aria-describedby')).toBe('settings-note-screen-recording');
    expect(screen.getByTestId('permission-settings-note-screen-recording').textContent).toContain(
      'Grant it by hand at',
    );
  });

  it('opens System Settings where it does work', async () => {
    const test = await renderPanel({ fixture: 'denied', platform: 'darwin' });
    await waitFor(() => expect(readiness()).toBe('blocked'));

    const button = screen.getByTestId('permission-settings-accessibility');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByTestId('settings-unavailable')).toBeNull();
    button.click();

    await waitFor(() => expect(test.permissions.adapter.openedSettings).toEqual(['accessibility']));
    expect(screen.queryByTestId('permission-error')).toBeNull();
  });

  it('rechecks on demand rather than making the user restart', async () => {
    const test = await renderPanel({ fixture: 'denied' });
    await waitFor(() => expect(readiness()).toBe('blocked'));

    // A change the platform never announced — macOS TCC does not.
    test.permissions.adapter.snapshot = async () => FIXTURE_PERMISSIONS_GRANTED;
    screen.getByTestId('permission-recheck').click();

    await waitFor(() => expect(readiness()).toBe('ready'));
  });

  it('walks every fixture from the demo bar', async () => {
    await renderPanel({ fixture: 'unknown' });
    await waitFor(() => expect(readiness()).toBe('blocked'));

    const expected: Readonly<Record<PermissionFixtureName, string>> = {
      unknown: 'blocked',
      granted: 'ready',
      denied: 'blocked',
      restricted: 'blocked',
      'screen-denied': 'blocked',
      'accessibility-denied': 'degraded',
      mixed: 'degraded',
    };

    for (const fixture of PERMISSION_FIXTURES) {
      screen.getByTestId(`permission-fixture-${fixture}`).click();
      await waitFor(() => expect(readiness()).toBe(expected[fixture]));
      expect(screen.getByTestId(`permission-fixture-${fixture}`).getAttribute('aria-pressed')).toBe(
        'true',
      );
    }
  });
});
