import type { SceneId, SceneState, WindowId } from '@pilot/shared';
import type { SceneChangeKind, SceneEndReason, SceneTransition } from './scene-tracker.js';

/**
 * Scene lineage (system-design §6, §10 step 3, §15).
 *
 * `SceneTracker` knows the *current* scene. Lineage is the history around it:
 * which selection episodes there have been, which revisions each one went
 * through, and — the part everything downstream needs — whether a scene
 * reference someone is still holding is answerable.
 *
 * New revision vs. new scene
 * --------------------------
 * - A **revision** is a change *within* one selection: title, geometry,
 *   accessibility root or meaningful visual content. `sceneId` is unchanged, so
 *   frames and pointer samples captured at an earlier revision still belong to
 *   the same screen and remain answerable — the revision number tells the model
 *   how far the screen has moved since it last looked.
 * - A **scene** is one selection episode. Selecting a different window, losing
 *   the window, a screen lock or any other clear ends the episode; the next
 *   selection starts a new `sceneId` at revision 0. Nothing captured before
 *   that boundary may be answered from, which is why the buffers are cleared at
 *   the same moment and why {@link SceneLineage.check} refuses a superseded id.
 *
 * Lineage holds scene *metadata* only — ids, window ids, titles, fingerprints
 * and timestamps. No frames, no pointer samples, no pixels. It is bounded to
 * the last {@link DEFAULT_MAX_EPISODES} episodes and the last
 * {@link DEFAULT_MAX_REVISIONS_PER_EPISODE} revisions of each.
 */

export const DEFAULT_MAX_EPISODES = 8;
export const DEFAULT_MAX_REVISIONS_PER_EPISODE = 64;

export interface SceneRevisionRecord {
  readonly revision: number;
  readonly fingerprint: string;
  readonly windowTitle: string;
  /** Empty for revision 0, which starts the episode rather than changing it. */
  readonly changes: readonly SceneChangeKind[];
  readonly at: number;
}

export interface SceneEpisodeEnd {
  readonly reason: SceneEndReason;
  /** Free-form detail from the caller, e.g. the clear reason. */
  readonly detail: string | null;
  readonly at: number;
}

/** One selection episode: a `sceneId` and every revision it went through. */
export interface SceneEpisode {
  readonly sceneId: SceneId;
  readonly windowId: WindowId;
  /** Title at the latest recorded revision. */
  readonly windowTitle: string;
  readonly startedAt: number;
  readonly latestRevision: number;
  readonly lastObservedRevision: number | null;
  readonly revisions: readonly SceneRevisionRecord[];
  /** `null` while the episode is the current selection. */
  readonly end: SceneEpisodeEnd | null;
  /** The episode this one replaced, if it is still in the bounded history. */
  readonly previousSceneId: SceneId | null;
}

/**
 * Scene restriction for a buffer query. A `SceneId` admits only records
 * captured for that scene; `'any'` is the explicit opt-out used by diagnostics
 * that want to see the raw buffer.
 */
export type SceneScope = SceneId | 'any';

/** Anything the buffers stamp with the scene in force when it was recorded. */
export interface SceneStamped {
  readonly sceneId: SceneId | null;
  readonly sceneRevision: number | null;
}

export interface SceneScopeQuery {
  readonly scene?: SceneScope;
  readonly minSceneRevision?: number;
}

/**
 * Scene filter shared by the frame ring and the pointer timeline. An unstamped
 * record (`sceneId === null`) is admitted only when the query does not name a
 * scene: nothing that predates scene stamping may satisfy a scoped query.
 */
export function matchesSceneScope(record: SceneStamped, query: SceneScopeQuery): boolean {
  const scope = query.scene;
  if (scope !== undefined && scope !== 'any' && record.sceneId !== scope) {
    return false;
  }
  const minRevision = query.minSceneRevision;
  if (minRevision !== undefined && (record.sceneRevision ?? -1) < minRevision) {
    return false;
  }
  return true;
}

/** A scene reference held by a question, a tool call or a pending result. */
export interface SceneRef {
  readonly sceneId: SceneId;
  /** Omit to ask only about scene identity. */
  readonly revision?: number;
}

export type SceneLineageStatus =
  /** The current scene at its current revision. */
  | 'current'
  /** The current scene, but the screen has moved on since. */
  | 'stale-revision'
  /** A revision this scene has never reached. */
  | 'future-revision'
  /** A scene that is no longer the selected one. */
  | 'superseded'
  /** Never recorded, or evicted from the bounded history. */
  | 'unknown';

export type SceneLineageCheck =
  | {
      /** True when the reference belongs to the current selection. */
      readonly ok: true;
      readonly status: 'current' | 'stale-revision';
      readonly episode: SceneEpisode;
      readonly currentRevision: number;
      /** How many revisions the reference is behind. */
      readonly revisionsBehind: number;
    }
  | {
      readonly ok: false;
      readonly status: 'future-revision' | 'superseded' | 'unknown';
      readonly episode: SceneEpisode | null;
      readonly detail: string;
    };

export interface SceneLineageConfig {
  readonly maxEpisodes?: number;
  readonly maxRevisionsPerEpisode?: number;
}

interface MutableEpisode {
  readonly sceneId: SceneId;
  readonly windowId: WindowId;
  windowTitle: string;
  readonly startedAt: number;
  latestRevision: number;
  lastObservedRevision: number | null;
  revisions: SceneRevisionRecord[];
  end: SceneEpisodeEnd | null;
  readonly previousSceneId: SceneId | null;
}

function freeze(episode: MutableEpisode): SceneEpisode {
  return {
    sceneId: episode.sceneId,
    windowId: episode.windowId,
    windowTitle: episode.windowTitle,
    startedAt: episode.startedAt,
    latestRevision: episode.latestRevision,
    lastObservedRevision: episode.lastObservedRevision,
    revisions: [...episode.revisions],
    end: episode.end === null ? null : { ...episode.end },
    previousSceneId: episode.previousSceneId,
  };
}

export class SceneLineage {
  readonly #maxEpisodes: number;
  readonly #maxRevisions: number;

  /** Oldest first. The last entry is the current episode when it is open. */
  #episodes: MutableEpisode[] = [];

  constructor(config: SceneLineageConfig = {}) {
    this.#maxEpisodes = Math.max(1, config.maxEpisodes ?? DEFAULT_MAX_EPISODES);
    this.#maxRevisions = Math.max(
      1,
      config.maxRevisionsPerEpisode ?? DEFAULT_MAX_REVISIONS_PER_EPISODE,
    );
  }

  /** The open episode, or `null` when no window is selected. */
  get current(): SceneEpisode | null {
    const last = this.#episodes[this.#episodes.length - 1];
    if (last === undefined || last.end !== null) {
      return null;
    }
    return freeze(last);
  }

  /** Every retained episode, newest first. */
  episodes(): readonly SceneEpisode[] {
    return [...this.#episodes].reverse().map(freeze);
  }

  get(sceneId: SceneId): SceneEpisode | null {
    const found = this.#find(sceneId);
    return found === undefined ? null : freeze(found);
  }

  revision(sceneId: SceneId, revision: number): SceneRevisionRecord | null {
    return this.#find(sceneId)?.revisions.find((entry) => entry.revision === revision) ?? null;
  }

  /**
   * Chain of scene ids from the current episode backwards, newest first. The
   * chain stops where the bounded history does.
   */
  chain(): readonly SceneId[] {
    return [...this.#episodes].reverse().map((episode) => episode.sceneId);
  }

  /**
   * Answers whether a held scene reference may still be answered from — the
   * lineage validation PR-019 performs before it selects anything, and the
   * check that keeps a stale window selection out of an answer.
   */
  check(ref: SceneRef): SceneLineageCheck {
    const episode = this.#find(ref.sceneId);
    if (episode === undefined) {
      return {
        ok: false,
        status: 'unknown',
        episode: null,
        detail: 'Scene is not in the retained lineage',
      };
    }
    if (episode.end !== null) {
      return {
        ok: false,
        status: 'superseded',
        episode: freeze(episode),
        detail: `Scene ended (${episode.end.reason}${
          episode.end.detail === null ? '' : `: ${episode.end.detail}`
        })`,
      };
    }
    const revision = ref.revision ?? episode.latestRevision;
    if (revision > episode.latestRevision) {
      return {
        ok: false,
        status: 'future-revision',
        episode: freeze(episode),
        detail: `Scene has never reached revision ${String(revision)}`,
      };
    }
    return {
      ok: true,
      status: revision === episode.latestRevision ? 'current' : 'stale-revision',
      episode: freeze(episode),
      currentRevision: episode.latestRevision,
      revisionsBehind: episode.latestRevision - revision,
    };
  }

  /** Records a transition from the scene tracker. `at` comes from the clock. */
  record(transition: SceneTransition, at: number): void {
    switch (transition.kind) {
      case 'started': {
        this.#endOpen('deselected', null, at);
        const previous = this.#episodes[this.#episodes.length - 1];
        this.#episodes.push({
          sceneId: transition.scene.sceneId,
          windowId: transition.scene.windowId,
          windowTitle: transition.scene.windowTitle,
          startedAt: transition.scene.updatedAt,
          latestRevision: transition.scene.revision,
          lastObservedRevision: transition.scene.lastObservedRevision ?? null,
          revisions: [
            {
              revision: transition.scene.revision,
              fingerprint: transition.scene.fingerprint,
              windowTitle: transition.scene.windowTitle,
              changes: [],
              at: transition.scene.updatedAt,
            },
          ],
          end: null,
          previousSceneId: previous?.sceneId ?? null,
        });
        this.#pruneEpisodes();
        return;
      }
      case 'revised': {
        const episode = this.#find(transition.scene.sceneId);
        if (episode === undefined) {
          return;
        }
        episode.latestRevision = transition.scene.revision;
        episode.windowTitle = transition.scene.windowTitle;
        episode.revisions.push({
          revision: transition.scene.revision,
          fingerprint: transition.scene.fingerprint,
          windowTitle: transition.scene.windowTitle,
          changes: [...transition.changes],
          at: transition.scene.updatedAt,
        });
        if (episode.revisions.length > this.#maxRevisions) {
          episode.revisions = episode.revisions.slice(-this.#maxRevisions);
        }
        return;
      }
      case 'ended': {
        const episode = this.#find(transition.previous.sceneId);
        if (episode !== undefined && episode.end === null) {
          episode.end = { reason: transition.reason, detail: null, at };
        }
        return;
      }
      case 'idle':
      case 'unchanged':
        return;
    }
  }

  /** Ends the open episode with an explicit reason and caller detail. */
  end(reason: SceneEndReason, detail: string | null, at: number): void {
    this.#endOpen(reason, detail, at);
  }

  /** Mirrors `SceneTracker.markObserved` so lineage can report observed state. */
  markObserved(scene: SceneState): void {
    const episode = this.#find(scene.sceneId);
    if (episode !== undefined) {
      episode.lastObservedRevision = scene.lastObservedRevision ?? scene.revision;
    }
  }

  /** Drops the whole history. Used on shutdown. */
  reset(): void {
    this.#episodes = [];
  }

  #find(sceneId: SceneId): MutableEpisode | undefined {
    return this.#episodes.find((episode) => episode.sceneId === sceneId);
  }

  #endOpen(reason: SceneEndReason, detail: string | null, at: number): void {
    const last = this.#episodes[this.#episodes.length - 1];
    if (last !== undefined && last.end === null) {
      last.end = { reason, detail, at };
    }
  }

  #pruneEpisodes(): void {
    if (this.#episodes.length > this.#maxEpisodes) {
      this.#episodes = this.#episodes.slice(-this.#maxEpisodes);
    }
  }
}
