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
import { DEFAULT_PHRASE_TIMEOUT_MS, takeSpeakablePhrases } from './segmentation.js';

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
  /**
   * How long an unterminated fragment may wait before it is spoken anyway
   * (PR-026). Optional so an existing caller keeps compiling; the machine
   * always supplies it.
   */
  readonly phraseTimeoutMs?: number;
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
    answerText: '',
    pendingAnswer: '',
    pendingAnswerSince: null,
    spokenChunkCount: 0,
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
 * **Always `abort`, including in `observing-screen` — decided by PR-035**
 * (runbook §8 follow-up 14). PR-006 chose `steer` here so that an
 * `observe_screen` call in flight could unwind rather than be cut in half, and
 * PR-027 kept it while recording the consequence. With the real
 * `PiAgentSession` in front of it, that choice is wrong in every direction:
 *
 *  - **A steer does not end the run.** Every teardown that reaches this
 *    function also runs `clearedActivity()`, so the machine forgets the run id
 *    and every event the steered run goes on to produce is rejected as
 *    `stale-run`. The run therefore keeps a provider request open, keeps the
 *    "one run per conversation" slot, and produces output that by construction
 *    nobody can ever see.
 *  - **The replacement question then cannot start.** `submit-question` is
 *    emitted in the same transition as the interruption, and it meets a run
 *    that is still going: `run-already-active`, surfaced as "Pilot is still
 *    working on the previous question". Pilot recovered (the failure teardown
 *    aborted the steered run) but did not do what the user asked.
 *  - **The capture lands afterwards.** `steer` leaves the tool's `AbortSignal`
 *    unfired, so the in-flight capture completes and its image is appended to
 *    the model's context for a question the user has already replaced. That is
 *    the opposite of unwinding.
 *  - **`abort` is what unwinds it.** PR-021's tool checks the signal before the
 *    call, passes it to `ScreenContextService.observe` and discards a result
 *    that arrives after it; PR-019's `captureWithAbort` races the platform
 *    capture against the same signal and drops a late frame on the floor; and
 *    `PiAgentSession.interrupt('abort')` awaits Pi's own idle signal, so by the
 *    time the replacement question is submitted there is no active run.
 *
 * The state parameter is kept — the signature is part of the package's public
 * surface, and a future PR that finds a case where steering is genuinely right
 * has exactly one place to add it.
 */
export function interruptModeFor(_state: InteractionState): InterruptMode {
  return 'abort';
}

/**
 * What a steered run would be told (PR-027).
 *
 * **No longer emitted by this table** (PR-035; see {@link interruptModeFor}).
 * It is kept, and kept exported, because `'steer'` is still part of the
 * `AgentSession` contract and this constant records the thing that is easy to
 * get wrong about it:
 *
 * `AgentSession.interrupt(mode, detail)` reads `detail` differently per mode,
 * and the difference matters: for `'abort'` it is an internal reason string
 * that never reaches the model, but for `'steer'` it is **a whole user message
 * injected into the transcript verbatim** (`packages/platform/src/agent.ts`,
 * verified against Pi 0.84.1). An internal string like "paused" or "superseded
 * by a new question" would therefore be spoken to the model as if the user had
 * said it. Anything that steers must carry a message written for the model, and
 * leave the internal reason where it belongs — in the outcome, the rejection
 * stream and the diagnostics.
 */
export const STEER_INTERRUPTION_MESSAGE =
  'Stop what you are doing and wait. The user interrupted this request; do not ' +
  'answer the previous question.';

/** Stop speech, discard in-flight audio, and stop the run — in that order. */
function teardown(context: InteractionContext, reason: string): InteractionEffect[] {
  const effects: InteractionEffect[] = [];
  if (isSpeechPending(context)) {
    // First, always: system-design §15 "starting a new utterance stops TTS
    // immediately", and §17 budgets that at under 300 ms. `PilotInteractionController`
    // performs this effect off the main effect queue for the same reason.
    effects.push({ type: 'stop-speech', speechId: context.activeSpeechId });
  }
  if (isCapturingAudio(context) && context.activeUtteranceId !== null) {
    effects.push({ type: 'cancel-listening', utteranceId: context.activeUtteranceId });
  }
  if (isRunPending(context)) {
    const mode = interruptModeFor(context.state);
    effects.push({
      type: 'interrupt-run',
      runId: context.activeRunId,
      mode,
      reason: mode === 'steer' ? STEER_INTERRUPTION_MESSAGE : reason,
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

// ---------------------------------------------------------------------------
// Response and TTS buffer (PR-026)
// ---------------------------------------------------------------------------

interface SpeechFlush {
  readonly effects: readonly InteractionEffect[];
  readonly patch: Partial<InteractionContext>;
}

function phraseTimeoutOf(env: TransitionEnv): number {
  return env.phraseTimeoutMs ?? DEFAULT_PHRASE_TIMEOUT_MS;
}

/**
 * Accumulate streamed answer text and hand every completed sentence to TTS
 * (system-design §7: "Completed sentence fragments enter TTS").
 *
 * Two buffers, deliberately: `answerText` is everything the run has said and is
 * what the panel renders, while `pendingAnswer` is only the fragment still
 * waiting for a terminator. They diverge the moment a sentence is spoken, and
 * conflating them would either re-speak the whole answer or lose the transcript.
 *
 * The chunks all carry the run's single `speechId`, minted here on the first
 * speakable sentence. That is what makes the machine's own `activeSpeechId`
 * guard cover mid-run speech: a `speech-started` for any other stream is stale
 * before it reaches the table, and PR-006's `thinking + speech-started ->
 * speaking` cell does the rest.
 *
 * Called with `addedText: ''` from the events that do not carry text, so a
 * fragment stranded behind a slow tool call is still released once its phrase
 * timeout has elapsed.
 */
function streamPhrases(
  context: InteractionContext,
  addedText: string,
  env: TransitionEnv,
): SpeechFlush {
  const utteranceId = context.activeUtteranceId;
  const answerText = context.answerText + addedText;
  const flush = takeSpeakablePhrases(context.pendingAnswer + addedText, {
    now: env.now,
    pendingSince: context.pendingAnswerSince,
    phraseTimeoutMs: phraseTimeoutOf(env),
  });

  const patch: Partial<InteractionContext> = {
    answerText,
    pendingAnswer: flush.remainder,
    pendingAnswerSince: flush.pendingSince,
    // Only when the answer actually grew: a timeout flush changes what is
    // spoken, not what the panel shows, and rebuilding the array would publish
    // a view update with nothing new in it.
    ...(utteranceId === null || addedText === ''
      ? {}
      : {
          transcript: withAssistantText(context.transcript, utteranceId, answerText, env.now, true),
        }),
  };

  if (utteranceId === null || flush.phrases.length === 0) {
    return { effects: [], patch };
  }

  const speechId = context.activeSpeechId ?? env.ids.speech();
  return {
    effects: flush.phrases.map((phrase, index) => ({
      type: 'speak',
      speechId,
      utteranceId,
      text: phrase,
      sequence: context.spokenChunkCount + index,
      final: false,
    })),
    patch: {
      ...patch,
      activeSpeechId: speechId,
      spokenChunkCount: context.spokenChunkCount + flush.phrases.length,
    },
  };
}

/**
 * `run-completed`: release the tail, close the speech stream, or fall back to
 * resting when the model had nothing to say.
 *
 * The tail matters. A stream that ends mid-sentence — no full stop, no newline
 * — must not silently drop what it had already produced, so the remaining
 * fragment is spoken here whatever it looks like. This is the guarantee the
 * phrase timeout is *for*; the elapsed-time rule in `streamPhrases` only makes
 * it happen sooner.
 */
function completeRun(
  context: InteractionContext,
  text: string,
  env: TransitionEnv,
): TransitionApplication {
  const utteranceId = context.activeUtteranceId;
  const answer = text === '' ? context.answerText : text;
  const transcript =
    utteranceId === null
      ? context.transcript
      : withAssistantText(context.transcript, utteranceId, answer, env.now, false);
  const streamOpen = context.activeSpeechId !== null;

  if (utteranceId === null || (!streamOpen && answer.trim() === '')) {
    return {
      to: 'resting',
      patch: { ...clearedActivity(), transcript },
    };
  }

  // Whatever has not been spoken yet. While a stream is open that is the
  // fragment still waiting for a terminator; with no stream open it is the
  // whole answer, because a provider that does not stream reports its text
  // only here.
  const flush = takeSpeakablePhrases(streamOpen ? context.pendingAnswer : answer, {
    now: env.now,
    pendingSince: context.pendingAnswerSince,
    phraseTimeoutMs: phraseTimeoutOf(env),
    final: true,
  });
  const speechId = context.activeSpeechId ?? env.ids.speech();
  const effects: InteractionEffect[] = flush.phrases.map((phrase, index) => ({
    type: 'speak',
    speechId,
    utteranceId,
    text: phrase,
    sequence: context.spokenChunkCount + index,
    final: index === flush.phrases.length - 1,
  }));
  if (effects.length === 0) {
    // Everything was already handed over. The stream still has to be closed,
    // or the binding would wait forever for a chunk that is never coming.
    effects.push({
      type: 'speak',
      speechId,
      utteranceId,
      text: '',
      sequence: context.spokenChunkCount,
      final: true,
    });
  }

  return {
    to: streamOpen ? 'same' : 'speaking',
    effects,
    patch: {
      transcript,
      answerText: answer,
      activeRunId: null,
      activeSpeechId: speechId,
      pendingAnswer: '',
      pendingAnswerSince: null,
      spokenChunkCount: context.spokenChunkCount + flush.phrases.length,
    },
  };
}

/**
 * A speech stream ended (drained, or stopped by the platform).
 *
 * `resting` only when the run is over too: with mid-run speech the answer can
 * finish speaking while the model is still working, and ending the turn there
 * would strand the rest of the response.
 */
function endSpeech(context: InteractionContext): TransitionApplication {
  if (context.activeRunId !== null || context.state === 'observing-screen') {
    return { to: 'same', patch: { activeSpeechId: null } };
  }
  return { to: 'resting', patch: clearedActivity() };
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
      { to: ['same'], note: 'accumulate the answer and speak completed sentences (PR-026)' },
      (context, input, env) => {
        if (input.type !== 'run-text-delta') {
          return undefined;
        }
        const flush = streamPhrases(context, input.text, env);
        return { to: 'same', effects: flush.effects, patch: flush.patch };
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

/**
 * Speech-output events, wherever a speech stream can be live (PR-026).
 *
 * PR-006 only had to answer these in `speaking`, because speech began when the
 * run ended. Once completed sentences enter TTS mid-run (system-design §7), a
 * stream is live in `thinking` and across a tool call as well — the model can
 * say "Let me look at your screen" *and then* call `observe_screen`. These
 * cells are what keeps that from becoming an `illegal-transition` and a
 * user-visible error. Every one of them is still guarded by `activeSpeechId`,
 * so an event for any other stream never reaches them.
 */
function speechEventRow(): TransitionRow {
  return {
    'speech-started': accept(
      { to: ['speaking', 'same'], note: 'mvp-01 §7: the first speakable sentence' },
      (context) => (context.state === 'thinking' ? { to: 'speaking' } : { to: 'same' }),
    ),
    'speech-finished': accept(
      { to: ['resting', 'same'], note: 'the whole stream drained, not one chunk' },
      (context) => endSpeech(context),
    ),
    'speech-stopped': accept({ to: ['resting', 'same'] }, (context) => endSpeech(context)),
    'speech-failed': accept({ to: ['error'] }, (context, input) =>
      input.type === 'speech-failed'
        ? {
            to: 'error',
            effects: teardown(context, 'speech failed'),
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
  /**
   * PR-027, runbook §8 follow-up 6: the waiting fragment has waited long enough.
   *
   * PR-026 evaluates the phrase timeout whenever a run event arrives and
   * unconditionally when the run ends, so no tail is ever *lost*; what it cannot
   * do is release a tail from a run that has gone quiet without ending, because
   * nothing arrives to evaluate it. This input is that missing wake-up, and it
   * is the same flush — `streamPhrases` with no new text, exactly as
   * `tool-started` and `tool-finished` already do — so a timed release and a
   * release triggered by the next delta produce identical effects.
   *
   * Global, because the identity guard has already decided whether it applies:
   * a tail can only be pending while a run is streaming, and `clearedActivity()`
   * drops `pendingAnswerSince` on every teardown. In every other state the guard
   * rejects it as `stale-phrase-timeout` before the table is consulted.
   */
  'phrase-timeout': accept(
    { to: ['same'], note: 'release a fragment the model left hanging' },
    (context, _input, env) => {
      const flush = streamPhrases(context, '', env);
      return { to: 'same', effects: flush.effects, patch: flush.patch };
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
    ...speechEventRow(),
    'tool-started': accept(
      { to: ['observing-screen'], note: 'mvp-01 §7: screen tool starts' },
      (context, _input, env) => {
        // A sentence stranded behind the tool call is released before the wait
        // begins, rather than after it (system-design §17, time to first spoken
        // sentence).
        const flush = streamPhrases(context, '', env);
        return { to: 'observing-screen', effects: flush.effects, patch: flush.patch };
      },
    ),
  },

  'observing-screen': {
    ...runEventRow(),
    ...speechEventRow(),
    'tool-finished': accept(
      { to: ['thinking'], note: 'mvp-01 §7: tool result returned' },
      (context, input, env) => {
        if (input.type !== 'tool-finished') {
          return undefined;
        }
        const flush = streamPhrases(context, '', env);
        return {
          to: 'thinking',
          effects: flush.effects,
          patch: {
            ...flush.patch,
            ...(input.error === undefined ? {} : { lastError: input.error }),
          },
        };
      },
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
    ...speechEventRow(),
    'tool-started': accept({ to: ['observing-screen'] }, (context, _input, env) => {
      const flush = streamPhrases(context, '', env);
      return { to: 'observing-screen', effects: flush.effects, patch: flush.patch };
    }),
  },

  error: {
    'push-to-talk-down': deny('illegal-transition'),
    'push-to-talk-up': deny('illegal-transition'),
    // `submit-text` is deliberately *not* denied here (PR-025). system-design
    // §16: when STT fails, Pilot "offers text input" — and a failed recogniser
    // is exactly what leaves the machine in `error`. Falling through to the
    // global rule makes typing the documented way out: the question is
    // submitted through the same path a spoken one takes, and the patch clears
    // `lastError`, so the error is dismissed by being answered.
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
