import { describe, expect, it } from 'vitest';
import { runLookDemo } from '../../src/observation/look-demo.js';

/**
 * The walkthrough `pnpm demo:look` prints, asserted rather than eyeballed.
 *
 * It spawns two helper stubs and drives the whole shell composition — window
 * picker, capture, ring, §10 policy, `observe_screen`, Pi's agent loop — twice
 * over, so it is slow and worth it: it is the only thing in the repository that
 * runs a *model-requested* observation end to end.
 *
 * The last assertion is the one that must never be deleted: no image payload
 * appears in the output. A demo that printed base64 would break §13 in the
 * friendliest possible way.
 */

describe('pnpm demo:look', () => {
  it('walks a model-requested look, "Look now", the indicator and a refusal', async () => {
    const { lines } = await runLookDemo();
    const output = lines.join('\n');

    // The boundary that changed, said out loud.
    expect(output).toContain("the tool's service is the app's service: true");
    expect(output).toContain('service class: PilotScreenContextService');

    // A model-requested observation, with a real image in the provider's inbox.
    expect(output).toContain('"status":"ok"');
    expect(output).toContain('"source":"selected-window-only"');
    expect(output).toMatch(/the provider received: 1 image\(s\) — image\/png, \d{3,} base64 chars/);
    expect(output).toContain('and then it answered: "The Auto Renew toggle');

    // With no window selected it is refused before anything is captured.
    expect(output).toContain('"failure":"no-window-selected"');
    expect(output).toContain('observations the facade ran: 0');

    // The observing state, while it is happening.
    expect(output).toContain('observation indicator while looking: looking=true');
    expect(output).toContain('capture indicator at the same moment: capturing=true');
    expect(output).toContain('the panel says:  Looking at the screen');
    expect(output).toContain('after it finished: looking=false');

    // "Look now".
    expect(output).toContain('request:  view=window moment=current');
    expect(output).toContain('observing state seen while it ran: true');
    expect(output).toContain('lastError after it: none');

    // One service, one budget.
    expect(output).toContain('rate-limited / policy-rejected');

    // Selected-window-only, against the real service.
    expect(output).toContain("a. lineage matches the service's own status(): accepted");
    expect(output).toMatch(/b\. retained frames: \d+, from any other window: 0/);
    expect(output).toContain('scene-changed');

    // A refusal, in words, on both paths.
    expect(output).toContain('attribution: helper-attributed');
    expect(output).toContain('"failure":"permission-denied"');
    expect(output).toContain(
      'the panel shows: "Pilot needs Screen Recording permission to look at your screen."',
    );
    expect(output).toContain('and: Looking again will not help until this is fixed.');
    expect(output).toContain('the text box is still live: true');

    // And the section that says what none of it proves.
    expect(output).toContain('what none of the above proves');
    expect(output).toContain('no model chose to call observe_screen');
    expect(output).toContain('no pixel is real');

    // Not one image payload anywhere in it.
    expect(output).not.toMatch(/[A-Za-z0-9+/]{200,}/);
  }, 120_000);
});
