import type { InteractionState, SerializedPilotError, UtteranceId } from '@pilot/shared';
import type { InteractionCommand, PilotViewState } from '@pilot/platform';
import { isTextFallbackAvailable, lookupRule } from '@pilot/interaction';
import {
  MAX_SUBMITTED_TEXT_LENGTH,
  type ConversationGateState,
  type ModelDataDisclosureView,
  type ModelStatusView,
} from '../ipc/schemas.js';
import { readLifecycleGuidance, type LifecycleGuidanceView } from '../lifecycle/guidance.js';
import {
  readObservationFailure,
  type ObservationFailureView,
} from '../observation/failure-view.js';
import type { ObservationView } from '../observation/view-model.js';

/**
 * Derives the conversation panel.
 *
 * Pure and synchronous, like `src/permissions/view-model.ts` and
 * `src/observation/view-model.ts`, and for the same reason: the rules that
 * matter are product rules, and they are asserted in unit tests rather than
 * inferred from a rendered tree. The components below this file render
 * decisions; they do not make any.
 *
 * Two rules this file must never break.
 *
 * **Availability comes from the transition table, not from a hand-written
 * `switch`.** Every control asks `@pilot/interaction` whether the machine
 * accepts its command in the current state. This is not a stylistic
 * preference — PR-006 shipped `dismiss-error` with no validator behind it and
 * left the `error` state with no exit, and PR-025 later made `error +
 * submit-text` legal so a failed recogniser has a way out (system-design §16:
 * "STT fails → … then offer text input"). A panel that decides for itself that
 * `error` means "disable everything" makes the documented fallback unreachable
 * in the shipped app even though the machine allows it. Asking the table means
 * the affordance and the machine cannot disagree.
 *
 * **"Is Pilot capturing" is not answered here.** That is
 * `ObservationView.capturing` (PR-009), the single answer in the app, read
 * verbatim and never re-derived.
 */

// ---------------------------------------------------------------------------
// The interaction states
// ---------------------------------------------------------------------------

/**
 * Visual weight. One value per situation the user is in, not per state name:
 * `listening` and `transcribing` are both "Pilot has the microphone", which is
 * the fact that matters, while what separates them is the activity below.
 */
export type ConversationTone =
  'idle' | 'ready' | 'listening' | 'working' | 'speaking' | 'error' | 'blocked' | 'suspended';

/** What Pilot is actually doing. Distinct for every state that is doing one. */
export type ConversationActivity =
  | 'waiting'
  | 'hearing'
  | 'transcribing'
  | 'thinking'
  | 'looking'
  | 'answering'
  | 'halted'
  | 'failed';

export interface InteractionStatePresentation {
  readonly label: string;
  /** One sentence saying what this state means, in the user's terms. */
  readonly detail: string;
  readonly tone: ConversationTone;
  readonly activity: ConversationActivity;
  /** True while the user is waiting on Pilot for something. */
  readonly busy: boolean;
}

/**
 * Every state of mvp-01 §7, with its own words.
 *
 * Ten entries, ten different labels and ten different sentences. The five the
 * PR names — listening, thinking, observing, speaking, error — additionally
 * carry pairwise-distinct `tone`/`activity`, which is what makes them tellable
 * apart at a glance rather than by reading. `test/conversation/view-model.test.ts`
 * asserts all of that, so the copy cannot quietly collapse.
 */
export const INTERACTION_STATE_PRESENTATION: Readonly<
  Record<InteractionState, InteractionStatePresentation>
> = {
  idle: {
    label: 'Ready',
    detail: 'Pick a window, then hold the push-to-talk key or type a question.',
    tone: 'idle',
    activity: 'waiting',
    busy: false,
  },
  'needs-permission': {
    label: 'Needs permission',
    detail: 'Pilot needs screen and microphone access before it can help.',
    tone: 'blocked',
    activity: 'halted',
    busy: false,
  },
  paused: {
    label: 'Paused',
    detail: 'Pilot is suspended. Nothing is captured and no question is answered until you resume.',
    tone: 'suspended',
    activity: 'halted',
    busy: false,
  },
  observing: {
    label: 'Watching',
    detail: 'Pilot is following the selected window. Ask a question at any time.',
    tone: 'ready',
    activity: 'waiting',
    busy: false,
  },
  listening: {
    label: 'Listening',
    detail: 'The microphone is open. Release the key when you have finished speaking.',
    tone: 'listening',
    activity: 'hearing',
    busy: true,
  },
  transcribing: {
    label: 'Transcribing',
    detail: 'The microphone is closed. Pilot is turning what you said into text.',
    tone: 'listening',
    activity: 'transcribing',
    busy: true,
  },
  thinking: {
    label: 'Thinking',
    detail: 'Pilot is working out an answer. Nothing is being said aloud yet.',
    tone: 'working',
    activity: 'thinking',
    busy: true,
  },
  'observing-screen': {
    label: 'Looking at the screen',
    detail: 'Pilot is taking a fresh look at the selected window to answer your question.',
    tone: 'working',
    activity: 'looking',
    busy: true,
  },
  speaking: {
    label: 'Speaking',
    detail: 'Pilot is reading the answer aloud. Interrupt at any time.',
    tone: 'speaking',
    activity: 'answering',
    busy: true,
  },
  error: {
    label: 'Something went wrong',
    detail: 'The last question did not finish. The reason is below; you can type another question.',
    tone: 'error',
    activity: 'failed',
    busy: false,
  },
};

// ---------------------------------------------------------------------------
// Transcript and streamed response
// ---------------------------------------------------------------------------

/**
 * How far a turn got.
 *
 * `interrupted` is derived, not carried: `TranscriptEntry.pending` says the
 * text was still arriving, and the interaction state says whether anything is
 * still arriving *now*. A pending entry with a machine that has stopped working
 * is an answer that was cut off — which is exactly what an interruption leaves
 * behind, and rendering it as though it were finished would misreport it.
 */
export type TurnStatus = 'complete' | 'streaming' | 'interrupted';

export interface ConversationTurnView {
  readonly utteranceId: UtteranceId;
  readonly role: 'user' | 'assistant';
  readonly speaker: string;
  readonly text: string;
  readonly at: number;
  readonly status: TurnStatus;
  /** Length of the text so far. Lets the panel show progress without a total. */
  readonly characters: number;
}

const SPEAKER: Readonly<Record<'user' | 'assistant', string>> = {
  user: 'You',
  assistant: 'Pilot',
};

/** The answer currently arriving in chunks, if one is. */
export interface StreamedResponseView {
  readonly utteranceId: UtteranceId;
  readonly text: string;
  readonly characters: number;
  /** True while more is expected; false once the last chunk landed. */
  readonly streaming: boolean;
  /** True when it stopped arriving without finishing. */
  readonly interrupted: boolean;
}

function turnStatus(pending: boolean, busy: boolean): TurnStatus {
  if (!pending) {
    return 'complete';
  }
  return busy ? 'streaming' : 'interrupted';
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/**
 * Does the machine accept this command here?
 *
 * The single question every control below asks. `lookupRule` is the transition
 * table itself, so an affordance can never claim something the machine would
 * refuse, nor hide something it would accept.
 */
export function commandIsAccepted(
  state: InteractionState,
  command: InteractionCommand['type'],
): boolean {
  return lookupRule(state, command).kind === 'accept';
}

export const CONVERSATION_CONTROLS = [
  'push-to-talk',
  'look-now',
  'interrupt',
  'stop-speaking',
  'clear-conversation',
] as const;

export type ConversationControlId = (typeof CONVERSATION_CONTROLS)[number];

export interface ConversationControlView {
  readonly id: ConversationControlId;
  readonly label: string;
  readonly available: boolean;
  /** Non-null exactly when `available` is false. */
  readonly unavailableReason: string | null;
}

const CONTROL_COMMAND: Readonly<Record<ConversationControlId, InteractionCommand['type']>> = {
  'push-to-talk': 'push-to-talk-down',
  'look-now': 'look-now',
  interrupt: 'interrupt',
  'stop-speaking': 'stop-speaking',
  'clear-conversation': 'clear-conversation',
};

const CONTROL_LABELS: Readonly<Record<ConversationControlId, string>> = {
  'push-to-talk': 'Hold to talk',
  'look-now': 'Look now',
  interrupt: 'Interrupt',
  'stop-speaking': 'Stop speaking',
  'clear-conversation': 'Clear conversation',
};

/** Why a control is unavailable, in words the panel shows unchanged. */
export const CONVERSATION_REASONS = {
  notNow: 'Pilot cannot do this in its current state.',
  nothingRunning: 'Pilot is not working on anything right now.',
  notSpeaking: 'Pilot is not speaking.',
  emptyConversation: 'There is nothing to clear.',
  hotkeyUnavailable: 'The push-to-talk shortcut is not listening. Type your question instead.',
} as const;

function controlReason(id: ConversationControlId, input: ConversationViewInput): string | null {
  const state = input.view.state;
  if (!commandIsAccepted(state, CONTROL_COMMAND[id])) {
    switch (id) {
      case 'interrupt':
        return CONVERSATION_REASONS.nothingRunning;
      case 'stop-speaking':
        return CONVERSATION_REASONS.notSpeaking;
      case 'clear-conversation':
        return input.view.transcript.length === 0
          ? CONVERSATION_REASONS.emptyConversation
          : CONVERSATION_REASONS.notNow;
      default:
        return CONVERSATION_REASONS.notNow;
    }
  }
  if (id === 'push-to-talk' && input.gate.pushToTalk !== null && !input.gate.pushToTalk.usable) {
    // The machine would accept the key; the platform cannot deliver it. Two
    // different problems, and only this one is fixed by granting a permission.
    return input.gate.pushToTalk.message ?? CONVERSATION_REASONS.hotkeyUnavailable;
  }
  if (id === 'clear-conversation' && input.view.transcript.length === 0) {
    return CONVERSATION_REASONS.emptyConversation;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The text box
// ---------------------------------------------------------------------------

export interface ComposerView {
  /** Whether a question may be typed right now. */
  readonly available: boolean;
  /** Non-null exactly when `available` is false. */
  readonly unavailableReason: string | null;
  readonly label: string;
  readonly placeholder: string;
  readonly submitLabel: string;
  readonly maxLength: number;
  /**
   * Why typing is being offered *right now*, when that needs saying. Empty in
   * the ordinary case; one entry per reason speaking is not an option.
   */
  readonly notes: readonly string[];
  /** True when typing is currently the only way to ask a question. */
  readonly onlyWayToAsk: boolean;
}

export const COMPOSER_NOTES = {
  /**
   * system-design §16, "STT fails → preserve audio only until failure handling
   * completes, then offer text input". `error` is where a failed recogniser
   * leaves the machine, so this is the sentence that makes the documented
   * fallback real rather than theoretical.
   */
  afterFailure:
    'Pilot could not finish the last question. Type it instead — the text box still works.',
  hotkeyMissing: 'The push-to-talk shortcut is not available, so typing is the way to ask.',
} as const;

function buildComposer(input: ConversationViewInput): ComposerView {
  // Derived from the transition table, never from `state === 'error'`.
  const available = isTextFallbackAvailable(input.view.state);
  const hotkeyBlocked = input.gate.pushToTalk !== null && !input.gate.pushToTalk.usable;
  const speechBlocked = !commandIsAccepted(input.view.state, 'push-to-talk-down') || hotkeyBlocked;

  const notes: string[] = [];
  if (available && input.view.state === 'error') {
    notes.push(COMPOSER_NOTES.afterFailure);
  }
  if (available && hotkeyBlocked) {
    notes.push(input.gate.pushToTalk?.message ?? COMPOSER_NOTES.hotkeyMissing);
  }

  return {
    available,
    unavailableReason: available
      ? null
      : input.view.state === 'paused'
        ? 'Pilot is paused. Resume it before asking a question.'
        : input.view.state === 'needs-permission'
          ? 'Pilot needs permission before it can answer a question.'
          : CONVERSATION_REASONS.notNow,
    label: 'Ask about the selected window',
    placeholder: 'What does this toggle do?',
    submitLabel: 'Send',
    maxLength: MAX_SUBMITTED_TEXT_LENGTH,
    notes,
    onlyWayToAsk: available && speechBlocked,
  };
}

// ---------------------------------------------------------------------------
// The voice disclosure
// ---------------------------------------------------------------------------

export interface VoiceDisclosureView {
  readonly headline: string;
  readonly detail: string;
  /** True when audio would leave the machine, or Pilot refuses to listen. */
  readonly needsAttention: boolean;
  readonly leavesDevice: boolean;
  readonly destination: string;
  readonly service: string | null;
  readonly locale: string | null;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface ConversationViewInput {
  readonly view: PilotViewState;
  readonly gate: ConversationGateState;
  /** PR-009's observation view. Read, never re-derived. */
  readonly observation: ObservationView;
}

export interface ConversationView {
  readonly state: InteractionState;
  readonly stateLabel: string;
  readonly stateDetail: string;
  readonly tone: ConversationTone;
  readonly activity: ConversationActivity;
  readonly busy: boolean;
  /**
   * Whether Pilot is capturing the screen right now.
   * `ObservationView.capturing` verbatim — the app has one answer to this.
   */
  readonly capturing: boolean;
  readonly turns: readonly ConversationTurnView[];
  /** Partial recognition of the utterance in progress, or null. */
  readonly liveTranscript: string | null;
  readonly stream: StreamedResponseView | null;
  readonly empty: boolean;
  readonly composer: ComposerView;
  readonly controls: readonly ConversationControlView[];
  readonly disclosure: VoiceDisclosureView | null;
  /**
   * Where screen images go for the configured model, or null when no model
   * profile has said (PR-038, system-design §14). Passed through from the gate
   * unchanged — `describeModelDataDisclosure` in `@pilot/agent` is the one
   * place that decides the wording, so the panel, the log line and the demo all
   * say the same thing.
   */
  readonly modelDisclosure: ModelDataDisclosureView | null;
  /**
   * Which model profile is in force, for all four of them (runbook follow-ups
   * 46 and 33). Passed through from the gate unchanged — `describeModelStatus`
   * in `src/conversation/model-status.ts` is the one place that decides the
   * wording, so the panel, the startup log and `pnpm smoke:launch` cannot
   * drift, exactly as {@link modelDisclosure} does for PR-038's banner.
   *
   * Null only before the main process has answered. The shipping composition
   * always sets it: there is always a profile, and when nothing is configured
   * it is the faux development provider, which is not a language model.
   */
  readonly modelStatus: ModelStatusView | null;
  readonly lastError: SerializedPilotError | null;
  /**
   * Set when {@link lastError} is a refused observation (PR-030), whether the
   * model asked for it or the user pressed "Look now". Null for every other
   * failure, so the panel never claims a broken run was a screen problem.
   */
  readonly observationFailure: ObservationFailureView | null;
  /**
   * What to do about {@link lastError}, and which of the two endings it was
   * (PR-040). Never null when there is an error: `readLifecycleGuidance` is
   * total over the error taxonomy, so every failure the panel shows carries an
   * actionable sentence rather than a code and a shrug.
   */
  readonly recovery: LifecycleGuidanceView | null;
  /** True while the developer diagnostics surface is open. */
  readonly diagnosticsVisible: boolean;
}

const DESTINATION_WORDS: Readonly<Record<string, string>> = {
  'on-device': 'on this Mac',
  'remote-service': 'on a remote service',
  unknown: 'somewhere Pilot could not determine',
};

function buildDisclosure(input: ConversationViewInput): VoiceDisclosureView | null {
  const disclosure = input.gate.disclosure;
  if (disclosure === null) {
    return null;
  }
  return {
    headline: disclosure.headline,
    detail: disclosure.detail,
    // `speechDisclosureNeedsAttention` in `@pilot/shared` is the same rule; it
    // is restated as data here so the renderer has one field to switch on.
    needsAttention: disclosure.leavesDevice || !disclosure.allowed,
    leavesDevice: disclosure.leavesDevice,
    destination: DESTINATION_WORDS[disclosure.destination] ?? disclosure.destination,
    service: disclosure.service,
    locale: disclosure.locale,
  };
}

export function buildConversationView(input: ConversationViewInput): ConversationView {
  const presentation = INTERACTION_STATE_PRESENTATION[input.view.state];
  const turns = input.view.transcript.map((entry): ConversationTurnView => ({
    utteranceId: entry.utteranceId,
    role: entry.role,
    speaker: SPEAKER[entry.role],
    text: entry.text,
    at: entry.at,
    status: turnStatus(entry.pending, presentation.busy),
    characters: entry.text.length,
  }));

  const streamingTurn = [...turns]
    .reverse()
    .find((turn) => turn.role === 'assistant' && turn.status !== 'complete');

  return {
    state: input.view.state,
    stateLabel: presentation.label,
    stateDetail: presentation.detail,
    tone: presentation.tone,
    activity: presentation.activity,
    busy: presentation.busy,
    capturing: input.observation.capturing,
    turns,
    liveTranscript: input.view.liveTranscript,
    stream:
      streamingTurn === undefined
        ? null
        : {
            utteranceId: streamingTurn.utteranceId,
            text: streamingTurn.text,
            characters: streamingTurn.characters,
            streaming: streamingTurn.status === 'streaming',
            interrupted: streamingTurn.status === 'interrupted',
          },
    empty: turns.length === 0 && input.view.liveTranscript === null,
    composer: buildComposer(input),
    controls: CONVERSATION_CONTROLS.map((id): ConversationControlView => {
      const reason = controlReason(id, input);
      const label =
        id === 'push-to-talk' && input.gate.pushToTalk !== null
          ? `${CONTROL_LABELS[id]} (${input.gate.pushToTalk.label})`
          : CONTROL_LABELS[id];
      return { id, label, available: reason === null, unavailableReason: reason };
    }),
    disclosure: buildDisclosure(input),
    modelDisclosure: input.gate.modelDisclosure,
    modelStatus: input.gate.modelStatus,
    lastError: input.view.lastError,
    observationFailure: readObservationFailure(input.view.lastError),
    recovery: readLifecycleGuidance(input.view.lastError),
    diagnosticsVisible: input.gate.diagnosticsVisible,
  };
}

/** Looks one control up. Throws rather than returning undefined: the set is fixed. */
export function conversationControl(
  view: ConversationView,
  id: ConversationControlId,
): ConversationControlView {
  const control = view.controls.find((entry) => entry.id === id);
  if (control === undefined) {
    throw new Error(`no conversation control named ${id}`);
  }
  return control;
}
