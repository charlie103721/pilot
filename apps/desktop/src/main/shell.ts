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
  demoScenarioChannel,
  interactionDispatchChannel,
  panelSetVisibleChannel,
  quitChannel,
  viewStateChangedEvent,
  viewStateGetChannel,
} from '../ipc/channels.js';
import { IpcRouter } from './ipc-router.js';
import { PanelController, type PanelWindowHost } from './panel-window.js';
import { TrayController, type TrayAvailability, type TrayHost } from './tray.js';
import type { ScenarioDriver } from './scenarios.js';

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
  readonly appInfo: DesktopShellAppInfo;
  readonly quit: () => void;
  /** Present only while the shell runs on fakes. Omit once PR-010 lands. */
  readonly scenarioDriver?: ScenarioDriver;
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

  readonly #controller: InteractionController;
  readonly #options: DesktopShellOptions;
  readonly #logger: Logger;
  #unsubscribe: (() => void) | null = null;

  constructor(options: DesktopShellOptions) {
    this.#options = options;
    this.#controller = options.controller;
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
    this.#publish(this.#controller.snapshot());
    return { trayAvailability };
  }

  /** Reveals the panel. Used on activate and on a second launch attempt. */
  reveal(): void {
    this.panel.show();
    this.tray.setPanelVisible(true);
    this.panel.broadcast(viewStateChangedEvent, this.#controller.snapshot());
  }

  async dispose(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
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
