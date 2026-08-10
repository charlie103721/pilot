import { describe, expect, it } from 'vitest';
import { runObserveDemo } from '../../src/observation/observe-demo.js';

/**
 * The walkthrough `pnpm demo:observe` prints, asserted rather than eyeballed.
 *
 * The demo spawns three helper stubs and drives the whole shell composition
 * through them, so it is slow by the standards of this suite and worth every
 * millisecond: it is the only thing in the repository that runs picker →
 * capture → ring → policy → diagnostics in one go.
 */

describe('pnpm demo:observe', () => {
  it('walks selection, capture, observation, pause, window loss and refusal', async () => {
    const { lines } = await runObserveDemo();
    const output = lines.join('\n');

    // It is the macOS adapters, not the fakes.
    expect(output).toContain('kind=macos-stub');
    expect(output).toContain('MacObservationAdapter');

    // Selection starts capture and the frames land in the ring.
    expect(output).toMatch(/after: {2}observing/);
    expect(output).toMatch(/ring: {4}frames=[1-9]/);
    expect(output).toContain('encoding=png');

    // An observation, and the three §17 numbers it produces.
    expect(output).toContain('images:   window image/png');
    expect(output).toContain('capture-to-observation=');
    expect(output).toContain('image-bytes=');
    expect(output).toContain('active-images=');
    expect(output).toContain('role=AXButton');

    // Pause clears immediately.
    expect(output).toContain('after pause:  frames=0 bytes=0 B pointer=0');
    expect(output).toContain('image cache wired into the guard: true');
    expect(output).toContain('refused: observation-paused');

    // Window loss stops, clears and prompts.
    expect(output).toContain('reason=selected-window-closed');
    expect(output).toContain('lastError:      window-closed');

    // Two permission refusals: the denied state, and a grant macOS credits
    // elsewhere (runbook follow-up 16).
    expect(output).toContain('permission-denied — Pilot cannot watch a window');
    expect(output).toContain('attribution=helper-attributed');
    expect(output).toContain('refused: permission-denied');

    // And the section that says what none of it proves.
    expect(output).toContain('what none of the above proves');
    expect(output).toContain('the Swift helper has never been compiled');
  }, 90_000);
});
