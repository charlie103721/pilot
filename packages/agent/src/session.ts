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
import {
  createCompactionController,
  type CompactionController,
  type CompactionOutcome,
  type CompactionPolicy,
  type CompactionState,
  type NowFn,
  type RestoredCompaction,
} from './compaction.js';
import type { ConversationStore, RestoredConversation } from './conversation-store.js';
import { markFailedToolResults, toolFailureError } from './tool-result.js';
import {
  pruneVisualContextByPolicy,
  stripImageBlocks,
  type VisualContextOptions,
} from './visual-context.js';

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
  /**
   * Durable store for this conversation (PR-023).
   *
   * Supplying it is the same as supplying `transcript: store.transcript`, and
   * additionally makes the session persist its compaction snapshot and gives
   * {@link PiAgentSession.clearConversation} something to delete. An explicit
   * `transcript` still wins, so PR-005's in-memory sink keeps working.
   */
  readonly store?: ConversationStore;
  /**
   * Conversation state read back from {@link ConversationStore.restore}.
   *
   * Restores the transcript into `agent.state.messages` and the compaction
   * generation, boundary and summary into the controller — the two halves
   * §11 splits the context into. Restoring only the transcript would make a
   * relaunched session re-send the entire history to the provider.
   */
  readonly restore?: RestoredConversation;
  /**
   * Active-context image limits and replacement records (system-design §10,
   * §11). Defaults to {@link MVP_SCREEN_CONTEXT_POLICY} with no recorded
   * summaries; pass `summaryFor` from a {@link createObservationNotebook} that
   * the `observe_screen` tool writes to, and pruned frames become truthful,
   * scene-stamped records instead of bare apologies.
   */
  readonly visualContext?: VisualContextOptions;
  /**
   * Optional extra cap on the *total* image blocks in active context, applied
   * after the per-purpose limits. Kept from PR-005 for source compatibility; it
   * can only shrink the context further, never widen a per-purpose limit.
   */
  readonly keepMostRecentImages?: number;
  /**
   * Compaction orchestration (system-design §11), on by default.
   *
   * The three §11 triggers are evaluated at every turn boundary and history
   * older than the retained tail is folded into a truthful summary before the
   * next provider request. `enabled: false` turns the whole thing off; the
   * session then behaves exactly as it did in PR-022a.
   */
  readonly compaction?: SessionCompactionOptions;
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

/** Per-session compaction settings (system-design §11). */
export interface SessionCompactionOptions {
  /** Defaults to `true`. */
  readonly enabled?: boolean;
  /** Defaults to `DEFAULT_COMPACTION_POLICY` — §11's numbers verbatim. */
  readonly policy?: CompactionPolicy;
  /**
   * Defaults to `model.contextWindow`. Override to model a smaller budget than
   * the provider advertises, which is what the demo does.
   */
  readonly contextWindow?: number;
  /** Injected clock for the summary message's timestamp. */
  readonly now?: NowFn;
  /**
   * Compaction state to start from. Normally comes from
   * `PiAgentSessionOptions.restore.compaction`; set it directly only when the
   * transcript is being restored by some other route.
   */
  readonly restore?: RestoredCompaction;
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
  readonly #store: ConversationStore | undefined;
  readonly #renderEnvelope: (envelope: QuestionEnvelope) => string;
  readonly #unsubscribePi: () => void;
  readonly #compaction: CompactionController | undefined;
  readonly #visualContext: VisualContextOptions;

  #active: ActiveRun | null = null;
  #persistedCount = 0;
  #disposed = false;
  /**
   * Serialises every durable write.
   *
   * `#persistNewMessages` and the compaction snapshot are both started from
   * Pi's synchronous event handler, and the snapshot's `boundaryIndex` is only
   * meaningful against a transcript that is already on disk. Chaining them
   * through one promise is what makes "summary alongside the transcript" true
   * on disk rather than merely intended.
   */
  #writes: Promise<void> = Promise.resolve();

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
    this.#store = options.store;
    this.#transcript = options.transcript ?? options.store?.transcript;
    this.#renderEnvelope = options.renderEnvelope ?? renderQuestionEnvelope;
    // How much of the *in-memory* transcript is already durable. It is
    // `messages.length`, not `persistedMessageCount`: the two differ only when
    // structural repair withheld an entry that is still on disk, and using the
    // disk count there would skip persisting real messages afterwards.
    // `repairTranscript` is a whole-list, idempotent function, so the withheld
    // entry is dropped again on every later restore wherever it has ended up.
    this.#persistedCount = options.restore?.messages.length ?? 0;

    // One options object, built once: `transformContext` runs before every
    // provider request, and rebuilding this per request would be pure waste.
    const visualContext: VisualContextOptions = {
      ...options.visualContext,
      ...(options.keepMostRecentImages === undefined
        ? {}
        : { maxTotalImages: options.keepMostRecentImages }),
    };
    this.#visualContext = visualContext;
    // Compaction (§11). Evaluated at turn boundaries, applied here. `prune` is
    // handed to the controller so "estimated context usage" measures the
    // request the provider would really receive — post-fold, post-prune —
    // which is also what makes the 60% trigger self-limiting.
    const prune = (messages: readonly AgentMessage[]): AgentMessage[] =>
      pruneVisualContextByPolicy(messages, visualContext);
    // PR-023: the compaction half of a restore. `boundaryIndex` indexes the
    // unmodified transcript, which is exactly what was just restored into
    // `initialState.messages`, so the two halves need no reconciliation.
    const restoredCompaction = options.compaction?.restore ?? options.restore?.compaction;
    this.#compaction =
      options.compaction?.enabled === false
        ? undefined
        : createCompactionController({
            contextWindow: options.compaction?.contextWindow ?? options.model.contextWindow,
            prune,
            ...(restoredCompaction === undefined ? {} : { restore: restoredCompaction }),
            ...(options.compaction?.policy === undefined
              ? {}
              : { policy: options.compaction.policy }),
            ...(options.compaction?.now === undefined ? {} : { now: options.compaction.now }),
            ...(options.visualContext?.policy === undefined
              ? {}
              : { screenPolicy: options.visualContext.policy }),
            ...(options.visualContext?.summaryFor === undefined
              ? {}
              : { summaryFor: options.visualContext.summaryFor }),
          });
    const compaction = this.#compaction;

    this.#agent = new Agent({
      streamFn: (model, context, streamOptions) =>
        options.models.streamSimple(model, context, streamOptions),
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        tools: (options.tools ?? []) as AgentTool<never>[],
        // Restore-on-launch (PR-023). `AgentState.messages` is an accessor
        // that copies the array it is assigned, so the restored list cannot be
        // mutated from underneath us. The messages are the *sanitised* ones —
        // every image block is already a `[image withheld: …]` text block —
        // which is both the privacy guarantee and the right context: §11 calls
        // screenshots replaceable environmental state, and a screenshot from
        // before a restart describes a screen that has certainly moved on.
        ...(options.restore === undefined ? {} : { messages: [...options.restore.messages] }),
      },
      // Pi contract: transformContext must not throw. Both halves are total:
      // `apply` catches and falls back to the untouched list, and
      // `pruneVisualContextByPolicy` is total by construction *and* falls back
      // to the count-based pruner.
      //
      // Order matters. Compaction folds history into a summary first, then
      // pruning enforces the image budget on what is left — so an image inside
      // folded history disappears with the history rather than leaving a
      // replacement record behind for a turn nobody can see any more.
      //
      // Neither step touches `this.#agent.state.messages`: the transcript keeps
      // every original message and every original image block (§11).
      transformContext: async (messages) =>
        prune(compaction === undefined ? messages : compaction.apply(messages)),
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

  /**
   * What compaction has folded so far (system-design §11).
   *
   * `undefined` when compaction is disabled. PR-023 reads this to persist the
   * durable conversation summary alongside the transcript; note that
   * `boundaryIndex` indexes {@link messages}, which compaction never modifies,
   * so the summary and the transcript can be restored independently.
   */
  get compaction(): CompactionState | undefined {
    return this.#compaction?.state;
  }

  /**
   * The most recent compaction decision, including the triggers that fired and
   * the token estimate they fired against.
   *
   * `context-compacted` carries only the summary text, so this is how PR-010's
   * diagnostics panel — and the demo — can say *why* the context was folded, or
   * why it was not.
   */
  get lastCompaction(): CompactionOutcome | undefined {
    return this.#compaction?.lastOutcome;
  }

  /** The provider-facing context as it would be sent right now. Diagnostics only. */
  activeContext(): AgentMessage[] {
    const folded =
      this.#compaction === undefined
        ? [...this.#agent.state.messages]
        : this.#compaction.apply(this.#agent.state.messages);
    return pruneVisualContextByPolicy(folded, this.#visualContext);
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
    const settled = new Promise<void>((resolveCompleted) => {
      resolve = resolveCompleted;
    });
    /**
     * DEFECT FOUND BY PR-022a, fixed here because every multi-observation demo
     * and test trips over it. `agent_end` — the event `#settle` listens to —
     * fires *before* `Agent.prompt()` has finished unwinding, so a caller that
     * did the obvious thing:
     *
     *     await (await session.submit(q1)).completed;
     *     await (await session.submit(q2)).completed;
     *
     * got `run-failed: "Agent is already processing a prompt"` on the second
     * question, and every question after it. The events were right; the promise
     * simply resolved a tick too early. Waiting for Pi's own idle signal makes
     * `completed` mean what its callers assumed it meant. Terminal events are
     * still emitted at `agent_end`, unchanged — only the promise waits.
     */
    const completed = settled
      .then(() => this.#agent.waitForIdle())
      .catch(() => undefined)
      .then(() => undefined);
    const run: ActiveRun = { runId, utteranceId: envelope.utteranceId, settled: false, resolve };
    this.#active = run;

    const onExternalAbort = (): void => {
      this.#agent.abort();
    };
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    this.#emit({ type: 'run-started', runId, utteranceId: envelope.utteranceId });

    // Recorded *before* `prompt()`, because `messages.length` is exactly the
    // index the user message is about to occupy. That index is what lets a
    // compaction summary say which goal belongs to which folded turn without
    // re-parsing the rendered envelope — `renderEnvelope` is pluggable
    // (PR-024 ships a different one), so parsing it back would be a trap.
    this.#compaction?.noteQuestion(envelope, this.#agent.state.messages.length);

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

  /**
   * Clear conversation (system-design §13).
   *
   * Aborts anything in flight, deletes the durable data, and empties the live
   * transcript and the compaction state. Everything is dropped together on
   * purpose: leaving the summary behind would keep quoting a conversation the
   * user asked Pilot to forget, and leaving the in-memory transcript behind
   * would silently re-persist it on the next turn.
   *
   * Safe with no store — an in-memory session simply forgets.
   */
  async clearConversation(): Promise<void> {
    if (this.#active !== null) {
      this.#agent.abort();
      await this.#agent.waitForIdle();
    }
    await this.#writes;
    this.#agent.reset();
    this.#compaction?.reset();
    this.#persistedCount = 0;
    await this.#store?.clear();
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
    // Flush before releasing. `agent_end` starts the last write and does not
    // await it, so a dispose that returned first would lose the final turn of
    // every conversation — the one a restart is most likely to want.
    await this.#writes;
    this.#unsubscribePi();
    this.#listeners.clear();
  }

  /** Resolves when every durable write started so far has landed. */
  async flush(): Promise<void> {
    await this.#writes;
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
        this.#persistNewMessages();
        this.#maybeCompact(runId);
        return;
      }
      case 'agent_end': {
        this.#persistNewMessages();
        // Before settling: a caller that awaits `completed` and immediately
        // reads `activeContext()` must see the compaction this run caused.
        this.#maybeCompact(runId);
        this.#settle(run, this.#terminalEvent(runId));
        return;
      }
      default:
        return;
    }
  }

  /**
   * Runs compaction if any §11 trigger fired (system-design §11).
   *
   * Called at every turn boundary rather than only at the end of a run: one run
   * can contain many turns and many observations, so waiting for `agent_end`
   * would let a long tool-using run blow past the limits it is supposed to
   * respect.
   *
   * Synchronous and total. The summary is extractive, so there is no provider
   * call to await and nothing that can reject; a compaction that failed here
   * would corrupt the next request's context, which is a far worse failure than
   * a slightly large one.
   */
  #maybeCompact(runId: RunId): void {
    const controller = this.#compaction;
    if (controller === undefined) {
      return;
    }
    const outcome = controller.maybeCompact(this.#agent.state.messages);
    if (outcome.kind === 'compacted') {
      // Runbook follow-up 8. The transcript on disk is complete, so without
      // this a restored session would have no summary and would re-send the
      // whole history — undoing at every restart exactly what §11 does at
      // every turn. Enqueued behind the message writes so the boundary index
      // always refers to a transcript that is already durable.
      this.#enqueueWrite(async () => {
        await this.#store?.saveCompaction(controller.state);
      });
      this.#emit({ type: 'context-compacted', runId, summary: outcome.summary.text });
    }
  }

  /**
   * Chains a durable write onto the single writer queue.
   *
   * Failures are swallowed on purpose. Persistence is best-effort state, not
   * the product: a full disk or a lost SQLite writer lease must not take down
   * a run that is answering the user's question. The next successful write
   * catches up, because `#persistedCount` only advances on success.
   */
  #enqueueWrite(write: () => Promise<void>): void {
    this.#writes = this.#writes.then(write).catch(() => undefined);
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

  #persistNewMessages(): void {
    const sink = this.#transcript;
    if (sink === undefined) {
      return;
    }
    // Snapshot the length now: the queue drains later, by which time Pi may
    // have appended more, and those belong to the next enqueued write.
    const messages = [...this.#agent.state.messages];
    this.#enqueueWrite(async () => {
      while (this.#persistedCount < messages.length) {
        const message = messages[this.#persistedCount];
        if (message !== undefined) {
          // Advance only after the write lands, so a failed append is retried
          // by the next turn rather than silently skipped.
          await sink.append(message);
        }
        this.#persistedCount += 1;
      }
    });
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
