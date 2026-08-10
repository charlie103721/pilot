import { describe, expect, it } from 'vitest';
import { TelemetryRing } from '../../src/main/telemetry.js';
import { telemetrySampleSchema, TELEMETRY_METRICS } from '../../src/ipc/schemas.js';
import { telemetrySampleIsContentFree } from '../../src/diagnostics/view-model.js';

/**
 * The ring buffer, and the promise it exists to keep.
 *
 * system-design §17: metrics record timings and counts, not screen content.
 * The last two tests here are the ones that matter — they say that every sample
 * this class can produce is numbers and closed-vocabulary categories, whatever
 * the caller does.
 */

function ring(options: { capacity?: number } = {}) {
  let clock = 1_700_000_000_000;
  const instance = new TelemetryRing({
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
    now: () => clock,
  });
  return {
    instance,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('telemetry ring', () => {
  it('records a timing against the turn that was open', () => {
    const { instance } = ring();
    expect(instance.turn).toBe(0);
    expect(instance.beginTurn()).toBe(1);
    instance.timing('stt-duration', 1_240);

    const [sample] = instance.snapshot().samples;
    expect(sample).toMatchObject({ seq: 0, turn: 1, metric: 'stt-duration', value: 1_240 });
  });

  it('rounds milliseconds but keeps counts and bytes exact', () => {
    const { instance } = ring();
    instance.timing('time-to-first-token', 118.6);
    instance.count('image-bytes', 412_608);

    const values = instance.snapshot().samples.map((sample) => sample.value);
    expect(values).toEqual([119, 412_608]);
  });

  it('drops a measurement that cannot be true rather than showing it', () => {
    const { instance } = ring();
    instance.timing('stt-duration', -1);
    instance.timing('stt-duration', Number.NaN);
    instance.count('active-images', Number.POSITIVE_INFINITY);

    // A diagnostics panel showing `-1 ms` teaches its reader to distrust it.
    expect(instance.snapshot().samples).toHaveLength(0);
    expect(instance.snapshot().recorded).toBe(0);
  });

  it('forgets the oldest samples and says how many, rather than forgetting quietly', () => {
    const { instance } = ring({ capacity: 3 });
    for (let index = 0; index < 5; index += 1) {
      instance.count('observation-calls', index);
    }

    const buffer = instance.snapshot();
    expect(buffer.samples.map((sample) => sample.value)).toEqual([2, 3, 4]);
    expect(buffer.recorded).toBe(5);
    expect(buffer.dropped).toBe(2);
    expect(buffer.capacity).toBe(3);
  });

  it('never mutates a snapshot that has already been published', () => {
    const { instance } = ring();
    instance.count('active-images', 1);
    const first = instance.snapshot().samples;
    instance.count('active-images', 2);

    expect(first).toHaveLength(1);
  });

  it('clears everything, including the turn counter', () => {
    const { instance } = ring();
    instance.beginTurn();
    instance.abort('user-interrupted');
    instance.clear();

    expect(instance.snapshot()).toMatchObject({ samples: [], recorded: 0, dropped: 0 });
    expect(instance.turn).toBe(0);
  });

  it('carries an abort and a failure as closed-vocabulary categories', () => {
    const { instance } = ring();
    instance.abort('window-changed');
    instance.failure('capture-failed');

    expect(instance.snapshot().samples.map((sample) => sample.category)).toEqual([
      'window-changed',
      'capture-failed',
    ]);
  });

  // -- the privacy properties ------------------------------------------------

  it('produces nothing but timings, counts and categories for every metric', () => {
    const { instance } = ring();
    instance.beginTurn();
    for (const metric of TELEMETRY_METRICS) {
      if (metric === 'abort') {
        instance.abort('new-question');
      } else if (metric === 'failure') {
        instance.failure('provider-unavailable');
      } else {
        instance.count(metric, 7);
      }
    }

    const samples = instance.snapshot().samples;
    expect(samples).toHaveLength(TELEMETRY_METRICS.length);
    for (const sample of samples) {
      // Two independent checks: the wire schema, which refuses unknown fields,
      // and the renderer's own guard, which refuses anything that is not a
      // number or a member of the closed vocabularies.
      expect(telemetrySampleSchema.safeParse(sample).success).toBe(true);
      expect(telemetrySampleIsContentFree(sample)).toBe(true);
      expect(Object.keys(sample).sort()).toEqual([
        'at',
        'category',
        'metric',
        'seq',
        'turn',
        'value',
      ]);
    }
  });

  it('has no recording method that accepts text', () => {
    const instance = new TelemetryRing();
    // A compile-time property, restated at runtime so a future refactor that
    // adds a `note(message: string)` is caught here as well as in review.
    const recorders = ['timing', 'count', 'abort', 'failure'] as const;
    for (const name of recorders) {
      expect(typeof instance[name]).toBe('function');
    }
    const methods = Object.getOwnPropertyNames(TelemetryRing.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methods.sort()).toEqual([
      'abort',
      'beginTurn',
      'clear',
      'count',
      'failure',
      'snapshot',
      'timing',
      'turn',
    ]);
  });
});
