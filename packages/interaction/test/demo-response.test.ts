import { describe, expect, it } from 'vitest';
import { runResponseDemo, type ResponseDemoScene } from '../src/demo-response.js';

/**
 * The PR-026 demo is the documented verification procedure, so it is pinned
 * here: `pnpm demo:response` must keep producing exactly this run.
 */

function sceneNamed(scenes: readonly ResponseDemoScene[], name: string): ResponseDemoScene {
  const scene = scenes.find((candidate) => candidate.name === name);
  if (scene === undefined) {
    throw new Error(`no demo scene named "${name}"`);
  }
  return scene;
}

function spoken(scene: ResponseDemoScene): readonly string[] {
  return scene.chunks.map((chunk) => chunk.text);
}

describe('response and TTS buffer demo', () => {
  it('keeps abbreviations, decimals, identifiers and ellipses inside their sentence', async () => {
    const { scenes } = await runResponseDemo();
    const scene = sceneNamed(scenes, 'abbreviations, decimals and dotted identifiers');

    expect(spoken(scene)).toEqual([
      'Dr. Chen set the timeout to 1.5 seconds in config.json.',
      'That is fine, e.g. for a slow network.',
      'Wait... let me check the other file too.',
    ]);
    expect(scene.unspoken).toBe('');
    expect(scene.rejections).toEqual([]);
  });

  it('splits lists on newlines without splitting on their markers', async () => {
    const { scenes } = await runResponseDemo();
    const scene = sceneNamed(scenes, 'lists and newlines');

    expect(spoken(scene)).toEqual(['Two things:', '1. Open Billing.', '2. Turn off Auto Renew.']);
  });

  it('speaks the tail of a stream that ends mid-sentence', async () => {
    const { scenes } = await runResponseDemo();
    const scene = sceneNamed(scenes, 'a stream that never terminates');

    expect(spoken(scene)).toEqual(['It looks like the Auto Renew toggle but I cannot be certain']);
    expect(scene.unspoken).toBe('');
  });

  it('releases a fragment once the phrase timeout has elapsed', async () => {
    const { scenes } = await runResponseDemo();
    const scene = sceneNamed(scenes, 'the phrase timeout');

    expect(spoken(scene)).toEqual([
      'Checking the billing page and the payment method',
      '— both are fine.',
    ]);
  });

  it('starts speaking mid-run and keeps speaking across observe_screen', async () => {
    const { scenes } = await runResponseDemo();
    const scene = sceneNamed(scenes, 'speech starts mid-run');

    expect(scene.path).toEqual([
      'idle',
      'observing',
      'thinking',
      'speaking',
      'observing-screen',
      'thinking',
      'observing',
    ]);
    expect(spoken(scene)).toEqual(['Let me look at your screen.', 'The Auto Renew toggle is off.']);
  });

  it('never speaks anything belonging to a superseded run', async () => {
    const { scenes } = await runResponseDemo();
    const scene = sceneNamed(scenes, 'a superseded run is silenced');

    expect(spoken(scene)).toEqual(['That is the Auto Renew toggle.', 'That is the plan name.']);
    expect(scene.diagnostics).toContain('dropped chunk #1 (30 chars) of speech-000001: stopped');
    expect(scene.rejections).toEqual([
      'run-aborted in thinking: stale-run',
      'run-text-delta in thinking: stale-run',
      'run-completed in thinking: stale-run',
    ]);
  });

  it('ends the turn once, however often the synthesiser reports completion', async () => {
    const { scenes } = await runResponseDemo();
    const scene = sceneNamed(scenes, 'a synthesiser that repeats itself');

    expect(spoken(scene)).toEqual([
      'That is the Auto Renew toggle.',
      'It renews the plan each month.',
    ]);
    expect(scene.path.at(-1)).toBe('observing');
    expect(scene.diagnostics).toEqual([
      'discarded finished for speech-000001#1: stale-chunk',
      'discarded finished for speech-000001#0: stale-chunk',
    ]);
    expect(scene.rejections).toEqual([]);
  });

  it('is deterministic: two runs are identical', async () => {
    const [first, second] = await Promise.all([runResponseDemo(), runResponseDemo()]);
    expect(first.lines).toEqual(second.lines);
  });
});
