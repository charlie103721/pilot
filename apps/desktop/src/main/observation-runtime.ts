import {
  isAttributionFailure,
  nullLogger,
  toPilotError,
  type Logger,
  type ObservationId,
  type ObservedWindow,
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
import { Poller } from '@pilot/platform-mac';
import type { ObservationControlPort } from '@pilot/interaction';
import type { TelemetryMetric } from '../ipc/schemas.js';
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
 * ## What is still not real here
 *
 * The question anchor. `moment: 'question'` needs the utterance anchor and the
 * accessibility node under the pointer at the moment the question ended, which
 * is PR-031's wiring (`ScreenContextInputs.anchor`). Until then the anchor is
 * `null`, which the facade reads as "a model-initiated look at now" — a correct
 * reading, and the reason "Look now" asks for `moment: 'current'` rather than
 * pretending to anchor on a question nobody asked.
 */

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
}

export interface ObservationRuntimeMetrics {
  readonly starts: number;
  readonly stops: number;
  readonly clears: number;
  readonly observations: number;
  readonly refusals: number;
  readonly framesIngested: number;
  readonly framesRejected: number;
  readonly pointerSamples: number;
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

export function createObservationRuntime(options: ObservationRuntimeOptions): ObservationRuntime {
  const logger = (options.logger ?? nullLogger).child('observation');
  const clock = options.clock ?? systemClock;
  let telemetry = options.telemetry;
  const capture = options.capture;
  const accessibility = options.accessibility ?? null;

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
  let selected: { window: ObservedWindow; geometry: WindowGeometry } | null = null;
  let offCaptureEvents: Unsubscribe | null = null;

  let starts = 0;
  let stops = 0;
  let clears = 0;

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
      const sample = await groundFn({ geometry: current.geometry });
      const ingest = core.ingestPointer({
        at: sample.at,
        windowId: current.window.windowId,
        pointer: sample.pointer,
      });
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
      clears += 1;
      logger.debug('buffers cleared through the retention guard', { event });
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
      selected = { window, geometry };
      pendingRetentionEvent = 'observation-disabled';
      await session.start({ window, geometry });
      starts += 1;

      // The stream may have been downscaled by the capture policy, and the
      // pointer's captured-pixel conversion is computed from `captureSize`. Ask
      // the adapter what it actually negotiated rather than assuming.
      const negotiated = (capture as { captureGeometry?: WindowGeometry | null } | null)
        ?.captureGeometry;
      if (negotiated != null) {
        selected = { window, geometry: negotiated };
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
      // moment and reaches the same facade through PR-030.
      //
      // `moment: 'current'` is the honest reading of "look now": a fresh
      // capture, not whichever frame happens to be in the ring. `view: 'window'`
      // rather than `'both'` because the pointer crop is cropped around the
      // *question* anchor, and there is no anchor until PR-031 wires one — a
      // crop around a pointer nobody pointed with would be a picture of the
      // wrong thing. It also means an unchanged frame is passed through
      // unencoded (PR-018), so the ordinary look costs no re-encode at all.
      const result = await screenContext.observeDetailed(
        { view: 'window', moment: 'current' },
        signal,
      );
      logger.debug('observation completed', {
        observationId,
        producedObservationId: result.observation.observationId,
      });
    },
  };

  return {
    port,
    screenContext,
    core,
    session,
    retention,
    inputs,
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
        pointerSamples: sessionMetrics.pointerSamples,
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
