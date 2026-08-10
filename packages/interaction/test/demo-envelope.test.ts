import { describe, expect, it } from 'vitest';
import { runEnvelopeDemo } from '../src/demo-envelope.js';
import { RECORDED_UTTERANCES } from '../src/recordings.js';

/**
 * `pnpm demo:envelope` is PR-024's documented verification procedure, so the
 * run is pinned here: it must stay deterministic and it must keep covering the
 * awkward cases the plan calls out.
 */
describe('question envelope demo', () => {
  it('builds one envelope per recorded pointer timeline', () => {
    const result = runEnvelopeDemo();
    expect(result.cases.map((item) => item.name)).toEqual(
      RECORDED_UTTERANCES.map((recording) => recording.name),
    );
  });

  it('is deterministic: two runs print identical text', () => {
    expect(runEnvelopeDemo().lines).toEqual(runEnvelopeDemo().lines);
  });

  it('covers every grounding case', () => {
    const groundings = new Set(
      runEnvelopeDemo().cases.map((item) => item.envelope.anchor?.grounding),
    );
    expect([...groundings].sort()).toEqual([
      'no-selected-window',
      'pointer-in-window',
      'pointer-outside-window',
      'pointer-unknown',
    ]);
  });

  it('shows the awkward cases the plan asks for', () => {
    const byName = new Map(runEnvelopeDemo().cases.map((item) => [item.name, item.envelope]));

    expect(byName.get('pointer-outside-window')?.anchor?.grounding).toBe('pointer-outside-window');
    expect(byName.get('no-accessibility-target')?.anchor?.targetAvailability).toBe('none');
    expect(byName.get('scene-revised-mid-utterance')?.anchor?.sceneRevisedDuringUtterance).toBe(
      true,
    );
    expect(byName.get('stale-last-observed-revision')?.anchor?.observationStale).toBe(true);
  });

  it('prints no image payload and stays small', () => {
    const result = runEnvelopeDemo();
    expect(result.totalBytes).toBeLessThan(16 * 1024);
    for (const line of result.lines) {
      expect(line).not.toMatch(/data:image/u);
    }
  });
});
