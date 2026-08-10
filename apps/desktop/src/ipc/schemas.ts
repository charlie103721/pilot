import {
  conversationIdSchema,
  interactionStateSchema,
  observedWindowSchema,
  permissionKindSchema,
  permissionSnapshotSchema,
  serializedPilotErrorSchema,
  speechRecognitionDisclosureSchema,
  utteranceIdSchema,
  windowIdSchema,
  PILOT_ERROR_CODES,
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

/*
 * REMOVED BY PR-029: `VIEW_SCENARIOS` / `viewScenarioSchema`.
 *
 * PR-002's scenario bar forced the *fake* controller into a named visible state
 * by patching its view state. With the real `PilotInteractionController` there
 * is no such door and there should not be one: a state is reached by sending
 * the machine an input, and the machine decides. `shell.ts` said so itself —
 * "Present only while the shell runs on fakes. Omit once PR-029 lands."
 *
 * What replaced it, without a forced state anywhere: the replay bar
 * (`pilot:demo/conversation`) now holds real conversations, `PILOT_*_FIXTURE`
 * environment switches reach the permission, hotkey, disclosure and model
 * states, and the fake window controls (`pilot:demo/window-event`) still close
 * and retitle the selected window.
 */

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
  /**
   * PR-040. The capture stream ended on its own — the window blocks capture
   * (§16 "protected/blank content"), or capture failed past the adapter's own
   * stream restarts. Distinct from the two above because the *permission* is
   * intact and the *window* is still there: only the pixels are unavailable.
   */
  'capture-unavailable',
  /**
   * PR-040. The native helper died. Reported separately because the remedy is
   * different — nothing about the window or the permission needs changing, and
   * a helper that is coming back needs no action at all.
   */
  'helper-unavailable',
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

// ---------------------------------------------------------------------------
// Conversation and developer diagnostics (PR-010)
// ---------------------------------------------------------------------------

/**
 * DEVELOPER DIAGNOSTICS ARE TIMINGS AND COUNTS. NOTHING ELSE.
 *
 * `docs/system-design.md` §17 lists exactly what may be measured, and §13
 * lists what is never logged: base64 images, raw audio, and prompts containing
 * screen text. A diagnostics panel is the obvious place for that rule to be
 * broken by accident — one `details` field of type `unknown`, one "just the
 * first 40 characters of the answer", and every other lane's care is undone.
 *
 * So the rule is enforced by the *shape* rather than by review: a
 * {@link TelemetrySample} has five numeric fields and one field drawn from a
 * closed vocabulary, and there is no member of this schema into which a
 * transcript, a window title, a file path or an image can be put. Making the
 * panel show content would require changing this type, which is a visible
 * contract change rather than a quiet one.
 */

/** How a metric's `value` is to be read. */
export const TELEMETRY_UNITS = ['ms', 'count', 'bytes'] as const;

export type TelemetryUnit = (typeof TELEMETRY_UNITS)[number];

/**
 * The measurable quantities of system-design §17, one name each.
 *
 * The first seven are §17's list verbatim (the "abort and failure categories"
 * row becomes two metrics whose `category` carries the class). The last two
 * are the compaction counters of §11, which the panel surfaces so a compacted
 * conversation is visible as numbers — the `context-compacted` event itself
 * carries the summary *text*, which is content and is therefore not recorded.
 */
export const TELEMETRY_METRICS = [
  'capture-to-observation',
  'stt-duration',
  'time-to-first-token',
  'time-to-first-sentence',
  'observation-calls',
  'image-bytes',
  'active-images',
  'abort',
  'failure',
  'context-tokens-before',
  'context-tokens-after',
] as const;

export type TelemetryMetric = (typeof TELEMETRY_METRICS)[number];

export const telemetryMetricSchema = z.enum(TELEMETRY_METRICS);

export const TELEMETRY_METRIC_UNITS: Readonly<Record<TelemetryMetric, TelemetryUnit>> = {
  'capture-to-observation': 'ms',
  'stt-duration': 'ms',
  'time-to-first-token': 'ms',
  'time-to-first-sentence': 'ms',
  'observation-calls': 'count',
  'image-bytes': 'bytes',
  'active-images': 'count',
  abort: 'count',
  failure: 'count',
  'context-tokens-before': 'count',
  'context-tokens-after': 'count',
};

/**
 * Why Pilot stopped waiting for something. §17's "abort category".
 *
 * A closed vocabulary rather than free text, for the reason given above: an
 * abort reason written by hand at the call site is a place a question could be
 * quoted into the diagnostics surface.
 */
export const ABORT_CATEGORIES = [
  /** The user interrupted an answer in progress. */
  'user-interrupted',
  /** A new question replaced the one in flight. */
  'new-question',
  /** Speech was stopped without abandoning the answer. */
  'stopped-speaking',
  /** The conversation was cleared. */
  'conversation-cleared',
  /** The observed window changed, so the answer in flight was about the old one. */
  'window-changed',
  /** Observation stopped: paused, permission withdrawn, or the window closed. */
  'observation-stopped',
  /** Pilot is shutting down. */
  'shutdown',
] as const;

export type AbortCategory = (typeof ABORT_CATEGORIES)[number];

/**
 * The `category` vocabulary: an abort reason, or a `PilotErrorCode`.
 *
 * `PilotErrorCode` is already the product's closed failure taxonomy — UI code
 * switches on it and never on a message — so "failure category" needs no second
 * enumeration. Note what is *not* here: `SerializedPilotError.userMessage` and
 * `details`, either of which could carry a window title.
 */
export const telemetryCategorySchema = z.union([
  z.enum(ABORT_CATEGORIES),
  z.enum(PILOT_ERROR_CODES),
]);

export type TelemetryCategory = z.infer<typeof telemetryCategorySchema>;

export const telemetrySampleSchema = z.strictObject({
  /** Monotonic within one run, so the panel can order and de-duplicate. */
  seq: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
  /** Which question this belongs to, 1-based. `0` means "not part of a turn". */
  turn: z.number().int().nonnegative(),
  metric: telemetryMetricSchema,
  /** Milliseconds, bytes or a count — read through {@link TELEMETRY_METRIC_UNITS}. */
  value: z.number().nonnegative().finite(),
  /** Non-null exactly for `abort` and `failure`. */
  category: telemetryCategorySchema.nullable(),
});

export type TelemetrySample = z.infer<typeof telemetrySampleSchema>;

/**
 * The ring buffer as the panel sees it.
 *
 * `recorded` and `dropped` are carried because a ring that silently forgets is
 * indistinguishable from one that was never written to, and "the numbers you
 * are reading are the last 200 of 4,000" changes how they should be read.
 */
export const telemetryBufferSchema = z.strictObject({
  samples: z.array(telemetrySampleSchema).readonly(),
  capacity: z.number().int().positive(),
  recorded: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
});

/**
 * Default ring capacity: enough to cover several questions without becoming a
 * memory story of its own. Declared here rather than in the main process so the
 * renderer's pre-connection placeholder does not have to invent a number.
 */
export const DEFAULT_TELEMETRY_CAPACITY = 200;

export type TelemetryBuffer = z.infer<typeof telemetryBufferSchema>;

/**
 * Push-to-talk, as the panel needs it.
 *
 * Deliberately the *result* of `isHotkeyUsable`, `hotkeyUnavailableMessage` and
 * `hotkeyBlockingPermission` rather than the raw `HotkeyAvailability`: those
 * three functions live beside the type in `@pilot/platform` precisely so every
 * shell says the same thing, and evaluating them once in the main process is
 * what makes that true here. `status` is carried as well so the diagnostics
 * surface can show the state without re-deriving the words.
 */
export const pushToTalkSchema = z.strictObject({
  usable: z.boolean(),
  status: z.enum(['active', 'stopped', 'unavailable']),
  /** Non-null exactly when `usable` is false. */
  message: z.string().nullable(),
  /** The permission that would fix it, when granting one would. */
  blockingPermission: permissionKindSchema.nullable(),
  /** The shortcut in the user's words, e.g. `"Right Option"`. */
  label: z.string(),
});

export type PushToTalk = z.infer<typeof pushToTalkSchema>;

/**
 * Fixture conversations a reviewer can replay at runtime.
 *
 * `docs/implementation.md` requires PR-010 to demo "a fixture-driven
 * conversation and ring-buffer telemetry". PR-010 could only replay scripted
 * view states; since PR-029 these same five names drive **real** commands into
 * the real controller and a real `PiAgentSession` (`main/conversation-driver.ts`),
 * so the wire vocabulary is unchanged and what it does behind the panel is not.
 * The recogniser (PR-032) and capture (PR-028) are still mocked. Validated like
 * any other renderer input and refused outright by a build with no driver.
 */
export const CONVERSATION_FIXTURES = [
  /** Held the key, asked, Pilot looked, answered aloud in chunks. */
  'spoken-question',
  /** Typed the same question. No microphone involved. */
  'typed-question',
  /** An answer interrupted halfway through being spoken. */
  'interrupted-answer',
  /** The recogniser fails: `error`, where typing is the documented way out. */
  'stt-failure',
  /** Back to an empty conversation with an empty ring buffer. */
  'reset',
] as const;

export type ConversationFixtureName = (typeof CONVERSATION_FIXTURES)[number];

export const conversationFixtureSchema = z.enum(CONVERSATION_FIXTURES);

/**
 * Everything the conversation panel needs that `PilotViewState` does not carry.
 *
 * The transcript, the streamed answer and the interaction state are *not* here:
 * `PilotViewState` is the one answer to those, exactly as
 * `PilotViewState.selectedWindow` is the one answer to what Pilot is watching
 * (PR-009). This carries the developer telemetry, the two voice facts the
 * renderer cannot know (whether the shortcut works, and what the recogniser
 * would do with the audio), and the demo switches.
 */
export const conversationGateStateSchema = z.strictObject({
  telemetry: telemetryBufferSchema,
  /** Whether the developer diagnostics surface is open. Off by default. */
  diagnosticsVisible: z.boolean(),
  /** Null when this build has no hotkey adapter at all. */
  pushToTalk: pushToTalkSchema.nullable(),
  /**
   * What the recogniser would do with the microphone audio (PR-014), or null
   * when no speech adapter has said. Routed here because nothing else surfaces
   * it: a Mac that cannot recognise the user's language on device otherwise
   * refuses to listen with a message nobody ever sees.
   */
  disclosure: speechRecognitionDisclosureSchema.nullable(),
  /** The fixture conversation currently loaded, or null. */
  fixture: conversationFixtureSchema.nullable(),
  /** True when this build can replay fixture conversations from the panel. */
  demoFixtures: z.boolean(),
});

export type ConversationGateState = z.infer<typeof conversationGateStateSchema>;

export const CONVERSATION_ACTIONS = [
  'refresh',
  'clear-telemetry',
  'set-diagnostics-visible',
] as const;

export type ConversationActionType = (typeof CONVERSATION_ACTIONS)[number];

/**
 * Everything the conversation panel can ask the main process for that is not a
 * command to the interaction controller, as one validated discriminated union —
 * the same shape permission and window actions use, for the same reason.
 */
export type ConversationAction =
  /** Re-read the telemetry buffer and the voice facts. */
  | { readonly type: 'refresh' }
  /** Empty the ring buffer. */
  | { readonly type: 'clear-telemetry' }
  | { readonly type: 'set-diagnostics-visible'; readonly visible: boolean };

export const conversationActionSchema: z.ZodType<ConversationAction> = z.discriminatedUnion(
  'type',
  [
    z.strictObject({ type: z.literal('refresh') }),
    z.strictObject({ type: z.literal('clear-telemetry') }),
    z.strictObject({ type: z.literal('set-diagnostics-visible'), visible: z.boolean() }),
  ],
);
