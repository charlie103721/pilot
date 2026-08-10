import {
  isPointerInsideWindow,
  MVP_SCREEN_POLICY,
  PilotError,
  type GroundedPointer,
  type WindowId,
} from '@pilot/shared';
import type { Clock } from './clock.js';

/**
 * Pointer timeline (system-design §6, §17).
 *
 * Pointer coordinates and accessibility targets are recorded separately from
 * frames, at a higher frequency (~30 Hz with coalescing) and over a longer
 * window, because question anchoring needs the pointer path *during an
 * utterance* — which routinely outlives the three-second frame ring.
 *
 * Memory-only, like the ring (system-design §13).
 */

/** ~30 Hz (mvp-01 §10 `pointerSampleHz`, system-design §17). */
export const DEFAULT_POINTER_MIN_INTERVAL_MS = 1000 / MVP_SCREEN_POLICY.pointerSampleHz;

/**
 * Retention window. Long enough to cover a push-to-talk utterance and the tool
 * call that follows it; PR-017 may tighten it from policy.
 */
export const DEFAULT_POINTER_MAX_AGE_MS = 30_000;

/** Hard ceiling: 30 Hz × 30 s ≈ 900 samples, so this only fires on misuse. */
export const DEFAULT_POINTER_MAX_SAMPLES = 4096;

export interface PointerSampleInput {
  /** Timestamp the pointer was observed at, from the injected clock. */
  readonly at: number;
  readonly windowId: WindowId;
  readonly pointer: GroundedPointer;
  /** Scene revision in force at sample time, stamped by the owner. */
  readonly sceneRevision?: number;
}

export interface PointerSample {
  readonly at: number;
  readonly windowId: WindowId;
  readonly pointer: GroundedPointer;
  /**
   * Whether the pointer was inside the selected window. Recorded here so
   * downstream code never has to re-derive it — and never invents a target for
   * a pointer that was outside (system-design §5 / mvp-01 §8).
   */
  readonly insideWindow: boolean;
  readonly sceneRevision: number | null;
}

export type PointerRejectionReason =
  /** Older than the retention window at arrival. */
  | 'stale'
  /** Timestamp precedes the newest retained sample; the timeline is monotonic. */
  | 'out-of-order';

export type PointerAdmission =
  | {
      readonly admitted: true;
      readonly sample: PointerSample;
      /** True when the sample replaced the previous one under the ~30 Hz bound. */
      readonly coalesced: boolean;
      readonly evicted: number;
    }
  | {
      readonly admitted: false;
      readonly reason: PointerRejectionReason;
      readonly detail: string;
      readonly evicted: number;
    };

export type PointerSelectionDirection = 'any' | 'at-or-before' | 'at-or-after';

export interface PointerSelectionQuery {
  readonly direction?: PointerSelectionDirection;
  /** Defaults to the timeline's retention window. */
  readonly maxSkewMs?: number;
}

export type PointerSelectionFailure = 'empty' | 'out-of-range' | 'no-sample-in-direction';

export type PointerSelection =
  | {
      readonly found: true;
      readonly sample: PointerSample;
      readonly skewMs: number;
      readonly distanceMs: number;
    }
  | {
      readonly found: false;
      readonly reason: PointerSelectionFailure;
      readonly nearestDistanceMs: number | null;
      readonly sampleCount: number;
    };

export interface PointerTimelineStats {
  readonly sampleCount: number;
  readonly oldestSampleAt: number | null;
  readonly newestSampleAt: number | null;
}

export interface PointerTimelineMetrics {
  readonly admitted: number;
  readonly coalesced: number;
  readonly evictedByAge: number;
  readonly evictedByCount: number;
  readonly rejected: Readonly<Record<PointerRejectionReason, number>>;
  readonly peakSampleCount: number;
  readonly clears: number;
}

export interface PointerTimelineConfig {
  readonly maxAgeMs?: number;
  readonly maxSamples?: number;
  /**
   * Width of a coalescing bucket. At most one sample is retained per bucket:
   * a sample landing in the same bucket as the newest retained one replaces
   * it, keeping the newest position. This is what bounds growth under a
   * high-frequency pointer feed, and it bounds it to the *rate* rather than
   * collapsing a burst to a single sample.
   */
  readonly minIntervalMs?: number;
}

export interface PointerTimelineOptions extends PointerTimelineConfig {
  readonly clock: Clock;
}

function assertPositive(value: number, what: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PilotError('invalid-request', `${what} must be a positive finite number`, {
      userMessage: 'Pilot was configured with an unusable pointer bound.',
      details: { what, value },
    });
  }
  return value;
}

export class PointerTimeline {
  readonly #clock: Clock;
  readonly #maxAgeMs: number;
  readonly #maxSamples: number;
  readonly #minIntervalMs: number;

  #samples: PointerSample[] = [];

  #admitted = 0;
  #coalesced = 0;
  #evictedByAge = 0;
  #evictedByCount = 0;
  #peakSampleCount = 0;
  #clears = 0;
  readonly #rejected: Record<PointerRejectionReason, number> = {
    stale: 0,
    'out-of-order': 0,
  };

  constructor(options: PointerTimelineOptions) {
    this.#clock = options.clock;
    this.#maxAgeMs = assertPositive(options.maxAgeMs ?? DEFAULT_POINTER_MAX_AGE_MS, 'maxAgeMs');
    this.#maxSamples = assertPositive(
      options.maxSamples ?? DEFAULT_POINTER_MAX_SAMPLES,
      'maxSamples',
    );
    this.#minIntervalMs = assertPositive(
      options.minIntervalMs ?? DEFAULT_POINTER_MIN_INTERVAL_MS,
      'minIntervalMs',
    );
  }

  get maxAgeMs(): number {
    return this.#maxAgeMs;
  }

  get maxSamples(): number {
    return this.#maxSamples;
  }

  get minIntervalMs(): number {
    return this.#minIntervalMs;
  }

  push(input: PointerSampleInput): PointerAdmission {
    const now = this.#clock.now();
    let evicted = this.#pruneByAge(now);

    if (now - input.at > this.#maxAgeMs) {
      this.#rejected.stale += 1;
      return {
        admitted: false,
        reason: 'stale',
        detail: `Sample is ${String(now - input.at)}ms old, past the ${String(this.#maxAgeMs)}ms window`,
        evicted,
      };
    }

    const previous = this.#samples[this.#samples.length - 1];
    if (previous !== undefined && input.at < previous.at) {
      this.#rejected['out-of-order'] += 1;
      return {
        admitted: false,
        reason: 'out-of-order',
        detail: `Sample at ${String(input.at)} precedes the newest retained sample at ${String(previous.at)}`,
        evicted,
      };
    }

    const sample: PointerSample = {
      at: input.at,
      windowId: input.windowId,
      pointer: input.pointer,
      insideWindow: isPointerInsideWindow(input.pointer),
      sceneRevision: input.sceneRevision ?? null,
    };

    const coalesced =
      previous !== undefined && this.#bucket(input.at) === this.#bucket(previous.at);
    if (coalesced) {
      this.#samples[this.#samples.length - 1] = sample;
      this.#coalesced += 1;
    } else {
      this.#samples.push(sample);
    }
    this.#admitted += 1;

    evicted += this.#pruneByCount();
    this.#peakSampleCount = Math.max(this.#peakSampleCount, this.#samples.length);

    return { admitted: true, sample, coalesced, evicted };
  }

  /**
   * Nearest pointer sample to a moment. Ties resolve to the earlier sample, the
   * same rule the frame ring uses, so a frame and a pointer selected for one
   * question moment stay consistent.
   */
  select(requestedAt: number, query: PointerSelectionQuery = {}): PointerSelection {
    this.#pruneByAge(this.#clock.now());
    const direction = query.direction ?? 'any';
    const maxSkewMs = query.maxSkewMs ?? this.#maxAgeMs;

    let best: PointerSample | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const sample of this.#samples) {
      if (direction === 'at-or-before' && sample.at > requestedAt) {
        continue;
      }
      if (direction === 'at-or-after' && sample.at < requestedAt) {
        continue;
      }
      const distance = Math.abs(sample.at - requestedAt);
      if (distance < bestDistance) {
        best = sample;
        bestDistance = distance;
      }
    }

    if (best === undefined) {
      return {
        found: false,
        reason: this.#samples.length === 0 ? 'empty' : 'no-sample-in-direction',
        nearestDistanceMs: null,
        sampleCount: this.#samples.length,
      };
    }
    if (bestDistance > maxSkewMs) {
      return {
        found: false,
        reason: 'out-of-range',
        nearestDistanceMs: bestDistance,
        sampleCount: this.#samples.length,
      };
    }
    return {
      found: true,
      sample: best,
      skewMs: best.at - requestedAt,
      distanceMs: bestDistance,
    };
  }

  /**
   * Pointer path over an inclusive interval — the utterance window used for
   * question anchoring. Returns an empty array (never `undefined`) when the
   * timeline holds nothing in range.
   */
  between(from: number, to: number): readonly PointerSample[] {
    this.#pruneByAge(this.#clock.now());
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    return this.#samples.filter((sample) => sample.at >= start && sample.at <= end);
  }

  newest(): PointerSample | null {
    this.#pruneByAge(this.#clock.now());
    return this.#samples[this.#samples.length - 1] ?? null;
  }

  oldest(): PointerSample | null {
    this.#pruneByAge(this.#clock.now());
    return this.#samples[0] ?? null;
  }

  samples(): readonly PointerSample[] {
    this.#pruneByAge(this.#clock.now());
    return [...this.#samples];
  }

  stats(): PointerTimelineStats {
    this.#pruneByAge(this.#clock.now());
    const oldest = this.#samples[0];
    const newest = this.#samples[this.#samples.length - 1];
    return {
      sampleCount: this.#samples.length,
      oldestSampleAt: oldest === undefined ? null : oldest.at,
      newestSampleAt: newest === undefined ? null : newest.at,
    };
  }

  metrics(): PointerTimelineMetrics {
    return {
      admitted: this.#admitted,
      coalesced: this.#coalesced,
      evictedByAge: this.#evictedByAge,
      evictedByCount: this.#evictedByCount,
      rejected: { ...this.#rejected },
      peakSampleCount: this.#peakSampleCount,
      clears: this.#clears,
    };
  }

  clear(): { readonly sampleCount: number } {
    const dropped = { sampleCount: this.#samples.length };
    this.#samples = [];
    this.#clears += 1;
    return dropped;
  }

  /** Coalescing bucket index for a timestamp. */
  #bucket(at: number): number {
    return Math.floor(at / this.#minIntervalMs);
  }

  #pruneByAge(now: number): number {
    let removed = 0;
    while (this.#samples.length > 0) {
      const oldest = this.#samples[0];
      if (oldest === undefined || now - oldest.at <= this.#maxAgeMs) {
        break;
      }
      this.#samples.shift();
      removed += 1;
    }
    this.#evictedByAge += removed;
    return removed;
  }

  #pruneByCount(): number {
    let removed = 0;
    while (this.#samples.length > this.#maxSamples) {
      this.#samples.shift();
      removed += 1;
    }
    this.#evictedByCount += removed;
    return removed;
  }
}
