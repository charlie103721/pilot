import type { HotkeySyntheticReleaseReason } from '@pilot/platform';

/**
 * Turns a stream of raw key transitions into clean, paired press/release
 * events (PR-015).
 *
 * ## What "coalescing" has to mean here
 *
 * `docs/implementation.md` PR-015 lists "event coalescing" as a task, and
 * PR-025's demo shows what happens without it: the state machine answers a
 * second `push-to-talk-down` with `illegal-transition`, once per repeat, at the
 * keyboard's repeat rate. That is a correct machine refusing a storm it should
 * never have been shown.
 *
 * The storm has two independent sources, so there are two independent defences:
 *
 * 1. **The native tap** drops platform auto-repeat and duplicate phases before
 *    a frame is ever written (`HotkeyGate` in
 *    `native/Sources/PilotHelperCore/HotkeyModel.swift`).
 * 2. **This class** does it again on the host, from state it owns, with an
 *    injected clock. It exists separately because the Swift half cannot be
 *    compiled or run on the development machine (runbook amendment 8) — the
 *    only coalescing that is *proven* to work is the one that has tests behind
 *    it, and this is that one. It is also the layer that survives a helper
 *    restart, because a fresh helper process starts with no memory of the key.
 *
 * ## The pairing invariant
 *
 * Every emitted `down` is matched by exactly one `up`. When the real release
 * cannot arrive — the tap died, the helper crashed, macOS lost the key-up
 * across a Space switch — {@link HotkeyCoalescer.release} or
 * {@link HotkeyCoalescer.sweep} synthesises it. Without this the interaction
 * machine sits in `listening` with the microphone open and no way out but the
 * user noticing.
 *
 * ## No clock of its own
 *
 * `clock` is injected and nothing here calls `Date.now()`. Two of the rules —
 * the retrigger guard and the maximum hold — are decided from elapsed time, so
 * a coalescer that read the wall clock would make its own tests flaky in
 * precisely the places that matter. `sweep()` is likewise pull-based: this
 * class owns no timer, and the adapter drives it from the same `Poller` the
 * rest of the package uses.
 */

/** A transition as the native side reported it, before any host-side rule. */
export interface RawHotkeyTransition {
  readonly phase: 'down' | 'up';
  /** Whether the platform marked it a key repeat. */
  readonly autorepeat: boolean;
  /** Helper-side sequence number, for gap detection. */
  readonly sequence: number;
}

export const HOTKEY_SUPPRESSION_REASONS = [
  /** The platform flagged the event as a key repeat. */
  'auto-repeat',
  /** A `down` while the key was already down. */
  'already-held',
  /** An `up` with nothing held. */
  'stray-up',
  /** A `down` too soon after the previous `up` to be a real second press. */
  'retrigger-too-fast',
  /** A transition arrived while the coalescer was not listening. */
  'not-listening',
] as const;

export type HotkeySuppressionReason = (typeof HOTKEY_SUPPRESSION_REASONS)[number];

export interface HotkeySuppression {
  readonly reason: HotkeySuppressionReason;
  readonly phase: 'down' | 'up';
  readonly at: number;
  readonly sequence: number;
}

export interface CoalescedDown {
  readonly type: 'down';
  readonly at: number;
  readonly sequence: number;
}

export interface CoalescedUp {
  readonly type: 'up';
  readonly at: number;
  readonly sequence: number;
  readonly heldMs: number;
  readonly synthetic: boolean;
  readonly reason: HotkeySyntheticReleaseReason | undefined;
}

export type CoalescedHotkeyTransition = CoalescedDown | CoalescedUp;

export interface HotkeyCoalescerOptions {
  /** Required. Library code in this repository does not read the wall clock. */
  readonly clock: () => number;
  /**
   * A `down` closer than this to the previous `up` is contact chatter, not a
   * second question. 30 ms is well under any human double-press and well over
   * any switch bounce.
   */
  readonly minRetriggerMs?: number;
  /**
   * Longest a press may stay open before {@link HotkeyCoalescer.sweep}
   * synthesises the release. macOS really does lose modifier key-ups across a
   * Space switch or a Mission Control activation, and a lost key-up with no
   * ceiling is an open microphone.
   */
  readonly maxHoldMs?: number;
}

export const DEFAULT_MIN_RETRIGGER_MS = 30;
export const DEFAULT_MAX_HOLD_MS = 30_000;

export class HotkeyCoalescer {
  readonly #clock: () => number;
  readonly #minRetriggerMs: number;
  readonly #maxHoldMs: number;

  #listening = false;
  #heldSince: number | null = null;
  #lastUpAt: number | null = null;
  #sequence = 0;
  #suppressed = 0;
  #synthetic = 0;
  #downs = 0;
  #ups = 0;

  constructor(options: HotkeyCoalescerOptions) {
    this.#clock = options.clock;
    this.#minRetriggerMs = options.minRetriggerMs ?? DEFAULT_MIN_RETRIGGER_MS;
    this.#maxHoldMs = options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  }

  get listening(): boolean {
    return this.#listening;
  }

  get held(): boolean {
    return this.#heldSince !== null;
  }

  /** Press counter. A `down` and its `up` share it. */
  get sequence(): number {
    return this.#sequence;
  }

  get counts(): {
    readonly downs: number;
    readonly ups: number;
    readonly suppressed: number;
    readonly synthetic: number;
  } {
    return {
      downs: this.#downs,
      ups: this.#ups,
      suppressed: this.#suppressed,
      synthetic: this.#synthetic,
    };
  }

  /**
   * Begins accepting transitions.
   *
   * Deliberately does *not* clear the retrigger guard: a helper restart must
   * not let a key that bounced during the outage register as a fresh press.
   */
  listen(): void {
    this.#listening = true;
  }

  /**
   * Stops accepting transitions, releasing a held key first.
   *
   * Returns the synthetic release, if one was needed, so the caller emits it
   * before the availability change that caused it — a consumer tearing down on
   * "unavailable" must already have seen the microphone close.
   */
  unlisten(reason: HotkeySyntheticReleaseReason): CoalescedUp | null {
    const released = this.release(reason);
    this.#listening = false;
    return released;
  }

  /**
   * Applies one raw transition.
   *
   * Returns the event to emit, or the reason it was folded away. Never both,
   * and never neither.
   */
  accept(
    transition: RawHotkeyTransition,
  ): { readonly emit: CoalescedHotkeyTransition } | { readonly suppressed: HotkeySuppression } {
    const at = this.#clock();
    const suppress = (
      reason: HotkeySuppressionReason,
    ): { readonly suppressed: HotkeySuppression } => {
      this.#suppressed += 1;
      return {
        suppressed: { reason, phase: transition.phase, at, sequence: transition.sequence },
      };
    };

    if (!this.#listening) {
      return suppress('not-listening');
    }
    if (transition.autorepeat) {
      // Checked before the held test so the flag is honoured even if the held
      // state was lost — after a helper restart, say.
      return suppress('auto-repeat');
    }

    if (transition.phase === 'down') {
      if (this.#heldSince !== null) {
        return suppress('already-held');
      }
      const lastUpAt = this.#lastUpAt;
      if (lastUpAt !== null && at - lastUpAt < this.#minRetriggerMs) {
        return suppress('retrigger-too-fast');
      }
      this.#sequence += 1;
      this.#heldSince = at;
      this.#downs += 1;
      return { emit: { type: 'down', at, sequence: this.#sequence } };
    }

    const heldSince = this.#heldSince;
    if (heldSince === null) {
      return suppress('stray-up');
    }
    this.#heldSince = null;
    this.#lastUpAt = at;
    this.#ups += 1;
    return {
      emit: {
        type: 'up',
        at,
        sequence: this.#sequence,
        heldMs: Math.max(0, at - heldSince),
        synthetic: false,
        reason: undefined,
      },
    };
  }

  /**
   * Releases a held key on Pilot's behalf. `null` when nothing was held, which
   * makes it safe to call on every teardown path.
   */
  release(reason: HotkeySyntheticReleaseReason): CoalescedUp | null {
    const heldSince = this.#heldSince;
    if (heldSince === null) {
      return null;
    }
    const at = this.#clock();
    this.#heldSince = null;
    this.#lastUpAt = at;
    this.#ups += 1;
    this.#synthetic += 1;
    return {
      type: 'up',
      at,
      sequence: this.#sequence,
      heldMs: Math.max(0, at - heldSince),
      synthetic: true,
      reason,
    };
  }

  /**
   * The stuck-key watchdog. Call it periodically; it releases a press that has
   * outlived `maxHoldMs` and does nothing otherwise.
   */
  sweep(): CoalescedUp | null {
    const heldSince = this.#heldSince;
    if (heldSince === null) {
      return null;
    }
    if (this.#clock() - heldSince < this.#maxHoldMs) {
      return null;
    }
    return this.release('held-too-long');
  }
}
