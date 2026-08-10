import {
  nullLogger,
  PERMISSION_KINDS,
  PilotError,
  toPilotError,
  type Logger,
  type PermissionKind,
  type PermissionSnapshot,
  type SerializedPilotError,
} from '@pilot/shared';
import type { PermissionAdapter } from '@pilot/platform';
import type {
  PermissionAction,
  PermissionFixtureName,
  PermissionGateState,
} from '../ipc/schemas.js';
import type { PermissionSettingsShortcut } from './settings-shortcut.js';

/**
 * Main-process owner of permission state.
 *
 * Three things happen here and nowhere else:
 *
 *  1. **Every permission read is asynchronous, and that is visible.** A kind
 *     with a check, prompt or settings call in flight is listed in `pending`,
 *     so the panel can render "checking" distinctly from "refused" instead of
 *     showing a stale or empty row (delivery rule: no silent states).
 *  2. **Recovery needs no restart.** The gate subscribes to the adapter, so a
 *     permission the user grants in System Settings arrives as an event and is
 *     published to the panel. `refresh()` covers platforms that do not notify —
 *     macOS TCC does not — and the shell calls it whenever the panel is
 *     revealed.
 *  3. **A refused action is reported, not swallowed.** `lastError` holds the
 *     typed reason the last action failed until the user dismisses it.
 *
 * The gate knows nothing about *why* a permission matters; that is the
 * catalogue's job, in `src/permissions/catalog.ts`.
 */

export type PermissionGateListener = (state: PermissionGateState) => void;

/** Development-only source of named permission states. Absent in a real build. */
export interface PermissionFixtureSource {
  /** Applies a fixture to the underlying adapter. */
  apply(name: PermissionFixtureName): void;
  /** The fixture last applied, or null when none has been. */
  current(): PermissionFixtureName | null;
}

export interface PermissionGateOptions {
  readonly adapter: PermissionAdapter;
  readonly settings: PermissionSettingsShortcut;
  readonly fixtures?: PermissionFixtureSource;
  readonly logger?: Logger;
  readonly now?: () => number;
}

export class PermissionGate {
  readonly #adapter: PermissionAdapter;
  readonly #settings: PermissionSettingsShortcut;
  readonly #fixtures: PermissionFixtureSource | undefined;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #listeners = new Set<PermissionGateListener>();
  readonly #pending = new Set<PermissionKind>();
  readonly #unsubscribe: () => void;

  #snapshot: PermissionSnapshot | null = null;
  #checkedAt: number | null = null;
  #lastError: SerializedPilotError | null = null;
  #disposed = false;

  constructor(options: PermissionGateOptions) {
    this.#adapter = options.adapter;
    this.#settings = options.settings;
    this.#fixtures = options.fixtures;
    this.#logger = options.logger ?? nullLogger;
    this.#now = options.now ?? (() => Date.now());

    // An external change — the user editing System Settings while Pilot runs —
    // must reach the panel without anyone asking for it.
    this.#unsubscribe = this.#adapter.subscribe((status) => {
      if (this.#disposed || this.#snapshot === null) {
        return;
      }
      const current = this.#snapshot[status.kind];
      if (current.state === status.state && current.canRequest === status.canRequest) {
        return;
      }
      this.#snapshot = { ...this.#snapshot, [status.kind]: status };
      this.#checkedAt = this.#now();
      this.#logger.info('permission changed outside Pilot', {
        kind: status.kind,
        state: status.state,
      });
      this.#publish();
    });
  }

  snapshot(): PermissionGateState {
    return {
      snapshot: this.#snapshot,
      pending: [...this.#pending],
      checkedAt: this.#checkedAt,
      settings: this.#settings.availability(),
      lastError: this.#lastError,
      fixture: this.#fixtures?.current() ?? null,
    };
  }

  subscribe(listener: PermissionGateListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Reads every permission from the platform. Safe to call repeatedly. */
  async refresh(): Promise<PermissionGateState> {
    this.#assertUsable();
    for (const kind of PERMISSION_KINDS) {
      this.#pending.add(kind);
    }
    this.#publish();
    try {
      const snapshot = await this.#adapter.snapshot();
      this.#snapshot = snapshot;
      this.#checkedAt = this.#now();
    } catch (cause) {
      this.#fail(cause, 'refresh');
    } finally {
      this.#pending.clear();
      this.#publish();
    }
    return this.snapshot();
  }

  /** Prompts for one permission, if the platform still allows a prompt. */
  async request(kind: PermissionKind): Promise<PermissionGateState> {
    this.#assertUsable();
    this.#pending.add(kind);
    this.#publish();
    try {
      const status = await this.#adapter.request(kind);
      this.#snapshot = { ...(this.#snapshot ?? (await this.#adapter.snapshot())), [kind]: status };
      this.#checkedAt = this.#now();
    } catch (cause) {
      this.#fail(cause, 'request', { kind });
    } finally {
      this.#pending.delete(kind);
      this.#publish();
    }
    return this.snapshot();
  }

  /**
   * Opens the platform settings pane. On a platform without one this records a
   * typed `unsupported-capability` failure — the panel already knows the
   * shortcut is unavailable and disables the control, so reaching here means
   * something raced or a caller ignored the availability.
   */
  async openSettings(kind: PermissionKind): Promise<PermissionGateState> {
    this.#assertUsable();
    this.#pending.add(kind);
    this.#publish();
    try {
      await this.#settings.open(kind);
      this.#lastError = null;
    } catch (cause) {
      this.#fail(cause, 'open-settings', { kind });
    } finally {
      this.#pending.delete(kind);
      this.#publish();
    }
    return this.snapshot();
  }

  dismissError(): PermissionGateState {
    this.#lastError = null;
    this.#publish();
    return this.snapshot();
  }

  /** Serves one validated renderer action. */
  async act(action: PermissionAction): Promise<PermissionGateState> {
    switch (action.type) {
      case 'refresh':
        return this.refresh();
      case 'request':
        return this.request(action.kind);
      case 'open-settings':
        return this.openSettings(action.kind);
      case 'dismiss-error':
        return this.dismissError();
    }
  }

  /** Development builds only: loads a named permission state and re-reads it. */
  async applyFixture(name: PermissionFixtureName): Promise<PermissionGateState> {
    this.#assertUsable();
    if (this.#fixtures === undefined) {
      throw new PilotError('unsupported-capability', 'This build has no permission fixtures', {
        userMessage: 'Permission fixtures are only available in development builds.',
        details: { fixture: name },
      });
    }
    this.#fixtures.apply(name);
    this.#lastError = null;
    return this.refresh();
  }

  dispose(): void {
    this.#disposed = true;
    this.#unsubscribe();
    this.#listeners.clear();
  }

  #fail(cause: unknown, action: string, details: Record<string, unknown> = {}): void {
    const error = toPilotError(cause);
    this.#lastError = error.toJSON();
    // Codes and kinds only: a permission failure must not log screen content.
    this.#logger.warn('permission action failed', { action, code: error.code, ...details });
  }

  #publish(): void {
    const state = this.snapshot();
    for (const listener of this.#listeners) {
      listener(state);
    }
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new PilotError('internal', 'Permission gate has been disposed', {
        userMessage: 'Pilot is shutting down.',
      });
    }
  }
}
