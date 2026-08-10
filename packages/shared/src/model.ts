import { z } from 'zod';
import { modelProfileIdSchema } from './ids.js';

/**
 * Model profile (system-design §12), verbatim apart from `id` carrying the
 * `ModelProfileId` brand.
 *
 * PROVISIONAL: PR-005 probes the pinned Pi release and may add fields (for
 * example real capability metadata or provider-specific auth hints). Consumers
 * should treat unknown extra fields as possible and re-parse rather than cast.
 */
export const modelProfileSchema = z.strictObject({
  id: modelProfileIdSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  authMode: z.enum(['subscription', 'api-key', 'local']),
  baseUrl: z.url().optional(),
  supportsVision: z.boolean(),
  supportsTools: z.boolean(),
  isRemote: z.boolean(),
});

export type ModelProfile = z.infer<typeof modelProfileSchema>;

/**
 * A visual conversation requires both vision and tool calling. A profile that
 * fails this check may still be used in the degraded, explicitly labelled
 * accessibility/OCR-only mode (system-design §12).
 */
export function supportsVisualConversation(profile: ModelProfile): boolean {
  return profile.supportsVision && profile.supportsTools;
}
