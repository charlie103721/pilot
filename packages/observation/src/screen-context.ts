import {
  isInsideWindow,
  nullLogger,
  type PilotError,
  screenStatusSchema,
  toPilotError,
  type AccessibilityNode,
  type CapturedFrame,
  type IdFactory,
  type Logger,
  type ObservationId,
  type ObserveScreenRequest,
  type PermissionState,
  type SceneId,
  type SceneState,
  type ScreenObservation,
  type ScreenStatus,
  type SerializedPilotError,
} from '@pilot/shared';
import type { ObservationAdapter, ScreenContextService } from '@pilot/platform';
import { toTimestamp, type Clock } from './clock.js';
import { toScreenStatusBuffer } from './frame-ring.js';
import type { ImageProcessor, ObservationImagePurpose } from './image-pipeline.js';
import { PilotImageProcessor } from './image-processor.js';
import type { ObservationCore } from './observation-core.js';
import { ObservationRateLimiter } from './observation-rate.js';
import type { ObservationSession } from './observation-session.js';
import {
  countPurposes,
  plannedPurposes,
  policyRuleError,
  ScreenPolicyEnforcer,
  type ActiveContextCounts,
  type ActiveContextPlan,
  type CaptureSource,
  type ObservationPolicyRequest,
  type ObservationRuntimeState,
  type ObservationSource,
  type PolicyDecision,
  type PolicyRule,
  type PolicyStep,
  type SelectedFrame,
  UNKNOWN_OBSERVATION_POINTER,
} from './policy-enforcer.js';
import type { QuestionAnchor } from './question-anchor.js';
import { RetentionGuard, type ImageCache, type RetentionEvent } from './retention.js';
import type { SceneChangeKind } from './scene-tracker.js';
import type { SceneLineageStatus, SceneRef } from './scene-lineage.js';
import {
  DEFAULT_SCREEN_CONTEXT_POLICY,
  SCREEN_REDACTION_CAVEAT,
  type ScreenContextPolicy,
} from './screen-policy.js';
import type { RedactionReport, SecureRegion } from './secure-content.js';

/**
 * `ScreenContextService` — the observation lane's one public face
 * (system-design §5, §9, §10; PR-019).
 *
 * Everything this file needs already exists. PR-016 owns the buffers, the scene
 * lineage and the question anchor; PR-017 owns the §10 execution order and its
 * rule table; PR-018 owns the pixels. This is the assembly, and the assembly is
 * the point: `packages/agent`'s `observe_screen` tool holds a
 * `ScreenContextService` and nothing else, so the three-word interface in §5 is
 * the entire surface the agent runtime may reach screen state through.
 *
 * What the facade decides, rather than delegates:
 *
 * - **Which moment.** `question` is the frame nearest the utterance anchor
 *   (PR-016's {@link QuestionAnchor}), `current` is a fresh capture taken at
 *   tool-execution time through the `ObservationAdapter`, and
 *   `before-and-after` is bounded around the scene transition the facade finds
 *   in the lineage — §9 says "two bounded frames around a relevant scene
 *   transition" and someone has to choose which transition and which bounds.
 *   See {@link ScreenContextService.observe} and `#comparisonPlan`.
 * - **Whether the scene is still answerable.** One `core.checkScene(ref)` call,
 *   through the enforcer's step 3, refuses `superseded`, `unknown` and
 *   `future-revision` references. A held scene reference is the only way a
 *   caller can ask about a window Pilot has stopped watching, so it is checked
 *   rather than trusted.
 * - **What the runtime state is.** The enforcer takes
 *   {@link ObservationRuntimeState} as data; the facade assembles it from the
 *   session's live selection plus the {@link ScreenContextConditions} the app
 *   supplies (pause, permissions, capture source).
 *
 * What it deliberately does *not* decide: every refusal is one of PR-017's
 * rules, carrying that rule's typed `PilotError` — see
 * {@link POLICY_RULE_TABLE}. No new error code is invented here, because
 * PR-021 already maps that table onto model-readable failures, and a code it
 * has never seen would surface to the model as an unclassified error.
 *
 * ### Clock discipline
 *
 * Nothing here reads `Date.now()`. "Now" is `clock.now()`, the utterance anchor
 * arrives on the {@link ScreenContextAnchor}, and every timestamp on the
 * returned metadata is derived from those two.
 */

// ---------------------------------------------------------------------------
// Inputs the facade cannot read for itself
// ---------------------------------------------------------------------------

/**
 * Live conditions §10 step 1 validates that the observation session does not
 * own: it knows which window is selected and whether capture is running, but
 * not whether the user has paused Pilot, what the TCC permission states are, or
 * whether the platform widened capture beyond the selected window.
 */
export interface ScreenContextConditions {
  /**
   * Whether observation is switched on. Defaults to "the session is
   * observing", which is what the session itself can answer.
   */
  readonly enabled?: boolean;
  /** Defaults to `false`: the session has no notion of a user-facing pause. */
  readonly paused?: boolean;
  /** Defaults to "the session is suspended", which a lock is one cause of. */
  readonly screenLocked?: boolean;
  /**
   * TCC states from `PermissionAdapter` (PR-011).
   *
   * **Defaults to `'unknown'`, which the policy refuses.** An unwired facade
   * must not assume a grant it has never seen: the failure mode of guessing
   * `'granted'` is an observation that proceeds on a denied permission, and
   * the failure mode of guessing `'unknown'` is a loud, typed
   * `permission-denied` that names the missing wiring.
   */
  readonly permissions?: {
    readonly screenRecording: PermissionState;
    readonly accessibility: PermissionState;
  };
  /**
   * Where the frames came from. Defaults to `'selected-window'` — the facade
   * only ever reads the session's own ring, which refuses foreign frames at
   * ingest, and the adapter's `captureFresh`, whose result is checked against
   * the selected window's id in step 3. A caller that learns the platform
   * widened must say so here, and the observation is refused (§9/§14).
   */
  readonly captureSource?: CaptureSource;
}

/**
 * What the pending question was anchored to (system-design §6).
 *
 * Built from PR-016's {@link QuestionAnchor} by {@link screenContextAnchor}.
 * Absent, `moment: 'question'` anchors on "now", which is the right answer for
 * a model-initiated observation with no utterance behind it.
 */
export interface ScreenContextAnchor {
  /** The utterance anchor — the moment `question` selects around. */
  readonly at: number;
  /** Scene the question was anchored to. Validated through `checkScene`. */
  readonly scene?: SceneRef;
  /** Accessibility element under the grounded pointer (PR-013). */
  readonly target?: AccessibilityNode;
  /** Further secure regions found by an accessibility scan (PR-013). */
  readonly secureRegions?: readonly SecureRegion[];
}

/**
 * Projects PR-016's question anchor onto the facade's input.
 *
 * The anchor's own `target` is a `GroundedPointer` summary with the secure
 * value already dropped, which is deliberately *not* an `AccessibilityNode`:
 * the redaction rule needs `isSecure` and screen-point `bounds`, and neither
 * survives that projection. So the platform's node is passed separately, by the
 * caller that read it (PR-013's `elementAt`).
 */
export function screenContextAnchor(
  anchor: QuestionAnchor,
  target?: AccessibilityNode,
  secureRegions?: readonly SecureRegion[],
): ScreenContextAnchor {
  return {
    at: anchor.at,
    scene: { sceneId: anchor.sceneId, revision: anchor.sceneRevision },
    ...(target === undefined ? {} : { target }),
    ...(secureRegions === undefined ? {} : { secureRegions }),
  };
}

/**
 * The three things the facade has to be told rather than able to read. One
 * port, so a caller wires one object; {@link MutableScreenContextInputs} is the
 * default implementation and is enough for the app.
 */
export interface ScreenContextInputs {
  conditions(): ScreenContextConditions;
  /** The pending question anchor, or `null` for a model-initiated look. */
  anchor(): ScreenContextAnchor | null;
  /** Images already in the model's active context, for the eviction plan. */
  activeContext(): ActiveContextCounts;
}

export const NO_ACTIVE_CONTEXT_IMAGES: ActiveContextCounts = Object.freeze({
  fullFrames: 0,
  pointerCrops: 0,
  comparisonFrames: 0,
});

/** Plain mutable {@link ScreenContextInputs}; the app writes, the facade reads. */
export class MutableScreenContextInputs implements ScreenContextInputs {
  #conditions: ScreenContextConditions;
  #anchor: ScreenContextAnchor | null = null;
  #activeContext: ActiveContextCounts = NO_ACTIVE_CONTEXT_IMAGES;

  constructor(conditions: ScreenContextConditions = {}) {
    this.#conditions = conditions;
  }

  conditions(): ScreenContextConditions {
    return this.#conditions;
  }

  setConditions(conditions: ScreenContextConditions): void {
    this.#conditions = conditions;
  }

  anchor(): ScreenContextAnchor | null {
    return this.#anchor;
  }

  /** Called when an utterance ends; cleared when the question is answered. */
  setAnchor(anchor: ScreenContextAnchor | null): void {
    this.#anchor = anchor;
  }

  activeContext(): ActiveContextCounts {
    return this.#activeContext;
  }

  setActiveContext(counts: ActiveContextCounts): void {
    this.#activeContext = counts;
  }
}

// ---------------------------------------------------------------------------
// Compact metadata
// ---------------------------------------------------------------------------

/** One image of an observation, described without a byte of its payload. */
export interface ObservationImageMetadata {
  readonly purpose: ObservationImagePurpose;
  readonly mimeType: 'image/jpeg' | 'image/png';
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly redactionsApplied: number;
}

/** One frame the policy selected, described without a byte of its payload. */
export interface ObservationFrameMetadata {
  readonly purpose: ObservationImagePurpose;
  readonly origin: 'ring' | 'fresh';
  readonly capturedAt: number;
  /** Distance from the moment that was asked for; `null` for a fresh capture. */
  readonly skewMs: number | null;
  /** Age at the moment the observation was taken. */
  readonly ageMs: number;
}

/**
 * Which transition a `before-and-after` observation was bounded around, and
 * how. `null` for every other moment, and for a `before-and-after` that found
 * no transition and fell back to the whole local buffer.
 */
export interface ComparisonMetadata {
  readonly sceneRevision: number;
  readonly at: number;
  readonly changes: readonly SceneChangeKind[];
  readonly from: number;
  readonly to: number;
  /** The `after` frame is restricted to this revision or later. */
  readonly minSceneRevision: number;
}

/**
 * Compact, content-free metadata about one observation.
 *
 * `ScreenObservation` is a strict schema owned by system-design §9 and this
 * facade does not widen it — PR-021 parses it, PR-022a prunes it, and an extra
 * field would be a contract change to two other lanes. Everything a caller
 * needs *about* the observation rather than *in* it lives here instead: what
 * was selected and why, what the images cost, what redaction did and did not
 * promise, and the eviction plan PR-022a applies. Nothing here is derived from
 * screen content, so it is safe to log and safe to show in the diagnostics
 * panel.
 */
export interface ScreenObservationMetadata {
  readonly observationId: ObservationId;
  readonly view: ObserveScreenRequest['view'];
  readonly moment: ObserveScreenRequest['moment'];
  readonly sceneId: SceneId;
  readonly sceneRevision: number;
  /** Lineage verdict on the *requested* scene; `null` when none was named. */
  readonly requestedSceneStatus: SceneLineageStatus | null;
  /** How many revisions the request was behind, when it named a scene. */
  readonly revisionsBehind: number | null;
  readonly windowTitle: string;
  /** `clock.now()` at the start of the call. */
  readonly requestedAt: number;
  /** The utterance anchor the selection used. */
  readonly questionAt: number;
  readonly capturedAt: number;
  readonly pointerKnown: boolean;
  readonly pointerInsideWindow: boolean;
  readonly targetRole: string | null;
  readonly frames: readonly ObservationFrameMetadata[];
  readonly images: readonly ObservationImageMetadata[];
  readonly totalImageBytes: number;
  readonly comparison: ComparisonMetadata | null;
  readonly redaction: RedactionReport;
  /** What PR-022a must drop to stay inside the §10/§11 active-context limits. */
  readonly activeContext: ActiveContextPlan;
  /** True when the decoded-frame cache answered at least one render. */
  readonly imageCacheHits: number;
  /** §14, verbatim. Carried whether or not anything was masked. */
  readonly caveat: string;
}

/** `observe()` plus everything about it the strict §9 shape cannot carry. */
export interface ScreenObservationResult {
  readonly observation: ScreenObservation;
  readonly metadata: ScreenObservationMetadata;
  readonly decision: Extract<PolicyDecision, { allowed: true }>;
}

/** A refusal, in the same shape the diagnostics panel shows a success in. */
export interface ScreenObservationRefusal {
  readonly view: ObserveScreenRequest['view'];
  readonly moment: ObserveScreenRequest['moment'];
  readonly rule: PolicyRule;
  readonly step: PolicyStep;
  readonly detail: string;
  readonly error: SerializedPilotError;
  readonly requestedAt: number;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** An `ImageProcessor` that may also hold a droppable decoded-frame cache. */
export type CacheableImageProcessor = ImageProcessor & Partial<ImageCache>;

export interface ScreenContextServiceOptions {
  readonly clock: Clock;
  /** Owns the selection, the buffers and the scene lineage (PR-016). */
  readonly session: ObservationSession;
  /**
   * Fresh capture for `moment: 'current'`. Either an `ObservationAdapter` or a
   * bare function; absent, `current` is refused by `frame-available` with an
   * explicit "no fresh capture source is wired" rather than silently degrading
   * to a buffered frame, which would answer a different question.
   */
  readonly capture?: ObservationAdapter | ((signal?: AbortSignal) => Promise<CapturedFrame>);
  /** Defaults to a new {@link PilotImageProcessor} (PR-018). */
  readonly images?: CacheableImageProcessor;
  readonly policy?: ScreenContextPolicy;
  /** Supply one to share a rate limiter or an id factory; otherwise built here. */
  readonly enforcer?: ScreenPolicyEnforcer;
  readonly rateLimiter?: ObservationRateLimiter;
  /** Supply one to share it with the app's lifecycle handling (PR-028). */
  readonly retention?: RetentionGuard;
  readonly ids?: IdFactory;
  readonly logger?: Logger;
  readonly inputs?: ScreenContextInputs;
  /** Diagnostics. Never receives image bytes. */
  readonly onObservation?: (metadata: ScreenObservationMetadata) => void;
  /** Diagnostics. Fires for every refusal, with the rule that fired. */
  readonly onRefusal?: (refusal: ScreenObservationRefusal) => void;
}

/**
 * The `ScreenContextService` of system-design §5.
 *
 * `observe()` returns the enforcer's already-schema-validated observation or
 * throws its typed error; `clear()` is a {@link RetentionGuard} clear; and
 * `status()` is the core's own snapshot projected onto the §5 shape.
 */
export class PilotScreenContextService implements ScreenContextService {
  readonly #clock: Clock;
  readonly #session: ObservationSession;
  readonly #core: ObservationCore;
  readonly #policy: ScreenContextPolicy;
  readonly #images: CacheableImageProcessor;
  readonly #enforcer: ScreenPolicyEnforcer;
  readonly #retention: RetentionGuard;
  readonly #logger: Logger;
  readonly #inputs: ScreenContextInputs;
  readonly #captureFresh: ((signal?: AbortSignal) => Promise<CapturedFrame>) | null;
  readonly #onObservation: ((metadata: ScreenObservationMetadata) => void) | null;
  readonly #onRefusal: ((refusal: ScreenObservationRefusal) => void) | null;

  #lastError: PilotError | null = null;
  #lastObservation: ScreenObservationMetadata | null = null;
  /** Scene the decoded-frame cache last held pixels for; see `#syncImageCache`. */
  #cachedScene: SceneId | null = null;
  #observations = 0;
  #refusals = 0;

  constructor(options: ScreenContextServiceOptions) {
    this.#clock = options.clock;
    this.#session = options.session;
    this.#core = options.session.core;
    this.#policy = options.policy ?? options.session.policy ?? DEFAULT_SCREEN_CONTEXT_POLICY;
    this.#images = options.images ?? new PilotImageProcessor();
    this.#logger = options.logger ?? nullLogger;
    this.#inputs = options.inputs ?? new MutableScreenContextInputs();

    const rateLimiter =
      options.rateLimiter ??
      options.enforcer?.rateLimiter ??
      new ObservationRateLimiter({ clock: options.clock, policy: this.#policy });
    this.#enforcer =
      options.enforcer ??
      new ScreenPolicyEnforcer({
        clock: options.clock,
        policy: this.#policy,
        images: this.#images,
        rateLimiter,
        ...(options.ids === undefined ? {} : { ids: options.ids }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
    this.#retention =
      options.retention ??
      new RetentionGuard({
        core: this.#core,
        policy: this.#policy,
        rateLimiter,
        // Runbook follow-up 16: the decoded-frame cache is a screenshot and
        // goes when the ring goes.
        ...(typeof this.#images.clear === 'function' ? { images: this.#images as ImageCache } : {}),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });

    const capture = options.capture;
    this.#captureFresh =
      capture === undefined
        ? null
        : typeof capture === 'function'
          ? capture
          : (signal?: AbortSignal) => capture.captureFresh(signal);
    this.#onObservation = options.onObservation ?? null;
    this.#onRefusal = options.onRefusal ?? null;
  }

  get policy(): ScreenContextPolicy {
    return this.#policy;
  }

  get enforcer(): ScreenPolicyEnforcer {
    return this.#enforcer;
  }

  /** Shared with the app so a lifecycle event and an observation agree. */
  get retention(): RetentionGuard {
    return this.#retention;
  }

  get inputs(): ScreenContextInputs {
    return this.#inputs;
  }

  /** Compact metadata for the most recent allowed observation. */
  get lastObservation(): ScreenObservationMetadata | null {
    return this.#lastObservation;
  }

  get metrics(): { readonly observations: number; readonly refusals: number } {
    return { observations: this.#observations, refusals: this.#refusals };
  }

  // -------------------------------------------------------------------------
  // §5 — status
  // -------------------------------------------------------------------------

  status(): ScreenStatus {
    const state = this.#runtimeState();
    const core = this.#core.status();
    // Parsed rather than assembled and trusted: `status()` crosses into the
    // agent runtime and the desktop IPC, both of which validate it.
    return screenStatusSchema.parse({
      enabled: state.enabled,
      paused: state.paused,
      selectedWindow: state.selectedWindow,
      scene: state.scene,
      permissions: state.permissions,
      buffer: toScreenStatusBuffer(core.buffer),
      lastError: this.#lastError === null ? null : this.#lastError.toJSON(),
    } satisfies ScreenStatus);
  }

  // -------------------------------------------------------------------------
  // §5 — observe
  // -------------------------------------------------------------------------

  async observe(request: ObserveScreenRequest, signal?: AbortSignal): Promise<ScreenObservation> {
    return (await this.observeDetailed(request, signal)).observation;
  }

  /**
   * `observe()` with the compact metadata attached.
   *
   * The §5 interface returns a bare `ScreenObservation`, which is right for the
   * tool — it may not see anything the model may not. Everything else in the
   * app wants the frame provenance, the byte totals and the eviction plan, and
   * this is where they come from without widening §9's schema.
   */
  async observeDetailed(
    request: ObserveScreenRequest,
    signal?: AbortSignal,
  ): Promise<ScreenObservationResult> {
    const requestedAt = toTimestamp(this.#clock.now());

    // Before anything else, and before the rate limiter takes a slot: a call
    // that was already cancelled must not cost the next one its budget.
    if (signal?.aborted === true) {
      throw this.#refuse(request, {
        rule: 'request-cancelled',
        step: 'validate',
        detail: 'The observation was cancelled before it started',
        requestedAt,
      });
    }

    const state = this.#runtimeState();
    const anchor = this.#inputs.anchor();
    const questionAt = toTimestamp(anchor?.at ?? requestedAt);
    const scene = state.scene;

    // A clear that did not go through the retention guard — the session tears
    // the core down directly on window loss and screen lock — must not leave a
    // decoded frame behind. Noticing at the next observation is the backstop;
    // `clear()` and the guard are the front door.
    this.#syncImageCache(scene?.sceneId ?? null);

    const comparison =
      request.moment === 'before-and-after' && scene !== null
        ? this.#comparisonPlan(scene, questionAt)
        : null;

    const decision = await this.#enforcer.evaluate({
      request,
      at: requestedAt,
      questionAt,
      state,
      source: this.#source(request, comparison?.minSceneRevision ?? null),
      ...(comparison === null
        ? {}
        : { comparisonWindow: { from: comparison.from, to: comparison.to } }),
      ...(anchor?.scene === undefined ? {} : { requestedScene: anchor.scene }),
      ...(anchor?.target === undefined ? {} : { pointerTarget: anchor.target }),
      ...(anchor?.secureRegions === undefined ? {} : { secureRegions: anchor.secureRegions }),
      activeContext: this.#inputs.activeContext(),
      ...(signal === undefined ? {} : { signal }),
    } satisfies ObservationPolicyRequest);

    if (!decision.allowed) {
      this.#refusals += 1;
      this.#lastError = decision.error;
      const refusal: ScreenObservationRefusal = {
        view: request.view,
        moment: request.moment,
        rule: decision.rule,
        step: decision.step,
        detail: decision.detail,
        error: decision.error.toJSON(),
        requestedAt,
      };
      this.#onRefusal?.(refusal);
      this.#logger.debug('observation refused', {
        rule: decision.rule,
        step: decision.step,
        code: decision.error.code,
      });
      throw decision.error;
    }

    // The lineage now knows the model has seen this revision, which is what
    // lets a later `stale-revision` verdict mean "the screen moved since you
    // looked" rather than "you have never looked".
    this.#core.markObserved(decision.observation.sceneRevision);

    const metadata = this.#describe(request, requestedAt, questionAt, decision, comparison, anchor);
    this.#observations += 1;
    this.#lastError = null;
    this.#lastObservation = metadata;
    this.#cachedScene = decision.observation.sceneId;
    this.#onObservation?.(metadata);

    return { observation: decision.observation, metadata, decision };
  }

  // -------------------------------------------------------------------------
  // §5 — clear
  // -------------------------------------------------------------------------

  /**
   * Drops every buffer and every decoded frame, through the retention guard.
   *
   * §5 types this as `clear(): void`; the optional event is additive and
   * source-compatible, so a `ScreenContextService`-typed reference still calls
   * it with no arguments. The default is `'pause'` because that is the occasion
   * §10 names first ("cleared on pause or lock") and it is non-terminal: the
   * scene lineage survives, so a result that lands after the clear is refused
   * as `superseded` rather than silently unknown. Pass `'shutdown'` or
   * `'logout'` to drop the lineage as well.
   */
  clear(event: RetentionEvent = 'pause'): void {
    this.#retention.clearFor(event);
    // Belt and braces: the guard clears the cache when one was wired into it,
    // and this covers a caller that supplied its own guard without one.
    this.#images.clear?.();
    this.#cachedScene = null;
  }

  // -------------------------------------------------------------------------
  // Assembly
  // -------------------------------------------------------------------------

  /** §10 step 1's inputs: the session's live selection plus what it cannot know. */
  #runtimeState(): ObservationRuntimeState {
    const conditions = this.#inputs.conditions();
    const status = this.#session.status();
    return {
      enabled: conditions.enabled ?? status.state === 'observing',
      paused: conditions.paused ?? false,
      screenLocked: conditions.screenLocked ?? status.state === 'suspended',
      permissions: {
        screenRecording: conditions.permissions?.screenRecording ?? 'unknown',
        accessibility: conditions.permissions?.accessibility ?? 'unknown',
      },
      selectedWindow: status.window,
      geometry: status.geometry,
      scene: status.scene,
      captureSource: conditions.captureSource ?? 'selected-window',
    };
  }

  /**
   * The buffers, as the enforcer reads them.
   *
   * `ObservationCore` already satisfies {@link ObservationSource} structurally.
   * Two things are added around it:
   *
   * - `captureFresh`, from the `ObservationAdapter`, wrapped so an abort raised
   *   *while the platform is capturing* is honoured even by an adapter that
   *   ignores its signal;
   * - `minSceneRevision` on the `after` half of a comparison, so the second
   *   frame of a `before-and-after` is provably from after the transition
   *   rather than merely later in time.
   */
  #source(request: ObserveScreenRequest, minSceneRevision: number | null): ObservationSource {
    const core = this.#core;
    const captureFresh = this.#captureFresh;
    const bound = request.moment === 'before-and-after' ? minSceneRevision : null;
    return {
      selectFrame: (requestedAt, query) =>
        core.selectFrame(requestedAt, {
          ...query,
          // The enforcer selects `after` with `at-or-before` and `before` with
          // `at-or-after`; only the former may be restricted, or the `before`
          // frame would be post-transition too and there would be nothing to
          // compare.
          ...(bound !== null && query?.direction === 'at-or-before'
            ? { minSceneRevision: bound }
            : {}),
        }),
      selectPointer: (requestedAt, query) => core.selectPointer(requestedAt, query),
      checkScene: (ref) => core.checkScene(ref),
      ...(captureFresh === null
        ? {}
        : { captureFresh: (signal?: AbortSignal) => captureWithAbort(captureFresh, signal) }),
    };
  }

  /**
   * Bounds a `before-and-after` around the last relevant scene transition
   * (system-design §9).
   *
   * The tool input carries no timestamps, so the facade chooses them. It takes
   * the most recent revision at or before the anchor that actually changed
   * something, finds the last frame captured before it, and asks for:
   *
   *     from = that frame's own timestamp      → the `before` image
   *     to   = the anchor                      → the `after` image
   *     minSceneRevision = the transition      → the `after` image is post-change
   *
   * The time bound alone would not be enough: frames arrive at 2–3 FPS and a
   * transition lands between two of them, so "later than the transition" and
   * "captured after the transition" are different claims. The revision bound is
   * the one that is true.
   *
   * With no transition in the retained lineage there is nothing to be "around",
   * and the enforcer's own default — the whole local buffer up to the anchor —
   * is used instead. That either finds two frames or refuses with
   * `comparison-frames-available`; it never invents a comparison.
   */
  #comparisonPlan(scene: SceneState, anchorAt: number): ComparisonMetadata | null {
    const episode = this.#core.lineage.get(scene.sceneId);
    if (episode === null) {
      return null;
    }
    let transition: (typeof episode.revisions)[number] | null = null;
    for (const revision of episode.revisions) {
      if (revision.changes.length > 0 && revision.at <= anchorAt) {
        transition = revision;
      }
    }
    if (transition === null) {
      return null;
    }
    const before = this.#core.selectFrame(transition.at - 1, {
      direction: 'at-or-before',
      scene: scene.sceneId,
      maxSkewMs: Number.POSITIVE_INFINITY,
    });
    if (!before.found) {
      // Nothing was captured before the transition, so there is no "before".
      return null;
    }
    const after = this.#core.selectFrame(anchorAt, {
      direction: 'at-or-before',
      scene: scene.sceneId,
      minSceneRevision: transition.revision,
      maxSkewMs: Number.POSITIVE_INFINITY,
    });
    if (!after.found || after.record.frame.frameId === before.record.frame.frameId) {
      // The transition is real but nothing was captured after it, so this plan
      // would refuse an observation the default window can still answer.
      return null;
    }
    return {
      sceneRevision: transition.revision,
      at: transition.at,
      changes: transition.changes,
      from: before.record.frame.capturedAt,
      to: anchorAt,
      minSceneRevision: transition.revision,
    };
  }

  /**
   * Drops the decoded-frame cache when the scene it belongs to is gone.
   *
   * `ObservationSession` clears the core directly on window loss and screen
   * lock, which does not pass through the retention guard, so the guard alone
   * cannot see those. This does, at the only moment that matters — before the
   * next render could be served from a frame belonging to a window the user is
   * no longer looking at.
   */
  #syncImageCache(sceneId: SceneId | null): void {
    if (this.#cachedScene !== null && this.#cachedScene !== sceneId) {
      this.#images.clear?.();
    }
    this.#cachedScene = sceneId;
  }

  #describe(
    request: ObserveScreenRequest,
    requestedAt: number,
    questionAt: number,
    decision: Extract<PolicyDecision, { allowed: true }>,
    comparison: ComparisonMetadata | null,
    anchor: ScreenContextAnchor | null,
  ): ScreenObservationMetadata {
    const observation = decision.observation;
    const lineage = anchor?.scene === undefined ? null : this.#core.checkScene(anchor.scene);
    // Two different questions, and conflating them would be a lie: a pointer
    // can be known and outside the window. "Unknown" is the sentinel §8/§9
    // carry for it (PR-024's `UNKNOWN_NORMALIZED_POINT`, deliberately outside
    // `[0,1]`), never a coordinate the model could mistake for a position.
    const pointerKnown =
      observation.pointer.x !== UNKNOWN_OBSERVATION_POINTER.x ||
      observation.pointer.y !== UNKNOWN_OBSERVATION_POINTER.y;
    return {
      observationId: observation.observationId,
      view: request.view,
      moment: request.moment,
      sceneId: observation.sceneId,
      sceneRevision: observation.sceneRevision,
      requestedSceneStatus: lineage === null ? null : lineage.status,
      revisionsBehind: lineage !== null && lineage.ok ? lineage.revisionsBehind : null,
      windowTitle: observation.windowTitle,
      requestedAt,
      questionAt,
      capturedAt: observation.capturedAt,
      pointerKnown,
      pointerInsideWindow: pointerKnown && isInsideWindow(observation.pointer),
      targetRole: observation.target?.role ?? null,
      frames: decision.frames.map((frame) => toFrameMetadata(frame, requestedAt)),
      images: decision.images.map((image) => ({
        purpose: image.purpose,
        mimeType: image.mimeType,
        byteLength: image.byteLength,
        width: image.size.width,
        height: image.size.height,
        redactionsApplied: image.redactionsApplied,
      })),
      totalImageBytes: decision.totalImageBytes,
      comparison,
      redaction: decision.redaction,
      activeContext: decision.activeContext,
      imageCacheHits: decision.images.filter((image) => image.stats?.decodeCacheHit === true)
        .length,
      caveat: SCREEN_REDACTION_CAVEAT,
    };
  }

  #refuse(
    request: ObserveScreenRequest,
    refusal: {
      readonly rule: PolicyRule;
      readonly step: PolicyStep;
      readonly detail: string;
      readonly requestedAt: number;
    },
  ): PilotError {
    const error = policyRuleError(refusal.rule, refusal.detail, undefined, refusal.step);
    this.#refusals += 1;
    this.#lastError = error;
    this.#onRefusal?.({
      view: request.view,
      moment: request.moment,
      rule: refusal.rule,
      step: refusal.step,
      detail: refusal.detail,
      error: error.toJSON(),
      requestedAt: refusal.requestedAt,
    });
    return error;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toFrameMetadata(frame: SelectedFrame, requestedAt: number): ObservationFrameMetadata {
  return {
    purpose: frame.purpose,
    origin: frame.origin,
    capturedAt: frame.capturedAt,
    skewMs: frame.skewMs,
    ageMs: Math.max(0, requestedAt - frame.capturedAt),
  };
}

/**
 * Races a platform capture against its abort signal.
 *
 * `ObservationAdapter.captureFresh` takes the signal, and the Mac adapter
 * honours it — but §15 says the agent's abort must stop the observation, not
 * that every adapter is well behaved. A capture that ignores its signal would
 * otherwise hold the tool call open for as long as the platform takes, after
 * the run it belongs to has already been torn down. This turns that into a
 * prompt, typed `cancelled` refusal; the adapter's promise is left to settle on
 * its own and its result is discarded rather than entering the ring.
 */
async function captureWithAbort(
  capture: (signal?: AbortSignal) => Promise<CapturedFrame>,
  signal?: AbortSignal,
): Promise<CapturedFrame> {
  const cancelled = (): PilotError =>
    policyRuleError('request-cancelled', 'The fresh capture was cancelled', {
      phase: 'capture-fresh',
    });
  if (signal?.aborted === true) {
    throw cancelled();
  }
  const started = (async () => {
    try {
      return await capture(signal);
    } catch (error) {
      throw toPilotError(error, 'capture-failed');
    }
  })();
  if (signal === undefined) {
    return started;
  }
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      started,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(cancelled());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
    // A capture that lands after the abort is dropped on the floor rather than
    // left as an unhandled rejection.
    void started.catch(() => undefined);
  }
}

/**
 * The purposes a request will produce, before any frame is chosen (§9).
 *
 * Re-exported from the enforcer through the facade because the desktop panel
 * and the agent runtime both want to say "this will fetch a full frame and a
 * pointer crop" *before* the call, and neither should have to reach past
 * `ScreenContextService` into the policy module to find out.
 */
export function plannedObservationImages(request: ObserveScreenRequest): {
  readonly purposes: readonly ObservationImagePurpose[];
  readonly counts: ActiveContextCounts;
} {
  const purposes = plannedPurposes(request);
  return { purposes, counts: countPurposes(purposes) };
}
