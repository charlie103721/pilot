import {
  INTERACTION_STATES,
  PilotError,
  type IdFactory,
  type InteractionState,
  type PermissionKind,
} from '@pilot/shared';
import type { InterruptMode } from '@pilot/platform';
import type { InteractionEffect } from './effects.js';
import {
  INTERACTION_INPUT_TYPES,
  type InteractionInput,
  type InteractionInputType,
} from './inputs.js';
import type { TransitionRejectionReason } from './rejection.js';
import {
  REQUIRED_PERMISSIONS,
  isActiveState,
  permissionsSatisfied,
  restingState,
  withAssistantText,
  withUserText,
  type InteractionContext,
} from './context.js';

/**
 * The transition table (mvp-01 §7, system-design §7 and §15).
 *
 * The table is data. `resolveTransition()` answers *every* (state, input) pair:
 * either an `AcceptRule` or an explicit `RejectRule`. There is no "not in the
 * table, so ignore it" path — an unlisted cell resolves to a typed
 * `illegal-transition` rejection.
 *
 * Rows are looked up in this order:
 *
 *   1. `TRANSITIONS[state][input]` — state-specific behaviour;
 *   2. `GLOBAL_TRANSITIONS[input]` — behaviour that is the same everywhere
 *      (pause, failure, permission changes, interruption by a new question);
 *   3. an implicit `illegal-transition` rejection.
 *
 * A rule declares the target states it may produce (`to`) and the reasons it
 * may still reject (`mayReject`), so the generated matrix in
 * `test/table.test.ts` reads as documentation and can be checked against what
 * `apply()` actually returns.
 */

/** `'resting'` = `restingState(context)`. `'same'` = stay where you are. */
export type TransitionTarget = InteractionState | 'resting' | 'same';

export interface TransitionEnv {
  readonly ids: IdFactory;
  readonly now: number;
  readonly required: readonly PermissionKind[];
}

export type TransitionApplication =
  | {
      readonly to: TransitionTarget;
      readonly effects?: readonly InteractionEffect[];
      readonly patch?: Partial<InteractionContext>;
    }
  | { readonly reject: TransitionRejectionReason };

export interface AcceptRule {
  readonly kind: 'accept';
  /** Every target `apply()` is allowed to return. */
  readonly to: readonly TransitionTarget[];
  /** Every reason `apply()` is allowed to reject with. */
  readonly mayReject: readonly TransitionRejectionReason[];
  readonly note?: string;
  apply(
    context: InteractionContext,
    input: InteractionInput,
    env: TransitionEnv,
  ): TransitionApplication | undefined;
}

export interface RejectRule {
  readonly kind: 'reject';
  readonly reason: TransitionRejectionReason;
}

export type TransitionRule = AcceptRule | RejectRule;
export type TransitionRow = Partial<Record<InteractionInputType, TransitionRule>>;

// ---------------------------------------------------------------------------
// Rule builders
// ---------------------------------------------------------------------------

interface AcceptOptions {
  readonly to: readonly TransitionTarget[];
  readonly mayReject?: readonly TransitionRejectionReason[];
  readonly note?: string;
}

function accept(options: AcceptOptions, apply: AcceptRule['apply']): AcceptRule {
  return {
    kind: 'accept',
    to: options.to,
    mayReject: options.mayReject ?? [],
    ...(options.note === undefined ? {} : { note: options.note }),
    apply,
  };
}

function deny(reason: TransitionRejectionReason): RejectRule {
  return { kind: 'reject', reason };
}

function denyAll(
  reason: TransitionRejectionReason,
  types: readonly InteractionInputType[],
): TransitionRow {
  const row: Record<string, TransitionRule> = {};
  for (const type of types) {
    row[type] = deny(reason);
  }
  return row as TransitionRow;
}

// ---------------------------------------------------------------------------
// Shared effect / patch helpers
// ---------------------------------------------------------------------------

/** Identity fields that must not survive an interruption or a teardown. */
function clearedActivity(): Partial<InteractionContext> {
  return {
    activeUtteranceId: null,
    activeRunId: null,
    activeSpeechId: null,
    activeObservationId: null,
    liveTranscript: null,
    pendingAnswer: '',
  };
}

function isRunPending(context: InteractionContext): boolean {
  return (
    context.activeRunId !== null ||
    context.state === 'thinking' ||
    context.state === 'observing-screen' ||
    context.state === 'speaking'
  );
}

function isSpeechPending(context: InteractionContext): boolean {
  return context.activeSpeechId !== null || context.state === 'speaking';
}

function isCapturingAudio(context: InteractionContext): boolean {
  return (
    context.activeUtteranceId !== null &&
    (context.state === 'listening' || context.state === 'transcribing')
  );
}

/**
 * How the active run is stopped (system-design §15: "aborts the current agent
 * request or submits a steering message according to state").
 *
 * While a screen observation is in flight the run is *steered* so the tool call
 * unwinds cleanly instead of being cancelled halfway through a capture;
 * everywhere else the run is aborted outright. Either way the machine forgets
 * the run id, so late events from it are rejected as `stale-run`.
 */
export function interruptModeFor(state: InteractionState): InterruptMode {
  return state === 'observing-screen' ? 'steer' : 'abort';
}

/** Stop speech, discard in-flight audio, and stop the run — in that order. */
function teardown(context: InteractionContext, reason: string): InteractionEffect[] {
  const effects: InteractionEffect[] = [];
  if (isSpeechPending(context)) {
    effects.push({ type: 'stop-speech', speechId: context.activeSpeechId });
  }
  if (isCapturingAudio(context) && context.activeUtteranceId !== null) {
    effects.push({ type: 'cancel-listening', utteranceId: context.activeUtteranceId });
  }
  if (isRunPending(context)) {
    effects.push({
      type: 'interrupt-run',
      runId: context.activeRunId,
      mode: interruptModeFor(context.state),
      reason,
    });
  }
  return effects;
}

function captureEffects(
  context: InteractionContext,
  patch: Partial<InteractionContext>,
  env: TransitionEnv,
): InteractionEffect[] {
  const next = { ...context, ...patch };
  if (restingState(next, env.required) === 'observing' && next.selectedWindow !== null) {
    return [{ type: 'start-capture', window: next.selectedWindow }];
  }
  return [{ type: 'stop-capture' }, { type: 'clear-buffers' }];
}

function beginListening(context: InteractionContext, env: TransitionEnv): TransitionApplication {
  const utteranceId = env.ids.utterance();
  const effects = isActiveState(context.state)
    ? teardown(context, 'superseded by a new question')
    : [];
  return {
    to: 'listening',
    effects: [...effects, { type: 'start-listening', utteranceId }],
    patch: {
      ...clearedActivity(),
      activeUtteranceId: utteranceId,
      // Push-to-talk down (system-design §6). The end is stamped when the
      // transcript is accepted; PR-024 anchors the question on it.
      utteranceStartedAt: env.now,
      utteranceEndedAt: null,
      liveTranscript: '',
      lastError: null,
    },
  };
}

function beginQuestion(
  context: InteractionContext,
  utteranceId: ReturnType<IdFactory['utterance']>,
  text: string,
  env: TransitionEnv,
  extraEffects: readonly InteractionEffect[] = [],
): TransitionApplication {
  // A typed question has no listening phase, and a question that supersedes a
  // previous one must not inherit the previous utterance's interval: the window
  // PR-024 queries the pointer timeline with has to belong to *this* utterance.
  const spoken = context.activeUtteranceId === utteranceId;
  const startedAt = spoken ? (context.utteranceStartedAt ?? env.now) : env.now;
  // Push-to-talk up when there was one; otherwise now — a transcript that
  // finalises before the key is released ends the utterance where it lands.
  const askedAt = spoken ? (context.utteranceEndedAt ?? env.now) : env.now;
  return {
    to: 'thinking',
    effects: [
      ...extraEffects,
      { type: 'submit-question', utteranceId, text, utteranceStartedAt: startedAt, askedAt },
    ],
    patch: {
      ...clearedActivity(),
      activeUtteranceId: utteranceId,
      finalizedUtteranceId: utteranceId,
      utteranceStartedAt: startedAt,
      utteranceEndedAt: askedAt,
      transcript: withUserText(context.transcript, utteranceId, text, env.now),
      lastError: null,
    },
  };
}

/** `run-completed`: speak the answer, or fall back to resting when silent. */
function completeRun(
  context: InteractionContext,
  text: string,
  env: TransitionEnv,
): TransitionApplication {
  const utteranceId = context.activeUtteranceId;
  const answer = text === '' ? context.pendingAnswer : text;
  const transcript =
    utteranceId === null
      ? context.transcript
      : withAssistantText(context.transcript, utteranceId, answer, env.now, false);

  if (utteranceId === null || answer.trim() === '') {
    return {
      to: 'resting',
      patch: { ...clearedActivity(), transcript },
    };
  }
  if (context.state === 'speaking') {
    // PR-026 already handed the sentences to TTS; nothing more to say.
    return { to: 'same', patch: { transcript, activeRunId: null, pendingAnswer: '' } };
  }
  const speechId = env.ids.speech();
  return {
    to: 'speaking',
    effects: [{ type: 'speak', speechId, utteranceId, text: answer }],
    patch: { transcript, activeRunId: null, activeSpeechId: speechId, pendingAnswer: '' },
  };
}

// ---------------------------------------------------------------------------
// Reusable event sub-rows
// ---------------------------------------------------------------------------

/** Agent-run events that mean the same thing wherever a run is active. */
function runEventRow(): TransitionRow {
  return {
    'run-started': accept({ to: ['same'], note: 'record the run id' }, (_context, input) =>
      input.type === 'run-started'
        ? { to: 'same', patch: { activeRunId: input.runId } }
        : undefined,
    ),
    'run-text-delta': accept(
      { to: ['same'], note: 'accumulate the streamed answer' },
      (context, input, env) => {
        if (input.type !== 'run-text-delta') {
          return undefined;
        }
        const pendingAnswer = context.pendingAnswer + input.text;
        const utteranceId = context.activeUtteranceId;
        return {
          to: 'same',
          patch: {
            pendingAnswer,
            ...(utteranceId === null
              ? {}
              : {
                  transcript: withAssistantText(
                    context.transcript,
                    utteranceId,
                    pendingAnswer,
                    env.now,
                    true,
                  ),
                }),
          },
        };
      },
    ),
    'run-completed': accept(
      { to: ['speaking', 'resting', 'same'], note: 'speak the answer' },
      (context, input, env) =>
        input.type === 'run-completed' ? completeRun(context, input.text, env) : undefined,
    ),
    'run-aborted': accept({ to: ['resting'] }, (context) => ({
      to: 'resting',
      effects: isSpeechPending(context)
        ? [{ type: 'stop-speech', speechId: context.activeSpeechId }]
        : [],
      patch: clearedActivity(),
    })),
    'run-failed': accept({ to: ['error'] }, (context, input) =>
      input.type === 'run-failed'
        ? {
            to: 'error',
            effects: teardown(context, 'run failed'),
            patch: { ...clearedActivity(), lastError: input.error },
          }
        : undefined,
    ),
  };
}

// ---------------------------------------------------------------------------
// Global row
// ---------------------------------------------------------------------------

export const GLOBAL_TRANSITIONS: TransitionRow = {
  // -- platform -------------------------------------------------------------
  'permissions-changed': accept(
    { to: ['resting', 'same'], note: 'revocation tears everything down' },
    (context, input, env) => {
      if (input.type !== 'permissions-changed') {
        return undefined;
      }
      const patch: Partial<InteractionContext> = { permissions: input.permissions };
      if (!permissionsSatisfied(input.permissions, env.required)) {
        return {
          to: 'resting',
          effects: [
            ...teardown(context, 'permission revoked'),
            { type: 'stop-capture' },
            { type: 'clear-buffers' },
          ],
          patch: { ...patch, ...clearedActivity(), observationEnabled: false },
        };
      }
      if (context.state === 'needs-permission') {
        return { to: 'resting', effects: captureEffects(context, patch, env), patch };
      }
      return { to: 'same', patch };
    },
  ),
  'windows-changed': accept({ to: ['same'] }, (context, input) => {
    if (input.type !== 'windows-changed') {
      return undefined;
    }
    const selected =
      context.selectedWindow === null
        ? null
        : (input.windows.find((w) => w.windowId === context.selectedWindow?.windowId) ??
          context.selectedWindow);
    return { to: 'same', patch: { knownWindows: input.windows, selectedWindow: selected } };
  }),
  'window-closed': accept(
    { to: ['error'], note: 'the selected window disappeared (mvp-01 §7 recoverable failure)' },
    (context, input) =>
      input.type === 'window-closed'
        ? {
            to: 'error',
            effects: [
              ...teardown(context, 'selected window closed'),
              { type: 'stop-capture' },
              { type: 'clear-buffers' },
            ],
            patch: {
              ...clearedActivity(),
              selectedWindow: null,
              observationEnabled: false,
              lastError: new PilotError('window-closed', 'The selected window closed', {
                userMessage: 'The window Pilot was watching closed. Choose another window.',
                details: { windowId: input.windowId },
              }).toJSON(),
            },
          }
        : undefined,
  ),
  'screen-locked': accept({ to: ['resting'], mayReject: ['illegal-transition'] }, (context) =>
    context.screenLocked
      ? { reject: 'illegal-transition' }
      : {
          to: 'resting',
          effects: [
            ...teardown(context, 'screen locked'),
            { type: 'stop-capture' },
            { type: 'clear-buffers' },
          ],
          patch: { ...clearedActivity(), screenLocked: true },
        },
  ),
  'screen-unlocked': accept(
    { to: ['resting'], mayReject: ['illegal-transition'] },
    (context, _input, env) => {
      if (!context.screenLocked) {
        return { reject: 'illegal-transition' };
      }
      const patch: Partial<InteractionContext> = { screenLocked: false };
      return { to: 'resting', effects: captureEffects(context, patch, env), patch };
    },
  ),
  failure: accept({ to: ['error'] }, (context, input) =>
    input.type === 'failure'
      ? {
          to: 'error',
          effects: teardown(context, 'recoverable failure'),
          patch: { ...clearedActivity(), lastError: input.error },
        }
      : undefined,
  ),

  // -- commands that behave the same everywhere ------------------------------
  pause: accept(
    { to: ['resting'], mayReject: ['already-paused'], note: 'stops capture, TTS and the run' },
    (context) =>
      context.paused
        ? { reject: 'already-paused' }
        : {
            to: 'resting',
            effects: [
              ...teardown(context, 'paused'),
              { type: 'stop-capture' },
              { type: 'clear-buffers' },
            ],
            patch: { ...clearedActivity(), paused: true },
          },
  ),
  resume: accept({ to: ['resting'], mayReject: ['not-paused'] }, (context, _input, env) => {
    if (!context.paused) {
      return { reject: 'not-paused' };
    }
    const patch: Partial<InteractionContext> = { paused: false };
    return { to: 'resting', effects: captureEffects(context, patch, env), patch };
  }),
  'clear-conversation': accept({ to: ['resting'] }, (context, _input, env) => ({
    to: 'resting',
    effects: [...teardown(context, 'conversation cleared'), { type: 'clear-conversation' }],
    patch: {
      ...clearedActivity(),
      conversationId: env.ids.conversation(),
      finalizedUtteranceId: null,
      transcript: [],
      lastError: null,
    },
  })),
  'dismiss-error': accept(
    { to: ['resting', 'same'], mayReject: ['nothing-to-dismiss'] },
    (context, _input, env) => {
      if (context.state === 'error') {
        const patch: Partial<InteractionContext> = { lastError: null };
        return { to: 'resting', effects: captureEffects(context, patch, env), patch };
      }
      if (context.lastError === null) {
        return { reject: 'nothing-to-dismiss' };
      }
      return { to: 'same', patch: { lastError: null } };
    },
  ),
  'select-window': accept(
    { to: ['resting'], mayReject: ['window-not-found', 'illegal-transition'] },
    (context, input, env) => {
      if (input.type !== 'select-window') {
        return undefined;
      }
      if (isActiveState(context.state)) {
        return { reject: 'illegal-transition' };
      }
      const window = context.knownWindows.find((w) => w.windowId === input.windowId);
      if (window === undefined) {
        return { reject: 'window-not-found' };
      }
      const patch: Partial<InteractionContext> = {
        selectedWindow: window,
        observationEnabled: true,
        lastError: null,
      };
      return {
        to: 'resting',
        effects: [
          { type: 'stop-capture' },
          { type: 'clear-buffers' },
          ...captureEffects(context, patch, env),
        ],
        patch,
      };
    },
  ),
  'set-observation-enabled': accept(
    { to: ['resting'], mayReject: ['illegal-transition'] },
    (context, input, env) => {
      if (input.type !== 'set-observation-enabled') {
        return undefined;
      }
      if (isActiveState(context.state)) {
        return { reject: 'illegal-transition' };
      }
      const patch: Partial<InteractionContext> = {
        observationEnabled: input.enabled,
        lastError: null,
      };
      return { to: 'resting', effects: captureEffects(context, patch, env), patch };
    },
  ),
  'push-to-talk-down': accept(
    {
      to: ['listening'],
      mayReject: ['illegal-transition'],
      note: 'a new push-to-talk always supersedes whatever is running',
    },
    (context, _input, env) =>
      context.state === 'listening'
        ? { reject: 'illegal-transition' }
        : beginListening(context, env),
  ),
  'push-to-talk-up': accept(
    { to: ['transcribing'], mayReject: ['illegal-transition'] },
    (context, _input, env) =>
      context.state === 'listening' && context.activeUtteranceId !== null
        ? {
            to: 'transcribing',
            effects: [{ type: 'stop-listening', utteranceId: context.activeUtteranceId }],
            // Push-to-talk up is the end of the utterance (system-design §6),
            // and therefore the instant PR-024 anchors the pointer on. The
            // transcript lands later — recognition takes time, and by then the
            // user has usually moved the pointer somewhere else.
            patch: { utteranceEndedAt: env.now },
          }
        : { reject: 'illegal-transition' },
  ),
  'submit-text': accept(
    { to: ['thinking'], mayReject: ['empty-input'], note: 'the in-panel fallback to voice' },
    (context, input, env) => {
      if (input.type !== 'submit-text') {
        return undefined;
      }
      const text = input.text.trim();
      if (text === '') {
        return { reject: 'empty-input' };
      }
      const extra = isActiveState(context.state)
        ? teardown(context, 'superseded by a typed question')
        : [];
      return beginQuestion(context, env.ids.utterance(), text, env, extra);
    },
  ),
  'look-now': accept(
    { to: ['observing-screen'], mayReject: ['illegal-transition'], note: 'runbook §5 amendment 1' },
    (context, _input, env) => {
      if (context.state !== 'observing') {
        return { reject: 'illegal-transition' };
      }
      const observationId = env.ids.observation();
      return {
        to: 'observing-screen',
        effects: [{ type: 'request-observation', observationId, reason: 'manual' }],
        patch: { activeObservationId: observationId },
      };
    },
  ),
  interrupt: accept({ to: ['resting'], mayReject: ['nothing-to-interrupt'] }, (context) =>
    isActiveState(context.state)
      ? {
          to: 'resting',
          effects: teardown(context, 'interrupted by the user'),
          patch: clearedActivity(),
        }
      : { reject: 'nothing-to-interrupt' },
  ),
  'stop-speaking': accept({ to: ['resting'], mayReject: ['nothing-to-interrupt'] }, (context) =>
    isSpeechPending(context)
      ? {
          to: 'resting',
          effects: teardown(context, 'speech stopped by the user'),
          patch: clearedActivity(),
        }
      : { reject: 'nothing-to-interrupt' },
  ),
};

// ---------------------------------------------------------------------------
// Per-state rows
// ---------------------------------------------------------------------------

const BLOCKED_COMMANDS: readonly InteractionInputType[] = [
  'select-window',
  'set-observation-enabled',
  'push-to-talk-down',
  'push-to-talk-up',
  'submit-text',
  'look-now',
  'interrupt',
  'stop-speaking',
];

export const TRANSITIONS: Readonly<Record<InteractionState, TransitionRow>> = {
  idle: {},

  'needs-permission': {
    ...denyAll('not-permitted', BLOCKED_COMMANDS),
  },

  paused: {
    ...denyAll('paused', BLOCKED_COMMANDS),
  },

  observing: {},

  listening: {
    'transcript-partial': accept({ to: ['same'] }, (_context, input) =>
      input.type === 'transcript-partial'
        ? { to: 'same', patch: { liveTranscript: input.text } }
        : undefined,
    ),
    'transcript-final': accept(
      { to: ['thinking'], note: 'STT may finalise before push-to-talk is released' },
      (context, input, env) =>
        input.type === 'transcript-final' && context.activeUtteranceId !== null
          ? beginQuestion(context, context.activeUtteranceId, input.text, env, [
              { type: 'stop-listening', utteranceId: context.activeUtteranceId },
            ])
          : undefined,
    ),
    'transcript-failed': accept({ to: ['error'] }, (context, input) =>
      input.type === 'transcript-failed'
        ? {
            to: 'error',
            effects:
              context.activeUtteranceId === null
                ? []
                : [{ type: 'cancel-listening', utteranceId: context.activeUtteranceId }],
            patch: { ...clearedActivity(), lastError: input.error },
          }
        : undefined,
    ),
  },

  transcribing: {
    'transcript-partial': accept({ to: ['same'] }, (_context, input) =>
      input.type === 'transcript-partial'
        ? { to: 'same', patch: { liveTranscript: input.text } }
        : undefined,
    ),
    'transcript-final': accept(
      { to: ['thinking'], note: 'mvp-01 §7: transcript accepted' },
      (context, input, env) =>
        input.type === 'transcript-final' && context.activeUtteranceId !== null
          ? beginQuestion(context, context.activeUtteranceId, input.text, env)
          : undefined,
    ),
    'transcript-failed': accept({ to: ['error'] }, (_context, input) =>
      input.type === 'transcript-failed'
        ? {
            to: 'error',
            effects: [],
            patch: { ...clearedActivity(), lastError: input.error },
          }
        : undefined,
    ),
  },

  thinking: {
    ...runEventRow(),
    'tool-started': accept(
      { to: ['observing-screen'], note: 'mvp-01 §7: screen tool starts' },
      () => ({ to: 'observing-screen' }),
    ),
    'speech-started': accept(
      { to: ['speaking'], note: 'mvp-01 §7: first speakable sentence (PR-026)' },
      () => ({ to: 'speaking' }),
    ),
  },

  'observing-screen': {
    ...runEventRow(),
    'tool-finished': accept(
      { to: ['thinking'], note: 'mvp-01 §7: tool result returned' },
      (_context, input) =>
        input.type === 'tool-finished'
          ? {
              to: 'thinking',
              ...(input.error === undefined ? {} : { patch: { lastError: input.error } }),
            }
          : undefined,
    ),
    'observation-finished': accept(
      { to: ['thinking', 'resting'], note: 'completion of a "Look now" observation' },
      (context, input) =>
        input.type === 'observation-finished'
          ? {
              to: context.activeRunId === null ? 'resting' : 'thinking',
              patch: {
                activeObservationId: null,
                ...(input.error === undefined ? {} : { lastError: input.error }),
              },
            }
          : undefined,
    ),
  },

  speaking: {
    ...runEventRow(),
    'tool-started': accept({ to: ['observing-screen'] }, () => ({ to: 'observing-screen' })),
    'speech-started': accept({ to: ['same'] }, () => ({ to: 'same' })),
    'speech-finished': accept({ to: ['resting'] }, () => ({
      to: 'resting',
      patch: clearedActivity(),
    })),
    'speech-stopped': accept({ to: ['resting'] }, () => ({
      to: 'resting',
      patch: clearedActivity(),
    })),
    'speech-failed': accept({ to: ['error'] }, (context, input) =>
      input.type === 'speech-failed'
        ? {
            to: 'error',
            effects: teardown(context, 'speech failed'),
            patch: { ...clearedActivity(), lastError: input.error },
          }
        : undefined,
    ),
  },

  error: {
    'push-to-talk-down': deny('illegal-transition'),
    'push-to-talk-up': deny('illegal-transition'),
    'submit-text': deny('illegal-transition'),
    'look-now': deny('illegal-transition'),
    interrupt: deny('nothing-to-interrupt'),
    'stop-speaking': deny('nothing-to-interrupt'),
  },
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export function lookupRule(state: InteractionState, input: InteractionInputType): TransitionRule {
  return (
    TRANSITIONS[state][input] ??
    GLOBAL_TRANSITIONS[input] ?? { kind: 'reject', reason: 'illegal-transition' }
  );
}

export function resolveTarget(
  target: TransitionTarget,
  context: InteractionContext,
  required: readonly PermissionKind[] = REQUIRED_PERMISSIONS,
): InteractionState {
  if (target === 'same') {
    return context.state;
  }
  if (target === 'resting') {
    return restingState(context, required);
  }
  return target;
}

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------

export interface TransitionCell {
  readonly from: InteractionState;
  readonly input: InteractionInputType;
  readonly rule: TransitionRule;
}

/** Every (state, input) pair. Used by the totality test. */
export function allTransitionCells(): readonly TransitionCell[] {
  return INTERACTION_STATES.flatMap((from) =>
    INTERACTION_INPUT_TYPES.map((input) => ({ from, input, rule: lookupRule(from, input) })),
  );
}

/**
 * Renders the declared table as one line per cell, sorted, so a test can pin it
 * with an inline snapshot and reviewers can read the machine without reading
 * the code.
 */
export function describeTransitionTable(): readonly string[] {
  return allTransitionCells().map(({ from, input, rule }) => {
    if (rule.kind === 'reject') {
      return `${from} + ${input} -> reject(${rule.reason})`;
    }
    const targets = rule.to.join('|');
    const rejects = rule.mayReject.length === 0 ? '' : ` | reject(${rule.mayReject.join(',')})`;
    return `${from} + ${input} -> ${targets}${rejects}`;
  });
}
