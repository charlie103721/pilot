import {
  ABORT_CATEGORIES,
  TELEMETRY_METRICS,
  TELEMETRY_METRIC_UNITS,
  type ConversationGateState,
  type TelemetryBuffer,
  type TelemetryCategory,
  type TelemetryMetric,
  type TelemetrySample,
  type TelemetryUnit,
} from '../ipc/schemas.js';
import { PILOT_ERROR_CODES } from '@pilot/shared';

/**
 * Derives the developer diagnostics surface.
 *
 * `docs/system-design.md` §17 says metrics record **timings and counts, not
 * screen content**, and §13 puts base64 images, raw audio and screen-bearing
 * prompts in the "never logged" column. This file is where that promise is
 * either kept or quietly broken, so it is defended three times over:
 *
 *  1. **By the wire type.** `TelemetrySample` (`src/ipc/schemas.ts`) has five
 *     numeric fields and one field drawn from a closed vocabulary. There is no
 *     member into which a transcript, a title, a path or an image could be put.
 *  2. **By construction here.** Every rendered value below is either a number
 *     Pilot measured, a metric name from {@link TELEMETRY_METRICS}, or a
 *     category from the closed vocabulary. Nothing is copied through from an
 *     unknown field, so a *later* widening of the wire type still cannot reach
 *     the screen without editing this file.
 *  3. **By {@link partitionTelemetry} at runtime.** Samples are checked against
 *     the vocabularies before they are rendered, and one that does not fit is
 *     withheld and counted rather than displayed. A diagnostics panel is the
 *     one surface where "render whatever arrived" is the wrong default.
 *
 * The panel therefore cannot show what the user said, what Pilot answered, what
 * window was on screen or what any frame contained — not because no one wrote
 * that code, but because there is no path for it.
 */

// ---------------------------------------------------------------------------
// The content guard
// ---------------------------------------------------------------------------

const METRIC_NAMES: ReadonlySet<string> = new Set(TELEMETRY_METRICS);

const CATEGORY_NAMES: ReadonlySet<string> = new Set<string>([
  ...ABORT_CATEGORIES,
  ...PILOT_ERROR_CODES,
]);

/** Field names a sample is allowed to have. Anything else is not rendered. */
const SAMPLE_FIELDS: ReadonlySet<string> = new Set([
  'seq',
  'at',
  'turn',
  'metric',
  'value',
  'category',
]);

/**
 * Is this sample entirely timings, counts and closed-vocabulary categories?
 *
 * Written against `unknown` on purpose: the interesting case is a value that
 * TypeScript already believes is a `TelemetrySample` and is not — a payload
 * that crossed IPC from a future main process, or a fixture written by hand.
 */
export function telemetrySampleIsContentFree(sample: unknown): sample is TelemetrySample {
  if (typeof sample !== 'object' || sample === null) {
    return false;
  }
  const record = sample as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (!SAMPLE_FIELDS.has(key)) {
      return false;
    }
    if (key === 'metric') {
      if (typeof value !== 'string' || !METRIC_NAMES.has(value)) {
        return false;
      }
      continue;
    }
    if (key === 'category') {
      if (value === null) {
        continue;
      }
      if (typeof value !== 'string' || !CATEGORY_NAMES.has(value)) {
        return false;
      }
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return false;
    }
  }
  return typeof record['metric'] === 'string' && typeof record['value'] === 'number';
}

export interface TelemetryPartition {
  readonly rendered: readonly TelemetrySample[];
  /** Samples that failed the guard above. Counted, never shown. */
  readonly withheld: number;
}

export function partitionTelemetry(samples: readonly unknown[]): TelemetryPartition {
  const rendered: TelemetrySample[] = [];
  let withheld = 0;
  for (const sample of samples) {
    if (telemetrySampleIsContentFree(sample)) {
      rendered.push(sample);
    } else {
      withheld += 1;
    }
  }
  return { rendered, withheld };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export const METRIC_LABELS: Readonly<Record<TelemetryMetric, string>> = {
  'capture-to-observation': 'Capture → observation',
  'stt-duration': 'Speech to text',
  'time-to-first-token': 'Time to first token',
  'time-to-first-sentence': 'Time to first spoken sentence',
  'observation-calls': 'Observation calls per question',
  'image-bytes': 'Image bytes',
  'active-images': 'Active images',
  abort: 'Aborts',
  failure: 'Failures',
  'context-tokens-before': 'Context tokens before compaction',
  'context-tokens-after': 'Context tokens after compaction',
};

/** What §17 wants the number to mean, for a reader who has not read §17. */
export const METRIC_NOTES: Readonly<Record<TelemetryMetric, string>> = {
  'capture-to-observation': 'From the frame being captured to the model receiving it.',
  'stt-duration': 'From the push-to-talk key going down to a transcript, or to a failure.',
  'time-to-first-token': 'From the question being submitted to the first of the answer arriving.',
  'time-to-first-sentence': 'From the question being submitted to the first sentence being spoken.',
  'observation-calls': 'How many times the model looked at the screen for one question.',
  'image-bytes': 'Bytes of image data handed to the model.',
  'active-images': 'How many images the model context is holding.',
  abort: 'Times Pilot stopped waiting for something, by category.',
  failure: 'Failures, by error code.',
  'context-tokens-before': 'Estimated context size before compaction ran.',
  'context-tokens-after': 'Estimated context size after compaction ran.',
};

export function formatTelemetryValue(value: number, unit: TelemetryUnit): string {
  switch (unit) {
    case 'ms':
      return value >= 1000
        ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 2)} s`
        : `${String(Math.round(value))} ms`;
    case 'bytes': {
      if (value < 1024) {
        return `${String(Math.round(value))} B`;
      }
      const kib = value / 1024;
      return kib < 1024 ? `${kib.toFixed(1)} KiB` : `${(kib / 1024).toFixed(2)} MiB`;
    }
    case 'count':
      return String(value);
  }
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface MetricSummaryView {
  readonly metric: TelemetryMetric;
  readonly label: string;
  readonly note: string;
  readonly unit: TelemetryUnit;
  readonly samples: number;
  /** All null when `samples` is 0 — an absent measurement is never shown as 0. */
  readonly last: string | null;
  readonly min: string | null;
  readonly max: string | null;
  readonly mean: string | null;
}

export interface CategoryTallyView {
  readonly metric: 'abort' | 'failure';
  readonly category: TelemetryCategory;
  readonly count: number;
}

export interface DiagnosticsSampleView {
  readonly seq: number;
  readonly at: number;
  readonly turn: number;
  readonly metric: TelemetryMetric;
  readonly label: string;
  readonly unit: TelemetryUnit;
  readonly value: number;
  readonly formatted: string;
  readonly category: TelemetryCategory | null;
}

export interface DiagnosticsView {
  readonly visible: boolean;
  readonly capacity: number;
  readonly recorded: number;
  readonly dropped: number;
  readonly retained: number;
  /** True when the ring has forgotten samples: the numbers are a tail, not all. */
  readonly truncated: boolean;
  readonly withheld: number;
  /** Non-null exactly when `withheld` is greater than zero. */
  readonly withheldNote: string | null;
  /** Every metric §17 names, whether or not it has been measured yet. */
  readonly metrics: readonly MetricSummaryView[];
  readonly aborts: readonly CategoryTallyView[];
  readonly failures: readonly CategoryTallyView[];
  /** Newest first, bounded. */
  readonly recent: readonly DiagnosticsSampleView[];
  readonly turns: number;
  readonly emptyNote: string | null;
  /** Said on the surface itself, so a reader knows what it can and cannot contain. */
  readonly privacyNote: string;
}

export const DIAGNOSTICS_PRIVACY_NOTE =
  'Timings and counts only. Nothing you said, nothing Pilot answered and nothing from any ' +
  'captured image is recorded here or anywhere else in diagnostics.';

export const DIAGNOSTICS_EMPTY_NOTE =
  'Nothing measured yet. Ask a question, or replay a fixture conversation, and the timings appear here.';

/** How many individual samples the recent list shows. */
export const RECENT_SAMPLE_LIMIT = 40;

function summarise(
  metric: TelemetryMetric,
  samples: readonly TelemetrySample[],
): MetricSummaryView {
  const unit = TELEMETRY_METRIC_UNITS[metric];
  const values = samples.filter((sample) => sample.metric === metric).map((sample) => sample.value);
  const base = {
    metric,
    label: METRIC_LABELS[metric],
    note: METRIC_NOTES[metric],
    unit,
    samples: values.length,
  };
  const last = values[values.length - 1];
  if (values.length === 0 || last === undefined) {
    return { ...base, last: null, min: null, max: null, mean: null };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    ...base,
    last: formatTelemetryValue(last, unit),
    min: formatTelemetryValue(Math.min(...values), unit),
    max: formatTelemetryValue(Math.max(...values), unit),
    mean: formatTelemetryValue(total / values.length, unit),
  };
}

function tally(
  metric: 'abort' | 'failure',
  samples: readonly TelemetrySample[],
): readonly CategoryTallyView[] {
  const counts = new Map<TelemetryCategory, number>();
  for (const sample of samples) {
    if (sample.metric !== metric || sample.category === null) {
      continue;
    }
    counts.set(sample.category, (counts.get(sample.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]): CategoryTallyView => ({ metric, category, count }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category));
}

/**
 * Everything on this surface that came from a *measurement* rather than from
 * authored copy.
 *
 * The distinction matters for the test that proves no conversation reaches the
 * diagnostics: the labels, the notes and the privacy statement are English
 * sentences written in this file, so they contain ordinary English words and a
 * naive substring search over the whole view reports them as leaks. What must
 * be provably free of conversation content is the data — and this is all of it,
 * flattened. A value that is not returned here is not rendered from telemetry.
 */
export function diagnosticsDataStrings(view: DiagnosticsView): readonly string[] {
  return [
    String(view.capacity),
    String(view.recorded),
    String(view.dropped),
    String(view.retained),
    String(view.withheld),
    String(view.turns),
    ...view.metrics.flatMap((metric) => [
      metric.metric,
      String(metric.samples),
      metric.last ?? '',
      metric.min ?? '',
      metric.max ?? '',
      metric.mean ?? '',
    ]),
    ...[...view.aborts, ...view.failures].flatMap((tally) => [
      tally.metric,
      tally.category,
      String(tally.count),
    ]),
    ...view.recent.flatMap((sample) => [
      String(sample.seq),
      String(sample.at),
      String(sample.turn),
      sample.metric,
      sample.unit,
      String(sample.value),
      sample.formatted,
      sample.category ?? '',
    ]),
  ];
}

export function buildDiagnosticsView(gate: ConversationGateState): DiagnosticsView {
  return buildDiagnosticsViewFrom(gate.telemetry, gate.diagnosticsVisible);
}

export function buildDiagnosticsViewFrom(
  buffer: TelemetryBuffer,
  visible: boolean,
): DiagnosticsView {
  const { rendered, withheld } = partitionTelemetry(buffer.samples);
  const turns = rendered.reduce((highest, sample) => Math.max(highest, sample.turn), 0);

  return {
    visible,
    capacity: buffer.capacity,
    recorded: buffer.recorded,
    dropped: buffer.dropped,
    retained: rendered.length,
    truncated: buffer.dropped > 0,
    withheld,
    withheldNote:
      withheld === 0
        ? null
        : `${String(withheld)} sample${withheld === 1 ? '' : 's'} were withheld: they did not match the timings-and-counts shape this surface is allowed to show.`,
    metrics: TELEMETRY_METRICS.map((metric) => summarise(metric, rendered)),
    aborts: tally('abort', rendered),
    failures: tally('failure', rendered),
    recent: rendered
      .slice(-RECENT_SAMPLE_LIMIT)
      .reverse()
      .map((sample): DiagnosticsSampleView => ({
        seq: sample.seq,
        at: sample.at,
        turn: sample.turn,
        metric: sample.metric,
        label: METRIC_LABELS[sample.metric],
        unit: TELEMETRY_METRIC_UNITS[sample.metric],
        value: sample.value,
        formatted: formatTelemetryValue(sample.value, TELEMETRY_METRIC_UNITS[sample.metric]),
        category: sample.category,
      })),
    turns,
    emptyNote: rendered.length === 0 ? DIAGNOSTICS_EMPTY_NOTE : null,
    privacyNote: DIAGNOSTICS_PRIVACY_NOTE,
  };
}
