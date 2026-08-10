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

// ---------------------------------------------------------------------------
// Window picker and observation controls (PR-009)
// ---------------------------------------------------------------------------

/**
 * Something that happened *to* observation, which the user has to be told about
 * and which needs an answer from them.
 *
 * Both reasons are conditions from the capture lifecycle (system-design §6):
 * observation may only run while a valid window is selected and Screen
 * Recording is granted. When either stops being true, Pilot stops watching —
 * and system-design §16 requires that it says so and asks for a new selection
 * rather than going quiet.
 */
export const OBSERVATION_NOTICE_REASONS = [
  /** §16 "Selected window closed": stop observation, clear, prompt for selection. */
  'selected-window-closed',
  /** Screen Recording was withdrawn while Pilot was allowed to observe. */
  'observation-permission-lost',
] as const;

export type ObservationNoticeReason = (typeof OBSERVATION_NOTICE_REASONS)[number];

export const observationNoticeSchema = z.strictObject({
  reason: z.enum(OBSERVATION_NOTICE_REASONS),
  /** The window this is about. Null when the notice is not about one window. */
  window: observedWindowSchema.nullable(),
  /**
   * Whether Pilot was actually capturing when this happened. "The window you
   * were being watched through closed" and "the window you had lined up closed"
   * are different messages, and only the first is about privacy.
   */
  wasObserving: z.boolean(),
  at: z.number().int().nonnegative(),
});

export type ObservationNotice = z.infer<typeof observationNoticeSchema>;

/**
 * Everything the panel needs to draw the window picker, and nothing more.
 *
 * The *selection* is deliberately not here: `PilotViewState.selectedWindow` is
 * the single source of truth for what Pilot is watching, and duplicating it
 * would create two answers to the only question that matters. This carries the
 * list, when it was read, and the one thing the view state cannot express — the
 * §16 prompt for a new selection.
 */
export const windowGateStateSchema = z.strictObject({
  windows: z.array(observedWindowSchema).readonly(),
  /** Null until the first list completes — never conflated with "no windows". */
  listedAt: z.number().int().nonnegative().nullable(),
  /** True while a list is in flight, so "loading" never renders as "empty". */
  listing: z.boolean(),
  notice: observationNoticeSchema.nullable(),
  /** The last refused window action; cleared by `dismiss-notice`. */
  lastError: serializedPilotErrorSchema.nullable(),
  /**
   * True when this build can be driven through window-lifecycle events from the
   * panel. False in a build on the real macOS adapter, where the panel must not
   * offer a control the main process would refuse.
   */
  demoEvents: z.boolean(),
});

export type WindowGateState = z.infer<typeof windowGateStateSchema>;

export const WINDOW_ACTIONS = [
  'refresh',
  'select',
  'start',
  'stop',
  'pause',
  'resume',
  'dismiss-notice',
] as const;

export type WindowActionType = (typeof WINDOW_ACTIONS)[number];

/**
 * Every observation control the panel can operate, as one validated
 * discriminated union — the same shape permission actions use, for the same
 * reason: a new affordance cannot arrive without a validator.
 *
 * There is no separate "change window" member. Changing the observed window
 * *is* `select` with a different id, which is what the interaction contract
 * models (`select-window` stops the previous capture and clears its buffers).
 */
export type WindowAction =
  /** Re-read the window list from the platform. */
  | { readonly type: 'refresh' }
  /** Watch this window. Also the "change window" action. */
  | { readonly type: 'select'; readonly windowId: z.infer<typeof windowIdSchema> }
  /** Turn observation on for the selected window. */
  | { readonly type: 'start' }
  /** Turn observation off. Nothing is captured until it is started again. */
  | { readonly type: 'stop' }
  /** Suspend all of Pilot, observation included. */
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'dismiss-notice' };

export const windowActionSchema: z.ZodType<WindowAction> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('refresh') }),
  z.strictObject({ type: z.literal('select'), windowId: windowIdSchema }),
  z.strictObject({ type: z.literal('start') }),
  z.strictObject({ type: z.literal('stop') }),
  z.strictObject({ type: z.literal('pause') }),
  z.strictObject({ type: z.literal('resume') }),
  z.strictObject({ type: z.literal('dismiss-notice') }),
]);

/**
 * Window-lifecycle events a reviewer can cause at runtime.
 *
 * PR-011's real window enumeration cannot be verified here (runbook §5
 * amendment 8), so the states that only a *changing* window list can produce —
 * the selected window closing mid-observation, a window being retitled while
 * selected — need a way to be reached without editing source. Validated like
 * any other renderer input, and refused outright by a build with no fake
 * window adapter behind it.
 */
export const WINDOW_DEMO_EVENTS = [
  'close-selected',
  'retitle-selected',
  'hide-selected',
  'restore-windows',
] as const;

export type WindowDemoEvent = (typeof WINDOW_DEMO_EVENTS)[number];

export const windowDemoEventSchema = z.enum(WINDOW_DEMO_EVENTS);
