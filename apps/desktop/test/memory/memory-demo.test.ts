import { describe, expect, it } from 'vitest';
import { runMemoryDemo } from '../../src/memory/memory-demo.js';

/**
 * The walkthrough `pnpm demo:memory` prints, asserted rather than eyeballed.
 *
 * It drives the shell composition twice over a **real SQLite session database**
 * — the real `PilotInteractionController`, the real `PiAgentSession` with
 * PR-022a's pruner and PR-022b's compaction, the real `ConversationStore`, the
 * real `PilotScreenContextService` and §10 policy, the mac adapters over
 * `NativeHelperTransport` — so it is slow, and it is the only thing in the
 * repository that asks nine screen questions across two scene changes on one
 * conversation.
 *
 * Five groups of assertion must never be deleted, because each is a claim
 * `docs/implementation.md`'s PR-036 line makes and each fails silently:
 *
 *  1. **Images stay bounded.** No provider request may carry more image blocks
 *     than §10's two budgets allow, however many turns have gone by. Read off
 *     the requests the provider received, not off the pruner.
 *  2. **Text survives.** The first question must still be reachable in the last
 *     request of the run, and after a relaunch off disk.
 *  3. **No stale screen is offered as current.** Every replacement record must
 *     state the negation and carry a scene stamp; once the scene has moved, it
 *     must say where it went.
 *  4. **Compaction fires and is visible in the ring** as
 *     `context-tokens-before`/`-after`, with no conversation text in it.
 *  5. **Clearing empties the file**, checked by scanning the bytes.
 *
 * Token counts, timings and byte totals are deliberately *not* pinned: runbook
 * cross-lane issue 7 is what happens when a suite treats a number that varies
 * with load as a property. What is pinned is the *bound* and the *shape*.
 */

describe('pnpm demo:memory', () => {
  it('keeps images bounded and text alive across nine questions and two scene changes', async () => {
    const { lines } = await runMemoryDemo();
    const output = lines.join('\n');

    // The disclaimer, at the top and again at the end.
    expect(output).toContain('NOT REAL: no macOS, no model');
    expect(output).toContain('NO MODEL WAS EVER TOLD ANYTHING');
    expect(output).toContain('THE CONTEXT WINDOW IS A GUESS');

    // 1 — the budget, and where it comes from (follow-ups 7 and 9).
    expect(output).toContain('200000 tokens (model; remote endpoint advertised 200000)');
    expect(output).toContain('32768 tokens (local-ceiling; local endpoint advertised 128000)');
    expect(output).toContain('32768 tokens (unknown; local endpoint advertised nothing)');
    expect(output).toContain(
      'the §11 budget this session runs on:           32768 tokens (local-ceiling;',
    );

    // 2 — nine turns, on two windows, with no error.
    expect(output).toContain('restored on this launch:                       0 message(s)');
    expect(output).toMatch(/ {8}1 {2}Billing Settings/);
    expect(output).toMatch(/ {8}9 {2}Release checklist/);
    expect(output).toContain('answers on screen:                             9');
    expect(output).toContain('lastError:                                     (none)');
    // Runbook follow-up 31: this read 0 on the shipping path before PR-036.
    expect(output).toMatch(
      /pointer samples \(follow-up 31\): {16}\d+ admitted, of which \d+ through groundFast/,
    );
    expect(output).not.toMatch(/pointer samples \(follow-up 31\): {16}0 admitted/);

    // 3 — the bound, which is the whole point of the PR. §10 allows one full
    //     frame and one pointer crop; nine observations were taken.
    expect(output).toContain(
      'the most images any one request carried:       2 (§10 allows maxActiveFullFrames=1',
    );
    expect(output).toContain('observations taken over the whole run:         9');
    // No request may ever have carried three. Read every row of the table.
    const rows = [...output.matchAll(/^ +\d+ +\d+ +(\d+) +\d+$/gm)];
    expect(rows.length).toBeGreaterThanOrEqual(18);
    for (const row of rows) {
      expect(Number(row[1])).toBeLessThanOrEqual(2);
    }

    // 4 — no stale screen. Every record says so, and none is unstamped.
    expect(output).toContain('not a description of the screen now');
    expect(output).toContain('the screen has since moved to');
    expect(output).toContain('records with no scene stamp at all:            0');
    expect(output).toMatch(/records that state the negation outright: {6}(\d+) of \1$/m);

    // 5 — compaction, in the ring the diagnostics surface reads.
    expect(output).toContain('context-tokens-before');
    expect(output).toContain('context-tokens-after');
    expect(output).not.toContain('NOTHING COMPACTED');
    expect(output).toMatch(/folds over the whole conversation: {13}[1-9]/);
    expect(output).toContain('any question or answer text in the ring:       false');
    // The text half of "bounded": every question still reachable, and the
    // context smaller than the transcript that produced it.
    expect(output).toContain('questions still reachable, of nine:            9');
    expect(output).toContain('turn 1’s subject still reachable:              true');

    // 6 — the lifecycle (follow-up 20). The lease, in the words the panel uses.
    expect(output).toContain('a second opener, while the first holds it:     REFUSED');
    expect(output).toContain('details.reason:                              writer-lease-held');
    expect(output).toContain('Pilot is already open in another window.');
    expect(output).toContain('and the store it returned:                   null — in memory');

    // …and the relaunch, read off the request the model received.
    expect(output).toMatch(/message entries read back {8}: [1-9]\d*/);
    expect(output).toContain('structural repairs needed        : 0');
    expect(output).toContain('raw pixels in the restored context: 0');
    expect(output).toContain('it still contains turn 1’s question: true');

    // The privacy proof, on the bytes: text yes, pixels no.
    expect(output).toContain('the user’s first question on disk                    YES');
    expect(output).toContain('any base64-shaped payload in any file                no');

    // 7 — clear conversation (follow-up 21), in memory and in the file.
    expect(output).toContain('transcript after   : 0 messages, 0 panel entries');
    expect(output).toContain('provider context   : 0 messages, 0 images');
    expect(output).toContain('on disk            : 0 messages, summary: none');
    expect(output).toContain('the user’s first question still on disk              no');
    expect(output).toContain('the model’s first answer still on disk               no');
    expect(output).toContain('any observation record still on disk                 no');

    // Nothing that belongs to another application may appear anywhere at all —
    // not in a prompt, not in a printed line (§9/§14).
    expect(output).not.toContain('Private release notes');
    expect(output).not.toContain('Another desktop entirely');
    expect(output).toContain('any base64-shaped run in any log line:         false');
  }, 300_000);
});
