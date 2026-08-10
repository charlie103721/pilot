import {
  asFrameId,
  isPilotError,
  OBSERVE_SCREEN_MOMENTS,
  OBSERVE_SCREEN_VIEWS,
  type CapturedFrame,
  type ObserveScreenRequest,
  type PilotErrorCode,
} from '@pilot/shared';
import {
  FIXTURE_GEOMETRY_RETINA,
  FIXTURE_GEOMETRY_SECONDARY,
  FIXTURE_SECURE_NODE,
  FIXTURE_WINDOW_RETINA,
  FIXTURE_WINDOW_SECONDARY,
} from '@pilot/platform/fakes';
import {
  createSceneLineageFixture,
  createScreenContextHarness,
  primeScreenContextHarness,
  type RecordedObservationFixture,
  type ScreenContextHarness,
} from './fixtures.js';
import { createImageFixtureFrame } from './image-fixtures.js';
import { PilotImageProcessor } from './image-processor.js';
import type { PolicyRule } from './policy-enforcer.js';
import { RETENTION_EVENTS } from './retention.js';
import { screenContextAnchor, type ScreenObservationMetadata } from './screen-context.js';

/**
 * PR-019 demo: "call `ScreenContextService.observe()` against recorded and
 * fake-fresh sources".
 *
 *     pnpm build && pnpm --filter @pilot/observation demo:context
 *
 * Everything here is deterministic. The screen is a synthetic screenshot that
 * really encodes and really decodes (PR-018's `renderSyntheticScreen`), the
 * session is replayed through the PR-001 platform fakes on a fake clock, and
 * the image pipeline runs on an injected stopwatch that always reads zero — so
 * the byte counts below are real and the output is byte-identical on every
 * machine and every run.
 *
 * What it is meant to show, in order:
 *
 *  1. the §5 interface, and what the facade had to be told rather than read;
 *  2. every `view` × `moment` combination and the images each produces;
 *  3. which scene transition a `before-and-after` was bounded around, and why
 *     the revision bound is the one that is true;
 *  4. a superseded scene reference being refused;
 *  5. an abort landing while the platform is capturing;
 *  6. retention clearing the frame ring *and* the decoded-frame cache;
 *  7. the typed error every refusal carries into the `observe_screen` tool.
 */

const WINDOW = FIXTURE_WINDOW_SECONDARY;
const GEOMETRY = FIXTURE_GEOMETRY_SECONDARY;

/** The stopwatch the demo renders through: no wall-clock reading, ever. */
const FROZEN_STOPWATCH = { elapsed: (): number => 0 };

export interface ContextDemoRow {
  readonly view: ObserveScreenRequest['view'];
  readonly moment: ObserveScreenRequest['moment'];
  readonly outcome: 'allowed' | 'refused';
  readonly images: string;
  readonly origin: string;
  readonly bytes: number;
  readonly rule: PolicyRule | null;
  readonly code: PilotErrorCode | null;
}

export interface ContextDemoRefusal {
  readonly label: string;
  readonly rule: PolicyRule;
  readonly code: PilotErrorCode;
  readonly retryable: boolean;
  readonly userMessage: string;
}

export interface ContextDemoResult {
  readonly lines: readonly string[];
  readonly rows: readonly ContextDemoRow[];
  readonly refusals: readonly ContextDemoRefusal[];
}

/**
 * The recorded session, with real screenshots in place of the PR-004
 * pseudo-random payloads. Built once and shared: the frames are immutable and
 * encoding thirteen PNGs per scenario would be the slowest thing in the demo.
 */
async function createImageFixture(): Promise<RecordedObservationFixture> {
  const base = createSceneLineageFixture({ window: WINDOW, geometry: GEOMETRY });
  const frames = await Promise.all(
    base.frames.map(async (frame, index) => {
      const built = await createImageFixtureFrame({
        windowId: WINDOW.windowId,
        frameId: `image-${String(index).padStart(4, '0')}`,
        capturedAt: frame.capturedAt,
        size: GEOMETRY.captureSize,
        scaleFactor: GEOMETRY.scaleFactor,
        encoding: 'png',
        // The renewal sheet opens partway through the session, so the two
        // halves of a comparison really do show different things.
        toggleOn: frame.capturedAt >= base.startedAt + 2000,
      });
      return built.frame;
    }),
  );
  return { ...base, frames };
}

interface ScenarioOptions {
  readonly fixture: RecordedObservationFixture;
  readonly withFresh?: boolean;
}

async function primed(options: ScenarioOptions): Promise<ScreenContextHarness> {
  const { fixture } = options;
  const harness = createScreenContextHarness({
    fixture,
    images: new PilotImageProcessor({ stopwatch: FROZEN_STOPWATCH }),
    conditions: { permissions: { screenRecording: 'granted', accessibility: 'granted' } },
    ...(options.withFresh === false
      ? {}
      : {
          captureFresh: async (): Promise<CapturedFrame> => {
            const newest = fixture.frames[fixture.frames.length - 1];
            if (newest === undefined) {
              throw new Error('fixture has no frames');
            }
            return { ...newest, frameId: asFrameId('fresh-0001'), capturedAt: harness.clock.now() };
          },
        }),
  });
  await primeScreenContextHarness(harness, fixture);
  const anchor = harness.core.anchorQuestion({
    startedAt: fixture.utteranceStartedAt,
    endedAt: fixture.questionAt,
  });
  if (anchor.ok) {
    harness.inputs.setAnchor(screenContextAnchor(anchor.anchor));
  }
  return harness;
}

function describeImages(metadata: ScreenObservationMetadata): string {
  return metadata.images
    .map(
      (image) =>
        `${image.purpose} ${String(image.width)}×${String(image.height)} ${image.mimeType.replace(
          'image/',
          '',
        )} ${String(image.byteLength)} B`,
    )
    .join(', ');
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export async function runScreenContextDemo(): Promise<ContextDemoResult> {
  const lines: string[] = [];
  const rows: ContextDemoRow[] = [];
  const refusals: ContextDemoRefusal[] = [];
  const out = (line = ''): void => {
    lines.push(line);
  };
  const heading = (text: string): void => {
    out();
    out(text);
    out('-'.repeat(text.length));
  };

  const fixture = await createImageFixture();

  heading('1. The interface (system-design §5)');
  out('interface ScreenContextService {');
  out('  status(): ScreenStatus;');
  out(
    '  observe(request: ObserveScreenRequest, signal?: AbortSignal): Promise<ScreenObservation>;',
  );
  out('  clear(): void;');
  out('}');
  out();
  out('The facade reads the selection, the buffers and the scene lineage from the');
  out('observation session. Three things it cannot read, and is told instead:');
  out('  paused / enabled     the user-facing observation switch');
  out('  permissions          TCC states (PR-011). Default is "unknown", which is refused');
  out('  captureSource        proof the platform did not widen beyond the window');

  const status = (await primed({ fixture })).service.status();
  heading('2. The recorded session');
  out(`window              ${WINDOW.applicationName} — "${status.selectedWindow?.title ?? ''}"`);
  out(
    `capture size        ${String(GEOMETRY.captureSize.width)}×${String(GEOMETRY.captureSize.height)} at ${String(GEOMETRY.scaleFactor)}×`,
  );
  out(
    `frames retained     ${String(status.buffer.frameCount)} of ${String(fixture.frames.length)}`,
  );
  out(
    `scene               ${status.scene?.sceneId ?? ''} at revision ${String(status.scene?.revision ?? 0)}`,
  );
  out(`question moment     +${String(fixture.questionAt - fixture.startedAt)} ms`);
  out('Frames are real PNG screenshots of a synthetic billing settings window.');

  heading('3. Every view × moment the tool can ask for (§9)');
  out(`${pad('view / moment', 30)}${pad('origin', 8)}images`);
  for (const view of OBSERVE_SCREEN_VIEWS) {
    for (const moment of OBSERVE_SCREEN_MOMENTS) {
      const request: ObserveScreenRequest = { view, moment };
      const harness = await primed({ fixture });
      try {
        const { metadata } = await harness.service.observeDetailed(request);
        const origin = [...new Set(metadata.frames.map((frame) => frame.origin))].join('+');
        rows.push({
          view,
          moment,
          outcome: 'allowed',
          images: describeImages(metadata),
          origin,
          bytes: metadata.totalImageBytes,
          rule: null,
          code: null,
        });
        out(`${pad(`${view} / ${moment}`, 30)}${pad(origin, 8)}${describeImages(metadata)}`);
      } catch (error) {
        if (!isPilotError(error)) {
          throw error;
        }
        const rule = error.details?.['policyRule'] as PolicyRule;
        rows.push({
          view,
          moment,
          outcome: 'refused',
          images: '',
          origin: '',
          bytes: 0,
          rule,
          code: error.code,
        });
        out(`${pad(`${view} / ${moment}`, 30)}${pad('-', 8)}REFUSED by ${rule} (${error.code})`);
      }
    }
  }
  out();
  out('`current` is a fresh capture taken at tool-execution time; every other row');
  out('came out of the three-second local ring. `before-and-after` produces two');
  out('comparison frames whatever the view asks for: §10 budgets two images for a');
  out('comparison, and a pointer crop would be the third.');

  heading('4. What a before-and-after is bounded around (§9)');
  {
    const harness = await primed({ fixture });
    const { metadata } = await harness.service.observeDetailed({
      view: 'window',
      moment: 'before-and-after',
    });
    const comparison = metadata.comparison;
    const before = metadata.frames[0];
    const after = metadata.frames[1];
    if (comparison === null) {
      out('No scene transition was retained, so the whole local buffer was used.');
    } else {
      out(
        `transition          revision ${String(comparison.sceneRevision)} at +${String(
          comparison.at - fixture.startedAt,
        )} ms (${comparison.changes.join(', ')})`,
      );
      out(
        `before frame        +${String((before?.capturedAt ?? 0) - fixture.startedAt)} ms, scene revision < ${String(comparison.minSceneRevision)}`,
      );
      out(
        `after frame         +${String((after?.capturedAt ?? 0) - fixture.startedAt)} ms, scene revision ≥ ${String(comparison.minSceneRevision)}`,
      );
      out(
        `window asked for    [+${String(comparison.from - fixture.startedAt)} ms, +${String(comparison.to - fixture.startedAt)} ms]`,
      );
      out();
      out('The time bound alone would not be enough. Frames arrive at 2–3 FPS and a');
      out('transition lands between two of them, so "later than the transition" and');
      out('"captured after the transition" are different claims. The revision bound');
      out('is the one that is true, and it is what the after frame is selected on.');
    }
  }

  heading('5. A scene reference the window selection has moved on from');
  {
    const harness = await primed({ fixture });
    const superseded = harness.core.scene;
    harness.clock.advance(50);
    // A *different* window: selecting the same one again is a revision, not a
    // new scene, and would not supersede anything.
    await harness.session.start({
      window: FIXTURE_WINDOW_RETINA,
      geometry: FIXTURE_GEOMETRY_RETINA,
    });
    // The new selection is producing frames, so the refusal below is the
    // lineage rule and not simply "there is nothing to look at".
    harness.session.ingestFrame({
      ...(fixture.frames[0] as CapturedFrame),
      frameId: asFrameId('retina-0001'),
      windowId: FIXTURE_WINDOW_RETINA.windowId,
      capturedAt: harness.clock.now(),
    });
    await harness.session.samplePointer(harness.clock.now());
    if (superseded !== null) {
      harness.inputs.setAnchor({
        at: harness.clock.now(),
        scene: { sceneId: superseded.sceneId, revision: superseded.revision },
      });
      const check = harness.core.checkScene({ sceneId: superseded.sceneId });
      out(`held scene          ${superseded.sceneId} → ${check.status}`);
    }
    try {
      await harness.service.observe({ view: 'window', moment: 'question' });
      out('NOT REFUSED — this is a defect.');
    } catch (error) {
      if (!isPilotError(error)) {
        throw error;
      }
      out(`observe()           threw ${error.code} [${String(error.details?.['policyRule'])}]`);
      out(`retryable           ${String(error.retryable)}`);
      out(`user sees           ${error.userMessage}`);
    }
    out();
    out('One `checkScene` call. The question was anchored to a scene that has since');
    out('ended, so it is refused rather than answered from the new window — which is');
    out('the failure the model could not detect for itself.');
  }

  heading('6. An abort landing while the platform is capturing (§15)');
  {
    const controller = new AbortController();
    let landed = false;
    const harness = createScreenContextHarness({
      fixture,
      images: new PilotImageProcessor({ stopwatch: FROZEN_STOPWATCH }),
      conditions: { permissions: { screenRecording: 'granted', accessibility: 'granted' } },
      // An adapter that ignores its signal entirely, which §15 must survive.
      captureFresh: () =>
        new Promise<CapturedFrame>((resolve) => {
          setTimeout(() => {
            landed = true;
            const newest = fixture.frames[fixture.frames.length - 1] as CapturedFrame;
            resolve({ ...newest, frameId: asFrameId('late-0001') });
          }, 50);
        }),
    });
    await primeScreenContextHarness(harness, fixture);
    const observing = harness.service.observe(
      { view: 'window', moment: 'current' },
      controller.signal,
    );
    controller.abort();
    try {
      await observing;
      out('NOT REFUSED — this is a defect.');
    } catch (error) {
      if (!isPilotError(error)) {
        throw error;
      }
      out(`observe()           threw ${error.code} [${String(error.details?.['policyRule'])}]`);
      out(`retryable           ${String(error.retryable)}`);
      out(`capture landed      ${String(landed)} — the refusal did not wait for it`);
    }
    out();
    out('The adapter takes the signal and the Mac one honours it, but §15 is a');
    out('promise about the tool call, not about every adapter. A capture that lands');
    out('after the abort is discarded rather than entering the ring.');
  }

  heading('7. Retention — the frame ring and the decoded frame go together');
  {
    for (const event of RETENTION_EVENTS) {
      const harness = await primed({ fixture });
      await harness.service.observeDetailed({ view: 'pointer', moment: 'question' });
      const before = harness.core.status().buffer;
      const report = harness.retention.clearFor(event);
      out(
        `${pad(event, 22)}cleared ${pad(`${String(report.clearedFrames)} frames / ${String(before.byteCount)} B`, 26)}` +
          `image cache dropped=${String(report.imageCacheCleared)} lineage reset=${String(report.lineageReset)}`,
      );
    }
    out();
    out('Runbook follow-up 16, closed: `PilotImageProcessor` keeps at most one');
    out('decoded frame so `view: "both"` decodes its source once instead of twice.');
    out('It is memory-only and never written anywhere, but it is a screenshot, so it');
    out('is dropped inside the same call that empties the ring — and the guard');
    out('reports whether one was wired rather than assuming it was.');
  }

  heading('8. Every refusal is a typed error the tool can act on');
  {
    const scenarios: ReadonlyArray<{
      readonly label: string;
      readonly run: (harness: ScreenContextHarness) => void | Promise<void>;
    }> = [
      {
        label: 'observation is paused',
        run: (harness) => {
          harness.inputs.setConditions({
            paused: true,
            permissions: { screenRecording: 'granted', accessibility: 'granted' },
          });
        },
      },
      {
        label: 'the screen is locked',
        run: (harness) => {
          harness.inputs.setConditions({
            screenLocked: true,
            permissions: { screenRecording: 'granted', accessibility: 'granted' },
          });
        },
      },
      {
        label: 'Screen Recording is not granted',
        run: (harness) => {
          harness.inputs.setConditions({
            permissions: { screenRecording: 'denied', accessibility: 'granted' },
          });
        },
      },
      {
        label: 'permission was never wired',
        run: (harness) => {
          harness.inputs.setConditions({});
        },
      },
      {
        label: 'capture widened to a display',
        run: (harness) => {
          harness.inputs.setConditions({
            captureSource: 'display',
            permissions: { screenRecording: 'granted', accessibility: 'granted' },
          });
        },
      },
      {
        label: 'a password field with no bounds to mask',
        run: (harness) => {
          harness.inputs.setAnchor({
            at: fixture.questionAt,
            target: { role: 'AXTextField', label: 'Password', value: '…', isSecure: true },
          });
        },
      },
      {
        label: 'the request was already cancelled',
        run: () => undefined,
      },
    ];

    for (const scenario of scenarios) {
      const harness = await primed({ fixture });
      await scenario.run(harness);
      const controller = new AbortController();
      if (scenario.label === 'the request was already cancelled') {
        controller.abort();
      }
      try {
        await harness.service.observe({ view: 'window', moment: 'question' }, controller.signal);
        out(`${pad(scenario.label, 42)}NOT REFUSED — this is a defect.`);
      } catch (error) {
        if (!isPilotError(error)) {
          throw error;
        }
        const rule = error.details?.['policyRule'] as PolicyRule;
        refusals.push({
          label: scenario.label,
          rule,
          code: error.code,
          retryable: error.retryable,
          userMessage: error.userMessage,
        });
        out(`${pad(scenario.label, 42)}${pad(error.code, 22)}${rule}`);
        out(`${pad('', 42)}retryable=${pad(String(error.retryable), 8)}${error.userMessage}`);
      }
    }
    out();
    out('No error code is invented here. Every one of these is a rule from PR-017’s');
    out('table, which PR-021 already maps onto a model-readable tool failure.');
  }

  heading('9. What the secure field in this frame is worth');
  {
    const harness = await primed({ fixture });
    harness.inputs.setAnchor({ at: fixture.questionAt, target: FIXTURE_SECURE_NODE });
    const { metadata } = await harness.service.observeDetailed({
      view: 'window',
      moment: 'question',
    });
    out(`masked regions      ${String(metadata.redaction.maskedRegions)}`);
    out(`values withheld     ${String(metadata.redaction.withheldValues)}`);
    out(`guarantee           ${metadata.redaction.guarantee}`);
    out(metadata.caveat);
  }
  out();

  return { lines, rows, refusals };
}
