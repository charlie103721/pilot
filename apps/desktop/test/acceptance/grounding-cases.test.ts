import { describe, expect, it } from 'vitest';
import { MVP_SCREEN_POLICY } from '@pilot/shared';
import {
  GROUNDING_CASES,
  GROUNDING_POSITIONS,
  runGroundingCase,
} from '../../src/acceptance/grounding-cases.js';
import { ACCEPTANCE_AX_ELEMENTS, WINDOW_BOUNDS } from '../../src/acceptance/rig-support.js';

/**
 * The curated checklist, as a table.
 *
 * `docs/implementation.md` asks PR-043 for "approximately 30 grounding cases"
 * and `docs/mvp-01-point-ask-hear.md` §19 for "at least 90% of the curated
 * static-UI cases". The number and the *shape* of the checklist are therefore
 * the deliverable, and a later edit that quietly dropped the hard positions —
 * the corners, the exact border, the foreign window, the point outside the
 * frame — would leave the count intact and the coverage gone. These tests pin
 * both.
 *
 * They also pin the classification, because it is the one number in the whole
 * suite a reader could mistake for a score: how many cases are decided here and
 * how many are waiting on a model.
 */

describe('the grounding checklist', () => {
  it('is thirty cases', () => {
    expect(GROUNDING_CASES).toHaveLength(30);
  });

  it('gives every case a unique id in order', () => {
    const ids = GROUNDING_CASES.map((one) => one.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('G-01');
    expect(ids.at(-1)).toBe('G-30');
  });

  it('runs the same ten positions at 1× and at 2×, which is §19’s display requirement', () => {
    expect(GROUNDING_POSITIONS).toHaveLength(10);
    for (const scale of [1, 2] as const) {
      const positional = GROUNDING_CASES.filter(
        (one) => one.position !== undefined && one.scaleFactor === scale,
      );
      expect(positional).toHaveLength(GROUNDING_POSITIONS.length);
      expect(positional.map((one) => one.position?.key)).toEqual(
        GROUNDING_POSITIONS.map((position) => position.key),
      );
    }
  });

  it('keeps the positions that are hard rather than only the easy ones', () => {
    const keys = new Set(GROUNDING_POSITIONS.map((position) => position.key));
    for (const required of [
      'button',
      'sidebar',
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
      'left-border',
      'stacked-window',
      'outside-window',
    ]) {
      expect(keys).toContain(required);
    }
  });

  it('expects nothing to be identified outside the window or on a foreign application', () => {
    for (const key of ['stacked-window', 'outside-window']) {
      const position = GROUNDING_POSITIONS.find((one) => one.key === key);
      expect(position?.expect.targetRole).toBeNull();
      expect(position?.expect.targetLabel).toBeNull();
      // …and the label that really is there must be named, so the run can look
      // for it in the prompt rather than merely not finding it by accident.
      expect(position?.forbiddenInPrompt?.length ?? 0).toBeGreaterThan(0);
    }
    expect(
      GROUNDING_POSITIONS.find((one) => one.key === 'outside-window')?.expect.insideWindow,
    ).toBe(false);
    // The exact border is inside, per §8's inclusive bound.
    expect(GROUNDING_POSITIONS.find((one) => one.key === 'left-border')?.expect.insideWindow).toBe(
      true,
    );
  });

  it('classifies every case, and says how much of the checklist waits on a model', () => {
    const accuracy = GROUNDING_CASES.filter((one) => one.metric === 'grounding-accuracy');
    const contract = GROUNDING_CASES.filter((one) => one.metric === 'tool-contract');
    expect(accuracy.length + contract.length).toBe(GROUNDING_CASES.length);
    // The 90% metric is about answers, so every positional case is pending.
    expect(accuracy).toHaveLength(23);
    expect(contract).toHaveLength(7);
  });

  it('places the elements it points at where the checklist says they are', () => {
    // A case that pointed at empty canvas while claiming an AXButton would pass
    // its "no element" assertion for the wrong reason. The fixture is checked
    // against the positions rather than trusted.
    const button = GROUNDING_POSITIONS.find((one) => one.key === 'button');
    const element = ACCEPTANCE_AX_ELEMENTS.find((one) => one.label === 'Update payment method');
    expect(button).toBeDefined();
    expect(element).toBeDefined();
    expect(button?.point.x).toBeGreaterThanOrEqual(element?.bounds.x ?? 0);
    expect(button?.point.x).toBeLessThan((element?.bounds.x ?? 0) + (element?.bounds.width ?? 0));
    expect(button?.point.y).toBeGreaterThanOrEqual(element?.bounds.y ?? 0);
    expect(button?.point.y).toBeLessThan((element?.bounds.y ?? 0) + (element?.bounds.height ?? 0));
    // The corners are inside the window and on nothing.
    for (const key of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      const position = GROUNDING_POSITIONS.find((one) => one.key === key);
      expect(position?.expect.targetRole).toBeNull();
      expect(position?.point.x).toBeGreaterThanOrEqual(WINDOW_BOUNDS.x);
      expect(position?.point.x).toBeLessThan(WINDOW_BOUNDS.x + WINDOW_BOUNDS.width);
    }
  });
});

describe('running one case', () => {
  it('reads the anchor, the crop and the envelope off the shipping objects', async () => {
    const one = GROUNDING_CASES.find((candidate) => candidate.id === 'G-11');
    expect(one).toBeDefined();
    const result = await runGroundingCase(one!);

    expect(result.inputSidePassed).toBe(true);
    // Not "some assertions ran": the specific ones that make the case a
    // grounding case.
    const claims = result.assertions.map((assertion) => assertion.claim).join('\n');
    expect(claims).toContain('normalised point');
    expect(claims).toContain('captured-pixel point');
    expect(claims).toContain('inside the crop the model receives');
    expect(result.observed.normalized).toEqual({ x: 0.5, y: 0.5 });
    expect(result.observed.targetRole).toBe('AXButton');
    expect(result.observed.envelope).toContain('AXButton — Update payment method');
    expect(result.observed.cropRect?.width).toBe(MVP_SCREEN_POLICY.pointerCropPixels);
  }, 60_000);

  it('fails the case rather than the run when an expectation does not hold', async () => {
    // The suite must be able to report a red case. Rewire G-11's expectation to
    // something false and check the result says so instead of throwing.
    const one = GROUNDING_CASES.find((candidate) => candidate.id === 'G-11');
    const wrong = {
      ...one!,
      position: {
        ...one!.position!,
        expect: { ...one!.position!.expect, targetRole: 'AXCheckBox' },
      },
    };
    const result = await runGroundingCase(wrong);
    expect(result.inputSidePassed).toBe(false);
    expect(
      result.assertions.filter((assertion) => !assertion.passed).map((one2) => one2.claim),
    ).toContain('the accessibility element is AXCheckBox');
  }, 60_000);
});
