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

// ---------------------------------------------------------------------------
// Attribution (added by PR-011)
// ---------------------------------------------------------------------------

/**
 * Which process the operating system credited a permission grant to.
 *
 * Pilot spawns a native helper (system-design §4) and every permission the
 * helper exercises is checked against whatever identity the OS considers
 * *responsible* for that helper. When that identity is the parent application
 * bundle, a grant the user gives to Pilot reaches the helper and everything
 * works. When it is the helper itself, the user grants Pilot the permission,
 * the helper still cannot use it, and every status Pilot reports is a lie.
 *
 * This type exists so that answer is reported rather than assumed. It is
 * deliberately platform-neutral: a platform with no such split reports
 * `matched` with `direct` confidence and empty evidence.
 *
 * | Verdict | Meaning |
 * | --- | --- |
 * | `matched` | The OS credits the parent application. Grants work. |
 * | `helper-attributed` | The OS credits the helper. **Grants do not reach it.** |
 * | `bundle-mismatch` | The helper belongs to a different application than the one expected. |
 * | `unknown` | Could not be determined. Not a pass and not a failure. |
 */
export const PERMISSION_ATTRIBUTION_VERDICTS = [
  'matched',
  'helper-attributed',
  'bundle-mismatch',
  'unknown',
] as const;

export type PermissionAttributionVerdict = (typeof PERMISSION_ATTRIBUTION_VERDICTS)[number];

/**
 * How the verdict was reached.
 *
 * - `direct`: the OS was asked which process it holds responsible and answered.
 * - `inferred`: that answer was unavailable, so the verdict rests on the
 *   helper's location and identity. Evidence, not proof.
 * - `none`: nothing usable was available.
 */
export const PERMISSION_ATTRIBUTION_CONFIDENCES = ['direct', 'inferred', 'none'] as const;

export type PermissionAttributionConfidence = (typeof PERMISSION_ATTRIBUTION_CONFIDENCES)[number];

export const permissionAttributionVerdictSchema = z.enum(PERMISSION_ATTRIBUTION_VERDICTS);
export const permissionAttributionConfidenceSchema = z.enum(PERMISSION_ATTRIBUTION_CONFIDENCES);

/** One identity in an attribution report. Fields are `null` when unavailable. */
export const attributionIdentitySchema = z.strictObject({
  /** Bundle identifier, e.g. `com.pilot.app`. */
  bundleIdentifier: z.string().nullable(),
  /** Filesystem path of the bundle or executable. */
  path: z.string().nullable(),
  /** Process id, when the identity refers to a running process. */
  pid: z.number().int().nonnegative().nullable(),
});

export type AttributionIdentity = z.infer<typeof attributionIdentitySchema>;

export const permissionAttributionSchema = z.strictObject({
  verdict: permissionAttributionVerdictSchema,
  confidence: permissionAttributionConfidenceSchema,
  /** The identity Pilot requires the OS to credit: the parent application. */
  expected: attributionIdentitySchema,
  /** The identity the OS actually credits, as far as it could be determined. */
  attributed: attributionIdentitySchema,
  /** Stable machine-readable reason for the verdict. Never user-facing prose. */
  reason: z.string().min(1).max(120),
  /**
   * Raw probe results the verdict was derived from. Diagnostic only; contains
   * process ids and paths, never screen content, audio or credentials.
   */
  evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  checkedAt: z.number().int().nonnegative(),
});

export type PermissionAttribution = z.infer<typeof permissionAttributionSchema>;

/**
 * Whether the permission states reported alongside this attribution can be
 * believed. `unknown` is deliberately *not* trustworthy: a status Pilot cannot
 * attribute is not the same as a status it has verified.
 */
export function isAttributionTrusted(attribution: PermissionAttribution): boolean {
  return attribution.verdict === 'matched';
}

/**
 * Whether this attribution is an outright failure — the OS is known to be
 * crediting the wrong process — as opposed to merely undetermined.
 */
export function isAttributionFailure(attribution: PermissionAttribution): boolean {
  return attribution.verdict === 'helper-attributed' || attribution.verdict === 'bundle-mismatch';
}
