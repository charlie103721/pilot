import {
  PilotError,
  createCounterIdSource,
  createIdFactory,
  supportsVisualConversation,
  type ConversationId,
  type IdFactory,
  type ModelProfile,
  type QuestionEnvelope,
  type RunId,
} from '@pilot/shared';
import type {
  AgentEvent,
  AgentRunHandle,
  AgentSession,
  AgentSessionFactory,
  InterruptMode,
} from '../agent.js';
import { Emitter, throwIfAborted } from './support.js';
import { FIXTURE_MODEL_PROFILE } from './fixtures.js';

/** One scripted model turn. */
export interface FakeAgentTurn {
  /** Tool calls the model makes before answering. */
  readonly toolCalls?: readonly { readonly name: string; readonly fails?: string }[];
  /** Streamed answer fragments, in order. */
  readonly deltas: readonly string[];
  /** When set, the run fails with this message instead of completing. */
  readonly failWith?: string;
}

export const DEFAULT_AGENT_SCRIPT: readonly FakeAgentTurn[] = [
  {
    toolCalls: [{ name: 'observe_screen' }],
    deltas: ['That is the Auto Renew toggle. ', 'It is currently off.'],
  },
  { deltas: ['Turning it on renews the plan automatically each month.'] },
];

export interface FakeAgentSessionOptions {
  readonly conversationId: ConversationId;
  readonly profile?: ModelProfile;
  readonly script?: readonly FakeAgentTurn[];
  /**
   * `'auto'` (default) plays the whole turn synchronously inside `submit()`.
   * `'manual'` emits only `run-started`; the test drives the rest with
   * `step()`, which is what interruption tests need.
   */
  readonly mode?: 'auto' | 'manual';
  readonly idFactory?: IdFactory;
}

/**
 * Deterministic `AgentSession`.
 *
 * Contains no Pi types and makes no network calls. PROVISIONAL along with the
 * facade it implements: PR-005 will report what the real Pi surface looks like
 * and this fake follows it.
 */
export class FakeAgentSession implements AgentSession {
  readonly conversationId: ConversationId;
  readonly profile: ModelProfile;

  readonly #emitter = new Emitter<AgentEvent>();
  readonly #script: readonly FakeAgentTurn[];
  readonly #mode: 'auto' | 'manual';
  readonly #ids: IdFactory;

  readonly submitted: QuestionEnvelope[] = [];
  readonly interrupts: { mode: InterruptMode; reason: string }[] = [];
  disposed = false;

  #turnCursor = 0;
  #activeRun: { runId: RunId; turn: FakeAgentTurn; resolve: () => void } | null = null;

  constructor(options: FakeAgentSessionOptions) {
    this.conversationId = options.conversationId;
    this.profile = options.profile ?? FIXTURE_MODEL_PROFILE;
    this.#script = options.script ?? DEFAULT_AGENT_SCRIPT;
    this.#mode = options.mode ?? 'auto';
    this.#ids = options.idFactory ?? createIdFactory(createCounterIdSource());
  }

  subscribe = this.#emitter.subscribe;

  async submit(envelope: QuestionEnvelope, signal?: AbortSignal): Promise<AgentRunHandle> {
    throwIfAborted(signal, 'Agent run');
    if (this.disposed) {
      throw new PilotError('internal', 'Session has been disposed');
    }
    if (this.#activeRun !== null) {
      throw new PilotError('run-already-active', 'A run is already active for this conversation', {
        userMessage: 'Pilot is still working on the previous question.',
      });
    }
    if (!supportsVisualConversation(this.profile)) {
      throw new PilotError('unsupported-capability', 'Model lacks vision or tool support', {
        userMessage: 'The selected model cannot look at your screen. Choose another model.',
        details: { profileId: this.profile.id },
      });
    }

    const turn = this.#script[Math.min(this.#turnCursor, this.#script.length - 1)] ?? {
      deltas: [],
    };
    this.#turnCursor += 1;
    this.submitted.push(envelope);

    const runId = this.#ids.run();
    let resolve: () => void = () => undefined;
    const completed = new Promise<void>((resolveCompleted) => {
      resolve = resolveCompleted;
    });
    this.#activeRun = { runId, turn, resolve };
    this.#emitter.emit({ type: 'run-started', runId, utteranceId: envelope.utteranceId });

    if (this.#mode === 'auto') {
      this.step();
    }

    return { runId, completed };
  }

  /**
   * Test control: play the rest of the active turn (tool calls, deltas, and the
   * terminal event). Returns false when no run is active.
   */
  step(): boolean {
    const active = this.#activeRun;
    if (active === null) {
      return false;
    }
    const { runId, turn } = active;

    for (const toolCall of turn.toolCalls ?? []) {
      const toolCallId = this.#ids.toolCall();
      this.#emitter.emit({ type: 'tool-started', runId, toolCallId, toolName: toolCall.name });
      if (toolCall.fails === undefined) {
        this.#emitter.emit({ type: 'tool-succeeded', runId, toolCallId, toolName: toolCall.name });
      } else {
        this.#emitter.emit({
          type: 'tool-failed',
          runId,
          toolCallId,
          toolName: toolCall.name,
          error: new PilotError('capture-failed', toolCall.fails).toJSON(),
        });
      }
    }

    for (const delta of turn.deltas) {
      this.#emitter.emit({ type: 'text-delta', runId, text: delta });
    }

    this.#activeRun = null;
    if (turn.failWith === undefined) {
      this.#emitter.emit({ type: 'run-completed', runId, text: turn.deltas.join('') });
    } else {
      this.#emitter.emit({
        type: 'run-failed',
        runId,
        error: new PilotError('provider-unavailable', turn.failWith).toJSON(),
      });
    }
    active.resolve();
    return true;
  }

  async interrupt(mode: InterruptMode, reason: string): Promise<void> {
    this.interrupts.push({ mode, reason });
    const active = this.#activeRun;
    if (active === null) {
      return;
    }
    this.#activeRun = null;
    this.#emitter.emit({ type: 'run-aborted', runId: active.runId, reason });
    active.resolve();
  }

  async dispose(): Promise<void> {
    await this.interrupt('abort', 'session disposed');
    this.disposed = true;
  }

  get activeRunId(): RunId | null {
    return this.#activeRun?.runId ?? null;
  }
}

export interface FakeAgentSessionFactoryOptions {
  readonly script?: readonly FakeAgentTurn[];
  readonly mode?: 'auto' | 'manual';
}

export class FakeAgentSessionFactory implements AgentSessionFactory {
  readonly sessions: FakeAgentSession[] = [];
  readonly #options: FakeAgentSessionFactoryOptions;

  constructor(options: FakeAgentSessionFactoryOptions = {}) {
    this.#options = options;
  }

  async create(conversationId: ConversationId, profile: ModelProfile): Promise<AgentSession> {
    const session = new FakeAgentSession({
      conversationId,
      profile,
      ...(this.#options.script === undefined ? {} : { script: this.#options.script }),
      ...(this.#options.mode === undefined ? {} : { mode: this.#options.mode }),
    });
    this.sessions.push(session);
    return session;
  }
}
