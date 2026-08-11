import { createScriptedModelSource } from '@pilot/agent';
import {
  MVP_SCREEN_POLICY,
  pointerCropRect,
  type NormalizedRect,
  type PixelRect,
  type PixelSize,
  type ScreenPoint,
} from '@pilot/shared';
import { lastRequest, settleRun } from '../observation/ask-demo.js';
import {
  buildFrame,
  openAcceptanceRig,
  screenPointAt,
  SYNTHETIC_PASSWORD_FIELD,
  SYNTHETIC_TOGGLE,
  WINDOW_BOUNDS,
} from './rig-support.js';

/**
 * PR-043 — the curated grounding checklist, as executable cases.
 *
 * `docs/implementation.md` asks for "approximately 30 grounding cases" and
 * `docs/mvp-01-point-ask-hear.md` §19 makes the metric "pointer grounding is
 * correct in at least 90% of the curated static-UI cases". **That metric is not
 * computable on this machine and no number resembling it is produced here.**
 * Grounding accuracy is a property of an *answer*: whether a model, shown the
 * crop Pilot made, talks about the control the pointer was on. Every provider in
 * this repository is a recorded fake or Pi's faux provider, so an accuracy
 * figure computed here would be a measurement of the script that produced the
 * answer. `docs/handoff.md` §1 step 23 is the procedure that fills it in.
 *
 * What these thirty cases *do* measure is Pilot's **input to the model**, which
 * is real, is the half a Mac cannot make more true, and is where every grounding
 * bug this project has actually found has lived (runbook follow-up 30, and the
 * `ownerPid` defect PR-031 fixed). Per case:
 *
 *  - the anchor's normalised point, against the one geometry module's own
 *    arithmetic on the screen point the pointer was at;
 *  - whether the anchor is inside the selected window, on the §8 rule that a
 *    point outside `[0,1]` identifies nothing;
 *  - the accessibility role and label the anchor retained, or their absence;
 *  - the crop rectangle §10 step 5 computes, and whether the thing the pointer
 *    was on is **inside the picture the model receives**;
 *  - what the rendered `<context>` envelope told the model, verbatim;
 *  - and, for the two foreign-window cases, that no label read off another
 *    application appears anywhere in the provider's request.
 *
 * ## Classification
 *
 * Every case declares a {@link GroundingMetric}. `grounding-accuracy` cases are
 * the ones §19's 90% is about: their input side is decided here and their
 * *verdict* waits on a model looking at a real screen. `tool-contract` cases are
 * claims about what `observe_screen` returns — image counts, comparison-frame
 * budgets, the full-frame edge limit — which are fully decided here and are not
 * part of the 90% at all. The suite prints both counts so the fraction that is
 * input-side-only cannot be mistaken for a score.
 *
 * ## Scale coverage
 *
 * Ten pointer positions are declared once and run at **both** 1× and 2×
 * (G-01…G-20), which is `docs/mvp-01-point-ask-hear.md` §19's standard-DPI and
 * Retina requirement and the first time the assembled application has run at
 * anything but 2×. The pairing is what makes the scale invariant checkable:
 * the same screen point must produce the *same* normalised point at both scales
 * and a *different* captured-pixel point, because §5's geometry module converts
 * through `captureSize` rather than through `scaleFactor`.
 */

export type GroundingMetric = 'grounding-accuracy' | 'tool-contract';

/** A pointer position the checklist points at, declared once for both scales. */
export interface GroundingPosition {
  readonly key: string;
  /** What is under the pointer, in the words a checklist would use. */
  readonly target: string;
  readonly point: ScreenPoint;
  readonly expect: {
    readonly normalized: { readonly x: number; readonly y: number };
    readonly insideWindow: boolean;
    /** `null` means "no element may be identified", which is a claim too. */
    readonly targetRole: string | null;
    readonly targetLabel: string | null;
    /** The element's own bounds must fall inside the crop the model receives. */
    readonly cropContainsTarget: boolean;
  };
  /** Strings that must appear nowhere in anything the provider was sent. */
  readonly forbiddenInPrompt?: readonly string[];
  readonly expectedGrounding: string;
}

function normalizedOf(point: ScreenPoint): { x: number; y: number } {
  return {
    x: (point.x - WINDOW_BOUNDS.x) / WINDOW_BOUNDS.width,
    y: (point.y - WINDOW_BOUNDS.y) / WINDOW_BOUNDS.height,
  };
}

/**
 * The ten positions, run at both scales.
 *
 * Chosen to cover the four things §8's coordinate contract can get wrong: the
 * ordinary case, the four corners (where `pointerCropRect` shifts rather than
 * clips), the exact border (where `isInsideWindow`'s inclusive bound decides),
 * and the two ways a pointer can be over something Pilot may not describe — a
 * foreign application's window stacked inside the frame, and a point outside the
 * frame altogether.
 */
export const GROUNDING_POSITIONS: readonly GroundingPosition[] = [
  {
    key: 'button',
    target: 'the "Update payment method" button (AXButton, the selected app)',
    point: { x: 700, y: 480 },
    expect: {
      normalized: normalizedOf({ x: 700, y: 480 }),
      insideWindow: true,
      targetRole: 'AXButton',
      targetLabel: 'Update payment method',
      cropContainsTarget: true,
    },
    expectedGrounding:
      'the crop is centred on the button and the envelope names it by role and label',
  },
  {
    key: 'sidebar',
    target: 'the account-settings outline in the sidebar (AXOutline)',
    point: { x: 220, y: 200 },
    expect: {
      normalized: normalizedOf({ x: 220, y: 200 }),
      insideWindow: true,
      targetRole: 'AXOutline',
      targetLabel: 'Account settings',
      cropContainsTarget: true,
    },
    expectedGrounding: 'a different crop from the button case, naming the outline instead',
  },
  {
    key: 'top-left',
    target: 'the window’s top-left corner, on no element',
    point: { x: 101, y: 81 },
    expect: {
      normalized: normalizedOf({ x: 101, y: 81 }),
      insideWindow: true,
      targetRole: null,
      targetLabel: null,
      cropContainsTarget: false,
    },
    expectedGrounding: 'the crop is shifted flush to the frame’s top-left, not clipped small',
  },
  {
    key: 'top-right',
    target: 'the window’s top-right corner, on no element',
    point: { x: 1299, y: 81 },
    expect: {
      normalized: normalizedOf({ x: 1299, y: 81 }),
      insideWindow: true,
      targetRole: null,
      targetLabel: null,
      cropContainsTarget: false,
    },
    expectedGrounding: 'the crop is shifted flush to the frame’s top-right',
  },
  {
    key: 'bottom-left',
    target: 'the window’s bottom-left corner, on no element',
    point: { x: 101, y: 879 },
    expect: {
      normalized: normalizedOf({ x: 101, y: 879 }),
      insideWindow: true,
      targetRole: null,
      targetLabel: null,
      cropContainsTarget: false,
    },
    expectedGrounding: 'the crop is shifted flush to the frame’s bottom-left',
  },
  {
    key: 'bottom-right',
    target: 'the window’s bottom-right corner, on no element',
    point: { x: 1299, y: 879 },
    expect: {
      normalized: normalizedOf({ x: 1299, y: 879 }),
      insideWindow: true,
      targetRole: null,
      targetLabel: null,
      cropContainsTarget: false,
    },
    expectedGrounding: 'the crop is shifted flush to the frame’s bottom-right',
  },
  {
    key: 'left-border',
    target: 'exactly the window’s left border (normalised x = 0)',
    point: { x: 100, y: 480 },
    expect: {
      normalized: normalizedOf({ x: 100, y: 480 }),
      insideWindow: true,
      targetRole: null,
      targetLabel: null,
      cropContainsTarget: false,
    },
    expectedGrounding: 'x = 0.000 is inside the window, not outside it (§8’s inclusive bound)',
  },
  {
    key: 'lower-middle',
    target: 'empty canvas below the button',
    point: { x: 700, y: 800 },
    expect: {
      normalized: normalizedOf({ x: 700, y: 800 }),
      insideWindow: true,
      targetRole: null,
      targetLabel: null,
      cropContainsTarget: false,
    },
    expectedGrounding: 'an ordinary interior point with no element under it identifies nothing',
  },
  {
    key: 'stacked-window',
    target: 'another application’s window, stacked inside the selected window’s frame',
    point: { x: 1100, y: 650 },
    expect: {
      normalized: normalizedOf({ x: 1100, y: 650 }),
      insideWindow: true,
      targetRole: null,
      targetLabel: null,
      cropContainsTarget: false,
    },
    forbiddenInPrompt: ['Private release notes'],
    expectedGrounding:
      'inside [0,1], so PR-013’s foreign-application rule fires rather than the outside-window one',
  },
  {
    key: 'outside-window',
    target: 'a point outside the selected window entirely, over another desktop element',
    point: { x: 1500, y: 950 },
    expect: {
      normalized: normalizedOf({ x: 1500, y: 950 }),
      insideWindow: false,
      targetRole: null,
      targetLabel: null,
      cropContainsTarget: false,
    },
    forbiddenInPrompt: ['Another desktop entirely'],
    expectedGrounding: 'the model is told the pointer was outside the window and given no target',
  },
];

/** What one case asks `observe_screen` for and what it expects back. */
export interface GroundingCase {
  readonly id: string;
  readonly title: string;
  readonly target: string;
  readonly expectedGrounding: string;
  readonly metric: GroundingMetric;
  readonly scaleFactor: 1 | 2;
  readonly view: 'pointer' | 'window' | 'both';
  readonly moment: 'question' | 'current' | 'before-and-after';
  /** `null` means the pointer is never sampled at all. */
  readonly point: ScreenPoint | null;
  readonly position?: GroundingPosition;
  readonly expect: {
    readonly imageCount?: number;
    readonly pointerCropEdge?: number;
    readonly fullFrameWithinMaxEdge?: boolean;
    readonly comparisonFramesAtMost?: number;
    readonly envelopeContains?: readonly string[];
    readonly envelopeOmits?: readonly string[];
    readonly cropContainsRegion?: NormalizedRect;
    readonly redactionsAtLeast?: number;
    readonly revisionsBehindAtLeast?: number;
    readonly forbiddenInPrompt?: readonly string[];
  };
  /** Push an oversized frame instead of one the size Pilot asked for. */
  readonly oversizedFrame?: boolean;
  /** Push a second, changed frame so a comparison has a transition to bound. */
  readonly secondFrame?: boolean;
  /** Push a newer frame from inside the agent callback, before the tool runs. */
  readonly reviseSceneMidRun?: boolean;
}

function positionCase(
  index: number,
  position: GroundingPosition,
  scaleFactor: 1 | 2,
): GroundingCase {
  return {
    id: `G-${String(index).padStart(2, '0')}`,
    title: `pointer on ${position.key} at ${String(scaleFactor)}×`,
    target: position.target,
    expectedGrounding: position.expectedGrounding,
    metric: 'grounding-accuracy',
    scaleFactor,
    view: 'both',
    moment: 'question',
    point: position.point,
    position,
    expect: {
      imageCount: 2,
      pointerCropEdge: MVP_SCREEN_POLICY.pointerCropPixels,
      ...(position.forbiddenInPrompt === undefined
        ? {}
        : { forbiddenInPrompt: position.forbiddenInPrompt }),
    },
  };
}

/**
 * The thirty cases.
 *
 * G-01…G-10 are the ten positions at 1×, G-11…G-20 the same ten at 2×, so the
 * two halves of §19's display requirement are directly comparable — same
 * screen point, same element, same expectation, different backing scale.
 * G-21…G-30 are the tool-contract and edge cases, all at 2×.
 */
export const GROUNDING_CASES: readonly GroundingCase[] = [
  ...GROUNDING_POSITIONS.map((position, index) => positionCase(index + 1, position, 1)),
  ...GROUNDING_POSITIONS.map((position, index) =>
    positionCase(index + 1 + GROUNDING_POSITIONS.length, position, 2),
  ),
  {
    id: 'G-21',
    title: 'view: pointer returns the crop alone',
    target: 'the "Update payment method" button',
    expectedGrounding: 'one image, the pointer crop, at the §10 crop size',
    metric: 'tool-contract',
    scaleFactor: 2,
    view: 'pointer',
    moment: 'question',
    point: { x: 700, y: 480 },
    expect: { imageCount: 1, pointerCropEdge: MVP_SCREEN_POLICY.pointerCropPixels },
  },
  {
    id: 'G-22',
    title: 'view: window returns the frame alone',
    target: 'the whole selected window',
    expectedGrounding: 'one image, the full frame, within the §10 edge limit',
    metric: 'tool-contract',
    scaleFactor: 2,
    view: 'window',
    moment: 'question',
    point: { x: 700, y: 480 },
    expect: { imageCount: 1, fullFrameWithinMaxEdge: true },
  },
  {
    id: 'G-23',
    title: 'view: both returns exactly two images',
    target: 'the button and its surroundings',
    expectedGrounding: 'the crop and the frame, and nothing else',
    metric: 'tool-contract',
    scaleFactor: 2,
    view: 'both',
    moment: 'question',
    point: { x: 700, y: 480 },
    expect: { imageCount: 2, pointerCropEdge: MVP_SCREEN_POLICY.pointerCropPixels },
  },
  {
    id: 'G-24',
    title: 'moment: current takes the latest state',
    target: 'the button, with the screen having moved on since the question',
    expectedGrounding: 'the observation is answered from a frame newer than the question anchor',
    metric: 'tool-contract',
    scaleFactor: 2,
    view: 'window',
    moment: 'current',
    point: { x: 700, y: 480 },
    secondFrame: true,
    expect: { imageCount: 1 },
  },
  {
    id: 'G-25',
    title: 'moment: before-and-after is budgeted at two frames',
    target: 'the Auto Renew toggle, before and after it moved',
    expectedGrounding: `no more than ${String(MVP_SCREEN_POLICY.maxComparisonFrames)} comparison frames, whatever the view asks for`,
    metric: 'tool-contract',
    scaleFactor: 2,
    view: 'both',
    moment: 'before-and-after',
    point: { x: 700, y: 480 },
    secondFrame: true,
    expect: { comparisonFramesAtMost: MVP_SCREEN_POLICY.maxComparisonFrames },
  },
  {
    id: 'G-26',
    title: 'a question asked with no pointer sample at all',
    target: 'nothing — the pointer was never read',
    expectedGrounding: 'the model is told "unknown" in words, never the -1,-1 sentinel',
    metric: 'grounding-accuracy',
    scaleFactor: 2,
    view: 'window',
    moment: 'question',
    point: null,
    expect: {
      envelopeContains: ['pointer: unknown'],
      envelopeOmits: ['-1.000'],
      forbiddenInPrompt: ['-1.000'],
    },
  },
  {
    id: 'G-27',
    title: 'pointer on the Auto Renew toggle',
    target: 'a rendered control with no accessibility element behind it',
    expectedGrounding: 'the toggle’s pixels are inside the crop the model receives',
    metric: 'grounding-accuracy',
    scaleFactor: 2,
    view: 'pointer',
    moment: 'question',
    point: screenPointAt(SYNTHETIC_TOGGLE),
    expect: {
      imageCount: 1,
      pointerCropEdge: MVP_SCREEN_POLICY.pointerCropPixels,
      cropContainsRegion: SYNTHETIC_TOGGLE,
    },
  },
  {
    id: 'G-28',
    title: 'pointer on a secure text field',
    target: 'an AXSecureTextField over the synthetic password field',
    expectedGrounding: 'the crop is centred on it and the field is masked before encoding (§14)',
    metric: 'grounding-accuracy',
    scaleFactor: 2,
    view: 'pointer',
    moment: 'question',
    point: screenPointAt(SYNTHETIC_PASSWORD_FIELD),
    expect: {
      imageCount: 1,
      cropContainsRegion: SYNTHETIC_PASSWORD_FIELD,
      redactionsAtLeast: 1,
      forbiddenInPrompt: ['hunter2-should-never-appear'],
    },
  },
  {
    id: 'G-29',
    title: 'the window changes between the question and the tool call',
    target: 'the button, on a screen that has moved on',
    expectedGrounding: 'the observation is answered and says how far behind the question was',
    metric: 'tool-contract',
    scaleFactor: 2,
    view: 'window',
    moment: 'question',
    point: { x: 700, y: 480 },
    reviseSceneMidRun: true,
    expect: { imageCount: 1, revisionsBehindAtLeast: 1 },
  },
  {
    id: 'G-30',
    title: 'an oversized frame is reduced to the §10 edge limit',
    target: 'the whole selected window, captured larger than policy allows',
    expectedGrounding: `the full frame reaches the model at no more than ${String(MVP_SCREEN_POLICY.fullFrameMaxEdge)} px on its longest edge`,
    metric: 'tool-contract',
    scaleFactor: 2,
    view: 'window',
    moment: 'question',
    point: { x: 700, y: 480 },
    oversizedFrame: true,
    expect: { imageCount: 1, fullFrameWithinMaxEdge: true },
  },
];

// ---------------------------------------------------------------------------
// Running one case
// ---------------------------------------------------------------------------

export interface GroundingAssertion {
  readonly claim: string;
  readonly passed: boolean;
  readonly evidence: string;
}

export interface GroundingCaseResult {
  readonly id: string;
  readonly title: string;
  readonly target: string;
  readonly expectedGrounding: string;
  readonly metric: GroundingMetric;
  readonly scaleFactor: 1 | 2;
  readonly assertions: readonly GroundingAssertion[];
  readonly inputSidePassed: boolean;
  /** What the anchor resolved to, for the scale-comparison table. */
  readonly observed: {
    readonly normalized: { readonly x: number; readonly y: number } | null;
    readonly capturedPixel: { readonly x: number; readonly y: number } | null;
    readonly captureSize: PixelSize;
    readonly cropRect: PixelRect | null;
    readonly targetRole: string | null;
    readonly targetLabel: string | null;
    readonly images: readonly {
      readonly purpose: string;
      readonly w: number;
      readonly h: number;
    }[];
    readonly envelope: string;
  };
}

function rectContains(outer: PixelRect, inner: PixelRect): boolean {
  return (
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height + 0.5
  );
}

function near(left: number, right: number, tolerance = 1e-9): boolean {
  return Math.abs(left - right) <= tolerance;
}

function fixed(value: number): string {
  return value.toFixed(3);
}

/**
 * Runs one case on its own rig.
 *
 * The model is Pi's faux provider with a one-line reply scripted, and the reply
 * is never read: nothing in this function looks at what the model said, because
 * what it said is what the script said. Everything asserted below is on Pilot's
 * side of the request.
 */
export async function runGroundingCase(one: GroundingCase): Promise<GroundingCaseResult> {
  const model = createScriptedModelSource({ script: [{ say: '…' }] });
  const opened = await openAcceptanceRig({
    scaleFactor: one.scaleFactor,
    stub: one.point === null ? {} : { pointer: one.point },
    rig: { modelSource: model },
  });
  const { rig, window, captureSize } = opened;
  const assertions: GroundingAssertion[] = [];
  const check = (claim: string, passed: boolean, evidence: string): void => {
    assertions.push({ claim, passed, evidence });
  };

  try {
    // The size Pilot asked the platform for is the size the geometry module
    // converts through. Checked rather than assumed: every pixel coordinate
    // below is wrong if the adapter's sizing changes.
    check(
      'capture.start asked for the policy-bounded size for this scale',
      opened.requestedCaptureSize !== null &&
        opened.requestedCaptureSize.width === captureSize.width &&
        opened.requestedCaptureSize.height === captureSize.height,
      `requested ${JSON.stringify(opened.requestedCaptureSize)}, ` +
        `expected ${String(captureSize.width)}×${String(captureSize.height)} ` +
        `(${String(WINDOW_BOUNDS.width)}×${String(WINDOW_BOUNDS.height)} pt × ` +
        `${String(one.scaleFactor)}, reduced to fullFrameMaxEdge=` +
        `${String(MVP_SCREEN_POLICY.fullFrameMaxEdge)})`,
    );

    const frameSize =
      one.oversizedFrame === true
        ? {
            width: MVP_SCREEN_POLICY.fullFrameMaxEdge * 2,
            height: MVP_SCREEN_POLICY.fullFrameMaxEdge,
          }
        : captureSize;
    const first = await buildFrame(window, {
      id: `${one.id}-a`,
      capturedAt: Date.now(),
      size: frameSize,
      scaleFactor: one.scaleFactor,
    });
    rig.observation.session.ingestFrame(first);
    if (one.secondFrame === true) {
      const second = await buildFrame(window, {
        id: `${one.id}-b`,
        capturedAt: Date.now() + 1,
        size: frameSize,
        scaleFactor: one.scaleFactor,
        toggleOn: true,
      });
      rig.observation.session.ingestFrame(second);
    }
    if (one.point !== null) {
      await rig.observation.samplePointer();
    }

    // Pushed from inside the agent's own callback so it really lands between
    // the question and the tool call, as `pnpm demo:ask` §5 does.
    let stop = (): void => {};
    if (one.reviseSceneMidRun === true) {
      const later = await buildFrame(window, {
        id: `${one.id}-c`,
        capturedAt: Date.now() + 2,
        size: frameSize,
        scaleFactor: one.scaleFactor,
        toggleOn: true,
      });
      let pushed = false;
      stop = rig.agent.session.subscribe((event) => {
        if (event.type === 'tool-started' && !pushed) {
          pushed = true;
          rig.observation.session.ingestFrame(later);
        }
      });
    }

    model.setScript([
      { observe: { view: one.view, moment: one.moment } },
      { say: 'A scripted reply, deliberately never read by this suite.' },
    ]);
    rig.controller.dispatch({ type: 'submit-text', text: 'What is this?' });
    await settleRun(rig);
    stop();

    const anchor = rig.anchoring.lastAnchor();
    const selection = anchor === null ? null : rig.anchoring.anchors.pointerAt(anchor.at);
    const pointer = selection !== null && selection.found ? selection.sample.pointer : null;
    const observation = rig.observation.lastObservation();
    const request = lastRequest(model);
    const envelope = request?.context ?? '(none)';
    const sent = JSON.stringify(model.requests);

    const cropRect =
      pointer?.capturedPixelPoint === undefined
        ? null
        : pointerCropRect(
            pointer.capturedPixelPoint,
            MVP_SCREEN_POLICY.pointerCropPixels,
            frameSize,
          );

    if (one.position !== undefined) {
      const position = one.position;
      check(
        'the anchor’s normalised point is the geometry module’s conversion of the screen point',
        pointer !== null &&
          near(pointer.normalizedPoint.x, position.expect.normalized.x, 1e-6) &&
          near(pointer.normalizedPoint.y, position.expect.normalized.y, 1e-6),
        pointer === null
          ? 'no pointer was anchored'
          : `screen ${String(position.point.x)},${String(position.point.y)} → ` +
              `${fixed(pointer.normalizedPoint.x)}, ${fixed(pointer.normalizedPoint.y)} ` +
              `(expected ${fixed(position.expect.normalized.x)}, ` +
              `${fixed(position.expect.normalized.y)})`,
      );
      check(
        `the anchor is ${position.expect.insideWindow ? 'inside' : 'outside'} the selected window`,
        anchor !== null && anchor.insideWindow === position.expect.insideWindow,
        `insideWindow=${String(anchor?.insideWindow)} ` +
          `(expected ${String(position.expect.insideWindow)})`,
      );
      check(
        position.expect.targetRole === null
          ? 'no accessibility element is identified'
          : `the accessibility element is ${position.expect.targetRole}`,
        (anchor?.targetRole ?? null) === position.expect.targetRole,
        `targetRole=${String(anchor?.targetRole ?? null)} ` +
          `label=${String(pointer?.accessibilityTarget?.label ?? null)} ` +
          `(expected role ${String(position.expect.targetRole)}, ` +
          `label ${String(position.expect.targetLabel)})`,
      );
      check(
        'the anchor’s captured-pixel point is the normalised point scaled by captureSize',
        pointer?.capturedPixelPoint !== undefined &&
          near(pointer.capturedPixelPoint.x, pointer.normalizedPoint.x * captureSize.width, 1e-6) &&
          near(pointer.capturedPixelPoint.y, pointer.normalizedPoint.y * captureSize.height, 1e-6),
        pointer?.capturedPixelPoint === undefined
          ? 'no captured-pixel point'
          : `${fixed(pointer.capturedPixelPoint.x)}, ${fixed(pointer.capturedPixelPoint.y)} ` +
              `in a ${String(captureSize.width)}×${String(captureSize.height)} capture`,
      );
      if (position.expect.cropContainsTarget) {
        const bounds = pointer?.accessibilityTarget?.normalizedBounds;
        const inPixels =
          bounds === undefined
            ? null
            : {
                x: bounds.x * frameSize.width,
                y: bounds.y * frameSize.height,
                width: bounds.width * frameSize.width,
                height: bounds.height * frameSize.height,
              };
        check(
          'the element the user pointed at is inside the crop the model receives',
          cropRect !== null && inPixels !== null && rectContains(cropRect, inPixels),
          cropRect === null || inPixels === null
            ? 'no crop rectangle or no element bounds'
            : `crop ${describeRect(cropRect)} contains element ${describeRect(inPixels)}`,
        );
      }
    }

    if (one.expect.imageCount !== undefined) {
      check(
        `observe_screen returned ${String(one.expect.imageCount)} image(s)`,
        (observation?.images.length ?? -1) === one.expect.imageCount,
        `images=${(observation?.images ?? [])
          .map((image) => `${image.purpose} ${String(image.width)}×${String(image.height)}`)
          .join(', ')}`,
      );
      check(
        'the provider received exactly those images and no others',
        (request?.images.length ?? -1) === one.expect.imageCount,
        `${String(request?.images.length ?? 0)} image block(s) in the provider request`,
      );
    }
    if (one.expect.pointerCropEdge !== undefined) {
      const crop = observation?.images.find((image) => image.purpose === 'pointer');
      check(
        `the pointer crop is ${String(one.expect.pointerCropEdge)} captured pixels square`,
        crop !== undefined &&
          crop.width === one.expect.pointerCropEdge &&
          crop.height === one.expect.pointerCropEdge,
        crop === undefined
          ? 'no pointer crop was produced'
          : `${String(crop.width)}×${String(crop.height)} ${crop.mimeType} ` +
              `${String(crop.byteLength)} B`,
      );
    }
    if (one.expect.fullFrameWithinMaxEdge === true) {
      const full = observation?.images.find((image) => image.purpose === 'window');
      check(
        `the full frame is within fullFrameMaxEdge=${String(MVP_SCREEN_POLICY.fullFrameMaxEdge)}`,
        full !== undefined &&
          Math.max(full.width, full.height) <= MVP_SCREEN_POLICY.fullFrameMaxEdge,
        full === undefined
          ? 'no full frame was produced'
          : `${String(full.width)}×${String(full.height)} from a ` +
              `${String(frameSize.width)}×${String(frameSize.height)} frame`,
      );
    }
    if (one.expect.comparisonFramesAtMost !== undefined) {
      check(
        `at most ${String(one.expect.comparisonFramesAtMost)} comparison frames`,
        (observation?.frames.length ?? 99) <= one.expect.comparisonFramesAtMost &&
          (observation?.images.length ?? 99) <= one.expect.comparisonFramesAtMost,
        `frames=${String(observation?.frames.length)} images=${String(
          observation?.images.length,
        )} comparison=${observation?.comparison === null ? 'no transition retained' : 'bounded'}`,
      );
    }
    if (one.expect.cropContainsRegion !== undefined) {
      const region = one.expect.cropContainsRegion;
      const inPixels = {
        x: region.x * frameSize.width,
        y: region.y * frameSize.height,
        width: region.width * frameSize.width,
        height: region.height * frameSize.height,
      };
      check(
        'the rendered control the pointer was on is inside the crop',
        cropRect !== null && rectContains(cropRect, inPixels),
        cropRect === null
          ? 'no crop rectangle'
          : `crop ${describeRect(cropRect)} contains region ${describeRect(inPixels)}`,
      );
    }
    if (one.expect.redactionsAtLeast !== undefined) {
      check(
        `at least ${String(one.expect.redactionsAtLeast)} region(s) masked before encoding`,
        (observation?.redaction.maskedRegions ?? 0) >= one.expect.redactionsAtLeast,
        `maskedRegions=${String(observation?.redaction.maskedRegions)} ` +
          `withheldValues=${String(observation?.redaction.withheldValues)} ` +
          `guarantee=${String(observation?.redaction.guarantee)}`,
      );
    }
    if (one.expect.revisionsBehindAtLeast !== undefined) {
      check(
        `the observation reports being at least ${String(one.expect.revisionsBehindAtLeast)} revision(s) behind`,
        (observation?.revisionsBehind ?? 0) >= one.expect.revisionsBehindAtLeast,
        `requestedSceneStatus=${String(observation?.requestedSceneStatus)} ` +
          `revisionsBehind=${String(observation?.revisionsBehind)} ` +
          `refusals=${String(rig.observation.metrics().refusals)}`,
      );
    }
    for (const needle of one.expect.envelopeContains ?? []) {
      check(
        `the envelope says "${needle}"`,
        envelope.includes(needle),
        `envelope: ${envelope.replace(/\n/g, ' | ')}`,
      );
    }
    for (const needle of one.expect.envelopeOmits ?? []) {
      check(
        `the envelope never says "${needle}"`,
        !envelope.includes(needle),
        `envelope: ${envelope.replace(/\n/g, ' | ')}`,
      );
    }
    for (const needle of one.expect.forbiddenInPrompt ?? []) {
      check(
        `"${needle}" appears nowhere in anything the provider was sent`,
        !sent.includes(needle),
        `${String(model.requests.length)} provider request(s) scanned`,
      );
    }

    return {
      id: one.id,
      title: one.title,
      target: one.target,
      expectedGrounding: one.expectedGrounding,
      metric: one.metric,
      scaleFactor: one.scaleFactor,
      assertions,
      inputSidePassed: assertions.every((assertion) => assertion.passed),
      observed: {
        normalized: pointer?.normalizedPoint ?? null,
        capturedPixel: pointer?.capturedPixelPoint ?? null,
        captureSize,
        cropRect,
        targetRole: anchor?.targetRole ?? null,
        targetLabel: pointer?.accessibilityTarget?.label ?? null,
        images: (observation?.images ?? []).map((image) => ({
          purpose: image.purpose,
          w: image.width,
          h: image.height,
        })),
        envelope,
      },
    };
  } finally {
    await rig.dispose();
  }
}

function describeRect(rect: PixelRect): string {
  return `[${fixed(rect.x)}, ${fixed(rect.y)} ${fixed(rect.width)}×${fixed(rect.height)}]`;
}

export interface GroundingRunResult {
  readonly results: readonly GroundingCaseResult[];
  readonly executed: number;
  readonly inputSidePassed: number;
  readonly accuracyPending: number;
  readonly contractDecided: number;
}

export async function runGroundingCases(
  cases: readonly GroundingCase[] = GROUNDING_CASES,
): Promise<GroundingRunResult> {
  const results: GroundingCaseResult[] = [];
  for (const one of cases) {
    results.push(await runGroundingCase(one));
  }
  return {
    results,
    executed: results.length,
    inputSidePassed: results.filter((result) => result.inputSidePassed).length,
    accuracyPending: results.filter((result) => result.metric === 'grounding-accuracy').length,
    contractDecided: results.filter((result) => result.metric === 'tool-contract').length,
  };
}
