import { z } from 'zod';

/**
 * Permission kinds and states.
 *
 * These are domain values, not platform values: `packages/platform` declares
 * the adapter that reports them, `packages/platform-mac` maps macOS TCC status
 * onto them, and the renderer renders them. No macOS-specific type may leak
 * past this file.
 */

export const PERMISSION_KINDS = [
  'screen-recording',
  'accessibility',
  'microphone',
  'speech-recognition',
] as const;

export type PermissionKind = (typeof PERMISSION_KINDS)[number];

export const PERMISSION_STATES = ['unknown', 'denied', 'restricted', 'granted'] as const;

export type PermissionState = (typeof PERMISSION_STATES)[number];

export const permissionKindSchema = z.enum(PERMISSION_KINDS);
export const permissionStateSchema = z.enum(PERMISSION_STATES);

export const permissionStatusSchema = z.strictObject({
  kind: permissionKindSchema,
  state: permissionStateSchema,
  /** Whether an in-app prompt is still possible, or the user must use System Settings. */
  canRequest: z.boolean(),
});

export type PermissionStatus = z.infer<typeof permissionStatusSchema>;

export const permissionSnapshotSchema = z.strictObject({
  'screen-recording': permissionStatusSchema,
  accessibility: permissionStatusSchema,
  microphone: permissionStatusSchema,
  'speech-recognition': permissionStatusSchema,
});

export type PermissionSnapshot = z.infer<typeof permissionSnapshotSchema>;

export function isGranted(status: PermissionStatus): boolean {
  return status.state === 'granted';
}
