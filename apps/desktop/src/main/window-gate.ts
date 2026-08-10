import {
  nullLogger,
  PilotError,
  toPilotError,
  type Logger,
  type ObservedWindow,
  type SerializedPilotError,
  type WindowId,
} from '@pilot/shared';
import type { InteractionCommand, PilotViewState, Subscribe, WindowAdapter } from '@pilot/platform';
import type {
  ObservationNotice,
  ObservationNoticeReason,
  PermissionGateState,
  WindowAction,
  WindowGateState,
} from '../ipc/schemas.js';
import {
  buildPermissionOnboardingView,
  permissionsAllowObservation,
} from '../permissions/view-model.js';

/**
 * Main-process owner of the window list and the observation controls.
 *
 * Four things happen here and nowhere else:
 *
 *  1. **The window list is read asynchronously, and that is visible.**
 *     `listing` and a null `listedAt` are distinct from "there are no windows",
 *     so the picker never renders an empty list it has not actually read
 *     (delivery rule: no silent states).
 *  2. **Permissions gate observation in the main process too.** The panel
 *     already hides the controls when {@link permissionsAllowObservation} says
 *     no, but the renderer is untrusted input (system-design §14): a `start`
 *     that arrives anyway is refused here, with a typed reason.
 *  3. **The selected window closing is handled without the panel.**
 *     system-design §16 requires observation to stop, the buffer to clear and
 *     the user to be prompted for a new selection. Two of those are the
 *     interaction controller's (through {@link ObservationInteraction}); the
 *     prompt is this gate's, and it survives the panel being shut.
 *  4. **Selection is never duplicated.** `PilotViewState.selectedWindow` is the
 *     one answer to "what is Pilot watching"; this gate holds the list and the
 *     prompt, and reads the selection from the controller.
 */

/** A window-lifecycle change the interaction side has to know about. */
export type WindowFeedEvent =
  | { readonly type: 'windows-changed'; readonly windows: readonly ObservedWindow[] }
  | { readonly type: 'window-closed'; readonly windowId: WindowId };

/**
 * What the gate needs from the interaction side.
 *
 * `report` is deliberately shaped as two members of `@pilot/interaction`'s
 * `InteractionEvent` union, so when PR-029 wires the real controller the
 * implementation is `(event) => controller.send(event)` — the identity
 * function — rather than a translation layer that could drift.
 */
export interface ObservationInteraction {
  snapshot(): PilotViewState;
  subscribe: Subscribe<PilotViewState>;
  dispatch(command: InteractionCommand): void;
  report(event: WindowFeedEvent): void;
}

/** The permission half of the gate rule. {@link PermissionGate} satisfies it. */
export interface ObservationPermissionSource {
  snapshot(): PermissionGateState;
  subscribe(listener: (state: PermissionGateState) => void): () => void;
}

export type WindowGateListener = (state: WindowGateState) => void;

export interface WindowGateOptions {
  readonly windows: WindowAdapter;
  readonly interaction: ObservationInteraction;
  readonly permissions: ObservationPermissionSource;
  /**
   * True when the shell can drive window-lifecycle events from the panel.
   * Published so the panel never offers a control the shell would refuse.
   */
  readonly demoEvents?: boolean;
  readonly logger?: Logger;
  readonly now?: () => number;
}

/** Why an action was refused, in words the panel can show unchanged. */
const REFUSALS = {
  blocked: 'Pilot cannot watch a window until Screen Recording is allowed.',
  paused: 'Pilot is paused. Resume it before changing what it watches.',
  alreadyPaused: 'Pilot is already paused.',
  notPaused: 'Pilot is not paused.',
  noSelection: 'Choose a window before starting observation.',
  notListed: 'That window is no longer open. Choose another one.',
  offScreen: 'That window is minimised or hidden, so there is nothing to watch.',
} as const;

export class WindowGate {
  readonly #windows: WindowAdapter;
  readonly #interaction: ObservationInteraction;
  readonly #permissions: ObservationPermissionSource;
  readonly #demoEvents: boolean;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #listeners = new Set<WindowGateListener>();
  readonly #unsubscribes: (() => void)[] = [];

  #list: readonly ObservedWindow[] = [];
  #listedAt: number | null = null;
  #listing = false;
  #notice: ObservationNotice | null = null;
  #lastError: SerializedPilotError | null = null;
  #disposed = false;

  constructor(options: WindowGateOptions) {
    this.#windows = options.windows;
    this.#interaction = options.interaction;
    this.#permissions = options.permissions;
    this.#demoEvents = options.demoEvents ?? false;
    this.#logger = options.logger ?? nullLogger;
    this.#now = options.now ?? (() => Date.now());

    this.#unsubscribes.push(
      this.#windows.subscribe((event) => {
        if (this.#disposed) {
          return;
        }
        switch (event.type) {
          case 'window-closed':
            this.#onWindowClosed(event.windowId);
            void this.refresh();
            return;
          case 'window-changed':
            this.#onWindowChanged(event.window);
            return;
          case 'window-list-changed':
            void this.refresh();
            return;
          case 'screen-locked':
          case 'screen-unlocked':
            // Capture and buffer clearing on lock belong to the interaction
            // controller's table and to PR-012's capture session, neither of
            // which this shell owns yet. Recorded rather than acted on, so it
            // is not mistaken for a handled case. Closed by PR-029.
            this.#logger.info('screen lock event ignored by the window gate', {
              event: event.type,
            });
            return;
        }
      }),
    );

    // Screen Recording being withdrawn is one of the capture-lifecycle
    // conditions (system-design §6). Losing it while Pilot is watching must
    // stop the watching, not merely grey out a button on next render.
    this.#unsubscribes.push(
      this.#permissions.subscribe(() => {
        if (this.#disposed) {
          return;
        }
        this.#enforcePermissions();
      }),
    );
  }

  snapshot(): WindowGateState {
    return {
      windows: this.#list,
      listedAt: this.#listedAt,
      listing: this.#listing,
      notice: this.#notice,
      lastError: this.#lastError,
      demoEvents: this.#demoEvents,
    };
  }

  subscribe(listener: WindowGateListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** True when permissions currently allow Pilot to observe at all (PR-008). */
  allowsObservation(): boolean {
    return permissionsAllowObservation(buildPermissionOnboardingView(this.#permissions.snapshot()));
  }

  /** Reads the window list from the platform. Safe to call repeatedly. */
  async refresh(): Promise<WindowGateState> {
    this.#assertUsable();
    this.#listing = true;
    this.#publish();
    try {
      const windows = await this.#windows.list();
      this.#list = [...windows];
      this.#listedAt = this.#now();
      this.#interaction.report({ type: 'windows-changed', windows: this.#list });
      this.#reconcileSelection();
    } catch (cause) {
      this.#fail(cause, 'refresh');
    } finally {
      this.#listing = false;
      this.#publish();
    }
    return this.snapshot();
  }

  /** Serves one validated renderer action. */
  async act(action: WindowAction): Promise<WindowGateState> {
    this.#assertUsable();
    switch (action.type) {
      case 'refresh':
        return this.refresh();
      case 'select':
        return this.#select(action.windowId);
      case 'start':
        return this.#setObservationEnabled(true);
      case 'stop':
        return this.#setObservationEnabled(false);
      case 'pause':
        return this.#interaction.snapshot().state === 'paused'
          ? this.#refuse('observation-paused', REFUSALS.alreadyPaused)
          : this.#dispatch({ type: 'pause' });
      case 'resume':
        return this.#interaction.snapshot().state === 'paused'
          ? this.#dispatch({ type: 'resume' })
          : this.#refuse('observation-paused', REFUSALS.notPaused);
      case 'dismiss-notice':
        this.#notice = null;
        this.#lastError = null;
        this.#publish();
        return this.snapshot();
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const unsubscribe of this.#unsubscribes) {
      unsubscribe();
    }
    this.#unsubscribes.length = 0;
    this.#listeners.clear();
  }

  // -- actions --------------------------------------------------------------

  #select(windowId: WindowId): WindowGateState {
    const window = this.#list.find((entry) => entry.windowId === windowId);
    if (window === undefined) {
      return this.#refuse('window-not-found', REFUSALS.notListed, { windowId });
    }
    if (!window.isOnScreen) {
      return this.#refuse('window-not-found', REFUSALS.offScreen, { windowId });
    }
    const refusal = this.#guard(true);
    if (refusal !== null) {
      return refusal;
    }
    // The controller resolves `select-window` against the window list it was
    // last told about, so the list goes first. Selecting also answers the §16
    // prompt, which is why the notice clears here and not on the next render.
    this.#interaction.report({ type: 'windows-changed', windows: this.#list });
    this.#interaction.dispatch({ type: 'select-window', windowId });
    this.#notice = null;
    this.#lastError = null;
    this.#publish();
    return this.snapshot();
  }

  #setObservationEnabled(enabled: boolean): WindowGateState {
    if (enabled && this.#interaction.snapshot().selectedWindow === null) {
      return this.#refuse('window-not-found', REFUSALS.noSelection);
    }
    const refusal = this.#guard(enabled);
    if (refusal !== null) {
      return refusal;
    }
    return this.#dispatch({ type: 'set-observation-enabled', enabled });
  }

  #dispatch(command: InteractionCommand): WindowGateState {
    this.#interaction.dispatch(command);
    this.#lastError = null;
    this.#publish();
    return this.snapshot();
  }

  /**
   * The rules the panel also applies, enforced where they cannot be bypassed.
   * Returns null when the action may proceed.
   *
   * Pausing and resuming are not routed through here: they are the way *out* of
   * the paused state, so a paused Pilot cannot be allowed to refuse them.
   */
  #guard(requirePermission: boolean): WindowGateState | null {
    if (requirePermission && !this.allowsObservation()) {
      return this.#refuse('permission-denied', REFUSALS.blocked);
    }
    if (this.#interaction.snapshot().state === 'paused') {
      return this.#refuse('observation-paused', REFUSALS.paused);
    }
    return null;
  }

  // -- platform events ------------------------------------------------------

  #onWindowChanged(window: ObservedWindow): void {
    const index = this.#list.findIndex((entry) => entry.windowId === window.windowId);
    if (index < 0) {
      return;
    }
    const next = [...this.#list];
    next[index] = window;
    this.#list = next;
    this.#listedAt = this.#now();
    // A retitled window must reach the selected-window summary, or the user is
    // reading a stale claim about what Pilot is watching.
    this.#interaction.report({ type: 'windows-changed', windows: this.#list });
    this.#publish();
  }

  #onWindowClosed(windowId: WindowId): void {
    const view = this.#interaction.snapshot();
    const selected = view.selectedWindow;
    if (selected === null || selected.windowId !== windowId) {
      return;
    }
    // Order matters: the notice records what was true *before* the controller
    // clears the selection and switches observation off.
    this.#noteStop('selected-window-closed', selected, view.observationEnabled);
    this.#interaction.report({ type: 'window-closed', windowId });
  }

  /**
   * A window can also vanish without a `window-closed` event — a list that
   * simply no longer holds it. §16 does not care which signal arrived.
   */
  #reconcileSelection(): void {
    const view = this.#interaction.snapshot();
    const selected = view.selectedWindow;
    if (selected === null) {
      return;
    }
    if (this.#list.some((entry) => entry.windowId === selected.windowId)) {
      return;
    }
    this.#noteStop('selected-window-closed', selected, view.observationEnabled);
    this.#interaction.report({ type: 'window-closed', windowId: selected.windowId });
  }

  #enforcePermissions(): void {
    if (this.allowsObservation()) {
      return;
    }
    const view = this.#interaction.snapshot();
    if (!view.observationEnabled && view.selectedWindow === null) {
      return;
    }
    if (view.observationEnabled) {
      this.#interaction.dispatch({ type: 'set-observation-enabled', enabled: false });
    }
    this.#noteStop('observation-permission-lost', view.selectedWindow, view.observationEnabled);
  }

  #noteStop(
    reason: ObservationNoticeReason,
    window: ObservedWindow | null,
    wasObserving: boolean,
  ): void {
    this.#notice = { reason, window, wasObserving, at: this.#now() };
    // Identifiers only: a window title is screen content and must not be logged.
    this.#logger.warn('observation stopped', {
      reason,
      windowId: window?.windowId ?? null,
      wasObserving,
    });
    this.#publish();
  }

  // -- plumbing -------------------------------------------------------------

  #refuse(
    code: 'permission-denied' | 'observation-paused' | 'window-not-found',
    message: string,
    details: Record<string, unknown> = {},
  ): WindowGateState {
    this.#lastError = new PilotError(code, message, {
      userMessage: message,
      details,
    }).toJSON();
    this.#logger.warn('window action refused', { code, ...details });
    this.#publish();
    return this.snapshot();
  }

  #fail(cause: unknown, action: string): void {
    const error = toPilotError(cause);
    this.#lastError = error.toJSON();
    this.#logger.warn('window action failed', { action, code: error.code });
  }

  #publish(): void {
    const state = this.snapshot();
    for (const listener of this.#listeners) {
      listener(state);
    }
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new PilotError('internal', 'Window gate has been disposed', {
        userMessage: 'Pilot is shutting down.',
      });
    }
  }
}
