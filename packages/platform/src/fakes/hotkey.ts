import {
  DEFAULT_PUSH_TO_TALK_BINDING,
  type HotkeyAdapter,
  type HotkeyAvailability,
  type HotkeyBinding,
  type HotkeyCounters,
  type HotkeyEvent,
  type HotkeyStatus,
  type HotkeySyntheticReleaseReason,
} from '../hotkey.js';
import { Emitter } from './support.js';

/**
 * Deterministic `HotkeyAdapter` (PR-015).
 *
 * Like every other fake here it owns no timer and no clock: a test presses the
 * key, advances the clock it supplied, and releases it. That is deliberate for
 * this adapter in particular, because the real one coalesces on elapsed time
 * and a fake that read the wall clock would make those tests flaky in exactly
 * the place the coalescing rules need to be pinned down.
 *
 * It enforces the same invariant the macOS adapter does — one `hotkey-up` per
 * `hotkey-down`, synthesised if necessary — so a consumer written against this
 * fake cannot accidentally depend on the pairing being optional.
 */
export interface FakeHotkeyAdapterOptions {
  readonly binding?: HotkeyBinding;
  readonly availability?: HotkeyAvailability;
  /** Supplies `at` on every event. Defaults to a fixed epoch that never moves. */
  readonly clock?: () => number;
}

const ZERO_COUNTERS: HotkeyCounters = {
  downs: 0,
  ups: 0,
  suppressed: 0,
  synthetic: 0,
  listenerDisabled: 0,
  listenerRestored: 0,
};

export class FakeHotkeyAdapter implements HotkeyAdapter {
  readonly #emitter = new Emitter<HotkeyEvent>();
  readonly #clock: () => number;

  #binding: HotkeyBinding;
  #availability: HotkeyAvailability;
  #counters: HotkeyCounters = ZERO_COUNTERS;
  #heldSince: number | null = null;
  #sequence = 0;

  constructor(options: FakeHotkeyAdapterOptions = {}) {
    this.#binding = options.binding ?? DEFAULT_PUSH_TO_TALK_BINDING;
    this.#availability = options.availability ?? { status: 'stopped' };
    this.#clock = options.clock ?? ((): number => 0);
  }

  subscribe = this.#emitter.subscribe;

  get held(): boolean {
    return this.#heldSince !== null;
  }

  async status(): Promise<HotkeyStatus> {
    return this.#status();
  }

  async start(binding?: HotkeyBinding): Promise<HotkeyStatus> {
    if (binding !== undefined) {
      this.#rebind(binding);
    }
    if (this.#availability.status === 'unavailable') {
      // Matches the real adapter: an unavailable hotkey is a reported state,
      // never a thrown error.
      return this.#status();
    }
    this.#setAvailability({ status: 'active' });
    return this.#status();
  }

  async stop(): Promise<HotkeyStatus> {
    this.#release(true, 'stopped');
    this.#setAvailability({ status: 'stopped' });
    return this.#status();
  }

  // -- test controls ---------------------------------------------------------

  /** Presses the key. A press while already held is suppressed, as the real one is. */
  pressDown(): void {
    if (this.#availability.status !== 'active') {
      this.#counters = { ...this.#counters, suppressed: this.#counters.suppressed + 1 };
      return;
    }
    if (this.#heldSince !== null) {
      this.#counters = { ...this.#counters, suppressed: this.#counters.suppressed + 1 };
      return;
    }
    const at = this.#clock();
    this.#sequence += 1;
    this.#heldSince = at;
    this.#counters = { ...this.#counters, downs: this.#counters.downs + 1 };
    this.#emitter.emit({
      type: 'hotkey-down',
      binding: this.#binding,
      at,
      sequence: this.#sequence,
    });
  }

  /** Releases the key. A release with nothing held is suppressed. */
  pressUp(): void {
    this.#release(false);
  }

  /** Presses and releases in one call, for tests that do not care about the hold. */
  tap(): void {
    this.pressDown();
    this.pressUp();
  }

  /**
   * Test control: force an availability, as a revoked permission or a system
   * disabling the listener would. Releases a held key first, so the pairing
   * invariant survives.
   */
  setAvailability(availability: HotkeyAvailability): void {
    if (availability.status !== 'active' && this.#heldSince !== null) {
      this.#release(true, availability.status === 'stopped' ? 'stopped' : 'listener-lost');
    }
    if (availability.status === 'unavailable') {
      this.#counters = {
        ...this.#counters,
        listenerDisabled: this.#counters.listenerDisabled + 1,
      };
    }
    if (availability.status === 'active' && this.#availability.status === 'unavailable') {
      this.#counters = {
        ...this.#counters,
        listenerRestored: this.#counters.listenerRestored + 1,
      };
    }
    this.#setAvailability(availability);
  }

  /** Test control: change the binding without starting or stopping. */
  rebind(binding: HotkeyBinding): void {
    this.#rebind(binding);
  }

  // -- internals -------------------------------------------------------------

  #rebind(binding: HotkeyBinding): void {
    this.#release(true, 'stopped');
    this.#binding = binding;
  }

  #release(synthetic: boolean, reason?: HotkeySyntheticReleaseReason): void {
    const heldSince = this.#heldSince;
    if (heldSince === null) {
      if (!synthetic) {
        this.#counters = { ...this.#counters, suppressed: this.#counters.suppressed + 1 };
      }
      return;
    }
    const at = this.#clock();
    this.#heldSince = null;
    this.#counters = {
      ...this.#counters,
      ups: this.#counters.ups + 1,
      ...(synthetic ? { synthetic: this.#counters.synthetic + 1 } : {}),
    };
    this.#emitter.emit({
      type: 'hotkey-up',
      binding: this.#binding,
      at,
      sequence: this.#sequence,
      heldMs: Math.max(0, at - heldSince),
      synthetic,
      ...(synthetic && reason !== undefined ? { reason } : {}),
    });
  }

  #setAvailability(availability: HotkeyAvailability): void {
    const changed =
      availability.status !== this.#availability.status ||
      (availability.status === 'unavailable' &&
        this.#availability.status === 'unavailable' &&
        availability.reason !== this.#availability.reason);
    this.#availability = availability;
    if (!changed) {
      return;
    }
    this.#emitter.emit({
      type: 'hotkey-availability-changed',
      availability,
      binding: this.#binding,
      at: this.#clock(),
    });
  }

  #status(): HotkeyStatus {
    return {
      binding: this.#binding,
      availability: this.#availability,
      held: this.#heldSince !== null,
      counters: this.#counters,
    };
  }
}
