import {
  createIdFactory,
  IPC_PROTOCOL_VERSION,
  nullLogger,
  PilotError,
  type IdFactory,
  type Logger,
} from '@pilot/shared';
import type { InteractionController, PilotViewState } from '@pilot/platform';
import {
  appInfoChannel,
  demoPermissionFixtureChannel,
  demoScenarioChannel,
  interactionDispatchChannel,
  panelSetVisibleChannel,
  demoWindowEventChannel,
  permissionsActChannel,
  permissionsChangedEvent,
  permissionsGetChannel,
  quitChannel,
  viewStateChangedEvent,
  viewStateGetChannel,
  windowsActChannel,
  windowsChangedEvent,
  windowsGetChannel,
} from '../ipc/channels.js';
import { IpcRouter } from './ipc-router.js';
import { PanelController, type PanelWindowHost } from './panel-window.js';
import { TrayController, type TrayAvailability, type TrayHost } from './tray.js';
import type { ScenarioDriver } from './scenarios.js';
import type { PermissionGate } from './permission-gate.js';
import type { WindowGate } from './window-gate.js';
import type { WindowDemoDriver } from './window-feed.js';

/**
 * Composition root for the desktop shell.
 *
 * Everything the shell does — routing validated renderer requests, driving the
 * panel, keeping the menu bar in sync with the view state — is assembled here
 * from ports. `main/index.ts` supplies the Electron implementations of those
 * ports and nothing else; this module never imports `electron`, so the whole
 * composition is exercised in tests without a display server.
 */

export interface DesktopShellAppInfo {
  readonly version: string;
  readonly platform: string;
}

export interface DesktopShellOptions {
  readonly panelHost: PanelWindowHost;
  readonly trayHost: TrayHost;
  readonly controller: InteractionController;
  /** Owns permission state and the System Settings shortcut (PR-008). */
  readonly permissions: PermissionGate;
  /** Owns the window list and the observation controls (PR-009). */
  readonly windows: WindowGate;
  readonly appInfo: DesktopShellAppInfo;
  readonly quit: () => void;
  /** Present only while the shell runs on fakes. Omit once PR-010 lands. */
  readonly scenarioDriver?: ScenarioDriver;
  /** Present only while the shell runs on the fake window adapter (PR-009). */
  readonly windowDemoDriver?: WindowDemoDriver;
  readonly ids?: IdFactory;
  readonly now?: () => number;
  readonly logger?: Logger;
}

export interface DesktopShellStartResult {
  readonly trayAvailability: TrayAvailability;
}

export class DesktopShell {
  readonly router: IpcRouter;
  readonly panel: PanelController;
  readonly tray: TrayController;

  readonly permissions: PermissionGate;
  readonly windows: WindowGate;

  readonly #controller: InteractionController;
  readonly #options: DesktopShellOptions;
  readonly #logger: Logger;
  #unsubscribe: (() => void) | null = null;
  #unsubscribePermissions: (() => void) | null = null;
  #unsubscribeWindows: (() => void) | null = null;

  constructor(options: DesktopShellOptions) {
    this.#options = options;
    this.#controller = options.controller;
    this.permissions = options.permissions;
    this.windows = options.windows;
    this.#logger = options.logger ?? nullLogger;
    const ids = options.ids ?? createIdFactory();

    this.panel = new PanelController({
      host: options.panelHost,
      ids,
      ...(options.now === undefined ? {} : { now: options.now }),
      logger: this.#logger,
    });

    this.tray = new TrayController({
      host: options.trayHost,
      logger: this.#logger,
      actions: {
        togglePanel: () => {
          const visible = this.panel.toggle();
          this.tray.setPanelVisible(visible);
        },
        toggleObservation: (enabled) => {
          this.#controller.dispatch({ type: 'set-observation-enabled', enabled });
        },
        setPaused: (paused) => {
          this.#controller.dispatch({ type: paused ? 'pause' : 'resume' });
        },
        quit: () => options.quit(),
      },
    });

    this.router = new IpcRouter({
      logger: this.#logger,
      ...(options.now === undefined ? {} : { now: options.now }),
      nextRequestId: () => ids.request(),
    });

    this.#registerHandlers();
  }

  /** Creates the menu bar item and pushes the first view state everywhere. */
  start(): DesktopShellStartResult {
    const trayAvailability = this.tray.create();
    if (!trayAvailability.available) {
      this.#logger.warn('running without a menu bar item', { reason: trayAvailability.reason });
    }

    this.#unsubscribe = this.#controller.subscribe((view) => this.#publish(view));
    this.#unsubscribePermissions = this.permissions.subscribe((state) => {
      this.panel.broadcast(permissionsChangedEvent, state);
    });
    this.#unsubscribeWindows = this.windows.subscribe((state) => {
      this.panel.broadcast(windowsChangedEvent, state);
    });
    this.#publish(this.#controller.snapshot());

    // The first permission read starts immediately, so the panel has something
    // real to show as soon as it opens instead of an empty onboarding list.
    void this.permissions.refresh();
    // Same for the window list: an empty picker must mean "no windows", never
    // "Pilot has not looked yet".
    void this.windows.refresh();
    return { trayAvailability };
  }

  /**
   * Reveals the panel. Used on activate and on a second launch attempt.
   *
   * Also re-reads permissions: macOS does not notify an app when the user
   * changes a TCC setting, and returning to Pilot after visiting System
   * Settings is exactly when a previously refused permission has become
   * available. Without this the user would have to restart Pilot to be
   * believed, which system-design §16 does not permit.
   */
  reveal(): void {
    this.panel.show();
    this.tray.setPanelVisible(true);
    this.panel.broadcast(viewStateChangedEvent, this.#controller.snapshot());
    this.panel.broadcast(permissionsChangedEvent, this.permissions.snapshot());
    this.panel.broadcast(windowsChangedEvent, this.windows.snapshot());
    void this.permissions.refresh();
    // Windows open and close while the panel is hidden; a stale list would
    // offer the user a window that is no longer there.
    void this.windows.refresh();
  }

  async dispose(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#unsubscribePermissions?.();
    this.#unsubscribePermissions = null;
    this.#unsubscribeWindows?.();
    this.#unsubscribeWindows = null;
    this.windows.dispose();
    this.permissions.dispose();
    this.tray.dispose();
    this.panel.dispose();
    await this.#controller.dispose();
  }

  #publish(view: PilotViewState): void {
    this.tray.update(view);
    this.panel.broadcast(viewStateChangedEvent, view);
  }

  #registerHandlers(): void {
    this.router.register(appInfoChannel, () => ({
      version: this.#options.appInfo.version,
      protocolVersion: IPC_PROTOCOL_VERSION,
      platform: this.#options.appInfo.platform,
      usesRealPlatform: false,
    }));

    this.router.register(viewStateGetChannel, () => this.#controller.snapshot());

    this.router.register(interactionDispatchChannel, (command) => {
      this.#controller.dispatch(command);
      return this.#controller.snapshot();
    });

    this.router.register(panelSetVisibleChannel, (request) => {
      const visible =
        request.toggle === true
          ? this.panel.toggle()
          : this.panel.setVisible(request.visible ?? true);
      this.tray.setPanelVisible(visible);
      return { visible };
    });

    this.router.register(permissionsGetChannel, () => this.permissions.snapshot());

    this.router.register(permissionsActChannel, (action) => this.permissions.act(action));

    this.router.register(demoPermissionFixtureChannel, (fixture) =>
      this.permissions.applyFixture(fixture),
    );

    this.router.register(windowsGetChannel, () => this.windows.snapshot());

    this.router.register(windowsActChannel, (action) => this.windows.act(action));

    this.router.register(demoWindowEventChannel, async (event) => {
      const driver = this.#options.windowDemoDriver;
      if (driver === undefined) {
        throw new PilotError('unsupported-capability', 'This build has no fake window driver', {
          userMessage: 'Window demo events are only available in development builds.',
          details: { event },
        });
      }
      await driver(event);
      // Re-listed before answering: the response must not be older than the
      // event the panel has already been sent, or it would overwrite it.
      return this.windows.refresh();
    });

    this.router.register(demoScenarioChannel, (scenario) => {
      const driver = this.#options.scenarioDriver;
      if (driver === undefined) {
        throw new PilotError('unsupported-capability', 'This build has no fake scenario driver', {
          userMessage: 'Demo states are only available in development builds.',
          details: { scenario },
        });
      }
      return driver(scenario);
    });

    this.router.register(quitChannel, () => {
      this.#options.quit();
      return { accepted: true as const };
    });
  }
}
