import {
  nullLogger,
  type Logger,
  type ObservedWindow,
  type WindowGeometry,
  type WindowId,
} from '@pilot/shared';
import type { Unsubscribe, WindowAdapter, WindowEvent } from '@pilot/platform';
import { Poller } from '../polling.js';
import {
  windowGetOperation,
  windowListOperation,
  type WindowSnapshot,
} from '../protocol/window-ops.js';
import { TypedEmitter } from '../transport/emitter.js';
import type { HelperTransportState, NativeHelperTransport } from '../transport/helper-transport.js';
import { diffWindowSnapshots } from './window-diff.js';
import {
  isSelectableWindow,
  macWindowNumber,
  toObservedWindow,
  toWindowGeometry,
} from './window-model.js';

/**
 * macOS `WindowAdapter` (system-design §5), backed by the native helper.
 *
 * Enumeration is a request; lifecycle is a diff of consecutive enumerations
 * (`src/windows/window-diff.ts`). The adapter's own job is the three things
 * that sit around that:
 *
 * 1. **Only poll when watched.** The timer starts on the first `subscribe` and
 *    stops on the last unsubscribe.
 * 2. **Reconcile across helper restarts.** PR-003's supervisor restarts the
 *    helper on a crash; the adapter listens for the transition back to `ready`
 *    and forces a tick. Because window ids are pure functions of the
 *    `CGWindowID` (`src/windows/window-model.ts`), the new process re-derives
 *    the same ids, so the diff against the pre-crash snapshot is a real diff:
 *    a window that closed during the outage is reported closed, and one that
 *    merely survived is silent. No id is re-keyed, so an in-progress
 *    observation keeps ingesting.
 * 3. **Never invent state.** `list()` and `get()` always ask the helper. The
 *    cached snapshot exists to diff against, not to answer with.
 */

export const DEFAULT_WINDOW_POLL_INTERVAL_MS = 1_000;

interface WindowEvents extends Record<string, unknown> {
  event: WindowEvent;
}

export interface MacWindowAdapterOptions {
  readonly transport: NativeHelperTransport;
  /** Poll interval for lifecycle events. Only runs while subscribed. */
  readonly pollIntervalMs?: number;
  /**
   * Include menu-bar extras, the Dock and other non-application surfaces.
   * Off by default: they are never observation targets and their churn would
   * drown the lifecycle stream.
   */
  readonly includeAllLayers?: boolean;
  readonly logger?: Logger;
}

export class MacWindowAdapter implements WindowAdapter {
  readonly #transport: NativeHelperTransport;
  readonly #emitter = new TypedEmitter<WindowEvents>();
  readonly #logger: Logger;
  readonly #poller: Poller;
  readonly #includeAllLayers: boolean;
  readonly #offTransportState: Unsubscribe;

  #subscribers = 0;
  #snapshot: WindowSnapshot | null = null;
  #lastTransportState: HelperTransportState;

  constructor(options: MacWindowAdapterOptions) {
    this.#transport = options.transport;
    this.#logger = (options.logger ?? nullLogger).child('mac-windows');
    this.#includeAllLayers = options.includeAllLayers ?? false;
    this.#poller = new Poller(() => this.#poll(), {
      intervalMs: options.pollIntervalMs ?? DEFAULT_WINDOW_POLL_INTERVAL_MS,
      logger: this.#logger,
      name: 'windows',
    });
    this.#lastTransportState = options.transport.state;
    this.#offTransportState = options.transport.on('state', (state) => {
      const previous = this.#lastTransportState;
      this.#lastTransportState = state;
      // A helper that has just come back may be looking at a different desktop
      // than the one the cached snapshot describes. Reconcile immediately
      // rather than waiting out the poll interval; a window that closed during
      // the outage must not stay "open" for another second.
      if (state === 'ready' && previous !== 'ready' && this.#subscribers > 0) {
        void this.#poller.refresh();
      }
    });
  }

  /** The most recent snapshot, or `null` before the first successful poll. */
  get lastSnapshot(): WindowSnapshot | null {
    return this.#snapshot;
  }

  subscribe = (listener: (event: WindowEvent) => void): Unsubscribe => {
    const off = this.#emitter.on('event', listener);
    this.#subscribers += 1;
    this.#poller.start();
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      off();
      this.#subscribers -= 1;
      if (this.#subscribers <= 0) {
        this.#subscribers = 0;
        this.#poller.stop();
      }
    };
  };

  async list(): Promise<readonly ObservedWindow[]> {
    const snapshot = await this.#fetch();
    return this.#apply(snapshot);
  }

  async get(windowId: WindowId): Promise<ObservedWindow | null> {
    const windowNumber = macWindowNumber(windowId);
    if (windowNumber === null) {
      // A non-macOS id is not an error; it is simply not a window this
      // platform knows. `null` is the contract's answer for that.
      return null;
    }
    const response = await this.#transport.request(windowGetOperation, { windowNumber });
    const window = response.payload.window;
    if (window === null || !isSelectableWindow(window)) {
      return null;
    }
    const display = response.payload.display;
    return toObservedWindow(window, display === null ? [] : [display]);
  }

  async geometry(windowId: WindowId): Promise<WindowGeometry | null> {
    const windowNumber = macWindowNumber(windowId);
    if (windowNumber === null) {
      return null;
    }
    const response = await this.#transport.request(windowGetOperation, { windowNumber });
    const window = response.payload.window;
    if (window === null || !isSelectableWindow(window)) {
      return null;
    }
    const display = response.payload.display;
    return toWindowGeometry(window, display === null ? [] : [display]);
  }

  /** Runs one poll immediately, emitting whatever it finds. */
  async refresh(): Promise<void> {
    await this.#poller.refresh();
  }

  dispose(): void {
    this.#poller.stop();
    this.#offTransportState();
    this.#subscribers = 0;
  }

  // -------------------------------------------------------------------------

  async #fetch(): Promise<WindowSnapshot> {
    const response = await this.#transport.request(
      windowListOperation,
      this.#includeAllLayers ? { includeAllLayers: true } : {},
    );
    return response.payload;
  }

  /** Diffs against the cached snapshot, emits, and returns the new window list. */
  #apply(snapshot: WindowSnapshot): readonly ObservedWindow[] {
    const diff = diffWindowSnapshots(this.#snapshot, snapshot);
    this.#snapshot = snapshot;
    if (snapshot.titlesWithheld && snapshot.windows.length > 0) {
      // An independent cross-check on the TCC probe: macOS withholds every
      // window title when Screen Recording is not actually in force, whatever
      // the permission API claims. Worth a log line, never a thrown error —
      // a machine with no windows open looks the same.
      this.#logger.debug('macOS withheld every window title', {
        windowCount: snapshot.windows.length,
      });
    }
    for (const event of diff.events) {
      this.#emitter.emit('event', event);
    }
    return diff.windows;
  }

  async #poll(): Promise<void> {
    this.#apply(await this.#fetch());
  }
}
