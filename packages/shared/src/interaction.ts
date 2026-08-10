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
 * Question envelope (system-design §8), verbatim.
 *
 * Carries text and inexpensive metadata only — never image bytes. The model
 * decides whether to call `observe_screen`.
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
