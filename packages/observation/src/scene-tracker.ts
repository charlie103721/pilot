import {
  createIdFactory,
  type IdFactory,
  type ObservedWindow,
  type SceneState,
  type WindowGeometry,
} from '@pilot/shared';
import { toTimestamp, type Clock } from './clock.js';
import { fnv1a32 } from './hashing.js';

/**
 * Scene identity and revision tracking (system-design §6).
 *
 * > A revision changes when the selected window, geometry, accessibility root,
 * > or meaningful visual content changes.
 *
 * Identity and revision are two different things and are tracked as such:
 *
 * - **Identity** (`sceneId`) changes only when the *selection* changes. A new
 *   scene starts at revision 0. Because `isSameSceneLineage` compares
 *   `sceneId` **and** `windowId`, a fresh id is what lets PR-019 reject a
 *   result produced for a previous selection.
 * - **Revision** increments within one scene whenever any tracked signal
 *   changes. It is lightweight metadata attached to a question; it never
 *   triggers an upload by itself.
 */

export type SceneChangeKind = 'window' | 'title' | 'geometry' | 'accessibility-root' | 'content';

export const SCENE_CHANGE_KINDS: readonly SceneChangeKind[] = [
  'window',
  'title',
  'geometry',
  'accessibility-root',
  'content',
];

export type SceneEndReason = 'deselected' | 'window-closed' | 'cleared';

/** Everything the tracker fingerprints. */
export interface SceneSignals {
  readonly window: ObservedWindow;
  /**
   * Capture geometry. Optional because window bounds alone already move the
   * fingerprint; supplying it also catches capture-size and scale changes.
   */
  readonly geometry?: WindowGeometry;
  /**
   * Stable identifier for the window's accessibility root, as reported by the
   * platform (PR-013). Any opaque string works; the tracker only compares it.
   */
  readonly accessibilityRootId?: string;
  /**
   * Digest of *meaningful* visual content, produced by whoever can judge
   * meaningfulness (PR-016/PR-018). The tracker deliberately does not compute
   * one from frame bytes: every decoded pixel would move it.
   */
  readonly contentFingerprint?: string;
}

/** Partial update to the signals of the currently selected window. */
export interface SceneSignalsPatch {
  readonly window?: ObservedWindow;
  readonly geometry?: WindowGeometry;
  readonly accessibilityRootId?: string;
  readonly contentFingerprint?: string;
}

export type SceneTransition =
  /** Nothing is selected and nothing changed. */
  | { readonly kind: 'idle' }
  /** A new scene began; `previous` is the scene it replaced, if any. */
  | {
      readonly kind: 'started';
      readonly scene: SceneState;
      readonly previous: SceneState | null;
    }
  /** The same scene at a new revision. */
  | {
      readonly kind: 'revised';
      readonly scene: SceneState;
      readonly previous: SceneState;
      readonly changes: readonly SceneChangeKind[];
    }
  /** Signals re-evaluated, nothing moved. */
  | { readonly kind: 'unchanged'; readonly scene: SceneState }
  /** The selection went away. */
  | {
      readonly kind: 'ended';
      readonly previous: SceneState;
      readonly reason: SceneEndReason;
    };

export interface SceneTrackerOptions {
  readonly clock: Clock;
  /** Inject a counter-backed factory for reproducible scene ids in tests. */
  readonly ids?: IdFactory;
}

interface SceneComponents {
  readonly window: string;
  readonly title: string;
  readonly geometry: string;
  readonly 'accessibility-root': string;
  readonly content: string;
}

function componentsOf(signals: SceneSignals): SceneComponents {
  const { window, geometry } = signals;
  const bounds = geometry?.bounds ?? window.bounds;
  const captureSize = geometry?.captureSize;
  return {
    window: window.windowId,
    title: window.title,
    geometry: [
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      geometry?.scaleFactor ?? window.scaleFactor,
      captureSize?.width ?? '',
      captureSize?.height ?? '',
      window.displayId,
    ].join(':'),
    'accessibility-root': signals.accessibilityRootId ?? '',
    content: signals.contentFingerprint ?? '',
  };
}

function fingerprintOf(components: SceneComponents): string {
  const joined = SCENE_CHANGE_KINDS.map((kind) => `${kind}=${components[kind]}`).join('|');
  return `sc_${fnv1a32(joined)}`;
}

function diff(before: SceneComponents, after: SceneComponents): readonly SceneChangeKind[] {
  return SCENE_CHANGE_KINDS.filter((kind) => before[kind] !== after[kind]);
}

export class SceneTracker {
  readonly #clock: Clock;
  readonly #ids: IdFactory;

  #scene: SceneState | null = null;
  #signals: SceneSignals | null = null;
  #components: SceneComponents | null = null;

  constructor(options: SceneTrackerOptions) {
    this.#clock = options.clock;
    this.#ids = options.ids ?? createIdFactory();
  }

  /** Current scene, or `null` when no window is selected. */
  get current(): SceneState | null {
    return this.#scene;
  }

  /** Signals behind the current scene, for callers that need to re-derive. */
  get signals(): SceneSignals | null {
    return this.#signals;
  }

  /**
   * Declares the selected window. Selecting a different window starts a new
   * scene at revision 0; re-declaring the same window is treated as an update.
   */
  select(signals: SceneSignals): SceneTransition {
    const current = this.#scene;
    if (current !== null && current.windowId === signals.window.windowId) {
      return this.#apply(signals);
    }

    const components = componentsOf(signals);
    const scene: SceneState = {
      sceneId: this.#ids.scene(),
      revision: 0,
      windowId: signals.window.windowId,
      windowTitle: signals.window.title,
      fingerprint: fingerprintOf(components),
      updatedAt: toTimestamp(this.#clock.now()),
    };
    this.#scene = scene;
    this.#signals = signals;
    this.#components = components;
    return { kind: 'started', scene, previous: current };
  }

  /**
   * Updates part of the current scene's signals. A patch carrying a different
   * window is a new selection and is routed through {@link select}.
   */
  update(patch: SceneSignalsPatch): SceneTransition {
    const signals = this.#signals;
    if (signals === null) {
      return { kind: 'idle' };
    }

    const window = patch.window ?? signals.window;
    const geometry = patch.geometry ?? signals.geometry;
    const accessibilityRootId = patch.accessibilityRootId ?? signals.accessibilityRootId;
    const contentFingerprint = patch.contentFingerprint ?? signals.contentFingerprint;
    const merged: SceneSignals = {
      window,
      ...(geometry === undefined ? {} : { geometry }),
      ...(accessibilityRootId === undefined ? {} : { accessibilityRootId }),
      ...(contentFingerprint === undefined ? {} : { contentFingerprint }),
    };

    if (window.windowId !== signals.window.windowId) {
      return this.select(merged);
    }
    return this.#apply(merged);
  }

  /**
   * Records that the model has seen a revision of the current scene, so
   * `isSceneObserved` can tell a stale scene from a fresh one.
   */
  markObserved(revision?: number): SceneState | null {
    const scene = this.#scene;
    if (scene === null) {
      return null;
    }
    const updated: SceneState = { ...scene, lastObservedRevision: revision ?? scene.revision };
    this.#scene = updated;
    return updated;
  }

  /** Drops the selection. Idempotent. */
  end(reason: SceneEndReason): SceneTransition {
    const previous = this.#scene;
    this.#scene = null;
    this.#signals = null;
    this.#components = null;
    if (previous === null) {
      return { kind: 'idle' };
    }
    return { kind: 'ended', previous, reason };
  }

  /** Alias used by the deterministic clear path. */
  clear(): SceneTransition {
    return this.end('cleared');
  }

  #apply(signals: SceneSignals): SceneTransition {
    const previous = this.#scene;
    const previousComponents = this.#components;
    if (previous === null || previousComponents === null) {
      return this.select(signals);
    }

    const components = componentsOf(signals);
    const changes = diff(previousComponents, components);
    this.#signals = signals;
    if (changes.length === 0) {
      return { kind: 'unchanged', scene: previous };
    }

    this.#components = components;
    const scene: SceneState = {
      ...previous,
      revision: previous.revision + 1,
      windowTitle: signals.window.title,
      fingerprint: fingerprintOf(components),
      updatedAt: toTimestamp(this.#clock.now()),
    };
    this.#scene = scene;
    return { kind: 'revised', scene, previous, changes };
  }
}
