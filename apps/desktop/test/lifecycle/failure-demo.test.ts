import { describe, expect, it } from 'vitest';
import { runFailureDemo } from '../../src/lifecycle/failure-demo.js';

/**
 * `pnpm demo:failure`, pinned (PR-040).
 *
 * The walkthrough drives nine helper processes and thirteen failures through
 * the shipping composition, so this suite is slow by construction — it runs it
 * once and asserts on the output, the way `test/memory/memory-demo.test.ts` and
 * `test/observation/ask-demo.test.ts` do for theirs.
 *
 * What is pinned is the *shape of the answer*, not the prose: every case ends in
 * one of the two endings, none of them ends silently, and the handful of claims
 * that would be worth nothing if they quietly stopped being true — the retention
 * occasions, the re-probed attribution verdict, the surviving answer and the
 * surviving transcript — are asserted by name.
 */

describe('the failure matrix', () => {
  it('ends every case in recovery or a safe terminal state', { timeout: 300_000 }, async () => {
    const { lines } = await runFailureDemo();
    const output = lines.join('\n');

    // Every case has an ending, and the count is stated rather than implied.
    expect(output).toMatch(/14 cases: \d+ recovered, \d+ stopped safely, 0 silent\./);
    const endings = lines.filter((line) => line.trim().startsWith('ending '));
    expect(endings).toHaveLength(14);
    for (const ending of endings) {
      expect(ending).toMatch(/recovered|safe-terminal/);
    }

    // §13's five occasions, each named by the event that caused it. Two of them
    // had no caller in the product before this PR.
    expect(output).toContain('retention occasion for the clear:        permission-loss');
    expect(output).toMatch(/retention occasion:\s+screen-lock \(lineage kept: true\)/);
    expect(output).toMatch(/retention occasion:\s+logout — lineage reset: true/);
    expect(output).toMatch(/retention occasion:\s+window-loss/);

    // Nothing is left in a buffer after any of them.
    const leftBehind = lines.filter((line) => line.includes('left behind '));
    expect(leftBehind.length).toBeGreaterThan(10);
    for (const line of leftBehind) {
      expect(line).not.toContain('A RUN STILL ACTIVE');
    }

    // A protected window is refused rather than photographed, and the user is
    // told in a sentence rather than in a log line.
    expect(output).toContain('This application does not allow Pilot to see its window');
    expect(output).toMatch(/observation switch:\s+off/);

    // A crashed helper comes back, and the verdict cached against the dead
    // process is re-probed: one attribution call at startup, one after.
    expect(output).toMatch(/crashes \/ recoveries:\s+1 \/ 1/);
    expect(output).toMatch(/attribution probes on the wire:\s+2/);

    // A failure of the voice never costs the answer (PR-033's property, under a
    // crash and under a scripted synthesiser error).
    const survived = lines.filter((line) => line.includes('the answer survived:'));
    expect(survived).toHaveLength(2);
    for (const line of survived) {
      expect(line).not.toContain('NO');
    }

    // The recogniser failing leaves the text box live, and the same question
    // typed is answered.
    expect(output).toMatch(/typing still offered:\s+YES/);
    expect(output).toMatch(/typed instead:\s+answered/);

    // §16: reauthenticate without losing the transcript, and send nothing while
    // signed out.
    expect(output).toMatch(/transcript:\s+2 turn\(s\) before → 2 after/);
    expect(output).toMatch(/provider requests made while signed out:\s+0/);

    // The retry, and the retry Pilot refuses to make.
    expect(output).toMatch(/retries made:\s+1/);
    expect(output).toMatch(/screen has moved on:\s+ask-again \(scene-changed\)/);
    expect(output).not.toContain('RETRY — which would be the defect');

    // And the section that says what none of it proves.
    expect(output).toContain('WHAT THIS DOES NOT PROVE');
    expect(output).toContain('no permission has ever been revoked');
  });
});
