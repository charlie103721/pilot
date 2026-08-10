import {
  asSceneId,
  buildGroundedPointer,
  isPointerInsideWindow,
  normalizedToScreen,
  type AccessibilityNode,
  type NormalizedPoint,
  type ObservedWindow,
  type SceneState,
  type WindowGeometry,
} from '@pilot/shared';
import {
  FAKE_EPOCH_MS,
  FIXTURE_ACCESSIBILITY_NODE,
  FIXTURE_GEOMETRY_RETINA,
  FIXTURE_SECURE_NODE,
  FIXTURE_WINDOW_RETINA,
} from '@pilot/platform/fakes';
import type { PointerAnchorSample } from './ports.js';

/**
 * Recorded pointer timelines for question anchoring (PR-024).
 *
 * `docs/implementation.md` asks PR-024 to "create envelopes from recorded
 * pointer timelines", so the recordings are data, not a live capture: every
 * timestamp is derived from `startedAt`, so two runs are identical and the demo
 * and the tests replay exactly the same utterances.
 *
 * The window, geometry and accessibility fixtures come from
 * `@pilot/platform/fakes`, so a sample here carries the same identities it
 * carries everywhere else in the repo. Coordinates are produced by the one
 * geometry module through `buildGroundedPointer`, so an "outside the window"
 * sample is genuinely outside — nothing is hand-written.
 */

export const RECORDING_EPOCH_MS = FAKE_EPOCH_MS;
/** Push-to-talk down. */
export const RECORDING_UTTERANCE_STARTED_AT = RECORDING_EPOCH_MS;
/** Push-to-talk up — the grounding instant (system-design §6). */
export const RECORDING_UTTERANCE_ENDED_AT = RECORDING_EPOCH_MS + 1_800;

export interface RecordPointerPathOptions {
  readonly window?: ObservedWindow;
  readonly geometry?: WindowGeometry;
  readonly startedAt?: number;
  readonly durationMs?: number;
  /** Sample rate before coalescing; the policy value is 30 Hz. */
  readonly hz?: number;
  /** Normalised start and end of the path. Values outside `[0,1]` are legal. */
  readonly from?: NormalizedPoint;
  readonly to?: NormalizedPoint;
  /** Accessibility element reported once `progress >= targetFrom`. */
  readonly target?: AccessibilityNode;
  readonly targetFrom?: number;
  /** Scene revision stamped on each sample, by path progress. */
  readonly sceneRevision?: number | ((progress: number) => number);
}

/**
 * One straight, evenly sampled pointer path.
 *
 * Deliberately dumb: a linear interpolation at a fixed rate. Anchoring must not
 * depend on the shape of the path, only on where the pointer was at the moment
 * the utterance ended.
 */
export function recordPointerPath(
  options: RecordPointerPathOptions = {},
): readonly PointerAnchorSample[] {
  const window = options.window ?? FIXTURE_WINDOW_RETINA;
  const geometry = options.geometry ?? FIXTURE_GEOMETRY_RETINA;
  const startedAt = options.startedAt ?? RECORDING_UTTERANCE_STARTED_AT;
  const durationMs = options.durationMs ?? 1_800;
  const hz = options.hz ?? 30;
  const from = options.from ?? { x: 0.2, y: 0.25 };
  const to = options.to ?? { x: 0.6, y: 0.6 };
  const targetFrom = options.targetFrom ?? 0.9;
  const revision = options.sceneRevision;

  const count = Math.floor((durationMs * hz) / 1000) + 1;
  return Array.from({ length: count }, (_unused, index) => {
    const progress = count === 1 ? 1 : index / (count - 1);
    const screenPoint = normalizedToScreen(
      {
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
      },
      geometry,
    );
    const node =
      options.target !== undefined && progress >= targetFrom ? options.target : undefined;
    const pointer = buildGroundedPointer(screenPoint, geometry, node);
    const sceneRevision =
      revision === undefined ? null : typeof revision === 'number' ? revision : revision(progress);
    return {
      at: startedAt + Math.round((index * 1000) / hz),
      windowId: window.windowId,
      pointer,
      insideWindow: isPointerInsideWindow(pointer),
      sceneRevision,
    } satisfies PointerAnchorSample;
  });
}

function scene(overrides: Partial<SceneState> = {}): SceneState {
  return {
    sceneId: asSceneId('scene-recorded'),
    revision: 4,
    windowId: FIXTURE_WINDOW_RETINA.windowId,
    windowTitle: FIXTURE_WINDOW_RETINA.title,
    fingerprint: 'fingerprint-recorded',
    lastObservedRevision: 4,
    updatedAt: RECORDING_EPOCH_MS,
    ...overrides,
  };
}

export interface RecordedUtterance {
  readonly name: string;
  /** One line explaining what the recording is there to exercise. */
  readonly description: string;
  readonly transcript: string;
  readonly window: ObservedWindow | null;
  readonly scene: SceneState | null;
  readonly samples: readonly PointerAnchorSample[];
  readonly utteranceStartedAt: number;
  readonly askedAt: number;
}

function utterance(
  name: string,
  description: string,
  transcript: string,
  parts: Partial<Omit<RecordedUtterance, 'name' | 'description' | 'transcript'>> = {},
): RecordedUtterance {
  return {
    name,
    description,
    transcript,
    window: parts.window === undefined ? FIXTURE_WINDOW_RETINA : parts.window,
    scene: parts.scene === undefined ? scene() : parts.scene,
    samples: parts.samples ?? recordPointerPath({ target: FIXTURE_ACCESSIBILITY_NODE }),
    utteranceStartedAt: parts.utteranceStartedAt ?? RECORDING_UTTERANCE_STARTED_AT,
    askedAt: parts.askedAt ?? RECORDING_UTTERANCE_ENDED_AT,
  };
}

/** Pointer settles on the toggle and stays there. The ordinary case. */
export const RECORDED_POINT_AND_ASK = utterance(
  'point-and-ask',
  'The pointer rests on an accessibility element inside the selected window.',
  'What is this?',
);

/** Pointer drifts off the window before the user releases push-to-talk. */
export const RECORDED_POINTER_OUTSIDE_WINDOW = utterance(
  'pointer-outside-window',
  'The pointer leaves the selected window before the utterance ends.',
  'And what about that one?',
  {
    samples: recordPointerPath({
      from: { x: 0.4, y: 0.4 },
      to: { x: 1.6, y: 0.5 },
      target: FIXTURE_ACCESSIBILITY_NODE,
      targetFrom: 0,
    }),
  },
);

/** Inside the window, but the platform reported no element under the pointer. */
export const RECORDED_NO_ACCESSIBILITY_TARGET = utterance(
  'no-accessibility-target',
  'The pointer is inside the window but no accessibility element is reported.',
  'What does this page say?',
  { samples: recordPointerPath({}) },
);

/** The window repaints halfway through the question. */
export const RECORDED_SCENE_REVISED_MID_UTTERANCE = utterance(
  'scene-revised-mid-utterance',
  'The scene is revised while the user is still speaking.',
  'Why did that just change?',
  {
    scene: scene({ revision: 6, lastObservedRevision: 6 }),
    samples: recordPointerPath({
      target: FIXTURE_ACCESSIBILITY_NODE,
      sceneRevision: (progress) => (progress < 0.5 ? 4 : progress < 0.8 ? 5 : 6),
    }),
  },
);

/** The model's last observation is two revisions behind the live scene. */
export const RECORDED_STALE_LAST_OBSERVED_REVISION = utterance(
  'stale-last-observed-revision',
  'The model last saw revision 2 of a scene now at revision 7.',
  'Is it done yet?',
  {
    scene: scene({ revision: 7, lastObservedRevision: 2 }),
    samples: recordPointerPath({ target: FIXTURE_ACCESSIBILITY_NODE, sceneRevision: 7 }),
  },
);

/** Nothing was recorded — observation had only just started. */
export const RECORDED_NO_POINTER_SAMPLES = utterance(
  'no-pointer-samples',
  'No pointer sample exists for the utterance at all.',
  'What am I looking at?',
  { samples: [] },
);

/** The only samples are far older than the utterance. */
export const RECORDED_POINTER_TOO_OLD = utterance(
  'pointer-too-old',
  'The newest pointer sample predates the utterance by more than the skew budget.',
  'What is this?',
  {
    samples: recordPointerPath({
      startedAt: RECORDING_EPOCH_MS - 20_000,
      durationMs: 500,
      target: FIXTURE_ACCESSIBILITY_NODE,
      targetFrom: 0,
    }),
  },
);

/** A text-only conversation: nothing is being observed. */
export const RECORDED_NO_SELECTED_WINDOW = utterance(
  'no-selected-window',
  'A typed question with no window selected and nothing observed.',
  'Remind me what we decided earlier.',
  { window: null, scene: null, samples: [] },
);

/** The pointer rests on a secure text field; its value must never travel. */
export const RECORDED_SECURE_FIELD = utterance(
  'secure-field',
  'The pointer rests on a password field.',
  'What goes in here?',
  { samples: recordPointerPath({ target: FIXTURE_SECURE_NODE, targetFrom: 0 }) },
);

/** Every recording, in demo order. */
export const RECORDED_UTTERANCES: readonly RecordedUtterance[] = [
  RECORDED_POINT_AND_ASK,
  RECORDED_POINTER_OUTSIDE_WINDOW,
  RECORDED_NO_ACCESSIBILITY_TARGET,
  RECORDED_SCENE_REVISED_MID_UTTERANCE,
  RECORDED_STALE_LAST_OBSERVED_REVISION,
  RECORDED_NO_POINTER_SAMPLES,
  RECORDED_POINTER_TOO_OLD,
  RECORDED_NO_SELECTED_WINDOW,
  RECORDED_SECURE_FIELD,
];
