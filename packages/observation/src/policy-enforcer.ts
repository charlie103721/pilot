import {
  createIdFactory,
  normalizedToCapturedPixel,
  normalizedRectToCapturedPixelRect,
  nullLogger,
  PilotError,
  pointerCropRect,
  screenObservationSchema,
  toPilotError,
  UNKNOWN_NORMALIZED_POINT,
  type AccessibilityNode,
  type AccessibilityNodeSummary,
  type CapturedFrame,
  type IdFactory,
  type Logger,
  type NormalizedPoint,
  type ObservedWindow,
  type ObserveScreenRequest,
  type PermissionState,
  type PilotErrorCode,
  type PixelRect,
  type SceneState,
  type ScreenObservation,
  type WindowGeometry,
} from '@pilot/shared';
import { toTimestamp, type Clock } from './clock.js';
import type { FrameSelection, FrameSelectionQuery } from './frame-ring.js';
import {
  toObservationImage,
  type ImageProcessor,
  type ImageRenderRequest,
  type ObservationImagePurpose,
  type RenderedImage,
} from './image-pipeline.js';
import { ObservationRateLimiter, type RateDecision } from './observation-rate.js';
import type { PointerSelection, PointerSelectionQuery } from './pointer-timeline.js';
import type { SceneLineageCheck, SceneRef } from './scene-lineage.js';
import {
  planRedaction,
  toSafeTargetSummary,
  type RedactionMask,
  type RedactionReport,
  type SecureRegion,
} from './secure-content.js';
import { DEFAULT_SCREEN_CONTEXT_POLICY, type ScreenContextPolicy } from './screen-policy.js';

/**
 * Screen policy enforcement (system-design §10).
 *
 * §10 prints an execution order, and this module is that order — an explicit,
 * named, testable sequence rather than checks scattered through a pipeline:
 *
 * 1. `validate` — permission, pause/lock, selected-window identity, rate.
 * 2. `select`   — the requested timestamp and view.
 * 3. `lineage`  — refuse frames from a previous window selection.
 * 4. `redact`   — known secure accessibility fields.
 * 5. `render`   — crop, annotate, resize, encode (the PR-018 seam).
 * 6. `limits`   — active-context image counts and byte ceilings.
 * 7. `return`   — the observation the Pi tool loop receives.
 *
 * Two properties matter more than the individual rules:
 *
 * - **No silent empty result.** Every rejection names the rule that fired, the
 *   step it fired in, and a typed `PilotError`. {@link POLICY_RULE_TABLE} maps
 *   each rule to what it rejects and what the user is told, so PR-021 can turn
 *   any refusal into something the model and the user can act on.
 * - **Selected window only.** §9/§14 forbid widening to a display. Two separate
 *   rules enforce it — `selected-window-only` refuses a capture source that is
 *   not the selected window, and `frame-window-identity` refuses an individual
 *   frame whose `windowId` is not the selected window's, which is the rule that
 *   catches a *fresh* capture handing back the wrong surface.
 */

export const POLICY_STEPS = [
  'validate',
  'select',
  'lineage',
  'redact',
  'render',
  'limits',
  'return',
] as const;

export type PolicyStep = (typeof POLICY_STEPS)[number];

export const POLICY_RULES = [
  // 1. validate
  'rate-limit',
  'observation-enabled',
  'not-paused',
  'screen-unlocked',
  'screen-recording-permission',
  'window-selected',
  'window-identity',
  'selected-window-only',
  // 2. select
  'view-supported',
  'moment-supported',
  'frame-available',
  'buffer-retention',
  'comparison-frames-available',
  'pointer-anchor-available',
  // 3. lineage
  'frame-window-identity',
  'scene-lineage',
  // 4. redact
  'secure-content-refused',
  'unmaskable-secure-region',
  // 5. render
  'render-failed',
  'image-bytes',
  // any
  'request-cancelled',
  // 6. limits
  'max-full-frames',
  'max-pointer-crops',
  'max-comparison-frames',
  'observation-bytes',
] as const;

export type PolicyRule = (typeof POLICY_RULES)[number];

export interface PolicyRuleInfo {
  /** The §10 step the rule belongs to; `'any'` for cancellation. */
  readonly step: PolicyStep | 'any';
  readonly code: PilotErrorCode;
  readonly retryable: boolean;
  /** What the rule rejects, in one line. */
  readonly rejects: string;
  /** What the caller shows the user. */
  readonly userMessage: string;
}

/**
 * The rule table. Data, not code: PR-021 maps a refusal onto UI and model text
 * from here, PR-041 verifies the limits against it, and the demo prints it.
 */
export const POLICY_RULE_TABLE: Readonly<Record<PolicyRule, PolicyRuleInfo>> = {
  'rate-limit': {
    step: 'validate',
    code: 'rate-limited',
    retryable: true,
    rejects: 'More observation calls per second than capture.maxRequestsPerSecond allows',
    userMessage: 'Pilot is looking at the screen too often. Try again in a moment.',
  },
  'observation-enabled': {
    step: 'validate',
    code: 'observation-disabled',
    retryable: false,
    rejects: 'Observation is switched off',
    userMessage: 'Pilot is not observing a window right now.',
  },
  'not-paused': {
    step: 'validate',
    code: 'observation-paused',
    retryable: false,
    rejects: 'Observation is paused; the buffers were cleared on pause',
    userMessage: 'Pilot is paused. Resume observation to look at the screen.',
  },
  'screen-unlocked': {
    step: 'validate',
    code: 'screen-locked',
    retryable: false,
    rejects: 'The screen is locked',
    userMessage: 'The screen is locked, so Pilot cannot see anything.',
  },
  'screen-recording-permission': {
    step: 'validate',
    code: 'permission-denied',
    retryable: false,
    rejects: 'Screen Recording permission is not granted',
    userMessage: 'Pilot needs Screen Recording permission to look at a window.',
  },
  'window-selected': {
    step: 'validate',
    code: 'observation-disabled',
    retryable: false,
    rejects: 'No window is selected',
    userMessage: 'Choose a window for Pilot to watch.',
  },
  'window-identity': {
    step: 'validate',
    code: 'window-not-found',
    retryable: false,
    rejects: 'The scene belongs to a window that is no longer the selected one',
    userMessage: 'Pilot is looking at a different window now.',
  },
  'selected-window-only': {
    step: 'validate',
    code: 'invalid-request',
    retryable: false,
    rejects: 'A capture source that is not the selected window (a display, or unknown)',
    userMessage: 'Pilot only looks at the window you selected, never a whole screen.',
  },
  'view-supported': {
    step: 'select',
    code: 'invalid-request',
    retryable: false,
    rejects: 'A view outside pointer | window | both',
    userMessage: 'Pilot did not understand that observation request.',
  },
  'moment-supported': {
    step: 'select',
    code: 'invalid-request',
    retryable: false,
    rejects: 'A moment outside question | current | before-and-after',
    userMessage: 'Pilot did not understand that observation request.',
  },
  'frame-available': {
    step: 'select',
    code: 'frame-unavailable',
    retryable: true,
    rejects: 'No frame for the requested moment (empty ring, or no fresh capture source)',
    userMessage: 'Pilot does not have a picture of that moment any more.',
  },
  'buffer-retention': {
    step: 'select',
    code: 'frame-unavailable',
    retryable: true,
    rejects: 'The nearest frame is older than localBuffer.durationMs',
    userMessage: 'That moment has already left Pilot’s short local buffer.',
  },
  'comparison-frames-available': {
    step: 'select',
    code: 'frame-unavailable',
    retryable: true,
    rejects: 'before-and-after with fewer than two distinct frames',
    userMessage: 'Pilot does not have two moments to compare.',
  },
  'pointer-anchor-available': {
    step: 'select',
    code: 'frame-unavailable',
    retryable: true,
    rejects: 'A pointer crop was requested but no pointer position is known',
    userMessage: 'Pilot does not know where you were pointing when you asked.',
  },
  'frame-window-identity': {
    step: 'lineage',
    code: 'scene-mismatch',
    retryable: false,
    rejects: 'A frame whose windowId is not the selected window — including a fresh capture',
    userMessage: 'Pilot is looking at a different window now.',
  },
  'scene-lineage': {
    step: 'lineage',
    code: 'scene-mismatch',
    retryable: false,
    rejects: 'A scene reference that has been superseded, is unknown, or names a future revision',
    userMessage: 'Pilot is looking at a different window now.',
  },
  'secure-content-refused': {
    step: 'redact',
    code: 'protected-content',
    retryable: false,
    rejects: 'A secure field in view while the policy is set to reject rather than redact',
    userMessage: 'Pilot will not send an image of a window showing a password field.',
  },
  'unmaskable-secure-region': {
    step: 'redact',
    code: 'protected-content',
    retryable: false,
    rejects: 'A secure field the platform reported without bounds, so it cannot be masked',
    userMessage: 'Pilot cannot hide a password field it cannot locate, so it will not send this.',
  },
  'render-failed': {
    step: 'render',
    code: 'capture-failed',
    retryable: true,
    rejects: 'The image pipeline could not produce an image',
    userMessage: 'Pilot could not prepare a picture of the window.',
  },
  'image-bytes': {
    step: 'render',
    code: 'payload-too-large',
    retryable: false,
    rejects: 'One encoded image larger than image.maxImageBytes',
    userMessage: 'That image is too large to send.',
  },
  'request-cancelled': {
    step: 'any',
    code: 'cancelled',
    retryable: true,
    rejects: 'An observation whose abort signal fired',
    userMessage: 'The request was cancelled.',
  },
  'max-full-frames': {
    step: 'limits',
    code: 'image-limit-exceeded',
    retryable: false,
    rejects: 'More full frames than activeContext.maxFullFrames',
    userMessage: 'Pilot may only send one full window image at a time.',
  },
  'max-pointer-crops': {
    step: 'limits',
    code: 'image-limit-exceeded',
    retryable: false,
    rejects: 'More pointer crops than activeContext.maxPointerCrops',
    userMessage: 'Pilot may only send one pointer close-up at a time.',
  },
  'max-comparison-frames': {
    step: 'limits',
    code: 'image-limit-exceeded',
    retryable: false,
    rejects: 'More comparison frames than activeContext.maxComparisonFrames',
    userMessage: 'Pilot may only compare two moments at a time.',
  },
  'observation-bytes': {
    step: 'limits',
    code: 'payload-too-large',
    retryable: false,
    rejects: 'All images of one observation larger than image.maxObservationBytes',
    userMessage: 'That observation is too large to send.',
  },
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Where the frames on offer came from. Anything other than
 * `'selected-window'` is refused at step 1: system-design §9 requires an error
 * rather than a fall back to whole-display capture.
 */
export type CaptureSource = 'selected-window' | 'display' | 'unknown';

export interface ObservationRuntimeState {
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly screenLocked: boolean;
  readonly permissions: {
    readonly screenRecording: PermissionState;
    readonly accessibility: PermissionState;
  };
  readonly selectedWindow: ObservedWindow | null;
  readonly geometry: WindowGeometry | null;
  readonly scene: SceneState | null;
  readonly captureSource: CaptureSource;
}

/**
 * The buffers, as the enforcer reads them. `ObservationCore` satisfies this
 * structurally; PR-019 adds `captureFresh` from the `ObservationAdapter`.
 */
export interface ObservationSource {
  selectFrame(requestedAt: number, query?: FrameSelectionQuery): FrameSelection;
  selectPointer(requestedAt: number, query?: PointerSelectionQuery): PointerSelection;
  captureFresh?(signal?: AbortSignal): Promise<CapturedFrame>;
  checkScene?(ref: SceneRef): SceneLineageCheck;
}

/** Counts already in the model's active context, when the caller tracks them. */
export interface ActiveContextCounts {
  readonly fullFrames: number;
  readonly pointerCrops: number;
  readonly comparisonFrames: number;
}

/** What the caller must drop to stay inside the §10/§11 active-context limits. */
export interface ActiveContextPlan {
  readonly evictFullFrames: number;
  readonly evictPointerCrops: number;
  readonly evictComparisonFrames: number;
  readonly incoming: ActiveContextCounts;
  readonly limits: ActiveContextCounts;
}

export interface ObservationPolicyRequest {
  readonly request: ObserveScreenRequest;
  /** "Now", from the injected clock. */
  readonly at: number;
  /** Utterance anchor for `moment: 'question'`. Defaults to `at`. */
  readonly questionAt?: number;
  /**
   * Window to compare across for `moment: 'before-and-after'` (§9: "two bounded
   * frames around a relevant scene transition"). The `before` image is the
   * earliest frame at or after `from`, the `after` image the latest at or
   * before `to`. PR-019 sets it around the transition it found; the default is
   * the whole local buffer up to the anchor.
   */
  readonly comparisonWindow?: { readonly from: number; readonly to: number };
  readonly state: ObservationRuntimeState;
  readonly source: ObservationSource;
  /** Scene the question or tool call was anchored to, checked against lineage. */
  readonly requestedScene?: SceneRef;
  /** Accessibility element under the grounded pointer (PR-013). */
  readonly pointerTarget?: AccessibilityNode;
  /** Further secure regions found by an accessibility scan. */
  readonly secureRegions?: readonly SecureRegion[];
  readonly activeContext?: ActiveContextCounts;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type PolicyStepOutcome = 'passed' | 'rejected' | 'skipped';

export interface PolicyStepRecord {
  readonly step: PolicyStep;
  readonly outcome: PolicyStepOutcome;
  /** Rules the step evaluated, in the order they ran. */
  readonly rules: readonly PolicyRule[];
  readonly note: string;
}

/** One frame the policy selected, and why it is the right one. */
export interface SelectedFrame {
  readonly frame: CapturedFrame;
  readonly purpose: ObservationImagePurpose;
  readonly origin: 'ring' | 'fresh';
  readonly capturedAt: number;
  /** `capturedAt - requestedAt`; `null` for a fresh capture. */
  readonly skewMs: number | null;
  readonly cropToPointer: boolean;
  readonly maxEdge: number;
}

export type PolicyDecision =
  | {
      readonly allowed: true;
      readonly observation: ScreenObservation;
      readonly steps: readonly PolicyStepRecord[];
      readonly frames: readonly SelectedFrame[];
      readonly images: readonly RenderedImage[];
      readonly redaction: RedactionReport;
      readonly activeContext: ActiveContextPlan;
      readonly rate: RateDecision;
      readonly totalImageBytes: number;
    }
  | {
      readonly allowed: false;
      readonly rule: PolicyRule;
      readonly step: PolicyStep;
      readonly detail: string;
      readonly error: PilotError;
      readonly steps: readonly PolicyStepRecord[];
      /** Present when redaction ran before the rejection. */
      readonly redaction: RedactionReport | null;
    };

export interface ScreenPolicyEnforcerOptions {
  readonly clock: Clock;
  readonly images: ImageProcessor;
  readonly policy?: ScreenContextPolicy;
  readonly ids?: IdFactory;
  readonly logger?: Logger;
  /** Share one limiter with the retention guard so a clear resets it. */
  readonly rateLimiter?: ObservationRateLimiter;
}

/** Purpose plan for a request, before any frame is chosen. §9 semantics. */
export function plannedPurposes(request: ObserveScreenRequest): readonly ObservationImagePurpose[] {
  if (request.moment === 'before-and-after') {
    // §10 budgets two comparison frames. `view: 'both'` does not add a third
    // image on this path; the crop would be the frame that breaks the budget.
    return ['before', 'after'];
  }
  switch (request.view) {
    case 'window':
      return ['window'];
    case 'pointer':
      return ['pointer'];
    case 'both':
      return ['window', 'pointer'];
  }
}

export function countPurposes(purposes: readonly ObservationImagePurpose[]): ActiveContextCounts {
  return {
    fullFrames: purposes.filter((purpose) => purpose === 'window').length,
    pointerCrops: purposes.filter((purpose) => purpose === 'pointer').length,
    comparisonFrames: purposes.filter((purpose) => purpose === 'before' || purpose === 'after')
      .length,
  };
}

const VIEWS: ReadonlySet<string> = new Set(['pointer', 'window', 'both']);
const MOMENTS: ReadonlySet<string> = new Set(['question', 'current', 'before-and-after']);

/** The pointer sentinel PR-024 uses, in the `NormalizedPoint` shape of §9. */
export const UNKNOWN_OBSERVATION_POINTER: NormalizedPoint = {
  x: UNKNOWN_NORMALIZED_POINT.normalizedX,
  y: UNKNOWN_NORMALIZED_POINT.normalizedY,
};

export class ScreenPolicyEnforcer {
  readonly #clock: Clock;
  readonly #policy: ScreenContextPolicy;
  readonly #images: ImageProcessor;
  readonly #ids: IdFactory;
  readonly #logger: Logger;
  readonly #rate: ObservationRateLimiter;

  constructor(options: ScreenPolicyEnforcerOptions) {
    this.#clock = options.clock;
    this.#policy = options.policy ?? DEFAULT_SCREEN_CONTEXT_POLICY;
    this.#images = options.images;
    this.#ids = options.ids ?? createIdFactory();
    this.#logger = options.logger ?? nullLogger;
    this.#rate =
      options.rateLimiter ??
      new ObservationRateLimiter({ clock: options.clock, policy: this.#policy });
  }

  get policy(): ScreenContextPolicy {
    return this.#policy;
  }

  get rateLimiter(): ObservationRateLimiter {
    return this.#rate;
  }

  /**
   * Runs the §10 execution order end to end.
   *
   * The steps are run in the printed order and each one records what it
   * evaluated, so a caller (and the demo) can show which rule allowed or
   * rejected an observation rather than only the outcome.
   */
  async evaluate(input: ObservationPolicyRequest): Promise<PolicyDecision> {
    const steps: PolicyStepRecord[] = [];
    const at = toTimestamp(input.at);

    // ---- 1. validate ------------------------------------------------------
    const validate = this.#validate(input, at);
    steps.push(validate.record);
    if (!validate.ok) {
      return this.#reject(
        steps,
        'validate',
        validate.rule,
        validate.detail,
        null,
        validate.details,
      );
    }
    const { window, scene, rate } = validate;

    if (isAborted(input.signal)) {
      return this.#reject(steps, 'validate', 'request-cancelled', 'Aborted before selection', null);
    }

    // ---- 2. select --------------------------------------------------------
    const selection = await this.#select(input, at, scene);
    steps.push(selection.record);
    if (!selection.ok) {
      return this.#reject(
        steps,
        'select',
        selection.rule,
        selection.detail,
        null,
        selection.details,
      );
    }

    // ---- 3. lineage -------------------------------------------------------
    const lineage = this.#checkLineage(input, window, selection.frames);
    steps.push(lineage.record);
    if (!lineage.ok) {
      return this.#reject(steps, 'lineage', lineage.rule, lineage.detail, null, lineage.details);
    }

    // ---- 4. redact --------------------------------------------------------
    const redaction = planRedaction(this.#policy, {
      ...(input.pointerTarget === undefined ? {} : { pointerTarget: input.pointerTarget }),
      ...(input.secureRegions === undefined ? {} : { secureRegions: input.secureRegions }),
      geometry: input.state.geometry,
    });
    steps.push({
      step: 'redact',
      outcome: redaction.allowed ? 'passed' : 'rejected',
      rules: ['secure-content-refused', 'unmaskable-secure-region'],
      note: `${String(redaction.report.maskedRegions)} region(s) masked, ${String(
        redaction.report.unmaskableRegions,
      )} unmaskable, ${String(redaction.report.withheldValues)} value(s) withheld`,
    });
    if (!redaction.allowed) {
      return this.#reject(steps, 'redact', redaction.rule, redaction.detail, redaction.report);
    }

    if (isAborted(input.signal)) {
      return this.#reject(
        steps,
        'render',
        'request-cancelled',
        'Aborted before rendering',
        redaction.report,
      );
    }

    // ---- 5. render --------------------------------------------------------
    const render = await this.#render(input, selection.frames, redaction.masks, selection.pointer);
    steps.push(render.record);
    if (!render.ok) {
      return this.#reject(steps, 'render', render.rule, render.detail, redaction.report, {
        ...render.details,
      });
    }

    // ---- 6. limits --------------------------------------------------------
    const limits = this.#enforceLimits(input, selection.frames, render.images);
    steps.push(limits.record);
    if (!limits.ok) {
      return this.#reject(steps, 'limits', limits.rule, limits.detail, redaction.report, {
        ...limits.details,
      });
    }

    // ---- 7. return --------------------------------------------------------
    const observation = this.#buildObservation(input, scene, window, selection, render.images);
    steps.push({
      step: 'return',
      outcome: 'passed',
      rules: [],
      note: `observation ${observation.observationId} with ${String(
        observation.images.length,
      )} image(s)`,
    });

    this.#logger.debug('observation allowed by policy', {
      observationId: observation.observationId,
      sceneId: observation.sceneId,
      sceneRevision: observation.sceneRevision,
      imageCount: observation.images.length,
      totalImageBytes: limits.totalBytes,
      maskedRegions: redaction.report.maskedRegions,
    });

    return {
      allowed: true,
      observation,
      steps,
      frames: selection.frames,
      images: render.images,
      redaction: redaction.report,
      activeContext: limits.plan,
      rate,
      totalImageBytes: limits.totalBytes,
    };
  }

  // -------------------------------------------------------------------------
  // Step 1 — validate permission and window identity
  // -------------------------------------------------------------------------

  #validate(
    input: ObservationPolicyRequest,
    at: number,
  ):
    | {
        readonly ok: true;
        readonly record: PolicyStepRecord;
        readonly window: ObservedWindow;
        readonly scene: SceneState;
        readonly rate: RateDecision;
      }
    | {
        readonly ok: false;
        readonly record: PolicyStepRecord;
        readonly rule: PolicyRule;
        readonly detail: string;
        readonly details?: Readonly<Record<string, unknown>>;
      } {
    const rules: PolicyRule[] = [];
    const fail = (
      rule: PolicyRule,
      detail: string,
      details?: Readonly<Record<string, unknown>>,
    ) => {
      rules.push(rule);
      return {
        ok: false as const,
        record: {
          step: 'validate' as const,
          outcome: 'rejected' as const,
          rules: [...rules],
          note: detail,
        },
        rule,
        detail,
        ...(details === undefined ? {} : { details }),
      };
    };

    // Rate first: a request that costs nothing to refuse must still cost the
    // caller its slot, or a caller can hammer the tool by failing a later rule.
    rules.push('rate-limit');
    const rate = this.#rate.take(at);
    if (!rate.allowed) {
      return fail(
        'rate-limit',
        `${String(rate.inWindow)} observation calls in the last ${String(rate.windowMs)} ms; the limit is ${String(rate.limit)}`,
        { retryAfterMs: rate.retryAfterMs, limit: rate.limit, windowMs: rate.windowMs },
      );
    }

    const state = input.state;
    rules.push('observation-enabled');
    if (!state.enabled) {
      return fail('observation-enabled', 'Observation is disabled');
    }
    rules.push('not-paused');
    if (state.paused) {
      return fail('not-paused', 'Observation is paused');
    }
    rules.push('screen-unlocked');
    if (state.screenLocked) {
      return fail('screen-unlocked', 'The screen is locked');
    }
    rules.push('screen-recording-permission');
    if (state.permissions.screenRecording !== 'granted') {
      return fail(
        'screen-recording-permission',
        `Screen Recording permission is ${state.permissions.screenRecording}`,
        { state: state.permissions.screenRecording },
      );
    }
    rules.push('window-selected');
    const window = state.selectedWindow;
    const scene = state.scene;
    if (window === null || scene === null) {
      return fail('window-selected', 'No window is selected');
    }
    rules.push('window-identity');
    if (scene.windowId !== window.windowId) {
      return fail(
        'window-identity',
        'The current scene belongs to a different window than the selected one',
      );
    }
    rules.push('selected-window-only');
    if (state.captureSource !== 'selected-window' || !this.#policy.capture.selectedWindowOnly) {
      return fail(
        'selected-window-only',
        `Capture source is "${state.captureSource}"; Pilot never widens to a display`,
        { captureSource: state.captureSource },
      );
    }

    return {
      ok: true,
      record: {
        step: 'validate',
        outcome: 'passed',
        rules: [...rules],
        note: `window ${window.windowId}, ${String(rate.inWindow)}/${String(rate.limit)} calls in window`,
      },
      window,
      scene,
      rate,
    };
  }

  // -------------------------------------------------------------------------
  // Step 2 — select the requested timestamp and view
  // -------------------------------------------------------------------------

  async #select(
    input: ObservationPolicyRequest,
    at: number,
    scene: SceneState,
  ): Promise<
    | {
        readonly ok: true;
        readonly record: PolicyStepRecord;
        readonly frames: readonly SelectedFrame[];
        readonly pointer: PointerAnchor;
      }
    | {
        readonly ok: false;
        readonly record: PolicyStepRecord;
        readonly rule: PolicyRule;
        readonly detail: string;
        readonly details?: Readonly<Record<string, unknown>>;
      }
  > {
    const rules: PolicyRule[] = ['view-supported', 'moment-supported'];
    const fail = (
      rule: PolicyRule,
      detail: string,
      details?: Readonly<Record<string, unknown>>,
    ) => {
      if (!rules.includes(rule)) {
        rules.push(rule);
      }
      return {
        ok: false as const,
        record: {
          step: 'select' as const,
          outcome: 'rejected' as const,
          rules: [...rules],
          note: detail,
        },
        rule,
        detail,
        ...(details === undefined ? {} : { details }),
      };
    };

    const { request } = input;
    if (!VIEWS.has(request.view)) {
      return fail('view-supported', `Unsupported view "${String(request.view)}"`);
    }
    if (!MOMENTS.has(request.moment)) {
      return fail('moment-supported', `Unsupported moment "${String(request.moment)}"`);
    }

    const purposes = plannedPurposes(request);
    const anchorAt = toTimestamp(input.questionAt ?? at);
    const needsPointer = purposes.includes('pointer');

    // Pointer anchor — the crop centre, the marker position and the `pointer`
    // field of the observation. A pointer that is not known is reported as
    // unknown; it is only a rejection when a crop was actually requested.
    rules.push('pointer-anchor-available');
    const pointer = this.#anchorPointer(input, anchorAt, scene);
    if (needsPointer && !pointer.known) {
      return fail(
        'pointer-anchor-available',
        `A pointer crop was requested but ${pointer.detail}`,
        { reason: pointer.reason },
      );
    }

    rules.push('frame-available', 'buffer-retention');
    const frames: SelectedFrame[] = [];

    if (request.moment === 'current') {
      const captureFresh = input.source.captureFresh;
      if (captureFresh === undefined) {
        return fail('frame-available', 'No fresh capture source is wired for moment "current"');
      }
      let fresh: CapturedFrame;
      try {
        fresh = await captureFresh.call(input.source, input.signal);
      } catch (error) {
        const pilot = toPilotError(error, 'capture-failed');
        if (pilot.code === 'cancelled') {
          return fail('request-cancelled', pilot.message, { cause: pilot.code });
        }
        return fail('frame-available', `Fresh capture failed: ${pilot.message}`, {
          cause: pilot.code,
        });
      }
      for (const purpose of purposes) {
        frames.push(this.#toSelected(fresh, purpose, 'fresh', null));
      }
    } else if (request.moment === 'question') {
      const found = this.#selectFromRing(input, anchorAt, scene, 'at-or-before');
      if (!found.ok) {
        return fail(found.rule, found.detail, found.details);
      }
      for (const purpose of purposes) {
        frames.push(this.#toSelected(found.frame, purpose, 'ring', found.skewMs));
      }
    } else {
      rules.push('comparison-frames-available');
      const from = toTimestamp(
        input.comparisonWindow?.from ?? anchorAt - this.#policy.localBuffer.durationMs,
      );
      const to = toTimestamp(input.comparisonWindow?.to ?? anchorAt);
      const before = this.#selectFromRing(input, from, scene, 'at-or-after');
      if (!before.ok) {
        return fail(before.rule, `before: ${before.detail}`, before.details);
      }
      const after = this.#selectFromRing(input, to, scene, 'at-or-before');
      if (!after.ok) {
        return fail(after.rule, `after: ${after.detail}`, after.details);
      }
      if (before.frame.frameId === after.frame.frameId) {
        return fail(
          'comparison-frames-available',
          'The buffer holds only one frame for this scene, so there is nothing to compare',
        );
      }
      frames.push(this.#toSelected(before.frame, 'before', 'ring', before.skewMs));
      frames.push(this.#toSelected(after.frame, 'after', 'ring', after.skewMs));
    }

    return {
      ok: true,
      record: {
        step: 'select',
        outcome: 'passed',
        rules: [...rules],
        note: `${request.moment}/${request.view} → ${frames.map((frame) => frame.purpose).join(' + ')}`,
      },
      frames,
      pointer,
    };
  }

  #selectFromRing(
    input: ObservationPolicyRequest,
    requestedAt: number,
    scene: SceneState,
    direction: 'at-or-before' | 'at-or-after',
  ):
    | { readonly ok: true; readonly frame: CapturedFrame; readonly skewMs: number }
    | {
        readonly ok: false;
        readonly rule: PolicyRule;
        readonly detail: string;
        readonly details: Readonly<Record<string, unknown>>;
      } {
    // The retention bound is the *policy's*, not the ring's: a core built with a
    // laxer ring must not be able to hand out a frame the policy has retired.
    const selection = input.source.selectFrame(requestedAt, {
      direction,
      scene: scene.sceneId,
      maxSkewMs: Number.POSITIVE_INFINITY,
    });
    if (!selection.found) {
      return {
        ok: false,
        rule: 'frame-available',
        detail: `no frame for the requested moment (${selection.reason})`,
        details: { reason: selection.reason, frameCount: selection.frameCount },
      };
    }
    if (selection.distanceMs > this.#policy.localBuffer.durationMs) {
      return {
        ok: false,
        rule: 'buffer-retention',
        detail: `nearest frame is ${String(selection.distanceMs)} ms away, past the ${String(
          this.#policy.localBuffer.durationMs,
        )} ms local buffer`,
        details: {
          distanceMs: selection.distanceMs,
          durationMs: this.#policy.localBuffer.durationMs,
        },
      };
    }
    return { ok: true, frame: selection.record.frame, skewMs: selection.skewMs };
  }

  #toSelected(
    frame: CapturedFrame,
    purpose: ObservationImagePurpose,
    origin: 'ring' | 'fresh',
    skewMs: number | null,
  ): SelectedFrame {
    const cropToPointer = purpose === 'pointer';
    return {
      frame,
      purpose,
      origin,
      capturedAt: frame.capturedAt,
      skewMs,
      cropToPointer,
      maxEdge: cropToPointer
        ? this.#policy.image.pointerCropPixels
        : this.#policy.image.fullFrameMaxEdge,
    };
  }

  #anchorPointer(
    input: ObservationPolicyRequest,
    anchorAt: number,
    scene: SceneState,
  ): PointerAnchor {
    const selection = input.source.selectPointer(anchorAt, {
      scene: scene.sceneId,
      maxSkewMs: Number.POSITIVE_INFINITY,
    });
    if (!selection.found) {
      return {
        known: false,
        point: UNKNOWN_OBSERVATION_POINTER,
        insideWindow: false,
        reason: selection.reason,
        detail: `no pointer sample for this scene (${selection.reason})`,
      };
    }
    if (selection.distanceMs > this.#policy.localBuffer.pointerDurationMs) {
      return {
        known: false,
        point: UNKNOWN_OBSERVATION_POINTER,
        insideWindow: false,
        reason: 'out-of-range',
        detail: `nearest pointer sample is ${String(selection.distanceMs)} ms away`,
      };
    }
    return {
      known: true,
      point: selection.sample.pointer.normalizedPoint,
      insideWindow: selection.sample.insideWindow,
      reason: null,
      detail: 'pointer resolved',
    };
  }

  // -------------------------------------------------------------------------
  // Step 3 — reject frames from a previous window selection
  // -------------------------------------------------------------------------

  #checkLineage(
    input: ObservationPolicyRequest,
    window: ObservedWindow,
    frames: readonly SelectedFrame[],
  ):
    | { readonly ok: true; readonly record: PolicyStepRecord }
    | {
        readonly ok: false;
        readonly record: PolicyStepRecord;
        readonly rule: PolicyRule;
        readonly detail: string;
        readonly details?: Readonly<Record<string, unknown>>;
      } {
    const rules: PolicyRule[] = ['frame-window-identity', 'scene-lineage'];
    const fail = (
      rule: PolicyRule,
      detail: string,
      details?: Readonly<Record<string, unknown>>,
    ) => ({
      ok: false as const,
      record: { step: 'lineage' as const, outcome: 'rejected' as const, rules, note: detail },
      rule,
      detail,
      ...(details === undefined ? {} : { details }),
    });

    for (const selected of frames) {
      if (selected.frame.windowId !== window.windowId) {
        return fail(
          'frame-window-identity',
          `A ${selected.origin} frame belongs to window ${selected.frame.windowId}, not the selected ${window.windowId}`,
          { origin: selected.origin, purpose: selected.purpose },
        );
      }
    }

    const ref = input.requestedScene;
    const check = ref === undefined ? undefined : input.source.checkScene?.(ref);
    if (check !== undefined && !check.ok) {
      return fail('scene-lineage', `Requested scene is ${check.status}: ${check.detail}`, {
        status: check.status,
      });
    }

    return {
      ok: true,
      record: {
        step: 'lineage',
        outcome: 'passed',
        rules,
        note:
          check === undefined
            ? `${String(frames.length)} frame(s) from the selected window`
            : `${String(frames.length)} frame(s), requested scene ${check.status}`,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Step 5 — crop, annotate, resize, encode (PR-018)
  // -------------------------------------------------------------------------

  async #render(
    input: ObservationPolicyRequest,
    frames: readonly SelectedFrame[],
    masks: readonly RedactionMask[],
    anchor: PointerAnchor,
  ): Promise<
    | {
        readonly ok: true;
        readonly record: PolicyStepRecord;
        readonly images: readonly RenderedImage[];
      }
    | {
        readonly ok: false;
        readonly record: PolicyStepRecord;
        readonly rule: PolicyRule;
        readonly detail: string;
        readonly details: Readonly<Record<string, unknown>>;
      }
  > {
    const rules: PolicyRule[] = ['render-failed', 'image-bytes', 'request-cancelled'];
    const images: RenderedImage[] = [];
    const pointer = anchor.known ? anchor.point : null;

    for (const selected of frames) {
      const frameSize = selected.frame.size;
      const redactions: PixelRect[] = masks.map((mask) =>
        normalizedRectToCapturedPixelRect(mask.normalizedBounds, frameSize),
      );
      const marker = pointer === null ? undefined : normalizedToCapturedPixel(pointer, frameSize);
      const crop =
        selected.cropToPointer && marker !== undefined
          ? pointerCropRect(marker, this.#policy.image.pointerCropPixels, frameSize)
          : undefined;

      const renderRequest: ImageRenderRequest = {
        frame: selected.frame,
        purpose: selected.purpose,
        ...(crop === undefined ? {} : { crop }),
        maxEdge: selected.maxEdge,
        redactions,
        ...(marker === undefined || selected.purpose === 'window' ? {} : { marker }),
        jpegQuality: this.#policy.image.jpegQuality,
        preferLossless: false,
        // The ceiling is still enforced below, on the bytes that come back.
        // Passing it in only lets PR-018 pick an encoding that fits rather than
        // hand back a lossless image this step must then reject.
        maxBytes: this.#policy.image.maxImageBytes,
      };

      let rendered: RenderedImage;
      try {
        rendered = await this.#images.render(renderRequest, input.signal);
      } catch (error) {
        const pilot = toPilotError(error, 'capture-failed');
        const rule: PolicyRule = pilot.code === 'cancelled' ? 'request-cancelled' : 'render-failed';
        return {
          ok: false,
          record: {
            step: 'render',
            outcome: 'rejected',
            rules,
            note: `${selected.purpose}: ${pilot.message}`,
          },
          rule,
          detail: `${selected.purpose}: ${pilot.message}`,
          details: { purpose: selected.purpose, cause: pilot.code },
        };
      }

      if (rendered.byteLength > this.#policy.image.maxImageBytes) {
        return {
          ok: false,
          record: {
            step: 'render',
            outcome: 'rejected',
            rules,
            note: `${selected.purpose} is ${String(rendered.byteLength)} B`,
          },
          rule: 'image-bytes',
          detail: `The ${selected.purpose} image is ${String(rendered.byteLength)} B, past the ${String(
            this.#policy.image.maxImageBytes,
          )} B per-image ceiling`,
          details: {
            purpose: selected.purpose,
            byteLength: rendered.byteLength,
            maxImageBytes: this.#policy.image.maxImageBytes,
          },
        };
      }
      images.push(rendered);
    }

    return {
      ok: true,
      record: {
        step: 'render',
        outcome: 'passed',
        rules,
        note: `${String(images.length)} image(s), ${String(masks.length)} mask(s) applied, longest edge ≤ ${String(
          this.#policy.image.fullFrameMaxEdge,
        )} px`,
      },
      images,
    };
  }

  // -------------------------------------------------------------------------
  // Step 6 — enforce active-context image limits
  // -------------------------------------------------------------------------

  #enforceLimits(
    input: ObservationPolicyRequest,
    frames: readonly SelectedFrame[],
    images: readonly RenderedImage[],
  ):
    | {
        readonly ok: true;
        readonly record: PolicyStepRecord;
        readonly plan: ActiveContextPlan;
        readonly totalBytes: number;
      }
    | {
        readonly ok: false;
        readonly record: PolicyStepRecord;
        readonly rule: PolicyRule;
        readonly detail: string;
        readonly details: Readonly<Record<string, unknown>>;
      } {
    const rules: PolicyRule[] = [
      'max-full-frames',
      'max-pointer-crops',
      'max-comparison-frames',
      'observation-bytes',
    ];
    const incoming = countPurposes(frames.map((frame) => frame.purpose));
    const limits: ActiveContextCounts = {
      fullFrames: this.#policy.activeContext.maxFullFrames,
      pointerCrops: this.#policy.activeContext.maxPointerCrops,
      comparisonFrames: this.#policy.activeContext.maxComparisonFrames,
    };

    const overflow: Array<[PolicyRule, keyof ActiveContextCounts, string]> = [
      ['max-full-frames', 'fullFrames', 'full frame'],
      ['max-pointer-crops', 'pointerCrops', 'pointer crop'],
      ['max-comparison-frames', 'comparisonFrames', 'comparison frame'],
    ];
    for (const [rule, key, label] of overflow) {
      if (incoming[key] > limits[key]) {
        const detail = `${String(incoming[key])} ${label}(s) requested, the limit is ${String(limits[key])}`;
        return {
          ok: false,
          record: { step: 'limits', outcome: 'rejected', rules, note: detail },
          rule,
          detail,
          details: { requested: incoming[key], limit: limits[key] },
        };
      }
    }

    const totalBytes = images.reduce((sum, image) => sum + image.byteLength, 0);
    if (totalBytes > this.#policy.image.maxObservationBytes) {
      const detail = `Observation is ${String(totalBytes)} B, past the ${String(
        this.#policy.image.maxObservationBytes,
      )} B ceiling`;
      return {
        ok: false,
        record: { step: 'limits', outcome: 'rejected', rules, note: detail },
        rule: 'observation-bytes',
        detail,
        details: { totalBytes, maxObservationBytes: this.#policy.image.maxObservationBytes },
      };
    }

    // §11: active context holds the *latest* relevant frame, so an incoming
    // image replaces rather than accumulates. The plan says how many of each
    // purpose the caller has to drop to stay inside the limit (PR-022a prunes).
    const existing = input.activeContext ?? {
      fullFrames: 0,
      pointerCrops: 0,
      comparisonFrames: 0,
    };
    const plan: ActiveContextPlan = {
      evictFullFrames: Math.max(0, existing.fullFrames + incoming.fullFrames - limits.fullFrames),
      evictPointerCrops: Math.max(
        0,
        existing.pointerCrops + incoming.pointerCrops - limits.pointerCrops,
      ),
      evictComparisonFrames: Math.max(
        0,
        existing.comparisonFrames + incoming.comparisonFrames - limits.comparisonFrames,
      ),
      incoming,
      limits,
    };

    return {
      ok: true,
      record: {
        step: 'limits',
        outcome: 'passed',
        rules,
        note: `${String(incoming.fullFrames)} full / ${String(incoming.pointerCrops)} crop / ${String(
          incoming.comparisonFrames,
        )} comparison, ${String(totalBytes)} B total`,
      },
      plan,
      totalBytes,
    };
  }

  // -------------------------------------------------------------------------
  // Step 7 — return
  // -------------------------------------------------------------------------

  #buildObservation(
    input: ObservationPolicyRequest,
    scene: SceneState,
    window: ObservedWindow,
    selection: { readonly frames: readonly SelectedFrame[]; readonly pointer: PointerAnchor },
    images: readonly RenderedImage[],
  ): ScreenObservation {
    const primary = selection.frames[0];
    const target: AccessibilityNodeSummary | undefined =
      input.pointerTarget === undefined
        ? undefined
        : toSafeTargetSummary(input.pointerTarget, input.state.geometry);
    const observation: ScreenObservation = {
      observationId: this.#ids.observation(),
      sceneId: scene.sceneId,
      sceneRevision: scene.revision,
      capturedAt: toTimestamp(primary?.capturedAt ?? this.#clock.now()),
      windowTitle: window.title,
      pointer: selection.pointer.point,
      ...(target === undefined ? {} : { target }),
      images: images.map(toObservationImage),
    };
    // Parse rather than trust: the observation crosses into the agent runtime,
    // and a shape that drifts from system-design §9 must fail here, loudly.
    return screenObservationSchema.parse(observation);
  }

  // -------------------------------------------------------------------------

  #reject(
    steps: readonly PolicyStepRecord[],
    step: PolicyStep,
    rule: PolicyRule,
    detail: string,
    redaction: RedactionReport | null,
    details?: Readonly<Record<string, unknown>>,
  ): PolicyDecision {
    const info = POLICY_RULE_TABLE[rule];
    const error = new PilotError(info.code, `Screen policy [${rule}]: ${detail}`, {
      userMessage: info.userMessage,
      retryable: info.retryable,
      details: { policyRule: rule, policyStep: step, ...(details ?? {}) },
    });
    this.#logger.debug('observation rejected by policy', {
      rule,
      step,
      code: info.code,
    });
    return { allowed: false, rule, step, detail, error, steps: [...steps], redaction };
  }
}

/**
 * Kept as a function so TypeScript cannot narrow one abort check into making
 * the next one unreachable: a signal fires between steps, which is the entire
 * point of checking more than once.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

interface PointerAnchor {
  readonly known: boolean;
  readonly point: NormalizedPoint;
  readonly insideWindow: boolean;
  readonly reason: string | null;
  readonly detail: string;
}
