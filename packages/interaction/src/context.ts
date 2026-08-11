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
  /**
   * Everything the active run has streamed so far. This is what the panel
   * shows; PR-026 keeps it separate from `pendingAnswer` because the two
   * diverge as soon as a sentence is handed to TTS.
   */
  readonly answerText: string;
  /**
   * Answer text accumulated for the active utterance but **not yet spoken** —
   * the fragment still waiting for a terminator (PR-026). Drained into `speak`
   * effects as sentences complete, and always emptied when the run ends, so no
   * tail is left behind.
   */
  readonly pendingAnswer: string;
  /**
   * Injected-clock reading at which `pendingAnswer` started waiting, or `null`
   * when nothing is waiting. The phrase timeout is measured from here — never
   * from a wall clock.
   */
  readonly pendingAnswerSince: number | null;
  /** Chunks already handed to TTS for the active speech stream (PR-026). */
  readonly spokenChunkCount: number;
  readonly transcript: readonly TranscriptEntry[];
  readonly lastError: SerializedPilotError | null;
  readonly updatedAt: number;
}

/**
 * Permissions that must be granted before the machine will leave
 * `needs-permission`. Overridable so a harness can require more or fewer.
 *
 * **Screen Recording only, since PR-044** (runbook follow-up 35). Until then
 * this listed all four kinds, which made `needs-permission` mean "any of the
 * four is missing" and put Pilot into a hard stop the moment Accessibility was
 * refused. `docs/system-design.md` §16 asks for the opposite:
 *
 * > | Accessibility denied | Continue with visual pointer coordinates and
 * >   disclose reduced grounding |
 *
 * The three narrower kinds each have their own, already-correct handling and
 * none of them is a reason to stop:
 *
 *  - **Accessibility** — degrades. Pilot keeps the selected window, its frames,
 *    the pointer coordinates and therefore the crop; what it loses is the name
 *    of the control under the pointer. {@link accessibilityGroundingOf} turns
 *    that into the envelope's `targetAvailability: 'unavailable'`, so the model
 *    is told what it does not have, and the desktop catalogue's `degrades`
 *    consequence is what puts the disclosure in front of the user.
 *  - **Microphone / Speech Recognition** — limit. They close the *spoken* path
 *    only; a typed question is answered exactly as well. The speech adapter
 *    refuses to open a microphone it has no permission for and raises a typed
 *    error, which §16's "STT fails → offer text input" row already covers, and
 *    `hotkeyBlockingPermission` names the missing grant on the push-to-talk
 *    control.
 *
 * This is the single definition of "Pilot cannot work at all", and it now
 * agrees with the desktop permission catalogue, where `screen-recording` is the
 * one kind whose consequence is `blocks`.
 */
export const REQUIRED_PERMISSIONS: readonly PermissionKind[] = ['screen-recording'];

/**
 * Every permission the full MVP flow uses, in onboarding order (mvp-01 §3).
 *
 * Kept as a named list because PR-008/PR-009's onboarding must go on asking for
 * all four — degraded must not become "we stopped asking" — while only
 * {@link REQUIRED_PERMISSIONS} decides whether the machine can run.
 */
export const ALL_PERMISSIONS: readonly PermissionKind[] = [
  'screen-recording',
  'accessibility',
  'microphone',
  'speech-recognition',
];

/**
 * Whether the pointer's *target* can be named this session (PR-044).
 *
 *  - `available`   — Accessibility is granted; a hit test may name the control.
 *  - `unavailable` — refused or withheld by policy. No element can be named,
 *    anywhere, until the user changes it. §16's degraded mode.
 *  - `unknown`     — nothing has been decided: no snapshot yet, or a permission
 *    nobody has been asked for. **Not** `unavailable`: runbook hazard 22 is the
 *    record of what happens when a tri-state is read as a boolean here, and
 *    telling a model "Accessibility is not permitted" while Pilot is still
 *    asking macOS would be exactly that bug in the envelope.
 */
export type PointerTargetGrounding = 'available' | 'unavailable' | 'unknown';

export function accessibilityGroundingOf(
  permissions: PermissionSnapshot | null,
): PointerTargetGrounding {
  if (permissions === null) {
    return 'unknown';
  }
  switch (permissions.accessibility.state) {
    case 'granted':
      return 'available';
    case 'denied':
    case 'restricted':
      return 'unavailable';
    case 'unknown':
      return 'unknown';
  }
}

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
    answerText: '',
    pendingAnswer: '',
    pendingAnswerSince: null,
    spokenChunkCount: 0,
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
