import {
  conversationIdSchema,
  interactionStateSchema,
  observedWindowSchema,
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
