import { nullLogger, toPilotError, type Logger } from '@pilot/shared';
import {
  DEFAULT_PUSH_TO_TALK_BINDING,
  type HotkeyAdapter,
  type HotkeyAvailability,
  type HotkeyBinding,
  type HotkeyCounters,
  type HotkeyEvent,
  type HotkeyStatus,
  type HotkeySyntheticReleaseReason,
  type Unsubscribe,
} from '@pilot/platform';
import { Poller } from '../polling.js';
import {
  HOTKEY_KEY_EVENT,
  HOTKEY_TAP_EVENT,
  hotkeyKeyEventSchema,
  hotkeyStartOperation,
  hotkeyStatusOperation,
  hotkeyStopOperation,
  hotkeyTapEventSchema,
  type NativeHotkeyStatus,
} from '../protocol/hotkey-ops.js';
import { TypedEmitter } from '../transport/emitter.js';
import type { HelperTransportState, NativeHelperTransport } from '../transport/helper-transport.js';
import { HotkeyCoalescer, type CoalescedUp } from './coalescer.js';

/**
 * macOS `HotkeyAdapter` (PR-015), backed by the native `CGEventTap`.
 *
 * ## What this class is responsible for
 *
 * The tap itself lives in Swift because only a `CGEventTap` hears a key while
 * another application has focus — the whole point of push-to-talk. Everything
 * that can be decided without macOS lives here instead, where it has tests
 * that actually run (runbook amendment 8):
 *
 * 1. **Coalescing.** `HotkeyCoalescer`, clock-injected. The native side drops
 *    repeats too; this is the layer that is *proven* to.
 * 2. **The pairing invariant.** Every `hotkey-down` gets exactly one
 *    `hotkey-up`. Four things can take the release away — the system disabling
 *    the tap, the helper crashing, `stop()`/`dispose()`, and macOS simply
 *    losing a modifier key-up — and all four are converted into a synthetic
 *    release here, before the availability change that explains them.
 * 3. **Typed unavailability.** A missing Accessibility grant is a `HotkeyStatus`,
 *    not a thrown error: system-design §16 requires the user keep a way to ask
 *    a question, and PR-025's `isTextFallbackAvailable(state)` is what the panel
 *    tests to keep the text box live. An exception here would tempt a caller
 *    into treating a routine, user-fixable condition as a crash.
 * 4. **Reconnection.** The tap dies with the helper process. On the transport's
 *    return to `ready` the adapter re-issues `hotkey.start`, because a hotkey
 *    that silently stops working after a helper restart is the exact failure
 *    this PR is meant to make impossible.
 *
 * ## Why it never becomes a keylogger
 *
 * The narrow wire schema is described in `src/protocol/hotkey-ops.ts`; the
 * early return in the native callback is in `HotkeyTap.swift`. The host-side
 * share of that guarantee is here and is small enough to state completely:
 * a `hotkey.key` event whose `keyCode` is not the one this adapter configured
 * is **discarded**, and nothing but a phase, a timestamp and counts is ever
 * logged or emitted. There is no code path in this file that reads a character,
 * a modifier flag set, or any key code other than the configured one.
 */

export const DEFAULT_HOLD_WATCHDOG_INTERVAL_MS = 1_000;

interface HotkeyEvents extends Record<string, unknown> {
  event: HotkeyEvent;
}

export interface MacHotkeyAdapterOptions {
  readonly transport: NativeHelperTransport;
  /** Defaults to Right Option (`DEFAULT_PUSH_TO_TALK_BINDING`). */
  readonly binding?: HotkeyBinding;
  /** Injected: no library code in this repository reads the wall clock. */
  readonly clock?: () => number;
  readonly logger?: Logger;
  /** How often the stuck-key watchdog runs while listening. */
  readonly holdWatchdogIntervalMs?: number;
  /** See `HotkeyCoalescerOptions.minRetriggerMs`. */
  readonly minRetriggerMs?: number;
  /** See `HotkeyCoalescerOptions.maxHoldMs`. */
  readonly maxHoldMs?: number;
}

function availabilityFor(status: NativeHotkeyStatus): HotkeyAvailability {
  switch (status.tap) {
    case 'active':
      return { status: 'active' };
    case 'stopped':
      return { status: 'stopped' };
    case 'accessibility-denied':
      return {
        status: 'unavailable',
        reason: 'permission-missing',
        permission: 'accessibility',
        detail: status.detail === '' ? 'AXIsProcessTrusted() is false' : status.detail,
      };
    case 'creation-failed':
      return {
        status: 'unavailable',
        reason: 'listener-rejected',
        detail: status.detail === '' ? 'CGEventTapCreate returned null' : status.detail,
      };
    case 'disabled':
      return {
        status: 'unavailable',
        reason: 'listener-disabled',
        detail: status.detail === '' ? 'the event tap was disabled by the system' : status.detail,
      };
  }
}

function sameAvailability(a: HotkeyAvailability, b: HotkeyAvailability): boolean {
  if (a.status !== b.status) {
    return false;
  }
  if (a.status === 'unavailable' && b.status === 'unavailable') {
    return a.reason === b.reason && a.detail === b.detail;
  }
  return true;
}

export class MacHotkeyAdapter implements HotkeyAdapter {
  readonly #transport: NativeHelperTransport;
  readonly #emitter = new TypedEmitter<HotkeyEvents>();
  readonly #logger: Logger;
  readonly #clock: () => number;
  readonly #coalescer: HotkeyCoalescer;
  readonly #poller: Poller;
  readonly #offTransportEvent: Unsubscribe;
  readonly #offTransportState: Unsubscribe;

  #binding: HotkeyBinding;
  #availability: HotkeyAvailability = { status: 'stopped' };
  #wanted = false;
  #lastTransportState: HelperTransportState;
  #listenerDisabled = 0;
  #listenerRestored = 0;
  #foreignKeyEvents = 0;
  #disposed = false;
  /**
   * Bumped by every event-driven status change.
   *
   * A `hotkey.start` response and a `hotkey.tap` event can reach the host in
   * the same read, and the transport dispatches both before the awaited
   * continuation of the request runs — so the *older* response would otherwise
   * overwrite the *newer* event. The request path applies its status only when
   * this counter has not moved since the request was issued.
   */
  #eventGeneration = 0;

  constructor(options: MacHotkeyAdapterOptions) {
    this.#transport = options.transport;
    this.#binding = options.binding ?? DEFAULT_PUSH_TO_TALK_BINDING;
    this.#logger = (options.logger ?? nullLogger).child('mac-hotkey');
    this.#clock = options.clock ?? ((): number => Date.now());
    this.#coalescer = new HotkeyCoalescer({
      clock: this.#clock,
      ...(options.minRetriggerMs === undefined ? {} : { minRetriggerMs: options.minRetriggerMs }),
      ...(options.maxHoldMs === undefined ? {} : { maxHoldMs: options.maxHoldMs }),
    });
    this.#poller = new Poller(() => this.#watchdogTick(), {
      intervalMs: options.holdWatchdogIntervalMs ?? DEFAULT_HOLD_WATCHDOG_INTERVAL_MS,
      logger: this.#logger,
      name: 'hotkey-hold',
    });

    this.#offTransportEvent = options.transport.on('event', (message) => {
      this.#onHelperEvent(message.op, message.payload);
    });
    this.#lastTransportState = options.transport.state;
    this.#offTransportState = options.transport.on('state', (state) => {
      const previous = this.#lastTransportState;
      this.#lastTransportState = state;
      this.#onTransportState(previous, state);
    });
  }

  subscribe = (listener: (event: HotkeyEvent) => void): Unsubscribe => {
    return this.#emitter.on('event', listener);
  };

  /** Key codes this adapter received and discarded because it did not bind them. */
  get discardedForeignKeyEvents(): number {
    return this.#foreignKeyEvents;
  }

  async status(): Promise<HotkeyStatus> {
    const generation = this.#eventGeneration;
    const response = await this.#transport.request(hotkeyStatusOperation, {});
    if (generation === this.#eventGeneration) {
      this.#applyNativeStatus(response.payload.status);
    }
    return this.#status();
  }

  async start(binding?: HotkeyBinding): Promise<HotkeyStatus> {
    if (binding !== undefined && binding.keyCode !== this.#binding.keyCode) {
      // Rebinding closes any press on the old key: the user is no longer
      // holding the thing Pilot is listening for.
      this.#emitRelease(this.#coalescer.release('stopped'));
      this.#binding = binding;
    } else if (binding !== undefined) {
      this.#binding = binding;
    }
    this.#wanted = true;
    this.#coalescer.listen();
    const generation = this.#eventGeneration;
    const response = await this.#transport.request(hotkeyStartOperation, {
      binding: {
        keyCode: this.#binding.keyCode,
        label: this.#binding.label,
        isModifierKey: this.#binding.isModifierKey,
        requiredModifiers: [...this.#binding.requiredModifiers],
      },
    });
    if (generation === this.#eventGeneration) {
      this.#applyNativeStatus(response.payload.status);
    }
    if (this.#availability.status === 'active') {
      this.#poller.start();
    }
    return this.#status();
  }

  async stop(): Promise<HotkeyStatus> {
    this.#wanted = false;
    this.#poller.stop();
    this.#emitRelease(this.#coalescer.unlisten('stopped'));
    try {
      const response = await this.#transport.request(hotkeyStopOperation, {});
      this.#applyNativeStatus(response.payload.status);
    } catch (error) {
      // Stopping a tap that is already gone is not a failure the caller can do
      // anything about; the local state is what the machine reads.
      this.#logger.debug('hotkey stop could not reach the helper', {
        code: toPilotError(error).code,
      });
      this.#setAvailability({ status: 'stopped' });
    }
    return this.#status();
  }

  /**
   * Runs the stuck-key watchdog once. The poller calls it; tests call it
   * directly so the rule is exercised without waiting on wall-clock time.
   */
  sweep(): void {
    const released = this.#coalescer.sweep();
    if (released !== null) {
      this.#logger.warn('push-to-talk key was held past the maximum; releasing it', {
        heldMs: released.heldMs,
      });
      this.#emitRelease(released);
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#wanted = false;
    this.#poller.stop();
    this.#emitRelease(this.#coalescer.unlisten('stopped'));
    this.#offTransportEvent();
    this.#offTransportState();
  }

  // -------------------------------------------------------------------------

  #onHelperEvent(op: string, payload: unknown): void {
    if (op === HOTKEY_KEY_EVENT) {
      this.#onKeyEvent(payload);
      return;
    }
    if (op === HOTKEY_TAP_EVENT) {
      this.#onTapEvent(payload);
    }
  }

  #onKeyEvent(payload: unknown): void {
    const parsed = hotkeyKeyEventSchema.safeParse(payload);
    if (!parsed.success) {
      // A malformed hotkey event is never guessed at. `strictObject` also means
      // an event carrying an extra field lands here rather than being read.
      this.#logger.warn('discarded a malformed hotkey event', {
        issues: parsed.error.issues.length,
      });
      return;
    }
    if (parsed.data.keyCode !== this.#binding.keyCode) {
      // The only key this adapter will act on is the one it configured. A
      // report about any other key is dropped here, unread and unlogged beyond
      // this count.
      this.#foreignKeyEvents += 1;
      return;
    }
    const outcome = this.#coalescer.accept({
      phase: parsed.data.phase,
      autorepeat: parsed.data.autorepeat,
      sequence: parsed.data.sequence,
    });
    if ('suppressed' in outcome) {
      this.#logger.debug('coalesced a push-to-talk transition', {
        reason: outcome.suppressed.reason,
        phase: outcome.suppressed.phase,
      });
      return;
    }
    if (outcome.emit.type === 'down') {
      this.#emitter.emit('event', {
        type: 'hotkey-down',
        binding: this.#binding,
        at: outcome.emit.at,
        sequence: outcome.emit.sequence,
      });
      return;
    }
    this.#emitRelease(outcome.emit);
  }

  #onTapEvent(payload: unknown): void {
    const parsed = hotkeyTapEventSchema.safeParse(payload);
    if (!parsed.success) {
      this.#logger.warn('discarded a malformed hotkey tap event', {
        issues: parsed.error.issues.length,
      });
      return;
    }
    const { change, status } = parsed.data;
    if (change === 'disabled-by-timeout' || change === 'disabled-by-user-input') {
      this.#listenerDisabled += 1;
      this.#logger.warn('macOS disabled the push-to-talk event tap', { change });
    }
    if (change === 're-enabled') {
      this.#listenerRestored += 1;
      this.#logger.info('push-to-talk event tap re-enabled', {});
    }
    this.#eventGeneration += 1;
    this.#applyNativeStatus(status);
  }

  #onTransportState(previous: HelperTransportState, next: HelperTransportState): void {
    if (!this.#wanted) {
      return;
    }
    if (next !== 'ready' && previous === 'ready') {
      // The tap died with the process. Close the press before saying why, so a
      // consumer that tears down on "unavailable" has already stopped
      // recording.
      this.#emitRelease(this.#coalescer.release('helper-lost'));
      this.#setAvailability({
        status: 'unavailable',
        reason: 'helper-unavailable',
        detail: `helper transport is ${next}`,
      });
      return;
    }
    if (next === 'ready' && previous !== 'ready') {
      // A new helper process has no tap. Reinstall it rather than waiting for
      // someone to notice the shortcut stopped working.
      this.#logger.info('reinstalling the push-to-talk tap after a helper restart', {});
      void this.start(this.#binding).catch((error: unknown) => {
        this.#logger.warn('could not reinstall the push-to-talk tap', {
          code: toPilotError(error).code,
        });
      });
    }
  }

  #applyNativeStatus(status: NativeHotkeyStatus): void {
    const availability = availabilityFor(status);
    if (availability.status === 'active') {
      this.#coalescer.listen();
      if (this.#wanted) {
        this.#poller.start();
      }
    } else {
      this.#poller.stop();
      this.#emitRelease(
        this.#coalescer.unlisten(
          availability.status === 'stopped'
            ? 'stopped'
            : availability.reason === 'helper-unavailable'
              ? 'helper-lost'
              : 'listener-lost',
        ),
      );
    }
    this.#setAvailability(availability);
  }

  #setAvailability(availability: HotkeyAvailability): void {
    if (sameAvailability(this.#availability, availability)) {
      return;
    }
    this.#availability = availability;
    this.#emitter.emit('event', {
      type: 'hotkey-availability-changed',
      availability,
      binding: this.#binding,
      at: this.#clock(),
    });
  }

  #emitRelease(released: CoalescedUp | null): void {
    if (released === null) {
      return;
    }
    this.#emitter.emit('event', {
      type: 'hotkey-up',
      binding: this.#binding,
      at: released.at,
      sequence: released.sequence,
      heldMs: released.heldMs,
      synthetic: released.synthetic,
      ...(released.synthetic && released.reason !== undefined ? { reason: released.reason } : {}),
    });
  }

  async #watchdogTick(): Promise<void> {
    this.sweep();
  }

  #status(): HotkeyStatus {
    const counts = this.#coalescer.counts;
    const counters: HotkeyCounters = {
      downs: counts.downs,
      ups: counts.ups,
      suppressed: counts.suppressed,
      synthetic: counts.synthetic,
      listenerDisabled: this.#listenerDisabled,
      listenerRestored: this.#listenerRestored,
    };
    return {
      binding: this.#binding,
      availability: this.#availability,
      held: this.#coalescer.held,
      counters,
    };
  }
}

/**
 * The synthetic release reasons, re-exported so a consumer can switch on them
 * without importing two packages.
 */
export type { HotkeySyntheticReleaseReason };
