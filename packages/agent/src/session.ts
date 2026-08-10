import {
  Agent,
  type AgentEvent as PiAgentEvent,
  type AgentMessage,
  type AgentTool,
} from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Model, Models } from '@earendil-works/pi-ai';
import type {
  AgentEvent,
  AgentRunHandle,
  AgentSession,
  AgentSessionCapabilities,
  InterruptMode,
} from '@pilot/platform';
import {
  PilotError,
  asToolCallId,
  createIdFactory,
  type ConversationId,
  type IdFactory,
  toPilotError,
  type ModelProfile,
  type QuestionEnvelope,
  type RunId,
} from '@pilot/shared';
import {
  assertCapabilityDecision,
  verifyProfileAgainstModel,
  type CapabilityConfidence,
  type CapabilityReport,
} from './capability.js';
import { markFailedToolResults, toolFailureError } from './tool-result.js';
import { pruneVisualContext, stripImageBlocks } from './visual-context.js';

/**
 * Pi-backed `AgentSession`.
 *
 * This is the whole point of PR-005: it is the smallest complete binding
 * between the Pilot facade and the *verified* `@earendil-works/pi-agent-core`
 * 0.84.1 surface, with nothing invented.
 *
 * What Pi gives us (all verified by the tests in `test/`):
 *  - `new Agent({ streamFn, initialState: { systemPrompt, model, tools } })`
 *  - `agent.prompt(text | AgentMessage | AgentMessage[])`, one at a time —
 *    a concurrent call rejects with "Agent is already processing a prompt".
 *  - `agent.subscribe((event, signal) => …)` returning an unsubscribe fn.
 *  - `agent.abort()`, `agent.steer(message)`, `agent.followUp(message)`,
 *    `agent.waitForIdle()`.
 *  - `AgentOptions.transformContext` runs before every provider request and
 *    does not mutate the transcript.
 *
 * What Pi does NOT give us, and this class therefore synthesises:
 *  - Run identity. Pi emits `agent_start`/`agent_end` with no run id.
 *  - An abort *event*. Abort shows up only as a final assistant message with
 *    `stopReason: "aborted"`.
 *  - Any persistence. `Agent` never writes to a `Session`; the `AgentHarness`
 *    that would have is a stub in 0.84.1 (`docs/pi-notes.md` §4).
 */

/** Sink for durable, text-only transcript state (system-design §11, §13). */
export interface TranscriptSink {
  /**
   * Persist one message. The implementation is responsible for keeping image
   * bytes off disk; {@link createSanitisingTranscriptSink} does that.
   */
  append(message: AgentMessage): Promise<void>;
}

/**
 * Wraps a sink so every message is made durable-safe first:
 * {@link stripImageBlocks}, then {@link toDurablePayload}.
 *
 * Use this, not a bare sink. Pi's session storage serializes whatever it is
 * handed, so this wrapper is the enforcement point for
 * "raw screenshots are not persisted" (system-design decision 10).
 */
export function createSanitisingTranscriptSink(inner: TranscriptSink): TranscriptSink {
  return {
    async append(message: AgentMessage): Promise<void> {
      await inner.append(toDurablePayload(stripImageBlocks(message)));
    },
  };
}

/**
 * Drops explicit `undefined` properties by round-tripping through JSON.
 *
 * VERIFIED trap: `Session.appendMessage` runs `assertJsonSerializable`, which
 * throws `SessionError("invalid_payload", "Durable payload contains
 * undefined")` on *any* `undefined` value, at any depth. Pi's own
 * `AssistantMessage` objects always carry `deferred`, `errorMessage` and
 * `responseId` as explicit `undefined`, so a message taken straight off
 * `agent.state.messages` cannot be persisted without this step.
 */
export function toDurablePayload(message: AgentMessage): AgentMessage {
  return JSON.parse(JSON.stringify(message)) as AgentMessage;
}

export interface PiAgentSessionOptions {
  readonly conversationId: ConversationId;
  readonly profile: ModelProfile;
  readonly models: Models;
  readonly model: Model<Api>;
  readonly systemPrompt: string;
  readonly tools?: readonly AgentTool<never>[];
  /** Durable state. Omit to run entirely in memory. */
  readonly transcript?: TranscriptSink;
  /** Image blocks kept in the model's active context (system-design §11). */
  readonly keepMostRecentImages?: number;
  readonly idFactory?: IdFactory;
  /** Renders an envelope into the user turn. Defaults to {@link renderQuestionEnvelope}. */
  readonly renderEnvelope?: (envelope: QuestionEnvelope) => string;
  /**
   * Whether `profile.supportsTools` was explicitly configured (`'verified'`)
   * or defaulted (`'assumed'`). Reporting only; it does not change the gate.
   * Carried through from the profile store so diagnostics can say which.
   */
  readonly toolSupport?: CapabilityConfidence;
}

/** Default text rendering of a question envelope (system-design §8). */
export function renderQuestionEnvelope(envelope: QuestionEnvelope): string {
  const { scene, pointer } = envelope;
  const lines = [
    envelope.transcript,
    '',
    '<context>',
    `window: ${scene.windowTitle}`,
    `scene: ${scene.id} revision ${String(scene.revision)}`,
  ];
  if (scene.lastObservedRevision !== undefined) {
    lines.push(`last observed revision: ${String(scene.lastObservedRevision)}`);
  }
  lines.push(
    `pointer: ${pointer.normalizedX.toFixed(3)}, ${pointer.normalizedY.toFixed(3)} (window-relative)`,
  );
  if (pointer.targetRole !== undefined || pointer.targetLabel !== undefined) {
    lines.push(
      `pointer target: ${[pointer.targetRole, pointer.targetLabel].filter(Boolean).join(' — ')}`,
    );
  }
  lines.push('</context>');
  return lines.join('\n');
}

type Listener = (event: AgentEvent) => void;

interface ActiveRun {
  readonly runId: RunId;
  readonly utteranceId: string;
  settled: boolean;
  resolve(): void;
}

function isAssistantMessage(message: AgentMessage | undefined): message is AssistantMessage {
  return message !== undefined && 'role' in message && message.role === 'assistant';
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export class PiAgentSession implements AgentSession {
  readonly conversationId: ConversationId;
  readonly profile: ModelProfile;
  readonly capabilities: AgentSessionCapabilities;
  /**
   * The capability decision that let this session exist, including where each
   * capability came from and whether the endpoint is remote. Superset of
   * {@link capabilities}; diagnostics and the privacy panel read this.
   */
  readonly capabilityReport: CapabilityReport;

  readonly #agent: Agent;
  readonly #listeners = new Set<Listener>();
  readonly #ids: IdFactory;
  readonly #transcript: TranscriptSink | undefined;
  readonly #renderEnvelope: (envelope: QuestionEnvelope) => string;
  readonly #unsubscribePi: () => void;

  #active: ActiveRun | null = null;
  #persistedCount = 0;
  #disposed = false;

  constructor(options: PiAgentSessionOptions) {
    // THE GATE (PR-020). Runs before `new Agent(...)`, before any tool is
    // registered, and therefore before any screen data can be requested or
    // sent. It re-probes `Model.input` rather than trusting the stored
    // profile, because a non-vision model does NOT error on an image — pi-ai
    // silently ignores it, and the user would get a confident answer about a
    // screen the model never saw.
    const report = assertCapabilityDecision(
      verifyProfileAgainstModel(
        options.profile,
        options.model,
        options.toolSupport === undefined ? {} : { toolSupport: options.toolSupport },
      ),
    );
    this.conversationId = options.conversationId;
    this.profile = options.profile;
    this.capabilityReport = report;
    this.capabilities = { vision: report.vision, tools: report.tools };
    this.#ids = options.idFactory ?? createIdFactory();
    this.#transcript = options.transcript;
    this.#renderEnvelope = options.renderEnvelope ?? renderQuestionEnvelope;

    const keepMostRecent = options.keepMostRecentImages ?? 2;
    this.#agent = new Agent({
      streamFn: (model, context, streamOptions) =>
        options.models.streamSimple(model, context, streamOptions),
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        tools: (options.tools ?? []) as AgentTool<never>[],
      },
      // Pi contract: transformContext must not throw. pruneVisualContext is total.
      transformContext: async (messages) => pruneVisualContext(messages, { keepMostRecent }),
      // Pilot tools return typed failure results instead of throwing, so that
      // `details` survives for the UI (see `tool-result.ts`). This hook is what
      // makes Pi agree they failed: it sets `isError` on the tool-result
      // message and on `tool_execution_end`, which becomes `tool-failed` below.
      afterToolCall: async (context) => markFailedToolResults(context),
    });
    this.#unsubscribePi = this.#agent.subscribe((event) => this.#onPiEvent(event));
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Read-only view of the in-memory transcript. Exposed for tests and diagnostics. */
  get messages(): readonly AgentMessage[] {
    return this.#agent.state.messages;
  }

  async submit(envelope: QuestionEnvelope, signal?: AbortSignal): Promise<AgentRunHandle> {
    if (this.#disposed) {
      throw new PilotError('internal', 'Session has been disposed');
    }
    if (signal?.aborted === true) {
      throw new PilotError('cancelled', 'Agent run cancelled before it started');
    }
    if (this.#active !== null) {
      throw new PilotError('run-already-active', 'A run is already active for this conversation', {
        userMessage: 'Pilot is still working on the previous question.',
      });
    }

    const runId = this.#ids.run();
    let resolve: () => void = () => undefined;
    const completed = new Promise<void>((resolveCompleted) => {
      resolve = resolveCompleted;
    });
    const run: ActiveRun = { runId, utteranceId: envelope.utteranceId, settled: false, resolve };
    this.#active = run;

    const onExternalAbort = (): void => {
      this.#agent.abort();
    };
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    this.#emit({ type: 'run-started', runId, utteranceId: envelope.utteranceId });

    void this.#agent
      .prompt(this.#renderEnvelope(envelope))
      .catch((cause: unknown) => {
        this.#settle(run, {
          type: 'run-failed',
          runId,
          error: toPilotError(cause, 'provider-unavailable').toJSON(),
        });
      })
      .finally(() => {
        signal?.removeEventListener('abort', onExternalAbort);
      });

    return { runId, completed };
  }

  async interrupt(mode: InterruptMode, detail: string): Promise<void> {
    if (this.#active === null) {
      return;
    }
    if (mode === 'abort') {
      this.#agent.abort();
      await this.#agent.waitForIdle();
      return;
    }
    // Verified: Agent.steer() takes a whole AgentMessage and injects it at the
    // next queue drain point. `detail` is therefore model-visible text.
    this.#agent.steer({ role: 'user', content: detail, timestamp: Date.now() });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    if (this.#active !== null) {
      this.#agent.abort();
      await this.#agent.waitForIdle();
    }
    this.#unsubscribePi();
    this.#listeners.clear();
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  #settle(run: ActiveRun, event: AgentEvent): void {
    if (run.settled) {
      return;
    }
    run.settled = true;
    if (this.#active === run) {
      this.#active = null;
    }
    this.#emit(event);
    run.resolve();
  }

  #onPiEvent(event: PiAgentEvent): void {
    const run = this.#active;
    if (run === null) {
      return;
    }
    const runId = run.runId;

    switch (event.type) {
      case 'message_update': {
        const inner = event.assistantMessageEvent;
        if (inner.type === 'text_delta') {
          this.#emit({ type: 'text-delta', runId, text: inner.delta });
        }
        return;
      }
      case 'tool_execution_start': {
        this.#emit({
          type: 'tool-started',
          runId,
          toolCallId: asToolCallId(event.toolCallId),
          toolName: event.toolName,
        });
        return;
      }
      case 'tool_execution_update': {
        this.#emit({
          type: 'tool-progress',
          runId,
          toolCallId: asToolCallId(event.toolCallId),
          toolName: event.toolName,
        });
        return;
      }
      case 'tool_execution_end': {
        const toolCallId = asToolCallId(event.toolCallId);
        if (event.isError) {
          // A Pilot tool puts the real `PilotError` on `result.details`, so the
          // UI gets `permission-denied` rather than a generic capture failure.
          // The text fallback covers tools that threw (Pi flattens those).
          const details = (event.result as { details?: unknown } | undefined)?.details;
          this.#emit({
            type: 'tool-failed',
            runId,
            toolCallId,
            toolName: event.toolName,
            error: toolFailureError(details, toolResultText(event.result)).toJSON(),
          });
        } else {
          this.#emit({ type: 'tool-succeeded', runId, toolCallId, toolName: event.toolName });
        }
        return;
      }
      case 'turn_end': {
        void this.#persistNewMessages();
        return;
      }
      case 'agent_end': {
        void this.#persistNewMessages();
        this.#settle(run, this.#terminalEvent(runId));
        return;
      }
      default:
        return;
    }
  }

  #terminalEvent(runId: RunId): AgentEvent {
    const last = this.#agent.state.messages.at(-1);
    if (!isAssistantMessage(last)) {
      return { type: 'run-completed', runId, text: '' };
    }
    if (last.stopReason === 'aborted') {
      return { type: 'run-aborted', runId, reason: last.errorMessage ?? 'aborted' };
    }
    if (last.stopReason === 'error') {
      return {
        type: 'run-failed',
        runId,
        error: new PilotError(
          'provider-unavailable',
          last.errorMessage ?? 'Provider request failed',
        ).toJSON(),
      };
    }
    return { type: 'run-completed', runId, text: assistantText(last) };
  }

  async #persistNewMessages(): Promise<void> {
    const sink = this.#transcript;
    if (sink === undefined) {
      return;
    }
    const messages = this.#agent.state.messages;
    while (this.#persistedCount < messages.length) {
      const message = messages[this.#persistedCount];
      this.#persistedCount += 1;
      if (message !== undefined) {
        await sink.append(message);
      }
    }
  }
}

function toolResultText(result: unknown): string {
  if (typeof result !== 'object' || result === null) {
    return 'Tool failed';
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return 'Tool failed';
  }
  const text = content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join(' ');
  return text.length > 0 ? text : 'Tool failed';
}
