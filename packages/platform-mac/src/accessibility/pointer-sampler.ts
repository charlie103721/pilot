import { MVP_SCREEN_POLICY, nullLogger, toPilotError, type Logger } from '@pilot/shared';
import type {
  AccessibilityGroundingTarget,
  PointerGroundingSample,
  Unsubscribe,
} from '@pilot/platform';
import { Poller } from '../polling.js';
import { TypedEmitter } from '../transport/emitter.js';
import { sameGrounding } from './pointer-grounding.js';

/**
 * Pointer sampling at ~30 Hz, with coalescing (system-design §17).
 *
 * ## The interval
 *
 * `MVP_SCREEN_POLICY.pointerSampleHz` is 30, so the period is 33⅓ ms. It is one
 * constant read from the shared policy, not a literal repeated here, because
 * PR-017 owns the policy and this must move when it does.
 *
 * ## Coalescing, and why there are two kinds
 *
 * Sampling produces a redundant stream: a stationary pointer over a stationary
 * element yields the same answer thirty times a second, and a caller that
 * forces ticks (a test, a burst after a stall) can produce them faster than the
 * period. Both are suppressed, and the two are counted separately because they
 * mean different things:
 *
 * - **By interval.** At most one sample is emitted per coalescing bucket,
 *   `floor(at / coalesceIntervalMs)`. This is a bucket, not a gap: two samples
 *   33 ms apart may still land in different buckets. That is deliberate — it is
 *   precisely the rule `PointerTimeline` (PR-004) uses to decide whether an
 *   arriving sample replaces the last retained one, so a sample this sampler
 *   calls coalesced is the same one the timeline would have collapsed. Two
 *   different rules would make the emitted rate and the retained rate disagree.
 * - **By equality.** A sample in a *new* bucket that is materially identical to
 *   the last emitted one — same position, same grounding, same target — is not
 *   news. Suppressing it is what keeps a still pointer from writing 1800
 *   identical entries a minute into a timeline that only exists to answer
 *   "where was the pointer when the question ended".
 *
 * Neither kind of coalescing ever drops a *change*: equality is compared against
 * the last **emitted** sample, so a move followed by a move back is two
 * emissions, and a bucket that contains a change emits the change.
 *
 * ## Clock discipline
 *
 * Every timestamp comes from the injected clock and every tick from the
 * injected timer. Nothing here calls `Date.now()`, so the boundary cases are
 * tested at the exact millisecond rather than raced against wall time.
 */

/** ~30 Hz (system-design §17, mvp-01 §10 `pointerSampleHz`). */
export const DEFAULT_POINTER_SAMPLE_INTERVAL_MS = 1000 / MVP_SCREEN_POLICY.pointerSampleHz;

/** What the sampler needs from an accessibility adapter. */
export interface PointerGroundingSource {
  ground(target: AccessibilityGroundingTarget): Promise<PointerGroundingSample>;
  /** One-round-trip form, preferred when present. */
  groundFast?(target: AccessibilityGroundingTarget): Promise<PointerGroundingSample>;
}

export interface PointerSamplerMetrics {
  /** Ticks that produced an answer from the platform. */
  readonly sampled: number;
  readonly emitted: number;
  readonly coalescedByInterval: number;
  readonly coalescedByEquality: number;
  /** Ticks skipped because no window was selected. */
  readonly skippedNoTarget: number;
  /** Ticks whose platform call failed. */
  readonly failed: number;
  /** Emitted samples whose pointer was outside the selected window. */
  readonly outsideWindow: number;
  /** Emitted samples taken without accessibility hit testing. */
  readonly degraded: number;
}

export interface PointerSamplerOptions {
  readonly source: PointerGroundingSource;
  /**
   * The window to ground against, read on every tick. Returning `null` — no
   * window selected, observation paused — skips the tick rather than sampling
   * something that cannot be grounded.
   */
  readonly target: () => AccessibilityGroundingTarget | null;
  /** Injected clock. Required: coalescing must not depend on wall time. */
  readonly clock: () => number;
  readonly intervalMs?: number;
  /** Coalescing bucket width. Defaults to the sampling interval. */
  readonly coalesceIntervalMs?: number;
  readonly logger?: Logger;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
}

interface SamplerEvents extends Record<string, unknown> {
  sample: PointerGroundingSample;
}

export class PointerSampler {
  readonly #source: PointerGroundingSource;
  readonly #target: () => AccessibilityGroundingTarget | null;
  readonly #clock: () => number;
  readonly #coalesceIntervalMs: number;
  readonly #logger: Logger;
  readonly #emitter = new TypedEmitter<SamplerEvents>();
  readonly #poller: Poller;

  #subscribers = 0;
  #lastEmitted: PointerGroundingSample | null = null;
  #lastEmittedBucket: number | null = null;

  #sampled = 0;
  #emitted = 0;
  #coalescedByInterval = 0;
  #coalescedByEquality = 0;
  #skippedNoTarget = 0;
  #failed = 0;
  #outsideWindow = 0;
  #degraded = 0;

  constructor(options: PointerSamplerOptions) {
    this.#source = options.source;
    this.#target = options.target;
    this.#clock = options.clock;
    const intervalMs = options.intervalMs ?? DEFAULT_POINTER_SAMPLE_INTERVAL_MS;
    this.#coalesceIntervalMs = options.coalesceIntervalMs ?? intervalMs;
    this.#logger = (options.logger ?? nullLogger).child('pointer-sampler');
    this.#poller = new Poller(
      async () => {
        await this.#tick();
      },
      {
        intervalMs,
        logger: this.#logger,
        name: 'pointer',
        ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
        ...(options.clearTimer === undefined ? {} : { clearTimer: options.clearTimer }),
      },
    );
  }

  get running(): boolean {
    return this.#poller.running;
  }

  /** The last sample actually delivered to subscribers. */
  get lastSample(): PointerGroundingSample | null {
    return this.#lastEmitted;
  }

  /**
   * Starts sampling on the first subscriber and stops on the last unsubscribe.
   * A pointer nobody is watching is not worth an IPC round trip thirty times a
   * second.
   */
  subscribe = (listener: (sample: PointerGroundingSample) => void): Unsubscribe => {
    const off = this.#emitter.on('sample', listener);
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

  /**
   * Runs one tick immediately and resolves when it has settled. Returns the
   * sample if one was emitted, or `null` if it was coalesced, skipped or
   * failed. This is how the tests drive the sampler without wall time.
   */
  async sampleOnce(): Promise<PointerGroundingSample | null> {
    return this.#tick();
  }

  metrics(): PointerSamplerMetrics {
    return {
      sampled: this.#sampled,
      emitted: this.#emitted,
      coalescedByInterval: this.#coalescedByInterval,
      coalescedByEquality: this.#coalescedByEquality,
      skippedNoTarget: this.#skippedNoTarget,
      failed: this.#failed,
      outsideWindow: this.#outsideWindow,
      degraded: this.#degraded,
    };
  }

  /**
   * Forgets the last emitted sample, so the next one is emitted whatever it
   * says. Called when the selection changes or buffers are cleared
   * (system-design §14) — a position from the previous window must not
   * coalesce away the first position in the new one.
   */
  reset(): void {
    this.#lastEmitted = null;
    this.#lastEmittedBucket = null;
  }

  dispose(): void {
    this.#poller.stop();
    this.#subscribers = 0;
    this.#emitter.clear();
  }

  // -------------------------------------------------------------------------

  async #tick(): Promise<PointerGroundingSample | null> {
    const target = this.#target();
    if (target === null) {
      this.#skippedNoTarget += 1;
      return null;
    }
    // Bucketing reads the sampler's own injected clock at the start of the
    // tick, so it never depends on how the platform stamped the sample. In the
    // app and in the tests the two are the same clock.
    const tickAt = this.#clock();

    let sample: PointerGroundingSample;
    try {
      sample = await (this.#source.groundFast === undefined
        ? this.#source.ground(target)
        : this.#source.groundFast(target));
    } catch (error) {
      this.#failed += 1;
      // Sampling failures are expected and transient: the helper restarts and
      // the next tick reconciles. Never fatal — a dropped pointer sample is a
      // gap in a timeline, not a broken session.
      this.#logger.debug('pointer sample failed', { code: toPilotError(error).code });
      return null;
    }

    this.#sampled += 1;
    const bucket = Math.floor(tickAt / this.#coalesceIntervalMs);
    const previous = this.#lastEmitted;

    if (previous !== null && this.#lastEmittedBucket === bucket) {
      this.#coalescedByInterval += 1;
      return null;
    }
    if (previous !== null && sameGrounding(previous, sample)) {
      this.#coalescedByEquality += 1;
      return null;
    }

    this.#lastEmitted = sample;
    this.#lastEmittedBucket = bucket;
    this.#emitted += 1;
    if (sample.grounding === 'pointer-outside-window') {
      this.#outsideWindow += 1;
    }
    if (sample.degraded) {
      this.#degraded += 1;
    }
    this.#emitter.emit('sample', sample);
    return sample;
  }
}
