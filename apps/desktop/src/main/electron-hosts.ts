import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import type { EventEnvelope } from '@pilot/shared';
import { IPC_TRANSPORT } from '../ipc/channels.js';
import type { PanelWindowHandle, PanelWindowHost } from './panel-window.js';
import type { TrayHandle, TrayHost, TrayMenuItem } from './tray.js';

/**
 * Electron implementations of the shell's ports.
 *
 * This is the only file besides `main/index.ts` that touches `electron`. It
 * contains no policy: every decision about *when* to show a window or *what*
 * the menu says lives in the pure controllers, so this layer stays thin enough
 * to review by eye rather than test.
 */

const PANEL_WIDTH = 420;
const PANEL_HEIGHT = 620;

export interface ElectronPanelHostOptions {
  readonly preloadPath: string;
  readonly rendererPath: string;
}

/**
 * Web preferences for the panel. These are the security settings named in
 * system-design §14 and must not be relaxed:
 *  - `nodeIntegration: false` — the renderer gets no Node API.
 *  - `contextIsolation: true` — the preload runs in a separate world.
 *  - `sandbox: true` — the renderer process is OS-sandboxed. This is why the
 *    preload is bundled to CommonJS: sandboxed preloads cannot use ESM.
 *  - `webSecurity` and navigation restrictions keep the panel on its own file.
 */
export function panelWebPreferences(preloadPath: string) {
  return {
    preload: preloadPath,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    spellcheck: false,
  } as const;
}

export function createElectronPanelHost(options: ElectronPanelHostOptions): PanelWindowHost {
  return {
    create(): PanelWindowHandle {
      const window = new BrowserWindow({
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT,
        show: false,
        frame: false,
        resizable: true,
        fullscreenable: false,
        skipTaskbar: true,
        title: 'Pilot',
        // Floats above ordinary windows without stealing the active app.
        alwaysOnTop: true,
        webPreferences: panelWebPreferences(options.preloadPath),
      });

      window.setMenuBarVisibility(false);

      // The panel is the only surface; it must never navigate anywhere else,
      // and it must never open a second window.
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => {
        event.preventDefault();
      });

      void window.loadFile(options.rendererPath);

      return {
        show: () => window.show(),
        hide: () => window.hide(),
        focus: () => window.focus(),
        isVisible: () => !window.isDestroyed() && window.isVisible(),
        isDestroyed: () => window.isDestroyed(),
        destroy: () => {
          if (!window.isDestroyed()) {
            window.destroy();
          }
        },
        send: (envelope: EventEnvelope) => {
          if (!window.isDestroyed()) {
            window.webContents.send(IPC_TRANSPORT.event, envelope);
          }
        },
        onClosed: (listener) => window.on('closed', listener),
      };
    },
  };
}

function toMenuTemplate(
  items: readonly TrayMenuItem[],
  onSelect: (id: TrayMenuItem['id']) => void,
): MenuItemConstructorOptions[] {
  return items.map((item) =>
    item.type === 'separator'
      ? { type: 'separator' }
      : {
          type: item.type,
          label: item.label,
          enabled: item.enabled,
          ...(item.checked === undefined ? {} : { checked: item.checked }),
          click: () => onSelect(item.id),
        },
  );
}

export interface ElectronTrayHostOptions {
  readonly onSelect: (id: TrayMenuItem['id']) => void;
}

export function createElectronTrayHost(options: ElectronTrayHostOptions): TrayHost {
  return {
    create(): TrayHandle {
      // An empty template image is a legitimate placeholder: PR-042 supplies
      // the real menu bar asset. Constructing a Tray still fails on platforms
      // with no status area, which the TrayController reports as unavailable.
      const tray = new Tray(nativeImage.createEmpty());
      tray.setTitle('Pilot');
      return {
        setToolTip: (tooltip) => tray.setToolTip(tooltip),
        setMenu: (items) =>
          tray.setContextMenu(Menu.buildFromTemplate(toMenuTemplate(items, options.onSelect))),
        onClick: (listener) => tray.on('click', listener),
        destroy: () => tray.destroy(),
      };
    },
  };
}

export function createElectronSingleInstanceHost() {
  return {
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    onSecondInstance: (listener: (argv: readonly string[]) => void) => {
      app.on('second-instance', (_event, argv) => listener(argv));
    },
    quit: () => app.quit(),
  };
}

/** Resolves a path relative to the compiled `dist/main` directory. */
export function resolveFromMain(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}
