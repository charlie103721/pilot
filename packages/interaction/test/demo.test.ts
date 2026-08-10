import { describe, expect, it } from 'vitest';
import { runInteractionDemo } from '../src/demo.js';

/**
 * The PR-006 demo is the documented verification procedure, so it is pinned
 * here: `pnpm demo:interaction` must keep producing exactly this run.
 */
describe('scripted fake flow', () => {
  it('walks idle → listening → thinking → speaking → interrupted → idle', async () => {
    const result = await runInteractionDemo();

    expect(result.path).toEqual([
      'idle',
      'observing',
      'listening',
      'transcribing',
      'thinking',
      'observing-screen',
      'thinking',
      'speaking',
      'listening',
      'transcribing',
      'thinking',
      'observing',
      'idle',
    ]);
  });

  it('discards every late result from the two superseded runs', async () => {
    const result = await runInteractionDemo();

    expect(result.rejections).toEqual([
      // The `stopped` callback for speech Pilot itself stopped no longer
      // reaches the machine at all: PR-026's output binding recognises its own
      // teardown and reports it as a diagnostic instead of a stale rejection.
      'run-text-delta in listening: stale-run',
      'speech-finished in listening: stale-speech',
      'run-aborted in observing: stale-run',
      'run-completed in observing: stale-run',
    ]);
    // Nothing from the interrupted answers was ever spoken.
    expect(result.spokenText).toBe('That is the Auto Renew toggle. It is currently off.');
  });

  it('is deterministic: two runs are identical', async () => {
    const [first, second] = await Promise.all([runInteractionDemo(), runInteractionDemo()]);
    expect(first.lines).toEqual(second.lines);
  });

  it('starts and stops capture around the selected window only', async () => {
    const result = await runInteractionDemo();
    expect(result.observationCalls).toEqual([
      'stop',
      'clear',
      'start',
      'stop',
      'clear',
      'stop',
      'clear',
    ]);
  });
});
