import { describe, expect, it } from 'vitest';
import { runInterruptDemo, type InterruptDemoScene } from '../src/demo-interrupt.js';

/**
 * The PR-027 demo is the documented verification procedure, so it is pinned
 * here: `pnpm demo:interrupt` must keep producing exactly this run.
 */

function sceneNamed(scenes: readonly InterruptDemoScene[], name: string): InterruptDemoScene {
  const scene = scenes.find((candidate) => candidate.name === name);
  if (scene === undefined) {
    throw new Error(`no demo scene named "${name}"`);
  }
  return scene;
}

describe('interruption demo', () => {
  it('aborts a thinking run and speaks nothing it produced afterwards', async () => {
    const { scenes } = await runInterruptDemo();
    const scene = sceneNamed(scenes, 'interrupted while thinking');

    expect(scene.interrupts).toEqual(['abort']);
    expect(scene.spoken).toEqual(['That is the Auto Renew toggle.']);
    expect(scene.rejections).toEqual([
      'run-aborted in listening: stale-run',
      'run-text-delta in listening: stale-run',
      'run-completed in listening: stale-run',
    ]);
    // The panel keeps what was said before the interruption and gains nothing
    // after it.
    expect(scene.transcript).toEqual([
      'user: "what is this?"',
      'assistant: "That is the Auto Renew toggle. " (pending)',
      'user: "What is this?"',
    ]);
    expect(scene.lastError).toBe('(none)');
  });

  it('drops the sentence queued behind the one being spoken', async () => {
    const { scenes } = await runInterruptDemo();
    const scene = sceneNamed(scenes, 'interrupted while speaking');

    expect(scene.spoken).toEqual(['That is the Auto Renew toggle.', 'That is the plan name.']);
    expect(scene.discards).toContain('dropped chunk #1 (31 chars) of speech-000001: stopped');
  });

  it('aborts while a capture is in flight, which is what unwinds it (PR-035)', async () => {
    const { scenes } = await runInterruptDemo();
    const scene = sceneNamed(scenes, 'interrupted during a screen observation');

    // Was `steer` until PR-035 (runbook §8 follow-up 14): a steered run stays
    // alive, so the abandoned capture's image still reaches the model and the
    // replacement question meets `run-already-active`.
    expect(scene.interrupts).toEqual(['abort']);
    expect(scene.path).toEqual([
      'idle',
      'observing',
      'thinking',
      'speaking',
      'observing-screen',
      'observing',
    ]);
    // The abort's own terminal event now arrives too, and is discarded exactly
    // like the delta: the machine forgot the run id when it tore down.
    expect(scene.rejections).toEqual([
      'run-aborted in observing: stale-run',
      'run-text-delta in observing: stale-run',
    ]);
  });

  it('discards a completion that arrives after the abort', async () => {
    const { scenes } = await runInterruptDemo();
    const scene = sceneNamed(scenes, 'a run that completes after being aborted');

    expect(scene.spoken).toEqual(['That is the Auto Renew toggle.']);
    expect(scene.rejections).toEqual([
      'run-aborted in observing: stale-run',
      'run-completed in observing: stale-run',
    ]);
    expect(scene.transcript).toEqual([
      'user: "what is this?"',
      'assistant: "That is the Auto Renew toggle. " (pending)',
    ]);
  });

  it('answers only the last of three questions', async () => {
    const { scenes } = await runInterruptDemo();
    const scene = sceneNamed(scenes, 'two interruptions in quick succession');

    expect(scene.interrupts).toEqual(['abort', 'abort']);
    expect(scene.spoken).toEqual([
      'That is the Auto Renew toggle.',
      'That is the plan name.',
      'That is the renewal date.',
    ]);
    expect(scene.lastError).toBe('(none)');
  });

  it('speaks nothing when the interruption beats the first spoken word', async () => {
    const { scenes } = await runInterruptDemo();
    const scene = sceneNamed(scenes, 'interrupted between the answer and its first word');

    expect(scene.spoken).toEqual([]);
    expect(scene.discards).toEqual(['dropped chunk #0 (35 chars) of speech-000001: stopped']);
    expect(scene.path.at(-1)).toBe('observing');
  });

  it('never submits a question that was interrupted mid-submission', async () => {
    const { scenes } = await runInterruptDemo();
    const scene = sceneNamed(scenes, 'interrupted while the question was still being submitted');

    expect(scene.cancellations).toEqual(['question utt-000001: superseded']);
    expect(scene.spoken).toEqual(['That is the plan name.']);
    expect(scene.lastError).toBe('(none)');
  });

  it('speaks a stalled fragment when the scheduler fires, with no run event', async () => {
    const { scenes } = await runInterruptDemo();
    const scene = sceneNamed(scenes, 'a run that stalls mid-sentence');

    expect(scene.spoken).toEqual([
      'Checking the billing page',
      'and the payment method — both are fine.',
    ]);
    expect(scene.interrupts).toEqual([]);
    expect(scene.rejections).toEqual([]);
  });

  it('is deterministic: two runs are identical', async () => {
    const [first, second] = await Promise.all([runInterruptDemo(), runInterruptDemo()]);
    expect(first.lines).toEqual(second.lines);
  });
});
