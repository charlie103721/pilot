import { describe, expect, it } from 'vitest';
import { runFlowDemo } from '../../src/voice/flow-demo.js';

/**
 * The walkthrough `pnpm demo:flow` prints, asserted rather than eyeballed.
 *
 * It drives the whole shell composition twice — the real `MacHotkeyAdapter`,
 * `MacSpeechInputAdapter`, `MacSpeechOutputAdapter`, `MacObservationAdapter`,
 * `MacAccessibilityAdapter` and `MacWindowAdapter` over `NativeHelperTransport`,
 * `ObservationSession`, `PilotScreenContextService`, the §10 policy and the
 * image pipeline, the interaction transition table, `PiAgentSession` and Pi's
 * agent loop — so it is slow, and it is the only thing in the repository that
 * runs **select → point → speak → look → stream → hear → interrupt** as one
 * trace.
 *
 * Four groups of assertion must never be deleted, because each is a claim the
 * MVP scenario makes and each fails silently:
 *
 *  1. **The trace is in order.** The state path must contain the mvp-01 §7
 *     sequence — `listening → transcribing → thinking → observing-screen →
 *     thinking → speaking` — and the answer must reach the synthesiser as
 *     `<speechId>#0`, `#1`, in the order it is on screen. A trace that reaches
 *     the same end state by another route is not this scenario.
 *  2. **The invariants hold in that same trace.** Selected-window-only, no
 *     image bytes in any log line or on disk, no foreign accessibility label
 *     anywhere in the prompt, and no `-1.000` sentinel.
 *  3. **The interruption leaves nothing behind.** No chunk of the abandoned
 *     answer may reach the synthesiser after the stop.
 *  4. **The output keeps saying what it did not prove.** The acceptance table
 *     and the closing list are the difference between a demo and an over-claim,
 *     and this PR is where an over-claim would be most damaging.
 *
 * Wall-clock numbers are deliberately *not* asserted: runbook cross-lane issue
 * 7 is what happens when a suite treats timing under concurrent agent load as a
 * property.
 */

describe('pnpm demo:flow', () => {
  it('runs the MVP point-ask-hear scenario as one trace and says what it did not prove', async () => {
    const { lines } = await runFlowDemo();
    const output = lines.join('\n');

    // The disclaimer, at the top and again at the end.
    expect(output).toContain('NOT REAL: no macOS, no key, no microphone, no speaker, no model');
    expect(output).toContain('NO MODEL CHOSE ANYTHING');
    expect(output).toContain('NOTHING WAS HEARD AND NOTHING WAS SAID ALOUD');

    // 0 — one composition, and the gate that runs before anything is sent.
    expect(output).toContain('platform:                                      kind=macos-stub');
    expect(output).toContain(
      'capability gate:                               vision=true tools=true',
    );
    expect(output).toContain('provider requests so far:                      0');
    expect(output).toContain('agent.screenContext === observation.screenContext: true');

    // [1] one window, and only that window at the wire.
    expect(output).toContain(
      'chosen:                                        Safari — "Billing Settings"',
    );
    expect(output).toContain('capture.start × 1 for windowNumber 42 (the selected window is 42)');

    // [2] a frame stamped with the other window is refused by the session.
    expect(output).toContain(
      'a frame stamped with the other window:         admitted=false, rejected=1',
    );

    // [3] the key, the words. Every partial the panel rendered, in order.
    expect(output).toContain('attribution first:                             matched (direct)');
    expect(output).toMatch(/\| what\n {7}\| what is\n {7}\| what is this/);

    // [4] the anchor: the pointer at push-to-talk release, on the button.
    expect(output).toContain('the accepted transcript:                       "What is this?"');
    expect(output).toMatch(/anchor: +at=\d+ skewMs=-?\d+ insideWindow=true targetRole=AXButton/);
    expect(output).toContain('pointer samples in it:                         3');

    // [5] the model looked, and a policy-checked image reached it. The
    //     envelope is read from the request the provider actually received.
    expect(output).toContain('observe_screen view=both moment=question');
    expect(output).toContain('images produced:                               window 1280×800 png');
    expect(output).toContain('pointer 640×640 png');
    expect(output).toContain(
      '| pointer: 0.500, 0.500 (window-relative, inside the selected window)',
    );
    expect(output).toContain('| pointer target: AXButton — Update payment method');
    expect(output).toContain('"source":"selected-window-only"');
    expect(output).toMatch(
      /the provider received: +image\/png, \d+ base64 chars; image\/png, \d+ base64 chars/,
    );

    // [6] mvp-01 checkpoint D: speech starts before the answer finishes.
    expect(output).toContain('still streaming when the first chunk was spoken: pending=true');

    // [7] the answer, spoken in order, with PR-026's per-chunk identifiers.
    expect(output).toMatch(/ {7}speech-[0-9a-f-]+#0 = speechChunkId\(stream, 0\)/);
    expect(output).toMatch(/ {7}speech-[0-9a-f-]+#1 = speechChunkId\(stream, 1\)/);
    expect(output).toContain('"That is the Update payment method button."');
    expect(output).toContain('the opening of the answer on screen, in order');

    // [8] the interruption, and the follow-up that replaces it.
    expect(output).toContain(
      'the follow-up:                                 "And can I turn it off later?"',
    );
    expect(output).toContain('stale chunks of the old answer spoken after the stop: 0');
    expect(output).toContain(
      'the new chunks, joined:                        exactly the answer on screen',
    );
    expect(output).toContain(
      'observations in the whole trace:               1 (the follow-up was answered without a second look)',
    );

    // The path itself: every mvp-01 §7 row of the scenario, walked in one run
    // and read back out of the recorded path. The exact path is deliberately
    // not pinned — an extra `thinking → speaking` edge under load is not a
    // defect, a missing row is (runbook cross-lane issue 7).
    expect(output).toContain('idle → observing → listening → transcribing → thinking');
    expect(output).not.toContain('NOT WALKED');
    expect(output.match(/walked$/gm)?.length).toBe(8);
    for (const row of [
      'observing + push-to-talk down',
      'listening + push-to-talk up',
      'transcribing + transcript accepted',
      'thinking + screen tool starts',
      'observing-screen + tool result returned',
      'thinking + first speakable sentence',
      'speaking + new push-to-talk',
    ]) {
      expect(output).toContain(row);
    }

    // 2 — the invariants, on that same trace.
    expect(output).toContain('the other window’s title anywhere in the prompt: false');
    expect(output).toContain('any base64-shaped run in any log line:         false');
    expect(output).toContain('any data: URI in any log line:                 false');
    expect(output).toContain('files created under the repository:            0');
    expect(output).toMatch(/the base64 the model received, in any log line: false/);
    expect(output).toContain('accessibility.element-at:                      ownerPid=501');
    expect(output).toContain('the outside element’s label anywhere in the prompt: false');
    expect(output).toContain('the stacked window’s label anywhere in the prompt: false');
    expect(output).toContain('"-1.000" anywhere in any request:              false');
    expect(output).toContain('every question in this trace was anchored:     true');

    // Nothing that belongs to another application may appear anywhere at all —
    // not in the prompt, not in a printed line (§9/§14).
    expect(output).not.toContain('Private release notes');
    expect(output).not.toContain('Another desktop entirely');

    // 3 — the refusal, and the flow the user is left with.
    expect(output).toContain('attribution:                                   helper-attributed');
    expect(output).toContain('the push-to-talk tap was installed:            false');
    expect(output).toContain('presses that became commands:                  0');
    expect(output).toContain('unavailable/permission-unattributed');
    expect(output).toContain('"failure":"permission-denied"');
    expect(output).toContain('images the provider received:                  0');
    // The refused answer is still spoken. How many utterances it is cut into
    // depends on when the phrase timeout fires, so only "at least one" is a
    // property (runbook cross-lane issue 7).
    expect(output).toMatch(/spoken: +[1-9]\d* chunk\(s\) reached the synthesiser/);
    expect(output).toContain('still able to ask again:                       true');

    // 4 — the acceptance matrix, honestly. The `no` rows are the point of it.
    expect(output).toContain('A-01  partial');
    expect(output).toContain('A-02  no');
    expect(output).toContain('A-15  no');
    expect(output).toContain('A-08  partial');
  }, 180_000);
});
