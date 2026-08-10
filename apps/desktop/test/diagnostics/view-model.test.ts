import { describe, expect, it } from 'vitest';
import { PILOT_ERROR_CODES } from '@pilot/shared';
import {
  ABORT_CATEGORIES,
  DEFAULT_TELEMETRY_CAPACITY,
  TELEMETRY_METRICS,
  telemetrySampleSchema,
  type ConversationGateState,
  type TelemetrySample,
} from '../../src/ipc/schemas.js';
import {
  buildDiagnosticsView,
  buildDiagnosticsViewFrom,
  diagnosticsDataStrings,
  formatTelemetryValue,
  METRIC_LABELS,
  partitionTelemetry,
  telemetrySampleIsContentFree,
} from '../../src/diagnostics/view-model.js';
import { FIXTURE_ANSWER_CHUNKS, FIXTURE_QUESTION } from '../../src/main/conversation-fixtures.js';
import { conversationHarness } from '../main/support.js';

/**
 * The diagnostics surface, and the promise it exists to keep.
 *
 * system-design §17 says metrics record timings and counts, not screen content;
 * §13 puts base64 images, raw audio and screen-bearing prompts in the "never
 * logged" column. The last block below is the assertion that makes that true of
 * the shipped panel rather than only of the intention behind it: a real fixture
 * conversation is replayed through the real gate, and then every value the
 * diagnostics surface would render is searched for the words that were said.
 */

function sample(patch: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    seq: 0,
    at: 1_700_000_000_000,
    turn: 1,
    metric: 'stt-duration',
    value: 1_200,
    category: null,
    ...patch,
  };
}

function bufferOf(samples: readonly TelemetrySample[]): ConversationGateState['telemetry'] {
  return {
    samples,
    capacity: DEFAULT_TELEMETRY_CAPACITY,
    recorded: samples.length,
    dropped: 0,
  };
}

describe('the content guard', () => {
  it('accepts a sample that is entirely timings, counts and closed categories', () => {
    expect(telemetrySampleIsContentFree(sample())).toBe(true);
    expect(
      telemetrySampleIsContentFree(sample({ metric: 'abort', category: 'new-question' })),
    ).toBe(true);
  });

  it('accepts every metric and every category the vocabulary admits', () => {
    for (const metric of TELEMETRY_METRICS) {
      expect(telemetrySampleIsContentFree(sample({ metric }))).toBe(true);
    }
    for (const category of [...ABORT_CATEGORIES, ...PILOT_ERROR_CODES]) {
      expect(telemetrySampleIsContentFree(sample({ category }))).toBe(true);
    }
  });

  it('refuses a sample carrying a field that is not a number or a category', () => {
    const smuggled = [
      { ...sample(), note: 'the user asked about the Auto Renew toggle' },
      { ...sample(), frame: 'iVBORw0KGgoAAAANSUhEUg' },
      { ...sample(), category: 'the recogniser said “what does this do”' },
      { ...sample(), metric: 'transcript' },
      { ...sample(), value: 'fast' },
    ];

    for (const candidate of smuggled) {
      expect(telemetrySampleIsContentFree(candidate)).toBe(false);
    }
  });

  it('withholds and counts what it refuses, rather than rendering it', () => {
    const partition = partitionTelemetry([
      sample(),
      { ...sample({ seq: 1 }), userMessage: 'Billing Settings — Auto Renew' },
    ]);

    expect(partition.rendered).toHaveLength(1);
    expect(partition.withheld).toBe(1);

    const view = buildDiagnosticsViewFrom(
      { ...bufferOf([]), samples: partition.rendered, recorded: 2 },
      true,
    );
    expect(view.recent).toHaveLength(1);
  });

  it('says so loudly when something was withheld', () => {
    const view = buildDiagnosticsViewFrom(
      bufferOf([{ ...sample(), title: 'Billing Settings' } as TelemetrySample]),
      true,
    );

    expect(view.withheld).toBe(1);
    expect(view.withheldNote).toContain('withheld');
    expect(view.recent).toHaveLength(0);
  });

  it('is the same shape the wire schema enforces', () => {
    // Two guards, one rule. If they ever disagree, one of them is wrong.
    for (const candidate of [sample(), { ...sample(), extra: 1 }, { ...sample(), value: -1 }]) {
      expect(telemetrySampleSchema.safeParse(candidate).success).toBe(
        telemetrySampleIsContentFree(candidate) && candidate.value >= 0,
      );
    }
  });
});

describe('summaries', () => {
  it('lists every §17 metric, measured or not', () => {
    const view = buildDiagnosticsViewFrom(bufferOf([]), true);

    expect(view.metrics.map((metric) => metric.metric)).toEqual([...TELEMETRY_METRICS]);
    for (const metric of view.metrics) {
      expect(metric.label).toBe(METRIC_LABELS[metric.metric]);
    }
  });

  it('shows an unmeasured metric as absent, never as zero', () => {
    const view = buildDiagnosticsViewFrom(bufferOf([]), true);
    const stt = view.metrics.find((metric) => metric.metric === 'stt-duration');

    expect(stt).toMatchObject({ samples: 0, last: null, min: null, max: null, mean: null });
    expect(view.emptyNote).not.toBeNull();
  });

  it('summarises last, min, max and mean in the metric’s own unit', () => {
    const view = buildDiagnosticsViewFrom(
      bufferOf([
        sample({ seq: 0, value: 100 }),
        sample({ seq: 1, value: 300 }),
        sample({ seq: 2, value: 200 }),
      ]),
      true,
    );
    const stt = view.metrics.find((metric) => metric.metric === 'stt-duration');

    expect(stt).toMatchObject({
      samples: 3,
      last: '200 ms',
      min: '100 ms',
      max: '300 ms',
      mean: '200 ms',
    });
  });

  it('tallies aborts and failures by category, commonest first', () => {
    const view = buildDiagnosticsViewFrom(
      bufferOf([
        sample({ seq: 0, metric: 'abort', value: 1, category: 'user-interrupted' }),
        sample({ seq: 1, metric: 'abort', value: 1, category: 'user-interrupted' }),
        sample({ seq: 2, metric: 'abort', value: 1, category: 'new-question' }),
        sample({ seq: 3, metric: 'failure', value: 1, category: 'capture-failed' }),
      ]),
      true,
    );

    expect(view.aborts).toEqual([
      { metric: 'abort', category: 'user-interrupted', count: 2 },
      { metric: 'abort', category: 'new-question', count: 1 },
    ]);
    expect(view.failures).toEqual([{ metric: 'failure', category: 'capture-failed', count: 1 }]);
  });

  it('says when the ring has forgotten samples, so a tail is not read as everything', () => {
    const view = buildDiagnosticsViewFrom(
      { samples: [sample()], capacity: 1, recorded: 40, dropped: 39 },
      true,
    );

    expect(view.truncated).toBe(true);
    expect(view.dropped).toBe(39);
    expect(view.retained).toBe(1);
  });

  it('formats milliseconds, counts and bytes so the number can be read', () => {
    expect(formatTelemetryValue(118, 'ms')).toBe('118 ms');
    expect(formatTelemetryValue(1_520, 'ms')).toBe('1.52 s');
    expect(formatTelemetryValue(412_608, 'bytes')).toBe('402.9 KiB');
    expect(formatTelemetryValue(3, 'count')).toBe('3');
  });
});

describe('no conversation reaches the diagnostics surface', () => {
  /** Words worth ≥3 letters from everything the fixtures put on screen. */
  const spokenWords = [
    ...new Set(
      [FIXTURE_QUESTION, ...FIXTURE_ANSWER_CHUNKS]
        .join(' ')
        .split(/\s+/)
        .map((word) => word.replace(/[^A-Za-z]/g, ''))
        .filter((word) => word.length >= 3),
    ),
  ];

  function replayedDiagnostics() {
    const harness = conversationHarness();
    harness.replay('spoken-question');
    harness.replay('typed-question');
    harness.replay('interrupted-answer');
    harness.replay('stt-failure');
    return {
      harness,
      view: buildDiagnosticsView({ ...harness.gate.snapshot(), diagnosticsVisible: true }),
    };
  }

  it('measured a real conversation, so this is not a test of an empty buffer', () => {
    const { harness, view } = replayedDiagnostics();

    expect(view.recorded).toBeGreaterThan(15);
    expect(view.turns).toBe(4);
    expect(harness.controller.snapshot().transcript.length).toBeGreaterThan(0);
  });

  it('renders no word that was said, in any measured value', () => {
    const { view } = replayedDiagnostics();
    const rendered = diagnosticsDataStrings(view).join(' ');

    const leaked = spokenWords.filter((word) => new RegExp(`\\b${word}\\b`, 'i').test(rendered));
    expect(leaked).toEqual([]);
  });

  it('renders neither the question nor any chunk of the answer anywhere at all', () => {
    const { view } = replayedDiagnostics();
    // The whole view this time, authored copy included: a phrase that long
    // could only have arrived from the conversation.
    const everything = JSON.stringify(view);

    for (const phrase of [FIXTURE_QUESTION, ...FIXTURE_ANSWER_CHUNKS]) {
      expect(everything).not.toContain(phrase.trim());
    }
    expect(everything).not.toContain('Billing Settings');
  });

  it('renders only numbers, metric names and categories as data', () => {
    const { view } = replayedDiagnostics();
    const vocabulary = new Set<string>([
      ...TELEMETRY_METRICS,
      ...ABORT_CATEGORIES,
      ...PILOT_ERROR_CODES,
      'ms',
      'count',
      'bytes',
      '',
    ]);

    for (const value of diagnosticsDataStrings(view)) {
      if (vocabulary.has(value)) {
        continue;
      }
      // Everything else must be a formatted number: digits, an optional
      // decimal, and a unit suffix. There is no third kind of value.
      expect(value).toMatch(/^\d+(\.\d+)?( (ms|s|B|KiB|MiB))?$/);
    }
  });

  it('states on itself what it cannot contain', () => {
    const { view } = replayedDiagnostics();

    expect(view.privacyNote).toContain('Timings and counts only');
  });
});
