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
import {
  FakeInteractionController,
  FIXTURE_PERMISSIONS_GRANTED,
  FIXTURE_WINDOW_RETINA,
} from '@pilot/platform/fakes';
import {
  appInfoChannel,
  conversationActChannel,
  conversationChangedEvent,
  conversationGetChannel,
  demoConversationChannel,
  demoPermissionFixtureChannel,
  demoScenarioChannel,
  demoWindowEventChannel,
  interactionDispatchChannel,
  panelSetVisibleChannel,
  permissionsActChannel,
  permissionsChangedEvent,
  permissionsGetChannel,
  quitChannel,
  viewStateChangedEvent,
  viewStateGetChannel,
  windowsActChannel,
  windowsChangedEvent,
  windowsGetChannel,
} from '../../src/ipc/channels.js';
import type {
  ConversationGateState,
  PermissionGateState,
  WindowGateState,
} from '../../src/ipc/schemas.js';
import { unavailableReason } from '../../src/main/settings-shortcut.js';
import { createFakeScenarioDriver, DEMO_FAILURE } from '../../src/main/scenarios.js';
import { DesktopShell } from '../../src/main/shell.js';
import {
  conversationHarness,
  FakePanelHost,
  FakeTrayHost,
  permissionHarness,
  windowHarness,
} from './support.js';

/**
 * The composed shell.
 *
 * These tests drive the whole main-process surface the way the renderer and the
 * menu bar do — through validated envelopes and tray selections — with Electron
 * replaced by the in-memory ports.
 */

function shell(
  options: {
    withScenarioDriver?: boolean;
    withPermissionFixtures?: boolean;
    withWindowDemoDriver?: boolean;
    withConversationFixtures?: boolean;
    trayFailure?: Error;
  } = {},
) {
  const panelHost = new FakePanelHost();
  const trayHost = new FakeTrayHost();
  if (options.trayFailure !== undefined) {
    trayHost.failure = options.trayFailure;
  }
  const controller = new FakeInteractionController();
  const permissions = permissionHarness({
    ...(options.withPermissionFixtures === false ? { withFixtures: false } : {}),
    now: () => 1_700_000_000_000,
  });
  const windows = windowHarness({
    permissions: permissions.gate,
    controller,
    now: () => 1_700_000_000_000,
  });
  const conversation = conversationHarness({ controller });
  const quits: number[] = [];

  const instance = new DesktopShell({
    panelHost,
    trayHost,
    controller,
    permissions: permissions.gate,
    windows: windows.gate,
    conversation: conversation.gate,
    appInfo: { version: '9.9.9', platform: 'linux' },
    quit: () => quits.push(1),
    ids: createIdFactory(createCounterIdSource()),
    now: () => 1_700_000_000_000,
    ...(options.withScenarioDriver === false
      ? {}
      : { scenarioDriver: createFakeScenarioDriver(controller) }),
    ...(options.withWindowDemoDriver === false ? {} : { windowDemoDriver: windows.demo }),
    ...(options.withConversationFixtures === false
      ? {}
      : { conversationFixtureDriver: conversation.replay }),
  });

  return { instance, panelHost, trayHost, controller, permissions, windows, conversation, quits };
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

  it('serves permission state to the renderer', async () => {
    const { instance } = shell();

    const payload = successPayload(
      await instance.router.handle(request(permissionsGetChannel.name, {}), { senderId: 1 }),
    ) as PermissionGateState;

    // Nothing has been read yet, so the snapshot is null — which the panel
    // renders as "checking", never as a refusal.
    expect(payload.snapshot).toBeNull();
    expect(payload.settings).toEqual({
      available: false,
      platform: 'linux',
      reason: unavailableReason('linux'),
    });
  });

  it('reads permissions on start and pushes them to the panel', async () => {
    const { instance, panelHost } = shell();

    instance.start();
    instance.panel.show();
    await instance.permissions.refresh();

    const events = panelHost.latest!.sent.filter(
      (envelope) => envelope.channel === permissionsChangedEvent.name,
    );
    expect(events.length).toBeGreaterThan(0);
    const latest = parseEventEnvelope(permissionsChangedEvent, events.at(-1)!).payload;
    expect(latest.snapshot?.['screen-recording'].state).toBe('unknown');
    expect(latest.pending).toEqual([]);
  });

  it('rechecks permissions when the panel is revealed', async () => {
    const { instance, permissions } = shell();
    instance.start();
    await instance.permissions.refresh();
    permissions.adapter.setSnapshot(FIXTURE_PERMISSIONS_GRANTED);

    instance.reveal();
    await instance.permissions.refresh();

    expect(instance.permissions.snapshot().snapshot).toEqual(FIXTURE_PERMISSIONS_GRANTED);
  });

  it('runs a validated permission action', async () => {
    const { instance } = shell();

    const payload = successPayload(
      await instance.router.handle(
        request(permissionsActChannel.name, { type: 'request', kind: 'microphone' }),
        { senderId: 1 },
      ),
    ) as PermissionGateState;

    expect(payload.snapshot?.microphone.state).toBe('granted');
  });

  it('rejects a permission action for a kind that does not exist', async () => {
    const { instance } = shell();

    const response = await instance.router.handle(
      request(permissionsActChannel.name, { type: 'request', kind: 'filesystem' }),
      { senderId: 1 },
    );

    expect(response.ok === false && response.error.code).toBe('invalid-request');
  });

  it('reports the System Settings shortcut as unsupported instead of doing nothing', async () => {
    const { instance } = shell();

    const payload = successPayload(
      await instance.router.handle(
        request(permissionsActChannel.name, { type: 'open-settings', kind: 'screen-recording' }),
        { senderId: 1 },
      ),
    ) as PermissionGateState;

    expect(payload.lastError?.code).toBe('unsupported-capability');
    expect(payload.lastError?.userMessage).toContain('Screen Recording');
  });

  it('switches permission fixtures on demand', async () => {
    const { instance } = shell();

    const payload = successPayload(
      await instance.router.handle(request(demoPermissionFixtureChannel.name, 'restricted'), {
        senderId: 1,
      }),
    ) as PermissionGateState;

    expect(payload.fixture).toBe('restricted');
    expect(payload.snapshot?.accessibility.state).toBe('restricted');
  });

  it('rejects an unknown permission fixture name', async () => {
    const { instance } = shell();

    const response = await instance.router.handle(
      request(demoPermissionFixtureChannel.name, 'everything-allowed-trust-me'),
      { senderId: 1 },
    );

    expect(response.ok === false && response.error.code).toBe('invalid-request');
  });

  it('reports fixtures as unsupported in a build without them', async () => {
    const { instance } = shell({ withPermissionFixtures: false });

    const response = await instance.router.handle(
      request(demoPermissionFixtureChannel.name, 'granted'),
      { senderId: 1 },
    );

    expect(response.ok === false && response.error.code).toBe('unsupported-capability');
  });

  it('serves the window list and the observation controls', async () => {
    const { instance, controller } = shell();
    // Observation is gated on permissions in the main process too, so the
    // fixture is granted first — a selection before that is refused, which the
    // window-gate suite asserts separately.
    await instance.router.handle(request(demoPermissionFixtureChannel.name, 'granted'), {
      senderId: 1,
    });

    const listed = successPayload(
      await instance.router.handle(request(windowsGetChannel.name, {}), { senderId: 1 }),
    ) as WindowGateState;
    expect(listed.listedAt).toBeNull();

    const refreshed = successPayload(
      await instance.router.handle(request(windowsActChannel.name, { type: 'refresh' }), {
        senderId: 1,
      }),
    ) as WindowGateState;
    expect(refreshed.windows).toHaveLength(2);

    await instance.router.handle(
      request(windowsActChannel.name, {
        type: 'select',
        windowId: FIXTURE_WINDOW_RETINA.windowId,
      }),
      { senderId: 1 },
    );
    await instance.router.handle(request(windowsActChannel.name, { type: 'start' }), {
      senderId: 1,
    });

    expect(controller.snapshot().selectedWindow).toEqual(FIXTURE_WINDOW_RETINA);
    expect(controller.snapshot().observationEnabled).toBe(true);
  });

  it('rejects an unknown window action rather than acting on it', async () => {
    const { instance } = shell();

    const response = await instance.router.handle(
      request(windowsActChannel.name, { type: 'capture-everything' }),
      { senderId: 1 },
    );

    expect(response.ok === false && response.error.code).toBe('invalid-request');
  });

  it('pushes the §16 prompt to the panel when the selected window closes', async () => {
    const { instance, panelHost, windows } = shell();
    instance.start();
    instance.panel.show();
    await instance.router.handle(request(demoPermissionFixtureChannel.name, 'granted'), {
      senderId: 1,
    });
    await instance.router.handle(request(windowsActChannel.name, { type: 'refresh' }), {
      senderId: 1,
    });
    await instance.router.handle(
      request(windowsActChannel.name, {
        type: 'select',
        windowId: FIXTURE_WINDOW_RETINA.windowId,
      }),
      { senderId: 1 },
    );
    await instance.router.handle(request(windowsActChannel.name, { type: 'start' }), {
      senderId: 1,
    });
    const panel = panelHost.latest;
    expect(panel).toBeDefined();
    panel!.sent.length = 0;

    windows.adapter.closeWindow(FIXTURE_WINDOW_RETINA.windowId);

    const events = panel!.sent.filter((envelope) => envelope.channel === windowsChangedEvent.name);
    expect(events.length).toBeGreaterThan(0);
    expect(parseEventEnvelope(windowsChangedEvent, events[0]).payload.notice?.reason).toBe(
      'selected-window-closed',
    );
  });

  it('reports fake window events as unsupported in a build without them', async () => {
    const { instance } = shell({ withWindowDemoDriver: false });

    const response = await instance.router.handle(
      request(demoWindowEventChannel.name, 'close-selected'),
      { senderId: 1 },
    );

    expect(response.ok === false && response.error.code).toBe('unsupported-capability');
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

describe('DesktopShell — conversation and diagnostics (PR-010)', () => {
  it('serves the telemetry buffer and the voice facts over the same transport', async () => {
    const { instance } = shell();
    instance.start();

    const initial = successPayload(
      await instance.router.handle(request(conversationGetChannel.name, {}), { senderId: 1 }),
    ) as ConversationGateState;

    expect(initial.telemetry.samples).toEqual([]);
    expect(initial.demoFixtures).toBe(true);
    // `start()` refreshes the voice facts, so the panel never renders a
    // push-to-talk button before knowing whether it can work.
    await Promise.resolve();
    await Promise.resolve();
    expect(instance.conversation.snapshot().pushToTalk).not.toBeNull();
  });

  it('records an abort for a command that abandoned an answer, wherever it came from', async () => {
    const { instance, controller } = shell();
    instance.start();
    controller.set({ state: 'speaking' });

    await instance.router.handle(request(interactionDispatchChannel.name, { type: 'interrupt' }), {
      senderId: 1,
    });
    // The same command from the menu bar goes through the same one path.
    controller.set({ state: 'speaking' });
    instance.tray.select('pause-resume');

    const samples = instance.conversation.snapshot().telemetry.samples;
    expect(
      samples.filter((sample) => sample.metric === 'abort').map((sample) => sample.category),
    ).toEqual(['user-interrupted', 'observation-stopped']);
  });

  it('replays a fixture conversation and pushes the ring buffer to the panel', async () => {
    const { instance, panelHost, controller } = shell();
    instance.start();
    instance.panel.show();
    const panel = panelHost.latest;
    expect(panel).toBeDefined();
    panel!.sent.length = 0;

    const state = successPayload(
      await instance.router.handle(request(demoConversationChannel.name, 'spoken-question'), {
        senderId: 1,
      }),
    ) as ConversationGateState;

    expect(state.fixture).toBe('spoken-question');
    expect(state.telemetry.recorded).toBeGreaterThan(0);
    expect(controller.snapshot().transcript).toHaveLength(2);

    const events = panel!.sent.filter(
      (envelope) => envelope.channel === conversationChangedEvent.name,
    );
    expect(events.length).toBeGreaterThan(0);
    const published = parseEventEnvelope(conversationChangedEvent, events.at(-1)!).payload;
    // What crossed the wire is timings and counts. The question and the answer
    // went to the transcript, over `pilot:view-state/changed`, and nowhere near
    // this envelope.
    expect(JSON.stringify(published)).not.toContain('Auto Renew');
  });

  it('rejects an unknown conversation action rather than acting on it', async () => {
    const { instance } = shell();

    const response = await instance.router.handle(
      request(conversationActChannel.name, { type: 'dump-everything' }),
      { senderId: 1 },
    );

    expect(response.ok === false && response.error.code).toBe('invalid-request');
  });

  it('reports fixture conversations as unsupported in a build without them', async () => {
    const { instance } = shell({ withConversationFixtures: false });

    const response = await instance.router.handle(
      request(demoConversationChannel.name, 'spoken-question'),
      { senderId: 1 },
    );

    expect(response.ok === false && response.error.code).toBe('unsupported-capability');
  });

  it('records a shutdown abort when an answer is still in flight', async () => {
    const { instance, controller } = shell();
    instance.start();
    controller.set({ state: 'thinking' });

    await instance.dispose();

    expect(
      instance.conversation
        .snapshot()
        .telemetry.samples.some((sample) => sample.category === 'shutdown'),
    ).toBe(true);
  });
});
