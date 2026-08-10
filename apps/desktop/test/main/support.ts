import type { EventEnvelope } from '@pilot/shared';
import type { PanelWindowHandle, PanelWindowHost } from '../../src/main/panel-window.js';
import type { TrayHandle, TrayHost, TrayMenuItem } from '../../src/main/tray.js';
import type { SingleInstanceHost } from '../../src/main/single-instance.js';

/**
 * In-memory implementations of the shell's ports.
 *
 * Every main-process behaviour under test — single instance, window lifecycle,
 * tray rendering, IPC validation — is expressed against these rather than
 * against Electron, so the suite runs headlessly and deterministically.
 */

export class FakePanelWindow implements PanelWindowHandle {
  visible = false;
  destroyed = false;
  focusCount = 0;
  readonly sent: EventEnvelope[] = [];
  readonly #closedListeners: (() => void)[] = [];
  /** When set, `send` throws it once — simulates a window dying mid-send. */
  sendError: Error | null = null;

  show(): void {
    this.visible = true;
  }

  hide(): void {
    this.visible = false;
  }

  focus(): void {
    this.focusCount += 1;
  }

  isVisible(): boolean {
    return !this.destroyed && this.visible;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.visible = false;
  }

  send(envelope: EventEnvelope): void {
    if (this.sendError !== null) {
      const error = this.sendError;
      this.sendError = null;
      throw error;
    }
    this.sent.push(envelope);
  }

  onClosed(listener: () => void): void {
    this.#closedListeners.push(listener);
  }

  /** Simulates the OS closing the window. */
  closeExternally(): void {
    this.destroyed = true;
    this.visible = false;
    for (const listener of this.#closedListeners) {
      listener();
    }
  }
}

export class FakePanelHost implements PanelWindowHost {
  readonly created: FakePanelWindow[] = [];

  create(): FakePanelWindow {
    const window = new FakePanelWindow();
    this.created.push(window);
    return window;
  }

  get latest(): FakePanelWindow | undefined {
    return this.created.at(-1);
  }
}

export class FakeTray implements TrayHandle {
  tooltip: string | null = null;
  menu: readonly TrayMenuItem[] = [];
  destroyed = false;
  #clickListener: (() => void) | null = null;

  setToolTip(tooltip: string): void {
    this.tooltip = tooltip;
  }

  setMenu(items: readonly TrayMenuItem[]): void {
    this.menu = items;
  }

  onClick(listener: () => void): void {
    this.#clickListener = listener;
  }

  destroy(): void {
    this.destroyed = true;
  }

  click(): void {
    this.#clickListener?.();
  }

  item(id: string): TrayMenuItem | undefined {
    return this.menu.find((entry) => entry.id === id);
  }
}

export class FakeTrayHost implements TrayHost {
  readonly created: FakeTray[] = [];
  /** When set, `create` throws it — the "no status area" case. */
  failure: Error | null = null;

  create(): FakeTray {
    if (this.failure !== null) {
      throw this.failure;
    }
    const tray = new FakeTray();
    this.created.push(tray);
    return tray;
  }

  get latest(): FakeTray | undefined {
    return this.created.at(-1);
  }
}

export class FakeSingleInstanceHost implements SingleInstanceHost {
  quitCount = 0;
  #secondInstanceListener: ((argv: readonly string[]) => void) | null = null;

  constructor(private readonly lockGranted: boolean) {}

  requestSingleInstanceLock(): boolean {
    return this.lockGranted;
  }

  onSecondInstance(listener: (argv: readonly string[]) => void): void {
    this.#secondInstanceListener = listener;
  }

  quit(): void {
    this.quitCount += 1;
  }

  get hasSecondInstanceListener(): boolean {
    return this.#secondInstanceListener !== null;
  }

  launchSecondInstance(argv: readonly string[] = ['pilot']): void {
    this.#secondInstanceListener?.(argv);
  }
}
