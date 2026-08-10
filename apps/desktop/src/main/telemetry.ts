import {
  DEFAULT_TELEMETRY_CAPACITY,
  TELEMETRY_METRIC_UNITS,
  type AbortCategory,
  type TelemetryBuffer,
  type TelemetryMetric,
  type TelemetrySample,
} from '../ipc/schemas.js';
import type { PilotErrorCode } from '@pilot/shared';

/**
 * The developer telemetry ring buffer (system-design §17).
 *
 * Bounded and in memory only. §13 puts "non-sensitive diagnostics" in the
 * persisted column, but nothing here is written anywhere: the ring is the whole
 * store, it is dropped with the process, and the panel reads a copy of it.
 *
 * **What it cannot hold.** The recording API below takes a metric name, a
 * number and — for `abort` and `failure` only — a category from a closed
 * vocabulary. There is no parameter of type `string`, `unknown` or `object`, so
 * a caller cannot pass a transcript, a window title, a prompt or an image
 * through it even by accident. That is the whole privacy design: §17 says
 * metrics record timings and counts, and the type system is what makes that
 * true rather than a convention the next PR might not read.
 *
 * `PilotError` is deliberately *not* accepted whole. Its `code` is a category;
 * its `userMessage` and `details` are not, and `details` in particular has
 * carried a window id and could carry a title. {@link TelemetryRing.failure}
 * therefore takes the code and nothing else.
 */

export interface TelemetryRingOptions {
  readonly capacity?: number;
  readonly now?: () => number;
  /** Called after every sample, so the gate can publish without polling. */
  readonly onSample?: (sample: TelemetrySample) => void;
}

export class TelemetryRing {
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #onSample: ((sample: TelemetrySample) => void) | undefined;

  #samples: TelemetrySample[] = [];
  #recorded = 0;
  #dropped = 0;
  #turn = 0;

  constructor(options: TelemetryRingOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_TELEMETRY_CAPACITY;
    // A zero-length ring would silently discard everything and read exactly
    // like a ring nothing ever wrote to.
    this.#capacity = capacity > 0 ? Math.floor(capacity) : DEFAULT_TELEMETRY_CAPACITY;
    this.#now = options.now ?? (() => Date.now());
    this.#onSample = options.onSample;
  }

  /** The question samples are currently attributed to. 0 before the first. */
  get turn(): number {
    return this.#turn;
  }

  /** Starts a new question. Returns its 1-based number. */
  beginTurn(): number {
    this.#turn += 1;
    return this.#turn;
  }

  snapshot(): TelemetryBuffer {
    return {
      samples: this.#samples,
      capacity: this.#capacity,
      recorded: this.#recorded,
      dropped: this.#dropped,
    };
  }

  clear(): void {
    this.#samples = [];
    this.#recorded = 0;
    this.#dropped = 0;
    this.#turn = 0;
  }

  /** A duration in milliseconds. Negative durations are refused, not clamped. */
  timing(metric: TelemetryMetric, milliseconds: number): void {
    this.#record(metric, milliseconds, null);
  }

  /** A count, or a byte total. */
  count(metric: TelemetryMetric, value: number): void {
    this.#record(metric, value, null);
  }

  /** §17's "abort category". One sample per abort. */
  abort(category: AbortCategory): void {
    this.#record('abort', 1, category);
  }

  /**
   * §17's "failure category". Takes the `PilotErrorCode` alone — see the note
   * above about why the error object itself is not accepted.
   */
  failure(code: PilotErrorCode): void {
    this.#record('failure', 1, code);
  }

  #record(metric: TelemetryMetric, value: number, category: AbortCategory | PilotErrorCode | null) {
    if (!Number.isFinite(value) || value < 0) {
      // A measurement that cannot be true is dropped rather than recorded: a
      // diagnostics panel showing `-1 ms` teaches the reader to distrust it.
      return;
    }
    const sample: TelemetrySample = {
      seq: this.#recorded,
      at: Math.max(0, Math.round(this.#now())),
      turn: this.#turn,
      metric,
      value: TELEMETRY_METRIC_UNITS[metric] === 'ms' ? Math.round(value) : value,
      category,
    };
    this.#recorded += 1;
    // Copy-on-write: `snapshot()` hands the array out, and a published state
    // that mutates underneath the renderer is a bug that reproduces once a week.
    this.#samples = [...this.#samples, sample];
    while (this.#samples.length > this.#capacity) {
      this.#samples.shift();
      this.#dropped += 1;
    }
    this.#onSample?.(sample);
  }
}
