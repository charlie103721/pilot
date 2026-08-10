import { describe, expect, it } from 'vitest';
import {
  asRequestId,
  createCounterIdSource,
  createIdFactory,
  IPC_PROTOCOL_VERSION,
  parseEventEnvelope,
  type RequestEnvelope,
  type ResponseEnvelope,
} from '@pilot/shared';
import { FakeInteractionController, FIXTURE_WINDOW_RETINA } from '@pilot/platform/fakes';
import {
  appInfoChannel,
  demoScenarioChannel,
  interactionDispatchChannel,
  panelSetVisibleChannel,
  quitChannel,
  viewStateChangedEvent,
  viewStateGetChannel,
} from '../../src/ipc/channels.js';
import { createFakeScenarioDriver, DEMO_FAILURE } from '../../src/main/scenarios.js';
import { DesktopShell } from '../../src/main/shell.js';
import { FakePanelHost, FakeTrayHost } from './support.js';

/**
 * The composed shell.
 *
 * These tests drive the whole main-process surface the way the renderer and the
 * menu bar do — through validated envelopes and tray selections — with Electron
 * replaced by the in-memory ports.
 */

function shell(options: { withScenarioDriver?: boolean; trayFailure?: Error } = {}) {
  const panelHost = new FakePanelHost();
  const trayHost = new FakeTrayHost();
  if (options.trayFailure !== undefined) {
    trayHost.failure = options.trayFailure;
  }
  const controller = new FakeInteractionController();
  const quits: number[] = [];

  const instance = new DesktopShell({
    panelHost,
    trayHost,
    controller,
    appInfo: { version: '9.9.9', platform: 'linux' },
    quit: () => quits.push(1),
    ids: createIdFactory(createCounterIdSource()),
    now: () => 1_700_000_000_000,
    ...(options.withScenarioDriver === false
      ? {}
      : { scenarioDriver: createFakeScenarioDriver(controller) }),
  });

  return { instance, panelHost, trayHost, controller, quits };
}

let sequence = 0;
function request(channel: string, payload: unknown): RequestEnvelope {
  sequence += 1;
  return {
    kind: 'request',
    protocolVersion: IPC_PROTOCOL_VERSION,
    id: asRequestId(`req-${String(sequence).padStart(6, '0')}`),
    channel,
    issuedAt: 1,
    payload,
  };
}

function successPayload(response: ResponseEnvelope): unknown {
  if (!response.ok) {
    throw new Error(`expected success, got ${response.error.code}`);
  }
  return response.payload;
}

describe('DesktopShell', () => {
  it('answers app info without leaking anything privileged', async () => {
    const { instance } = shell();

    const payload = successPayload(
      await instance.router.handle(request(appInfoChannel.name, {}), { senderId: 1 }),
    );

    expect(payload).toEqual({
      version: '9.9.9',
      protocolVersion: IPC_PROTOCOL_VERSION,
      platform: 'linux',
      usesRealPlatform: false,
    });
  });

  it('serves the current view state to the renderer', async () => {
    const { instance, controller } = shell();

    const payload = successPayload(
      await instance.router.handle(request(viewStateGetChannel.name, {}), { senderId: 1 }),
    );

    expect(payload).toEqual(controller.snapshot());
  });

  it('dispatches a validated interaction command to the controller', async () => {
    const { instance, controller } = shell();

    const payload = successPayload(
      await instance.router.handle(
        request(interactionDispatchChannel.name, { type: 'push-to-talk-down' }),
        { senderId: 1 },
      ),
    );

    expect(controller.commands).toEqual([{ type: 'push-to-talk-down' }]);
    expect((payload as { state: string }).state).toBe('listening');
  });

  it('pushes every controller change to the panel as a validated event', async () => {
    const { instance, panelHost, controller } = shell();

    instance.start();
    instance.panel.show();
    const window = panelHost.latest;
    expect(window).toBeDefined();
    window!.sent.length = 0;

    controller.set({ state: 'thinking' });

    const stateEvents = window!.sent.filter(
      (envelope) => envelope.channel === viewStateChangedEvent.name,
    );
    expect(stateEvents).toHaveLength(1);
    expect(parseEventEnvelope(viewStateChangedEvent, stateEvents[0]).payload.state).toBe(
      'thinking',
    );
  });

  it('keeps the menu bar in sync with the view state', () => {
    const { instance, trayHost, controller } = shell();

    instance.start();
    controller.set({ state: 'speaking', selectedWindow: FIXTURE_WINDOW_RETINA });

    expect(trayHost.latest?.tooltip).toBe('Pilot — Speaking');
    expect(trayHost.latest?.item('status')?.label).toBe('Speaking — Billing Settings');
  });

  it('shows, hides and toggles the panel from the renderer', async () => {
    const { instance } = shell();

    expect(
      successPayload(
        await instance.router.handle(request(panelSetVisibleChannel.name, { visible: true }), {
          senderId: 1,
        }),
      ),
    ).toEqual({ visible: true });
    expect(instance.panel.isVisible()).toBe(true);

    expect(
      successPayload(
        await instance.router.handle(request(panelSetVisibleChannel.name, { toggle: true }), {
          senderId: 1,
        }),
      ),
    ).toEqual({ visible: false });
    expect(instance.panel.isVisible()).toBe(false);
  });

  it('renders each fake scenario, including the failure state', async () => {
    const { instance } = shell();

    for (const scenario of ['idle', 'listening', 'thinking', 'speaking', 'observing'] as const) {
      const payload = successPayload(
        await instance.router.handle(request(demoScenarioChannel.name, scenario), { senderId: 1 }),
      ) as { state: string; lastError: unknown };
      expect(payload.lastError).toBeNull();
    }

    const failed = successPayload(
      await instance.router.handle(request(demoScenarioChannel.name, 'error'), { senderId: 1 }),
    ) as { state: string; lastError: { code: string; userMessage: string } | null };

    expect(failed.state).toBe('error');
    expect(failed.lastError?.code).toBe(DEMO_FAILURE.code);
    expect(failed.lastError?.userMessage).toBe(DEMO_FAILURE.userMessage);
  });

  it('rejects an unknown scenario name', async () => {
    const { instance } = shell();

    const response = await instance.router.handle(request(demoScenarioChannel.name, 'exfiltrate'), {
      senderId: 1,
    });

    expect(response.ok).toBe(false);
    expect(response.ok === false && response.error.code).toBe('invalid-request');
  });

  it('reports scenarios as unsupported when no driver is wired in', async () => {
    const { instance } = shell({ withScenarioDriver: false });

    const response = await instance.router.handle(request(demoScenarioChannel.name, 'error'), {
      senderId: 1,
    });

    expect(response.ok === false && response.error.code).toBe('unsupported-capability');
  });

  it('quits on request from the renderer and from the menu bar', async () => {
    const { instance, quits } = shell();
    instance.start();

    await instance.router.handle(request(quitChannel.name, {}), { senderId: 1 });
    instance.tray.select('quit');

    expect(quits).toHaveLength(2);
  });

  it('reports an unavailable menu bar item to the caller instead of failing to start', () => {
    const { instance } = shell({ trayFailure: new Error('no status area') });

    const { trayAvailability } = instance.start();

    expect(trayAvailability.available).toBe(false);
  });

  it('reveals the panel on a second launch attempt', () => {
    const { instance, panelHost } = shell();
    instance.start();

    instance.reveal();

    expect(instance.panel.isVisible()).toBe(true);
    expect(
      panelHost.latest?.sent.some((envelope) => envelope.channel === viewStateChangedEvent.name),
    ).toBe(true);
  });

  it('tears everything down on dispose', async () => {
    const { instance, panelHost, trayHost, controller } = shell();
    instance.start();
    instance.panel.show();

    await instance.dispose();

    expect(panelHost.latest?.destroyed).toBe(true);
    expect(trayHost.latest?.destroyed).toBe(true);
    expect(controller.disposed).toBe(true);
  });
});
