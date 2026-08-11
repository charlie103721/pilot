import { describe, expect, it } from 'vitest';
import {
  acceptanceVerdict,
  blockedRows,
  criterion,
  distribution,
  executed,
  headline,
  passConditionTally,
  pending,
  VERDICTS,
} from '../../src/acceptance/verdict.js';

/**
 * The rule PR-043 exists to make unbreakable: **a criterion with no executed
 * evidence cannot report as passing.**
 *
 * `docs/mvp-01-point-ask-hear.md` §19 turns §18's fifteen rows into a release
 * gate, and this machine can satisfy almost none of it — no macOS, no model, no
 * screen. The temptation a hand-written acceptance table offers is to write
 * `pass` beside a row nobody checked, or to let supporting evidence stand in for
 * the pass condition. Every test below is a way that could happen, closed.
 *
 * These are unit tests over pure functions on purpose. The suite itself takes
 * about half a minute and spawns forty-odd helper processes; a rule this
 * important must be checkable in a millisecond, and must fail loudly if someone
 * later "simplifies" `acceptanceVerdict`.
 */

describe('acceptanceVerdict — a criterion with no evidence cannot pass', () => {
  it('reports not-implemented when there is no pass-condition check at all', () => {
    expect(acceptanceVerdict([])).toBe('not-implemented');
  });

  it('still reports not-implemented when every supporting check passed', () => {
    // The exact shape the honest-looking mistake takes: five green supporting
    // rows and nothing that tests §18's own sentence.
    const supporting = Array.from({ length: 5 }, (_unused, index) =>
      executed('supporting', `supporting claim ${String(index)}`, true, 'some evidence'),
    );
    expect(acceptanceVerdict(supporting)).toBe('not-implemented');
    expect(
      criterion({ id: 'A-XX', scenario: 's', passCondition: 'p', checks: supporting }).summary,
    ).toBe('no pass-condition check exists for this row');
  });

  it('reports blocked, never verified, when every pass-condition check is pending', () => {
    expect(
      acceptanceVerdict([
        pending('pass-condition', 'needs a Mac', 'mac', 'no macOS here'),
        executed('supporting', 'the input side is right', true, 'read off the wire'),
      ]),
    ).toBe('blocked-on-mac');
    expect(
      acceptanceVerdict([pending('pass-condition', 'needs a model', 'model', 'no model here')]),
    ).toBe('blocked-on-model');
  });

  it('treats a mixed blocker as blocked on a Mac, because a model alone would not close it', () => {
    expect(
      acceptanceVerdict([
        pending('pass-condition', 'needs both', 'mac-and-model', 'no macOS and no model'),
        pending('pass-condition', 'needs a model', 'model', 'no model'),
      ]),
    ).toBe('blocked-on-mac');
  });

  it('reports verified only when every pass-condition check ran and held', () => {
    expect(
      acceptanceVerdict([
        executed('pass-condition', 'a', true, 'evidence a'),
        executed('pass-condition', 'b', true, 'evidence b'),
      ]),
    ).toBe('verified');
  });

  it('reports verified-in-part when some pass conditions ran and some are pending', () => {
    expect(
      acceptanceVerdict([
        executed('pass-condition', 'a', true, 'evidence a'),
        pending('pass-condition', 'b', 'mac', 'no macOS here'),
      ]),
    ).toBe('verified-in-part');
  });

  it('reports failed for an executed check that did not hold, even a supporting one', () => {
    expect(
      acceptanceVerdict([
        executed('pass-condition', 'a', true, 'evidence a'),
        executed('supporting', 'b', false, 'evidence b'),
      ]),
    ).toBe('failed');
    // …and failure outranks blocked: a row that has a real defect must not be
    // filed with the ones that are merely waiting for a machine.
    expect(
      acceptanceVerdict([
        executed('pass-condition', 'a', false, 'evidence a'),
        pending('pass-condition', 'b', 'mac', 'no macOS here'),
      ]),
    ).toBe('failed');
  });

  it('never returns a verdict outside the closed set', () => {
    const cases = [
      [],
      [executed('supporting', 'a', true, 'e')],
      [executed('pass-condition', 'a', true, 'e')],
      [executed('pass-condition', 'a', false, 'e')],
      [pending('pass-condition', 'a', 'mac', 'r')],
      [pending('pass-condition', 'a', 'model', 'r')],
      [executed('pass-condition', 'a', true, 'e'), pending('pass-condition', 'b', 'model', 'r')],
    ];
    for (const checks of cases) {
      expect(VERDICTS).toContain(acceptanceVerdict(checks));
    }
  });
});

describe('a check cannot be constructed without evidence or a reason', () => {
  it('refuses an executed check with no evidence', () => {
    expect(() => executed('pass-condition', 'a claim', true, '')).toThrow(/needs evidence/);
    expect(() => executed('pass-condition', 'a claim', true, '   ')).toThrow(/needs evidence/);
  });

  it('refuses a pending check with no reason', () => {
    expect(() => pending('pass-condition', 'a claim', 'mac', '')).toThrow(/needs a reason/);
  });

  it('refuses a check with no claim', () => {
    expect(() => executed('supporting', '', true, 'evidence')).toThrow(/needs a claim/);
    expect(() => pending('supporting', '', 'mac', 'reason')).toThrow(/needs a claim/);
  });
});

describe('the verdict is derived, not supplied', () => {
  it('criterion() computes the verdict from the checks it was given', () => {
    const result = criterion({
      id: 'A-01',
      scenario: 'Select a native app window',
      passCondition: 'Only that window enters the frame ring',
      checks: [
        executed('pass-condition', 'a', true, 'e'),
        pending('pass-condition', 'b', 'mac', 'r'),
      ],
    });
    expect(result.verdict).toBe('verified-in-part');
    expect(result.summary).toBe('1 of 2 pass-condition check(s) executed here');
    // There is no way to say otherwise: `CriterionResult.verdict` has no setter
    // and `criterion` takes no verdict argument.
    expect(Object.keys(result)).not.toContain('setVerdict');
  });
});

describe('the summary a reader sees', () => {
  const rows = [
    criterion({
      id: 'A-01',
      scenario: 's',
      passCondition: 'p',
      checks: [executed('pass-condition', 'a', true, 'e')],
    }),
    criterion({
      id: 'A-02',
      scenario: 's',
      passCondition: 'p',
      checks: [pending('pass-condition', 'a', 'mac-and-model', 'r')],
    }),
    criterion({
      id: 'A-03',
      scenario: 's',
      passCondition: 'p',
      checks: [executed('pass-condition', 'a', false, 'e')],
    }),
  ];

  it('counts every verdict in the closed set', () => {
    const counts = distribution(rows);
    expect(counts.verified).toBe(1);
    expect(counts['blocked-on-mac']).toBe(1);
    expect(counts.failed).toBe(1);
    expect(Object.keys(counts).sort()).toEqual([...VERDICTS].sort());
  });

  it('leads with the verified count and names the word "blocked" before any score', () => {
    const line = headline(rows);
    expect(line).toContain('1 of 3 acceptance criteria are verified here');
    expect(line).toContain('blocked');
    expect(line.indexOf('blocked')).toBeLessThan(line.indexOf('verified in part'));
  });

  it('tallies pass-condition checks, which row counts understate', () => {
    const tally = passConditionTally(rows);
    expect(tally).toEqual({
      total: 3,
      executed: 2,
      pendingMac: 0,
      pendingModel: 0,
      pendingBoth: 1,
    });
  });

  it('says what each blocked row is waiting on, so a mixed blocker is not hidden', () => {
    expect(blockedRows(rows)).toEqual([{ id: 'A-02', blockers: 'a Mac and a model' }]);
  });
});
