import {
  asUtteranceId,
  createIdFactory,
  createRandomIdSource,
  toPilotError,
  type ConversationId,
  type IdFactory,
  type IdSource,
  type ObservationId,
  type ObservedWindow,
  type PermissionKind,
  type PermissionSnapshot,
  type SpeechId,
  type UtteranceId,
} from '@pilot/shared';
import type {
  AgentSession,
  InteractionCommand,
  InteractionController,
  PilotViewState,
  SpeechInputAdapter,
  SpeechOutputAdapter,
  Unsubscribe,
} from '@pilot/platform';
import type { InteractionContext } from './context.js';
import type { InteractionEffect, InteractionEffectType } from './effects.js';
import type { InteractionInput } from './inputs.js';
import { InteractionMachine, type Clock, type TransitionOutcome } from './machine.js';
import { rejectionError, type InteractionRejection } from './rejection.js';
import type { ObservationControlPort, QuestionEnvelopeFactory } from './ports.js';
import { NULL_SCHEDULER, type CancelScheduled, type Scheduler } from './scheduler.js';
import { DEFAULT_PHRASE_TIMEOUT_MS } from './segmentation.js';
import { SpeechInputBinding } from './speech-binding.js';
import { SpeechOutputBinding } from './speech-output-binding.js';
import type { VoiceDiagnostic } from './voice-diagnostics.js';

/**
 * The `InteractionController` implementation.
 *
 * It is a thin, boring shell around `InteractionMachine`: translate adapter
 * events into machine inputs, perform the effects the machine returns, publish
 * the view state. All of the interesting behaviour — legality, identity,
 * interruption — lives in the pure machine and its table.
 *
 * ## Two effect queues (PR-027)
 *
 * Ordinary effects are performed in order on one promise chain, so a sequence
 * that must "cancel the recogniser, then submit the question" really does happen
 * in that order.
 *
 * Cancellation effects — `stop-speech` and `interrupt-run` — are performed on a
 * *separate* chain that nothing else can block. system-design §15 says starting
 * a new utterance stops TTS immediately and §17 budgets that at under 300 ms,
 * and a single queue cannot honour either: an interruption arriving while a
 * "Look now" observation or a slow envelope build is in flight would wait for
 * that work to finish before the synthesiser was even told to stop. Both chains
 * preserve their own order; the only ordering they give up is between "stop
 * doing things" and "start doing things", which is precisely the ordering an
 * interruption wants inverted.
 *
 * ## Cancellation scopes
 *
 * Stopping the machine's own bookkeeping is not enough — work already in flight
 * on the far side of an adapter has to be told (§15: "`observe_screen` respects
 * the agent's abort signal"). Every question submission and every user-requested
 * observation therefore runs under an `AbortSignal` that this controller aborts
 * the moment the machine stops waiting for it. That closes the window the
 * machine cannot: a question interrupted *while it is being submitted* has no
 * run id yet, so `interrupt()` is a documented no-op, and without the signal the
 * agent would happily start a run nobody wants and hold the "one run per
 * conversation" slot against the next question.
 */

function viewStateEquals(a: PilotViewState, b: PilotViewState): boolean {
  return (
    a.state === b.state &&
    a.conversationId === b.conversationId &&
    a.permissions === b.permissions &&
    a.selectedWindow === b.selectedWindow &&
    a.observationEnabled === b.observationEnabled &&
    a.speaking === b.speaking &&
    a.liveTranscript === b.liveTranscript &&
    a.transcript === b.transcript &&
    a.lastError === b.lastError
  );
}

class Listeners<Event> {
  readonly #listeners = new Set<(event: Event) => void>();

  subscribe = (listener: (event: Event) => void): Unsubscribe => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  emit(event: Event): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}

/** Why in-flight work was cancelled before it could finish (PR-027). */
export type CancellationReason =
  /** An `interrupt-run` effect in `abort` mode reached it. */
  | 'interrupted'
  /** The machine is no longer waiting for this utterance or observation. */
  | 'superseded'
  /** The controller was disposed. */
  | 'disposed';

/**
 * Work this controller cancelled on the far side of an adapter.
 *
 * A cancelled submission or observation is not a failure — it must not reach
 * `lastError` and must not put Pilot in `error` — but it is not nothing either,
 * so it is reported here rather than swallowed (`docs/implementation.md`
 * delivery rules: never silently do nothing). Identifiers and reasons only; no
 * question text, no answer text (system-design §13).
 */
export interface CancellationRecord {
  readonly work: 'question' | 'observation';
  readonly id: UtteranceId | ObservationId;
  readonly reason: CancellationReason;
  /** Injected-clock reading, never a wall clock. */
  readonly at: number;
}

/** Effects that must never wait behind ordinary work. See the class comment. */
const URGENT_EFFECTS: readonly InteractionEffectType[] = ['stop-speech', 'interrupt-run'];

export interface PilotInteractionControllerOptions {
  readonly clock: Clock;
  readonly idSource?: IdSource;
  readonly ids?: IdFactory;
  readonly speechInput: SpeechInputAdapter;
  readonly speechOutput: SpeechOutputAdapter;
  readonly agent: AgentSession;
  readonly envelopes: QuestionEnvelopeFactory;
  readonly observation?: ObservationControlPort;
  readonly permissions?: PermissionSnapshot | null;
  readonly windows?: readonly ObservedWindow[];
  readonly selectedWindow?: ObservedWindow | null;
  readonly requiredPermissions?: readonly PermissionKind[];
  readonly conversationId?: ConversationId;
  /** Refuse to record unless recognition runs on device (system-design §11). */
  readonly requireOnDeviceSpeech?: boolean;
  readonly speechLocale?: string;
  /** PR-026: how long an unterminated fragment waits before it is spoken. */
  readonly phraseTimeoutMs?: number;
  /**
   * PR-027, opt-in: what wakes the phrase timeout up when the model goes quiet.
   *
   * Without one, an unterminated fragment is released when the next run event
   * arrives or when the run ends — PR-026's behaviour exactly, and no tail is
   * ever lost. With one, a run that stalls mid-sentence and emits nothing
   * further speaks what it already had after `phraseTimeoutMs`. Pass
   * `createTimeoutScheduler()` in the app and `ManualScheduler` in a test; the
   * default (`NULL_SCHEDULER`) never fires, which is why every existing test
   * stays deterministic without knowing this exists.
   */
  readonly scheduler?: Scheduler;
  readonly voice?: string;
  readonly speechRate?: number;
}

export class PilotInteractionController implements InteractionController {
  readonly #machine: InteractionMachine;
  readonly #views = new Listeners<PilotViewState>();
  readonly #rejections = new Listeners<InteractionRejection>();
  readonly #diagnostics = new Listeners<VoiceDiagnostic>();
  readonly #cancellations = new Listeners<CancellationRecord>();
  readonly #unsubscribes: Unsubscribe[] = [];

  readonly #speech: SpeechInputBinding;
  readonly #speechOut: SpeechOutputBinding;
  readonly #agent: AgentSession;
  readonly #envelopes: QuestionEnvelopeFactory;
  readonly #observation: ObservationControlPort | undefined;
  readonly #clock: Clock;
  readonly #scheduler: Scheduler;
  readonly #phraseTimeoutMs: number;
  readonly #cancelled: CancellationRecord[] = [];

  #view: PilotViewState;
  #pending: Promise<void> = Promise.resolve();
  /** Cancellation effects only. Never blocked by ordinary work. */
  #urgent: Promise<void> = Promise.resolve();
  /** The question whose submission may still be cancelled. */
  #question: { readonly utteranceId: UtteranceId; readonly abort: AbortController } | null = null;
  /** The user-requested observation that may still be cancelled. */
  #observing: { readonly observationId: ObservationId; readonly abort: AbortController } | null =
    null;
  #armed: { readonly pendingSince: number; readonly cancel: CancelScheduled } | null = null;
  /** Phrase timeouts already delivered, so one tail is never re-armed forever. */
  #firedFor: number | null = null;
  #disposed = false;

  constructor(options: PilotInteractionControllerOptions) {
    const ids = options.ids ?? createIdFactory(options.idSource ?? createRandomIdSource());
    this.#machine = new InteractionMachine({
      clock: options.clock,
      ids,
      ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
      ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
      ...(options.windows === undefined ? {} : { windows: options.windows }),
      ...(options.selectedWindow === undefined ? {} : { selectedWindow: options.selectedWindow }),
      ...(options.requiredPermissions === undefined
        ? {}
        : { requiredPermissions: options.requiredPermissions }),
      ...(options.phraseTimeoutMs === undefined
        ? {}
        : { phraseTimeoutMs: options.phraseTimeoutMs }),
    });
    this.#agent = options.agent;
    this.#envelopes = options.envelopes;
    this.#observation = options.observation;
    this.#clock = options.clock;
    this.#scheduler = options.scheduler ?? NULL_SCHEDULER;
    this.#phraseTimeoutMs = options.phraseTimeoutMs ?? DEFAULT_PHRASE_TIMEOUT_MS;
    this.#view = this.#machine.viewState;

    // PR-025: the speech adapter is reached only through the binding, which
    // owns "exactly one active utterance" at the adapter layer. Events that
    // reach `onEvent` have already been proved to belong to the live utterance;
    // everything else is a diagnostic and never becomes a machine input.
    this.#speech = new SpeechInputBinding({
      speechInput: options.speechInput,
      requireOnDevice: options.requireOnDeviceSpeech ?? true,
      ...(options.speechLocale === undefined ? {} : { locale: options.speechLocale }),
      onDiagnostic: (diagnostic) => {
        this.#diagnostics.emit(diagnostic);
      },
      onEvent: (event) => {
        switch (event.type) {
          case 'partial':
            this.send({
              type: 'transcript-partial',
              utteranceId: event.utteranceId,
              text: event.transcript,
            });
            return;
          case 'final':
            this.send({
              type: 'transcript-final',
              utteranceId: event.utteranceId,
              text: event.transcript,
            });
            return;
          case 'error':
            this.send({
              type: 'transcript-failed',
              utteranceId: event.utteranceId,
              error: toPilotError(event.error, 'speech-input-failed').toJSON(),
            });
            return;
        }
      },
    });

    // PR-026: the symmetric output side. The machine emits `speak` per finished
    // sentence, all under one stream id; the binding owns the queue, the
    // ordering, and the difference between "this chunk finished" and "the
    // answer finished". Events reaching `onEvent` are stream-level and already
    // proved to belong to the live stream.
    this.#speechOut = new SpeechOutputBinding({
      speechOutput: options.speechOutput,
      ...(options.voice === undefined ? {} : { voice: options.voice }),
      ...(options.speechRate === undefined ? {} : { rate: options.speechRate }),
      onDiagnostic: (diagnostic) => {
        this.#diagnostics.emit(diagnostic);
      },
      onEvent: (event) => {
        switch (event.type) {
          case 'started':
            this.send({ type: 'speech-started', speechId: event.speechId });
            return;
          case 'finished':
            this.send({ type: 'speech-finished', speechId: event.speechId });
            return;
          case 'stopped':
            this.send({ type: 'speech-stopped', speechId: event.speechId });
            return;
          case 'error':
            this.send({
              type: 'speech-failed',
              speechId: event.speechId,
              error: toPilotError(event.error, 'speech-output-failed').toJSON(),
            });
            return;
        }
      },
    });

    this.#unsubscribes.push(
      this.#agent.subscribe((event) => {
        switch (event.type) {
          case 'run-started':
            this.send({
              type: 'run-started',
              runId: event.runId,
              utteranceId: asUtteranceId(event.utteranceId),
            });
            return;
          case 'text-delta':
            this.send({ type: 'run-text-delta', runId: event.runId, text: event.text });
            return;
          case 'tool-started':
            this.send({
              type: 'tool-started',
              runId: event.runId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            });
            return;
          case 'tool-succeeded':
            this.send({
              type: 'tool-finished',
              runId: event.runId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            });
            return;
          case 'tool-failed':
            this.send({
              type: 'tool-finished',
              runId: event.runId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              error: event.error,
            });
            return;
          case 'run-completed':
            this.send({ type: 'run-completed', runId: event.runId, text: event.text });
            return;
          case 'run-aborted':
            this.send({ type: 'run-aborted', runId: event.runId, reason: event.reason });
            return;
          case 'run-failed':
            this.send({ type: 'run-failed', runId: event.runId, error: event.error });
            return;
        }
      }),
    );
  }

  // -- InteractionController ------------------------------------------------

  subscribe = this.#views.subscribe;

  /** Rejected transitions, including discarded stale results. */
  subscribeRejections = this.#rejections.subscribe;

  /**
   * Speech-adapter traffic the binding refused to act on: a callback for a dead
   * utterance, a second finalize, a teardown call for something already closed.
   * These never reach the machine, so they are reported here instead.
   */
  subscribeVoiceDiagnostics = this.#diagnostics.subscribe;

  /**
   * In-flight work this controller cancelled: a question that was superseded
   * while it was being submitted, an observation nobody is waiting for any more.
   * Cancellations are deliberately *not* failures, so they appear here and never
   * in `lastError`.
   */
  subscribeCancellations = this.#cancellations.subscribe;

  /** Everything {@link subscribeCancellations} has reported. */
  get cancellations(): readonly CancellationRecord[] {
    return this.#cancelled;
  }

  /** Everything {@link subscribeVoiceDiagnostics} has reported, bounded. */
  get voiceDiagnostics(): readonly VoiceDiagnostic[] {
    return [...this.#speech.diagnostics, ...this.#speechOut.diagnostics];
  }

  /** The utterance the speech adapter is allowed to talk about, if any. */
  get liveUtteranceId(): UtteranceId | null {
    return this.#speech.liveUtteranceId;
  }

  /** The speech stream the synthesiser is allowed to talk about, if any. */
  get liveSpeechId(): SpeechId | null {
    return this.#speechOut.liveSpeechId;
  }

  /** Chunks accepted for the live stream but not yet handed to the synthesiser. */
  get pendingSpeechChunks(): number {
    return this.#speechOut.pendingChunkCount;
  }

  snapshot(): PilotViewState {
    return this.#view;
  }

  /** Full machine context, including the identity fields the view omits. */
  get context(): InteractionContext {
    return this.#machine.context;
  }

  dispatch(command: InteractionCommand): void {
    this.send(command);
  }

  /**
   * The typed form of `dispatch`. Returns what the machine did, so a caller
   * (or a test) can see a rejection instead of guessing from the view state.
   */
  send(input: InteractionInput): TransitionOutcome {
    if (this.#disposed) {
      const from = this.#machine.state;
      const error = rejectionError('disposed', from, input.type);
      return {
        kind: 'rejected',
        from,
        input,
        rejection: { reason: 'disposed', from, input: input.type, at: 0, error },
        context: this.#machine.context,
      };
    }

    const outcome = this.#machine.send(input);
    if (outcome.kind === 'rejected') {
      this.#rejections.emit(outcome.rejection);
    } else {
      this.#dispatch(outcome.effects);
    }
    // Identity moved on, so anything the machine has stopped waiting for is
    // told to stop. Synchronous and unconditional: it must not be possible for
    // a slow adapter call to delay a cancellation.
    this.#reconcileScopes();
    this.#publish();
    this.#armPhraseTimeout();
    return outcome;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const unsubscribe of this.#unsubscribes) {
      unsubscribe();
    }
    this.#unsubscribes.length = 0;
    this.#armed?.cancel();
    this.#armed = null;
    // Everything still in flight is told before anything is awaited: an
    // `observe_screen` or a submission that is mid-call gets its abort now,
    // not after the queue it is blocking has drained.
    this.#cancelQuestion('disposed');
    this.#cancelObservation('disposed');
    await this.#urgent.catch(() => undefined);
    await this.#pending.catch(() => undefined);
    // Releases the microphone if an utterance was still open (system-design
    // §11: pause, lock, logout and shutdown must clear audio buffers).
    await this.#speech.dispose().catch(() => undefined);
    await this.#speechOut.dispose().catch(() => undefined);
    await this.#agent.interrupt('abort', 'controller disposed').catch(() => undefined);
    await this.#observation?.stop().catch(() => undefined);
    await this.#observation?.clear().catch(() => undefined);
    this.#views.clear();
    this.#rejections.clear();
    this.#diagnostics.clear();
    this.#cancellations.clear();
  }

  /**
   * Resolves once every queued effect (and anything they caused) has run,
   * including the speech chunks the output binding hands over on its own chain.
   * It never waits for audio to *finish* playing — that is the synthesiser's
   * business, and blocking on it would make an interruption wait for the
   * sentence it is interrupting.
   */
  async settled(): Promise<void> {
    let previousPending: Promise<void>;
    let previousUrgent: Promise<void>;
    do {
      previousPending = this.#pending;
      previousUrgent = this.#urgent;
      await previousUrgent.catch(() => undefined);
      await previousPending.catch(() => undefined);
      await this.#speechOut.settled();
    } while (previousPending !== this.#pending || previousUrgent !== this.#urgent);
  }

  // -- internals ------------------------------------------------------------

  #publish(): void {
    const next = this.#machine.viewState;
    if (viewStateEquals(this.#view, next)) {
      return;
    }
    this.#view = next;
    this.#views.emit(next);
  }

  /**
   * Split one transition's effects across the two queues.
   *
   * The abort of an in-flight submission happens here, synchronously, rather
   * than when the `interrupt-run` effect is finally performed: aborting a signal
   * costs nothing and waiting to do it is exactly the delay §17 budgets against.
   * A `steer` deliberately does *not* abort — system-design §15 steers instead
   * of aborting precisely so a capture in flight can unwind.
   */
  #dispatch(effects: readonly InteractionEffect[]): void {
    if (effects.length === 0) {
      return;
    }
    const urgent: InteractionEffect[] = [];
    const queued: InteractionEffect[] = [];
    for (const effect of effects) {
      if (effect.type === 'interrupt-run' && effect.mode === 'abort') {
        this.#cancelQuestion('interrupted');
      }
      (URGENT_EFFECTS.includes(effect.type) ? urgent : queued).push(effect);
    }
    let barrier: Promise<void> | null = null;
    if (urgent.length > 0) {
      this.#urgent = this.#urgent.then(async () => {
        for (const effect of urgent) {
          await this.#perform(effect);
        }
      });
      barrier = this.#urgent;
    }
    if (queued.length > 0) {
      this.#pending = this.#pending.then(async () => {
        // The barrier is what keeps "jumps the queue" from becoming "loses its
        // place". This transition's own ordering is intact — the run is stopped
        // before the next question is submitted, which matters because
        // `AgentSession.interrupt()` names no run and would otherwise abort the
        // one that replaced it. What the urgent chain skips is only work queued
        // *before* the interruption.
        if (barrier !== null) {
          await barrier.catch(() => undefined);
        }
        for (const effect of queued) {
          await this.#perform(effect);
        }
      });
    }
  }

  // -- cancellation scopes ---------------------------------------------------

  /** Abort anything the machine has stopped waiting for. */
  #reconcileScopes(): void {
    const context = this.#machine.context;
    if (this.#question !== null && this.#question.utteranceId !== context.activeUtteranceId) {
      this.#cancelQuestion('superseded');
    }
    if (this.#observing !== null && this.#observing.observationId !== context.activeObservationId) {
      this.#cancelObservation('superseded');
    }
  }

  #cancelQuestion(reason: CancellationReason): void {
    const scope = this.#question;
    if (scope === null) {
      return;
    }
    this.#question = null;
    if (!scope.abort.signal.aborted) {
      scope.abort.abort();
      this.#recordCancellation({ work: 'question', id: scope.utteranceId, reason });
    }
  }

  #cancelObservation(reason: CancellationReason): void {
    const scope = this.#observing;
    if (scope === null) {
      return;
    }
    this.#observing = null;
    if (!scope.abort.signal.aborted) {
      scope.abort.abort();
      this.#recordCancellation({ work: 'observation', id: scope.observationId, reason });
    }
  }

  #recordCancellation(record: Omit<CancellationRecord, 'at'>): void {
    const entry: CancellationRecord = { ...record, at: this.#clock.now() };
    this.#cancelled.push(entry);
    this.#cancellations.emit(entry);
  }

  // -- the phrase timeout (opt-in) -------------------------------------------

  /**
   * Arm, re-arm or cancel the wake-up for the fragment currently waiting.
   *
   * `pendingAnswerSince` is both the due time and the identity of that
   * fragment, so re-arming is only needed when it changes, and a fragment that
   * has already been woken once is never re-armed — a scheduler that fires
   * early cannot turn into a loop.
   */
  #armPhraseTimeout(): void {
    const pendingSince = this.#machine.context.pendingAnswerSince;
    if (this.#armed !== null && this.#armed.pendingSince === pendingSince) {
      return;
    }
    this.#armed?.cancel();
    this.#armed = null;
    if (pendingSince === null) {
      this.#firedFor = null;
      return;
    }
    if (this.#firedFor === pendingSince) {
      return;
    }
    const delayMs = Math.max(0, pendingSince + this.#phraseTimeoutMs - this.#clock.now());
    const cancel = this.#scheduler.schedule(delayMs, () => {
      this.#armed = null;
      this.#firedFor = pendingSince;
      this.send({ type: 'phrase-timeout', pendingSince });
    });
    this.#armed = { pendingSince, cancel };
  }

  // -- performing effects ----------------------------------------------------

  /** True while the machine is still waiting for this utterance. */
  #isCurrentUtterance(utteranceId: UtteranceId): boolean {
    return this.#machine.context.activeUtteranceId === utteranceId;
  }

  async #perform(effect: InteractionEffect): Promise<void> {
    try {
      await this.#execute(effect);
    } catch (cause) {
      const error = toPilotError(cause).toJSON();
      this.send({ type: 'failure', error });
    }
  }

  async #execute(effect: InteractionEffect): Promise<void> {
    switch (effect.type) {
      case 'start-capture':
        await this.#observation?.start(effect.window);
        return;
      case 'stop-capture':
        await this.#observation?.stop();
        return;
      case 'clear-buffers':
        await this.#observation?.clear();
        return;
      case 'start-listening':
        // An effect performs work the machine asked for *earlier*; by the time
        // it runs the machine may have moved on. Opening the microphone for an
        // utterance that has already been superseded would immediately have to
        // be cancelled again, so it is skipped instead.
        if (!this.#isCurrentUtterance(effect.utteranceId)) {
          this.#recordCancellation({
            work: 'question',
            id: effect.utteranceId,
            reason: 'superseded',
          });
          return;
        }
        await this.#speech.start(effect.utteranceId);
        return;
      case 'stop-listening':
        await this.#speech.stop(effect.utteranceId);
        return;
      case 'cancel-listening':
        await this.#speech.cancel(effect.utteranceId);
        return;
      case 'submit-question': {
        if (!this.#isCurrentUtterance(effect.utteranceId)) {
          this.#recordCancellation({
            work: 'question',
            id: effect.utteranceId,
            reason: 'superseded',
          });
          return;
        }
        const abort = new AbortController();
        this.#question = { utteranceId: effect.utteranceId, abort };
        try {
          const envelope = await this.#envelopes.create({
            utteranceId: effect.utteranceId,
            conversationId: this.#machine.context.conversationId,
            transcript: effect.text,
            selectedWindow: this.#machine.context.selectedWindow,
            // Stamped by the machine's clock at transition time. Effects run on
            // a promise chain, so reading a clock here would anchor the question
            // to whenever the queue drained instead of to the utterance.
            utteranceStartedAt: effect.utteranceStartedAt,
            askedAt: effect.askedAt,
          });
          if (abort.signal.aborted) {
            return;
          }
          // The signal is what carries the cancellation across the process
          // boundary: `PiAgentSession` wires it to `Agent.abort()`, which is
          // what reaches an `observe_screen` call already in flight (§15).
          await this.#agent.submit(envelope, abort.signal);
        } catch (cause) {
          // Our own cancellation is not a failure. Anything else is.
          if (!abort.signal.aborted) {
            throw cause;
          }
        } finally {
          if (this.#question?.abort === abort) {
            this.#question = null;
          }
        }
        return;
      }
      case 'interrupt-run':
        await this.#agent.interrupt(effect.mode, effect.reason);
        return;
      case 'request-observation': {
        if (this.#machine.context.activeObservationId !== effect.observationId) {
          this.#recordCancellation({
            work: 'observation',
            id: effect.observationId,
            reason: 'superseded',
          });
          return;
        }
        const abort = new AbortController();
        this.#observing = { observationId: effect.observationId, abort };
        try {
          await this.#observation?.observe(effect.observationId, abort.signal);
        } catch (cause) {
          if (!abort.signal.aborted) {
            throw cause;
          }
          return;
        } finally {
          if (this.#observing?.abort === abort) {
            this.#observing = null;
          }
        }
        if (abort.signal.aborted) {
          // The result arrived after Pilot stopped waiting for it. The machine
          // would reject it as `stale-observation`; not sending it keeps a
          // cancelled observation out of the diagnostics as a real event.
          return;
        }
        this.send({ type: 'observation-finished', observationId: effect.observationId });
        return;
      }
      case 'speak':
        await this.#speechOut.speak({
          speechId: effect.speechId,
          utteranceId: effect.utteranceId,
          text: effect.text,
          ...(effect.sequence === undefined ? {} : { sequence: effect.sequence }),
          ...(effect.final === undefined ? {} : { final: effect.final }),
        });
        return;
      case 'stop-speech':
        await this.#speechOut.stop(effect.speechId);
        return;
      case 'clear-conversation':
        // PR-036, runbook follow-up 21. The table has already emptied the
        // *machine's* transcript and minted a fresh conversation id; this is
        // the other half — the model's own context and whatever the session
        // has written to disk.
        //
        // Optional on the facade (system-design §13, added by PR-023) because
        // an `AgentSession` need not be able to forget: a session with nothing
        // durable behind it has nothing to delete, and `FakeAgentSession` does
        // not implement it. `?.()` is therefore the whole of the compatibility
        // story, and a session that *does* implement it — `PiAgentSession` —
        // aborts anything still running, drops the transcript and the
        // compaction summary together, and reclaims the SQLite pages so the
        // text is gone from the file rather than merely unreachable.
        //
        // This runs on the ordinary queue, behind the urgent one, so the
        // `interrupt-run` this transition also emits has already aborted the
        // run by the time it is reached. `clearConversation` aborts again
        // anyway; both are idempotent, and neither may be relied on alone.
        await this.#agent.clearConversation?.();
        return;
    }
  }
}
