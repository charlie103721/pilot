import { describe, expect, it } from 'vitest';
import { runApiKeyDemo } from '../../src/model/apikey-demo.js';

/**
 * The walkthrough `pnpm demo:apikey` prints, asserted rather than eyeballed.
 *
 * It drives `openApiKeyProfileRuntime` — the function `main/index.ts` calls —
 * against a real encrypted file on disk, and then runs one screen question end
 * to end on `observation/observe-rig.ts` with the verified profile's
 * `ModelSource`. So it is slow, and it is the only place in the repository
 * where the whole API-key lane runs as one piece.
 *
 * Four claims must never be deleted, because each is something
 * `docs/implementation.md`'s PR-038 line promises and each would fail silently:
 *
 *  1. **The credential is not on the medium.** The sealed file, the profile
 *     file and every renderer-bound surface are swept for the key.
 *  2. **A refused model costs zero provider requests and zero image blocks.**
 *     Read off the recorded vendor's own counters, not off Pilot's intent.
 *  3. **Configured is not verified.** No state but `verified` hands out a
 *     `ModelSource`, including after a mid-conversation key revocation.
 *  4. **The banner says where the screen goes**, and says so before the
 *     conversation in section 6 happens.
 *
 * Timings and byte counts are deliberately not pinned (runbook cross-lane
 * issue 7). What is pinned is the shape and the zeroes.
 */

describe('pnpm demo:apikey', () => {
  it('walks storage, selection, the probe, recovery and labelling', async () => {
    const result = await runApiKeyDemo();
    const output = result.lines.join('\n');

    // The disclaimer, at the top and again at the end.
    expect(output).toContain('Not real: the vendor (a recorded 401-issuing fake)');
    expect(output).toContain('8. never executed');
    expect(output).toContain('No real API key. None exists here and none was requested.');
    expect(output).toContain('No macOS Keychain. safeStorage has never run');

    // 1 — selection reads Pi's live catalogue, and does not pretend to know
    //     about tools.
    expect(output).toContain('provider  recorded-vendor — "Recorded Vendor API key", 3 models');
    expect(output).toContain('ranked candidates: recorded-vision-pro → recorded-vision-lite');
    expect(output).toContain('Tool support is deliberately absent from this table');

    // 2 — the medium holds ciphertext, and the file is owner-only.
    expect(output).toContain('sealed file: credentials.json (mode 600)');
    expect(output).toContain('contains the key: false');
    expect(output).toContain('contains "sk-":   false');
    expect(output).toContain('profile file: profiles.json, contains the key: false');

    // 3 — the probe. The two zeroes are the Phase 4 gate.
    expect(output).toContain('vision: NO — Pi Model.input does not include "image"');
    expect(output).toContain('refused before any provider request; 0 requests, 0 image blocks');
    expect(output).toContain('provider requests made by the probe: 0');
    expect(output).toContain('the vendor heard from us at all:     0 requests');
    expect(result.requestsWhileRefused).toBe(0);
    // …and the tool stage costs exactly one request that carries no image.
    expect(output).toContain('provider requests made by the probe: 1 (text only)');
    expect(output).toContain('image blocks the vendor ever saw:    0');
    expect(result.imageBlocksBeforeGate).toBe(0);
    // …and tool support ends up measured rather than defaulted.
    expect(output).toContain('toolSupport: verified — MEASURED, not defaulted.');
    expect(output).toContain('gate: passed — vision true (verified), tools true (verified)');

    // A refused model never becomes a source. Three separate refusals, all null.
    expect(output).not.toContain('A SOURCE — BUG');
    expect(output).toContain('model source handed to the app:      none');

    // 4 — invalid key: detected, scrubbed, recovered, and distinguished from a
    //     rate limit.
    expect(output).toContain('state:      invalid-key (usable: false)');
    expect(output).toContain('Invalid API key\n         provided: [redacted:credential]');
    expect(output).toContain('the key appears in it: false');
    expect(output).toContain(
      'shown to the user: "This model provider rejected your API key. Enter a new key to continue."',
    );
    expect(output).toContain('(b) a new key is entered; one re-probe; the profile is usable again');
    expect(output).toContain('state verified, failure rate-limited, source still handed out');
    expect(output).toContain('the banner now says: unverified');

    // 5 — the banner, and the PR-039 contrast case from the same function.
    expect(output).toContain('headline:   Screen images are sent to api.recorded-vendor.example');
    expect(output).toContain('The request is made with your API key.');
    expect(output).toContain('flags:      sendsScreenOffDevice=true verification=verified');
    expect(output).toContain('headline:   Screen images stay on this Mac (localhost)');
    // PR-036's rule, on a hosted endpoint: believed, not capped.
    expect(output).toContain('contextWindow: 200000 (model; remote endpoint advertised 200000)');

    // 6 — the acceptance subset, on the verified profile.
    expect(output).toContain('capability gate: passed');
    expect(output).toContain(
      'states:   thinking → observing-screen → thinking → speaking → observing',
    );
    expect(output).toContain(
      'It called\n     observe_screen first and answered from the tool result.',
    );
    expect(output).toContain('image blocks the vendor received:   0 before this question, 1 after');
    expect(output).toContain('banner: "Screen images are sent to api.recorded-vendor.example"');

    // 7 — the sweep. Every line must read `clean`.
    expect(output).toContain('any surface contained the key: false');
    expect(output).not.toContain('LEAKED');
    expect(result.credentialContained).toBe(false);

    // …and the demo's own output, which is a transcript in its own right, must
    // not contain the key either.
    expect(output).not.toContain('sk-recorded-DEMO-KEY');
    expect(output).not.toContain('sk-recorded-A-KEY-THAT-WAS-REVOKED');
  }, 120_000);
});
