import { describe, expect, it } from 'vitest';
import { runInterruptFlowDemo } from '../../src/voice/interrupt-demo.js';

/**
 * The walkthrough `pnpm demo:interrupt-flow` prints, asserted rather than
 * eyeballed.
 *
 * It drives the whole shell composition three times — the real
 * `MacHotkeyAdapter`, `MacSpeechInputAdapter`, `MacSpeechOutputAdapter`,
 * `MacObservationAdapter`, `MacAccessibilityAdapter` and `MacWindowAdapter` over
 * `NativeHelperTransport`, `ObservationSession`, `PilotScreenContextService`,
 * the interaction transition table, `PiAgentSession` and Pi's agent loop — so it
 * is slow, and it is the only thing in the repository that interrupts a *screen
 * observation in flight* through the shipping composition.
 *
 * Five groups of assertion must never be deleted, because each is a claim
 * PR-035 makes and each fails silently:
 *
 *  1. **The decision holds.** `interruptModeFor('observing-screen')` is `abort`,
 *     the in-flight capture unwinds as `request-cancelled`, no frame and no
 *     image survive it, and the replacement question is asked and answered with
 *     no `run-already-active` anywhere. That last one is the whole of runbook
 *     §8 follow-up 14.
 *  2. **Late output does not resurface.** No superseded speech stream speaks
 *     again, no abandoned answer's text changes after its interruption, and no
 *     chunk of the answer interrupted before its first word is ever spoken.
 *  3. **The abandoned runs' terminal events are discarded, not shown.** Every
 *     one of them is rejected as `stale-run` — including `run-failed`, whose
 *     table cell would otherwise have put Pilot in `error` — and `lastError`
 *     reads `(none)` in every section.
 *  4. **The invariants still hold**: selected-window-only, no foreign
 *     accessibility label, no base64 in a log line, nothing written to disk, no
 *     `-1.000` sentinel.
 *  5. **The output keeps saying what it did not prove.** "The synthesiser was
 *     told to stop" is a JSON round trip, and this is the PR where reading it
 *     as "the sound stopped" would be most damaging.
 *
 * Wall-clock numbers and character counts are deliberately *not* asserted:
 * runbook cross-lane issue 7 is what happens when a suite treats timing under
 * concurrent agent load as a property.
 */

describe('pnpm demo:interrupt-flow', () => {
  it('interrupts in every state that is hard, and lets nothing late resurface', async () => {
    const { lines } = await runInterruptFlowDemo();
    const output = lines.join('\n');

    // The disclaimer, at the top and again at the end.
    expect(output).toContain('NOT REAL: no macOS, no key, no microphone, no speaker, no model');
    expect(output).toContain('NOTHING WAS SPOKEN AND NOTHING WAS SILENCED');
    expect(output).toContain('NO MODEL WAS INTERRUPTED');
    expect(output).toContain('NO PIXEL WAS CANCELLED');

    // 1 — the decision, and the capture it unwinds.
    expect(output).toContain("interruptModeFor('observing-screen') = abort");
    expect(output).toContain('capture.pull × 1 on the wire, helper told to take 1200 ms over it');
    expect(output).toContain('state after the press:                         listening');
    expect(output).toContain('rule=request-cancelled step=select code=cancelled');
    // Nothing the helper answered afterwards reached the ring, and no image
    // was ever produced for the question the user replaced.
    expect(output).toMatch(/when the helper’s frame finally arrived: +observations=0 refusals=1/);
    expect(output).toMatch(/framesIngested=(\d+) \(was \1\)/);
    expect(output).toMatch(/frames in the ring: +(\d+) \(was \1\)/);
    expect(output).toContain('image blocks any provider request carried:     0');
    expect(output).toContain('"failure":"cancelled"');
    expect(output).toContain('"images":[]');

    // …and the half a steer could not do: the replacement question is asked
    // and answered. This is runbook §8 follow-up 14, closed.
    expect(output).toContain(
      'the replacement question:                      "And what does the other one do?"',
    );
    expect(output).toContain(
      'answered:                                      "That one cancels the plan at the end of the billing period."',
    );
    expect(output).toContain('run-already-active anywhere in this run:       false');
    expect(output).not.toContain('Pilot is still working on the previous question');
    expect(output).toContain('idle → observing → thinking → observing-screen → listening');

    // 2 — two interruptions in quick succession.
    expect(output).toContain('questions asked:                               3');
    expect(output).toContain('answers on screen:                             3');
    expect(output).toContain(
      'the last answer, spoken whole:                 exactly the answer on screen',
    );
    expect(output).toContain('a superseded stream speaking again:            never');
    expect(output).toContain('every one is speechChunkId(stream, n), in order');
    // The panel half: an abandoned answer stops where it stopped.
    expect(output).not.toContain('CHANGED AFTER THE INTERRUPTION');
    expect(output).toMatch(/#1 unchanged \(\d+ chars\), #2 unchanged \(\d+ chars\)/);
    // The sentence queued behind the one being spoken is dropped, not deferred.
    expect(output).toMatch(/chunk #1 of speech-[0-9a-f-]+ \(\d+ chars\): stopped/);
    // Both presses landed on the mvp-01 §7 row they are supposed to.
    expect(output.match(/pressed in "speaking"/g)?.length).toBe(2);
    expect(output).toContain('speaking → silent → speaking → silent → speaking → silent');

    // 3 — the window between `run-completed` and the first spoken word.
    expect(output).toContain('the run:                                       activeRunId=null');
    expect(output).toMatch(/handed to the synthesiser: +1 utterance\(s\), accepted=1/);
    expect(output).toContain('chunks of the abandoned answer spoken after the stop: 0');
    // §16: the sound is what is lost, never the text.
    expect(output).toContain('the abandoned answer’s text, still on screen:  true');

    // 4 — every abandoned run's terminal event, discarded by the identity guard.
    expect(output).toContain('tool-finished in listening: stale-run');
    expect(output).toContain('run-failed in listening: stale-run');
    expect(output).toContain('run-aborted in transcribing: stale-run');
    // Nothing at all reached the user as an error, in any section.
    const lastErrors = output.match(/lastError: +(\S+)/g) ?? [];
    expect(lastErrors).toHaveLength(3);
    for (const entry of lastErrors) {
      expect(entry).toMatch(/\(none\)$/);
    }

    // 5 — the timing, and the sentence that has to go with it.
    expect(output).toMatch(
      /push-to-talk-down accepted → speech\.output\.stop handed to the transport: \d+ ms/,
    );
    expect(output).toContain('It is Pilot’s half of §17’s 300 ms.');
    expect(output).toContain('it is not sound stopping. No AVSpeechSynthesizer has ever run here.');

    // 6/7 — the invariants, on these same runs.
    expect(output).toContain('the other window’s title anywhere in any prompt: false');
    expect(output).toContain('the stacked window’s label anywhere in any prompt: false');
    expect(output).toContain('the label outside the window: false');
    expect(output).toContain('any base64-shaped run in any log line:         false');
    expect(output).toContain('any data: URI in any log line:                 false');
    expect(output).toContain('files created under the repository:            0');
    expect(output).toContain('"-1.000" in any request: false');
    expect(output).not.toContain('§16 text fallback:                             listening=NO');

    // Nothing belonging to another application may appear anywhere at all —
    // not in a prompt, not in a printed line (§9, §14).
    expect(output).not.toContain('Private release notes');
    expect(output).not.toContain('Another desktop entirely');
  }, 180_000);
});
