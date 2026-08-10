import { describe, expect, it } from 'vitest';
import { runLocalDemo } from '../../src/main/local-demo.js';
import { LOCAL_DIAGNOSIS_CODES } from '@pilot/agent';

/**
 * The walkthrough `pnpm demo:local` prints, asserted rather than eyeballed.
 *
 * The endpoint is `packages/agent/src/stub-openai-endpoint.ts`, a fixture
 * written for PR-039 — an HTTP server on 127.0.0.1 that answers in OpenAI
 * shapes with scripted replies. **It is not an inference server**, and the
 * demo's own header says so; this suite asserts that it keeps saying so.
 *
 * Four claims must never be deleted, because each is a line
 * `docs/implementation.md`'s PR-039 entry makes and each fails silently:
 *
 *  1. **Every unsupported-model failure mode is demonstrated**, with the
 *     sentence a user would actually see, not a code.
 *  2. **The capability gate refuses before screen data.** Asserted as a
 *     number, read off the endpoint's own request log, not off Pilot's
 *     control flow.
 *  3. **Locality is stated**, for the loopback case and for the two cases that
 *     look like it and are not — a LAN address and a hosted provider.
 *  4. **One app, no helper service.** The walkthrough runs the composition
 *     root's own `resolveLocalModelSource` → `createAgentRuntime` →
 *     `createInteractionRuntime`, and nothing else is started.
 */

describe('pnpm demo:local', () => {
  it('walks settings, health, the probe, every diagnostic, the gate and locality', async () => {
    const result = await runLocalDemo();
    const output = result.lines.join('\n');
    // Sentences are wrapped for the terminal, so assert them against a
    // whitespace-flattened copy rather than pinning the wrap points.
    const flat = output.replace(/\s+/gu, ' ');

    // The disclaimer, at the top, in the words that matter.
    expect(output).toContain('A STUB WRITTEN FOR THIS PR, NOT AN INFERENCE SERVER');
    expect(output).toContain('It is not a second');

    // 1 — settings.
    expect(output).toContain('base URL and model settings');
    expect(output).toContain('model "(auto)"');
    expect(flat).toContain('is missing the http:// prefix');
    expect(output).toContain('Pilot does NOT do: silently append /v1');

    // 2 — health, through the app's own resolver.
    expect(output).toContain('resolveLocalModelSource() — the same call main/index.ts makes');
    expect(output).toContain('reachable true');
    expect(output).toContain('blockedBy: nothing');

    // 3 — the probe, and the provenance split.
    expect(output).toContain('vision : true — Pi Model.input includes "image"');
    expect(output).toContain('tools  : true — verified');
    expect(output).toContain('named it correctly');
    expect(output).toContain('tool_calls entry for pilot_probe_ping');

    // 4 — every failure mode, each with its user-facing sentence.
    const expected = [
      'endpoint-unreachable',
      'endpoint-not-openai-compatible',
      'endpoint-path-missing-v1',
      'no-model-loaded',
      'model-not-served',
      'endpoint-unauthorized',
      'vision-rejected',
      'vision-claimed-but-blind',
      'tools-rejected',
      'tools-ignored',
      'context-window-below-reserve',
    ];
    expect([...result.diagnosed].sort()).toEqual([...expected].sort());
    for (const code of expected) {
      expect(output, `demo never printed [${code}]`).toContain(`[${code}]`);
    }
    // Every code the module can produce is either demonstrated or explicitly
    // out of scope for a walkthrough — so a new one cannot be added silently.
    const notShown = LOCAL_DIAGNOSIS_CODES.filter((code) => !expected.includes(code));
    expect([...notShown].sort()).toEqual(
      // `base-url-invalid` is section 1; `endpoint-not-local` is section 7;
      // `endpoint-timeout` and `probe-failed` need a hung socket, which a
      // walkthrough should not wait on.
      ['base-url-invalid', 'endpoint-not-local', 'endpoint-timeout', 'probe-failed'].sort(),
    );
    // The sentences themselves, not the codes.
    expect(flat).toContain('Nothing is listening at');
    expect(flat).toContain('it is not an OpenAI-compatible model server');
    expect(flat).toContain('it has no model loaded');
    expect(flat).toContain('accepted an image but could not tell Pilot what was in it');
    expect(flat).toContain('accepted Pilot’s screen tool but did not use it');

    // 5 — the gate refuses BEFORE screen data, stated as a number.
    expect(output).toContain('capability gate: REFUSED');
    expect(output).toContain('screen captures requested: 0');
    expect(output).toContain('streamed provider requests: 0');
    // 74 bytes is the probe's own 8x8 PNG swatch. Nothing else ever arrived.
    expect(result.refusedScreenBytes).toBeGreaterThan(0);
    expect(result.refusedScreenBytes).toBeLessThan(200);
    expect(flat).toContain('all of it the probe’s own swatch');

    // 6 — a real answer, over Pi's real openai-completions provider.
    expect(result.turns).toBe(2);
    expect(flat).toContain('automatic renewal for your plan');
    expect(output).toContain('screen captures requested by the model: 1');
    expect(output).toContain('#1 imageBytes=0');
    expect(result.answeredScreenBytes).toBeGreaterThan(0);

    // 7 — locality, and the two cases that look local and are not.
    expect(output).toContain('Local model on this Mac');
    expect(flat).toContain('Nothing about your screen is sent to a company');
    expect(flat).toContain('Remote model — screen images are sent to 192.168.1.40');
    expect(output).toContain('api.anthropic.com');

    // 8 — the context window, all three rows of PR-036's rule.
    expect(output).toContain('8192 tokens (model; local endpoint advertised 8192)');
    expect(output).toContain('32768 tokens (local-ceiling; local endpoint advertised 131072)');
    expect(output).toContain('32768 tokens (unknown; local endpoint advertised nothing)');
    expect(output).toContain('NO BETTER: it does not loosen it');
  }, 60_000);

  it('is deterministic: two runs print the same walkthrough apart from ports', async () => {
    const strip = (lines: readonly string[]): string =>
      lines
        .join('\n')
        .replace(/127\.0\.0\.1:\d+/gu, '127.0.0.1:PORT')
        .replace(/\d+ ms/gu, 'N ms');
    const first = await runLocalDemo();
    const second = await runLocalDemo();
    expect(strip(second.lines)).toBe(strip(first.lines));
  }, 60_000);
});
