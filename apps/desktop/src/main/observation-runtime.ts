import {
  isAttributionFailure,
  nullLogger,
  toPilotError,
  type Logger,
  type ObservationId,
  type ObservedWindow,
  type ObserveScreenRequest,
  type PermissionAttribution,
  type PermissionSnapshot,
  type PermissionState,
  type PilotErrorCode,
  type ScreenStatus,
  type WindowGeometry,
} from '@pilot/shared';
import type {
  AccessibilityAdapter,
  AccessibilityGroundingTarget,
  ObservationAdapter,
  ObservationEvent,
  PermissionAdapter,
  PilotViewState,
  PointerGroundingSample,
  Unsubscribe,
  WindowAdapter,
} from '@pilot/platform';
import {
  ObservationCore,
  ObservationSession,
  PilotScreenContextService,
  MutableScreenContextInputs,
  systemClock,
  type Clock,
  type RetentionEvent,
  type ScreenContextConditions,
  type ScreenObservationMetadata,
  type ScreenObservationRefusal,
  type ScreenContextPolicy,
  type RetentionGuard,
} from '@pilot/observation';
import { macWindowNumber, Poller } from '@pilot/platform-mac';
import type { ObservationControlPort } from '@pilot/interaction';
import type { TelemetryMetric } from '../ipc/schemas.js';
import { toObservationFailureError } from './observation-failure.js';
import { PointerTargetLog } from './question-anchor.js';
import type { WindowFeedEvent } from './window-gate.js';

/**
 * The observation boundary, assembled (PR-028).
 *
 * This is the one fake boundary PR-028 replaces. Before it,
 * `createInteractionRuntime` defaulted to `createMockObservationControlPort`,
 * which *recorded* the four lifecycle calls and captured nothing — so "Look now
 * completed" meant the machine's path ran, never that a screen was read. After
 * it, the same four calls reach a real `ObservationAdapter`, a real
 * `ObservationCore` ring and PR-019's real `PilotScreenContextService`.
 *
 * The path, end to end:
 *
 * ```text
 *   window picker (WindowGate)
 *     → select-window                         @pilot/interaction transition table
 *       → start-capture                       ObservationControlPort.start
 *         → ObservationSession.start          @pilot/observation
 *           → ObservationAdapter.start        MacObservationAdapter → helper
 *             → frames                        → ObservationCore ring
 *   look-now / observe_screen
 *     → request-observation                   ObservationControlPort.observe
 *       → PilotScreenContextService.observe   §10 seven-step policy
 *         → ScreenObservationMetadata         → diagnostics (timings and counts)
 *   pause / lock / window loss / stop
 *     → stop-capture + clear-buffers          ObservationControlPort.stop/clear
 *       → RetentionGuard.clearFor             ring + pointer + decoded frame
 * ```
 *
 * Three recorded cross-lane follow-ups are closed here, and each is silently
 * wrong if it is skipped:
 *
 *  1. **Real permission states reach the facade** (follow-up 16).
 *     `ScreenContextConditions.permissions` defaults to `'unknown'`, which §10
 *     step 1 refuses with `permission-denied` — deliberately, so an unwired
 *     facade fails loudly. {@link observationPermissionConditions} feeds it from
 *     `PermissionAdapter.snapshot()` **and** PR-011's attribution verdict,
 *     because "macOS says granted" and "the grant reaches this process" are
 *     different claims and only the second one entitles Pilot to look.
 *  2. **Lifecycle goes through the retention guard** (follow-up 17).
 *     `ObservationSession.#teardown` clears the core directly on window loss and
 *     screen lock; that empties the ring but does not reset the rate limiter and
 *     does not drop `PilotImageProcessor`'s decoded frame — a screenshot, in the
 *     plainest form. Every lifecycle path here ends in
 *     {@link RetentionGuard.clearFor}, which does all three and then asserts the
 *     buffers are empty rather than assuming it.
 *  3. **Capture hands over `png`, not `jpeg`** (follow-up 18). Set at the
 *     composition root — see `CAPTURE_ENCODING` in `main/platform-runtime.ts`.
 *
 * ## The question anchor (PR-031)
 *
 * `ScreenContextInputs.anchor` was the last unwired input on this side, and
 * PR-031 sets it — from `main/question-anchor.ts`, at submission, over this
 * runtime's own `core`, `inputs` and {@link ObservationRuntime.targets}. Two
 * halves of that live here, because this is where the pointer is sampled:
 *
 *  - {@link PointerTargetLog} is written by {@link samplePointer}, and **only**
 *    for a sample inside the selected window. It holds the platform's own
 *    `AccessibilityNode` because §10's redaction step needs `isSecure` and
 *    screen-point `bounds`, neither of which survives the `GroundedPointer`
 *    summary the timeline keeps.
 *  - It is cleared by the retention guard with the ring: a role and a label
 *    read off a screen are screen content (§13).
 *
 * "Look now" still asks for `moment: 'current'` and `view: 'window'`. That is
 * unchanged on purpose — a manual look is not a question, so there is no
 * utterance to anchor it to, and cropping it around whichever pointer sample
 * happens to be newest would be a picture of wherever the mouse was left.
 */

/**
 * What "Look now" asks for (runbook amendment 1, PR-028's choice, PR-030's
 * wiring). Exported so the demo and the tests name the same request the app
 * makes rather than a plausible-looking copy of it.
 */
export const LOOK_NOW_REQUEST: ObserveScreenRequest = { view: 'window', moment: 'current' };

/** What the runtime reports to the diagnostics ring. Numbers only, by shape. */
export interface ObservationTelemetrySink {
  timing(metric: TelemetryMetric, milliseconds: number): void;
  count(metric: TelemetryMetric, value: number): void;
  failure(code: PilotErrorCode): void;
}

export interface ObservationRuntimeOptions {
  /**
   * `null` in a build with no capture at all (see `main/platform-runtime.ts`).
   * The facade is then wired with no fresh-capture source, and every
   * observation is refused with a typed error that names the missing wiring —
   * never an empty ring that names nothing.
   */
  readonly capture: ObservationAdapter | null;
  readonly windows: WindowAdapter;
  readonly accessibility?: AccessibilityAdapter | null;
  /** PR-011's verdict, read once and re-read after a helper restart. */
  readonly attribution?: PermissionAdapter['attribution'];
  readonly telemetry?: ObservationTelemetrySink;
  readonly clock?: Clock;
  readonly policy?: ScreenContextPolicy;
  readonly logger?: Logger;
  /**
   * Pointer sampling period. Defaults to ~30 Hz (system-design §17). A test
   * passes a long interval and calls {@link ObservationRuntime.samplePointer}
   * itself, so nothing here races wall time.
   */
  readonly pointerSampleIntervalMs?: number;
  /** PR-031. Built here when absent; supply one to share or to bound it. */
  readonly targets?: PointerTargetLog;
}

export interface ObservationRuntimeMetrics {
  readonly starts: number;
  readonly stops: number;
  readonly clears: number;
  readonly observations: number;
  readonly refusals: number;
  readonly framesIngested: number;
  readonly framesRejected: number;
  /**
   * Pointer samples the timeline admitted, on **both** paths (runbook
   * follow-up 31, fixed by PR-036).
   *
   * Until PR-036 this reported `ObservationSession.metrics().pointerSamples`
   * alone, which only the `session.samplePointer()` fallback increments — and
   * the app takes the `groundFast` path, so the number read 0 however many
   * samples had been taken. It cost nothing while nothing consumed it; PR-036's
   * demo does, and a wrong number is worse than a missing one. Both paths are
   * now counted, and {@link ObservationRuntimeMetrics.groundedPointerSamples}
   * says how many came from the one this runtime drives.
   */
  readonly pointerSamples: number;
  /**
   * Of {@link pointerSamples}, those admitted through
   * `AccessibilityAdapter.groundFast`/`ground` — the one-round-trip path
   * PR-028 chose for the 30 Hz cadence. Equal to `pointerSamples` on any
   * platform that offers either method, and 0 on one that offers neither.
   */
  readonly groundedPointerSamples: number;
  /** Elements retained for question anchoring, never more than one per sample. */
  readonly pointerTargets: number;
}

export interface ObservationRuntime {
  /** What `createInteractionRuntime({ observation })` takes (follow-up 23). */
  readonly port: ObservationControlPort;
  /** What PR-030 passes to `createAgentRuntime({ screenContext })`. */
  readonly screenContext: PilotScreenContextService;
  readonly core: ObservationCore;
  readonly session: ObservationSession;
  readonly retention: RetentionGuard;
  readonly inputs: MutableScreenContextInputs;
  /**
   * What was under the pointer, sample by sample (PR-031). Read by
   * `main/question-anchor.ts` when a question is submitted; emptied by the
   * retention guard with the frame ring.
   */
  readonly targets: PointerTargetLog;
  /** True when something can actually capture. False is a reportable state. */
  readonly captureAvailable: boolean;
  status(): ScreenStatus;
  metrics(): ObservationRuntimeMetrics;
  /** Latest allowed observation, content-free. `null` before the first one. */
  lastObservation(): ScreenObservationMetadata | null;
  /** Pushes the interaction controller's view state into the §10 conditions. */
  noteViewState(view: PilotViewState): void;
  /** Pushes the permission gate's snapshot into the §10 conditions. */
  notePermissions(snapshot: PermissionSnapshot | null): void;
  /** Names the occasion for the next clear, for the retention log (§13). */
  noteRetentionEvent(event: RetentionEvent): void;
  /**
   * Attaches the diagnostics ring.
   *
   * Separate from construction because of the order the composition root is
   * forced into: `ConversationGate` owns the ring and needs the interaction
   * controller, the controller needs this runtime's port, and this runtime is
   * therefore built first.
   */
  attachTelemetry(sink: ObservationTelemetrySink): void;
  /** Re-reads PR-011's attribution verdict. Safe to call repeatedly. */
  refreshAttribution(): Promise<PermissionAttribution | undefined>;
  /** One pointer sample, on demand. The poller calls this on its own cadence. */
  samplePointer(): Promise<boolean>;
  dispose(): Promise<void>;
}

/**
 * The two TCC states §10 step 1 validates, from the platform plus PR-011.
 *
 * Exported and pure because it is the whole of runbook follow-up 16 and the
 * place the wiring is easiest to get subtly wrong.
 *
 * | input | screenRecording / accessibility |
 * | --- | --- |
 * | no snapshot yet | `unknown` — refused, and it says so |
 * | snapshot, no attribution verdict | the platform's own answer |
 * | snapshot, verdict `matched` or `unknown` | the platform's own answer |
 * | snapshot, verdict `helper-attributed` / `bundle-mismatch` | **`denied`** |
 *
 * The last row is the one that matters. A failing verdict means macOS credits
 * the grant to something that is not Pilot, so a `granted` state is a permission
 * Pilot cannot actually use — and proceeding on it would produce an empty
 * capture reported as a capture bug. `unknown` is left alone deliberately: it is
 * a non-answer (a loose executable is inside no `.app`), not a failure, and
 * PR-011 says so.
 */
export function observationPermissionConditions(
  snapshot: PermissionSnapshot | null,
  attribution?: PermissionAttribution,
): { readonly screenRecording: PermissionState; readonly accessibility: PermissionState } {
  if (snapshot === null) {
    return { screenRecording: 'unknown', accessibility: 'unknown' };
  }
  if (attribution !== undefined && isAttributionFailure(attribution)) {
    return { screenRecording: 'denied', accessibility: 'denied' };
  }
  return {
    screenRecording: snapshot['screen-recording'].state,
    accessibility: snapshot.accessibility.state,
  };
}

/**
 * Which retention event a window-feed event is (system-design §13).
 *
 * The interaction table emits `stop-capture` + `clear-buffers` for all of them,
 * so the port cannot tell a lock from a pause from the call alone. It is armed
 * from the event that caused it instead. Nothing about *what is cleared* depends
 * on this — only the reason recorded in the retention log and whether the scene
 * lineage survives, which it does for every event here.
 */
export function retentionEventForFeed(event: WindowFeedEvent): RetentionEvent | null {
  switch (event.type) {
    case 'window-closed':
      return 'window-loss';
    case 'screen-locked':
      return 'screen-lock';
    case 'windows-changed':
    case 'screen-unlocked':
      return null;
  }
}

/** Geometry for a window the platform could not describe (fakes, or a race). */
function derivedGeometry(window: ObservedWindow): WindowGeometry {
  return {
    windowId: window.windowId,
    displayId: window.displayId,
    bounds: window.bounds,
    scaleFactor: window.scaleFactor,
    captureSize: {
      width: Math.max(1, Math.round(window.bounds.width * window.scaleFactor)),
      height: Math.max(1, Math.round(window.bounds.height * window.scaleFactor)),
    },
  };
}

type GroundFn = (target: AccessibilityGroundingTarget) => Promise<PointerGroundingSample>;

/**
 * The process id of the application owning a window, when the platform knows it
 * (PR-031, and it is not cosmetic).
 *
 * PR-013 built two defences against describing an element that belongs to a
 * window stacked on top of the selected one: the helper scopes the hit test
 * with `AXUIElementCreateApplication(ownerPid)`, and `groundPointer` drops an
 * element whose `ownerPid` disagrees. **Both are inert unless the caller
 * supplies `ownerPid`**, and `AccessibilityGroundingTarget.ownerPid` is
 * optional, so a caller that omits it gets a system-wide hit test and no
 * host-side check — silently. Until PR-031 nothing consumed the element, so the
 * omission cost nothing; now it is what a question is grounded on.
 *
 * `ObservedWindow` (system-design §5) carries no pid, so it is read off
 * `MacWindowAdapter.lastSnapshot`, which does. Structural and optional: a
 * `WindowAdapter` without that getter — the fakes, or a future platform —
 * returns `undefined`, and grounding falls back to the geometric defence
 * (`rectsOverlap`) exactly as it did before. Putting `ownerPid` on the window
 * contract itself is the real fix and is a focused contract PR, not this one.
 */
export function ownerPidFor(windows: WindowAdapter, window: ObservedWindow): number | undefined {
  const snapshot = (
    windows as WindowAdapter & {
      readonly lastSnapshot?: {
        readonly windows?: readonly { readonly windowNumber: number; readonly ownerPid: number }[];
      } | null;
    }
  ).lastSnapshot;
  const wanted = macWindowNumber(window.windowId);
  if (snapshot?.windows === undefined || wanted === null) {
    return undefined;
  }
  // Exact id, no first-match fallback — the same rule PR-012's capture filter
  // is held to by `selected-window-only.test.ts`.
  return snapshot.windows.find((row) => row.windowNumber === wanted)?.ownerPid;
}

export function createObservationRuntime(options: ObservationRuntimeOptions): ObservationRuntime {
  const logger = (options.logger ?? nullLogger).child('observation');
  const clock = options.clock ?? systemClock;
  let telemetry = options.telemetry;
  const capture = options.capture;
  const accessibility = options.accessibility ?? null;
  const targets = options.targets ?? new PointerTargetLog();

  const core = new ObservationCore({
    clock,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });
  const session = new ObservationSession({
    core,
    clock,
    logger,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(capture === null ? {} : { observation: capture }),
    ...(accessibility === null ? {} : { accessibility }),
  });
  const inputs = new MutableScreenContextInputs({
    // Until a permission snapshot arrives this is `unknown`, which the policy
    // refuses. That is the designed failure of an unwired facade (PR-019), and
    // it is briefly true here too — for exactly as long as the first
    // `permissions.refresh()` takes.
    permissions: { screenRecording: 'unknown', accessibility: 'unknown' },
  });

  let lastObservation: ScreenObservationMetadata | null = null;
  const onObservation = (metadata: ScreenObservationMetadata): void => {
    lastObservation = metadata;
    // §17's three capture-side numbers, which PR-010 deliberately left to this
    // PR because they cannot be seen from the view-state stream. Every one of
    // them is a number; `TelemetryRing` has no method that would take a title.
    telemetry?.timing(
      'capture-to-observation',
      Math.max(0, metadata.requestedAt - metadata.capturedAt),
    );
    telemetry?.count('image-bytes', metadata.totalImageBytes);
    telemetry?.count('active-images', metadata.images.length);
    logger.info('observation allowed', {
      view: metadata.view,
      moment: metadata.moment,
      frames: metadata.frames.length,
      images: metadata.images.length,
      totalImageBytes: metadata.totalImageBytes,
      pointerKnown: metadata.pointerKnown,
      // A role is a control *kind* ("AXButton"), never its label or its value.
      targetRole: metadata.targetRole,
      maskedRegions: metadata.redaction.maskedRegions,
      unmaskableRegions: metadata.redaction.unmaskableRegions,
    });
  };
  const onRefusal = (refusal: ScreenObservationRefusal): void => {
    telemetry?.failure(refusal.error.code);
    logger.warn('observation refused', {
      rule: refusal.rule,
      step: refusal.step,
      code: refusal.error.code,
    });
  };

  const screenContext = new PilotScreenContextService({
    clock,
    session,
    inputs,
    logger,
    onObservation,
    onRefusal,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(capture === null ? {} : { capture }),
  });
  const retention = screenContext.retention;

  let permissions: PermissionSnapshot | null = null;
  let attribution: PermissionAttribution | undefined;
  let view: PilotViewState | null = null;
  let pendingRetentionEvent: RetentionEvent = 'observation-disabled';
  let selected: {
    window: ObservedWindow;
    geometry: WindowGeometry;
    ownerPid: number | undefined;
  } | null = null;
  let offCaptureEvents: Unsubscribe | null = null;

  let starts = 0;
  let stops = 0;
  let clears = 0;
  /** Runbook follow-up 31. Counted here because only this path can count it. */
  let groundedPointerSamples = 0;

  const applyConditions = (): void => {
    const conditions: ScreenContextConditions = {
      permissions: observationPermissionConditions(permissions, attribution),
      // The pause switch and the observation switch are the interaction
      // controller's, not the session's: §6 lists them as two separate
      // conditions and the machine owns both.
      ...(view === null
        ? {}
        : { paused: view.state === 'paused', enabled: view.observationEnabled }),
      // Never widened: `MacObservationAdapter` builds its filter from one
      // `CGWindowID` and has no display-wide path (PR-012). A caller that
      // learns otherwise says so here and the observation is refused.
      captureSource: 'selected-window',
    };
    inputs.setConditions(conditions);
  };
  applyConditions();

  // `groundFast` is `MacAccessibilityAdapter`'s one-round-trip form, added by
  // PR-013 for exactly this cadence; `ground` is the optional interface member.
  // Neither is required, so a platform offering only §5's two verbatim methods
  // still records a pointer — through the session, at two round trips.
  const grounder = accessibility as (AccessibilityAdapter & { groundFast?: GroundFn }) | null;
  const groundFn: GroundFn | null =
    typeof grounder?.groundFast === 'function'
      ? grounder.groundFast.bind(grounder)
      : typeof grounder?.ground === 'function'
        ? grounder.ground.bind(grounder)
        : null;

  /**
   * One pointer sample into the timeline.
   *
   * PR-013 added `ground`/`groundFast` as optional members precisely so the
   * ~30 Hz path costs one round trip instead of two; `ObservationSession.
   * samplePointer` predates them and issues `getPointer` then `elementAt`. Both
   * are used, preferring the cheaper one, so a platform that offers neither
   * still records a pointer.
   *
   * PR-031 adds one line to it: the element the grounding already resolved is
   * written down beside the sample, so a question submitted later can say what
   * the user was pointing *at* and not only where. Written down **only** when
   * the grounding says the pointer was inside the selected window — the same
   * rule `shouldHitTest` and `groundPointer` enforce upstream, here for the
   * third time, because this is the copy that would otherwise reach a prompt.
   *
   * The `session.samplePointer()` fallback records no element: it resolves one
   * through `elementAt`, but the outcome it returns does not carry the node.
   * A platform on that path therefore anchors a position with no target, which
   * is the same degraded answer §16 already defines for a denied Accessibility
   * grant — never a wrong one.
   */
  const samplePointer = async (): Promise<boolean> => {
    const current = selected;
    if (current === null || session.state !== 'observing') {
      return false;
    }
    try {
      if (groundFn === null) {
        const outcome = await session.samplePointer();
        return outcome.sampled && outcome.ingest.admitted;
      }
      const sample = await groundFn({
        geometry: current.geometry,
        // PR-031: without this the hit test is system-wide and PR-013's
        // foreign-application check cannot fire. See `ownerPidFor`.
        ...(current.ownerPid === undefined ? {} : { ownerPid: current.ownerPid }),
      });
      const ingest = core.ingestPointer({
        at: sample.at,
        windowId: current.window.windowId,
        pointer: sample.pointer,
      });
      if (ingest.admitted) {
        // Runbook follow-up 31. The same condition `ObservationSession`
        // increments its own counter on — an *admitted* sample, not an attempt
        // — so the two paths add up to one comparable number.
        groundedPointerSamples += 1;
        targets.note({
          at: sample.at,
          windowId: current.window.windowId,
          insideWindow: sample.grounding === 'pointer-in-window',
          node: sample.target,
        });
      }
      return ingest.admitted;
    } catch (cause) {
      // A pointer sample that fails is not an error the user can act on: the
      // next tick reconciles. §16's degraded mode is "no pointer", not "stop".
      logger.debug('pointer sample failed', { code: toPilotError(cause).code });
      return false;
    }
  };

  const pointerPoller = new Poller(
    async () => {
      await samplePointer();
    },
    {
      intervalMs: options.pointerSampleIntervalMs ?? 1000 / 30,
      logger,
      name: 'pointer',
    },
  );

  const clearThrough = (event: RetentionEvent): void => {
    try {
      // `RetentionGuard` writes its own `retention clear` line with the counts,
      // so this adds nothing but the fact that the *guard* is what ran — which
      // is the whole of runbook follow-up 17 and is worth exactly one debug
      // line, not a second copy of the report at info.
      retention.clearFor(event);
      // PR-031: the retained accessibility elements and the pending question
      // anchor are screen content too (§13), and the guard does not own them.
      // They go in the same call, so there is no window in which the ring is
      // empty and a label read off it is still in memory.
      const droppedTargets = targets.clear();
      inputs.setAnchor(null);
      clears += 1;
      logger.debug('buffers cleared through the retention guard', {
        event,
        pointerTargets: droppedTargets.recordCount,
      });
    } catch (cause) {
      // `clearFor` throws when anything survived. That is the one retention
      // failure that must never be swallowed.
      const error = toPilotError(cause);
      telemetry?.failure(error.code);
      logger.error('buffers were not empty after clearing', { event, code: error.code });
      throw error;
    }
  };

  const port: ObservationControlPort = {
    async start(window: ObservedWindow): Promise<void> {
      const geometry = (await options.windows.geometry(window.windowId)) ?? derivedGeometry(window);
      const ownerPid = ownerPidFor(options.windows, window);
      selected = { window, geometry, ownerPid };
      pendingRetentionEvent = 'observation-disabled';
      await session.start({ window, geometry });
      starts += 1;

      // The stream may have been downscaled by the capture policy, and the
      // pointer's captured-pixel conversion is computed from `captureSize`. Ask
      // the adapter what it actually negotiated rather than assuming.
      const negotiated = (capture as { captureGeometry?: WindowGeometry | null } | null)
        ?.captureGeometry;
      if (negotiated != null) {
        selected = { window, geometry: negotiated, ownerPid };
        session.updateGeometry(negotiated);
      }

      offCaptureEvents?.();
      offCaptureEvents =
        capture?.subscribeEvents?.((event: ObservationEvent) => {
          if (event.type === 'capture-stopped') {
            logger.warn('capture stopped by the platform', {
              reason: event.reason,
              code: event.error?.code ?? null,
            });
            if (event.error !== undefined) {
              telemetry?.failure(event.error.code);
            }
          }
          if (event.type === 'frames-dropped') {
            logger.debug('frames dropped', { reason: event.reason, count: event.count });
          }
        }) ?? null;

      if (accessibility !== null) {
        pointerPoller.start();
      }
      logger.info('capture started', {
        windowId: window.windowId,
        captureSize: selected.geometry.captureSize,
        // `undefined` here means the hit test cannot be scoped to one
        // application, which is a weaker grounding guarantee — say so.
        pointerScopedToApplication: ownerPid !== undefined,
      });
      applyConditions();
    },

    async stop(): Promise<void> {
      pointerPoller.stop();
      offCaptureEvents?.();
      offCaptureEvents = null;
      selected = null;
      await session.stop(
        pendingRetentionEvent === 'window-loss' ? 'window-lost' : 'observation-disabled',
      );
      stops += 1;
      // Follow-up 17: the session cleared the core directly. This is the door —
      // it also resets the rate limiter, drops the decoded frame and proves the
      // buffers are empty.
      clearThrough(pendingRetentionEvent);
      applyConditions();
    },

    async clear(): Promise<void> {
      clearThrough(pendingRetentionEvent);
    },

    async observe(observationId: ObservationId, signal?: AbortSignal): Promise<void> {
      // This is Pilot's *own* observation — "Look now" (runbook amendment 1,
      // wired by PR-030). The model's `observe_screen` chooses its own view and
      // moment and reaches the same facade — the same instance, since PR-030
      // passes it to `createAgentRuntime({ screenContext })`.
      //
      // `moment: 'current'` is the honest reading of "look now": a fresh
      // capture, not whichever frame happens to be in the ring. `view: 'window'`
      // rather than `'both'` because the pointer crop is cropped around the
      // *question* anchor, and there is no anchor until PR-031 wires one — a
      // crop around a pointer nobody pointed with would be a picture of the
      // wrong thing. It also means an unchanged frame is passed through
      // unencoded (PR-018), so the ordinary look costs no re-encode at all.
      try {
        const result = await screenContext.observeDetailed(LOOK_NOW_REQUEST, signal);
        logger.debug('observation completed', {
          observationId,
          producedObservationId: result.observation.observationId,
        });
      } catch (cause) {
        // PR-030: a refusal the *user* triggered is given the same shape a
        // refusal the *model* triggered has, so the panel has one thing to
        // render and the user reads a sentence rather than an adapter's log
        // line. The controller turns this throw into the machine's `failure`
        // input, which is what puts it on `lastError`.
        const error = toObservationFailureError(cause, LOOK_NOW_REQUEST);
        logger.warn('look now refused', {
          observationId,
          code: error.code,
          failure: error.details?.['failure'],
        });
        throw error;
      }
    },
  };

  return {
    port,
    screenContext,
    core,
    session,
    retention,
    inputs,
    targets,
    captureAvailable: capture !== null,
    status: () => screenContext.status(),
    metrics: () => {
      const sessionMetrics = session.metrics();
      return {
        starts,
        stops,
        clears,
        observations: screenContext.metrics.observations,
        refusals: screenContext.metrics.refusals,
        framesIngested: sessionMetrics.framesIngested,
        framesRejected: sessionMetrics.framesRejected,
        // Both paths. Exactly one of the two can be non-zero for a given
        // platform — `groundFn` is chosen once, at construction — so this is a
        // sum rather than a max only because that is the honest arithmetic if
        // a future platform ever mixes them.
        pointerSamples: sessionMetrics.pointerSamples + groundedPointerSamples,
        groundedPointerSamples,
        pointerTargets: targets.size,
      };
    },
    lastObservation: () => lastObservation,
    noteViewState: (next: PilotViewState) => {
      view = next;
      applyConditions();
    },
    notePermissions: (snapshot: PermissionSnapshot | null) => {
      permissions = snapshot;
      applyConditions();
    },
    noteRetentionEvent: (event: RetentionEvent) => {
      pendingRetentionEvent = event;
    },
    attachTelemetry: (sink: ObservationTelemetrySink) => {
      telemetry = sink;
    },
    refreshAttribution: async (): Promise<PermissionAttribution | undefined> => {
      const read = options.attribution;
      if (read === undefined) {
        return undefined;
      }
      try {
        attribution = await read();
      } catch (cause) {
        // A verdict that cannot be read is not a verdict that passed. Leaving
        // the previous one in place would be worse than saying nothing, so the
        // states fall back to whatever the platform reported and the failure is
        // logged where it can be seen.
        logger.warn('could not read the permission attribution verdict', {
          code: toPilotError(cause).code,
        });
        attribution = undefined;
      }
      applyConditions();
      if (attribution !== undefined) {
        logger.info('permission attribution', {
          verdict: attribution.verdict,
          confidence: attribution.confidence,
        });
      }
      return attribution;
    },
    samplePointer,
    dispose: async (): Promise<void> => {
      pointerPoller.stop();
      offCaptureEvents?.();
      offCaptureEvents = null;
      selected = null;
      await session.stop('shutdown').catch(() => undefined);
      session.dispose();
      // Shutdown is terminal: the scene lineage goes too (§13).
      clearThrough('shutdown');
    },
  };
}
