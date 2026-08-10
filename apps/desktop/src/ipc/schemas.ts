import {
  conversationIdSchema,
  interactionStateSchema,
  observedWindowSchema,
  permissionKindSchema,
  permissionSnapshotSchema,
  serializedPilotErrorSchema,
  utteranceIdSchema,
  windowIdSchema,
} from '@pilot/shared';
import type { InteractionCommand, PilotViewState, TranscriptEntry } from '@pilot/platform';
import { z } from 'zod';

/**
 * Runtime schemas for the values that cross renderer ↔ main.
 *
 * `@pilot/platform` declares `PilotViewState`, `TranscriptEntry` and
 * `InteractionCommand` as compile-time types only — the interaction lane
 * (PR-006, PR-024…PR-027) owns their behaviour, and PR-001 deliberately left
 * the wire representation to whoever built the first transport. That is this
 * file. Each schema is annotated with the platform type it must produce, so a
 * contract change in `@pilot/platform` breaks the build here rather than
 * silently letting an unvalidated shape through `parseRequestEnvelope`.
 */

export const transcriptEntrySchema: z.ZodType<TranscriptEntry> = z.strictObject({
  utteranceId: utteranceIdSchema,
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  at: z.number().int().nonnegative(),
  pending: z.boolean(),
});

export const pilotViewStateSchema: z.ZodType<PilotViewState> = z.strictObject({
  state: interactionStateSchema,
  conversationId: conversationIdSchema.nullable(),
  permissions: permissionSnapshotSchema.nullable(),
  selectedWindow: observedWindowSchema.nullable(),
  observationEnabled: z.boolean(),
  speaking: z.boolean(),
  liveTranscript: z.string().nullable(),
  transcript: z.array(transcriptEntrySchema).readonly(),
  lastError: serializedPilotErrorSchema.nullable(),
});

/**
 * Bound on free text arriving from the renderer. The renderer is untrusted
 * input like any other process boundary (system-design §14); a text question
 * that exceeds this is a bug or an attack, not a long question.
 */
export const MAX_SUBMITTED_TEXT_LENGTH = 8_000;

export const interactionCommandSchema: z.ZodType<InteractionCommand> = z.discriminatedUnion(
  'type',
  [
    z.strictObject({ type: z.literal('select-window'), windowId: windowIdSchema }),
    z.strictObject({ type: z.literal('set-observation-enabled'), enabled: z.boolean() }),
    z.strictObject({ type: z.literal('push-to-talk-down') }),
    z.strictObject({ type: z.literal('push-to-talk-up') }),
    z.strictObject({
      type: z.literal('submit-text'),
      text: z.string().min(1).max(MAX_SUBMITTED_TEXT_LENGTH),
    }),
    z.strictObject({ type: z.literal('look-now') }),
    z.strictObject({ type: z.literal('interrupt') }),
    z.strictObject({ type: z.literal('stop-speaking') }),
    z.strictObject({ type: z.literal('clear-conversation') }),
    z.strictObject({ type: z.literal('pause') }),
    z.strictObject({ type: z.literal('resume') }),
    z.strictObject({ type: z.literal('dismiss-error') }),
  ],
);

/**
 * Scenarios the fake shell can be driven into. PR-002 ships no real platform,
 * agent or voice code, so the demo needs an explicit way to reach every visible
 * state — including the failure state, which must be rendered rather than
 * silently swallowed.
 */
export const VIEW_SCENARIOS = [
  'idle',
  'listening',
  'thinking',
  'speaking',
  'observing',
  'error',
] as const;

export type ViewScenario = (typeof VIEW_SCENARIOS)[number];

export const viewScenarioSchema = z.enum(VIEW_SCENARIOS);

export const emptyPayloadSchema = z.strictObject({});

export const appInfoSchema = z.strictObject({
  /** Application version, from the desktop package manifest. */
  version: z.string(),
  /** IPC contract version both sides agreed on. */
  protocolVersion: z.number().int().nonnegative(),
  platform: z.string(),
  /**
   * False when this build is running with fakes instead of real platform,
   * agent and voice code — which is every PR-002 build.
   */
  usesRealPlatform: z.boolean(),
});

export type AppInfo = z.infer<typeof appInfoSchema>;

export const panelVisibilitySchema = z.strictObject({ visible: z.boolean() });

export type PanelVisibility = z.infer<typeof panelVisibilitySchema>;

export const setPanelVisibleSchema = z.strictObject({
  visible: z.boolean().optional(),
  /** When true, `visible` is ignored and the panel toggles. */
  toggle: z.boolean().optional(),
});

export type SetPanelVisibleRequest = z.infer<typeof setPanelVisibleSchema>;

export const acknowledgementSchema = z.strictObject({ accepted: z.literal(true) });

export type Acknowledgement = z.infer<typeof acknowledgementSchema>;

// ---------------------------------------------------------------------------
// Permission onboarding (PR-008)
// ---------------------------------------------------------------------------

/**
 * Whether Pilot can open the platform's permission settings from here.
 *
 * Modelled as data rather than assumed, because it is false on every machine
 * this repository is developed on: `PermissionAdapter.openSettings` describes a
 * macOS pane, and there is no such pane on Linux. Carrying the reason across
 * the wire is what lets the panel render a disabled control that explains
 * itself instead of a button that does nothing (delivery rule: "expose an
 * explicit failure or unavailable state").
 */
export const permissionSettingsAvailabilitySchema = z.strictObject({
  available: z.boolean(),
  /** `process.platform` of the main process, for the explanation text. */
  platform: z.string(),
  /** Non-null exactly when `available` is false. */
  reason: z.string().nullable(),
});

export type PermissionSettingsAvailability = z.infer<typeof permissionSettingsAvailabilitySchema>;

export const PERMISSION_ACTIONS = ['refresh', 'request', 'open-settings', 'dismiss-error'] as const;

export type PermissionActionType = (typeof PERMISSION_ACTIONS)[number];

export type PermissionAction =
  /** Re-read every permission from the platform. The "check again" affordance. */
  | { readonly type: 'refresh' }
  /** Ask the platform to prompt. Only meaningful while `canRequest` is true. */
  | { readonly type: 'request'; readonly kind: z.infer<typeof permissionKindSchema> }
  | { readonly type: 'open-settings'; readonly kind: z.infer<typeof permissionKindSchema> }
  | { readonly type: 'dismiss-error' };

export const permissionActionSchema: z.ZodType<PermissionAction> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('refresh') }),
  z.strictObject({ type: z.literal('request'), kind: permissionKindSchema }),
  z.strictObject({ type: z.literal('open-settings'), kind: permissionKindSchema }),
  z.strictObject({ type: z.literal('dismiss-error') }),
]);

/**
 * Named permission states a reviewer can switch between at runtime.
 *
 * PR-008 has no real TCC to drive (runbook §5 amendment 8: Mac verification is
 * deferred), so the demo required by `docs/implementation.md` — "switch fixtures
 * through unknown, denied, restricted, and granted states" — has to be
 * reachable without editing source. These names are the vocabulary for that,
 * validated like any other renderer input.
 */
export const PERMISSION_FIXTURES = [
  'unknown',
  'granted',
  'denied',
  'restricted',
  'screen-denied',
  'accessibility-denied',
  'mixed',
] as const;

export type PermissionFixtureName = (typeof PERMISSION_FIXTURES)[number];

export const permissionFixtureSchema = z.enum(PERMISSION_FIXTURES);

/**
 * Everything the panel needs to draw the onboarding view, and nothing more.
 *
 * Deliberately close to the platform contract: the presentation (titles,
 * explanations, severity) is derived in `src/permissions/view-model.ts` from
 * this plus the static catalogue, so the wire format does not have to change
 * when the copy does.
 */
export const permissionGateStateSchema = z.strictObject({
  /** Null until the first check completes — never conflated with "denied". */
  snapshot: permissionSnapshotSchema.nullable(),
  /** Kinds with a check, prompt or settings call in flight right now. */
  pending: z.array(permissionKindSchema).readonly(),
  /** When the snapshot was last read from the platform. */
  checkedAt: z.number().int().nonnegative().nullable(),
  settings: permissionSettingsAvailabilitySchema,
  /** The last refused permission action; cleared by `dismiss-error`. */
  lastError: serializedPilotErrorSchema.nullable(),
  /** The fixture currently loaded, or null in a build with a real platform. */
  fixture: permissionFixtureSchema.nullable(),
});

export type PermissionGateState = z.infer<typeof permissionGateStateSchema>;
