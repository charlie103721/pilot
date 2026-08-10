import {
  createEventEnvelope,
  nullLogger,
  toPilotError,
  type EventEnvelope,
  type IdFactory,
  type Logger,
} from '@pilot/shared';
import { panelVisibilityEvent } from '../ipc/channels.js';
import type { AnyEventChannel } from '../ipc/channels.js';

/**
 * Floating panel lifecycle.
 *
 * The panel is the whole visible surface of Pilot: there is no main window and
 * closing the panel must not quit the app (macOS menu bar behaviour). The
 * controller therefore treats "hidden" and "destroyed" as the same user-visible
 * state and recreates the window on demand.
 *
 * The Electron `BrowserWindow` sits behind {@link PanelWindowHost} so window
 * lifecycle can be tested without a display server.
 */

export interface PanelWindowHandle {
  show(): void;
  hide(): void;
  focus(): void;
  isVisible(): boolean;
  isDestroyed(): boolean;
  destroy(): void;
  /** Delivers an event envelope on the physical event transport. */
  send(envelope: EventEnvelope): void;
  /** Fires when the window is closed by the OS or the user rather than by us. */
  onClosed(listener: () => void): void;
}

export interface PanelWindowHost {
  create(): PanelWindowHandle;
}

export interface PanelControllerOptions {
  readonly host: PanelWindowHost;
  readonly ids: IdFactory;
  readonly now?: () => number;
  readonly logger?: Logger;
}

export class PanelController {
  readonly #host: PanelWindowHost;
  readonly #ids: IdFactory;
  readonly #now: () => number;
  readonly #logger: Logger;
  #handle: PanelWindowHandle | null = null;
  #disposed = false;

  constructor(options: PanelControllerOptions) {
    this.#host = options.host;
    this.#ids = options.ids;
    this.#now = options.now ?? (() => Date.now());
    this.#logger = options.logger ?? nullLogger;
  }

  isVisible(): boolean {
    const handle = this.#liveHandle();
    return handle !== null && handle.isVisible();
  }

  /** Creates the window if needed, shows and focuses it. Idempotent. */
  show(): boolean {
    this.#assertUsable();
    const handle = this.#liveHandle() ?? this.#create();
    handle.show();
    handle.focus();
    this.#emitVisibility(true);
    return true;
  }

  /** Hides without destroying, so reopening is instant. Idempotent. */
  hide(): boolean {
    this.#assertUsable();
    const handle = this.#liveHandle();
    if (handle !== null) {
      handle.hide();
    }
    this.#emitVisibility(false);
    return false;
  }

  toggle(): boolean {
    return this.isVisible() ? this.hide() : this.show();
  }

  setVisible(visible: boolean): boolean {
    return visible ? this.show() : this.hide();
  }

  /**
   * Sends an event envelope to the panel. Returns false when there is no live
   * window — a hidden panel is not an error, it just means nobody is listening
   * and the renderer will re-read the state when it next opens.
   *
   * A payload that fails its channel schema *does* throw: that is a bug in main,
   * and main is the side that is supposed to be trustworthy. Only the delivery
   * itself is treated as best effort.
   */
  broadcast<Payload>(channel: AnyEventChannel, payload: Payload): boolean {
    const handle = this.#liveHandle();
    if (handle === null) {
      return false;
    }
    const envelope = createEventEnvelope(channel, payload, {
      id: this.#ids.request(),
      issuedAt: this.#now(),
    });
    try {
      handle.send(envelope);
      return true;
    } catch (cause) {
      // A window can be destroyed between the liveness check and the send.
      this.#logger.warn('dropped panel event', {
        channel: channel.name,
        code: toPilotError(cause).code,
      });
      return false;
    }
  }

  dispose(): void {
    this.#disposed = true;
    const handle = this.#liveHandle();
    this.#handle = null;
    if (handle !== null) {
      handle.destroy();
    }
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw toPilotError(new Error('Panel controller has been disposed'));
    }
  }

  #liveHandle(): PanelWindowHandle | null {
    if (this.#handle === null) {
      return null;
    }
    if (this.#handle.isDestroyed()) {
      this.#handle = null;
      return null;
    }
    return this.#handle;
  }

  #create(): PanelWindowHandle {
    const handle = this.#host.create();
    handle.onClosed(() => {
      this.#handle = null;
      this.#logger.info('panel window closed');
    });
    this.#handle = handle;
    return handle;
  }

  #emitVisibility(visible: boolean): void {
    this.broadcast(panelVisibilityEvent, { visible });
  }
}
