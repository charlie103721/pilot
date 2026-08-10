import type { CapturedFrame, FrameEncoding, PixelSize } from '@pilot/shared';
import { fnv1a32Bytes, mixNumber, toHex32 } from './hashing.js';

/**
 * Content fingerprint — the "meaningful visual content" component of a scene
 * revision (system-design §6).
 *
 * PR-004 deliberately left `SceneSignals.contentFingerprint` to whoever can
 * judge meaningfulness, for one reason: a digest of the frame payload moves on
 * *every* frame (a blinking caret, encoder noise, one repainted pixel), and a
 * scene revision that advances three times a second is worthless — every
 * question would report the model's last observation as stale. Equally, never
 * moving is worse: the model would answer a changed screen from an old
 * observation.
 *
 * The rule
 * --------
 * 1. Each captured frame is cut into content-defined chunks with a Gear
 *    rolling hash (average {@link DEFAULT_CHUNK_TARGET_BYTES} bytes). Chunk
 *    boundaries follow the bytes, not fixed offsets, so inserting or removing
 *    bytes re-synchronises instead of shifting every later chunk.
 * 2. Each chunk is hashed (FNV-1a 32). The frame's *signature* is the set of
 *    its chunk hashes plus its encoding, capture size and payload length.
 * 3. A frame is compared against the **anchor** — the last frame that minted a
 *    fingerprint, not the previous frame. `changeRatio = 1 - shared/largest`.
 *    Comparing against the anchor is what catches slow drift: a screen that
 *    scrolls one line per frame never trips a frame-to-frame comparison but
 *    does trip an anchor comparison once enough has moved.
 * 4. `changeRatio >= threshold` (default {@link DEFAULT_CONTENT_CHANGE_THRESHOLD})
 *    mints a new fingerprint and makes that frame the new anchor. A change of
 *    encoding or capture size always mints: signatures from different encoders
 *    or capture sizes are not comparable, and pretending otherwise would hide
 *    a real change.
 * 5. The fingerprint value is a digest of the anchor's own signature, so the
 *    same visual content produces the same token in every process and run.
 *
 * The threshold is biased towards *over*-reporting: a false positive costs one
 * extra observation, a false negative lets the model answer from a screen that
 * no longer exists.
 *
 * What this rule cannot detect
 * ----------------------------
 * - **Small-area, high-meaning changes.** A toggle flipping, one digit
 *   changing, a swapped word: a few chunks at most, far below the threshold.
 *   This is the important blind spot — it is exactly the change a user is most
 *   likely to ask about. Accessibility signals (the root id and the pointer
 *   target) and the window title are separate revision components precisely
 *   because they catch some of these; nothing here does.
 * - **Position sensitivity in entropy-coded formats.** A JPEG's bit stream is
 *   not byte-aligned, so a change near the top of the window desynchronises the
 *   rest of the payload and reads as a large change, while the identical change
 *   near the bottom reads as a small one. Sensitivity is therefore not uniform
 *   across the window.
 * - **Uncompressed (`bgra`) frames**, where the metric degenerates to a coarse
 *   area comparison: a small region changing touches few chunks whatever it
 *   means.
 * - **Non-deterministic encoders.** Variable quantisation or a hardware
 *   encoder can re-encode an unchanged screen into different bytes; the rule
 *   then reports change that is not visible. Same for video, animations and
 *   any continuously repainting region: the revision advances continuously and
 *   `lastObservedRevision` is permanently behind.
 * - **Anything between samples.** Frames arrive at the policy rate (2–3 FPS);
 *   content that appears and disappears inside one sample interval is invisible
 *   here, which is what the frame ring — not the fingerprint — exists for.
 * - **Semantics of any kind.** The fingerprint says "how much of the payload
 *   changed", never what changed or where. It must never be used to decide
 *   redaction, privacy or policy.
 */

/** Average content-defined chunk size, in bytes. */
export const DEFAULT_CHUNK_TARGET_BYTES = 256;

/**
 * Fraction of the payload that must differ from the anchor before the content
 * counts as meaningfully changed. PR-017 may re-tune this from policy.
 */
export const DEFAULT_CONTENT_CHANGE_THRESHOLD = 0.15;

export interface ContentFingerprintConfig {
  /** Average chunk size. Smaller = finer resolution, more hashing. */
  readonly chunkTargetBytes?: number;
  /** Change ratio at or above which a new fingerprint is minted. */
  readonly changeThreshold?: number;
}

/** Comparable summary of one frame's encoded payload. */
export interface ContentSignature {
  readonly encoding: FrameEncoding;
  readonly captureSize: PixelSize;
  readonly byteLength: number;
  /** Content-defined chunk hashes. */
  readonly chunks: ReadonlySet<number>;
  /** Stable digest of everything above. */
  readonly digest: string;
}

export type ContentChangeReason =
  /** Nothing to compare against yet. */
  | 'first-frame'
  /** Encoding changed; signatures are not comparable. */
  | 'encoding-changed'
  /** Capture size changed; signatures are not comparable. */
  | 'capture-size-changed'
  /** Enough of the payload differs from the anchor. */
  | 'content-changed'
  /** Below the threshold: noise, not a new revision. */
  | 'below-threshold';

export interface ContentFingerprintUpdate {
  /** Fingerprint in force after this frame. */
  readonly fingerprint: string;
  /** True when this frame minted a new fingerprint. */
  readonly changed: boolean;
  readonly reason: ContentChangeReason;
  /** 0 = identical to the anchor, 1 = shares nothing with it. */
  readonly changeRatio: number;
  readonly threshold: number;
  readonly chunkCount: number;
}

/** Cumulative, content-free counters. */
export interface ContentFingerprintMetrics {
  readonly framesExamined: number;
  readonly fingerprintsMinted: number;
  readonly belowThreshold: number;
  readonly resets: number;
}

/**
 * Gear table for the rolling hash. Generated from a fixed seed so every
 * process cuts the same payload at the same boundaries.
 */
const GEAR: Uint32Array = (() => {
  const table = new Uint32Array(256);
  let state = 0x9e3779b9;
  for (let index = 0; index < table.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    table[index] = state;
  }
  return table;
})();

const ENCODING_ORDER: readonly FrameEncoding[] = ['jpeg', 'png', 'bgra'];

function normalizeChunkTarget(value: number): number {
  if (!Number.isFinite(value) || value < 16) {
    return DEFAULT_CHUNK_TARGET_BYTES;
  }
  // Round to a power of two so the cut mask is exactly `target - 1` bits wide.
  const bits = Math.max(4, Math.round(Math.log2(value)));
  return 2 ** bits;
}

/**
 * Cuts `bytes` into content-defined chunks and returns their hashes. One pass,
 * no allocation per chunk beyond the hash itself.
 */
export function chunkHashes(bytes: Uint8Array, chunkTargetBytes: number): number[] {
  const target = normalizeChunkTarget(chunkTargetBytes);
  const mask = target - 1;
  const minChunk = Math.max(16, target >> 2);
  const maxChunk = target << 2;

  const hashes: number[] = [];
  let start = 0;
  let roll = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    roll = ((roll << 1) + (GEAR[bytes[index] ?? 0] ?? 0)) >>> 0;
    const length = index - start + 1;
    if ((length >= minChunk && (roll & mask) === 0) || length >= maxChunk) {
      hashes.push(fnv1a32Bytes(bytes, start, index + 1));
      start = index + 1;
      roll = 0;
    }
  }
  if (start < bytes.length) {
    hashes.push(fnv1a32Bytes(bytes, start, bytes.length));
  }
  return hashes;
}

function digestOf(
  encoding: FrameEncoding,
  captureSize: PixelSize,
  byteLength: number,
  chunks: readonly number[],
): string {
  const sorted = [...chunks].sort((a, b) => a - b);
  let hash = mixNumber(0x811c9dc5, ENCODING_ORDER.indexOf(encoding));
  hash = mixNumber(hash, captureSize.width);
  hash = mixNumber(hash, captureSize.height);
  hash = mixNumber(hash, byteLength);
  for (const chunk of sorted) {
    hash = mixNumber(hash, chunk);
  }
  return `cf_${toHex32(hash)}`;
}

/** Signature of one frame's encoded payload. Pure: no state, no clock. */
export function contentSignature(
  frame: CapturedFrame,
  config: ContentFingerprintConfig = {},
): ContentSignature {
  const chunks = chunkHashes(frame.bytes, config.chunkTargetBytes ?? DEFAULT_CHUNK_TARGET_BYTES);
  return {
    encoding: frame.encoding,
    captureSize: { width: frame.size.width, height: frame.size.height },
    byteLength: frame.bytes.byteLength,
    chunks: new Set(chunks),
    digest: digestOf(frame.encoding, frame.size, frame.bytes.byteLength, chunks),
  };
}

/**
 * Fraction of `next` that is *not* shared with `previous`, in `[0, 1]`.
 * Signatures with a different encoding or capture size are incomparable and
 * report a full change.
 */
export function contentChangeRatio(previous: ContentSignature, next: ContentSignature): number {
  if (previous.encoding !== next.encoding) {
    return 1;
  }
  if (
    previous.captureSize.width !== next.captureSize.width ||
    previous.captureSize.height !== next.captureSize.height
  ) {
    return 1;
  }
  const largest = Math.max(previous.chunks.size, next.chunks.size);
  if (largest === 0) {
    return 0;
  }
  const [small, large] =
    previous.chunks.size <= next.chunks.size
      ? [previous.chunks, next.chunks]
      : [next.chunks, previous.chunks];
  let shared = 0;
  for (const chunk of small) {
    if (large.has(chunk)) {
      shared += 1;
    }
  }
  return 1 - shared / largest;
}

/**
 * Stateful fingerprinter: holds the anchor signature and mints a new
 * fingerprint when a frame differs from it by more than the threshold.
 *
 * Memory-only and content-free apart from the anchor's chunk hashes, which are
 * dropped by {@link ContentFingerprinter.reset} on every clear.
 */
export class ContentFingerprinter {
  readonly #chunkTargetBytes: number;
  readonly #threshold: number;

  #anchor: ContentSignature | null = null;
  #fingerprint: string | null = null;

  #framesExamined = 0;
  #fingerprintsMinted = 0;
  #belowThreshold = 0;
  #resets = 0;

  constructor(config: ContentFingerprintConfig = {}) {
    this.#chunkTargetBytes = config.chunkTargetBytes ?? DEFAULT_CHUNK_TARGET_BYTES;
    this.#threshold = config.changeThreshold ?? DEFAULT_CONTENT_CHANGE_THRESHOLD;
  }

  get threshold(): number {
    return this.#threshold;
  }

  /** Fingerprint in force, or `null` before the first frame. */
  get fingerprint(): string | null {
    return this.#fingerprint;
  }

  /** Signature of the frame that minted the current fingerprint. */
  get anchor(): ContentSignature | null {
    return this.#anchor;
  }

  observe(frame: CapturedFrame): ContentFingerprintUpdate {
    this.#framesExamined += 1;
    const signature = contentSignature(frame, { chunkTargetBytes: this.#chunkTargetBytes });
    const anchor = this.#anchor;

    if (anchor === null) {
      return this.#mint(signature, 'first-frame', 1);
    }
    if (anchor.encoding !== signature.encoding) {
      return this.#mint(signature, 'encoding-changed', 1);
    }
    if (
      anchor.captureSize.width !== signature.captureSize.width ||
      anchor.captureSize.height !== signature.captureSize.height
    ) {
      return this.#mint(signature, 'capture-size-changed', 1);
    }

    const changeRatio = contentChangeRatio(anchor, signature);
    if (changeRatio >= this.#threshold) {
      return this.#mint(signature, 'content-changed', changeRatio);
    }

    this.#belowThreshold += 1;
    return {
      fingerprint: this.#fingerprint ?? signature.digest,
      changed: false,
      reason: 'below-threshold',
      changeRatio,
      threshold: this.#threshold,
      chunkCount: signature.chunks.size,
    };
  }

  /** Drops the anchor. Called on every clear and on window change. */
  reset(): void {
    this.#anchor = null;
    this.#fingerprint = null;
    this.#resets += 1;
  }

  metrics(): ContentFingerprintMetrics {
    return {
      framesExamined: this.#framesExamined,
      fingerprintsMinted: this.#fingerprintsMinted,
      belowThreshold: this.#belowThreshold,
      resets: this.#resets,
    };
  }

  #mint(
    signature: ContentSignature,
    reason: ContentChangeReason,
    changeRatio: number,
  ): ContentFingerprintUpdate {
    this.#anchor = signature;
    this.#fingerprint = signature.digest;
    this.#fingerprintsMinted += 1;
    return {
      fingerprint: signature.digest,
      changed: true,
      reason,
      changeRatio,
      threshold: this.#threshold,
      chunkCount: signature.chunks.size,
    };
  }
}
