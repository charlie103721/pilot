import { describe, expect, it } from 'vitest';
import {
  asFrameId,
  isPilotError,
  OBSERVE_SCREEN_MOMENTS,
  OBSERVE_SCREEN_VIEWS,
  type PilotError,
  screenObservationSchema,
  screenStatusSchema,
  type CapturedFrame,
  type ObserveScreenRequest,
  type PilotErrorCode,
} from '@pilot/shared';
import type { ScreenContextService } from '@pilot/platform';
import {
  FIXTURE_ACCESSIBILITY_NODE,
  FIXTURE_GEOMETRY_SECONDARY,
  FIXTURE_SECURE_NODE,
  FIXTURE_WINDOW_SECONDARY,
} from '@pilot/platform/fakes';
import {
  createSceneLineageFixture,
  createScreenContextHarness,
  primeScreenContextHarness,
  type RecordedObservationFixture,
  type ScreenContextHarness,
  type ScreenContextHarnessOptions,
} from '../src/fixtures.js';
import { FakeImageProcessor } from '../src/image-pipeline.js';
import { PilotImageProcessor } from '../src/image-processor.js';
import { createImageFixtureFrame } from '../src/image-fixtures.js';
import { RETENTION_EVENTS } from '../src/retention.js';
import { defineScreenPolicy } from '../src/screen-policy.js';
import {
  MutableScreenContextInputs,
  PilotScreenContextService,
  plannedObservationImages,
  screenContextAnchor,
  type ObservationFrameMetadata,
  type ScreenObservationRefusal,
} from '../src/screen-context.js';
import type { ObservationImagePurpose } from '../src/image-pipeline.js';

/**
 * PR-019: `ScreenContextService.observe()` against recorded and fake-fresh
 * sources.
 *
 * The facade owns four decisions and delegates everything else, so this suite
 * is about exactly those four: which moment, which frames, whether the scene is
 * still answerable, and whether the abort was honoured. Anything that is a
 * PR-017 rule is asserted through the rule that fired and the typed code it
 * carries, never re-derived here — the rule table is the single source of truth
 * and `policy-enforcer.test.ts` already pins it.
 */

const FIXTURE = createSceneLineageFixture();

/** A fresh capture of the selected window, taken "now". */
function freshFrame(harness: ScreenContextHarness, at = harness.clock.now()): CapturedFrame {
  const source = FIXTURE.frames[0];
  if (source === undefined) {
    throw new Error('fixture has no frames');
  }
  return { ...source, frameId: asFrameId(`fresh-${String(at)}`), capturedAt: at };
}

async function primed(
  options: ScreenContextHarnessOptions = {},
  fixture: RecordedObservationFixture = FIXTURE,
): Promise<ScreenContextHarness> {
  const harness = createScreenContextHarness({ fixture, ...options });
  await primeScreenContextHarness(harness, fixture);
  return harness;
}

/** The default harness plus a fresh-capture source and a question anchor. */
async function primedWithFresh(
  options: ScreenContextHarnessOptions = {},
): Promise<ScreenContextHarness> {
  const harness = await primed({
    captureFresh: async () => freshFrame(harness),
    ...options,
  });
  // Referenced by the closure above; assigned before any capture can run.
  return harness;
}

function anchorAtQuestion(harness: ScreenContextHarness): void {
  const scene = harness.core.scene;
  harness.inputs.setAnchor({
    at: FIXTURE.questionAt,
    ...(scene === null ? {} : { scene: { sceneId: scene.sceneId, revision: scene.revision } }),
  });
}

async function expectPilotError(promise: Promise<unknown>): Promise<PilotError> {
  try {
    await promise;
  } catch (error) {
    if (isPilotError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the observation to be refused');
}

function purposes(frames: readonly ObservationFrameMetadata[]): readonly ObservationImagePurpose[] {
  return frames.map((frame) => frame.purpose);
}

// ---------------------------------------------------------------------------

describe('the system-design §5 contract', () => {
  it('is a ScreenContextService', async () => {
    const harness = await primed();
    const service: ScreenContextService = harness.service;

    expect(typeof service.status).toBe('function');
    expect(typeof service.observe).toBe('function');
    expect(typeof service.clear).toBe('function');
  });

  it('reports a status the ScreenStatus schema accepts', async () => {
    const harness = await primed();
    const status = harness.service.status();

    expect(() => screenStatusSchema.parse(status)).not.toThrow();
    expect(status.enabled).toBe(true);
    expect(status.paused).toBe(false);
    expect(status.selectedWindow?.windowId).toBe(FIXTURE.window.windowId);
    expect(status.buffer.frameCount).toBeGreaterThan(0);
    expect(status.lastError).toBeNull();
  });

  it('refuses rather than assuming a permission it has never been told about', async () => {
    // The permission default is deliberately `unknown`, not `granted`: an
    // unwired facade must fail loudly rather than proceed on a guess.
    const harness = await primed({ conditions: {} });
    const error = await expectPilotError(
      harness.service.observe({ view: 'window', moment: 'question' }),
    );

    expect(error.code satisfies PilotErrorCode).toBe('permission-denied');
    expect(harness.service.status().permissions.screenRecording).toBe('unknown');
  });
});

describe('view × moment', () => {
  const combinations = OBSERVE_SCREEN_VIEWS.flatMap((view) =>
    OBSERVE_SCREEN_MOMENTS.map((moment) => ({ view, moment }) satisfies ObserveScreenRequest),
  );

  it('covers every combination the tool can ask for', () => {
    expect(combinations).toHaveLength(9);
  });

  for (const request of combinations) {
    it(`${request.view} / ${request.moment} produces the images §9 describes`, async () => {
      const harness = await primedWithFresh();
      anchorAtQuestion(harness);

      const { observation, metadata } = await harness.service.observeDetailed(request);

      expect(() => screenObservationSchema.parse(observation)).not.toThrow();
      const expected = plannedObservationImages(request).purposes;
      expect(observation.images.map((image) => image.purpose)).toStrictEqual([...expected]);
      expect(purposes(metadata.frames)).toStrictEqual([...expected]);
      expect(metadata.view).toBe(request.view);
      expect(metadata.moment).toBe(request.moment);

      // The moment decides where the frames came from, and only that.
      const origins = new Set(metadata.frames.map((frame) => frame.origin));
      expect([...origins]).toStrictEqual([request.moment === 'current' ? 'fresh' : 'ring']);
    });
  }

  it('answers "question" from the frame nearest the utterance anchor', async () => {
    const harness = await primedWithFresh();
    anchorAtQuestion(harness);
    harness.clock.advance(400);

    const { metadata } = await harness.service.observeDetailed({
      view: 'window',
      moment: 'question',
    });
    const frame = metadata.frames[0];

    expect(metadata.questionAt).toBe(FIXTURE.questionAt);
    expect(frame?.origin).toBe('ring');
    expect(frame?.capturedAt).toBeLessThanOrEqual(FIXTURE.questionAt);
    // The nearest frame at or before the anchor, at the fixture's 3 FPS.
    expect(FIXTURE.questionAt - (frame?.capturedAt ?? 0)).toBeLessThan(400);
    // …and it is *not* simply the newest frame the ring holds.
    expect(frame?.ageMs).toBeGreaterThan(0);
  });

  it('answers "current" with a capture taken at tool-execution time', async () => {
    const harness = await primedWithFresh();
    anchorAtQuestion(harness);
    harness.clock.advance(5000); // Every buffered frame has aged out by now.

    const { metadata } = await harness.service.observeDetailed({
      view: 'window',
      moment: 'current',
    });

    expect(harness.freshCaptures.count).toBe(1);
    expect(metadata.frames[0]?.origin).toBe('fresh');
    expect(metadata.frames[0]?.capturedAt).toBe(harness.clock.now());
    expect(metadata.frames[0]?.skewMs).toBeNull();
  });

  it('decodes one source frame once, and forgets it when the buffers are cleared', async () => {
    const harness = await imageHarness({ images: new PilotImageProcessor() });
    const request: ObserveScreenRequest = { view: 'pointer', moment: 'question' };

    const first = await harness.service.observeDetailed(request);
    const second = await harness.service.observeDetailed(request);

    // The same source frame, so the second render is served from the decoded
    // cache rather than decoding the PNG again.
    expect(first.metadata.frames[0]?.capturedAt).toBe(second.metadata.frames[0]?.capturedAt);
    expect(first.metadata.imageCacheHits).toBe(0);
    expect(second.metadata.imageCacheHits).toBe(1);

    // …and the cache is a decoded screenshot, so retention drops it. Nothing
    // survives to serve a third render (runbook follow-up 16).
    harness.service.clear();
    expect(harness.core.isEmpty()).toBe(true);
  }, 30_000);

  it('refuses "current" with no capture source rather than substituting a buffered frame', async () => {
    const harness = await primed();
    anchorAtQuestion(harness);

    const error = await expectPilotError(
      harness.service.observe({ view: 'window', moment: 'current' }),
    );

    expect(error.code).toBe('frame-unavailable');
    expect(error.details?.['policyRule']).toBe('frame-available');
  });

  it('does not crop for view "pointer" when the moment is a comparison', async () => {
    // §10 budgets two comparison frames; a crop would be the third image.
    const harness = await primedWithFresh();
    anchorAtQuestion(harness);

    const { metadata } = await harness.service.observeDetailed({
      view: 'pointer',
      moment: 'before-and-after',
    });

    expect(purposes(metadata.frames)).toStrictEqual(['before', 'after']);
  });
});

describe('before-and-after', () => {
  it('bounds the comparison around a scene transition it found in the lineage', async () => {
    const harness = await primedWithFresh();
    anchorAtQuestion(harness);

    const { metadata } = await harness.service.observeDetailed({
      view: 'window',
      moment: 'before-and-after',
    });
    const comparison = metadata.comparison;
    const before = metadata.frames[0];
    const after = metadata.frames[1];

    expect(comparison).not.toBeNull();
    expect(comparison?.changes.length).toBeGreaterThan(0);
    expect(before?.purpose).toBe('before');
    expect(after?.purpose).toBe('after');
    // The bound that matters: the `before` frame was captured before the
    // transition and the `after` frame at or after it. Ordering in time alone
    // would not prove this — frames arrive at 3 FPS and a transition lands
    // between two of them.
    expect(before?.capturedAt).toBeLessThan(comparison?.at ?? 0);
    expect(after?.capturedAt).toBeGreaterThanOrEqual(comparison?.at ?? 0);
    expect(comparison?.from).toBe(before?.capturedAt);
    expect(comparison?.to).toBe(FIXTURE.questionAt);
  });

  it('restricts the after frame to the transition revision or later', async () => {
    const harness = await primedWithFresh();
    anchorAtQuestion(harness);

    const { metadata } = await harness.service.observeDetailed({
      view: 'window',
      moment: 'before-and-after',
    });
    const minRevision = metadata.comparison?.minSceneRevision ?? 0;
    const after = metadata.frames[1];
    const record = harness.core.selectFrame(after?.capturedAt ?? 0, {
      direction: 'at-or-before',
      maxSkewMs: 0,
    });

    expect(record.found).toBe(true);
    expect(record.found ? record.record.sceneRevision : -1).toBeGreaterThanOrEqual(minRevision);
  });

  it('refuses rather than inventing a comparison when the buffer holds one frame', async () => {
    // Stopped after the very first frame: there is a "before" and there is
    // nothing else, so there is nothing to compare it to.
    const harness = createScreenContextHarness({ fixture: FIXTURE });
    await primeScreenContextHarness(harness, FIXTURE, { until: FIXTURE.startedAt });
    harness.inputs.setAnchor({ at: FIXTURE.startedAt });

    const error = await expectPilotError(
      harness.service.observe({ view: 'window', moment: 'before-and-after' }),
    );

    expect(error.code).toBe('frame-unavailable');
    expect(error.details?.['policyRule']).toBe('comparison-frames-available');
    expect(error.retryable).toBe(true);
  });

  it('refuses a comparison anchored outside the local buffer', async () => {
    const harness = await primedWithFresh();
    harness.inputs.setAnchor({ at: FIXTURE.startedAt });

    const error = await expectPilotError(
      harness.service.observe({ view: 'window', moment: 'before-and-after' }),
    );

    expect(error.code).toBe('frame-unavailable');
    // The three-second ring has already retired everything that old; the rule
    // that fires is the retention bound, not a missing frame.
    expect(['buffer-retention', 'frame-available']).toContain(error.details?.['policyRule']);
  });
});

describe('lineage validation', () => {
  it('refuses a scene the window selection has moved on from', async () => {
    const harness = await primedWithFresh();
    const superseded = harness.core.scene;
    expect(superseded).not.toBeNull();

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
    // The question still names the scene it was asked against.
    harness.inputs.setAnchor({
      at: harness.clock.now(),
      scene: { sceneId: superseded!.sceneId, revision: superseded!.revision },
    });

    const error = await expectPilotError(
      harness.service.observe({ view: 'window', moment: 'question' }),
    );

    expect(error.code).toBe('scene-mismatch');
    expect(error.details?.['policyRule']).toBe('scene-lineage');
    expect(error.details?.['status']).toBe('superseded');
    expect(error.retryable).toBe(false);
    // Proof the check is the lineage's and not a coincidence of the buffers.
    expect(harness.core.checkScene({ sceneId: superseded!.sceneId }).status).toBe('superseded');
  });

  it('refuses a scene it has never recorded', async () => {
    const harness = await primedWithFresh();
    harness.inputs.setAnchor({
      at: FIXTURE.questionAt,
      scene: { sceneId: 'scene-never-seen' as never },
    });

    const error = await expectPilotError(
      harness.service.observe({ view: 'window', moment: 'question' }),
    );

    expect(error.code).toBe('scene-mismatch');
    expect(error.details?.['status']).toBe('unknown');
  });

  it('refuses a revision the scene has never reached', async () => {
    const harness = await primedWithFresh();
    const scene = harness.core.scene!;
    harness.inputs.setAnchor({
      at: FIXTURE.questionAt,
      scene: { sceneId: scene.sceneId, revision: scene.revision + 5 },
    });

    const error = await expectPilotError(
      harness.service.observe({ view: 'window', moment: 'question' }),
    );

    expect(error.details?.['status']).toBe('future-revision');
  });

  it('allows a stale revision of the current scene, and says how stale', async () => {
    const harness = await primedWithFresh();
    const scene = harness.core.scene!;
    expect(scene.revision).toBeGreaterThan(0);
    harness.inputs.setAnchor({
      at: FIXTURE.questionAt,
      scene: { sceneId: scene.sceneId, revision: scene.revision - 1 },
    });

    const { metadata } = await harness.service.observeDetailed({
      view: 'window',
      moment: 'question',
    });

    // A revision behind is not a different screen: the frames still belong to
    // the same selection episode, and the model is told how far it is behind.
    expect(metadata.requestedSceneStatus).toBe('stale-revision');
    expect(metadata.revisionsBehind).toBe(1);
  });

  it('records that the model has now seen the revision', async () => {
    const harness = await primedWithFresh();
    anchorAtQuestion(harness);
    const scene = harness.core.scene!;

    await harness.service.observe({ view: 'window', moment: 'question' });

    expect(harness.core.lineage.get(scene.sceneId)?.lastObservedRevision).toBe(scene.revision);
  });

  it('refuses a fresh capture of the wrong window', async () => {
    const harness = await primed({
      captureFresh: async () => ({
        ...(FIXTURE.frames[0] as CapturedFrame),
        frameId: asFrameId('foreign-0001'),
        windowId: FIXTURE_WINDOW_SECONDARY.windowId,
        capturedAt: harness.clock.now(),
      }),
    });
    anchorAtQuestion(harness);

    const error = await expectPilotError(
      harness.service.observe({ view: 'window', moment: 'current' }),
    );

    expect(error.code).toBe('scene-mismatch');
    expect(error.details?.['policyRule']).toBe('frame-window-identity');
  });
});

describe('cancellation', () => {
  it('refuses a request whose signal has already fired, without spending a rate slot', async () => {
    const harness = await primedWithFresh();
    anchorAtQuestion(harness);
    const controller = new AbortController();
    controller.abort();

    const error = await expectPilotError(
      harness.service.observe({ view: 'window', moment: 'question' }, controller.signal),
    );

    expect(error.code).toBe('cancelled');
    expect(error.details?.['policyRule']).toBe('request-cancelled');
    // The budget was not charged, so the next call still goes through.
    await expect(harness.service.observe({ view: 'window', moment: 'question' })).resolves.toEqual(
      expect.objectContaining({ observationId: expect.any(String) as unknown as string }),
    );
  });

  it('honours an abort raised while the platform is capturing', async () => {
    const controller = new AbortController();
    let released = false;
    const harness = await primed({
      captureFresh: (signal) =>
        new Promise<CapturedFrame>((resolve) => {
          // An adapter that ignores its signal entirely: §15 must still hold.
          void signal;
          setTimeout(() => {
            released = true;
            resolve(freshFrame(harness));
          }, 50);
        }),
    });
    anchorAtQuestion(harness);

    const observing = harness.service.observe(
      { view: 'window', moment: 'current' },
      controller.signal,
    );
    controller.abort();
    const error = await expectPilotError(observing);

    expect(error.code).toBe('cancelled');
    expect(error.retryable).toBe(true);
    // The refusal did not wait for the capture that ignored the abort.
    expect(released).toBe(false);
  });

  it('passes the signal to an adapter that does honour it', async () => {
    const controller = new AbortController();
    let sawSignal = false;
    const harness = await primed({
      captureFresh: async (signal) => {
        sawSignal = signal === controller.signal;
        return freshFrame(harness);
      },
    });
    anchorAtQuestion(harness);

    await harness.service.observe({ view: 'window', moment: 'current' }, controller.signal);

    expect(sawSignal).toBe(true);
  });

  it('refuses an abort raised between selection and rendering', async () => {
    const controller = new AbortController();
    const images = new FakeImageProcessor();
    const harness = await primed({
      images,
      captureFresh: async () => {
        controller.abort();
        return freshFrame(harness);
      },
    });
    anchorAtQuestion(harness);

    const error = await expectPilotError(
      harness.service.observe({ view: 'window', moment: 'current' }, controller.signal),
    );

    expect(error.code).toBe('cancelled');
    expect(images.calls).toHaveLength(0);
  });
});

describe('retention', () => {
  it('clears the buffers and the decoded-frame cache together', async () => {
    const images = new PilotImageProcessor();
    const harness = await imageHarness({ images });
    await harness.service.observeDetailed({ view: 'both', moment: 'question' });

    expect(harness.core.status().buffer.frameCount).toBeGreaterThan(0);
    harness.service.clear();

    expect(harness.core.isEmpty()).toBe(true);
    expect(harness.retention.hasImageCache).toBe(true);
    expect(harness.retention.clears).toBe(1);
  });

  for (const event of RETENTION_EVENTS) {
    it(`drops the image cache on "${event}"`, async () => {
      let cleared = 0;
      const images = {
        render: new FakeImageProcessor().render.bind(new FakeImageProcessor()),
        clear: () => {
          cleared += 1;
        },
      };
      const harness = await primed({ images });

      const report = harness.retention.clearFor(event);

      expect(report.imageCacheCleared).toBe(true);
      expect(report.empty).toBe(true);
      expect(cleared).toBe(1);
    });
  }

  it('reports honestly when no cache was wired', async () => {
    // The fake processor has no cache, so there is nothing to claim was dropped.
    const harness = await primed();

    expect(harness.retention.hasImageCache).toBe(false);
    expect(harness.retention.clearFor('pause').imageCacheCleared).toBe(false);
  });

  it('drops the cache when the session tears the core down without the guard', async () => {
    // `ObservationSession` clears the core directly on window loss, which does
    // not pass through the retention guard. The decoded frame must not outlive
    // it, and the facade is the backstop that notices.
    let cleared = 0;
    const images = {
      render: new FakeImageProcessor().render.bind(new FakeImageProcessor()),
      clear: () => {
        cleared += 1;
      },
    };
    const harness = await primed({ images, captureFresh: async () => freshFrame(harness) });
    anchorAtQuestion(harness);
    await harness.service.observe({ view: 'window', moment: 'question' });
    expect(cleared).toBe(0);

    harness.session.handleWindowEvent({
      type: 'window-closed',
      windowId: FIXTURE.window.windowId,
    });
    // The next look notices the scene it cached for is gone.
    await expectPilotError(harness.service.observe({ view: 'window', moment: 'question' }));

    expect(cleared).toBe(1);
  });

  it('keeps the lineage on a pause and drops it on a shutdown', async () => {
    const harness = await primed();
    const scene = harness.core.scene!;

    harness.service.clear();
    expect(harness.core.checkScene({ sceneId: scene.sceneId }).status).toBe('superseded');

    harness.service.clear('shutdown');
    expect(harness.core.checkScene({ sceneId: scene.sceneId }).status).toBe('unknown');
  });
});

describe('policy refusals surface as typed errors', () => {
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly code: PilotErrorCode;
    readonly rule: string;
    readonly setUp: (harness: ScreenContextHarness) => void | Promise<void>;
  }> = [
    {
      label: 'paused',
      code: 'observation-paused',
      rule: 'not-paused',
      setUp: (harness) => {
        harness.inputs.setConditions({
          paused: true,
          permissions: { screenRecording: 'granted', accessibility: 'granted' },
        });
      },
    },
    {
      label: 'screen locked',
      code: 'screen-locked',
      rule: 'screen-unlocked',
      setUp: (harness) => {
        harness.inputs.setConditions({
          screenLocked: true,
          permissions: { screenRecording: 'granted', accessibility: 'granted' },
        });
      },
    },
    {
      label: 'observation switched off',
      code: 'observation-disabled',
      rule: 'observation-enabled',
      setUp: (harness) => {
        harness.inputs.setConditions({
          enabled: false,
          permissions: { screenRecording: 'granted', accessibility: 'granted' },
        });
      },
    },
    {
      label: 'capture widened to a display',
      code: 'invalid-request',
      rule: 'selected-window-only',
      setUp: (harness) => {
        harness.inputs.setConditions({
          captureSource: 'display',
          permissions: { screenRecording: 'granted', accessibility: 'granted' },
        });
      },
    },
    {
      label: 'a password field with no bounds to mask',
      code: 'protected-content',
      rule: 'unmaskable-secure-region',
      setUp: (harness) => {
        harness.inputs.setAnchor({
          at: FIXTURE.questionAt,
          target: { role: 'AXTextField', label: 'Password', value: '…', isSecure: true },
        });
      },
    },
  ];

  for (const scenario of cases) {
    it(`${scenario.label} → ${scenario.code}`, async () => {
      const harness = await primedWithFresh();
      await scenario.setUp(harness);

      const error = await expectPilotError(
        harness.service.observe({ view: 'window', moment: 'question' }),
      );

      expect(error.code).toBe(scenario.code);
      expect(error.details?.['policyRule']).toBe(scenario.rule);
      expect(error.userMessage.length).toBeGreaterThan(0);
      // The refusal is reported once, and shows up in `status()`.
      expect(harness.service.status().lastError?.code).toBe(scenario.code);
      expect(harness.service.metrics.refusals).toBe(1);
    });
  }

  it('surfaces the rate limit and clears lastError on the next success', async () => {
    const harness = await primedWithFresh();
    anchorAtQuestion(harness);
    const refusals: ScreenObservationRefusal[] = [];
    const service = new PilotScreenContextService({
      clock: harness.clock,
      session: harness.session,
      policy: harness.policy,
      images: harness.images,
      enforcer: harness.enforcer,
      retention: harness.retention,
      inputs: harness.inputs,
      onRefusal: (refusal) => refusals.push(refusal),
    });

    await service.observe({ view: 'window', moment: 'question' });
    await service.observe({ view: 'window', moment: 'question' });
    const error = await expectPilotError(service.observe({ view: 'window', moment: 'question' }));
    expect(error.code).toBe('rate-limited');
    expect(refusals.map((refusal) => refusal.rule)).toStrictEqual(['rate-limit']);
    expect(service.status().lastError?.code).toBe('rate-limited');

    harness.clock.advance(1000);
    await service.observe({ view: 'window', moment: 'question' });
    expect(service.status().lastError).toBeNull();
  });

  it('masks a secure field rather than refusing, and says what that is worth', async () => {
    const harness = await primedWithFresh();
    harness.inputs.setAnchor({ at: FIXTURE.questionAt, target: FIXTURE_SECURE_NODE });

    const { metadata } = await harness.service.observeDetailed({
      view: 'window',
      moment: 'question',
    });

    expect(metadata.redaction.maskedRegions).toBe(1);
    expect(metadata.redaction.guarantee).toBe('best-effort');
    expect(metadata.caveat).toContain('best effort');
    expect(metadata.images[0]?.redactionsApplied).toBe(1);
  });

  it('refuses when the stricter policy rejects secure content', async () => {
    const harness = await primedWithFresh({
      policy: defineScreenPolicy({ secureContent: { onSecureTarget: 'reject' } }),
    });
    harness.inputs.setAnchor({ at: FIXTURE.questionAt, target: FIXTURE_SECURE_NODE });

    const error = await expectPilotError(
      harness.service.observe({ view: 'window', moment: 'question' }),
    );

    expect(error.code).toBe('protected-content');
    expect(error.details?.['policyRule']).toBe('secure-content-refused');
  });
});

describe('compact metadata', () => {
  it('describes the observation without carrying a byte of it', async () => {
    const harness = await primedWithFresh();
    harness.inputs.setAnchor({ at: FIXTURE.questionAt, target: FIXTURE_ACCESSIBILITY_NODE });
    harness.inputs.setActiveContext({ fullFrames: 1, pointerCrops: 1, comparisonFrames: 0 });

    const { observation, metadata } = await harness.service.observeDetailed({
      view: 'both',
      moment: 'question',
    });

    expect(metadata.observationId).toBe(observation.observationId);
    expect(metadata.windowTitle).toBe(observation.windowTitle);
    expect(metadata.targetRole).toBe('AXCheckBox');
    expect(metadata.totalImageBytes).toBeGreaterThan(0);
    expect(metadata.images.map((image) => image.purpose)).toStrictEqual(['window', 'pointer']);
    // The eviction plan PR-022a applies: one of each is already in context and
    // one of each is arriving, so one of each has to go.
    expect(metadata.activeContext.evictFullFrames).toBe(1);
    expect(metadata.activeContext.evictPointerCrops).toBe(1);

    const serialized = JSON.stringify(metadata);
    for (const image of observation.images) {
      expect(serialized).not.toContain(image.base64.slice(0, 24));
    }
    expect(harness.service.lastObservation).toStrictEqual(metadata);
  });

  it('reports an unknown pointer as unknown rather than as a coordinate', async () => {
    const harness = await primed({ captureFresh: async () => freshFrame(harness) });
    // A moment no pointer sample covers.
    harness.inputs.setAnchor({ at: FIXTURE.startedAt - 60_000 });
    harness.clock.advance(1);

    const { metadata, observation } = await harness.service.observeDetailed({
      view: 'window',
      moment: 'current',
    });

    expect(metadata.pointerKnown).toBe(false);
    expect(observation.pointer.x).toBeLessThan(0);
  });
});

describe('inputs', () => {
  it('carries the question anchor PR-016 produced', async () => {
    const harness = await primedWithFresh();
    const result = harness.core.anchorQuestion({
      startedAt: FIXTURE.utteranceStartedAt,
      endedAt: FIXTURE.questionAt,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    harness.inputs.setAnchor(screenContextAnchor(result.anchor, FIXTURE_ACCESSIBILITY_NODE));
    const { metadata } = await harness.service.observeDetailed({
      view: 'pointer',
      moment: 'question',
    });

    expect(metadata.questionAt).toBe(result.anchor.at);
    expect(metadata.sceneId).toBe(result.anchor.sceneId);
    expect(metadata.requestedSceneStatus).toBe('current');
    expect(metadata.pointerKnown).toBe(true);
  });

  it('defaults to a model-initiated look when no utterance is pending', async () => {
    const harness = await primedWithFresh();
    const inputs = new MutableScreenContextInputs({
      permissions: { screenRecording: 'granted', accessibility: 'granted' },
    });
    expect(inputs.anchor()).toBeNull();

    harness.clock.advance(1);
    const { metadata } = await harness.service.observeDetailed({
      view: 'window',
      moment: 'question',
    });

    expect(metadata.questionAt).toBe(metadata.requestedAt);
    expect(metadata.requestedSceneStatus).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The real image pipeline (PR-018) behind the facade
// ---------------------------------------------------------------------------

/**
 * A harness whose ring holds real, decodable screenshots rather than the
 * PR-004 pseudo-random payloads, so the facade can be exercised against the
 * pipeline it will actually run in front of.
 */
async function imageHarness(
  options: ScreenContextHarnessOptions = {},
): Promise<ScreenContextHarness> {
  const window = FIXTURE_WINDOW_SECONDARY;
  const geometry = FIXTURE_GEOMETRY_SECONDARY;
  const base = createSceneLineageFixture({ window, geometry });
  const frames = await Promise.all(
    base.frames.map(async (frame, index) => {
      const built = await createImageFixtureFrame({
        windowId: window.windowId,
        frameId: `image-${String(index).padStart(4, '0')}`,
        capturedAt: frame.capturedAt,
        size: geometry.captureSize,
        scaleFactor: geometry.scaleFactor,
        encoding: 'png',
        toggleOn: frame.capturedAt >= base.startedAt + 2000,
      });
      return built.frame;
    }),
  );
  const fixture: RecordedObservationFixture = { ...base, frames };
  const harness = await primed({ images: new PilotImageProcessor(), ...options }, fixture);
  harness.inputs.setAnchor({ at: fixture.questionAt });
  return harness;
}

describe('the real image pipeline behind the facade', () => {
  it('returns decodable base64 with an honest byte length', async () => {
    const harness = await imageHarness();

    const { observation, metadata } = await harness.service.observeDetailed({
      view: 'both',
      moment: 'question',
    });

    expect(observation.images).toHaveLength(2);
    for (const [index, image] of observation.images.entries()) {
      const decoded = Buffer.from(image.base64, 'base64');
      expect(decoded.byteLength).toBe(metadata.images[index]?.byteLength);
      expect(image.mimeType === 'image/png' || image.mimeType === 'image/jpeg').toBe(true);
    }
    expect(metadata.totalImageBytes).toBe(
      metadata.images.reduce((sum, image) => sum + image.byteLength, 0),
    );
    // The pointer crop is bounded by the policy, the full frame by its edge.
    expect(metadata.images[1]?.width).toBeLessThanOrEqual(harness.policy.image.pointerCropPixels);
    expect(
      Math.max(metadata.images[0]?.width ?? 0, metadata.images[0]?.height ?? 0),
    ).toBeLessThanOrEqual(harness.policy.image.fullFrameMaxEdge);
  }, 30_000);
});
