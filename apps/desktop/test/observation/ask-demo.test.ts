import { describe, expect, it } from 'vitest';
import { runAskDemo } from '../../src/observation/ask-demo.js';

/**
 * The walkthrough `pnpm demo:ask` prints, asserted rather than eyeballed.
 *
 * It spawns five helper stubs and drives the whole shell composition — window
 * picker, pointer sampling, the question anchor, the envelope, Pi's agent loop,
 * `observe_screen`, the §10 policy and the image pipeline — so it is slow and
 * worth it: it is the only thing in the repository that runs *point, ask, and
 * answer* end to end.
 *
 * Two assertions must never be deleted. No image payload appears in the output
 * — a demo that printed base64 would break §13 in the friendliest possible way.
 * And no label belonging to another application appears anywhere, which is the
 * failure the outside-window and foreign-application rules exist to prevent.
 */

describe('pnpm demo:ask', () => {
  it('walks pointing, asking, the question-time frame, the crop and both leaks', async () => {
    const { lines } = await runAskDemo();
    const output = lines.join('\n');

    // 1 — the boundary that changed.
    expect(output).toContain('the one fake boundary PR-031 replaces');
    expect(output).toContain('one core behind both: true');

    // 2 — point at a button, type a question, get a grounded answer.
    expect(output).toContain('insideWindow=true targetRole=AXButton');
    expect(output).toContain('moment=question view=both pointerKnown=true');
    expect(output).toMatch(/images: {4}window \d+×\d+ png \d+ B, pointer 640×640 png \d+ B/);
    expect(output).toContain(
      '| pointer: 0.500, 0.500 (window-relative, inside the selected window)',
    );
    expect(output).toContain('| pointer target: AXButton — Update payment method');
    expect(output).toContain('"status":"ok"');
    expect(output).toContain('"source":"selected-window-only"');
    expect(output).toContain('and then it answered: "That is the Update payment method button');

    // 3 — the question-time frame, not the newest.
    expect(output).toContain('the ring holds a newer frame than the one answered from: true');

    // 4 — the crop follows the anchor.
    expect(output).toContain('over the button   pointer 0.500, 0.500  crop 640×640');
    expect(output).toContain('over the sidebar  pointer 0.100, 0.150  crop 640×640');

    // 5 — the scene revised between the question and the tool call.
    expect(output).toContain(
      'the observation reports requestedSceneStatus=stale-revision revisionsBehind=1',
    );

    // 6a — outside the window: nothing identified, and nothing asked at the wire.
    expect(output).toContain('anchor:   insideWindow=false targetRole=null');
    expect(output).toContain('elements retained at all: 0');
    expect(output).toContain(
      '| pointer: 1.167, 1.087 (window-relative) — outside the selected window; no element was identified',
    );
    expect(output).toContain('at the wire: accessibility.element-at sent 0 time(s)');
    expect(output).toContain('that element’s label anywhere in the model’s prompt: false');

    // 6b — a window stacked on top: the hit test is scoped, the element dropped.
    expect(output).toContain('at the wire: accessibility.sample ownerPid=501');
    expect(output).toContain('the other application’s label anywhere in the model’s prompt: false');

    // 6c — an unknown pointer, in words.
    expect(output).toContain('| pointer: unknown — no pointer position was recorded');
    expect(output).toContain('why not:                     no-pointer-sample');
    expect(output).toContain('"-1.000" anywhere in the model’s prompt: false');

    // 7 — and the section that says what none of it proves.
    expect(output).toContain('what none of the above proves');
    expect(output).toContain('no real pointer has ever been read');
    expect(output).toContain('no model chose to call observe_screen');

    // Neither leak, anywhere in the whole walkthrough.
    expect(output).not.toContain('Private release notes');
    expect(output).not.toContain('Another desktop entirely');
    // Not one image payload anywhere in it.
    expect(output).not.toMatch(/[A-Za-z0-9+/]{200,}/);
  }, 180_000);
});
