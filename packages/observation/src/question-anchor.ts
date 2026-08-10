import {
  PilotError,
  type GroundedPointer,
  type QuestionEnvelope,
  type SceneId,
  type SceneState,
  type UtteranceId,
} from '@pilot/shared';
import type { PointerSample, PointerSelectionDirection } from './pointer-timeline.js';
import type { ObservationCore } from './observation-core.js';

/**
 * Question anchoring (system-design §6).
 *
 * > The interaction controller records: push-to-talk start and end timestamps,
 * > pointer path during the utterance, target element changes, scene revisions
 * > during the utterance. The initial grounding point is the pointer location
 * > at utterance end.
 *
 * This module turns those recordings into one {@link QuestionAnchor}: the
 * grounding point plus the evidence that says how trustworthy it is. It reads
 * the pointer timeline and the scene, never the frames — choosing an image for
 * the anchor is PR-019's job, and it does it with
 * `selectFrame(anchor.at, { scene: anchor.sceneId })`.
 *
 * "Longest dwell" and deictic-word alignment are explicitly a later version;
 * the full path is carried on the anchor so they can be added without changing
 * the shape of the result.
 */

export interface UtteranceWindow {
  /** Push-to-talk start. */
  readonly startedAt: number;
  /** Push-to-talk end — the moment the anchor is taken at. */
  readonly endedAt: number;
  readonly utteranceId?: UtteranceId;
}

export interface QuestionAnchorOptions {
  /**
   * Largest acceptable distance between the utterance end and the anchor
   * sample. Defaults to the pointer timeline's retention window: a pointer
   * that has not moved for a while is still where the user left it.
   */
  readonly maxSkewMs?: number;
  /**
   * Preferred side of the utterance end. Defaults to `'at-or-before'` — where
   * the pointer was as the user stopped speaking. When nothing precedes the
   * end, the lookup falls back to the nearest sample either side and reports it
   * through {@link QuestionAnchor.afterUtterance}.
   */
  readonly direction?: PointerSelectionDirection;
}

export interface QuestionAnchor {
  readonly utteranceId: UtteranceId | null;
  readonly utteranceStartedAt: number;
  readonly utteranceEndedAt: number;
  /** Timestamp of the anchor sample. */
  readonly at: number;
  /** `at - utteranceEndedAt`; negative when the pointer sample precedes the end. */
  readonly skewMs: number;
  /** True when no sample preceded the utterance end and a later one was used. */
  readonly afterUtterance: boolean;

  readonly scene: SceneState;
  readonly sceneId: SceneId;
  readonly sceneRevision: number;

  readonly pointer: GroundedPointer;
  /** False when the pointer was outside the window; the model must be told. */
  readonly insideWindow: boolean;
  readonly target: GroundedPointer['accessibilityTarget'] | null;

  /** Pointer path during the utterance, oldest first (may be empty). */
  readonly path: readonly PointerSample[];
  /** Number of times the accessibility target changed during the utterance. */
  readonly targetChanges: number;
  /** Distinct scene revisions the path spans, ascending. */
  readonly sceneRevisions: readonly number[];
  /**
   * True when the scene was revised during the utterance: the user may have
   * been pointing at something that has already changed.
   */
  readonly sceneChangedDuringUtterance: boolean;
}

export type QuestionAnchorFailure =
  /** No window is selected, so there is no scene to ground against. */
  | 'no-scene'
  /** The pointer timeline holds nothing for this scene. */
  | 'no-pointer-sample'
  /** The nearest sample is further from the utterance end than allowed. */
  | 'pointer-out-of-range';

export type QuestionAnchorResult =
  | { readonly ok: true; readonly anchor: QuestionAnchor }
  | {
      readonly ok: false;
      readonly reason: QuestionAnchorFailure;
      readonly detail: string;
      readonly scene: SceneState | null;
    };

function targetKey(sample: PointerSample): string {
  const target = sample.pointer.accessibilityTarget;
  if (target === undefined) {
    return '';
  }
  return `${target.role ?? ''}\u0000${target.label ?? ''}`;
}

/**
 * Resolves the grounding point for one utterance against the observation core.
 * The lookup is scoped to the current scene, so a pointer sample recorded for
 * a previous window selection can never become the anchor.
 */
export function resolveQuestionAnchor(
  core: ObservationCore,
  utterance: UtteranceWindow,
  options: QuestionAnchorOptions = {},
): QuestionAnchorResult {
  const scene = core.scene;
  if (scene === null) {
    return {
      ok: false,
      reason: 'no-scene',
      detail: 'No window is selected, so the question cannot be grounded',
      scene: null,
    };
  }

  const direction = options.direction ?? 'at-or-before';
  const query = {
    direction,
    ...(options.maxSkewMs === undefined ? {} : { maxSkewMs: options.maxSkewMs }),
  };

  let selection = core.selectPointer(utterance.endedAt, query);
  let afterUtterance = false;
  if (!selection.found && selection.reason === 'no-sample-in-direction') {
    // Nothing before the end of the utterance: the pointer only entered the
    // window as the user finished. Fall back rather than refuse to ground.
    selection = core.selectPointer(utterance.endedAt, { ...query, direction: 'any' });
    afterUtterance = selection.found;
  }

  if (!selection.found) {
    const reason: QuestionAnchorFailure =
      selection.reason === 'out-of-range' ? 'pointer-out-of-range' : 'no-pointer-sample';
    return {
      ok: false,
      reason,
      detail:
        selection.reason === 'out-of-range'
          ? `Nearest pointer sample is ${String(selection.nearestDistanceMs)}ms from the utterance end`
          : `No pointer sample for this scene (${selection.reason})`,
      scene,
    };
  }

  const sample = selection.sample;
  const path = core.pointerPath(utterance.startedAt, utterance.endedAt);

  let targetChanges = 0;
  let previousKey: string | null = null;
  const revisions = new Set<number>();
  for (const entry of path) {
    const key = targetKey(entry);
    if (previousKey !== null && key !== previousKey) {
      targetChanges += 1;
    }
    previousKey = key;
    if (entry.sceneRevision !== null) {
      revisions.add(entry.sceneRevision);
    }
  }
  if (sample.sceneRevision !== null) {
    revisions.add(sample.sceneRevision);
  }
  const sceneRevisions = [...revisions].sort((a, b) => a - b);

  return {
    ok: true,
    anchor: {
      utteranceId: utterance.utteranceId ?? null,
      utteranceStartedAt: utterance.startedAt,
      utteranceEndedAt: utterance.endedAt,
      at: sample.at,
      skewMs: sample.at - utterance.endedAt,
      afterUtterance,
      scene,
      sceneId: scene.sceneId,
      sceneRevision: scene.revision,
      pointer: sample.pointer,
      insideWindow: sample.insideWindow,
      target: sample.pointer.accessibilityTarget ?? null,
      path,
      targetChanges,
      sceneRevisions,
      sceneChangedDuringUtterance: sceneRevisions.length > 1,
    },
  };
}

/**
 * Anchor-or-throw. Downstream code that cannot ground a question without a
 * pointer uses this so the failure reaches the user as a typed `PilotError`.
 */
export function requireQuestionAnchor(
  core: ObservationCore,
  utterance: UtteranceWindow,
  options: QuestionAnchorOptions = {},
): QuestionAnchor {
  const result = resolveQuestionAnchor(core, utterance, options);
  if (result.ok) {
    return result.anchor;
  }
  if (result.reason === 'no-scene') {
    throw new PilotError('observation-disabled', result.detail, {
      userMessage: 'Pilot is not observing a window right now.',
    });
  }
  throw new PilotError('frame-unavailable', result.detail, {
    userMessage: 'Pilot does not know where you were pointing when you asked.',
    retryable: true,
    details: {
      reason: result.reason,
      utteranceStartedAt: utterance.startedAt,
      utteranceEndedAt: utterance.endedAt,
    },
  });
}

/** Scene half of the question envelope (system-design §8). */
export function toEnvelopeScene(anchor: QuestionAnchor): QuestionEnvelope['scene'] {
  const { scene } = anchor;
  return {
    id: scene.sceneId,
    revision: scene.revision,
    ...(scene.lastObservedRevision === undefined
      ? {}
      : { lastObservedRevision: scene.lastObservedRevision }),
    windowTitle: scene.windowTitle,
  };
}

/**
 * Pointer half of the question envelope (system-design §8). Normalised
 * coordinates are passed through unclamped: a value outside `[0, 1]` means the
 * pointer was outside the window and must be reported as such.
 */
export function toEnvelopePointer(anchor: QuestionAnchor): QuestionEnvelope['pointer'] {
  const target = anchor.target;
  return {
    normalizedX: anchor.pointer.normalizedPoint.x,
    normalizedY: anchor.pointer.normalizedPoint.y,
    ...(target?.role === undefined ? {} : { targetRole: target.role }),
    ...(target?.label === undefined ? {} : { targetLabel: target.label }),
  };
}
