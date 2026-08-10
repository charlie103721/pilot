import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { createIdFactory, createJsonSink, createLogger } from '@pilot/shared';
import {
  FakeInteractionController,
  FakePermissionAdapter,
  FakeWindowAdapter,
} from '@pilot/platform/fakes';
import { IPC_TRANSPORT } from '../ipc/channels.js';
import {
  createElectronPanelHost,
  createElectronSingleInstanceHost,
  createElectronTrayHost,
  resolveFromMain,
} from './electron-hosts.js';
import { PermissionGate } from './permission-gate.js';
import { createPermissionFixtureSource, resolvePermissionFixture } from './permission-fixtures.js';
import { createFakeScenarioDriver } from './scenarios.js';
import { createSettingsShortcut } from './settings-shortcut.js';
import { DesktopShell } from './shell.js';
import { enforceSingleInstance } from './single-instance.js';
import type { TrayMenuItem } from './tray.js';
import { WindowGate } from './window-gate.js';
import { createFakeObservationInteraction, createFakeWindowDemoDriver } from './window-feed.js';

/**
 * Electron entry point.
 *
 * Startup order matters: the single-instance lock is taken before anything is
 * created, so a losing instance never registers a tray item, an IPC handler or
 * a window. Everything after that is composition — the behaviour lives in
 * `shell.ts` and its collaborators.
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
  // Still entirely on the PR-001 fakes: no platform, agent or voice code is
  // wired up yet. PR-009 and PR-010 replace this controller; PR-011 replaces
  // the permission adapter below with the real TCC-backed one.
  const controller = new FakeInteractionController();

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

  // Window picker and observation controls (PR-009). Still the PR-001 fake
  // adapter: PR-011's real enumeration cannot run here, and PR-012 owns the
  // capture that a selection will eventually start.
  const windowAdapter = new FakeWindowAdapter();
  const windows = new WindowGate({
    windows: windowAdapter,
    interaction: createFakeObservationInteraction(controller),
    permissions,
    demoEvents: true,
    logger,
  });
  const windowDemoDriver = createFakeWindowDemoDriver({
    adapter: windowAdapter,
    selected: () => controller.snapshot().selectedWindow,
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
      scenarioDriver: createFakeScenarioDriver(controller),
      windowDemoDriver,
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
    void shell?.dispose();
    shell = null;
  });
}
