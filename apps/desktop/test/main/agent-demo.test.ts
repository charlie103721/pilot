import { describe, expect, it } from 'vitest';
import { runAgentDemo } from '../../src/main/agent-demo.js';

/**
 * The demo command is a deliverable, so it is tested like one.
 *
 * A demo that quietly stopped covering one of PR-029's four claims would be
 * worse than no demo: a reviewer would believe they had watched three turns, a
 * streamed answer, an interruption and a refusal.
 */

describe('the PR-029 demo', () => {
  it('covers all four claims, and says what is not real', async () => {
    const result = await runAgentDemo();
    const text = result.lines.join('\n');

    expect(result.turns).toBe(3);
    expect(text).toContain('three turns in a row');
    expect(text).toContain('Turn 1:');
    expect(text).toContain('Turn 2:');
    expect(text).toContain('Turn 3:');

    expect(text).toContain('the answer arrives as it is written');
    expect(text).toMatch(/re-rendered \d+ times while the answer grew/);

    expect(text).toContain('interrupted mid-answer');
    expect(text).toContain('still marked pending: true');
    expect(text).toContain('an interruption is not a failure');
    expect(text).toContain('the next question still gets an answer: true');

    expect(text).toContain('the capability gate refuses before anything is sent');
    expect(text).toContain('refused — unsupported-capability');
    expect(result.requestsWhileRefused).toBe(0);

    // The one thing this demo must never be read as claiming.
    expect(text).toContain('not a language model');
  }, 60_000);
});
