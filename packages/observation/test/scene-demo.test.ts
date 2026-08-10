import { describe, expect, it } from 'vitest';
import { runSceneTimelineDemo } from '../src/scene-demo.js';

/**
 * The PR-016 demo is the documented verification procedure, so its output is
 * pinned here: `pnpm --filter @pilot/observation demo:scene` must keep telling
 * exactly this story.
 */
describe('scene and pointer timeline demo', () => {
  it('is deterministic: two runs are identical', async () => {
    const [first, second] = await Promise.all([runSceneTimelineDemo(), runSceneTimelineDemo()]);
    expect(first.lines).toStrictEqual(second.lines);
  });

  it('walks the recorded session through its revision ladder', async () => {
    const result = await runSceneTimelineDemo();
    expect(result.ladder).toStrictEqual(['1:content', '2:content', '3:title', '4:geometry']);
  });

  it('shows the fingerprint ignoring noise, catching the sheet, missing the toggle', async () => {
    const { lines } = await runSceneTimelineDemo();
    const decisions = lines.filter((line) => /^\+\d+ ms\s+ratio=/.test(line));
    expect(decisions).toHaveLength(13);
    expect(decisions[5]).toContain('content-changed');
    expect(decisions[5]).toContain('NEW REVISION');
    // +3000 ms is the scripted toggle flip: the documented blind spot.
    expect(decisions[9]).toContain('below-threshold');
    expect(decisions.filter((line) => line.includes('NEW REVISION'))).toHaveLength(2);
  });

  it('grounds the question on the accessibility target under the pointer', async () => {
    const { lines } = await runSceneTimelineDemo();
    expect(lines).toContain('target            AXCheckBox "Auto Renew"');
    expect(lines.some((line) => line.startsWith('anchor sample     +3167 ms'))).toBe(true);
  });

  it('refuses every stale scene and records the lineage chain', async () => {
    const { lines, episodes } = await runSceneTimelineDemo();
    expect(
      lines.filter((line) => line.includes('selectFrame=scene-mismatch')).length,
    ).toBeGreaterThanOrEqual(2);
    expect(lines).toContain(
      'requireFrame      throws scene-mismatch: Pilot is looking at a different window now.',
    );
    expect(episodes).toHaveLength(3);
    expect(episodes.map((episode) => episode.end?.detail)).toStrictEqual([
      'window-lost',
      'window-changed',
      'screen-locked',
    ]);
    expect(episodes[0]?.previousSceneId).toBe(episodes[1]?.sceneId);
  });
});
