import { describe, expect, it } from 'vitest';
import {
  asFrameId,
  PilotError,
  type CapturedFrame,
  type ObserveScreenRequest,
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
} from '../src/fixtures.js';
import { FakeImageProcessor } from '../src/image-pipeline.js';
import {
  countPurposes,
  plannedPurposes,
  POLICY_RULES,
  POLICY_RULE_TABLE,
  POLICY_STEPS,
  ScreenPolicyEnforcer,
  type ObservationPolicyRequest,
  type PolicyDecision,
  type PolicyRule,
} from '../src/policy-enforcer.js';
import {
  defineScreenPolicy,
  SCREEN_REDACTION_CAVEAT,
  type ScreenContextPolicy,
} from '../src/screen-policy.js';

/**
 * PR-017: the §10 execution order, run against recorded fixtures.
 *
 * Every scenario is either allowed by a named sequence of rules or rejected by
 * exactly one named rule. There is no third outcome — a silent empty result is
 * the thing this PR exists to prevent.
 */

const FIXTURE = createSceneLineageFixture();

interface ObserveOptions {
  readonly state?: PolicyStateOverrides;
  readonly extra?: Partial<ObservationPolicyRequest>;
  readonly captureFresh?: (signal?: AbortSignal) => Promise<CapturedFrame>;
  readonly at?: number;
}

async function primed(
  options: { policy?: ScreenContextPolicy; images?: FakeImageProcessor } = {},
): Promise<PolicyHarness> {
  const harness = createPolicyHarness({
    fixture: FIXTURE,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.images === undefined ? {} : { images: options.images }),
  });
  await primePolicyHarness(harness, FIXTURE);
  return harness;
}

async function observe(
  harness: PolicyHarness,
  request: ObserveScreenRequest,
  options: ObserveOptions = {},
): Promise<PolicyDecision> {
  return harness.enforcer.evaluate({
    request,
    at: options.at ?? harness.clock.now(),
    questionAt: FIXTURE.questionAt,
    state: harness.state(options.state),
    source: harness.source(options.captureFresh),
    ...(options.extra ?? {}),
  });
}

/** Rules this suite has actually seen fire; asserted complete at the end. */
const exercised = new Set<PolicyRule>();

function expectRejected(decision: PolicyDecision, rule: PolicyRule): PilotError {
  if (decision.allowed) {
    throw new Error(`expected rejection by ${rule}, but the observation was allowed`);
  }
  exercised.add(rule);
  expect(decision.rule).toBe(rule);
  expect(decision.error).toBeInstanceOf(PilotError);
  expect(decision.error.code).toBe(POLICY_RULE_TABLE[rule].code);
  expect(decision.error.details).toMatchObject({ policyRule: rule });
  expect(decision.error.userMessage).toBe(POLICY_RULE_TABLE[rule].userMessage);
  return decision.error;
}

const QUESTION_WINDOW: ObserveScreenRequest = { view: 'window', moment: 'question' };

describe('the rule table', () => {
  it('names every rule, its step, its code and what the user sees', () => {
    for (const rule of POLICY_RULES) {
      const info = POLICY_RULE_TABLE[rule];
      expect(info.rejects.length).toBeGreaterThan(0);
      expect(info.userMessage.length).toBeGreaterThan(0);
      expect(info.step === 'any' || POLICY_STEPS.includes(info.step)).toBe(true);
    }
    expect(Object.keys(POLICY_RULE_TABLE).sort()).toStrictEqual([...POLICY_RULES].sort());
  });
});

describe('the planned view', () => {
  it('maps §9 view and moment onto image purposes', () => {
    expect(plannedPurposes({ view: 'window', moment: 'question' })).toStrictEqual(['window']);
    expect(plannedPurposes({ view: 'pointer', moment: 'current' })).toStrictEqual(['pointer']);
    expect(plannedPurposes({ view: 'both', moment: 'question' })).toStrictEqual([
      'window',
      'pointer',
    ]);
    expect(plannedPurposes({ view: 'both', moment: 'before-and-after' })).toStrictEqual([
      'before',
      'after',
    ]);
  });

  it('counts purposes against the active-context budget', () => {
    expect(countPurposes(['window', 'pointer'])).toStrictEqual({
      fullFrames: 1,
      pointerCrops: 1,
      comparisonFrames: 0,
    });
    expect(countPurposes(['before', 'after'])).toStrictEqual({
      fullFrames: 0,
      pointerCrops: 0,
      comparisonFrames: 2,
    });
  });
});

describe('allowed observations', () => {
  it('runs the seven §10 steps in order and returns one full frame', async () => {
    const harness = await primed();
    const decision = await observe(harness, QUESTION_WINDOW);

    if (!decision.allowed) {
      throw new Error(`unexpectedly rejected by ${decision.rule}: ${decision.detail}`);
    }
    expect(decision.steps.map((step) => step.step)).toStrictEqual([...POLICY_STEPS]);
    expect(decision.steps.every((step) => step.outcome === 'passed')).toBe(true);
    expect(decision.observation.images).toHaveLength(1);
    expect(decision.observation.images[0]?.purpose).toBe('window');
    expect(decision.observation.sceneId).toBe(harness.core.scene?.sceneId);
    expect(decision.observation.sceneRevision).toBe(harness.core.scene?.revision);
    expect(decision.frames[0]?.origin).toBe('ring');
    expect(decision.frames[0]?.capturedAt).toBeLessThanOrEqual(FIXTURE.questionAt);
  });

  it('resizes a full frame to the policy edge and a crop to the policy crop size', async () => {
    const harness = await primed();
    const decision = await observe(harness, { view: 'both', moment: 'question' });

    if (!decision.allowed) {
      throw new Error(`unexpectedly rejected by ${decision.rule}`);
    }
    expect(decision.images.map((image) => image.purpose)).toStrictEqual(['window', 'pointer']);
    expect(harness.images.calls[0]).toMatchObject({
      purpose: 'window',
      maxEdge: 1440,
      crop: null,
      jpegQuality: 0.75,
    });
    expect(harness.images.calls[1]?.maxEdge).toBe(640);
    expect(harness.images.calls[1]?.crop).toMatchObject({ width: 640, height: 640 });
    // The full frame is 2400×1600 captured pixels; policy caps the long edge.
    expect(decision.images[0]?.size).toStrictEqual({ width: 1440, height: 960 });
    expect(decision.images[1]?.size).toStrictEqual({ width: 640, height: 640 });
  });

  it('takes a fresh capture for moment "current"', async () => {
    const harness = await primed();
    const fresh: CapturedFrame = {
      ...FIXTURE.frames[0]!,
      frameId: asFrameId('fresh-1'),
      capturedAt: harness.clock.now(),
    };
    const decision = await observe(
      harness,
      { view: 'window', moment: 'current' },
      { captureFresh: async () => fresh },
    );

    if (!decision.allowed) {
      throw new Error(`unexpectedly rejected by ${decision.rule}`);
    }
    expect(decision.frames[0]?.origin).toBe('fresh');
    expect(decision.observation.capturedAt).toBe(fresh.capturedAt);
  });

  it('returns two comparison frames for before-and-after', async () => {
    const harness = await primed();
    const decision = await observe(harness, { view: 'window', moment: 'before-and-after' });

    if (!decision.allowed) {
      throw new Error(`unexpectedly rejected by ${decision.rule}`);
    }
    expect(decision.images.map((image) => image.purpose)).toStrictEqual(['before', 'after']);
    expect(decision.activeContext.incoming.comparisonFrames).toBe(2);
    expect(decision.frames[0]?.frame.frameId).not.toBe(decision.frames[1]?.frame.frameId);
  });

  it('reports the honest redaction caveat on every allowed observation', async () => {
    const harness = await primed();
    const decision = await observe(harness, QUESTION_WINDOW);

    if (!decision.allowed) {
      throw new Error('unexpectedly rejected');
    }
    expect(decision.redaction.caveat).toBe(SCREEN_REDACTION_CAVEAT);
    expect(decision.redaction.guarantee).toBe('best-effort');
    expect(decision.redaction.maskedRegions).toBe(0);
  });

  it('says how much of the active context has to be evicted', async () => {
    const harness = await primed();
    const decision = await observe(
      harness,
      { view: 'both', moment: 'question' },
      {
        extra: { activeContext: { fullFrames: 1, pointerCrops: 1, comparisonFrames: 0 } },
      },
    );

    if (!decision.allowed) {
      throw new Error('unexpectedly rejected');
    }
    expect(decision.activeContext).toMatchObject({
      evictFullFrames: 1,
      evictPointerCrops: 1,
      evictComparisonFrames: 0,
    });
  });
});

describe('step 1 — validate permission and window identity', () => {
  it('refuses when observation is disabled', async () => {
    const harness = await primed();
    const decision = await observe(harness, QUESTION_WINDOW, { state: { enabled: false } });
    expectRejected(decision, 'observation-enabled');
  });

  it('refuses while paused', async () => {
    const harness = await primed();
    const decision = await observe(harness, QUESTION_WINDOW, { state: { paused: true } });
    expectRejected(decision, 'not-paused');
  });

  it('refuses while the screen is locked', async () => {
    const harness = await primed();
    const decision = await observe(harness, QUESTION_WINDOW, { state: { screenLocked: true } });
    expectRejected(decision, 'screen-unlocked');
  });

  it('refuses without Screen Recording permission', async () => {
    const harness = await primed();
    const decision = await observe(harness, QUESTION_WINDOW, {
      state: { screenRecording: 'denied' },
    });
    const error = expectRejected(decision, 'screen-recording-permission');
    expect(error.code).toBe('permission-denied');
  });

  it('refuses when no window is selected', async () => {
    const harness = await primed();
    const decision = await observe(harness, QUESTION_WINDOW, { state: { selectedWindow: null } });
    expectRejected(decision, 'window-selected');
  });

  it('refuses when the scene belongs to a different window than the selection', async () => {
    const harness = await primed();
    const decision = await observe(harness, QUESTION_WINDOW, {
      state: { selectedWindow: FIXTURE_WINDOW_SECONDARY, geometry: FIXTURE_GEOMETRY_SECONDARY },
    });
    expectRejected(decision, 'window-identity');
  });

  it('stops at the first failing rule and records the step as rejected', async () => {
    const harness = await primed();
    const decision = await observe(harness, QUESTION_WINDOW, {
      state: { paused: true, screenLocked: true },
    });

    if (decision.allowed) {
      throw new Error('unexpectedly allowed');
    }
    expect(decision.rule).toBe('not-paused');
    expect(decision.steps).toHaveLength(1);
    expect(decision.steps[0]).toMatchObject({ step: 'validate', outcome: 'rejected' });
    expect(decision.steps[0]?.rules).not.toContain('screen-unlocked');
  });
});

describe('selected window only (§9/§14)', () => {
  it('refuses a display capture source outright', async () => {
    const harness = await primed();
    const decision = await observe(harness, QUESTION_WINDOW, {
      state: { captureSource: 'display' },
    });

    const error = expectRejected(decision, 'selected-window-only');
    expect(error.details).toMatchObject({ captureSource: 'display' });
    expect(harness.images.calls).toHaveLength(0);
  });

  it('refuses an unknown capture source — it must be proven, not assumed', async () => {
    const harness = await primed();
    const decision = await observe(harness, QUESTION_WINDOW, {
      state: { captureSource: 'unknown' },
    });
    expectRejected(decision, 'selected-window-only');
  });

  it('refuses a fresh capture that came back with another window', async () => {
    const harness = await primed();
    const foreign: CapturedFrame = {
      ...FIXTURE.frames[0]!,
      frameId: asFrameId('foreign-fresh'),
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      capturedAt: harness.clock.now(),
    };
    const decision = await observe(
      harness,
      { view: 'window', moment: 'current' },
      { captureFresh: async () => foreign },
    );

    expectRejected(decision, 'frame-window-identity');
    // Nothing reached the image pipeline: the frame never became pixels.
    expect(harness.images.calls).toHaveLength(0);
  });

  it('never hands out a frame from a window that is not selected, even after a switch', async () => {
    const harness = await primed();
    const before = harness.core.scene?.sceneId;
    harness.clock.advance(100);
    await harness.session.start({
      window: FIXTURE_WINDOW_SECONDARY,
      geometry: FIXTURE_GEOMETRY_SECONDARY,
    });

    const decision = await observe(harness, QUESTION_WINDOW, {
      extra: { requestedScene: { sceneId: before! } },
    });
    // The buffers were cleared on the switch, so there is nothing to select
    // for the new scene either — and certainly nothing from the old window.
    expectRejected(decision, 'frame-available');
    expect(harness.images.calls).toHaveLength(0);
  });
});

describe('step 2 — select the requested timestamp and view', () => {
  it('refuses a moment that has already left the local buffer', async () => {
    const harness = await primed();
    harness.clock.advance(10_000);
    const decision = await observe(harness, QUESTION_WINDOW);
    expectRejected(decision, 'frame-available');
  });

  it('refuses a frame the policy has retired even when the ring still holds it', async () => {
    // The ring keeps the default three seconds; the policy handed to this
    // enforcer keeps 200 ms. A buffer built laxer than the policy must not be
    // able to leak an old frame past it.
    const harness = await primed();
    const strict = new ScreenPolicyEnforcer({
      clock: harness.clock,
      images: harness.images,
      policy: defineScreenPolicy({ localBuffer: { durationMs: 50 } }),
    });
    const decision = await strict.evaluate({
      request: QUESTION_WINDOW,
      at: harness.clock.now(),
      questionAt: FIXTURE.questionAt - 2000,
      state: harness.state(),
      source: harness.source(),
    });
    expectRejected(decision, 'buffer-retention');
  });

  it('refuses moment "current" when no fresh capture source is wired', async () => {
    const harness = await primed();
    const decision = await observe(harness, { view: 'window', moment: 'current' });
    expectRejected(decision, 'frame-available');
  });

  it('refuses a comparison window that resolves to a single frame', async () => {
    const harness = await primed();
    const decision = await observe(
      harness,
      { view: 'window', moment: 'before-and-after' },
      {
        extra: { comparisonWindow: { from: FIXTURE.questionAt - 300, to: FIXTURE.questionAt } },
      },
    );
    expectRejected(decision, 'comparison-frames-available');
  });

  it('refuses a pointer crop when no pointer position is known', async () => {
    const harness = await primed();
    const decision = await harness.enforcer.evaluate({
      request: { view: 'pointer', moment: 'question' },
      at: harness.clock.now(),
      questionAt: FIXTURE.questionAt,
      state: harness.state(),
      source: {
        selectFrame: (requestedAt, query) => harness.core.selectFrame(requestedAt, query),
        selectPointer: () => ({
          found: false,
          reason: 'empty',
          nearestDistanceMs: null,
          sampleCount: 0,
        }),
      },
    });
    expectRejected(decision, 'pointer-anchor-available');
  });

  it('still allows a window view when the pointer is unknown, and says so', async () => {
    const harness = await primed();
    const decision = await harness.enforcer.evaluate({
      request: QUESTION_WINDOW,
      at: harness.clock.now(),
      questionAt: FIXTURE.questionAt,
      state: harness.state(),
      source: {
        selectFrame: (requestedAt, query) => harness.core.selectFrame(requestedAt, query),
        selectPointer: () => ({
          found: false,
          reason: 'empty',
          nearestDistanceMs: null,
          sampleCount: 0,
        }),
      },
    });

    if (!decision.allowed) {
      throw new Error(`unexpectedly rejected by ${decision.rule}`);
    }
    // The §8 sentinel: outside [0, 1], so the model cannot read it as a real point.
    expect(decision.observation.pointer).toStrictEqual({ x: -1, y: -1 });
  });

  it('refuses a view or moment outside the §9 vocabulary', async () => {
    const harness = await primed();
    const badView = await observe(harness, {
      view: 'display',
      moment: 'question',
    } as unknown as ObserveScreenRequest);
    expectRejected(badView, 'view-supported');

    harness.rateLimiter.reset();
    const badMoment = await observe(harness, {
      view: 'window',
      moment: 'later',
    } as unknown as ObserveScreenRequest);
    expectRejected(badMoment, 'moment-supported');
  });
});

describe('step 3 — reject a superseded scene', () => {
  it('refuses a scene reference from a previous selection', async () => {
    const harness = await primed();
    const stale = harness.core.scene?.sceneId;
    harness.clock.advance(50);
    await harness.session.start({
      window: FIXTURE_WINDOW_SECONDARY,
      geometry: FIXTURE_GEOMETRY_SECONDARY,
    });
    // Give the new scene a frame so selection succeeds and lineage is what fails.
    const fresh: CapturedFrame = {
      ...FIXTURE.frames[0]!,
      frameId: asFrameId('secondary-1'),
      windowId: FIXTURE_WINDOW_SECONDARY.windowId,
      capturedAt: harness.clock.now(),
    };
    harness.session.ingestFrame(fresh);
    await harness.session.samplePointer(harness.clock.now());

    const decision = await observe(harness, QUESTION_WINDOW, {
      at: harness.clock.now(),
      extra: { requestedScene: { sceneId: stale! }, questionAt: harness.clock.now() },
    });

    const error = expectRejected(decision, 'scene-lineage');
    expect(error.code).toBe('scene-mismatch');
    expect(error.details).toMatchObject({ status: 'superseded' });
  });
});

describe('step 4 — redact known secure fields', () => {
  it('masks a secure pointer target and withholds its value', async () => {
    const harness = await primed();
    const decision = await observe(
      harness,
      { view: 'both', moment: 'question' },
      {
        extra: { pointerTarget: FIXTURE_SECURE_NODE },
      },
    );

    if (!decision.allowed) {
      throw new Error(`unexpectedly rejected by ${decision.rule}`);
    }
    expect(decision.redaction.maskedRegions).toBe(1);
    expect(decision.redaction.withheldValues).toBe(1);
    expect(decision.observation.target).toMatchObject({ isSecure: true, label: 'Password' });
    expect(decision.observation.target?.value).toBeUndefined();
    expect(JSON.stringify(decision.observation.target)).not.toContain('hunter2');
    // The mask actually reached the image pipeline, on every image.
    expect(harness.images.calls.map((call) => call.redactions)).toStrictEqual([1, 1]);
  });

  it('passes an ordinary target through with its value', async () => {
    const harness = await primed();
    const decision = await observe(harness, QUESTION_WINDOW, {
      extra: { pointerTarget: FIXTURE_ACCESSIBILITY_NODE },
    });

    if (!decision.allowed) {
      throw new Error('unexpectedly rejected');
    }
    expect(decision.observation.target).toMatchObject({ isSecure: false, value: 'off' });
    expect(harness.images.calls[0]?.redactions).toBe(0);
  });

  it('refuses a secure field it cannot locate', async () => {
    const harness = await primed();
    const decision = await observe(harness, QUESTION_WINDOW, {
      extra: {
        pointerTarget: { role: 'AXTextField', label: 'Password', value: 'x', isSecure: true },
      },
    });

    expectRejected(decision, 'unmaskable-secure-region');
    expect(harness.images.calls).toHaveLength(0);
  });

  it('refuses everything when the policy rejects rather than redacts', async () => {
    const policy = defineScreenPolicy({ secureContent: { onSecureTarget: 'reject' } });
    const harness = await primed({ policy });
    const decision = await observe(harness, QUESTION_WINDOW, {
      extra: { pointerTarget: FIXTURE_SECURE_NODE },
    });

    expectRejected(decision, 'secure-content-refused');
    expect(harness.images.calls).toHaveLength(0);
  });
});

describe('step 5 — render, and step 6 — limits', () => {
  it('refuses an image past the per-image byte ceiling', async () => {
    const policy = defineScreenPolicy({
      image: { maxImageBytes: 1024, maxObservationBytes: 4096 },
    });
    const harness = await primed({ policy });
    const decision = await observe(harness, QUESTION_WINDOW);

    const error = expectRejected(decision, 'image-bytes');
    expect(error.code).toBe('payload-too-large');
    expect(error.details).toMatchObject({ maxImageBytes: 1024 });
  });

  it('refuses an observation past the total byte ceiling', async () => {
    const policy = defineScreenPolicy({
      image: { maxImageBytes: 15_000, maxObservationBytes: 15_000 },
    });
    const harness = await primed({ policy });
    const decision = await observe(harness, { view: 'both', moment: 'question' });

    const error = expectRejected(decision, 'observation-bytes');
    expect(error.details).toMatchObject({ maxObservationBytes: 15_000 });
  });

  it('refuses more full frames than the active context allows', async () => {
    const policy = defineScreenPolicy({ activeContext: { maxFullFrames: 0 } });
    const harness = await primed({ policy });
    expectRejected(await observe(harness, QUESTION_WINDOW), 'max-full-frames');
  });

  it('refuses more pointer crops than the active context allows', async () => {
    const policy = defineScreenPolicy({ activeContext: { maxPointerCrops: 0 } });
    const harness = await primed({ policy });
    expectRejected(
      await observe(harness, { view: 'pointer', moment: 'question' }),
      'max-pointer-crops',
    );
  });

  it('refuses more comparison frames than the active context allows', async () => {
    const policy = defineScreenPolicy({ activeContext: { maxComparisonFrames: 1 } });
    const harness = await primed({ policy });
    expectRejected(
      await observe(harness, { view: 'window', moment: 'before-and-after' }),
      'max-comparison-frames',
    );
  });

  it('turns an image pipeline failure into a typed rejection', async () => {
    const images = new FakeImageProcessor({
      failWith: new PilotError('capture-failed', 'encoder exploded'),
    });
    const harness = await primed({ images });
    expectRejected(await observe(harness, QUESTION_WINDOW), 'render-failed');
  });

  it('reports cancellation as cancellation, not as a policy refusal', async () => {
    const harness = await primed();
    const controller = new AbortController();
    controller.abort();
    const decision = await observe(harness, QUESTION_WINDOW, {
      extra: { signal: controller.signal },
    });

    const error = expectRejected(decision, 'request-cancelled');
    expect(error.code).toBe('cancelled');
  });
});

describe('the observation rate limit end to end', () => {
  it('allows the policy budget and refuses the next call, then recovers', async () => {
    const harness = await primed();
    const at = harness.clock.now();

    expect((await observe(harness, QUESTION_WINDOW, { at })).allowed).toBe(true);
    expect((await observe(harness, QUESTION_WINDOW, { at: at + 100 })).allowed).toBe(true);

    const refused = await observe(harness, QUESTION_WINDOW, { at: at + 200 });
    const error = expectRejected(refused, 'rate-limit');
    expect(error.retryable).toBe(true);
    expect(error.details).toMatchObject({ retryAfterMs: 800 });
    expect(refused.steps).toHaveLength(1);

    // At exactly one second after the first call the slot is free again.
    expect((await observe(harness, QUESTION_WINDOW, { at: at + 1000 })).allowed).toBe(true);
  });

  it('charges a call that is later refused, so a cheap failure is not free', async () => {
    const harness = await primed();
    const at = harness.clock.now();
    await observe(harness, QUESTION_WINDOW, { at, state: { paused: true } });
    await observe(harness, QUESTION_WINDOW, { at: at + 1, state: { paused: true } });

    expectRejected(await observe(harness, QUESTION_WINDOW, { at: at + 2 }), 'rate-limit');
  });
});

/**
 * Runs last in the file. "Cover every rule" is a stated requirement of this PR,
 * and a list maintained by hand rots; this asserts it from what actually fired.
 */
describe('rule coverage', () => {
  it('exercises every rule in the table', () => {
    const missing = POLICY_RULES.filter((rule) => !exercised.has(rule));
    expect(missing).toStrictEqual([]);
  });
});
