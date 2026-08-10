import {
  PilotError,
  UNKNOWN_NORMALIZED_POINT,
  UNKNOWN_SCENE_ID,
  isPointerInsideWindow,
  isSceneObserved,
  questionEnvelopeSchema,
  type ObservedWindow,
  type QuestionAnchor,
  type QuestionAnchorTarget,
  type QuestionEnvelope,
  type QuestionGrounding,
  type SceneState,
} from '@pilot/shared';
import type {
  PointerAnchorSample,
  QuestionAnchorSource,
  QuestionEnvelopeFactory,
  QuestionEnvelopeRequest,
} from './ports.js';

/**
 * PR-024 — the question envelope.
 *
 * The interaction machine (PR-006) decides *when* a question is submitted; this
 * decides *what* is in it. `docs/system-design.md` §8 fixes the shape and §6
 * fixes the anchoring rule:
 *
 * > The initial grounding point is the pointer location at utterance end.
 *
 * So the factory asks the pointer timeline — the one source of truth for where
 * the pointer was, owned by `packages/observation` and reached here through the
 * {@link QuestionAnchorSource} port — for the sample nearest utterance end, and
 * for the path over the utterance interval. It invents nothing: if there is no
 * sample, the envelope says the pointer is unknown.
 *
 * **No image bytes, ever.** The envelope is text and cheap metadata. Images
 * reach the model only through `observe_screen` (PR-021), after the screen
 * policy has approved them. Two independent things enforce that here: the
 * `questionEnvelopeSchema` admits only string/number/boolean leaves, and
 * {@link assertNoImageBytes} re-checks the parsed result for binary values,
 * base64 blobs, data URIs and overall size.
 */

/** Longest window title / accessibility role / label kept, in characters. */
export const MAX_ANCHOR_TEXT_CHARS = 120;

/**
 * Longest transcript kept. Roughly twenty minutes of continuous speech; a cap
 * exists so one runaway recogniser cannot produce an unbounded envelope.
 */
export const MAX_TRANSCRIPT_CHARS = 8_000;

/** Ceiling on the serialized envelope. Two orders of magnitude below one frame. */
export const MAX_QUESTION_ENVELOPE_BYTES = 32 * 1024;

/**
 * A string this long that is pure base64/hex is not metadata, whatever it
 * claims to be. Real roles, labels and window titles are far shorter.
 */
const SUSPICIOUS_BLOB_CHARS = 256;

const DATA_URI = /^\s*data:[^,]*,/i;
const BASE64_ONLY = /^[A-Za-z0-9+/=\r\n]+$/;

/** Default tolerance between utterance end and the anchoring pointer sample. */
export const DEFAULT_MAX_ANCHOR_SKEW_MS = 1_000;

export interface QuestionEnvelopeFactoryOptions {
  readonly anchors: QuestionAnchorSource;
  /**
   * Refuse to anchor on a pointer sample further than this from utterance end.
   * Beyond it the pointer is reported as unknown rather than guessed at.
   */
  readonly maxAnchorSkewMs?: number;
  readonly maxTranscriptChars?: number;
  readonly maxTextChars?: number;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function payloadError(message: string, details: Record<string, unknown>): PilotError {
  return new PilotError('payload-too-large', message, {
    userMessage: 'Pilot refused to send a malformed question to the model.',
    details,
  });
}

function checkString(value: string, path: string): void {
  if (DATA_URI.test(value)) {
    throw payloadError(`Question envelope field "${path}" contains a data URI`, { path });
  }
  if (value.length >= SUSPICIOUS_BLOB_CHARS && BASE64_ONLY.test(value)) {
    throw payloadError(`Question envelope field "${path}" looks like an encoded blob`, {
      path,
      length: value.length,
    });
  }
}

/**
 * Proves an envelope carries no image payload.
 *
 * Rejects binary containers (typed arrays, `ArrayBuffer`, Node `Buffer`),
 * anything that is not a plain JSON leaf, base64/data-URI strings smuggled into
 * a text field, and an oversized envelope overall. Producer-side, so a bad
 * envelope never reaches `AgentSession.submit`.
 */
export function assertNoImageBytes(
  envelope: unknown,
  maxBytes: number = MAX_QUESTION_ENVELOPE_BYTES,
): void {
  const walk = (value: unknown, path: string): void => {
    if (value === undefined || value === null) {
      return;
    }
    switch (typeof value) {
      case 'string':
        checkString(value, path);
        return;
      case 'number':
      case 'boolean':
        return;
      case 'bigint':
      case 'function':
      case 'symbol':
        throw payloadError(`Question envelope field "${path}" is a ${typeof value}`, { path });
      default:
        break;
    }
    if (
      ArrayBuffer.isView(value) ||
      value instanceof ArrayBuffer ||
      value instanceof SharedArrayBuffer
    ) {
      throw payloadError(`Question envelope field "${path}" carries raw bytes`, {
        path,
        kind: value.constructor.name,
      });
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, `${path}[${String(index)}]`);
      });
      return;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw payloadError(`Question envelope field "${path}" is not a plain object`, {
        path,
        kind: (value as object).constructor.name,
      });
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, path === '' ? key : `${path}.${key}`);
    }
  };

  walk(envelope, '');

  const byteLength = Buffer.byteLength(JSON.stringify(envelope) ?? '', 'utf8');
  if (byteLength > maxBytes) {
    throw payloadError('Question envelope exceeds its size ceiling', { byteLength, maxBytes });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Compact accessibility summary: role and label, nothing else.
 *
 * The element's *value* is never copied. `buildGroundedPointer` already drops
 * secure values, but a non-secure value is still arbitrary screen content
 * leaving the machine before any policy check — the envelope is metadata, so it
 * carries what a thing *is*, not what it says.
 */
export function summarizeAccessibilityTarget(
  sample: PointerAnchorSample,
  maxTextChars: number = MAX_ANCHOR_TEXT_CHARS,
): QuestionAnchorTarget | null {
  const target = sample.pointer.accessibilityTarget;
  if (target === undefined) {
    return null;
  }
  const role = target.role === undefined ? undefined : truncate(target.role, maxTextChars);
  const label = target.label === undefined ? undefined : truncate(target.label, maxTextChars);
  if ((role === undefined || role === '') && (label === undefined || label === '')) {
    return null;
  }
  return {
    ...(role === undefined || role === '' ? {} : { role }),
    ...(label === undefined || label === '' ? {} : { label }),
  };
}

/** A scene only describes the selected window; a stale one is not used. */
function sceneForWindow(
  scene: SceneState | null,
  selectedWindow: ObservedWindow | null,
): SceneState | null {
  if (scene === null || selectedWindow === null) {
    return null;
  }
  return scene.windowId === selectedWindow.windowId ? scene : null;
}

interface PathFacts {
  readonly sampleCount: number;
  readonly crossedBorder: boolean;
  readonly revisionAtStart: number | null;
  readonly revisedDuringUtterance: boolean;
}

function analysePath(
  path: readonly PointerAnchorSample[],
  sceneRevision: number | null,
): PathFacts {
  let inside = 0;
  let outside = 0;
  let revisionAtStart: number | null = null;
  let revisionAtEnd: number | null = null;

  for (const sample of path) {
    if (isPointerInsideWindow(sample.pointer)) {
      inside += 1;
    } else {
      outside += 1;
    }
    if (sample.sceneRevision !== null) {
      revisionAtStart ??= sample.sceneRevision;
      revisionAtEnd = sample.sceneRevision;
    }
  }

  const movedRevision =
    revisionAtStart !== null && revisionAtEnd !== null && revisionAtStart !== revisionAtEnd;
  // The scene may also have been revised after the last stamped sample.
  const driftedToNow =
    revisionAtEnd !== null && sceneRevision !== null && revisionAtEnd !== sceneRevision;

  return {
    sampleCount: path.length,
    crossedBorder: inside > 0 && outside > 0,
    revisionAtStart,
    revisedDuringUtterance: movedRevision || driftedToNow,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export class PilotQuestionEnvelopeFactory implements QuestionEnvelopeFactory {
  readonly #anchors: QuestionAnchorSource;
  readonly #maxSkewMs: number;
  readonly #maxTranscriptChars: number;
  readonly #maxTextChars: number;

  constructor(options: QuestionEnvelopeFactoryOptions) {
    this.#anchors = options.anchors;
    this.#maxSkewMs = options.maxAnchorSkewMs ?? DEFAULT_MAX_ANCHOR_SKEW_MS;
    this.#maxTranscriptChars = options.maxTranscriptChars ?? MAX_TRANSCRIPT_CHARS;
    this.#maxTextChars = options.maxTextChars ?? MAX_ANCHOR_TEXT_CHARS;
  }

  /** Async only to satisfy the port; the whole build is pure and synchronous. */
  create(request: QuestionEnvelopeRequest): Promise<QuestionEnvelope> {
    return Promise.resolve(this.build(request));
  }

  /** The synchronous form, for tests and for callers that already have a tick. */
  build(request: QuestionEnvelopeRequest): QuestionEnvelope {
    const { selectedWindow, askedAt, utteranceStartedAt } = request;
    const scene = sceneForWindow(this.#anchors.scene(), selectedWindow);

    const path =
      selectedWindow === null
        ? []
        : this.#anchors
            .pointerBetween(Math.min(utteranceStartedAt, askedAt), askedAt)
            .filter((sample) => sample.windowId === selectedWindow.windowId);
    const facts = analysePath(path, scene?.revision ?? null);

    const anchored: AnchorAttempt =
      selectedWindow === null
        ? { found: false, reason: 'no-selected-window' }
        : this.#anchorSample(selectedWindow, askedAt);
    const sample = anchored.found ? anchored.sample : null;

    const grounding: QuestionGrounding =
      selectedWindow === null
        ? 'no-selected-window'
        : sample === null
          ? 'pointer-unknown'
          : isPointerInsideWindow(sample.pointer)
            ? 'pointer-in-window'
            : 'pointer-outside-window';

    // Outside the selected window, whatever is under the pointer belongs to a
    // window Pilot is not observing. No target is summarized from it.
    const target =
      sample !== null && grounding === 'pointer-in-window'
        ? summarizeAccessibilityTarget(sample, this.#maxTextChars)
        : null;

    const note = noteFor(grounding, anchored, target);

    const anchor: QuestionAnchor = {
      grounding,
      utteranceStartedAt,
      utteranceEndedAt: askedAt,
      ...(sample === null ? {} : { pointerSampledAt: sample.at }),
      ...(anchored.found ? { pointerSkewMs: anchored.skewMs } : {}),
      pointerSampleCount: facts.sampleCount,
      pointerCrossedWindowBorder: facts.crossedBorder,
      ...(facts.revisionAtStart === null
        ? {}
        : { sceneRevisionAtUtteranceStart: facts.revisionAtStart }),
      sceneRevisedDuringUtterance: facts.revisedDuringUtterance,
      observationStale: scene === null ? true : !isSceneObserved(scene),
      ...(target === null ? {} : { target }),
      targetAvailability: target === null ? 'none' : 'reported',
      ...(note === null ? {} : { note }),
    };

    const pointer =
      sample === null
        ? { ...UNKNOWN_NORMALIZED_POINT }
        : {
            normalizedX: sample.pointer.normalizedPoint.x,
            normalizedY: sample.pointer.normalizedPoint.y,
          };

    const windowTitle = truncate(
      scene?.windowTitle ?? selectedWindow?.title ?? '',
      this.#maxTextChars,
    );

    const envelope = questionEnvelopeSchema.parse({
      utteranceId: request.utteranceId,
      transcript: truncateTranscript(request.transcript, this.#maxTranscriptChars),
      conversationId: request.conversationId,
      scene: {
        id: scene?.sceneId ?? UNKNOWN_SCENE_ID,
        revision: scene?.revision ?? 0,
        ...(scene?.lastObservedRevision === undefined
          ? {}
          : { lastObservedRevision: scene.lastObservedRevision }),
        windowTitle,
      },
      pointer: {
        ...pointer,
        ...(target?.role === undefined ? {} : { targetRole: target.role }),
        ...(target?.label === undefined ? {} : { targetLabel: target.label }),
      },
      anchor,
    });

    assertNoImageBytes(envelope);
    return envelope;
  }

  /**
   * The grounding point (system-design §6): the pointer at utterance end.
   *
   * Prefers the last sample at or before the anchor — a later sample is the
   * user moving on, not what they were pointing at. Falls back to the nearest
   * sample in either direction, which the recorded `pointerSkewMs` and the note
   * make visible instead of silent.
   */
  #anchorSample(selectedWindow: ObservedWindow, askedAt: number): AnchorAttempt {
    const before = this.#anchors.pointerAt(askedAt, {
      direction: 'at-or-before',
      maxSkewMs: this.#maxSkewMs,
    });
    const chosen = before.found
      ? before
      : this.#anchors.pointerAt(askedAt, { direction: 'any', maxSkewMs: this.#maxSkewMs });
    if (!chosen.found) {
      return {
        found: false,
        reason: chosen.reason === 'empty' ? 'no-samples' : 'out-of-range',
        ...(chosen.nearestDistanceMs === null
          ? {}
          : { nearestDistanceMs: Math.round(chosen.nearestDistanceMs) }),
      };
    }
    // A sample from a previous selection is not this window's pointer.
    if (chosen.sample.windowId !== selectedWindow.windowId) {
      return { found: false, reason: 'window-mismatch' };
    }
    return { found: true, sample: chosen.sample, skewMs: Math.round(chosen.skewMs) };
  }
}

type AnchorAttempt =
  | { readonly found: true; readonly sample: PointerAnchorSample; readonly skewMs: number }
  | {
      readonly found: false;
      readonly reason: 'no-selected-window' | 'no-samples' | 'out-of-range' | 'window-mismatch';
      readonly nearestDistanceMs?: number;
    };

/**
 * Why the grounding is what it is, in one sentence.
 *
 * Every non-obvious grounding gets a note, so a reader of the envelope — human
 * or model — never has to infer the reason from a missing field.
 */
function noteFor(
  grounding: QuestionGrounding,
  anchored: AnchorAttempt,
  target: QuestionAnchorTarget | null,
): string | null {
  switch (grounding) {
    case 'no-selected-window':
      return 'No window is selected, so the question has no screen anchor.';
    case 'pointer-unknown':
      if (anchored.found) {
        return null;
      }
      switch (anchored.reason) {
        case 'window-mismatch':
          return 'The recorded pointer belongs to a previously selected window.';
        case 'out-of-range':
          return anchored.nearestDistanceMs === undefined
            ? 'No pointer sample close enough to the end of the utterance.'
            : `No pointer sample close enough to the end of the utterance; the nearest was ${String(anchored.nearestDistanceMs)}ms away.`;
        default:
          return 'No pointer sample was recorded for this utterance.';
      }
    case 'pointer-outside-window':
      return 'The pointer was not over the selected window; no element was identified.';
    case 'pointer-in-window':
      if (target === null) {
        return 'No accessibility element was reported under the pointer.';
      }
      return anchored.found && anchored.skewMs > 0
        ? 'Anchored on the nearest pointer sample after the end of the utterance.'
        : null;
  }
}

function truncateTranscript(transcript: string, max: number): string {
  return transcript.length <= max ? transcript : `${transcript.slice(0, max)}… [truncated]`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Text rendering of an anchored envelope, for the model's user turn.
 *
 * `renderQuestionEnvelope` in `@pilot/agent` predates the anchor and prints the
 * raw `pointer` pair, which for an unknown pointer would read as a position at
 * `-1, -1`. This renderer states the grounding in words — "the pointer was not
 * over the selected window", "the pointer position is unknown" — which is the
 * whole point of representing those cases explicitly.
 *
 * It satisfies `PilotSessionOptions.renderEnvelope`, so PR-029 wires it in at
 * the composition root without either package depending on the other.
 */
export function renderAnchoredQuestionEnvelope(envelope: QuestionEnvelope): string {
  const { scene, pointer, anchor } = envelope;
  const lines = [envelope.transcript, '', '<context>', `window: ${scene.windowTitle}`];
  if (scene.id !== UNKNOWN_SCENE_ID) {
    lines.push(`scene: ${scene.id} revision ${String(scene.revision)}`);
  }
  if (scene.lastObservedRevision !== undefined) {
    lines.push(`last observed revision: ${String(scene.lastObservedRevision)}`);
  }

  const position = `${pointer.normalizedX.toFixed(3)}, ${pointer.normalizedY.toFixed(3)}`;
  switch (anchor?.grounding) {
    case undefined:
      lines.push(`pointer: ${position} (window-relative)`);
      break;
    case 'pointer-in-window':
      lines.push(`pointer: ${position} (window-relative, inside the selected window)`);
      break;
    case 'pointer-outside-window':
      lines.push(
        `pointer: ${position} (window-relative) — outside the selected window; no element was identified`,
      );
      break;
    case 'pointer-unknown':
      lines.push('pointer: unknown — no pointer position was recorded for this question');
      break;
    case 'no-selected-window':
      lines.push('pointer: not applicable — no window is selected');
      break;
  }

  if (pointer.targetRole !== undefined || pointer.targetLabel !== undefined) {
    lines.push(
      `pointer target: ${[pointer.targetRole, pointer.targetLabel].filter(Boolean).join(' — ')}`,
    );
  } else if (anchor?.grounding === 'pointer-in-window') {
    lines.push('pointer target: none reported');
  }

  if (anchor !== undefined) {
    if (anchor.sceneRevisedDuringUtterance) {
      lines.push('the window changed while the question was being asked');
    }
    if (anchor.observationStale && scene.id !== UNKNOWN_SCENE_ID) {
      lines.push('you have not observed this revision of the window');
    }
  }
  lines.push('</context>');
  return lines.join('\n');
}
