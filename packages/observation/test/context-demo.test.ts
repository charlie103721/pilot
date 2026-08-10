import { describe, expect, it } from 'vitest';
import { OBSERVE_SCREEN_MOMENTS, OBSERVE_SCREEN_VIEWS } from '@pilot/shared';
import { runScreenContextDemo } from '../src/context-demo.js';
import { POLICY_RULES, POLICY_RULE_TABLE } from '../src/policy-enforcer.js';
import { RETENTION_EVENTS } from '../src/retention.js';

/**
 * The PR-019 demo is the documented verification procedure for the facade, so
 * what it claims is pinned here: `pnpm --filter @pilot/observation demo:context`
 * must keep telling exactly this story, and must keep telling it identically on
 * every machine.
 */
describe('screen context demo', () => {
  it('is deterministic: two runs are identical', async () => {
    const [first, second] = await Promise.all([runScreenContextDemo(), runScreenContextDemo()]);
    expect(first.lines).toStrictEqual(second.lines);
  }, 60_000);

  it('runs every view × moment combination and allows all nine', async () => {
    const { rows } = await runScreenContextDemo();
    const expected = OBSERVE_SCREEN_VIEWS.flatMap((view) =>
      OBSERVE_SCREEN_MOMENTS.map((moment) => `${view} / ${moment}`),
    );

    expect(rows.map((row) => `${row.view} / ${row.moment}`)).toStrictEqual(expected);
    expect(rows.every((row) => row.outcome === 'allowed')).toBe(true);
    expect(rows.every((row) => row.bytes > 0)).toBe(true);
  }, 60_000);

  it('takes "current" from a fresh capture and everything else from the ring', async () => {
    const { rows } = await runScreenContextDemo();
    for (const row of rows) {
      expect(row.origin).toBe(row.moment === 'current' ? 'fresh' : 'ring');
    }
  }, 60_000);

  it('produces two comparison frames for before-and-after whatever the view', async () => {
    const { rows } = await runScreenContextDemo();
    const comparisons = rows.filter((row) => row.moment === 'before-and-after');

    expect(comparisons).toHaveLength(3);
    for (const row of comparisons) {
      expect(row.images).toContain('before ');
      expect(row.images).toContain('after ');
      expect(row.images).not.toContain('pointer ');
    }
  }, 60_000);

  it('shows the lineage refusal and the abort refusal actually firing', async () => {
    const { lines } = await runScreenContextDemo();

    expect(lines).toContain('held scene          scene-000001 → superseded');
    expect(lines.some((line) => line.includes('threw scene-mismatch [scene-lineage]'))).toBe(true);
    expect(lines.some((line) => line.includes('threw cancelled [request-cancelled]'))).toBe(true);
    expect(lines).toContain('capture landed      false — the refusal did not wait for it');
    // Every "this is a defect" branch is a claim the demo makes about itself.
    expect(lines.some((line) => line.includes('NOT REFUSED'))).toBe(false);
  }, 60_000);

  it('reports the decoded-frame cache dropping on every retention event', async () => {
    const { lines } = await runScreenContextDemo();
    for (const event of RETENTION_EVENTS) {
      const line = lines.find((entry) => entry.startsWith(event));
      expect(line, event).toBeDefined();
      expect(line).toContain('image cache dropped=true');
    }
  }, 60_000);

  it('gives every refusal a rule from PR-017’s table and nothing invented', async () => {
    const { refusals } = await runScreenContextDemo();

    expect(refusals.length).toBeGreaterThanOrEqual(7);
    for (const refusal of refusals) {
      expect(POLICY_RULES).toContain(refusal.rule);
      expect(refusal.code).toBe(POLICY_RULE_TABLE[refusal.rule].code);
      expect(refusal.retryable).toBe(POLICY_RULE_TABLE[refusal.rule].retryable);
      expect(refusal.userMessage).toBe(POLICY_RULE_TABLE[refusal.rule].userMessage);
    }
    // The unwired-permission default is refused, not assumed.
    expect(refusals.find((refusal) => refusal.label === 'permission was never wired')?.code).toBe(
      'permission-denied',
    );
  }, 60_000);
});
