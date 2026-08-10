import { describe, expect, it } from 'vitest';
import { runCodexDemo } from '../../src/codex/codex-demo.js';

/**
 * The walkthrough `pnpm demo:codex` prints, asserted rather than eyeballed.
 *
 * It drives the shipping composition — `createCodexRuntime`, `CodexGate`,
 * `createCodexModelSource`, `createCodexCredentialStore`,
 * `createCodexAgentSession`, `createAgentRuntime`, `PiAgentSession`, and in §5
 * the whole observation rig over the Node helper stub — against the recorded
 * Codex auth surface, so it is slow, and it is the only thing in the repository
 * that runs the MVP flow on a subscription profile.
 *
 * Six groups of assertion must never be deleted, because each is a claim PR-037
 * makes and each fails silently:
 *
 *  1. **Device code, never browser.** Port 1455 must never be bound, and the
 *     demo must show that a driver answering `browser` *would* bind it — a
 *     negative that proves nothing on its own.
 *  2. **The capability gate refuses with zero cost.** Zero screen observations
 *     and zero provider requests, printed as numbers.
 *  3. **An unusable credential refuses at `submit()`,** before any run starts.
 *  4. **Pi's refresh failure reaches the user as a sentence they can act on.**
 *  5. **The MVP flow runs on the Codex profile**, with `observe_screen` really
 *     called and an answer really spoken.
 *  6. **No credential reaches renderer state, a log, a transcript or a
 *     provider request**, and signing out removes the file.
 *
 * Deliberately *not* pinned: token counts that depend on how many requests the
 * demo happened to make, and timings. Runbook cross-lane issue 7 is what
 * happens when a suite treats a load-dependent number as a property.
 */

describe('pnpm demo:codex', () => {
  it('signs in without an API key and runs the point-ask-hear flow', async () => {
    const { lines } = await runCodexDemo();
    const output = lines.join('\n');

    /** `label` then whitespace then `value`, so column widths are not the test. */
    const shows = (label: string, value: string): void => {
      expect(output, `${label} → ${value}`).toMatch(
        new RegExp(`${escape(label)}\\s+${escape(value)}`),
      );
    };

    // The disclaimer, at the top and again at the end.
    expect(output).toContain('NO CHATGPT ACCOUNT, NO SIGN-IN, NO TOKEN, NO NETWORK, NO MACOS');
    expect(output).toContain('7. what none of the above proves');

    // 1 — device code, never browser.
    shows('login method chosen:', 'device_code');
    shows('port 1455 bound:', 'false');
    shows('a driver answering "browser" binds it:', 'true');
    shows('a manual_code prompt is:', 'refused');
    shows('verification URI:', 'https://auth.openai.com/codex/device');

    // …and the honesty rule from runbook follow-up 22.
    expect(output).toMatch(/before sign-in:.*NOT SIGNED IN/);
    expect(output).toMatch(/after sign-in:.*— signed in/);

    // 2 — the token lifecycle.
    shows('after expiring in 60s, state:', 'refresh-due');
    shows('refreshes Pi performed:', '1');
    shows('state after the request:', 'active');

    // 3 — the capability gate, and the two zeroes the Phase 4 gate turns on.
    shows('model:', 'gpt-5.3-codex-spark');
    shows('gate decision:', 'REFUSED');
    shows('the question was:', 'REFUSED AT SUBMIT');
    shows('screen observations taken:', '0');
    shows('provider requests made:', '0');
    expect(output).toMatch(/description:.*REFUSED BY THE CAPABILITY GATE/);

    // 4 — auth-expiry recovery, in all three shapes.
    shows('signed out — submit():', 'REFUSED');
    shows('refresh failed — outcome:', 'run-failed');
    shows('sentence shown to the user:', 'Pilot’s ChatGPT sign-in could not be renewed.');
    shows('hard-expired — submit():', 'REFUSED');
    shows('provider requests during it:', '2 → 2');
    shows('after signing in again:', 'Yes — still here.');
    shows('lastError:', '(none)');

    // 5 — the MVP flow, on the Codex profile.
    shows('profile in force:', 'openai-codex/gpt-5.5');
    // PR-036's context-window rule: a hosted endpoint's advertised window is
    // believed. This is the first profile in the repository that takes it.
    shows('context-window rule:', 'model (advertised 272000, remote)');
    shows(
      'states the panel showed:',
      'idle → observing → listening → transcribing → thinking → observing-screen → thinking → speaking → observing',
    );
    shows('observe_screen calls:', '1');
    // …and *why*, when it is not 1. A refusal is reported to the model, not to
    // the user (PR-021), so `observe_screen calls: 0` alone says nothing about
    // whether the tool was called and refused or never called at all. Runbook
    // follow-up 43 was a day of that ambiguity; the rule is printed now, and
    // asserted so it stays printed.
    shows('observations refused:', '(none)');
    // The frame `moment: "question"` chose must be at or before the anchor —
    // the ordering follow-up 43 turned out to be about. `false` here means the
    // walkthrough pushed its one frame on the wrong side of the question and
    // is passing only because the two landed in the same millisecond.
    shows('the frame it answered from:', 'origin=ring');
    expect(output).toContain('at or before the anchor: true');
    shows('pointer target the model was told:', 'AXButton');
    expect(output).toMatch(/answer on screen: +That is the Update payment method button\./);
    expect(output).toMatch(/utterances spoken: +[1-9]/);

    // 6 — the credential never leaks.
    for (const surface of [
      'renderer state (CodexGateState):',
      'renderer state (PilotViewState):',
      'application log (every record):',
      'session transcript summary:',
      'every provider request Pilot built:',
    ]) {
      expect(output).toMatch(new RegExp(`${escape(surface)} +clean`));
    }
    expect(output).not.toContain('LEAKED');
    shows('the credential file itself:', 'holds the token');
    shows('file mode:', '0600');
    shows('after sign out — the file is:', 'deleted');
    // The scan is only worth anything if it watched more than one string.
    const watched = /access\/refresh tokens watched for: +(\d+)/.exec(output);
    expect(Number(watched?.[1])).toBeGreaterThan(4);

    // …and the whole output is itself a surface: nothing printed may be a token.
    expect(output).not.toContain('fake-codex-access-token');
    expect(output).not.toContain('fake-codex-refresh-token');
  }, 120_000);
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
