import { nullLogger, PilotError, type Logger } from '@pilot/shared';
import type { ClearReason, ObservationCore } from './observation-core.js';
import type { ObservationRateLimiter } from './observation-rate.js';
import { DEFAULT_SCREEN_CONTEXT_POLICY, type ScreenContextPolicy } from './screen-policy.js';

/**
 * Retention enforcement (system-design §10 `localBuffer`, §13, §14, §17).
 *
 * > Clear frame and audio buffers on pause, logout, screen lock, window loss,
 * > and process shutdown.
 *
 * `ObservationCore.clear(reason)` already empties the buffers. What was missing
 * is the policy layer around it:
 *
 * - a **named event** for each of the five occasions the design lists, mapped to
 *   the core's clear reason, so no caller has to guess which reason a lock is;
 * - a **post-condition with teeth**: the guard re-reads the core after clearing
 *   and throws if anything is still retained. A clear that silently failed is
 *   the worst possible failure mode for this rule, and "the test asserted the
 *   call happened" is not the same as "nothing is left";
 * - **rate-limit reset**, so a paused session's calls do not throttle the next
 *   one, and **lineage reset** on the terminal events, so shutdown and logout
 *   leave no scene history behind either;
 * - **bounds verification** ({@link RetentionGuard.verifyBounds}) that the ring
 *   and pointer timeline were actually built with the policy's numbers. PR-041
 *   can call it directly.
 */

export const RETENTION_EVENTS = [
  'pause',
  'screen-lock',
  'window-loss',
  'shutdown',
  'logout',
  'permission-loss',
  'window-change',
  'observation-disabled',
] as const;

export type RetentionEvent = (typeof RETENTION_EVENTS)[number];

/** Which core clear reason each policy event maps to. */
export const RETENTION_CLEAR_REASON: Readonly<Record<RetentionEvent, ClearReason>> = {
  pause: 'paused',
  'screen-lock': 'screen-locked',
  'window-loss': 'window-lost',
  shutdown: 'shutdown',
  logout: 'shutdown',
  'permission-loss': 'permission-lost',
  'window-change': 'window-changed',
  'observation-disabled': 'observation-disabled',
};

/**
 * Events after which no scene reference may survive either. A pause or a lock
 * deliberately keeps the lineage so a late result is rejected as `superseded`
 * rather than silently unknown (PR-016); shutdown and logout keep nothing.
 */
const TERMINAL_EVENTS: ReadonlySet<RetentionEvent> = new Set<RetentionEvent>([
  'shutdown',
  'logout',
]);

export interface RetentionClearReport {
  readonly event: RetentionEvent;
  readonly reason: ClearReason;
  readonly at: number;
  readonly clearedFrames: number;
  readonly clearedBytes: number;
  readonly clearedPointerSamples: number;
  readonly sceneEnded: string | null;
  readonly lineageReset: boolean;
  /** Always `true` on return; the guard throws rather than reporting `false`. */
  readonly empty: boolean;
}

export interface RetentionBounds {
  readonly frameDurationMs: number;
  readonly frameMaxBytes: number;
  readonly frameMaxCount: number;
  readonly pointerDurationMs: number;
  readonly persist: false;
}

export interface RetentionBoundsCheck {
  readonly ok: boolean;
  readonly expected: RetentionBounds;
  readonly actual: RetentionBounds;
  readonly mismatches: readonly string[];
}

export interface RetentionGuardOptions {
  readonly core: ObservationCore;
  readonly policy?: ScreenContextPolicy;
  readonly logger?: Logger;
  /** Reset alongside every clear, so a pause does not throttle the next session. */
  readonly rateLimiter?: ObservationRateLimiter;
  /** Called after each clear, for diagnostics. Never receives frame content. */
  readonly onClear?: (report: RetentionClearReport) => void;
}

export class RetentionGuard {
  readonly #core: ObservationCore;
  readonly #policy: ScreenContextPolicy;
  readonly #logger: Logger;
  readonly #rateLimiter: ObservationRateLimiter | null;
  readonly #onClear: ((report: RetentionClearReport) => void) | null;

  #clears = 0;

  constructor(options: RetentionGuardOptions) {
    this.#core = options.core;
    this.#policy = options.policy ?? DEFAULT_SCREEN_CONTEXT_POLICY;
    this.#logger = options.logger ?? nullLogger;
    this.#rateLimiter = options.rateLimiter ?? null;
    this.#onClear = options.onClear ?? null;
  }

  get policy(): ScreenContextPolicy {
    return this.#policy;
  }

  get clears(): number {
    return this.#clears;
  }

  /**
   * Clears everything for one policy event and proves it worked.
   *
   * Throws `internal` when the core still retains anything afterwards: a
   * retention rule that fails quietly is indistinguishable from one that does
   * not exist.
   */
  clearFor(event: RetentionEvent): RetentionClearReport {
    const reason = RETENTION_CLEAR_REASON[event];
    const result = this.#core.clear(reason);
    const lineageReset = TERMINAL_EVENTS.has(event);
    if (lineageReset) {
      this.#core.resetLineage();
    }
    this.#rateLimiter?.reset();
    this.#clears += 1;

    if (!this.#core.isEmpty()) {
      const status = this.#core.status();
      throw new PilotError('internal', `Buffers were not empty after clearing for ${event}`, {
        userMessage: 'Pilot could not release what it had captured. Observation has stopped.',
        details: {
          event,
          reason,
          frameCount: status.buffer.frameCount,
          byteCount: status.buffer.byteCount,
          pointerSamples: status.pointer.sampleCount,
        },
      });
    }

    const report: RetentionClearReport = {
      event,
      reason,
      at: result.at,
      clearedFrames: result.frames.count,
      clearedBytes: result.frames.bytes,
      clearedPointerSamples: result.pointerSamples,
      sceneEnded: result.scene?.sceneId ?? null,
      lineageReset,
      empty: true,
    };
    this.#logger.info('retention clear', {
      event,
      reason,
      clearedFrames: report.clearedFrames,
      clearedBytes: report.clearedBytes,
      clearedPointerSamples: report.clearedPointerSamples,
      lineageReset,
    });
    this.#onClear?.(report);
    return report;
  }

  /** Bounds the policy asks for. */
  bounds(): RetentionBounds {
    return {
      frameDurationMs: this.#policy.localBuffer.durationMs,
      frameMaxBytes: this.#policy.localBuffer.maxBytes,
      frameMaxCount: this.#policy.localBuffer.maxFrames,
      pointerDurationMs: this.#policy.localBuffer.pointerDurationMs,
      persist: false,
    };
  }

  /**
   * Bounds the core was actually built with, compared against the policy.
   * A core constructed without `policy` (or with hand-written `frames`/`pointer`
   * config) shows up here rather than at the moment a frame outlives its budget.
   */
  verifyBounds(): RetentionBoundsCheck {
    const expected = this.bounds();
    const actual: RetentionBounds = {
      frameDurationMs: this.#core.frames.maxAgeMs,
      frameMaxBytes: this.#core.frames.maxBytes,
      frameMaxCount: this.#core.frames.maxFrames,
      pointerDurationMs: this.#core.pointer.maxAgeMs,
      persist: false,
    };
    const mismatches: string[] = [];
    for (const key of [
      'frameDurationMs',
      'frameMaxBytes',
      'frameMaxCount',
      'pointerDurationMs',
    ] as const) {
      if (expected[key] !== actual[key]) {
        mismatches.push(`${key}: expected ${String(expected[key])}, got ${String(actual[key])}`);
      }
    }
    return { ok: mismatches.length === 0, expected, actual, mismatches };
  }
}
