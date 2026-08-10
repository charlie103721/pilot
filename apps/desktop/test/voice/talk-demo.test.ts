import { describe, expect, it } from 'vitest';
import { runTalkDemo } from '../../src/voice/talk-demo.js';

/**
 * The walkthrough `pnpm demo:talk` prints, asserted rather than eyeballed.
 *
 * It spawns six helper stubs and drives the whole shell composition — the real
 * `MacHotkeyAdapter` and its coalescer, `main/voice-runtime.ts`, PR-025's
 * `SpeechInputBinding`, `MacSpeechInputAdapter` and the helper's recogniser
 * queue, the interaction transition table, the question anchor, Pi's agent loop
 * — so it is slow and worth it: it is the only thing in the repository that
 * runs *press, speak, release, ask* end to end.
 *
 * Two kinds of assertion must never be deleted. The **text fallback** must be
 * shown reachable in every failure mode below (§16, and the single most
 * important behaviour in PR-032). And the output must keep saying, in plain
 * words, that **no key has ever been pressed and no audio has ever been
 * recorded** — a walkthrough this convincing has to carry its own disclaimer.
 */

describe('pnpm demo:talk', () => {
  it('walks the press, the transcript, the anchor, and the four ways it fails', async () => {
    const { lines } = await runTalkDemo();
    const output = lines.join('\n');

    // The disclaimer, in the header and again at the end.
    expect(output).toContain('no key has ever been pressed and no audio has ever been');
    expect(output).toContain('NO KEY HAS EVER BEEN PRESSED.');
    expect(output).toContain('NO AUDIO HAS EVER BEEN RECORDED.');

    // 1 — the boundary that changed.
    expect(output).toContain('the one fake boundary PR-032 replaces');
    expect(output).toContain('platform:  kind=macos-stub');

    // 2 — a full press → speak → release → submit cycle, and the live
    //     transcript rendering as the partials arrive.
    expect(output).toContain('attribution established before anything could listen: matched');
    expect(output).toContain('hotkey-down →          state=listening');
    expect(output).toContain(
      '     | what\n     | what does this\n     | what does this auto renew',
    );
    expect(output).toContain(
      'the accepted transcript became the question: "What does this Auto Renew toggle do?"',
    );
    expect(output).toContain(
      'and Pilot answered:    "Auto Renew charges the card on file when the plan expires."',
    );
    expect(output).toContain('presses=1 releases=1 synthetic=0');

    // 3 — the utterance interval reaches the anchor, so the pointer path
    //     between the two instants is no longer degenerate.
    expect(output).toMatch(/utterance interval: {4}key-down → key-up.*\(\d+ ms of held key\)/);
    expect(output).toContain('pointer samples inside it: 2 (inside the window: 1)');
    expect(output).toContain('anchor:                insideWindow=true');
    expect(output).toContain('targetRole=AXButton');
    expect(output).toContain(
      '| pointer: 0.500, 0.500 (window-relative, inside the selected window)',
    );
    expect(output).toContain('| pointer target: AXButton — Update payment method');

    // 4 — the tap dies mid-press: a synthetic release still lets go.
    expect(output).toContain('releases=1 of which synthetic=1');
    expect(output).toContain('the recogniser let go of the microphone: true');
    expect(output).toContain('availability the panel is told: unavailable/listener-disabled');
    expect(output).toContain('text fallback reachable from observing: true');

    // 5 — the microphone is denied: `error`, and the text box really works.
    expect(output).toContain('state:                 error');
    expect(output).toContain('code:                  permission-denied');
    expect(output).toContain('Pilot needs Microphone access to listen');
    expect(output).toContain('text fallback reachable from error: true');
    expect(output).toContain('answer:   "Auto Renew charges the card on file');

    // 6 — the attribution gate (runbook follow-up 12).
    expect(output).toContain('verdict:               helper-attributed');
    expect(output).toContain('the tap was started:   false');
    expect(output).toContain('availability:          unavailable/permission-unattributed');
    expect(output).toContain('presses that became commands: 0');
    expect(output).toContain('the panel’s push-to-talk state: usable=false');
    expect(output).toContain('typed anyway: "Auto Renew charges the card on file');

    // 7 — the disclosure reaches the panel (runbook follow-up 13).
    expect(output).toContain('destination=on-device leavesDevice=false allowed=true');
    expect(output).toContain('destination=remote-service leavesDevice=true allowed=false');

    // Nothing that was said or heard may reach a place it does not belong: the
    // stub's *other* window belongs to another application (§9/§14).
    expect(output).not.toContain('Private release notes');
    expect(output).not.toContain('Another desktop entirely');
  }, 180_000);
});
