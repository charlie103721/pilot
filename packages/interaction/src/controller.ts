import {
  asUtteranceId,
  createIdFactory,
  createRandomIdSource,
  toPilotError,
  type ConversationId,
  type IdFactory,
  type IdSource,
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
import type { InteractionEffect } from './effects.js';
import type { InteractionInput } from './inputs.js';
import { InteractionMachine, type Clock, type TransitionOutcome } from './machine.js';
import { rejectionError, type InteractionRejection } from './rejection.js';
import type { ObservationControlPort, QuestionEnvelopeFactory } from './ports.js';
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
 * Effects are performed in order on a single promise chain, so an interruption
 * that must "stop speech, then abort the run, then start listening" really does
 * happen in that order.
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
  readonly voice?: string;
  readonly speechRate?: number;
}

export class PilotInteractionController implements InteractionController {
  readonly #machine: InteractionMachine;
  readonly #views = new Listeners<PilotViewState>();
  readonly #rejections = new Listeners<InteractionRejection>();
  readonly #diagnostics = new Listeners<VoiceDiagnostic>();
  readonly #unsubscribes: Unsubscribe[] = [];

  readonly #speech: SpeechInputBinding;
  readonly #speechOut: SpeechOutputBinding;
  readonly #agent: AgentSession;
  readonly #envelopes: QuestionEnvelopeFactory;
  readonly #observation: ObservationControlPort | undefined;

  #view: PilotViewState;
  #pending: Promise<void> = Promise.resolve();
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
    } else if (outcome.effects.length > 0) {
      this.#enqueue(outcome.effects);
    }
    this.#publish();
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
  }

  /**
   * Resolves once every queued effect (and anything they caused) has run,
   * including the speech chunks the output binding hands over on its own chain.
   * It never waits for audio to *finish* playing — that is the synthesiser's
   * business, and blocking on it would make an interruption wait for the
   * sentence it is interrupting.
   */
  async settled(): Promise<void> {
    let previous: Promise<void>;
    do {
      previous = this.#pending;
      await previous.catch(() => undefined);
      await this.#speechOut.settled();
    } while (previous !== this.#pending);
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

  #enqueue(effects: readonly InteractionEffect[]): void {
    this.#pending = this.#pending.then(async () => {
      for (const effect of effects) {
        await this.#perform(effect);
      }
    });
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
        await this.#speech.start(effect.utteranceId);
        return;
      case 'stop-listening':
        await this.#speech.stop(effect.utteranceId);
        return;
      case 'cancel-listening':
        await this.#speech.cancel(effect.utteranceId);
        return;
      case 'submit-question': {
        const envelope = await this.#envelopes.create({
          utteranceId: effect.utteranceId,
          conversationId: this.#machine.context.conversationId,
          transcript: effect.text,
          selectedWindow: this.#machine.context.selectedWindow,
          // Stamped by the machine's clock at transition time. Effects run on a
          // promise chain, so reading a clock here would anchor the question to
          // whenever the queue drained instead of to the utterance.
          utteranceStartedAt: effect.utteranceStartedAt,
          askedAt: effect.askedAt,
        });
        await this.#agent.submit(envelope);
        return;
      }
      case 'interrupt-run':
        await this.#agent.interrupt(effect.mode, effect.reason);
        return;
      case 'request-observation':
        await this.#observation?.observe(effect.observationId);
        this.send({ type: 'observation-finished', observationId: effect.observationId });
        return;
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
        // Text persistence and session recycling belong to PR-023/PR-036.
        return;
    }
  }
}
