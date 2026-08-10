import { serializedPilotErrorSchema } from '@pilot/shared';
import { z } from 'zod';

/**
 * Wire schemas for the Codex subscription profile (PR-037).
 *
 * In their own file, not `schemas.ts`, for the reason `docs/runbook.md`
 * cross-lane issue 1 gives: PR-038 and PR-039 are adding a profile surface to
 * the same catalogue at the same time, and three lanes editing one file is a
 * merge that has to be reasoned about rather than unioned. The only edit this
 * PR makes to a shared file is appending two entries to `REQUEST_CHANNELS` and
 * one to `EVENT_CHANNELS`.
 *
 * NOTHING HERE CAN HOLD A CREDENTIAL, and that is a property of the *schema*
 * rather than of the code that fills it: every field below is a boolean, a
 * number, an enum, a path or a sentence this repository wrote.
 * `z.strictObject` means a main process that started sending an `accessToken`
 * would fail validation at the boundary instead of shipping it to Chromium.
 * `apps/desktop/test/main/codex-channels.test.ts` asserts exactly that.
 */

export const CODEX_AUTH_STATES = ['signed-out', 'active', 'refresh-due', 'expired'] as const;

export type CodexAuthStateName = (typeof CODEX_AUTH_STATES)[number];

export const CODEX_SIGN_IN_PHASES = ['idle', 'starting', 'awaiting-approval', 'failed'] as const;

export type CodexSignInPhaseName = (typeof CODEX_SIGN_IN_PHASES)[number];

/** The renderer-safe projection of a Codex credential. */
export const codexAuthStatusSchema = z.strictObject({
  providerId: z.string().min(1).max(200),
  state: z.enum(CODEX_AUTH_STATES),
  configured: z.boolean(),
  isSubscription: z.boolean(),
  /**
   * Provenance label, e.g. `OAuth`. Pi supplies it and it is a label, never a
   * value — see `packages/agent/src/auth-facade.ts`.
   */
  source: z.string().max(200).nullable(),
  expiresAt: z.number().int().nullable(),
  expiresInMs: z.number().int().nullable(),
  signInRequired: z.boolean(),
  label: z.string().max(200),
  detail: z.string().max(500),
});

export type CodexAuthStatusPayload = z.infer<typeof codexAuthStatusSchema>;

/** What the user types, and where. Produced by Pi's `device_code` event. */
export const codexDeviceCodeSchema = z.strictObject({
  userCode: z.string().min(1).max(64),
  verificationUri: z.url(),
  intervalSeconds: z.number().int().nonnegative().nullable(),
  expiresInSeconds: z.number().int().nonnegative().nullable(),
});

export const codexSignInSchema = z.strictObject({
  phase: z.enum(CODEX_SIGN_IN_PHASES),
  deviceCode: codexDeviceCodeSchema.nullable(),
  error: serializedPilotErrorSchema.nullable(),
});

export const codexGateStateSchema = z.strictObject({
  /** False on every build that has not selected the Codex profile. */
  enabled: z.boolean(),
  auth: codexAuthStatusSchema,
  signIn: codexSignInSchema,
  /** Provider/model, the capability verdict and the auth state, in one line. */
  description: z.string().max(500),
  /** The capability gate's refusal, when it refused. */
  capabilityError: serializedPilotErrorSchema.nullable(),
  /** False means the refresh token is on disk in plaintext, and the panel says so. */
  credentialsEncrypted: z.boolean(),
  /** Where the token is stored, so a user can delete it by hand. */
  credentialsPath: z.string().max(1024).nullable(),
});

export type CodexGateState = z.infer<typeof codexGateStateSchema>;

/**
 * What a build that never selected the Codex profile reports, and what the
 * panel shows before main has answered anything.
 *
 * One constant rather than two, so "not selected" and "not answered yet" cannot
 * drift apart — a panel that rendered a sign-in control for half a second while
 * the first read was in flight would be offering something that does not exist.
 */
export const DISABLED_CODEX_GATE_STATE: CodexGateState = {
  enabled: false,
  auth: {
    providerId: 'openai-codex',
    state: 'signed-out',
    configured: false,
    isSubscription: false,
    source: null,
    expiresAt: null,
    expiresInMs: null,
    signInRequired: true,
    label: 'Not signed in to ChatGPT',
    detail:
      'Pilot uses your ChatGPT Plus/Pro subscription instead of an API key. Sign in to start answering questions.',
  },
  signIn: { phase: 'idle', deviceCode: null, error: null },
  description: 'Codex subscription profile is not selected (PILOT_MODEL_PROFILE=codex enables it)',
  capabilityError: null,
  credentialsEncrypted: false,
  credentialsPath: null,
};

export const CODEX_ACTIONS = ['refresh', 'sign-in', 'cancel-sign-in', 'sign-out'] as const;

export type CodexActionType = (typeof CODEX_ACTIONS)[number];

/**
 * Everything the panel can ask about the Codex profile, as one validated
 * discriminated union — the same shape permission, window and conversation
 * actions use, for the same reason (`docs/runbook.md` cross-lane issue 2).
 */
export type CodexAction =
  /** Re-read the credential store. */
  | { readonly type: 'refresh' }
  /** Start a device-code sign-in. Returns at once; progress arrives as an event. */
  | { readonly type: 'sign-in' }
  /** Abandon a sign-in in flight. */
  | { readonly type: 'cancel-sign-in' }
  /** Forget the stored credential. */
  | { readonly type: 'sign-out' };

export const codexActionSchema: z.ZodType<CodexAction> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('refresh') }),
  z.strictObject({ type: z.literal('sign-in') }),
  z.strictObject({ type: z.literal('cancel-sign-in') }),
  z.strictObject({ type: z.literal('sign-out') }),
]);
