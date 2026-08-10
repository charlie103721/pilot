import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { asConversationId, createIdFactory, createJsonSink, createLogger } from '@pilot/shared';
import {
  FakeHotkeyAdapter,
  FakePermissionAdapter,
  FakeSpeechInputAdapter,
  FakeWindowAdapter,
} from '@pilot/platform/fakes';
import { createDevelopmentModelSource, resolveDevelopmentModelFixture } from '@pilot/agent';
import { IPC_TRANSPORT } from '../ipc/channels.js';
import { createAgentRuntime } from './agent-runtime.js';
import { ConversationGate } from './conversation-gate.js';
import { createLiveConversationDriver } from './conversation-driver.js';
import {
  createFakeSpeechDisclosureSource,
  createReplayClock,
  resolveHotkeyAvailability,
  resolveSpeechDisclosure,
} from './conversation-fixtures.js';
import {
  createElectronPanelHost,
  createElectronSingleInstanceHost,
  createElectronTrayHost,
  resolveFromMain,
} from './electron-hosts.js';
import { createInteractionRuntime, createObservationInteraction } from './interaction-runtime.js';
import { PermissionGate } from './permission-gate.js';
import { createPermissionFixtureSource, resolvePermissionFixture } from './permission-fixtures.js';
import { createSettingsShortcut } from './settings-shortcut.js';
import { DesktopShell } from './shell.js';
import { enforceSingleInstance } from './single-instance.js';
import type { TrayMenuItem } from './tray.js';
import { WindowGate } from './window-gate.js';
import { createFakeWindowDemoDriver } from './window-demo.js';

/**
 * Electron entry point.
 *
 * Startup order matters: the single-instance lock is taken before anything is
 * created, so a losing instance never registers a tray item, an IPC handler or
 * a window. Everything after that is composition — the behaviour lives in
 * `shell.ts` and its collaborators.
 *
 * PR-029 replaced one fake boundary here: **the agent**. What the panel talks to
 * is now `@pilot/interaction`'s real state machine driving a real
 * `PiAgentSession` over a real Pi `Agent`. Text in, streamed answer out.
 *
 * What is still fake, and who takes each one:
 *
 * | boundary        | today                             | owner   |
 * | --------------- | --------------------------------- | ------- |
 * | permissions     | `FakePermissionAdapter`           | PR-028  |
 * | window list     | `FakeWindowAdapter`               | PR-028  |
 * | screen capture  | mocked port + `FakeScreenContext` | PR-028/030 |
 * | speech in       | `FakeSpeechInputAdapter`          | PR-032  |
 * | speech out      | silent adapter                    | PR-033  |
 * | model           | Pi's faux provider                | PR-037  |
 * | persistence     | none (in-memory session)          | PR-036  |
 *
 * Every one of them is reachable without editing source:
 *
 *   PILOT_MODEL_FIXTURE=faux-text-only pnpm dev   # the capability gate refuses
 *   PILOT_PERMISSION_FIXTURE=denied pnpm dev      # onboarding states
 *   PILOT_HOTKEY_FIXTURE=permission-missing pnpm dev
 *   PILOT_SPEECH_DISCLOSURE=remote pnpm dev
 */

const logger = createLogger({
  scope: 'desktop.main',
  level: process.env['PILOT_LOG_LEVEL'] === 'debug' ? 'debug' : 'info',
  sink: createJsonSink((line) => process.stderr.write(`${line}\n`)),
});

let shell: DesktopShell | null = null;

const singleInstance = enforceSingleInstance({
  host: createElectronSingleInstanceHost(),
  logger,
  onSecondInstance: () => shell?.reveal(),
});

if (!singleInstance.isPrimary) {
  // Another instance owns the menu bar item. Stop here; app.quit() is already
  // in flight and continuing would briefly create a second tray icon.
  logger.info('exiting as secondary instance');
} else {
  const conversationId = asConversationId(`conv-${String(Date.now())}`);

  // The model. There is no model access on this machine (docs/handoff.md §2),
  // so this is Pi's own faux provider behind a real `Models` collection —
  // runbook amendments 2 and 7. The line is logged rather than assumed: a build
  // that is not talking to a real model must say so where anyone can see it.
  const modelSource = createDevelopmentModelSource({
    fixture: resolveDevelopmentModelFixture(process.env['PILOT_MODEL_FIXTURE']),
  });
  logger.info('model source', { description: modelSource.description });

  // The agent (PR-029). The capability gate (PR-020) runs inside this call,
  // before Pi's `Agent` exists and before any tool is registered, so a refusal
  // costs zero provider requests.
  const agentRuntime = createAgentRuntime({ conversationId, source: modelSource, logger });

  // The interaction controller (PR-006/024/025/026/027), real at last. The
  // recogniser it is given is still mocked; it is constructed here rather than
  // inside the runtime so the replay bar can make recognition *fail*, which is
  // the one §16 case a command cannot express.
  const speechInput = new FakeSpeechInputAdapter();
  const { controller } = createInteractionRuntime({
    agent: agentRuntime.session,
    conversationId,
    speechInput,
    logger,
  });

  if (!agentRuntime.capability.ok) {
    // Say it now rather than when the user asks their first question. The
    // machine's `error` state keeps the text box live (system-design §16), and
    // the refusal carries its own `userMessage` and remedy.
    controller.send({ type: 'failure', error: agentRuntime.capability.error });
  }

  // Permission onboarding (PR-008). The fixture the app boots into is chosen by
  // the environment so every state is reachable without editing source:
  //   PILOT_PERMISSION_FIXTURE=denied pnpm dev
  const permissionAdapter = new FakePermissionAdapter();
  const fixtures = createPermissionFixtureSource(
    permissionAdapter,
    resolvePermissionFixture(process.env['PILOT_PERMISSION_FIXTURE']),
  );
  const permissions = new PermissionGate({
    adapter: permissionAdapter,
    // On anything but macOS this seam reports itself unavailable, and the panel
    // renders an explained, disabled control rather than a dead button.
    settings: createSettingsShortcut({
      platform: process.platform,
      adapter: permissionAdapter,
    }),
    fixtures,
    logger,
  });

  // The real machine gates on permissions (`needs-permission` outranks every
  // other resting state), so the gate's snapshot has to reach it. Until one
  // arrives the controller holds `null`, which means "nothing reported yet" and
  // deliberately does not block — never "granted".
  permissions.subscribe((state) => {
    if (state.snapshot !== null) {
      controller.send({ type: 'permissions-changed', permissions: state.snapshot });
    }
  });

  // Conversation and developer diagnostics (PR-010). Built before the window
  // gate so every command the window gate dispatches passes through
  // `noteCommand` too — a question abandoned by changing the observed window is
  // the same abort as one abandoned with the Interrupt button.
  //
  //   PILOT_HOTKEY_FIXTURE=permission-missing pnpm dev   # no way to speak
  //   PILOT_SPEECH_DISCLOSURE=remote pnpm dev            # audio would leave
  const replayClock = createReplayClock();
  const hotkeyAdapter = new FakeHotkeyAdapter({
    availability: resolveHotkeyAvailability(process.env['PILOT_HOTKEY_FIXTURE']),
  });
  const conversation = new ConversationGate({
    interaction: controller,
    hotkey: hotkeyAdapter,
    // PR-032 replaces this with `MacSpeechInputAdapter`; the route to the panel
    // is what PR-010 owed (runbook follow-up 13).
    ...(() => {
      const speech = createFakeSpeechDisclosureSource(
        resolveSpeechDisclosure(process.env['PILOT_SPEECH_DISCLOSURE']),
      );
      return speech === undefined ? {} : { speech };
    })(),
    demoFixtures: true,
    now: () => replayClock.now(),
    logger,
  });
  // Availability only. Turning `hotkey-down`/`hotkey-up` into
  // `push-to-talk-down`/`push-to-talk-up` is runbook follow-up 19, owned by
  // PR-032; wiring it here would put the same mapping in two places.
  void hotkeyAdapter.start();

  // Window picker and observation controls (PR-009). Still the PR-001 fake
  // adapter: PR-011's real enumeration cannot run here, and PR-012 owns the
  // capture that a selection will eventually start. What *is* real now is the
  // interaction side — `report` is `controller.send`, so `windows-changed`,
  // `window-closed`, `screen-locked` and `screen-unlocked` are answered by the
  // transition table rather than by a copy of it (runbook follow-ups 10, 11).
  const windowAdapter = new FakeWindowAdapter();
  const observationInteraction = createObservationInteraction(controller);
  const windows = new WindowGate({
    windows: windowAdapter,
    interaction: {
      ...observationInteraction,
      dispatch: (command) => {
        conversation.noteCommand(command);
        observationInteraction.dispatch(command);
      },
    },
    permissions,
    demoEvents: true,
    logger,
  });
  const windowDemoDriver = createFakeWindowDemoDriver({
    adapter: windowAdapter,
    selected: () => controller.snapshot().selectedWindow,
  });
  // The panel's "Replay" bar. Since PR-029 it holds real conversations against
  // the real controller instead of replaying scripted view states.
  const conversationFixtureDriver = createLiveConversationDriver({
    controller,
    gate: conversation,
    speech: speechInput,
    logger,
  });

  // Set by `electron-vite dev`, absent in every built app. When it is present
  // the panel loads from the dev server so edits hot-reload; otherwise it loads
  // the file emitted next to this one.
  const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'];
  const rendererSource =
    rendererDevUrl === undefined
      ? { file: resolveFromMain('../renderer/index.html') }
      : { url: rendererDevUrl };

  const start = (): void => {
    const trayHost = createElectronTrayHost({
      onSelect: (id: TrayMenuItem['id']) => shell?.tray.select(id),
    });

    shell = new DesktopShell({
      panelHost: createElectronPanelHost({
        preloadPath: resolveFromMain('../preload/index.cjs'),
        renderer: rendererSource,
      }),
      trayHost,
      controller,
      permissions,
      windows,
      conversation,
      windowDemoDriver,
      conversationFixtureDriver,
      appInfo: { version: app.getVersion(), platform: process.platform },
      quit: () => app.quit(),
      ids: createIdFactory(),
      logger,
    });

    ipcMain.handle(IPC_TRANSPORT.request, async (event: IpcMainInvokeEvent, raw: unknown) =>
      // Every renderer payload passes through the router's validation; there is
      // no second `ipcMain.handle` and therefore no unvalidated path (§14).
      shell === null ? undefined : shell.router.handle(raw, { senderId: event.sender.id }),
    );

    const { trayAvailability } = shell.start();
    if (!trayAvailability.available) {
      // Without a menu bar item the panel is the only way in, so open it.
      logger.warn('no menu bar item; opening the panel directly', {
        reason: trayAvailability.reason,
      });
      shell.reveal();
    }
    if (process.env['PILOT_OPEN_PANEL_ON_START'] === '1') {
      shell.reveal();
    }

    // Read by `scripts/smoke.js` to decide the headless launch check passed.
    logger.info('shell ready', {
      trayAvailable: trayAvailability.available,
      panelVisible: shell.panel.isVisible(),
      agent: agentRuntime.capability.ok ? 'ready' : 'refused',
    });
  };

  app.whenReady().then(start, (cause: unknown) => {
    logger.error('failed to start', { cause: String(cause) });
    app.exit(1);
  });

  // Pilot is a menu bar app: closing the panel must not quit it.
  app.on('window-all-closed', () => undefined);

  app.on('activate', () => shell?.reveal());

  app.on('before-quit', () => {
    // The shell disposes the controller, which aborts anything in flight; the
    // session itself is disposed here because the shell does not own it.
    // PR-036 adds `store.close()` next to this line.
    void shell?.dispose().then(() => agentRuntime.dispose());
    shell = null;
  });
}
