import { describe, expect, it } from 'vitest';
import { runAcceptanceSuite } from '../../src/acceptance/acceptance-suite.js';
import { VERDICTS } from '../../src/acceptance/verdict.js';

/**
 * The suite `pnpm acceptance` prints, asserted rather than eyeballed.
 *
 * It runs the whole thing: fifteen scenarios, thirty grounding cases and the
 * latency spot checks, each on its own rig over the Node helper stub. That is
 * slow — about half a minute — and it is the only test in the repository that
 * drives the assembled application at **1×** as well as 2×.
 *
 * What must never be deleted, because each is a claim the PR makes and each
 * would fail silently:
 *
 *  1. **Every row of §18 is present, with a verdict from the closed set.** A
 *     criterion that stopped being run would otherwise just disappear.
 *  2. **The suite cannot report a green acceptance run.** The headline says so
 *     in words, the distribution is printed before anything else, and the
 *     plan's 90% is named as not computed.
 *  3. **A-09 is reported as `failed`, not as blocked.** It is a real defect
 *     (runbook follow-up 35) and filing it with the missing machines would hide
 *     it.
 *  4. **Every executed grounding case passes on the input side** — that half is
 *     Pilot's own and there is no excuse for it being red — and the count that
 *     waits on a model is printed as a fraction, not as a score.
 *  5. **Both display scales ran**, and the same screen point produced the same
 *     normalised point at each.
 *  6. **No image bytes anywhere.** The suite emits debug logs across forty-odd
 *     rigs and writes a real session database; A-14 scans both, and this test
 *     scans the suite's own output too.
 *
 * Timings are deliberately *not* pinned: runbook cross-lane issue 7 is what
 * happens when a suite treats a number that varies with load as a property.
 * What is pinned is that a measurement exists and that its caveat is printed.
 */

describe('pnpm acceptance', () => {
  it('walks A-01…A-15 and the thirty grounding cases without claiming the gate is met', async () => {
    const result = await runAcceptanceSuite();
    const output = result.lines.join('\n');
    // The prose is wrapped and some of it is inside a `!` banner, so sentences
    // are asserted against a flattened copy. Everything that is about *bytes*
    // rather than about words is asserted on `output` itself.
    const prose = output.replace(/^[\s!]*/gm, '').replace(/\s+/g, ' ');

    // --- 1. every row, with a verdict from the closed set -------------------
    expect(result.criteria).toHaveLength(15);
    for (let index = 1; index <= 15; index += 1) {
      const id = `A-${String(index).padStart(2, '0')}`;
      const row = result.criteria.find((one) => one.id === id);
      expect(row, `${id} is missing from the run`).toBeDefined();
      expect(VERDICTS).toContain(row?.verdict);
      // §18's own sentence, verbatim, not a paraphrase.
      expect(row?.passCondition.length ?? 0).toBeGreaterThan(10);
      // And a criterion with no evidence must not be reporting as passing.
      if (row?.verdict === 'verified' || row?.verdict === 'verified-in-part') {
        expect(
          row.checks.some((check) => check.state === 'executed' && check.kind === 'pass-condition'),
          `${id} claims ${row.verdict} with no executed pass-condition check`,
        ).toBe(true);
      }
      // Every check carries its evidence or its reason. No bare assertions.
      for (const check of row?.checks ?? []) {
        expect(
          check.state === 'executed' ? check.evidence : check.reason,
          `${id}: "${check.claim}" has nothing beside it`,
        ).not.toBe('');
      }
    }

    // --- 2. it cannot be mistaken for a passing run -------------------------
    expect(prose).toContain('THIS IS NOT A PASSING ACCEPTANCE RUN');
    expect(prose).toContain('“at least 90% grounding accuracy” is NOT computed here and cannot be');
    expect(output).toContain('verdict distribution');
    // The distribution leads: before the matrix, before the cases, before the
    // latency numbers.
    expect(output.indexOf('verdict distribution')).toBeLessThan(
      output.indexOf('1. the acceptance matrix'),
    );
    // Nothing may claim the definition of done.
    expect(prose).toContain('THE ACCEPTANCE GATE IS NOT MET');
    expect(prose).toContain('NO GROUNDING-ACCURACY NUMBER EXISTS. Not 90%, not any other figure');
    // No row is fully verified while a Mac and a model are missing; if one ever
    // is, this assertion is the place to argue about it.
    expect(result.criteria.filter((one) => one.verdict === 'verified')).toHaveLength(0);
    // …and none is silently unchecked.
    expect(result.criteria.filter((one) => one.verdict === 'not-implemented')).toHaveLength(0);

    // --- 3. A-09 is a defect, not a blocker --------------------------------
    const a09 = result.criteria.find((one) => one.id === 'A-09');
    expect(a09?.verdict).toBe('failed');
    expect(
      a09?.checks.find((check) => check.state === 'executed' && !check.passed)?.claim,
    ).toContain('visual mode remains usable');
    expect(result.failed).toBe(1);

    // --- 4. the grounding checklist ----------------------------------------
    expect(result.grounding).toHaveLength(30);
    for (const one of result.grounding) {
      expect(one.assertions.length, `${one.id} asserted nothing`).toBeGreaterThan(0);
      expect(one.inputSidePassed, `${one.id} failed on the input side`).toBe(true);
    }
    expect(result.grounding.filter((one) => one.metric === 'grounding-accuracy')).toHaveLength(23);
    expect(prose).toContain('of them wait on a model for their verdict');

    // --- 5. both scales --------------------------------------------------
    const atOne = result.grounding.filter((one) => one.scaleFactor === 1);
    const atTwo = result.grounding.filter((one) => one.scaleFactor === 2);
    expect(atOne).toHaveLength(10);
    expect(atTwo).toHaveLength(20);
    expect(prose).toContain('10 of 10 paired positions produced an identical normalised point');
    // The same point, converted through captureSize: same fraction, different
    // pixels. This is the whole of the standard/Retina claim.
    const buttonAtOne = atOne.find((one) => one.title.startsWith('pointer on button'));
    const buttonAtTwo = atTwo.find((one) => one.title.startsWith('pointer on button'));
    expect(buttonAtOne?.observed.normalized).toEqual(buttonAtTwo?.observed.normalized);
    expect(buttonAtOne?.observed.capturedPixel).not.toEqual(buttonAtTwo?.observed.capturedPixel);
    expect(buttonAtOne?.observed.captureSize).toEqual({ width: 1200, height: 800 });
    expect(buttonAtTwo?.observed.captureSize).toEqual({ width: 1440, height: 960 });

    // --- 6. the latency spot checks, with their caveats --------------------
    const preprocessing = result.latency.measured.find((one) =>
      one.what.startsWith('image preprocessing'),
    );
    expect(preprocessing?.budgetMs).toBe(150);
    expect(preprocessing?.samplesMs.length ?? 0).toBeGreaterThan(0);
    expect(preprocessing?.caveat).toContain('idle Linux box');
    // The budget halves that have never run are named as not measured.
    const notMeasured = result.latency.notMeasured.map((one) => one.what).join('\n');
    expect(notMeasured).toContain('time to first model token');
    expect(notMeasured).toContain('time to first spoken sentence');
    expect(notMeasured).toContain('TTS interruption, end to end');
    expect(prose).toContain('NOTHING IN THIS PROJECT HAS EVER MADE A SOUND');

    // --- 7. no image bytes anywhere in the output --------------------------
    expect(/[A-Za-z0-9+/]{120,}={0,2}/.test(output)).toBe(false);
    expect(output).not.toContain('data:image');
    // G-28's secure-field value is *not* checked for here: the suite prints the
    // needle it searched the provider requests for, which is the point of that
    // case, and the value is a fixture string this repository authored rather
    // than a secret. What matters is that it never reached the provider, and
    // G-28 asserts exactly that against `model.requests`.
    const g28 = result.grounding.find((one) => one.id === 'G-28');
    expect(
      g28?.assertions.find((assertion) => assertion.claim.includes('appears nowhere'))?.passed,
    ).toBe(true);
  }, 600_000);
});
