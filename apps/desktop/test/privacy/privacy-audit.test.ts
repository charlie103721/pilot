import { describe, expect, it } from 'vitest';
import {
  auditSelfCheck,
  EXPECTED_CLAIM_IDS,
  runPrivacyAudit,
  type PrivacyClaim,
} from '../../src/privacy/privacy-audit.js';

/**
 * `pnpm demo:privacy`, pinned (PR-041).
 *
 * The audit drives several helper processes, a real SQLite store, two credential
 * stores and a failing socket through the shipping composition, so this suite is
 * slow by construction — it runs it once and asserts on the result, the way
 * `test/lifecycle/failure-demo.test.ts` and `test/memory/memory-demo.test.ts` do
 * for theirs.
 *
 * **What is pinned is that the audit cannot go quiet.** A privacy audit fails in
 * a way no other demo can: it keeps printing PASS while checking less and less.
 * So the assertions here are mostly about the audit itself — every expected
 * claim reached, no claim without a verdict, every verdict from the closed set,
 * every claim carrying the artefact it was decided from, and the four claims
 * whose *positive* evidence would vanish first (the canary that must be on disk,
 * the images that must have been sent, the refusals the rate limit must have
 * produced, the scanners' own self-test) asserted by name.
 */

function claim(id: string): PrivacyClaim {
  return { id, claim: 'x', how: 'y', verdict: 'held', detail: 'z' };
}

describe('the audit’s own self-check', () => {
  it('accepts exactly the manifest', () => {
    expect(auditSelfCheck(EXPECTED_CLAIM_IDS.map(claim)).ok).toBe(true);
  });

  it('fails loudly when a check silently stops running', () => {
    const truncated = EXPECTED_CLAIM_IDS.slice(0, -3).map(claim);
    const check = auditSelfCheck(truncated);
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual([...EXPECTED_CLAIM_IDS].slice(-3));
  });

  it('fails when a claim appears that the manifest does not know about', () => {
    const check = auditSelfCheck([...EXPECTED_CLAIM_IDS.map(claim), claim('Z9')]);
    expect(check.ok).toBe(false);
    expect(check.stray).toEqual(['Z9']);
  });

  it('fails when one id is recorded twice, because one reading would hide the other', () => {
    const check = auditSelfCheck([...EXPECTED_CLAIM_IDS.map(claim), claim('A1')]);
    expect(check.ok).toBe(false);
    expect(check.duplicated).toEqual(['A1']);
  });
});

describe('the privacy audit', () => {
  it('reaches every claim, decides every one, and passes', { timeout: 600_000 }, async () => {
    const result = await runPrivacyAudit();
    const output = result.lines.join('\n');
    const byId = new Map<string, PrivacyClaim>(result.claims.map((entry) => [entry.id, entry]));

    // 1. Nothing stopped checking. This is the assertion the whole suite is
    //    for: a section that throws early or a claim lost in a merge would
    //    otherwise leave a shorter, still-green audit behind.
    expect([...byId.keys()].sort()).toEqual([...EXPECTED_CLAIM_IDS].sort());
    expect(result.claims).toHaveLength(EXPECTED_CLAIM_IDS.length);
    expect(output).toContain(
      `claims reached: ${String(EXPECTED_CLAIM_IDS.length)} of ${String(EXPECTED_CLAIM_IDS.length)}`,
    );
    expect(output).not.toContain('CLAIMS THAT NEVER RAN');
    expect(output).not.toContain('CLAIMS NOT IN EXPECTED_CLAIM_IDS');

    // 2. Every claim says what it checked and how, and its verdict is from
    //    the closed set. A claim with an empty `how` is a claim that read
    //    nothing.
    for (const entry of result.claims) {
      expect(['held', 'FAILED', 'unprovable']).toContain(entry.verdict);
      expect(entry.claim.length, `${entry.id} states nothing`).toBeGreaterThan(20);
      expect(entry.how.length, `${entry.id} says how it checked nothing`).toBeGreaterThan(20);
      expect(entry.detail.length, `${entry.id} gives no detail`).toBeGreaterThan(10);
    }

    // 3. The overall result, and no failures.
    expect(result.claims.filter((entry) => entry.verdict === 'FAILED')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(output).toContain('PRIVACY AUDIT: PASS');

    // 4. The scanners proved themselves before anything believed them.
    expect(byId.get('A1')?.verdict).toBe('held');

    // 5. The five §13 occasions were each driven and each named itself. These
    //    are read off the printed evidence, not off the claim, because the
    //    claim is a summary of them.
    for (const occasion of ['pause', 'screen-lock', 'window-loss', 'logout', 'shutdown']) {
      expect(output, `${occasion} was not driven`).toContain(`${occasion} — entry point:`);
    }
    expect(output).toMatch(/retention log says:\s+pause/);
    expect(output).toMatch(/retention log says:\s+logout/);
    expect(output).toMatch(/retention log says:\s+shutdown — lineage reset: true/);
    expect(byId.get('R1')?.verdict).toBe('held');
    expect(byId.get('R2')?.verdict).toBe('held');
    expect(byId.get('R3')?.verdict).toBe('held');

    // 6. The positive evidence, without which the negative results are
    //    vacuous. A disk sweep of an empty file, a policy check with no image
    //    and a rate-limit check with no refusal all "pass" and prove nothing.
    expect(byId.get('D3')?.verdict, 'the canary question must be ON disk').toBe('held');
    expect(output).toMatch(/image blocks the provider received:\s+[1-9]/);
    expect(output).toMatch(/of those, refused:\s+[1-9]/);
    expect(output).toMatch(/buffers before:\s+1 frame\(s\)/);

    // 7. The one claim that is honestly unprovable here says so rather than
    //    passing. If a future change made the redactor value-aware this would
    //    become `held`, and this assertion is the place to notice.
    expect(byId.get('L2')?.verdict).toBe('unprovable');
    expect(output).toContain('UNPROVABLE');

    // 8. The "never executed" section is present and names the Mac-only
    //    properties. It ships as the user's checklist; an audit that dropped
    //    it would read as a much stronger result than it is.
    expect(output).toContain('WHAT NONE OF THIS PROVED');
    for (const marker of [
      'WHERE THE FILES ACTUALLY ARE',
      'WHETHER THE KEYCHAIN SEALS THE TOKEN',
      'WHETHER REAL AUDIO IS EVER BUFFERED',
      'WHETHER REAL PIXELS BEHAVE',
      'WHETHER A REAL LOGOUT CLEARS',
    ]) {
      expect(output, `the Mac checklist lost "${marker}"`).toContain(marker);
    }

    // 9. The audit's own evidence line survived the redactor (runbook
    //    cross-lane issue 25, which has now eaten evidence four times).
    expect(byId.get('L1')?.verdict).toBe('held');
    expect(output).toMatch(/of those, eaten by the redactor:\s+none/);
  });
});
