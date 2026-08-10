import { describe, expect, it } from 'vitest';
import { runScreenPolicyDemo } from '../src/policy-demo.js';
import { POLICY_RULES, POLICY_RULE_TABLE } from '../src/policy-enforcer.js';
import { SCREEN_REDACTION_CAVEAT } from '../src/screen-policy.js';

/**
 * The PR-017 demo is the documented verification procedure, so its output is
 * pinned here: `pnpm --filter @pilot/observation demo:policy` must keep telling
 * exactly this story.
 */
describe('screen policy demo', () => {
  it('is deterministic: two runs are identical', async () => {
    const [first, second] = await Promise.all([runScreenPolicyDemo(), runScreenPolicyDemo()]);
    expect(first.lines).toStrictEqual(second.lines);
  });

  it('prints the whole rule table', async () => {
    const { lines } = await runScreenPolicyDemo();
    for (const rule of POLICY_RULES) {
      expect(lines.some((line) => line.startsWith(rule))).toBe(true);
    }
  });

  it('allows the four §9 view/moment combinations and says what each produced', async () => {
    const { scenarios } = await runScreenPolicyDemo();
    const allowed = scenarios.filter((scenario) => scenario.outcome === 'allowed');
    expect(allowed.map((scenario) => scenario.label)).toStrictEqual([
      'question / window',
      'question / both',
      'current / pointer',
      'before-and-after / window',
      'question / both, password field in view',
      'question / window, ordinary target',
      'rate limit +0 ms',
      'rate limit +100 ms',
      'rate limit +1000 ms',
    ]);
    expect(allowed[0]?.note).toContain('window 1440×960');
    expect(allowed[1]?.note).toContain('pointer 640×640');
    expect(allowed[3]?.note).toContain('before 1440×960');
  });

  it('names one rule for every rejected scenario, never a silent empty result', async () => {
    const { scenarios } = await runScreenPolicyDemo();
    const rejected = scenarios.filter((scenario) => scenario.outcome === 'rejected');
    expect(rejected.length).toBeGreaterThanOrEqual(18);
    for (const scenario of rejected) {
      expect(scenario.rule).not.toBeNull();
      expect(POLICY_RULES).toContain(scenario.rule);
      expect(scenario.code).toBe(POLICY_RULE_TABLE[scenario.rule!].code);
      expect(scenario.note.length).toBeGreaterThan(0);
    }
  });

  it('refuses every attempt to look at anything but the selected window', async () => {
    const { scenarios } = await runScreenPolicyDemo();
    const privacy = scenarios.filter((scenario) =>
      [
        'capture source is a display',
        'capture source unknown',
        'fresh capture returns another window',
      ].includes(scenario.label),
    );
    expect(privacy).toHaveLength(3);
    expect(privacy.map((scenario) => scenario.rule)).toStrictEqual([
      'selected-window-only',
      'selected-window-only',
      'frame-window-identity',
    ]);
  });

  it('shows the rate limit refusing the third call and recovering at +1000 ms', async () => {
    const { lines } = await runScreenPolicyDemo();
    expect(lines.some((line) => line.startsWith('+0 ms') && line.includes('ALLOWED'))).toBe(true);
    expect(
      lines.some((line) => line.startsWith('+200 ms') && line.includes('retry after 800 ms')),
    ).toBe(true);
    expect(lines.some((line) => line.startsWith('+1000 ms') && line.includes('ALLOWED'))).toBe(
      true,
    );
  });

  it('clears the buffers for each of pause, lock, window loss and shutdown', async () => {
    const { lines } = await runScreenPolicyDemo();
    for (const event of ['pause', 'screen-lock', 'window-loss', 'shutdown']) {
      expect(
        lines.some((line) => line.startsWith(event) && line.includes('cleared 9 frames')),
      ).toBe(true);
    }
    expect(lines.filter((line) => line.includes('buffers empty=true'))).toHaveLength(4);
    expect(lines.filter((line) => line.includes('lineage reset=true'))).toHaveLength(1);
  });

  it('ends by saying what redaction does not promise', async () => {
    const { lines } = await runScreenPolicyDemo();
    expect(lines).toContain(SCREEN_REDACTION_CAVEAT);
  });
});
