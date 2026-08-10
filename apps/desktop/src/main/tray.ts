import { nullLogger, toPilotError, type InteractionState, type Logger } from '@pilot/shared';
import type { PilotViewState } from '@pilot/platform';

/**
 * Menu bar (tray) item.
 *
 * Pilot lives in the menu bar: the tray item is the only always-present
 * affordance and it must show, at a glance, whether Pilot is observing. The
 * menu is rebuilt from the view state so there is exactly one source of truth
 * for what the user sees.
 *
 * A tray is not guaranteed to exist — Linux without a StatusNotifier host is
 * the case that matters for development. {@link TrayController.create} reports
 * that as an explicit unavailable state rather than throwing or silently
 * skipping.
 */

export type TrayMenuItemId =
  'status' | 'toggle-panel' | 'toggle-observation' | 'pause-resume' | 'quit';

export interface TrayMenuItem {
  readonly id: TrayMenuItemId | `separator-${number}`;
  readonly type: 'normal' | 'separator' | 'checkbox';
  readonly label: string;
  readonly enabled: boolean;
  readonly checked?: boolean;
}

export interface TrayHandle {
  setToolTip(tooltip: string): void;
  setMenu(items: readonly TrayMenuItem[]): void;
  onClick(listener: () => void): void;
  destroy(): void;
}

export interface TrayHost {
  create(): TrayHandle;
}

export interface TrayActions {
  readonly togglePanel: () => void;
  readonly toggleObservation: (enabled: boolean) => void;
  readonly setPaused: (paused: boolean) => void;
  readonly quit: () => void;
}

/** Short, user-facing label for each interaction state. */
export const TRAY_STATE_LABELS: Readonly<Record<InteractionState, string>> = {
  idle: 'Idle',
  'needs-permission': 'Needs permission',
  paused: 'Paused',
  observing: 'Observing',
  listening: 'Listening',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  'observing-screen': 'Looking at the screen',
  speaking: 'Speaking',
  error: 'Error',
};

export function buildTrayMenu(
  view: PilotViewState,
  panelVisible: boolean,
): readonly TrayMenuItem[] {
  const windowLabel =
    view.selectedWindow === null ? 'No window selected' : view.selectedWindow.title;
  const paused = view.state === 'paused';
  return [
    {
      id: 'status',
      type: 'normal',
      label: `${TRAY_STATE_LABELS[view.state]} — ${windowLabel}`,
      enabled: false,
    },
    { id: 'separator-0', type: 'separator', label: '', enabled: true },
    {
      id: 'toggle-panel',
      type: 'normal',
      label: panelVisible ? 'Hide Pilot' : 'Show Pilot',
      enabled: true,
    },
    {
      id: 'toggle-observation',
      type: 'checkbox',
      label: 'Observe selected window',
      enabled: view.selectedWindow !== null,
      checked: view.observationEnabled,
    },
    {
      id: 'pause-resume',
      type: 'normal',
      label: paused ? 'Resume' : 'Pause',
      enabled: true,
    },
    { id: 'separator-1', type: 'separator', label: '', enabled: true },
    { id: 'quit', type: 'normal', label: 'Quit Pilot', enabled: true },
  ];
}

export function buildTrayTooltip(view: PilotViewState): string {
  if (view.state === 'error' && view.lastError !== null) {
    return `Pilot — ${view.lastError.userMessage}`;
  }
  return `Pilot — ${TRAY_STATE_LABELS[view.state]}`;
}

export type TrayAvailability =
  { readonly available: true } | { readonly available: false; readonly reason: string };

export interface TrayControllerOptions {
  readonly host: TrayHost;
  readonly actions: TrayActions;
  readonly logger?: Logger;
}

export class TrayController {
  readonly #host: TrayHost;
  readonly #actions: TrayActions;
  readonly #logger: Logger;
  #handle: TrayHandle | null = null;
  #availability: TrayAvailability = { available: false, reason: 'not created yet' };
  #panelVisible = false;
  #view: PilotViewState | null = null;

  constructor(options: TrayControllerOptions) {
    this.#host = options.host;
    this.#actions = options.actions;
    this.#logger = options.logger ?? nullLogger;
  }

  get availability(): TrayAvailability {
    return this.#availability;
  }

  /**
   * Attempts to create the menu bar item. A failure is reported, not thrown:
   * the app is still usable through the panel, and the caller surfaces the
   * degraded state to the user.
   */
  create(): TrayAvailability {
    try {
      const handle = this.#host.create();
      handle.onClick(() => this.#actions.togglePanel());
      this.#handle = handle;
      this.#availability = { available: true };
    } catch (cause) {
      const error = toPilotError(cause, 'platform-unavailable');
      this.#logger.warn('menu bar item unavailable', { code: error.code });
      this.#handle = null;
      this.#availability = { available: false, reason: error.userMessage };
    }
    return this.#availability;
  }

  setPanelVisible(visible: boolean): void {
    this.#panelVisible = visible;
    this.#render();
  }

  update(view: PilotViewState): void {
    this.#view = view;
    this.#render();
  }

  /** Routes a menu selection to the matching action. */
  select(id: TrayMenuItem['id']): void {
    switch (id) {
      case 'toggle-panel':
        this.#actions.togglePanel();
        return;
      case 'toggle-observation':
        this.#actions.toggleObservation(!(this.#view?.observationEnabled ?? false));
        return;
      case 'pause-resume':
        this.#actions.setPaused(this.#view?.state !== 'paused');
        return;
      case 'quit':
        this.#actions.quit();
        return;
      default:
        return;
    }
  }

  dispose(): void {
    this.#handle?.destroy();
    this.#handle = null;
    this.#availability = { available: false, reason: 'disposed' };
  }

  #render(): void {
    if (this.#handle === null || this.#view === null) {
      return;
    }
    this.#handle.setToolTip(buildTrayTooltip(this.#view));
    this.#handle.setMenu(buildTrayMenu(this.#view, this.#panelVisible));
  }
}
