import { z } from 'zod';
import { sceneIdSchema, windowIdSchema } from './ids.js';

/**
 * Scene identity and revision (system-design §6).
 *
 * A revision changes when the selected window, its geometry, its accessibility
 * root, or its meaningful visual content changes. The revision is lightweight
 * metadata attached to a question; it never triggers an upload by itself.
 */
export const sceneStateSchema = z.strictObject({
  sceneId: sceneIdSchema,
  revision: z.number().int().nonnegative(),
  windowId: windowIdSchema,
  windowTitle: z.string(),
  fingerprint: z.string(),
  lastObservedRevision: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative(),
});

export type SceneState = z.infer<typeof sceneStateSchema>;

/** True when the model has already seen the current revision of this scene. */
export function isSceneObserved(scene: SceneState): boolean {
  return scene.lastObservedRevision === scene.revision;
}

/** Rejects results produced for a different scene or an older window selection. */
export function isSameSceneLineage(expected: SceneState, actual: SceneState): boolean {
  return expected.sceneId === actual.sceneId && expected.windowId === actual.windowId;
}
