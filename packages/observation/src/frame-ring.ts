import {
  MVP_SCREEN_POLICY,
  PilotError,
  type CapturedFrame,
  type FrameId,
  type SceneId,
  type ScreenStatus,
} from '@pilot/shared';
import { toTimestamp, type Clock } from './clock.js';
import { matchesSceneScope, type SceneScope } from './scene-lineage.js';

/**
 * Bounded, memory-only frame ring (system-design §6, §13, §17).
 *
 * The ring exists to recover a state that may have disappeared between the
 * spoken question and the model's tool call. It is bounded on three axes at
 * once — age, total bytes and frame count — and it is never persisted, never
 * logged and never handed to the agent runtime directly.
 *
 * Bounds are enforced on every mutation *and* re-checked before every read, so
 * a frame that has aged out is not retrievable even if nothing has been pushed
 * since it expired.
 */

/** Three-second local buffer (mvp-01 §10 / system-design §10). */
export const DEFAULT_FRAME_MAX_AGE_MS = MVP_SCREEN_POLICY.ringDurationMs;

/** Configured byte ceiling (mvp-01 §10). */
export const DEFAULT_FRAME_MAX_BYTES = MVP_SCREEN_POLICY.ringByteLimit;

/**
 * Belt-and-braces count ceiling. At the policy sample rate (3 FPS) a
 * three-second ring holds ~9 frames; this only ever fires if a producer
 * misbehaves.
 */
export const DEFAULT_FRAME_MAX_COUNT = 256;

/** One retained frame plus the bookkeeping the ring needs. */
export interface FrameRecord {
  readonly frame: CapturedFrame;
  /** Mirror of `frame.capturedAt`; the ring is ordered by it. */
  readonly capturedAt: number;
  readonly byteLength: number;
  /** Clock reading when the ring accepted the frame. */
  readonly receivedAt: number;
  /**
   * Scene revision in force when the frame was ingested, stamped by the owner
   * (`ObservationCore`). `null` when the producer did not supply one.
   */
  readonly sceneRevision: number | null;
  /**
   * Scene the frame was captured for, stamped by the owner. Selection filters
   * on it so a frame from a previous window selection can never be returned
   * (system-design §10 step 3).
   */
  readonly sceneId: SceneId | null;
}

export type FrameRejectionReason =
  /** Older than the age bound at arrival; admitting it would be a no-op. */
  | 'stale'
  /** A single frame larger than the whole byte budget can never be held. */
  | 'too-large'
  /** `frameId` already present. */
  | 'duplicate'
  /** Zero-length payload: a frame with no pixels is not a usable anchor. */
  | 'empty-bytes';

export interface EvictionSummary {
  readonly byAge: number;
  readonly byBytes: number;
  readonly byCount: number;
  /** Total bytes released by this eviction pass. */
  readonly bytes: number;
}

export const NO_EVICTIONS: EvictionSummary = { byAge: 0, byBytes: 0, byCount: 0, bytes: 0 };

export type FrameAdmission =
  | {
      readonly admitted: true;
      readonly record: FrameRecord;
      readonly evicted: EvictionSummary;
    }
  | {
      readonly admitted: false;
      readonly reason: FrameRejectionReason;
      readonly detail: string;
      readonly evicted: EvictionSummary;
    };

export type FrameSelectionDirection = 'any' | 'at-or-before' | 'at-or-after';

export interface FrameSelectionQuery {
  /**
   * Restricts candidates relative to the requested moment. `'at-or-before'` is
   * what "the frame the user was looking at when they asked" wants;
   * `'at-or-after'` is the second half of a before-and-after comparison.
   */
  readonly direction?: FrameSelectionDirection;
  /**
   * Largest acceptable distance from the requested moment. Defaults to the
   * ring's age bound, so a query can never silently return a frame from a
   * different part of the session. Pass `Number.POSITIVE_INFINITY` to accept
   * whatever the ring holds.
   */
  readonly maxSkewMs?: number;
  /**
   * Restricts candidates to one scene. `ObservationCore` defaults it to the
   * current scene, so a caller holding a moment from a previous window
   * selection cannot be handed the new window's pixels. `'any'` opts out.
   */
  readonly scene?: SceneScope;
  /** Restricts candidates to frames captured at or after a scene revision. */
  readonly minSceneRevision?: number;
}

export type FrameSelectionFailure =
  /** The ring holds nothing at all. */
  | 'empty'
  /** Frames exist, but the closest is further away than `maxSkewMs`. */
  | 'out-of-range'
  /** Frames exist, but none on the requested side of the moment. */
  | 'no-frame-in-direction'
  /** Frames exist, but none belong to the requested scene or revision. */
  | 'scene-mismatch';

/**
 * Result of a nearest-frame lookup. Never `undefined`: callers switch on
 * `found` and always have a reason to report.
 */
export type FrameSelection =
  | {
      readonly found: true;
      readonly record: FrameRecord;
      /** `capturedAt - requestedAt`; negative when the frame precedes the moment. */
      readonly skewMs: number;
      /** Absolute distance, the value the selection minimised. */
      readonly distanceMs: number;
    }
  | {
      readonly found: false;
      readonly reason: FrameSelectionFailure;
      /** Distance of the closest candidate considered, when there was one. */
      readonly nearestDistanceMs: number | null;
      readonly frameCount: number;
    };

/** Content snapshot; shaped to feed `ScreenStatus.buffer` (system-design §5). */
export interface FrameBufferStats {
  readonly frameCount: number;
  readonly byteCount: number;
  readonly oldestFrameAt: number | null;
  readonly newestFrameAt: number | null;
}

/** Cumulative, content-free counters. Survive {@link FrameRing.clear}. */
export interface FrameRingMetrics {
  readonly admitted: number;
  readonly evictedByAge: number;
  readonly evictedByBytes: number;
  readonly evictedByCount: number;
  readonly rejected: Readonly<Record<FrameRejectionReason, number>>;
  readonly peakFrameCount: number;
  readonly peakByteCount: number;
  readonly clears: number;
}

export interface FrameRingConfig {
  /** Age bound in milliseconds. Default {@link DEFAULT_FRAME_MAX_AGE_MS}. */
  readonly maxAgeMs?: number;
  /** Total byte bound. Default {@link DEFAULT_FRAME_MAX_BYTES}. */
  readonly maxBytes?: number;
  /** Frame count bound. Default {@link DEFAULT_FRAME_MAX_COUNT}. */
  readonly maxFrames?: number;
}

export interface FrameRingOptions extends FrameRingConfig {
  readonly clock: Clock;
}

export interface FramePushOptions {
  readonly sceneRevision?: number;
  readonly sceneId?: SceneId;
}

function assertPositive(value: number, what: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PilotError('invalid-request', `${what} must be a positive finite number`, {
      userMessage: 'Pilot was configured with an unusable buffer bound.',
      details: { what, value },
    });
  }
  return value;
}

export class FrameRing {
  readonly #clock: Clock;
  readonly #maxAgeMs: number;
  readonly #maxBytes: number;
  readonly #maxFrames: number;

  /** Ascending by `capturedAt`; ties keep insertion order. */
  #records: FrameRecord[] = [];
  #byteCount = 0;

  #admitted = 0;
  #evictedByAge = 0;
  #evictedByBytes = 0;
  #evictedByCount = 0;
  #clears = 0;
  #peakFrameCount = 0;
  #peakByteCount = 0;
  readonly #rejected: Record<FrameRejectionReason, number> = {
    stale: 0,
    'too-large': 0,
    duplicate: 0,
    'empty-bytes': 0,
  };

  constructor(options: FrameRingOptions) {
    this.#clock = options.clock;
    this.#maxAgeMs = assertPositive(options.maxAgeMs ?? DEFAULT_FRAME_MAX_AGE_MS, 'maxAgeMs');
    this.#maxBytes = assertPositive(options.maxBytes ?? DEFAULT_FRAME_MAX_BYTES, 'maxBytes');
    this.#maxFrames = assertPositive(options.maxFrames ?? DEFAULT_FRAME_MAX_COUNT, 'maxFrames');
  }

  get maxAgeMs(): number {
    return this.#maxAgeMs;
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }

  get maxFrames(): number {
    return this.#maxFrames;
  }

  /**
   * Offers a frame to the ring. Returns an explicit admission result rather
   * than throwing: a producer pushing at 3 FPS must not be interrupted because
   * one frame arrived late or oversized.
   */
  push(frame: CapturedFrame, options: FramePushOptions = {}): FrameAdmission {
    const now = this.#clock.now();
    const ageEvictions = this.#pruneByAge(now);

    const byteLength = frame.bytes.byteLength;
    if (byteLength === 0) {
      return this.#reject('empty-bytes', 'Frame carries no bytes', ageEvictions);
    }
    if (byteLength > this.#maxBytes) {
      return this.#reject(
        'too-large',
        `Frame of ${String(byteLength)}B exceeds the ${String(this.#maxBytes)}B ring budget`,
        ageEvictions,
      );
    }
    if (this.#indexOfFrameId(frame.frameId) >= 0) {
      return this.#reject('duplicate', 'Frame is already in the ring', ageEvictions);
    }
    if (now - frame.capturedAt > this.#maxAgeMs) {
      return this.#reject(
        'stale',
        `Frame is ${String(now - frame.capturedAt)}ms old, past the ${String(this.#maxAgeMs)}ms bound`,
        ageEvictions,
      );
    }

    const record: FrameRecord = {
      frame,
      capturedAt: frame.capturedAt,
      byteLength,
      receivedAt: now,
      sceneRevision: options.sceneRevision ?? null,
      sceneId: options.sceneId ?? null,
    };
    this.#insert(record);
    this.#admitted += 1;

    const sizeEvictions = this.#pruneBySize(record);
    this.#recordPeaks();

    return {
      admitted: true,
      record,
      evicted: mergeEvictions(ageEvictions, sizeEvictions),
    };
  }

  /**
   * Nearest-frame selection — the "question moment" anchor lookup PR-019 builds
   * on.
   *
   * Ties (a frame exactly as far before the moment as another is after) resolve
   * to the **earlier** frame: what was on screen when the user spoke is a
   * safer anchor than what appeared afterwards.
   *
   * The scene filter is applied before the direction filter, so a query scoped
   * to a scene the ring holds nothing for reports `scene-mismatch` rather than
   * a misleading `no-frame-in-direction`.
   */
  select(requestedAt: number, query: FrameSelectionQuery = {}): FrameSelection {
    this.#pruneByAge(this.#clock.now());
    const direction = query.direction ?? 'any';
    const maxSkewMs = query.maxSkewMs ?? this.#maxAgeMs;

    let best: FrameRecord | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    let inScene = 0;

    for (const record of this.#records) {
      if (!matchesSceneScope(record, query)) {
        continue;
      }
      inScene += 1;
      if (direction === 'at-or-before' && record.capturedAt > requestedAt) {
        continue;
      }
      if (direction === 'at-or-after' && record.capturedAt < requestedAt) {
        continue;
      }
      const distance = Math.abs(record.capturedAt - requestedAt);
      // Strict `<` keeps the earliest record on a tie: the loop walks ascending.
      if (distance < bestDistance) {
        best = record;
        bestDistance = distance;
      }
    }

    if (best === undefined) {
      return {
        found: false,
        reason:
          this.#records.length === 0
            ? 'empty'
            : inScene === 0
              ? 'scene-mismatch'
              : 'no-frame-in-direction',
        nearestDistanceMs: null,
        frameCount: this.#records.length,
      };
    }
    if (bestDistance > maxSkewMs) {
      return {
        found: false,
        reason: 'out-of-range',
        nearestDistanceMs: bestDistance,
        frameCount: this.#records.length,
      };
    }
    return {
      found: true,
      record: best,
      skewMs: best.capturedAt - requestedAt,
      distanceMs: bestDistance,
    };
  }

  /** Newest retained frame, or `null` when the ring is empty. */
  newest(): FrameRecord | null {
    this.#pruneByAge(this.#clock.now());
    return this.#records[this.#records.length - 1] ?? null;
  }

  /** Oldest retained frame, or `null` when the ring is empty. */
  oldest(): FrameRecord | null {
    this.#pruneByAge(this.#clock.now());
    return this.#records[0] ?? null;
  }

  /** Every retained frame, oldest first. Empty array when the ring is empty. */
  records(): readonly FrameRecord[] {
    this.#pruneByAge(this.#clock.now());
    return [...this.#records];
  }

  has(frameId: FrameId): boolean {
    this.#pruneByAge(this.#clock.now());
    return this.#indexOfFrameId(frameId) >= 0;
  }

  stats(): FrameBufferStats {
    this.#pruneByAge(this.#clock.now());
    const oldest = this.#records[0];
    const newest = this.#records[this.#records.length - 1];
    return {
      frameCount: this.#records.length,
      byteCount: this.#byteCount,
      oldestFrameAt: oldest === undefined ? null : oldest.capturedAt,
      newestFrameAt: newest === undefined ? null : newest.capturedAt,
    };
  }

  metrics(): FrameRingMetrics {
    return {
      admitted: this.#admitted,
      evictedByAge: this.#evictedByAge,
      evictedByBytes: this.#evictedByBytes,
      evictedByCount: this.#evictedByCount,
      rejected: { ...this.#rejected },
      peakFrameCount: this.#peakFrameCount,
      peakByteCount: this.#peakByteCount,
      clears: this.#clears,
    };
  }

  /**
   * Drops every retained frame. Content-free counters survive so diagnostics
   * can still report how much was discarded.
   */
  clear(): { readonly frameCount: number; readonly byteCount: number } {
    const dropped = { frameCount: this.#records.length, byteCount: this.#byteCount };
    // Replace rather than truncate: no reference to a frame payload survives.
    this.#records = [];
    this.#byteCount = 0;
    this.#clears += 1;
    return dropped;
  }

  #reject(reason: FrameRejectionReason, detail: string, evicted: EvictionSummary): FrameAdmission {
    this.#rejected[reason] += 1;
    return { admitted: false, reason, detail, evicted };
  }

  #indexOfFrameId(frameId: FrameId): number {
    return this.#records.findIndex((record) => record.frame.frameId === frameId);
  }

  #insert(record: FrameRecord): void {
    const last = this.#records[this.#records.length - 1];
    if (last === undefined || last.capturedAt <= record.capturedAt) {
      this.#records.push(record);
    } else {
      // Out-of-order arrival: keep the array sorted so selection stays correct.
      let low = 0;
      let high = this.#records.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        const candidate = this.#records[mid];
        if (candidate !== undefined && candidate.capturedAt <= record.capturedAt) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      this.#records.splice(low, 0, record);
    }
    this.#byteCount += record.byteLength;
  }

  #removeAt(index: number): FrameRecord | undefined {
    const [removed] = this.#records.splice(index, 1);
    if (removed !== undefined) {
      this.#byteCount -= removed.byteLength;
    }
    return removed;
  }

  #pruneByAge(now: number): EvictionSummary {
    let byAge = 0;
    let bytes = 0;
    while (this.#records.length > 0) {
      const oldest = this.#records[0];
      if (oldest === undefined || now - oldest.capturedAt <= this.#maxAgeMs) {
        break;
      }
      this.#removeAt(0);
      byAge += 1;
      bytes += oldest.byteLength;
    }
    this.#evictedByAge += byAge;
    return { byAge, byBytes: 0, byCount: 0, bytes };
  }

  /**
   * Enforces the byte and count bounds by dropping the oldest record. `keep` is
   * never evicted: a newly admitted frame that happens to be the oldest in the
   * ring (out-of-order arrival) would otherwise be reported as admitted and
   * then vanish.
   */
  #pruneBySize(keep: FrameRecord): EvictionSummary {
    let byBytes = 0;
    let byCount = 0;
    let bytes = 0;

    const evictOldestOther = (): number => {
      const index = this.#records[0] === keep ? 1 : 0;
      const removed = this.#removeAt(index);
      return removed === undefined ? 0 : removed.byteLength;
    };

    while (this.#byteCount > this.#maxBytes && this.#records.length > 1) {
      bytes += evictOldestOther();
      byBytes += 1;
    }
    while (this.#records.length > this.#maxFrames && this.#records.length > 1) {
      bytes += evictOldestOther();
      byCount += 1;
    }

    this.#evictedByBytes += byBytes;
    this.#evictedByCount += byCount;
    return { byAge: 0, byBytes, byCount, bytes };
  }

  #recordPeaks(): void {
    this.#peakFrameCount = Math.max(this.#peakFrameCount, this.#records.length);
    this.#peakByteCount = Math.max(this.#peakByteCount, this.#byteCount);
  }
}

export function mergeEvictions(a: EvictionSummary, b: EvictionSummary): EvictionSummary {
  return {
    byAge: a.byAge + b.byAge,
    byBytes: a.byBytes + b.byBytes,
    byCount: a.byCount + b.byCount,
    bytes: a.bytes + b.bytes,
  };
}

/**
 * Projects the ring's content snapshot onto the `ScreenStatus.buffer` shape
 * PR-019 reports over IPC (which requires non-negative integers).
 */
export function toScreenStatusBuffer(stats: FrameBufferStats): ScreenStatus['buffer'] {
  return {
    frameCount: stats.frameCount,
    byteCount: stats.byteCount,
    oldestFrameAt: stats.oldestFrameAt === null ? null : toTimestamp(stats.oldestFrameAt),
    newestFrameAt: stats.newestFrameAt === null ? null : toTimestamp(stats.newestFrameAt),
  };
}
