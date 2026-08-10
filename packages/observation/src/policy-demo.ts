import {
  asFrameId,
  PilotError,
  type CapturedFrame,
  type ObserveScreenRequest,
  type PilotErrorCode,
} from '@pilot/shared';
import {
  FIXTURE_ACCESSIBILITY_NODE,
  FIXTURE_GEOMETRY_SECONDARY,
  FIXTURE_SECURE_NODE,
  FIXTURE_WINDOW_SECONDARY,
} from '@pilot/platform/fakes';
import {
  createPolicyHarness,
  createSceneLineageFixture,
  primePolicyHarness,
  type PolicyHarness,
  type PolicyStateOverrides,
} from './fixtures.js';
import { FakeImageProcessor } from './image-pipeline.js';
import {
  POLICY_RULES,
  POLICY_RULE_TABLE,
  type ObservationPolicyRequest,
  type PolicyDecision,
  type PolicyRule,
  type PolicyStep,
} from './policy-enforcer.js';
import {
  DEFAULT_SCREEN_CONTEXT_POLICY,
  defineScreenPolicy,
  SCREEN_REDACTION_CAVEAT,
  type ScreenContextPolicy,
} from './screen-policy.js';

/**
 * PR-017 demo: "run allowed and rejected observation scenarios against
 * fixtures".
 *
 *     pnpm build && pnpm --filter @pilot/observation demo:policy
 *
 * Every scenario prints the rule that allowed or rejected it, the §10 step the
 * rule belongs to, and the typed error code the caller receives. The whole run
 * is driven by the PR-001 platform fakes on a fake clock, so the output is
 * byte-identical on every machine and every run.
 */

const FIXTURE = createSceneLineageFixture();

export interface PolicyDemoScenario {
  readonly label: string;
  readonly outcome: 'allowed' | 'rejected';
  /** The rule that rejected it, or `null` when it was allowed. */
  readonly rule: PolicyRule | null;
  readonly step: PolicyStep;
  readonly code: PilotErrorCode | null;
  readonly note: string;
}

export interface PolicyDemoResult {
  readonly lines: readonly string[];
  readonly scenarios: readonly PolicyDemoScenario[];
}

interface ScenarioSpec {
  readonly label: string;
  readonly request: ObserveScreenRequest;
  readonly policy?: ScreenContextPolicy;
  readonly state?: PolicyStateOverrides;
  readonly extra?: Partial<ObservationPolicyRequest>;
  readonly images?: FakeImageProcessor;
  /** Runs before the observation, e.g. to switch windows or advance the clock. */
  readonly prepare?: (harness: PolicyHarness) => Promise<void> | void;
  readonly captureFresh?: (harness: PolicyHarness) => Promise<CapturedFrame>;
  /** Request fields that can only be computed after {@link ScenarioSpec.prepare}. */
  readonly overrides?: (harness: PolicyHarness) => Partial<ObservationPolicyRequest>;
  /** One line of explanation printed under the scenario. */
  readonly why: string;
}

async function primed(spec: ScenarioSpec): Promise<PolicyHarness> {
  const harness = createPolicyHarness({
    fixture: FIXTURE,
    ...(spec.policy === undefined ? {} : { policy: spec.policy }),
    ...(spec.images === undefined ? {} : { images: spec.images }),
  });
  await primePolicyHarness(harness, FIXTURE);
  await spec.prepare?.(harness);
  return harness;
}

async function runScenario(
  spec: ScenarioSpec,
): Promise<{ scenario: PolicyDemoScenario; decision: PolicyDecision; harness: PolicyHarness }> {
  const harness = await primed(spec);
  const captureFresh = spec.captureFresh;
  const decision = await harness.enforcer.evaluate({
    request: spec.request,
    at: harness.clock.now(),
    questionAt: FIXTURE.questionAt,
    state: harness.state(spec.state),
    source: harness.source(
      captureFresh === undefined ? undefined : async () => captureFresh(harness),
    ),
    ...(spec.extra ?? {}),
    ...(spec.overrides?.(harness) ?? {}),
  });

  if (decision.allowed) {
    const sizes = decision.images
      .map(
        (image) =>
          `${image.purpose} ${String(image.size.width)}×${String(image.size.height)} ${String(image.byteLength)} B`,
      )
      .join(', ');
    return {
      harness,
      decision,
      scenario: {
        label: spec.label,
        outcome: 'allowed',
        rule: null,
        step: 'return',
        code: null,
        note: `${String(decision.images.length)} image(s): ${sizes}; ${String(
          decision.redaction.maskedRegions,
        )} region(s) masked`,
      },
    };
  }
  return {
    harness,
    decision,
    scenario: {
      label: spec.label,
      outcome: 'rejected',
      rule: decision.rule,
      step: decision.step,
      code: decision.error.code,
      note: decision.detail,
    },
  };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

const QUESTION_WINDOW: ObserveScreenRequest = { view: 'window', moment: 'question' };

const ALLOWED: readonly ScenarioSpec[] = [
  {
    label: 'question / window',
    request: QUESTION_WINDOW,
    why: 'the frame closest to the utterance, resized to the 1440 px policy edge',
  },
  {
    label: 'question / both',
    request: { view: 'both', moment: 'question' },
    why: 'one full frame plus one 640 px pointer crop — the ordinary active context',
  },
  {
    label: 'current / pointer',
    request: { view: 'pointer', moment: 'current' },
    captureFresh: async (harness) => ({
      ...(FIXTURE.frames[0] as CapturedFrame),
      frameId: asFrameId('fresh-0001'),
      capturedAt: harness.clock.now(),
    }),
    why: 'a fresh capture of the selected window at tool-execution time',
  },
  {
    label: 'before-and-after / window',
    request: { view: 'window', moment: 'before-and-after' },
    why: 'two comparison frames — the only case §10 allows two full frames',
  },
  {
    label: 'question / both, password field in view',
    request: { view: 'both', moment: 'question' },
    extra: { pointerTarget: FIXTURE_SECURE_NODE },
    why: 'the secure field is masked and its value withheld; the caveat still applies',
  },
  {
    label: 'question / window, ordinary target',
    request: QUESTION_WINDOW,
    extra: { pointerTarget: FIXTURE_ACCESSIBILITY_NODE },
    why: 'nothing to mask, so nothing is claimed to have been masked',
  },
];

const REJECTED: readonly ScenarioSpec[] = [
  {
    label: 'observation disabled',
    request: QUESTION_WINDOW,
    state: { enabled: false },
    why: 'the user has not started observation',
  },
  {
    label: 'paused',
    request: QUESTION_WINDOW,
    state: { paused: true },
    why: 'a pause clears the buffers; there is nothing to answer from',
  },
  {
    label: 'screen locked',
    request: QUESTION_WINDOW,
    state: { screenLocked: true },
    why: 'a lock clears the buffers and never resumes silently',
  },
  {
    label: 'Screen Recording denied',
    request: QUESTION_WINDOW,
    state: { screenRecording: 'denied' },
    why: 'permission is checked before anything is selected',
  },
  {
    label: 'no window selected',
    request: QUESTION_WINDOW,
    state: { selectedWindow: null },
    why: 'nothing to look at',
  },
  {
    label: 'capture source is a display',
    request: QUESTION_WINDOW,
    state: { captureSource: 'display' },
    why: 'PRIVACY: §9/§14 forbid widening to a display — this is refused, never downgraded',
  },
  {
    label: 'capture source unknown',
    request: QUESTION_WINDOW,
    state: { captureSource: 'unknown' },
    why: 'PRIVACY: selected-window capture must be proven, not assumed',
  },
  {
    label: 'fresh capture returns another window',
    request: { view: 'window', moment: 'current' },
    captureFresh: async (harness) => ({
      ...(FIXTURE.frames[0] as CapturedFrame),
      frameId: asFrameId('foreign-0001'),
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      capturedAt: harness.clock.now(),
    }),
    why: 'PRIVACY: the frame is refused before it reaches the image pipeline',
  },
  {
    label: 'moment has left the local buffer',
    request: QUESTION_WINDOW,
    prepare: (harness) => {
      harness.clock.advance(10_000);
    },
    why: 'the three-second ring has aged the frame out',
  },
  {
    label: 'fresh capture not wired',
    request: { view: 'window', moment: 'current' },
    why: 'moment "current" needs a capture source; the failure is explicit',
  },
  {
    label: 'comparison window holds one frame',
    request: { view: 'window', moment: 'before-and-after' },
    extra: { comparisonWindow: { from: FIXTURE.questionAt - 300, to: FIXTURE.questionAt } },
    why: 'there is nothing to compare, so the tool says so',
  },
  {
    label: 'scene from a previous selection',
    request: QUESTION_WINDOW,
    prepare: async (harness) => {
      harness.clock.advance(50);
      await harness.session.start({
        window: FIXTURE_WINDOW_SECONDARY,
        geometry: FIXTURE_GEOMETRY_SECONDARY,
      });
      harness.session.ingestFrame({
        ...(FIXTURE.frames[0] as CapturedFrame),
        frameId: asFrameId('secondary-0001'),
        windowId: FIXTURE_WINDOW_SECONDARY.windowId,
        capturedAt: harness.clock.now(),
      });
      await harness.session.samplePointer(harness.clock.now());
    },
    overrides: (harness) => {
      // The lineage chain is newest first, so the previous episode is the
      // scene a caller could still be holding a reference to.
      const previous = harness.core.lineage.chain()[1];
      return {
        questionAt: harness.clock.now(),
        ...(previous === undefined ? {} : { requestedScene: { sceneId: previous } }),
      };
    },
    why: 'the window changed; a held scene reference is superseded, not silently answered',
  },
  {
    label: 'password field with no bounds to mask',
    request: QUESTION_WINDOW,
    extra: {
      pointerTarget: { role: 'AXTextField', label: 'Password', value: '…', isSecure: true },
    },
    why: 'HONESTY: Pilot will not claim redaction it cannot perform',
  },
  {
    label: 'policy set to reject secure content',
    request: QUESTION_WINDOW,
    policy: defineScreenPolicy({ secureContent: { onSecureTarget: 'reject' } }),
    extra: { pointerTarget: FIXTURE_SECURE_NODE },
    why: 'the stricter mode refuses rather than masking',
  },
  {
    label: 'image past the per-image byte ceiling',
    request: QUESTION_WINDOW,
    policy: defineScreenPolicy({ image: { maxImageBytes: 1024, maxObservationBytes: 4096 } }),
    why: '§14: size limits on image tool results are enforced on the encoded bytes',
  },
  {
    label: 'observation past the total byte ceiling',
    request: { view: 'both', moment: 'question' },
    policy: defineScreenPolicy({ image: { maxImageBytes: 15_000, maxObservationBytes: 15_000 } }),
    why: 'the per-observation ceiling covers every image together',
  },
  {
    label: 'more full frames than active context allows',
    request: QUESTION_WINDOW,
    policy: defineScreenPolicy({ activeContext: { maxFullFrames: 0 } }),
    why: '§10 activeContext.maxFullFrames',
  },
  {
    label: 'more comparison frames than allowed',
    request: { view: 'window', moment: 'before-and-after' },
    policy: defineScreenPolicy({ activeContext: { maxComparisonFrames: 1 } }),
    why: '§10 activeContext.maxComparisonFrames',
  },
  {
    label: 'image pipeline failed',
    request: QUESTION_WINDOW,
    images: new FakeImageProcessor({
      failWith: new PilotError('capture-failed', 'the encoder is unavailable'),
    }),
    why: 'PR-018 failures surface as a typed, retryable error rather than no images',
  },
];

export async function runScreenPolicyDemo(): Promise<PolicyDemoResult> {
  const lines: string[] = [];
  const scenarios: PolicyDemoScenario[] = [];
  const out = (line = ''): void => {
    lines.push(line);
  };
  const heading = (text: string): void => {
    out();
    out(text);
    out('-'.repeat(text.length));
  };

  const policy = DEFAULT_SCREEN_CONTEXT_POLICY;

  heading('1. The policy in force (system-design §10)');
  out(`selected window only    ${String(policy.capture.selectedWindowOnly)} (not configurable)`);
  out(
    `observation rate        ${String(policy.capture.maxRequestsPerSecond)} calls / ${String(policy.capture.rateWindowMs)} ms`,
  );
  out(
    `local buffer            ${String(policy.localBuffer.durationMs)} ms, ${String(policy.localBuffer.maxBytes)} B, ${String(policy.localBuffer.maxFrames)} frames`,
  );
  out(`pointer retention       ${String(policy.localBuffer.pointerDurationMs)} ms`);
  out(`persist raw frames      ${String(policy.localBuffer.persist)} (not configurable)`);
  out(`full frame longest edge ${String(policy.image.fullFrameMaxEdge)} px`);
  out(`pointer crop            ${String(policy.image.pointerCropPixels)} px square`);
  out(`jpeg quality            ${String(policy.image.jpegQuality)}`);
  out(
    `image bytes             ${String(policy.image.maxImageBytes)} B per image, ${String(policy.image.maxObservationBytes)} B per observation`,
  );
  out(
    `active context          ${String(policy.activeContext.maxFullFrames)} full frame, ${String(policy.activeContext.maxPointerCrops)} pointer crop, ${String(policy.activeContext.maxComparisonFrames)} comparison frames`,
  );
  out(
    `secure content          ${policy.secureContent.onSecureTarget}, requireMaskableBounds=${String(policy.secureContent.requireMaskableBounds)}`,
  );

  heading('2. The rule table (rule → what it rejects → what the caller sees)');
  for (const rule of POLICY_RULES) {
    const info = POLICY_RULE_TABLE[rule];
    out(`${pad(rule, 30)}${pad(info.step, 10)}${pad(info.code, 22)}${info.rejects}`);
  }

  heading('3. Recorded fixture');
  out(`window              ${FIXTURE.window.applicationName} — "${FIXTURE.window.title}"`);
  out(`frames              ${String(FIXTURE.frames.length)} at 3 FPS`);
  out(`pointer samples     ${String(FIXTURE.pointerSamples.length)} at 30 Hz`);
  out(`question moment     +${String(FIXTURE.questionAt - FIXTURE.startedAt)} ms`);
  out('Each scenario replays the fixture into a fresh core on a fake clock.');

  heading('4. Allowed observations');
  for (const spec of ALLOWED) {
    const { scenario } = await runScenario(spec);
    scenarios.push(scenario);
    out(`${pad(scenario.label, 44)}ALLOWED`);
    out(`${pad('', 44)}${scenario.note}`);
    out(`${pad('', 44)}${spec.why}`);
  }

  heading('5. Rejected observations');
  for (const spec of REJECTED) {
    const { scenario } = await runScenario(spec);
    scenarios.push(scenario);
    out(`${pad(scenario.label, 44)}REJECTED by ${scenario.rule}`);
    out(`${pad('', 44)}step=${scenario.step} code=${String(scenario.code)}`);
    out(`${pad('', 44)}${scenario.note}`);
    out(`${pad('', 44)}${spec.why}`);
  }

  heading('6. Observation rate limit at its boundary');
  const rateHarness = await primed({ label: 'rate', request: QUESTION_WINDOW, why: '' });
  const base = rateHarness.clock.now();
  for (const offset of [0, 100, 200, 1000]) {
    const decision = await rateHarness.enforcer.evaluate({
      request: QUESTION_WINDOW,
      at: base + offset,
      questionAt: FIXTURE.questionAt,
      state: rateHarness.state(),
      source: rateHarness.source(),
    });
    const verdict = decision.allowed
      ? `ALLOWED  ${String(decision.rate.inWindow)}/${String(decision.rate.limit)} in the window`
      : `REJECTED by ${decision.rule} — retry after ${String(
          (decision.error.details?.['retryAfterMs'] as number | undefined) ?? 0,
        )} ms`;
    out(`+${pad(`${String(offset)} ms`, 10)}${verdict}`);
    scenarios.push({
      label: `rate limit +${String(offset)} ms`,
      outcome: decision.allowed ? 'allowed' : 'rejected',
      rule: decision.allowed ? null : decision.rule,
      step: decision.allowed ? 'return' : decision.step,
      code: decision.allowed ? null : decision.error.code,
      note: verdict,
    });
  }
  out('The window slides, so two calls at the end of one second do not admit two');
  out('more at the start of the next. The third call is allowed at exactly +1000 ms.');

  heading('7. Retention — cleared on pause, lock, window loss and shutdown');
  for (const event of ['pause', 'screen-lock', 'window-loss', 'shutdown'] as const) {
    const harness = await primed({ label: event, request: QUESTION_WINDOW, why: '' });
    const before = harness.core.status().buffer;
    const report = harness.retention.clearFor(event);
    out(
      `${pad(event, 14)}before ${pad(`${String(before.frameCount)} frames / ${String(before.byteCount)} B`, 26)}` +
        `cleared ${String(report.clearedFrames)} frames, ${String(report.clearedBytes)} B, ` +
        `${String(report.clearedPointerSamples)} pointer samples`,
    );
    out(
      `${pad('', 14)}reason=${pad(report.reason, 22)}buffers empty=${String(report.empty)} lineage reset=${String(report.lineageReset)}`,
    );
  }
  out('A pause or a lock keeps the scene lineage so a late result is refused as');
  out('superseded; shutdown and logout keep nothing at all.');

  heading('8. What redaction does and does not promise');
  out(SCREEN_REDACTION_CAVEAT);
  out();

  return { lines, scenarios };
}
