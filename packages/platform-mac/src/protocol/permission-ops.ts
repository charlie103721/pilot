import { PERMISSION_KINDS, PERMISSION_STATES } from '@pilot/shared';
import { z } from 'zod';
import { defineHelperOperation, type HelperOperationRequest } from './operation-kit.js';

/**
 * Permission operations (PR-011).
 *
 * Appended to the closed operation set PR-003 established. Nothing here bumps
 * `HELPER_PROTOCOL_VERSION`: adding operations is backwards compatible, and a
 * helper that does not implement one answers `invalid-request` for it rather
 * than failing the handshake.
 *
 * ## Why the wire carries more than `PermissionStatus`
 *
 * `@pilot/shared`'s `PermissionStatus` is the *domain* answer. The wire
 * additionally carries which macOS API produced it and what that API literally
 * returned, because the four permissions are not equally expressive and
 * pretending they are is how "unknown" silently becomes "denied":
 *
 * | Permission | macOS API | States it can express |
 * | --- | --- | --- |
 * | Screen Recording | `CGPreflightScreenCaptureAccess` | granted / not-granted (a Bool) |
 * | Accessibility | `AXIsProcessTrusted` | granted / not-granted (a Bool) |
 * | Microphone | `AVCaptureDevice.authorizationStatus` | all four |
 * | Speech Recognition | `SFSpeechRecognizer.authorizationStatus` | all four |
 *
 * The first two cannot distinguish "the user said no" from "nobody has asked
 * yet", and cannot express `restricted` at all. So a `false` from them is
 * reported as `unknown` — never as `denied` — until a request has actually
 * been made and refused in this process, which is the only moment macOS makes
 * the distinction observable. `restrictedRepresentable: false` records that
 * `restricted` is unreachable through that API rather than merely absent.
 */

/** Which macOS API answered a probe. `unavailable` means the probe could not run. */
export const PERMISSION_PROBE_APIS = [
  'cg-preflight',
  'ax-trusted',
  'av-authorization',
  'sf-authorization',
  'unavailable',
] as const;

export type PermissionProbeApi = (typeof PERMISSION_PROBE_APIS)[number];

export const permissionProbeSchema = z.strictObject({
  kind: z.enum(PERMISSION_KINDS),
  state: z.enum(PERMISSION_STATES),
  /** Whether an in-app prompt is still possible, or System Settings is required. */
  canRequest: z.boolean(),
  api: z.enum(PERMISSION_PROBE_APIS),
  /** What that API literally returned, stringified. Diagnostics only. */
  raw: z.string().max(64),
  /** False when the answering API has no way to express `restricted`. */
  restrictedRepresentable: z.boolean(),
  /**
   * True when a grant made now only takes effect after Pilot relaunches.
   * macOS Screen Recording behaves this way: the grant lands, and the running
   * process keeps seeing the old answer until it is restarted.
   */
  requiresRelaunch: z.boolean(),
});

export type PermissionProbe = z.infer<typeof permissionProbeSchema>;

/** Status of one permission, without prompting. */
export const permissionStatusOperation = defineHelperOperation({
  name: 'permissions.status',
  request: z.strictObject({ kind: z.enum(PERMISSION_KINDS) }),
  response: z.strictObject({ probe: permissionProbeSchema }),
  requestBinary: false,
  responseBinary: false,
});

/** Status of every permission Pilot may request, in one round trip. */
export const permissionSnapshotOperation = defineHelperOperation({
  name: 'permissions.snapshot',
  request: z.strictObject({}),
  response: z.strictObject({
    probes: z.array(permissionProbeSchema).length(PERMISSION_KINDS.length),
  }),
  requestBinary: false,
  responseBinary: false,
});

/**
 * Prompts for a permission.
 *
 * Returns as soon as the prompt has been raised, **not** when the user has
 * answered it. A macOS permission dialog can sit unanswered for minutes; the
 * helper's stdio loop is single-threaded, so blocking on one would freeze
 * every other operation including `health`. The resulting state arrives
 * through the adapter's normal polling instead.
 */
export const permissionRequestOperation = defineHelperOperation({
  name: 'permissions.request',
  request: z.strictObject({ kind: z.enum(PERMISSION_KINDS) }),
  response: z.strictObject({
    /** State immediately after prompting; often unchanged. */
    probe: permissionProbeSchema,
    /** Whether a prompt was actually raised. False when macOS refuses to ask again. */
    prompted: z.boolean(),
  }),
  requestBinary: false,
  responseBinary: false,
});

/** Opens the System Settings pane for a permission. */
export const permissionOpenSettingsOperation = defineHelperOperation({
  name: 'permissions.open-settings',
  request: z.strictObject({ kind: z.enum(PERMISSION_KINDS) }),
  response: z.strictObject({
    opened: z.boolean(),
    /** The `x-apple.systempreferences:` URL that was opened. */
    target: z.string().max(300),
  }),
  requestBinary: false,
  responseBinary: false,
});

const nullableString = z.string().max(1024).nullable();

/**
 * Raw attribution evidence, exactly as the helper observed it.
 *
 * The helper reports facts and makes no judgement; the verdict is computed
 * host-side in `src/permissions/attribution.ts`, which keeps the decision in
 * TypeScript where it can actually be tested on this machine.
 */
export const attributionEvidenceSchema = z.strictObject({
  helperPid: z.number().int().nonnegative(),
  /** `getppid()`. Should be the Electron main process. */
  parentPid: z.number().int().nonnegative(),
  helperExecutablePath: nullableString,
  /** `Bundle.main.bundleIdentifier`. Normally null: the helper is a bare executable. */
  helperBundleIdentifier: nullableString,
  /** Nearest enclosing `.app` directory, found by walking the executable path up. */
  enclosingAppBundlePath: nullableString,
  /** `CFBundleIdentifier` read from that bundle's `Contents/Info.plist`. */
  enclosingAppBundleIdentifier: nullableString,
  /**
   * The process macOS holds responsible for the helper, which is the identity
   * TCC attributes grants to. Null when the query could not be made.
   */
  responsibleProcessPid: z.number().int().nonnegative().nullable(),
  /**
   * False when the responsibility query itself was unavailable, as opposed to
   * available and inconclusive. The difference decides whether the verdict is
   * `direct` or `inferred`.
   */
  responsibleProcessQueried: z.boolean(),
  /** `Bundle.main` points at an `.app`, i.e. the helper is bundled, not loose. */
  mainBundleIsApp: z.boolean(),
});

export type AttributionEvidence = z.infer<typeof attributionEvidenceSchema>;

/**
 * Asks the helper which identity macOS credits its permission grants to.
 *
 * The host states the identity it *expects* — the parent application bundle —
 * so the comparison happens against a value the helper cannot invent.
 */
export const permissionAttributionOperation = defineHelperOperation({
  name: 'permissions.attribution',
  request: z.strictObject({
    expected: z.strictObject({
      bundleIdentifier: nullableString,
      bundlePath: nullableString,
      hostPid: z.number().int().nonnegative(),
    }),
  }),
  response: z.strictObject({ evidence: attributionEvidenceSchema }),
  requestBinary: false,
  responseBinary: false,
});

export type PermissionAttributionRequest = HelperOperationRequest<
  typeof permissionAttributionOperation
>;
