import {
  createLogger,
  createMemorySink,
  MVP_SCREEN_POLICY,
  type LogRecord,
  type LogSink,
} from '@pilot/shared';
import { listTree, REPO_ROOT } from '../voice/flow-demo.js';
import {
  checkA01,
  checkA02,
  checkA03,
  checkA04,
  checkA05,
  checkA06,
  checkA07,
  checkA08,
  checkA09,
  checkA10,
  checkA11,
  checkA12,
  checkA13,
  checkA14,
  checkA15,
  type CriterionContext,
  type InterruptionTiming,
} from './criteria.js';
import { GROUNDING_CASES, runGroundingCases, type GroundingCaseResult } from './grounding-cases.js';
import { measureImagePreprocessing, median, type LatencyReport } from './latency.js';
import {
  blockedRows,
  distribution,
  headline,
  passConditionTally,
  VERDICTS,
  type CriterionResult,
} from './verdict.js';

/**
 * PR-043 — the acceptance and grounding suite.
 *
 *     pnpm acceptance
 *
 * `docs/implementation.md`'s PR-043 asks for "A-01 through A-15, approximately
 * 30 grounding cases, standard/Retina coverage, and latency spot checks", and
 * for a demo of "recorded acceptance results with at least 90% grounding
 * accuracy on the curated checklist".
 *
 * **The 90% is not produced here and must not be inferred from anything below.**
 * Grounding accuracy is a property of a model's *answer* about a *real screen*,
 * and this machine has neither: every provider in this repository is a recorded
 * fake or Pi's faux provider, and there is no macOS (runbook §5 amendment 8). A
 * percentage computed against a scripted reply would be a measurement of the
 * script. What this suite produces instead is:
 *
 *  1. a **verdict per criterion** out of a closed set, derived from checks that
 *     actually ran rather than asserted — `verdict.ts`, whose central rule is
 *     that a criterion with no executed pass-condition check cannot report as
 *     passing;
 *  2. the **thirty grounding cases** as an executable checklist, measuring
 *     *Pilot's input to the model* — the anchor, the crop rectangle, the
 *     element, the envelope — which is real, is where every grounding defect
 *     this project has actually found has lived, and is exactly the half a Mac
 *     cannot make more true;
 *  3. **standard and Retina coverage**, the first time the assembled
 *     application has run at 1× at all;
 *  4. **latency spot checks** against system-design §17, with the halves that
 *     have never run named as such.
 *
 * The verdict distribution prints before anything else, because the honest
 * summary is that most of A-01…A-15 remains blocked and a reader who skims must
 * not come away with a different impression.
 */

export interface AcceptanceResult {
  readonly lines: readonly string[];
  readonly criteria: readonly CriterionResult[];
  readonly grounding: readonly GroundingCaseResult[];
  readonly latency: LatencyReport;
  /** Criteria whose executed checks did not hold. Drives the exit code. */
  readonly failed: number;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function wrap(text: string, width: number, indent: string): readonly string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = '';
  for (const word of words) {
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line = `${line} ${word}`;
    } else {
      out.push(indent + line);
      line = word;
    }
  }
  if (line !== '') {
    out.push(indent + line);
  }
  return out;
}

export async function runAcceptanceSuite(): Promise<AcceptanceResult> {
  const lines: string[] = [];
  const say = (line = ''): void => {
    lines.push(line);
  };

  const sink: LogSink & { readonly records: readonly LogRecord[] } = createMemorySink();
  const logger = createLogger({ scope: 'acceptance', level: 'debug', sink });
  const context: CriterionContext = { logger, sink };
  const filesBefore = listTree(REPO_ROOT);

  // -------------------------------------------------------------------------
  // Run everything first; print afterwards, so the distribution can lead.
  // -------------------------------------------------------------------------
  const startedAt = Date.now();
  const criteria: CriterionResult[] = [];
  criteria.push(await checkA01(context));
  criteria.push(await checkA02(context));
  criteria.push(await checkA03(context));
  criteria.push(await checkA04(context));
  criteria.push(await checkA05(context));
  criteria.push(await checkA06(context));
  criteria.push(await checkA07(context));
  const a08 = await checkA08(context);
  criteria.push(a08.result);
  criteria.push(await checkA09(context));
  criteria.push(await checkA10(context));
  criteria.push(await checkA11(context));
  criteria.push(await checkA12(context));
  const a13 = await checkA13(context);
  criteria.push(a13.result);

  const grounding = await runGroundingCases(GROUNDING_CASES);
  const preprocessing = await measureImagePreprocessing({ logger });

  // A-14 last of the executed rows: it scans every log record the whole suite
  // emitted, so it has to run after everything that emits one.
  const filesAfter = listTree(REPO_ROOT);
  const created = filesAfter.filter((path) => !filesBefore.includes(path));
  criteria.push(checkA14(context, a13.storeFiles, created));
  criteria.push(await checkA15());
  const elapsedMs = Date.now() - startedAt;

  const latency: LatencyReport = {
    measured: [
      preprocessing.sample,
      preprocessing.ageMs,
      ...(a08.timing === null ? [] : [interruptionSample(a08.timing)]),
    ],
    notMeasured: [
      {
        what: 'time to first model token (§17 metric)',
        why:
          'there is no model. Pi’s faux provider emits at a tokensPerSecond this suite ' +
          'chose, so any number would be a measurement of that constant. ' +
          'docs/handoff.md §1 step 17 (g) is the first real read.',
      },
      {
        what: 'time to first spoken sentence, as sound (§17 metric)',
        why:
          'nothing in this project has ever been spoken aloud. Pilot’s half — the first ' +
          'speech.output.speak crossing the pipe — is visible in `pnpm demo:flow` §1[6]; ' +
          'AVSpeechSynthesizer and the audio device have never run.',
      },
      {
        what: 'TTS interruption, end to end (§17 budget: 300 ms)',
        why:
          'only Pilot’s half is measured above. The rest is stopSpeaking and the audio ' +
          'device. docs/handoff.md §1 step 15 (b) times it by ear.',
      },
      {
        what: `background sampling (${String(MVP_SCREEN_POLICY.sampleFps)} FPS) and pointer sampling (${String(MVP_SCREEN_POLICY.pointerSampleHz)} Hz)`,
        why:
          'these are policy constants, not measurements. Every walkthrough in this ' +
          'repository drives both pollers by hand so that a run reads the same every ' +
          'time; no scheduler has ever been observed keeping to either rate.',
      },
    ],
  };

  // -------------------------------------------------------------------------
  // 0 — the headline
  // -------------------------------------------------------------------------
  say('PR-043 — acceptance and grounding suite');
  say('='.repeat(78));
  say();
  say('  ' + '!'.repeat(74));
  for (const line of wrap(headline(criteria), 72, '  ! ')) {
    say(line);
  }
  say('  ! ');
  for (const line of wrap(
    'THIS IS NOT A PASSING ACCEPTANCE RUN. There is no macOS, no language model, ' +
      'no microphone, no speaker and no screen on this machine (runbook §5 ' +
      'amendment 8). The plan’s “at least 90% grounding accuracy” is NOT computed ' +
      'here and cannot be: a grounding-accuracy number measured against a scripted ' +
      'provider measures the script. Section 3 says exactly what the thirty cases ' +
      'do measure; docs/handoff.md §1 step 23 is the procedure that fills in the rest.',
    72,
    '  ! ',
  )) {
    say(line);
  }
  say('  ' + '!'.repeat(74));
  say();
  say('  verdict distribution');
  const counts = distribution(criteria);
  for (const verdict of VERDICTS) {
    say(`    ${pad(verdict, 20)} ${String(counts[verdict]).padStart(2)}`);
  }
  say(`    ${pad('total', 20)} ${String(criteria.length).padStart(2)}`);
  say();
  for (const blocked of blockedRows(criteria)) {
    say(`    ${blocked.id} is blocked on ${blocked.blockers}`);
  }
  say();
  const tally = passConditionTally(criteria);
  for (const line of wrap(
    `Row counts understate it: a row reads "verified in part" whether one claim of five ` +
      `is pending or four are. Across the fifteen rows there are ${String(tally.total)} ` +
      `pass-condition checks — ${String(tally.executed)} executed here, ` +
      `${String(tally.pendingMac)} waiting on a Mac, ${String(tally.pendingModel)} on a ` +
      `real model, ${String(tally.pendingBoth)} on both.`,
    74,
    '  ',
  )) {
    say(line);
  }
  say();
  say(
    `  ${String(grounding.executed)} grounding cases executed, ` +
      `${String(grounding.inputSidePassed)} passed on the input side; ` +
      `${String(grounding.accuracyPending)} of them wait on a model for their verdict.`,
  );
  say(`  Ran in ${(elapsedMs / 1000).toFixed(1)} s.`);
  say();

  // -------------------------------------------------------------------------
  // 1 — the matrix
  // -------------------------------------------------------------------------
  say('1. the acceptance matrix (docs/mvp-01-point-ask-hear.md §18)');
  say('-'.repeat(78));
  say();
  say(`   ${pad('id', 6)}${pad('verdict', 18)}scenario`);
  for (const result of criteria) {
    say(`   ${pad(result.id, 6)}${pad(result.verdict, 18)}${result.scenario}`);
  }
  say();
  say('   Each row, with every check that decided it. `pass-condition` checks are');
  say('   §18’s own sentence; `supporting` checks are evidence a reader wants and');
  say('   can never lift a verdict on their own.');
  say();

  for (const result of criteria) {
    say(`   ${result.id}  ${result.verdict.toUpperCase()}  —  ${result.scenario}`);
    say(`         pass condition: ${result.passCondition}`);
    say(`         why this verdict: ${result.summary}`);
    for (const check of result.checks) {
      const mark =
        check.state === 'pending' ? `pending/${check.blocker}` : check.passed ? 'ok' : 'FAILED';
      say(`         [${pad(mark, 17)}] ${check.kind}: ${check.claim}`);
      for (const line of wrap(
        check.state === 'pending' ? check.reason : check.evidence,
        66,
        '             ',
      )) {
        say(line);
      }
    }
    say();
  }

  // -------------------------------------------------------------------------
  // 2 — what changed against PR-034's recorded verdict
  // -------------------------------------------------------------------------
  say('2. against PR-034’s recorded verdict (docs/handoff.md)');
  say('-'.repeat(78));
  say('   PR-034 read ONE trace and recorded: “In part: A-01, A-03, A-08, A-11,');
  say('   A-14. Not at all: A-02, A-04, A-05, A-06, A-07, A-09, A-10, A-12, A-13,');
  say('   A-15.” This suite runs a SCENARIO PER CRITERION — a pause, a revocation,');
  say('   a relaunch, a non-vision model, a twelve-turn conversation — so more rows');
  say('   carry executed evidence than one trace could. Nothing that PR-034 left');
  say('   blocked on a Mac or on a model is closed here; the pending checks above');
  say('   are the same blockers, now named per claim instead of per row.');
  say();
  const partial = new Set(['A-01', 'A-03', 'A-08', 'A-11', 'A-14']);
  for (const result of criteria) {
    const was = partial.has(result.id) ? 'in part' : 'not at all';
    say(
      `   ${pad(result.id, 6)}PR-034: ${pad(was, 12)}now: ${pad(result.verdict, 18)}` +
        `${
          result.verdict === 'failed'
            ? '← a defect, not a blocker'
            : result.verdict.startsWith('blocked')
              ? ''
              : `${String(
                  result.checks.filter(
                    (check) => check.state === 'executed' && check.kind === 'pass-condition',
                  ).length,
                )} pass-condition check(s) executed`
        }`,
    );
  }
  say();

  // -------------------------------------------------------------------------
  // 3 — the grounding checklist
  // -------------------------------------------------------------------------
  say('3. the curated grounding checklist');
  say('-'.repeat(78));
  say();
  for (const line of wrap(
    `${String(grounding.executed)} cases. Every one of them executes here and every one ` +
      `measures Pilot’s INPUT to the model: the anchor’s normalised point against the ` +
      `geometry module’s own arithmetic, whether the point is inside the window, the ` +
      `accessibility role and label retained or refused, the crop rectangle §10 step 5 ` +
      `computes, whether the thing under the pointer is INSIDE that crop, what the ` +
      `rendered envelope told the model, and — for the two foreign-window cases — that ` +
      `no label read off another application appears anywhere in the request.`,
    74,
    '   ',
  )) {
    say(line);
  }
  say();
  for (const line of wrap(
    `${String(grounding.accuracyPending)} of the ${String(grounding.executed)} are ` +
      `grounding-ACCURACY cases: their input side is decided here and their verdict — ` +
      `does the model answer about the thing you were pointing at — waits on a model ` +
      `looking at a real screen. That is ` +
      `${((grounding.accuracyPending / grounding.executed) * 100).toFixed(0)}% of the ` +
      `checklist pending, and it is the whole of the plan’s 90% metric. The remaining ` +
      `${String(grounding.contractDecided)} are TOOL-CONTRACT cases — image counts, the ` +
      `comparison-frame budget, the full-frame edge limit — which are fully decided here ` +
      `and are not part of the 90% at all.`,
    74,
    '   ',
  )) {
    say(line);
  }
  say();
  say(
    `   ${pad('case', 6)}${pad('scale', 7)}${pad('input side', 12)}${pad('metric', 20)}what the pointer is on`,
  );
  for (const result of grounding.results) {
    say(
      `   ${pad(result.id, 6)}${pad(`${String(result.scaleFactor)}×`, 7)}` +
        `${pad(result.inputSidePassed ? 'ok' : 'FAILED', 12)}` +
        `${pad(result.metric, 20)}${result.target}`,
    );
  }
  say();
  say('   Per case: what was expected, and what was read.');
  say();
  for (const result of grounding.results) {
    say(`   ${result.id}  ${result.title}`);
    for (const line of wrap(`expected: ${result.expectedGrounding}`, 68, '         ')) {
      say(line);
    }
    for (const assertion of result.assertions) {
      say(`         [${assertion.passed ? 'ok    ' : 'FAILED'}] ${assertion.claim}`);
      for (const line of wrap(assertion.evidence, 64, '                  ')) {
        say(line);
      }
    }
    say(`         envelope: ${result.observed.envelope.replace(/\n/g, ' | ')}`);
    say();
  }

  // -------------------------------------------------------------------------
  // 4 — standard and Retina
  // -------------------------------------------------------------------------
  say('4. standard (1×) and Retina (2×) coverage');
  say('-'.repeat(78));
  for (const line of wrap(
    'docs/mvp-01-point-ask-hear.md §19 asks for the acceptance tests to pass "on at ' +
      'least one standard-DPI and one Retina/display-scaled setup". Until this PR every ' +
      'walkthrough in the repository ran at 2× — DEMO_DISPLAYS is a single 2× display ' +
      'and ask-demo.ts hardcodes scaleFactor: 2 — so the 1× path through the geometry ' +
      'module had unit tests and had never been exercised by the assembled application. ' +
      'The ten pointer positions above run at both scales, which makes the invariant ' +
      'checkable: the same screen point must give the SAME normalised point and a ' +
      'DIFFERENT captured-pixel point, because §5 converts through captureSize rather ' +
      'than through scaleFactor.',
    74,
    '   ',
  )) {
    say(line);
  }
  say();
  const byKey = new Map<string, GroundingCaseResult[]>();
  for (const result of grounding.results) {
    if (result.metric !== 'grounding-accuracy' || result.observed.normalized === null) {
      continue;
    }
    const key = result.title.replace(/ at \d×$/, '');
    byKey.set(key, [...(byKey.get(key) ?? []), result]);
  }
  say(
    `   ${pad('position', 30)}${pad('normalised', 20)}${pad('px @1×', 16)}${pad('px @2×', 16)}same?`,
  );
  let sameNormalized = 0;
  let pairs = 0;
  for (const [key, results] of byKey) {
    const one = results.find((result) => result.scaleFactor === 1);
    const two = results.find((result) => result.scaleFactor === 2);
    if (one === undefined || two === undefined) {
      continue;
    }
    pairs += 1;
    const agrees =
      one.observed.normalized !== null &&
      two.observed.normalized !== null &&
      Math.abs(one.observed.normalized.x - two.observed.normalized.x) < 1e-9 &&
      Math.abs(one.observed.normalized.y - two.observed.normalized.y) < 1e-9;
    sameNormalized += agrees ? 1 : 0;
    say(
      `   ${pad(key.replace('pointer on ', ''), 30)}` +
        `${pad(
          `${(one.observed.normalized?.x ?? 0).toFixed(3)}, ${(one.observed.normalized?.y ?? 0).toFixed(3)}`,
          20,
        )}` +
        `${pad(
          `${Math.round(one.observed.capturedPixel?.x ?? 0).toString()},${Math.round(one.observed.capturedPixel?.y ?? 0).toString()}`,
          16,
        )}` +
        `${pad(
          `${Math.round(two.observed.capturedPixel?.x ?? 0).toString()},${Math.round(two.observed.capturedPixel?.y ?? 0).toString()}`,
          16,
        )}` +
        `${agrees ? 'yes' : 'NO'}`,
    );
  }
  say();
  say(
    `   ${String(sameNormalized)} of ${String(pairs)} paired positions produced an identical ` +
      `normalised point at both scales.`,
  );
  const oneScale = grounding.results.filter((result) => result.scaleFactor === 1);
  const twoScale = grounding.results.filter((result) => result.scaleFactor === 2);
  say(
    `   1×: ${String(oneScale.filter((result) => result.inputSidePassed).length)}/` +
      `${String(oneScale.length)} cases passed on the input side.  ` +
      `2×: ${String(twoScale.filter((result) => result.inputSidePassed).length)}/` +
      `${String(twoScale.length)}.`,
  );
  say();
  for (const line of wrap(
    'AND ONE THING THE PAIRING SHOWS THAT NOBODY HAD NOTICED. `capture.start` asks for ' +
      '1200×800 px at 1× and 1440×960 px at 2× — the 2× request is 2400×1600 reduced by ' +
      'fullFrameMaxEdge — while `pointerCropPixels` is a constant 640 CAPTURED pixels at ' +
      'both. So the crop the model receives covers 640 pt of the window on a standard ' +
      'display and about 533 pt of the same window on a Retina one: the same gesture ' +
      'gives the model a tighter view on a better screen. Nothing is wrong at either ' +
      'scale and no test fails; it is a policy question §10 never asked, and it is ' +
      'recorded as a runbook follow-up rather than changed here.',
    74,
    '   ',
  )) {
    say(line);
  }
  say();

  // -------------------------------------------------------------------------
  // 5 — latency
  // -------------------------------------------------------------------------
  say('5. latency spot checks (docs/system-design.md §17)');
  say('-'.repeat(78));
  say();
  for (const sample of latency.measured) {
    const values = sample.samplesMs.filter((value) => Number.isFinite(value));
    say(`   ${sample.what}`);
    say(
      `      ${sample.budgetMs === null ? '§17 metric, no budget' : `§17 budget: ${String(sample.budgetMs)} ms`}` +
        ` — median ${median(values).toFixed(1)} ms, ` +
        `min ${Math.min(...values).toFixed(1)}, max ${Math.max(...values).toFixed(1)} ` +
        `(n=${String(values.length)})`,
    );
    for (const line of wrap(sample.caveat, 66, '         ')) {
      say(line);
    }
    say();
  }
  say('   NOT MEASURED, and why:');
  for (const one of latency.notMeasured) {
    say(`      - ${one.what}`);
    for (const line of wrap(one.why, 64, '        ')) {
      say(line);
    }
  }
  say();

  // -------------------------------------------------------------------------
  // 6 — what none of this establishes
  // -------------------------------------------------------------------------
  say('6. what none of the above establishes (docs/handoff.md §1, §2, §3)');
  say('-'.repeat(78));
  for (const [head, ...rest] of [
    [
      'THE ACCEPTANCE GATE IS NOT MET. docs/mvp-01-point-ask-hear.md §19 requires all',
      'acceptance tests to pass on a standard-DPI and a Retina setup, in a packaged',
      'macOS build, with pointer grounding correct in at least 90% of the curated',
      'cases. The distribution at the top of this output is the whole answer to that.',
    ],
    [
      'NO GROUNDING-ACCURACY NUMBER EXISTS. Not 90%, not any other figure. The thirty',
      'cases pin what Pilot SENDS; whether a model answers about the thing you were',
      'pointing at has never been observed, on this machine or any other.',
    ],
    [
      'NO MAC. The Swift helper has never been compiled, no ScreenCaptureKit stream has',
      'produced a pixel, no CGEventTap has been created, no AVSpeechSynthesizer has',
      'spoken, no TCC prompt has appeared, and no .app has been built, signed,',
      'installed or launched.',
    ],
    [
      'NO MODEL. No request has ever left this machine. Every reply above is a string',
      'this suite scripted, and the two questions the product turns on — does a model',
      'look when it needs to, and does it answer about the thing you pointed at — are',
      'untouched by every one of the forty-five scenarios and cases here.',
    ],
    [
      'THE 1× AND 2× RESULTS ARE GEOMETRY, NOT DISPLAYS. Both scales came from a Node',
      'helper stub that was told what to say. What is verified is that Pilot converts',
      'correctly for each; that a real Retina Mac reports what the stub reported is',
      'docs/handoff.md §1 step 5.',
    ],
    [
      'THE TIMINGS ARE STUB TIMINGS ON AN IDLE LINUX BOX. A JSON round trip over a pipe',
      'is not a window server, a recogniser or a speaker.',
    ],
    [
      'A-09 FAILS, AND IT IS A REAL DEFECT RATHER THAN A MISSING MACHINE. Losing',
      'Accessibility stops Pilot instead of degrading it (runbook follow-up 35). It is',
      'reported as `failed` above precisely so it cannot be filed with the blockers.',
    ],
  ]) {
    say(`   - ${String(head)}`);
    for (const line of rest) {
      say(`     ${line}`);
    }
  }
  say();
  say('   The Mac-and-model half of this run is docs/handoff.md §1 step 23, written as');
  say('   a runnable procedure with one command per criterion.');

  return {
    lines,
    criteria,
    grounding: grounding.results,
    latency,
    failed: criteria.filter((result) => result.verdict === 'failed').length,
  };
}

function interruptionSample(timing: InterruptionTiming): LatencyReport['measured'][number] {
  return {
    what: 'interruption: command dispatched → speech.output.stop crossed the pipe',
    budgetMs: 300,
    samplesMs: [timing.dispatchToWireMs],
    caveat:
      `Pilot’s half only, and one sample. The adapter’s own round trip, measured inside ` +
      `main/speech-runtime.ts, was ${String(timing.adapterRoundTripMs)} ms. The rest of ` +
      `§17’s 300 ms is AVSpeechSynthesizer.stopSpeaking and the audio device, and NOTHING ` +
      `IN THIS PROJECT HAS EVER MADE A SOUND.`,
  };
}
