import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { asConversationId, createIdFactory, createJsonSink, createLogger } from '@pilot/shared';
import { FakeHotkeyAdapter, FakeSpeechInputAdapter } from '@pilot/platform/fakes';
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
import { createObservationRuntime, retentionEventForFeed } from './observation-runtime.js';
import { createPlatformRuntime } from './platform-runtime.js';
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
 * PR-029 replaced one fake boundary here: **the agent**. PR-028 replaced the
 * next one: **observation**. The window picker, the permission states and the
 * capture lifecycle now run on `main/platform-runtime.ts`'s chosen adapters, and
 * the frames land in a real `ObservationCore` ring behind PR-019's real
 * `PilotScreenContextService` (`main/observation-runtime.ts`).
 *
 * PR-030 replaced one more: **the screen-context service behind
 * `observe_screen`**. `FakeScreenContextService` is gone from the real path, so
 * a model that calls the tool reaches the same facade "Look now" does.
 *
 * What is still fake, and who takes each one:
 *
 * | boundary        | today                                      | owner   |
 * | --------------- | ------------------------------------------ | ------- |
 * | permissions     | real adapter; fake only when `kind: fakes`  | —       |
 * | window list     | real adapter; fake only when `kind: fakes`  | —       |
 * | screen capture  | real; **no capture at all** on `kind: fakes`| —       |
 * | `observe_screen`| real `PilotScreenContextService`            | —       |
 * | question anchor | `FakeQuestionAnchorSource`                 | PR-031  |
 * | speech in       | `FakeSpeechInputAdapter`                   | PR-032  |
 * | speech out      | silent adapter                             | PR-033  |
 * | model           | Pi's faux provider                         | PR-037  |
 * | persistence     | none (in-memory session)                   | PR-036  |
 *
 * `kind: fakes` is what a machine that is not a Mac gets, and it is reported
 * with its reason rather than inferred. **The whole real observation path is
 * still reachable on Linux**, against the Node helper stub that
 * `packages/platform-mac` tests itself with:
 *
 *   PILOT_HELPER_STUB_PATH="$PWD/packages/platform-mac/test/support/helper-stub.ts" \
 *     PILOT_HELPER_STUB='{"permissions":{"screen-recording":"granted","accessibility":"granted","microphone":"granted","speech-recognition":"granted"}}' \
 *     pnpm dev
 *
 * (absolute: the main process does not run from the repository root, and the
 * stub needs a desktop in `PILOT_HELPER_STUB` to enumerate — see the README)
 *
 * Every fixture state is reachable without editing source:
 *
 *   PILOT_MODEL_FIXTURE=faux-text-only pnpm dev   # the capability gate refuses
 *   PILOT_PERMISSION_FIXTURE=denied pnpm dev      # onboarding states (fakes only)
 *   PILOT_HOTKEY_FIXTURE=permission-missing pnpm dev
 *   PILOT_SPEECH_DISCLOSURE=remote pnpm dev
 *   PILOT_PLATFORM=fakes pnpm dev                 # force the fakes on a Mac
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

  // The platform (PR-028). One decision, in one place: the real macOS adapters
  // when there is a helper to talk to, the fakes otherwise, and the reason
  // either way. `start()` is awaited inside `app.whenReady()` below, because it
  // spawns a child process.
  const platform = createPlatformRuntime({
    logger,
    resourcesPath: process.resourcesPath,
  });

  // The observation boundary (PR-028). Built before the controller because the
  // controller takes its `ObservationControlPort` — runbook follow-up 23: "PR-028
  // passes the real capture lifecycle there" — and now also before the agent,
  // which takes its `ScreenContextService` (PR-030, the other half of the same
  // follow-up).
  const observation = createObservationRuntime({
    capture: platform.capture,
    windows: platform.windows,
    accessibility: platform.accessibility,
    ...(platform.permissions.attribution === undefined
      ? {}
      : { attribution: platform.permissions.attribution.bind(platform.permissions) }),
    logger,
  });

  // The agent (PR-029). The capability gate (PR-020) runs inside this call,
  // before Pi's `Agent` exists and before any tool is registered, so a refusal
  // costs zero provider requests.
  //
  // `screenContext` is PR-030's whole change on this side, and it is one
  // argument: `observe_screen` now reaches PR-019's real
  // `PilotScreenContextService` — the *same instance* the interaction table's
  // "Look now" drives — instead of `FakeScreenContextService`. One instance
  // matters: the §10 rate limiter, the scene lineage, the retention guard and
  // the one decoded frame are shared, so a model look and a user look cannot
  // disagree about what is on screen or evade each other's limits.
  const agentRuntime = createAgentRuntime({
    conversationId,
    source: modelSource,
    screenContext: observation.screenContext,
    logger,
  });

  // The interaction controller (PR-006/024/025/026/027), real at last. The
  // recogniser it is given is still mocked; it is constructed here rather than
  // inside the runtime so the replay bar can make recognition *fail*, which is
  // the one §16 case a command cannot express.
  const speechInput = new FakeSpeechInputAdapter();
  const { controller } = createInteractionRuntime({
    agent: agentRuntime.session,
    conversationId,
    speechInput,
    observation: observation.port,
    logger,
  });

  // §10 step 1 takes the pause switch and the observation switch from the
  // machine, which is the only thing that knows them.
  controller.subscribe((view) => {
    observation.noteViewState(view);
  });
  observation.noteViewState(controller.snapshot());

  if (!agentRuntime.capability.ok) {
    // Say it now rather than when the user asks their first question. The
    // machine's `error` state keeps the text box live (system-design §16), and
    // the refusal carries its own `userMessage` and remedy.
    controller.send({ type: 'failure', error: agentRuntime.capability.error });
  }

  // Permission onboarding (PR-008), now on the platform's own adapter. The
  // named fixtures survive only on the fake build — a real TCC state cannot be
  // forced from a panel, and offering a control that would be refused is the
  // thing PR-009 exists not to do.
  //   PILOT_PERMISSION_FIXTURE=denied pnpm dev
  const permissionAdapter = platform.permissions;
  const fixtures =
    platform.fakePermissions === null
      ? undefined
      : createPermissionFixtureSource(
          platform.fakePermissions,
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
    ...(fixtures === undefined ? {} : { fixtures }),
    logger,
  });

  // The real machine gates on permissions (`needs-permission` outranks every
  // other resting state), so the gate's snapshot has to reach it. Until one
  // arrives the controller holds `null`, which means "nothing reported yet" and
  // deliberately does not block — never "granted".
  //
  // The same snapshot is what §10 step 1 validates (runbook follow-up 16): with
  // it unwired every observation is refused as `permission-denied`, so this line
  // is the difference between an observation path that works and one that looks
  // broken for the wrong reason.
  permissions.subscribe((state) => {
    observation.notePermissions(state.snapshot);
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
  // §17's three capture-side numbers — capture-to-observation latency, image
  // bytes and the active image count — are the ones PR-010 deliberately left to
  // this PR, because none of them can be seen from the view-state stream.
  observation.attachTelemetry(conversation.telemetry);
  // Availability only. Turning `hotkey-down`/`hotkey-up` into
  // `push-to-talk-down`/`push-to-talk-up` is runbook follow-up 19, owned by
  // PR-032; wiring it here would put the same mapping in two places.
  void hotkeyAdapter.start();

  // Window picker and observation controls (PR-009), on the platform's own
  // enumeration (PR-028). `report` is `controller.send`, so `windows-changed`,
  // `window-closed`, `screen-locked` and `screen-unlocked` are answered by the
  // transition table rather than by a copy of it (runbook follow-ups 10, 11) —
  // and each of them now also names the retention occasion for the clear the
  // table is about to ask for, so the log says "screen-lock" rather than
  // guessing (follow-up 17).
  const observationInteraction = createObservationInteraction(controller);
  const windows = new WindowGate({
    windows: platform.windows,
    interaction: {
      ...observationInteraction,
      dispatch: (command) => {
        conversation.noteCommand(command);
        if (command.type === 'pause') {
          observation.noteRetentionEvent('pause');
        } else if (command.type === 'select-window') {
          observation.noteRetentionEvent('window-change');
        } else if (command.type === 'set-observation-enabled' && !command.enabled) {
          observation.noteRetentionEvent('observation-disabled');
        }
        observationInteraction.dispatch(command);
      },
      report: (event) => {
        const retentionEvent = retentionEventForFeed(event);
        if (retentionEvent !== null) {
          observation.noteRetentionEvent(retentionEvent);
        }
        observationInteraction.report(event);
      },
    },
    permissions,
    // The fake window-lifecycle controls are offered only by a build that has a
    // fake window adapter behind them (PR-028's half of runbook follow-up 10).
    // On the real enumeration the panel must not offer to close a window Pilot
    // does not own, and the shell would refuse it.
    demoEvents: platform.fakeWindows !== null,
    logger,
  });
  const fakeWindows = platform.fakeWindows;
  const windowDemoDriver =
    fakeWindows === null
      ? undefined
      : createFakeWindowDemoDriver({
          adapter: fakeWindows,
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

  const start = async (): Promise<void> => {
    // Spawns the helper, when there is one. Before the shell, so the first
    // window list and the first permission read have something to talk to.
    //
    // A helper that will not start must not take the application with it: the
    // panel is where the user is told what happened, and the window and
    // permission gates already surface `helper-unavailable` as a typed
    // `lastError`. Quitting instead would leave them with a menu bar item that
    // vanished and no explanation anywhere.
    try {
      await platform.start();
    } catch (cause) {
      logger.error('the platform helper did not start; observation is unavailable', {
        cause: String(cause),
        platform: platform.kind,
      });
    }
    await observation.refreshAttribution();

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
      ...(windowDemoDriver === undefined ? {} : { windowDemoDriver }),
      conversationFixtureDriver,
      appInfo: {
        version: app.getVersion(),
        platform: process.platform,
        // No longer a constant: this build may be on the real macOS adapters.
        usesRealPlatform: platform.kind !== 'fakes',
      },
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
      platform: platform.kind,
      platformReason: platform.reason,
      capture: observation.captureAvailable ? 'available' : 'unavailable',
    });
  };

  app
    .whenReady()
    .then(start)
    .catch((cause: unknown) => {
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
    //
    // Observation goes before the platform, and it goes through the retention
    // guard: system-design §13 lists process shutdown among the occasions the
    // buffers must be cleared, and `shutdown` is terminal, so the scene lineage
    // goes with them.
    const quitting = shell?.dispose() ?? Promise.resolve();
    void quitting
      .then(() => observation.dispose())
      .then(() => platform.dispose())
      .then(() => agentRuntime.dispose());
    shell = null;
  });
}
