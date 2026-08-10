import { describe, expect, it } from 'vitest';
import { runSpeakDemo } from '../../src/voice/speak-demo.js';

/**
 * The walkthrough `pnpm demo:speak` prints, asserted rather than eyeballed.
 *
 * It spawns seven helper stubs and drives the whole shell composition — the
 * real `MacSpeechOutputAdapter` and the helper's synthesiser queue, PR-026's
 * `SpeechOutputBinding`, `main/speech-runtime.ts`, the interaction transition
 * table, PR-027's scheduler and Pi's agent loop — so it is slow and worth it:
 * it is the only thing in the repository that runs *ask, stream, speak* end to
 * end.
 *
 * Three kinds of assertion must never be deleted. The **chunk identifiers**
 * must keep matching `speechChunkId(stream, n)` with no callback discarded as
 * `unknown-chunk` (runbook follow-up 5 — the single most likely silent failure
 * of this PR). The **answer must survive a synthesiser failure**, in full and
 * out of the `error` state (system-design §16). And the output must keep
 * saying, in plain words, that **nothing has ever been spoken aloud**.
 *
 * The timing numbers in sections 6 and 7 are printed but only loosely
 * asserted: they are measured against a stub over a pipe, and runbook
 * cross-lane issue 7 is what happens when a suite treats wall time under
 * concurrent agent load as a property.
 */

describe('pnpm demo:speak', () => {
  it('speaks an answer in chunks, survives a failing synthesiser, and says what it did not prove', async () => {
    const { lines } = await runSpeakDemo();
    const output = lines.join('\n');

    // The disclaimer, in the header and again at the end.
    expect(output).toContain('NOTHING HAS EVER BEEN SPOKEN ALOUD');
    expect(output).toContain('No AVSpeechSynthesizer has run');

    // 1 — the boundary that changed.
    expect(output).toContain('the one fake boundary PR-033 replaces');
    expect(output).toContain('platform:  kind=macos-stub');
    expect(output).toContain('com.apple.voice.compact.en-US.Samantha');

    // 2 — one answer, several utterances, in order, and one `speaking` edge
    //     for the whole answer.
    expect(output).toContain('0. Auto Renew charges the card on file when the plan expires.');
    expect(output).toContain('1. Turning it off stops the next charge.');
    expect(output).toContain('2. You can switch it back on at any time.');
    expect(output).toContain('chunks the synthesiser accepted=3 silenced=0');
    expect(output).toContain('the panel’s speaking indicator went: speaking → silent');

    // 3 — runbook follow-up 5, read off the wire. Each utterance is named
    //     `<speechId>#<n>` and every callback found its chunk.
    expect(output).toMatch(/ {5}speech-[0-9a-f-]+#0 {3}matches speechChunkId\(stream, 0\)/);
    expect(output).toMatch(/ {5}speech-[0-9a-f-]+#2 {3}matches speechChunkId\(stream, 2\)/);
    expect(output).toContain('callbacks discarded as unknown-chunk: 0');
    expect(output).toContain('the answer reported completion: true');

    // 4 — §16. A failing synthesiser costs the sound and nothing else.
    expect(output).toContain('state:                 observing (not "error")');
    expect(output).toContain('lastError:             null');
    expect(output).toContain('chunks accepted=3 silenced=3');
    expect(output).toContain(
      '"Auto Renew charges the card on file when the plan expires. Turning it off ' +
        'stops the next charge. You can switch it back on at any time."',
    );
    expect(output).toContain('and it is complete: pending=false');
    expect(output).toContain('text fallback reachable: true');

    // 4b — a Mac with no voice asks the platform for nothing at all.
    expect(output).toContain('availability: available=false voices=0');
    expect(output).toContain('round trips to the synthesiser: 0');

    // 5 — runbook follow-up 15.
    expect(output).toContain('stop("speech-never-opened#0") threw: false');
    expect(output).toContain('events it produced:    (none)');

    // 6 — §17. The budget is 300 ms; the printed number is the measurement.
    expect(output).toContain('state when the interruption landed: speaking');
    expect(output).toContain('still speaking:                     false');
    const interruption = /command → synthesiser told: +([0-9.]+) ms/.exec(output);
    expect(interruption).not.toBeNull();
    expect(Number(interruption?.[1])).toBeLessThan(300);

    // 7 — runbook follow-up 25. Both configurations answer; the numbers are for
    //     a reader, not for an assertion.
    expect(output).toContain('without a scheduler (PR-029)');
    expect(output).toContain('with one (PR-033)');
    expect(output).toMatch(/without a scheduler \(PR-029\).*first word spoken \d+ ms/);
    expect(output).toMatch(/with one \(PR-033\).*first word spoken \d+ ms/);
  }, 120_000);
});
