import {
  isGranted,
  type ConversationId,
  type InteractionState,
  type ObservationId,
  type ObservedWindow,
  type PermissionKind,
  type PermissionSnapshot,
  type RunId,
  type SerializedPilotError,
  type SpeechId,
  type UtteranceId,
} from '@pilot/shared';
import type { PilotViewState, TranscriptEntry } from '@pilot/platform';

/**
 * Everything the machine remembers.
 *
 * `state` is the mvp-01 §7 state name; the rest is the data the transition
 * table needs in order to decide, plus the identity fields that make stale
 * results provable.
 */
export interface InteractionContext {
  readonly state: InteractionState;
  readonly conversationId: ConversationId;
  readonly permissions: PermissionSnapshot | null;
  readonly knownWindows: readonly ObservedWindow[];
  readonly selectedWindow: ObservedWindow | null;
  readonly observationEnabled: boolean;
  /** Set by the `pause` command, cleared by `resume`. */
  readonly paused: boolean;
  /** Set by the platform lock event. Suspends exactly like `paused`. */
  readonly screenLocked: boolean;

  /** The one utterance results may refer to. Everything else is stale. */
  readonly activeUtteranceId: UtteranceId | null;
  readonly activeRunId: RunId | null;
  readonly activeSpeechId: SpeechId | null;
  readonly activeObservationId: ObservationId | null;
  /** The utterance whose transcript has already been accepted, for duplicates. */
  readonly finalizedUtteranceId: UtteranceId | null;

  /**
   * Push-to-talk start and end timestamps (system-design §6: "the interaction
   * controller records push-to-talk start and end timestamps"). PR-024 anchors
   * the question envelope on `utteranceEndedAt`; both are `null` until an
   * utterance has begun. Recorded here, never read from a wall clock.
   */
  readonly utteranceStartedAt: number | null;
  readonly utteranceEndedAt: number | null;

  readonly liveTranscript: string | null;
  /** Answer text accumulated for the active utterance but not yet spoken. */
  readonly pendingAnswer: string;
  readonly transcript: readonly TranscriptEntry[];
  readonly lastError: SerializedPilotError | null;
  readonly updatedAt: number;
}

/**
 * Permissions the MVP flow needs before it will leave `needs-permission`
 * (mvp-01 §3). Overridable so a text-only harness can require fewer.
 */
export const REQUIRED_PERMISSIONS: readonly PermissionKind[] = [
  'screen-recording',
  'accessibility',
  'microphone',
  'speech-recognition',
];

export function permissionsSatisfied(
  permissions: PermissionSnapshot | null,
  required: readonly PermissionKind[] = REQUIRED_PERMISSIONS,
): boolean {
  if (permissions === null) {
    // Nothing reported yet. Do not block the machine on an unknown snapshot;
    // the platform emits `permissions-changed` as soon as it knows.
    return true;
  }
  return required.every((kind) => isGranted(permissions[kind]));
}

/**
 * The state Pilot rests in when nothing is happening.
 *
 * Ordered by precedence: a missing permission outranks a pause, a pause
 * outranks having a window, and a window is required in order to observe.
 * Every transition that means "go back to doing nothing" targets `'resting'`
 * and is resolved through this function, which is why there is exactly one
 * definition of what "back to normal" means.
 */
export function restingState(
  context: InteractionContext,
  required: readonly PermissionKind[] = REQUIRED_PERMISSIONS,
): InteractionState {
  if (!permissionsSatisfied(context.permissions, required)) {
    return 'needs-permission';
  }
  if (context.paused || context.screenLocked) {
    return 'paused';
  }
  if (context.selectedWindow === null || !context.observationEnabled) {
    return 'idle';
  }
  return 'observing';
}

/** States in which Pilot is doing work that a new question would interrupt. */
export const ACTIVE_STATES: readonly InteractionState[] = [
  'listening',
  'transcribing',
  'thinking',
  'observing-screen',
  'speaking',
];

export function isActiveState(state: InteractionState): boolean {
  return ACTIVE_STATES.includes(state);
}

export interface CreateContextOptions {
  readonly conversationId: ConversationId;
  readonly now: number;
  readonly permissions?: PermissionSnapshot | null;
  readonly windows?: readonly ObservedWindow[];
  readonly selectedWindow?: ObservedWindow | null;
  readonly observationEnabled?: boolean;
}

export function createInteractionContext(options: CreateContextOptions): InteractionContext {
  const selectedWindow = options.selectedWindow ?? null;
  const base: InteractionContext = {
    state: 'idle',
    conversationId: options.conversationId,
    permissions: options.permissions ?? null,
    knownWindows: options.windows ?? [],
    selectedWindow,
    observationEnabled: options.observationEnabled ?? selectedWindow !== null,
    paused: false,
    screenLocked: false,
    activeUtteranceId: null,
    activeRunId: null,
    activeSpeechId: null,
    activeObservationId: null,
    finalizedUtteranceId: null,
    utteranceStartedAt: null,
    utteranceEndedAt: null,
    liveTranscript: null,
    pendingAnswer: '',
    transcript: [],
    lastError: null,
    updatedAt: options.now,
  };
  return { ...base, state: restingState(base) };
}

/** The renderer-facing projection (`@pilot/platform`), derived, never stored. */
export function toViewState(context: InteractionContext): PilotViewState {
  return {
    state: context.state,
    conversationId: context.conversationId,
    permissions: context.permissions,
    selectedWindow: context.selectedWindow,
    observationEnabled: context.observationEnabled,
    speaking: context.state === 'speaking' || context.activeSpeechId !== null,
    liveTranscript: context.liveTranscript,
    transcript: context.transcript,
    lastError: context.lastError,
  };
}

/** Appends or updates the assistant entry for the utterance being answered. */
export function withAssistantText(
  transcript: readonly TranscriptEntry[],
  utteranceId: UtteranceId,
  text: string,
  at: number,
  pending: boolean,
): readonly TranscriptEntry[] {
  const index = transcript.findIndex(
    (entry) => entry.role === 'assistant' && entry.utteranceId === utteranceId,
  );
  const entry: TranscriptEntry = { utteranceId, role: 'assistant', text, at, pending };
  if (index < 0) {
    return [...transcript, entry];
  }
  const next = [...transcript];
  next[index] = entry;
  return next;
}

export function withUserText(
  transcript: readonly TranscriptEntry[],
  utteranceId: UtteranceId,
  text: string,
  at: number,
): readonly TranscriptEntry[] {
  return [...transcript, { utteranceId, role: 'user', text, at, pending: false }];
}
