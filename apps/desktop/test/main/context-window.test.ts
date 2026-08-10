import { describe, expect, it } from 'vitest';
import { createDevelopmentModelSource } from '@pilot/agent';
import {
  CONSERVATIVE_CONTEXT_WINDOW,
  contextWindowInputOf,
  describeContextWindow,
  parseContextWindowOverride,
  resolveContextWindow,
  type ContextWindowSource,
} from '../../src/main/context-window.js';

/**
 * PR-036 — runbook follow-ups 7 and 9: `compaction.contextWindow` comes from the
 * profile, not from `model.contextWindow`.
 *
 * Written as a table for the same reason `observationPermissionConditions`'
 * test is: the function is five lines and every one of them is a decision that
 * is invisible once it is wrong. A context window that is too large means §11's
 * 60% trigger never fires and the endpoint truncates the conversation instead.
 */

interface Row {
  readonly name: string;
  readonly remote: boolean;
  readonly advertised: number | undefined;
  readonly expected: number;
  readonly source: ContextWindowSource;
}

const ROWS: readonly Row[] = [
  {
    name: 'a hosted model is believed',
    remote: true,
    advertised: 200_000,
    expected: 200_000,
    source: 'model',
  },
  {
    name: 'a hosted model with a small window is believed too',
    remote: true,
    advertised: 8_192,
    expected: 8_192,
    source: 'model',
  },
  {
    name: 'a local endpoint under the ceiling is believed',
    remote: false,
    advertised: 32_768,
    expected: 32_768,
    source: 'model',
  },
  {
    name: 'a local endpoint over the ceiling is capped',
    remote: false,
    advertised: 128_000,
    expected: CONSERVATIVE_CONTEXT_WINDOW,
    source: 'local-ceiling',
  },
  {
    name: 'a local endpoint that advertises nothing gets the conservative answer',
    remote: false,
    advertised: undefined,
    expected: CONSERVATIVE_CONTEXT_WINDOW,
    source: 'unknown',
  },
  {
    name: 'a hosted model that advertises nothing gets it as well',
    remote: true,
    advertised: undefined,
    expected: CONSERVATIVE_CONTEXT_WINDOW,
    source: 'unknown',
  },
  {
    name: 'a zero window is not a window',
    remote: true,
    advertised: 0,
    expected: CONSERVATIVE_CONTEXT_WINDOW,
    source: 'unknown',
  },
];

describe('resolveContextWindow', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const decision = resolveContextWindow({
        profile: { isRemote: row.remote },
        model: row.advertised === undefined ? {} : { contextWindow: row.advertised },
      });
      expect(decision.contextWindow).toBe(row.expected);
      expect(decision.source).toBe(row.source);
      expect(decision.remote).toBe(row.remote);
      expect(decision.advertised).toBe(
        row.advertised === undefined || row.advertised <= 0 ? null : row.advertised,
      );
    });
  }

  it('never reports a resolved window larger than one the caller could not check', () => {
    // The property, stated once rather than row by row: a local endpoint can
    // never end up with more budget than the ceiling, whatever it claims.
    for (const advertised of [1, 1_000, 32_768, 32_769, 200_000, Number.MAX_SAFE_INTEGER]) {
      const decision = resolveContextWindow({
        profile: { isRemote: false },
        model: { contextWindow: advertised },
      });
      expect(decision.contextWindow).toBeLessThanOrEqual(CONSERVATIVE_CONTEXT_WINDOW);
    }
  });

  it('lets an explicit override win over every rule', () => {
    const decision = resolveContextWindow(
      { profile: { isRemote: false }, model: { contextWindow: 128_000 } },
      { override: 4_096 },
    );
    expect(decision).toMatchObject({
      contextWindow: 4_096,
      source: 'override',
      advertised: 128_000,
    });
  });

  it('describes the decision without naming anything from the conversation', () => {
    const line = describeContextWindow(
      resolveContextWindow({ profile: { isRemote: false }, model: { contextWindow: 128_000 } }),
    );
    expect(line).toBe('32768 tokens (local-ceiling; local endpoint advertised 128000)');
  });
});

describe('parseContextWindowOverride', () => {
  it('accepts a positive integer', () => {
    expect(parseContextWindowOverride('4096')).toBe(4_096);
  });

  it.each([undefined, '', '   ', 'lots', '-1', '0', '1.5', 'NaN', '1e400'])(
    'ignores %p rather than treating it as zero',
    (raw) => {
      // A typo must not silently turn compaction into a per-turn event, which
      // is what a window of 0 would do.
      expect(parseContextWindowOverride(raw)).toBeNull();
    },
  );
});

describe('the development profile the app boots into', () => {
  it('is a local endpoint, so it is capped rather than believed', () => {
    // Pi's faux provider advertises 128k against `http://localhost:0`. That is
    // not a hosted model, and this is the case the app actually takes today.
    const source = createDevelopmentModelSource();
    const decision = resolveContextWindow(contextWindowInputOf(source));

    expect(source.profile.isRemote).toBe(false);
    expect(decision.advertised).toBe(128_000);
    expect(decision.contextWindow).toBe(CONSERVATIVE_CONTEXT_WINDOW);
    expect(decision.source).toBe('local-ceiling');
  });
});
