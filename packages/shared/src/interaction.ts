import { z } from 'zod';
import { conversationIdSchema, utteranceIdSchema } from './ids.js';

/**
 * Interaction state names (mvp-01 §7), verbatim.
 *
 * The transition table itself is implemented by `packages/interaction` in
 * PR-006; PR-001 only fixes the vocabulary so the desktop shell, the agent
 * runtime and the interaction lane agree on state names.
 */
export const INTERACTION_STATES = [
  'idle',
  'needs-permission',
  'paused',
  'observing',
  'listening',
  'transcribing',
  'thinking',
  'observing-screen',
  'speaking',
  'error',
] as const;

export type InteractionState = (typeof INTERACTION_STATES)[number];

export const interactionStateSchema = z.enum(INTERACTION_STATES);

/**
 * How a question was grounded on the screen (system-design §6).
 *
 * This is the *typed* answer to "where was the pointer at utterance end?".
 * `docs/system-design.md` §8 only gives the envelope a required numeric
 * `pointer`, which forces every consumer to re-derive "was that even a real
 * position?" from the coordinates. These four cases say it outright:
 *
 * - `pointer-in-window` — a real sample, normalised inside `[0, 1]`.
 * - `pointer-outside-window` — a real sample whose normalised coordinates fall
 *   outside the selected window. The coordinates are the true ones; they are
 *   never clamped, and no accessibility target is attached, because anything
 *   under the pointer then belongs to a window Pilot is not observing.
 * - `pointer-unknown` — no usable pointer sample for the utterance. The
 *   envelope's `pointer` carries {@link UNKNOWN_NORMALIZED_POINT}, which is not
 *   a position.
 * - `no-selected-window` — there is nothing to normalise against at all
 *   (a text-only conversation, or observation is off).
 */
export const QUESTION_GROUNDINGS = [
  'pointer-in-window',
  'pointer-outside-window',
  'pointer-unknown',
  'no-selected-window',
] as const;

export type QuestionGrounding = (typeof QUESTION_GROUNDINGS)[number];

/**
 * Written into `QuestionEnvelope.pointer` when no pointer position is known.
 *
 * It is deliberately outside `[0, 1]`, so {@link envelopePointerInsideWindow}
 * is `false` and nothing can mistake it for a location. It exists only because
 * system-design §8 makes `pointer` a required pair of numbers; the honest
 * answer lives in `anchor.grounding`, and {@link envelopePointerKnown} reads it.
 */
export const UNKNOWN_NORMALIZED_POINT = { normalizedX: -1, normalizedY: -1 } as const;

/** Written into `QuestionEnvelope.scene.id` when no scene is being tracked. */
export const UNKNOWN_SCENE_ID = 'scene-unknown';

/**
 * Compact accessibility summary of the element under the anchoring pointer.
 *
 * Role and label only. The element's *value* is deliberately absent: values are
 * where secure fields, tokens and personal data live, and the envelope is sent
 * before any policy check has run.
 */
export const questionAnchorTargetSchema = z.strictObject({
  role: z.string().optional(),
  label: z.string().optional(),
});

export type QuestionAnchorTarget = z.infer<typeof questionAnchorTargetSchema>;

/**
 * Whether the envelope carries an accessibility target, and when it does not,
 * **why not** (PR-044; system-design §16, "Accessibility denied").
 *
 * The distinction is the whole of §16's degraded mode. `none` means the hit
 * test could have named the control and did not — an empty region, a view with
 * no accessible element. `unavailable` means no hit test was possible at all
 * because Accessibility is not permitted, so *nothing anywhere on the screen*
 * can be named this session. A model told `none` may reasonably conclude the
 * pointer is over blank space; a model told `unavailable` knows the picture and
 * the pointer coordinates are the only grounding it has, which is exactly what
 * §16 means by "continue with visual pointer coordinates and disclose reduced
 * grounding".
 *
 * `unavailable` is never inferred from an absent target: it is set only when
 * the permission snapshot says `denied` or `restricted`. A permission still
 * being read, or never asked for, is neither (runbook hazard 22).
 */
export const QUESTION_TARGET_AVAILABILITIES = ['reported', 'none', 'unavailable'] as const;

export type QuestionTargetAvailability = (typeof QUESTION_TARGET_AVAILABILITIES)[number];

/**
 * Anchoring metadata (system-design §6), attached to a question envelope.
 *
 * Optional so envelopes built before PR-024 still validate. Text and numbers
 * only — like the rest of the envelope, it never carries image bytes.
 */
export const questionAnchorSchema = z.strictObject({
  grounding: z.enum(QUESTION_GROUNDINGS),
  /** Push-to-talk start and end timestamps (system-design §6). */
  utteranceStartedAt: z.number().int().nonnegative(),
  utteranceEndedAt: z.number().int().nonnegative(),
  /** When the anchoring pointer sample was actually taken. */
  pointerSampledAt: z.number().int().nonnegative().optional(),
  /** `pointerSampledAt - utteranceEndedAt`; negative means it predates the anchor. */
  pointerSkewMs: z.number().int().optional(),
  /** Pointer samples retained for the utterance interval. */
  pointerSampleCount: z.number().int().nonnegative(),
  /** The pointer crossed the window border at least once during the utterance. */
  pointerCrossedWindowBorder: z.boolean(),
  /** Scene revision in force when the utterance began, when it was recorded. */
  sceneRevisionAtUtteranceStart: z.number().int().nonnegative().optional(),
  /** The scene was revised between utterance start and utterance end. */
  sceneRevisedDuringUtterance: z.boolean(),
  /** The model has not seen the current revision of this scene (§6). */
  observationStale: z.boolean(),
  /** Present only when the platform reported an element under the pointer. */
  target: questionAnchorTargetSchema.optional(),
  /** Explicit: an absent `target` is a fact, not an omission. */
  targetAvailability: z.enum(QUESTION_TARGET_AVAILABILITIES),
  /** Short, human-readable reason the grounding is what it is. */
  note: z.string().optional(),
});

export type QuestionAnchor = z.infer<typeof questionAnchorSchema>;

/**
 * Question envelope (system-design §8), verbatim, plus the optional `anchor`
 * added by PR-024.
 *
 * Carries text and inexpensive metadata only — never image bytes. Because the
 * schema is a `strictObject` over string/number/boolean leaves, a `Uint8Array`
 * or a `Buffer` cannot survive `questionEnvelopeSchema.parse`, which is what
 * makes "no image bytes" a property of the contract rather than a convention.
 * The model decides whether to call `observe_screen`.
 */
export const questionEnvelopeSchema = z.strictObject({
  utteranceId: utteranceIdSchema,
  transcript: z.string(),
  conversationId: conversationIdSchema,
  scene: z.strictObject({
    id: z.string().min(1),
    revision: z.number().int().nonnegative(),
    lastObservedRevision: z.number().int().nonnegative().optional(),
    windowTitle: z.string(),
  }),
  pointer: z.strictObject({
    normalizedX: z.number().finite(),
    normalizedY: z.number().finite(),
    targetRole: z.string().optional(),
    targetLabel: z.string().optional(),
  }),
  anchor: questionAnchorSchema.optional(),
});

export type QuestionEnvelope = z.infer<typeof questionEnvelopeSchema>;

/**
 * True when the pointer recorded in an envelope was inside the selected
 * window. When false the model must be told the pointer was outside rather
 * than being given an invented target (mvp-01 §8).
 */
export function envelopePointerInsideWindow(envelope: QuestionEnvelope): boolean {
  const { normalizedX, normalizedY } = envelope.pointer;
  return normalizedX >= 0 && normalizedX <= 1 && normalizedY >= 0 && normalizedY <= 1;
}

/**
 * True when `pointer` is a real position at all. An envelope with an `anchor`
 * says so directly; one without predates PR-024 and is taken at face value.
 */
export function envelopePointerKnown(envelope: QuestionEnvelope): boolean {
  if (envelope.anchor === undefined) {
    return true;
  }
  return (
    envelope.anchor.grounding === 'pointer-in-window' ||
    envelope.anchor.grounding === 'pointer-outside-window'
  );
}

/**
 * True when this question was asked with §16's reduced grounding: a picture and
 * a point, and no way to name what is under the point (PR-044).
 *
 * Read off `targetAvailability` rather than off a permission snapshot, so every
 * consumer of an envelope — the renderer, a log line, a test — gets the same
 * answer as the model did, from the same field.
 */
export function envelopeGroundingReduced(envelope: QuestionEnvelope): boolean {
  return envelope.anchor?.targetAvailability === 'unavailable';
}
