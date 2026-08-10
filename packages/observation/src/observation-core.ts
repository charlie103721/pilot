import {
  nullLogger,
  PilotError,
  type CapturedFrame,
  type IdFactory,
  type Logger,
  type ObservedWindow,
  type SceneState,
} from '@pilot/shared';
import type { ObservationAdapter, Unsubscribe } from '@pilot/platform';
import { toTimestamp, type Clock } from './clock.js';
import {
  FrameRing,
  NO_EVICTIONS,
  type EvictionSummary,
  type FrameBufferStats,
  type FrameRecord,
  type FrameRejectionReason,
  type FrameRingConfig,
  type FrameRingMetrics,
  type FrameSelection,
  type FrameSelectionQuery,
} from './frame-ring.js';
import {
  PointerTimeline,
  type PointerRejectionReason,
  type PointerSample,
  type PointerSampleInput,
  type PointerSelection,
  type PointerSelectionQuery,
  type PointerTimelineConfig,
  type PointerTimelineMetrics,
  type PointerTimelineStats,
} from './pointer-timeline.js';
import {
  SceneTracker,
  type SceneEndReason,
  type SceneSignals,
  type SceneSignalsPatch,
  type SceneTransition,
} from './scene-tracker.js';
import {
  SceneLineage,
  type SceneLineageCheck,
  type SceneLineageConfig,
  type SceneRef,
  type SceneScope,
} from './scene-lineage.js';
import {
  requireQuestionAnchor,
  resolveQuestionAnchor,
  type QuestionAnchor,
  type QuestionAnchorOptions,
  type QuestionAnchorResult,
  type UtteranceWindow,
} from './question-anchor.js';

/**
 * Observation core (system-design §6).
 *
 * Owns the three pieces of observation state — the bounded frame ring, the
 * pointer timeline and the scene identity/revision — and the one clear that
 * empties all of them. It performs no capture, no image processing and no
 * policy enforcement: frames arrive through the `ObservationAdapter` contract
 * (or a fake), PR-017 adds policy on top, PR-018 the image pipeline and PR-019
 * the `ScreenContextService` facade.
 *
 * Nothing here is persisted or logged in content form (system-design §13).
 */

/**
 * Every path that must drop observation state. Pause, lock, window loss and
 * shutdown are the four the design calls out; the rest exist so a caller never
 * has to reach past {@link ObservationCore.clear} to empty the buffers.
 */
export const CLEAR_REASONS = [
  'paused',
  'screen-locked',
  'window-lost',
  'shutdown',
  'window-changed',
  'observation-disabled',
  'permission-lost',
  'manual',
] as const;

export type ClearReason = (typeof CLEAR_REASONS)[number];

export interface ClearResult {
  readonly reason: ClearReason;
  readonly at: number;
  readonly frames: { readonly count: number; readonly bytes: number };
  readonly pointerSamples: number;
  /** The scene that was dropped, for the caller's own event log. */
  readonly scene: SceneState | null;
}

export type FrameIngestRejection =
  | FrameRejectionReason
  /** Nothing is selected, so no frame can be anchored to a scene. */
  | 'no-window-selected'
  /** The frame belongs to a window that is not the selected one. */
  | 'foreign-window';

export type FrameIngestResult =
  | { readonly admitted: true; readonly record: FrameRecord; readonly evicted: EvictionSummary }
  | {
      readonly admitted: false;
      readonly reason: FrameIngestRejection;
      readonly detail: string;
      readonly evicted: EvictionSummary;
    };

export type PointerIngestRejection =
  PointerRejectionReason | 'no-window-selected' | 'foreign-window';

export type PointerIngestResult =
  | { readonly admitted: true; readonly sample: PointerSample; readonly coalesced: boolean }
  | {
      readonly admitted: false;
      readonly reason: PointerIngestRejection;
      readonly detail: string;
    };

export interface ObservationCoreStatus {
  readonly scene: SceneState | null;
  readonly buffer: FrameBufferStats;
  readonly pointer: PointerTimelineStats;
  readonly lastClear: { readonly reason: ClearReason; readonly at: number } | null;
}

export interface ObservationCoreMetrics {
  readonly frames: FrameRingMetrics;
  readonly pointer: PointerTimelineMetrics;
  readonly clears: number;
}

export interface ObservationCoreOptions {
  readonly clock: Clock;
  readonly ids?: IdFactory;
  /** Privacy-safe logger; defaults to a logger that discards everything. */
  readonly logger?: Logger;
  readonly frames?: FrameRingConfig;
  readonly pointer?: PointerTimelineConfig;
  readonly lineage?: SceneLineageConfig;
}

/**
 * How a clear ends the scene episode in the lineage. Losing the window is not
 * the same as deselecting it, and both differ from a pause or a lock.
 */
function sceneEndReasonFor(reason: ClearReason): SceneEndReason {
  switch (reason) {
    case 'window-lost':
      return 'window-closed';
    case 'window-changed':
      return 'deselected';
    default:
      return 'cleared';
  }
}

export class ObservationCore {
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #ring: FrameRing;
  readonly #timeline: PointerTimeline;
  readonly #scenes: SceneTracker;
  readonly #lineage: SceneLineage;

  #lastClear: { reason: ClearReason; at: number } | null = null;
  #clears = 0;

  constructor(options: ObservationCoreOptions) {
    this.#clock = options.clock;
    this.#logger = options.logger ?? nullLogger;
    this.#ring = new FrameRing({ clock: options.clock, ...(options.frames ?? {}) });
    this.#timeline = new PointerTimeline({ clock: options.clock, ...(options.pointer ?? {}) });
    this.#scenes = new SceneTracker({
      clock: options.clock,
      ...(options.ids === undefined ? {} : { ids: options.ids }),
    });
    this.#lineage = new SceneLineage(options.lineage ?? {});
  }

  /** Read-only access for callers that need the primitives directly (PR-016+). */
  get frames(): FrameRing {
    return this.#ring;
  }

  get pointer(): PointerTimeline {
    return this.#timeline;
  }

  get scenes(): SceneTracker {
    return this.#scenes;
  }

  /** Scene history and the lineage check PR-019 validates results against. */
  get lineage(): SceneLineage {
    return this.#lineage;
  }

  get scene(): SceneState | null {
    return this.#scenes.current;
  }

  // -------------------------------------------------------------------------
  // Selection and scene
  // -------------------------------------------------------------------------

  /**
   * Selects the observed window. Switching to a different window clears the
   * buffers first: frames and pointer samples from the previous selection must
   * never be answerable against the new scene (system-design §10, step 3).
   */
  selectWindow(signals: SceneSignals | ObservedWindow): SceneTransition {
    const resolved: SceneSignals = 'window' in signals ? signals : { window: signals };
    const current = this.#scenes.current;
    if (current !== null && current.windowId !== resolved.window.windowId) {
      this.clear('window-changed');
    }
    return this.#record(this.#scenes.select(resolved));
  }

  updateScene(patch: SceneSignalsPatch): SceneTransition {
    const window = patch.window;
    const current = this.#scenes.current;
    if (window !== undefined && current !== null && current.windowId !== window.windowId) {
      // A different window is a different scene: route through selectWindow so
      // the buffers are cleared before anything from the new window arrives.
      return this.selectWindow({
        window,
        ...(patch.geometry === undefined ? {} : { geometry: patch.geometry }),
        ...(patch.accessibilityRootId === undefined
          ? {}
          : { accessibilityRootId: patch.accessibilityRootId }),
        ...(patch.contentFingerprint === undefined
          ? {}
          : { contentFingerprint: patch.contentFingerprint }),
      });
    }
    return this.#record(this.#scenes.update(patch));
  }

  markObserved(revision?: number): SceneState | null {
    const scene = this.#scenes.markObserved(revision);
    if (scene !== null) {
      this.#lineage.markObserved(scene);
    }
    return scene;
  }

  /**
   * Whether a scene reference held by a question, tool call or pending result
   * may still be answered from (system-design §15).
   */
  checkScene(ref: SceneRef): SceneLineageCheck {
    return this.#lineage.check(ref);
  }

  #record(transition: SceneTransition): SceneTransition {
    this.#lineage.record(transition, toTimestamp(this.#clock.now()));
    return transition;
  }

  // -------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------

  ingestFrame(frame: CapturedFrame): FrameIngestResult {
    const scene = this.#scenes.current;
    if (scene === null) {
      return {
        admitted: false,
        reason: 'no-window-selected',
        detail: 'No window is selected, so the frame has no scene to anchor to',
        evicted: NO_EVICTIONS,
      };
    }
    if (frame.windowId !== scene.windowId) {
      this.#logger.debug('rejected frame from a window that is not selected', {
        reason: 'foreign-window',
        capturedAt: frame.capturedAt,
      });
      return {
        admitted: false,
        reason: 'foreign-window',
        detail: 'Frame belongs to a previous or unrelated window selection',
        evicted: NO_EVICTIONS,
      };
    }
    return this.#ring.push(frame, { sceneRevision: scene.revision, sceneId: scene.sceneId });
  }

  ingestPointer(input: PointerSampleInput): PointerIngestResult {
    const scene = this.#scenes.current;
    if (scene === null) {
      return {
        admitted: false,
        reason: 'no-window-selected',
        detail: 'No window is selected, so the pointer sample has no scene to anchor to',
      };
    }
    if (input.windowId !== scene.windowId) {
      return {
        admitted: false,
        reason: 'foreign-window',
        detail: 'Pointer sample belongs to a previous or unrelated window selection',
      };
    }
    const result = this.#timeline.push({
      ...input,
      sceneRevision: scene.revision,
      sceneId: scene.sceneId,
    });
    if (!result.admitted) {
      return { admitted: false, reason: result.reason, detail: result.detail };
    }
    return { admitted: true, sample: result.sample, coalesced: result.coalesced };
  }

  /**
   * Attaches an `ObservationAdapter` (real or fake) as the frame source.
   * Rejections are counted and logged at debug, never thrown: a capture stream
   * must not die because one frame was late.
   */
  attach(adapter: ObservationAdapter): Unsubscribe {
    return adapter.subscribe((frame) => {
      const result = this.ingestFrame(frame);
      if (!result.admitted) {
        this.#logger.debug('frame not admitted', {
          reason: result.reason,
          capturedAt: frame.capturedAt,
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Selection (the question-moment anchor lookup)
  // -------------------------------------------------------------------------

  /**
   * Nearest frame to a moment, **scoped to the current scene** unless the
   * caller names another one.
   *
   * Ingest already refuses frames from a window that is not selected, and a
   * window change clears the buffers. This is the other half of the same rule
   * (system-design §10 step 3): a caller holding a moment from a previous
   * selection asks for it *after* the switch, and must be told the frame is
   * gone rather than handed the new window's pixels. Pass `{ scene: 'any' }`
   * to opt out — diagnostics only.
   */
  selectFrame(requestedAt: number, query: FrameSelectionQuery = {}): FrameSelection {
    return this.#ring.select(requestedAt, this.#scopeQuery(query));
  }

  /**
   * Frame-or-throw. Downstream code that cannot proceed without a frame uses
   * this so the failure reaches the user as a typed `PilotError` instead of an
   * `undefined` that reads as "nothing to see".
   */
  requireFrame(requestedAt: number, query: FrameSelectionQuery = {}): FrameRecord {
    const scene = this.#scenes.current;
    if (scene === null) {
      throw new PilotError('observation-disabled', 'No window is selected', {
        userMessage: 'Pilot is not observing a window right now.',
      });
    }
    const selection = this.#ring.select(requestedAt, this.#scopeQuery(query));
    if (selection.found) {
      return selection.record;
    }
    throw frameUnavailable(selection, requestedAt);
  }

  selectPointer(requestedAt: number, query: PointerSelectionQuery = {}): PointerSelection {
    return this.#timeline.select(requestedAt, this.#scopeQuery(query));
  }

  requirePointer(requestedAt: number, query: PointerSelectionQuery = {}): PointerSample {
    const scene = this.#scenes.current;
    if (scene === null) {
      throw new PilotError('observation-disabled', 'No window is selected', {
        userMessage: 'Pilot is not observing a window right now.',
      });
    }
    const selection = this.#timeline.select(requestedAt, this.#scopeQuery(query));
    if (selection.found) {
      return selection.sample;
    }
    throw new PilotError(
      selection.reason === 'scene-mismatch' ? 'scene-mismatch' : 'frame-unavailable',
      `No pointer sample for the requested moment (${selection.reason})`,
      {
        userMessage:
          selection.reason === 'scene-mismatch'
            ? 'Pilot is looking at a different window now.'
            : 'Pilot does not know where the pointer was when you asked.',
        retryable: selection.reason !== 'empty' && selection.reason !== 'scene-mismatch',
        details: {
          requestedAt,
          reason: selection.reason,
          sampleCount: selection.sampleCount,
          nearestDistanceMs: selection.nearestDistanceMs,
        },
      },
    );
  }

  /**
   * Pointer path over an utterance, for question anchoring (system-design §6).
   * Scoped to the current scene like every other selection.
   */
  pointerPath(from: number, to: number, scope?: SceneScope): readonly PointerSample[] {
    return this.#timeline.between(
      from,
      to,
      this.#scopeQuery(scope === undefined ? {} : { scene: scope }),
    );
  }

  /**
   * Grounding point for one utterance — the pointer position at utterance end
   * (system-design §6), with the path, target changes and scene revisions that
   * say how much to trust it.
   */
  anchorQuestion(
    utterance: UtteranceWindow,
    options?: QuestionAnchorOptions,
  ): QuestionAnchorResult {
    return resolveQuestionAnchor(this, utterance, options);
  }

  /** Anchor-or-throw, for callers that cannot proceed without a grounding point. */
  requireAnchor(utterance: UtteranceWindow, options?: QuestionAnchorOptions): QuestionAnchor {
    return requireQuestionAnchor(this, utterance, options);
  }

  /**
   * Defaults a buffer query to the current scene. When nothing is selected the
   * buffers are empty by construction (every clear empties both), so the query
   * is left unscoped and reports `empty` rather than a confusing mismatch.
   */
  #scopeQuery<Query extends { readonly scene?: SceneScope }>(query: Query): Query {
    if (query.scene !== undefined) {
      return query;
    }
    const scene = this.#scenes.current;
    if (scene === null) {
      return query;
    }
    return { ...query, scene: scene.sceneId };
  }

  // -------------------------------------------------------------------------
  // Status and clear
  // -------------------------------------------------------------------------

  status(): ObservationCoreStatus {
    return {
      scene: this.#scenes.current,
      buffer: this.#ring.stats(),
      pointer: this.#timeline.stats(),
      lastClear: this.#lastClear === null ? null : { ...this.#lastClear },
    };
  }

  metrics(): ObservationCoreMetrics {
    return {
      frames: this.#ring.metrics(),
      pointer: this.#timeline.metrics(),
      clears: this.#clears,
    };
  }

  /**
   * The deterministic clear. Pause, lock, window loss and shutdown all route
   * through this one call, and after it returns nothing captured is
   * retrievable: no frames, no pointer samples, no scene.
   *
   * The lineage keeps the ended episode — scene metadata only, no frames and no
   * pointer samples — so a result that arrives after the clear is rejected as
   * `superseded` instead of silently unknown. {@link resetLineage} drops it.
   */
  clear(reason: ClearReason): ClearResult {
    const at = toTimestamp(this.#clock.now());
    const scene = this.#scenes.current;
    const frames = this.#ring.clear();
    const pointer = this.#timeline.clear();
    this.#scenes.clear();
    this.#lineage.end(sceneEndReasonFor(reason), reason, at);
    this.#clears += 1;
    this.#lastClear = { reason, at };
    this.#logger.info('observation state cleared', {
      reason,
      clearedFrameCount: frames.frameCount,
      clearedByteCount: frames.byteCount,
      clearedPointerSamples: pointer.sampleCount,
    });
    return {
      reason,
      at,
      frames: { count: frames.frameCount, bytes: frames.byteCount },
      pointerSamples: pointer.sampleCount,
      scene,
    };
  }

  /**
   * Drops the scene history as well. Shutdown and logout use this; a pause or
   * a lock does not, because a pending result still has to be rejected against
   * the scene it named.
   */
  resetLineage(): void {
    this.#lineage.reset();
  }

  /** True when no frame, pointer sample or scene is retained. */
  isEmpty(): boolean {
    const status = this.status();
    return (
      status.scene === null &&
      status.buffer.frameCount === 0 &&
      status.buffer.byteCount === 0 &&
      status.pointer.sampleCount === 0
    );
  }
}

function frameUnavailable(
  selection: Extract<FrameSelection, { found: false }>,
  requestedAt: number,
): PilotError {
  if (selection.reason === 'scene-mismatch') {
    return new PilotError(
      'scene-mismatch',
      'No frame belongs to the scene the request named — the window selection has moved on',
      {
        userMessage: 'Pilot is looking at a different window now.',
        retryable: false,
        details: {
          requestedAt,
          reason: selection.reason,
          frameCount: selection.frameCount,
        },
      },
    );
  }
  const message =
    selection.reason === 'empty'
      ? 'The frame buffer is empty'
      : selection.reason === 'out-of-range'
        ? 'No frame close enough to the requested moment'
        : 'No frame on the requested side of the moment';
  return new PilotError('frame-unavailable', message, {
    userMessage: 'Pilot does not have a picture of that moment any more.',
    retryable: true,
    details: {
      requestedAt,
      reason: selection.reason,
      frameCount: selection.frameCount,
      nearestDistanceMs: selection.nearestDistanceMs,
    },
  });
}
