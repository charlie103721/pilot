import type { Clock } from './clock.js';
import { DEFAULT_SCREEN_CONTEXT_POLICY, type ScreenContextPolicy } from './screen-policy.js';

/**
 * Observation rate limit (system-design §10, `capture.maxRequestsPerSecond`).
 *
 * > No more than two observation calls per second.
 *
 * A sliding window rather than a fixed bucket: a fixed bucket lets a caller
 * fire `2 × maxRequestsPerSecond` across a bucket boundary, which is precisely
 * the burst the limit exists to stop.
 *
 * Every reading comes from the injected {@link Clock}. There is no `Date.now()`
 * here and no timer: a test drives the clock and the boundary is exact rather
 * than approximately exact.
 */

export interface RateDecision {
  readonly allowed: boolean;
  /** Requests already counted inside the window, including this one if allowed. */
  readonly inWindow: number;
  readonly limit: number;
  readonly windowMs: number;
  /**
   * Milliseconds until the oldest counted request leaves the window. `0` when
   * the request was allowed.
   */
  readonly retryAfterMs: number;
}

export interface RateLimiterOptions {
  readonly clock: Clock;
  readonly policy?: ScreenContextPolicy;
}

export interface RateLimiterMetrics {
  readonly allowed: number;
  readonly rejected: number;
  readonly peakInWindow: number;
  readonly resets: number;
}

/**
 * Counts observation calls in a sliding window.
 *
 * {@link ObservationRateLimiter.check} is a dry run and {@link
 * ObservationRateLimiter.take} consumes budget. The enforcer takes budget as
 * the first thing it does, so a request that is later refused for another
 * reason has still cost the caller its slot — otherwise a caller could hammer
 * `observe_screen` for free by failing a cheaper rule every time.
 */
export class ObservationRateLimiter {
  readonly #clock: Clock;
  readonly #limit: number;
  readonly #windowMs: number;

  /** Ascending timestamps of the requests still inside the window. */
  #hits: number[] = [];

  #allowed = 0;
  #rejected = 0;
  #peakInWindow = 0;
  #resets = 0;

  constructor(options: RateLimiterOptions) {
    const policy = options.policy ?? DEFAULT_SCREEN_CONTEXT_POLICY;
    this.#clock = options.clock;
    this.#limit = policy.capture.maxRequestsPerSecond;
    this.#windowMs = policy.capture.rateWindowMs;
  }

  get limit(): number {
    return this.#limit;
  }

  get windowMs(): number {
    return this.#windowMs;
  }

  /**
   * Would a request at `at` be allowed? Does not consume budget.
   *
   * The window is half-open: a hit exactly `windowMs` old has left. That makes
   * "two per second" mean what it says at the boundary — the third call is
   * allowed at exactly +1000 ms, not at +1001 ms.
   */
  check(at: number = this.#clock.now()): RateDecision {
    const live = this.#live(at);
    if (live.length < this.#limit) {
      return {
        allowed: true,
        inWindow: live.length + 1,
        limit: this.#limit,
        windowMs: this.#windowMs,
        retryAfterMs: 0,
      };
    }
    // `live` is ascending and full, so the slot frees when its oldest expires.
    const oldest = live[live.length - this.#limit] ?? live[0] ?? at;
    return {
      allowed: false,
      inWindow: live.length,
      limit: this.#limit,
      windowMs: this.#windowMs,
      retryAfterMs: Math.max(0, oldest + this.#windowMs - at),
    };
  }

  /** Consumes one slot when the request is allowed. */
  take(at: number = this.#clock.now()): RateDecision {
    const decision = this.check(at);
    if (decision.allowed) {
      this.#hits.push(at);
      this.#hits.sort((a, b) => a - b);
      this.#allowed += 1;
      this.#peakInWindow = Math.max(this.#peakInWindow, this.#hits.length);
    } else {
      this.#rejected += 1;
    }
    return decision;
  }

  /** Requests counted inside the window ending at `at`. */
  inWindow(at: number = this.#clock.now()): number {
    return this.#live(at).length;
  }

  /**
   * Forgets the history. Called on every clear: after a pause or a lock the
   * previous session's calls must not throttle the next one.
   */
  reset(): void {
    this.#hits = [];
    this.#resets += 1;
  }

  metrics(): RateLimiterMetrics {
    return {
      allowed: this.#allowed,
      rejected: this.#rejected,
      peakInWindow: this.#peakInWindow,
      resets: this.#resets,
    };
  }

  #live(at: number): readonly number[] {
    this.#hits = this.#hits.filter((hit) => at - hit < this.#windowMs);
    return this.#hits;
  }
}
