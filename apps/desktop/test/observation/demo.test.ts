import { describe, expect, it } from 'vitest';
import { OBSERVATION_INDICATORS } from '../../src/observation/view-model.js';
import { runObservationDemo } from '../../src/observation/demo.js';

/**
 * The demo command is a deliverable, so it is tested like one. A demo that
 * silently stopped covering a state would be worse than no demo: the reviewer
 * would believe they had seen the indicator in all six.
 */

describe('observation demo', () => {
  it('reaches every indicator state, and says so at the end', async () => {
    const result = await runObservationDemo();
    const text = result.lines.join('\n');

    for (const indicator of OBSERVATION_INDICATORS) {
      expect(result.indicators).toContain(indicator);
      expect(text).toContain(`  indicator : ${indicator}`);
    }
    expect(text).not.toContain('NOT REACHED');
  });

  it('claims capture in exactly the blocks whose indicator is "observing"', async () => {
    const text = (await runObservationDemo()).lines.join('\n');
    const pairs = [...text.matchAll(/ {2}indicator : (\S+)\n {2}capturing : (\S+)/g)].map(
      (match) => [match[1], match[2]] as const,
    );

    expect(pairs.length).toBeGreaterThan(6);
    for (const [indicator, capturing] of pairs) {
      expect(capturing).toBe(indicator === 'observing' ? 'true' : 'false');
    }
  });

  it('walks the §16 sequence: watching, closed, prompted, answered', async () => {
    const text = (await runObservationDemo()).lines.join('\n');

    const watching = text.indexOf('── watching ');
    const closed = text.indexOf('── the selected window closes');
    const answered = text.indexOf('── the user answers the prompt');
    expect(watching).toBeGreaterThan(-1);
    expect(closed).toBeGreaterThan(watching);
    expect(answered).toBeGreaterThan(closed);

    const afterClose = text.slice(closed, answered);
    expect(afterClose).toContain('capturing : false');
    expect(afterClose).toContain('selected  : nothing');
    expect(afterClose).toContain('Choose another window to carry on');
  });

  it('shows blocked and degraded as different things', async () => {
    const text = (await runObservationDemo()).lines.join('\n');

    const blocked = text.slice(text.indexOf('── Screen Recording refused'));
    expect(blocked.slice(0, 400)).toContain('indicator : blocked');

    const degraded = text.slice(text.indexOf('── Accessibility refused'));
    expect(degraded.slice(0, 400)).toContain('indicator : observing');
    expect(degraded.slice(0, 400)).toContain('capturing : true');
    expect(degraded).toContain('grounding : reduced');
  });

  it('shows the window being retitled while it is being watched', async () => {
    const text = (await runObservationDemo()).lines.join('\n');
    const retitled = text.slice(text.indexOf('── the window is retitled'));

    expect(retitled.slice(0, 400)).toContain('Billing Settings — Invoice 4172');
    expect(retitled.slice(0, 400)).toContain('capturing : true');
  });
});
