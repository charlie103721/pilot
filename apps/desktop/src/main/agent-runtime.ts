import {
  deserializePilotError,
  nullLogger,
  toPilotError,
  type ConversationId,
  type Logger,
  type ModelProfile,
  // PR-039 (additive import).
  type PilotError,
  type QuestionEnvelope,
  type SerializedPilotError,
} from '@pilot/shared';
import type {
  AgentEvent,
  AgentRunHandle,
  AgentSession,
  InterruptMode,
  ScreenContextService,
} from '@pilot/platform';
import { FakeScreenContextService } from '@pilot/platform/fakes';
import {
  PiAgentSession,
  asSessionTool,
  buildSystemPrompt,
  createObservationNotebook,
  createObserveScreenTool,
  containsImageBytes,
  type CapabilityReport,
  type CompactionOutcome,
  type ConversationStore,
  type ModelSource,
  type ObservationNotebook,
  type RestoredConversation,
} from '@pilot/agent';
import { renderAnchoredQuestionEnvelope } from '@pilot/interaction';
import type { TelemetryMetric } from '../ipc/schemas.js';
import {
  contextWindowInputOf,
  describeContextWindow,
  parseContextWindowOverride,
  resolveContextWindow,
  type ContextWindowDecision,
} from './context-window.js';

/**
 * The real agent session, assembled (PR-029).
 *
 * This is the one fake boundary PR-029 replaces: `FakeAgentSession` goes, and a
 * real `PiAgentSession` — real Pi `Agent`, real capability gate, real streaming
 * — takes its place.
 *
 * PR-030 finished the other half: {@link AgentRuntimeOptions.screenContext} is
 * supplied by the composition root and is PR-019's real
 * `PilotScreenContextService`, so `observe_screen` looks at the window the user
 * selected instead of at a fixture. Nothing else on this side changed — the
 * tool, the notebook, the envelope renderer and the gate are PR-021's and
 * PR-029's, untouched.
 *
 * Three wirings here are not decoration. Each one is a recorded cross-lane
 * follow-up (`docs/runbook.md` §8) that is silently wrong if it is skipped:
 *
 *  1. **`renderEnvelope: renderAnchoredQuestionEnvelope`** (follow-up 1).
 *     `@pilot/agent`'s own `renderQuestionEnvelope` predates PR-024's anchor and
 *     prints the raw pointer pair, so an *unknown* pointer reaches the model as
 *     `pointer: -1.000, -1.000` — a coordinate it would reasonably treat as
 *     real. The anchored renderer says "pointer: unknown — no pointer position
 *     was recorded for this question" instead. With observation still mocked
 *     that is the ordinary case here, not a corner one.
 *  2. **The observation notebook, passed twice** (follow-up 4). Once as
 *     `createObserveScreenTool({ onObservation: notebook.note })` so each
 *     observation is written down, and once as
 *     `visualContext.summaryFor` so the pruner can read it back. Wire neither
 *     and every replacement record degrades to "No description of that frame was
 *     recorded." — truthful and useless.
 *  3. **The capability gate runs in the constructor** (PR-020), before any tool
 *     is registered and before Pi's `Agent` exists. A refusal here therefore
 *     happens with zero provider requests made, which
 *     {@link AgentRuntime.capability} reports and the tests assert against
 *     `ModelSource.requestCount()`.
 *
 * PR-036 wired the last two, and they are the two this file's own comment used
 * to say were missing:
 *
 *  4. **`store` and `restore`** (follow-up 20). `main/conversation-store.ts`
 *     opens the durable conversation and reads it back; the two values arrive
 *     here as {@link AgentRuntimeOptions.store} and
 *     {@link AgentRuntimeOptions.restore} and are handed to `PiAgentSession`
 *     together. Passing `store` without `restore` is the failure that follow-up
 *     20 (b) describes — the history is on disk and invisible to the model —
 *     so, like the notebook above, they are written on adjacent lines.
 *  5. **`compaction.contextWindow`** (follow-ups 7 and 9). Not
 *     `model.contextWindow`: see `main/context-window.ts` for why a local
 *     endpoint's advertised window is not a budget Pilot can trust.
 *
 * Telemetry (follow-up 9's other half) is attached separately, through
 * {@link AgentRuntime.attachTelemetry}, for the same reason the observation
 * runtime's is: `ConversationGate` owns the ring and cannot exist until the
 * controller does, and the controller needs this session.
 */

export type AgentCapabilityStatus =
  | { readonly ok: true; readonly report: CapabilityReport }
  /** The gate refused. Nothing was sent; `session` refuses every question. */
  | { readonly ok: false; readonly error: SerializedPilotError };

/**
 * What the agent reports to the diagnostics ring (PR-036).
 *
 * `count` and nothing else, deliberately. The two metrics this runtime records
 * are token *estimates*; the `context-compacted` event beside them carries the
 * summary **text**, which is conversation content, and system-design §17 does
 * not permit recording it. A sink with no method that accepts a string is how
 * that is enforced rather than remembered — the same shape
 * `ObservationTelemetrySink` uses for the same reason.
 */
export interface AgentTelemetrySink {
  count(metric: TelemetryMetric, value: number): void;
}

/**
 * How big the conversation is, in counts (PR-036).
 *
 * Three numbers and nothing else, for the same reason {@link AgentTelemetrySink}
 * has one method: this is the shape in which the *size* of a conversation can
 * leave the session without any of its content coming with it. The diagnostics
 * surface and the memory walkthrough both read it; neither can read a word of
 * the transcript through it.
 *
 * It also keeps Pi's `AgentMessage` out of `apps/desktop`, which nothing here
 * imports and nothing here should.
 */
export interface AgentContextSummary {
  /** Messages in the durable, unmodified transcript (system-design §11). */
  readonly transcriptMessages: number;
  /** Messages the next provider request would carry: folded, then pruned. */
  readonly contextMessages: number;
  /** Of those, how many still carry raw image bytes. §10 bounds this. */
  readonly contextImages: number;
}

export interface AgentRuntime {
  readonly session: AgentSession;
  readonly capability: AgentCapabilityStatus;
  /** Wired into both halves of the visual-context contract. See above. */
  readonly notebook: ObservationNotebook;
  /**
   * What `observe_screen` reaches. `main/index.ts` passes PR-019's real
   * `PilotScreenContextService` (PR-030); it falls back to
   * `FakeScreenContextService` only for a caller that supplies nothing, which
   * is the scripted desktop suites.
   */
  readonly screenContext: ScreenContextService;
  /** The §11 budget in force, and which rule produced it (PR-036). */
  readonly contextWindow: ContextWindowDecision;
  /**
   * The most recent compaction decision, or `undefined` when nothing has
   * compacted yet — `null` when this runtime holds a refused session, which has
   * no compaction controller at all.
   */
  lastCompaction(): CompactionOutcome | undefined;
  /** Counts only. `null` for a refused session, which has no context at all. */
  contextSummary(): AgentContextSummary | null;
  /** Attaches the diagnostics ring. See {@link AgentTelemetrySink}. */
  attachTelemetry(sink: AgentTelemetrySink): void;
  dispose(): Promise<void>;
}

export interface AgentRuntimeOptions {
  readonly conversationId: ConversationId;
  readonly source: ModelSource;
  /**
   * The real service in the app (PR-030: `observation.screenContext`).
   * Defaults to `FakeScreenContextService` for callers that have no
   * observation runtime to hand.
   */
  readonly screenContext?: ScreenContextService;
  /**
   * The durable conversation (PR-036, follow-up 20). Omit to run entirely in
   * memory, which is what every scripted desktop suite does and what the app
   * itself falls back to when the store cannot be opened.
   */
  readonly store?: ConversationStore;
  /**
   * What `ConversationStore.restore()` read back. Supply it whenever `store` is
   * supplied: without it the transcript stays on disk and the model never sees
   * it (follow-up 20 (b)).
   */
  readonly restore?: RestoredConversation;
  /**
   * Overrides the §11 context budget. Defaults to
   * {@link resolveContextWindow} over the profile, which is the whole of
   * follow-ups 7 and 9; the demo passes a small window so twelve turns really
   * do trip the usage trigger.
   */
  readonly contextWindow?: number;
  /** Reads `PILOT_CONTEXT_WINDOW`. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly logger?: Logger;
  /**
   * A provider that is configured but cannot be used (ADDED BY PR-039).
   *
   * Optional and additive, which is the shape runbook cross-lane issue 8 says
   * survives a three-way merge. It exists because a local endpoint can fail in
   * ways a capability check cannot express — nothing listening, no model
   * loaded, an HTTP server that is not an API — and a session built anyway
   * would look like a working model until the first question. Supplying it
   * takes exactly the same path as a capability refusal: a refusing session
   * whose every answer is this error's `userMessage`.
   */
  readonly blockedBy?: PilotError;
}

/**
 * An `AgentSession` that refuses every question with the reason it was refused.
 *
 * Used when the capability gate rejects the configured profile. The alternative
 * — leaving the app with no agent at all — would make an unsupported model look
 * like a broken Pilot, and system-design §16 requires the user always be told
 * what happened and what to do about it. `PilotInteractionController` turns the
 * thrown error into the machine's `error` state, so the refusal reaches the
 * panel with its `userMessage` and its remedy intact.
 */
export function createRefusedAgentSession(
  conversationId: ConversationId,
  profile: ModelProfile,
  error: SerializedPilotError,
): AgentSession {
  const listeners = new Set<(event: AgentEvent) => void>();
  return {
    conversationId,
    profile,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async submit(_envelope: QuestionEnvelope): Promise<AgentRunHandle> {
      // Rebuilt from the serialized form rather than wrapped: `toPilotError` on
      // a plain object produces `internal`, which would hide the refusal behind
      // a generic failure and lose the remedy the user needs.
      throw deserializePilotError(error);
    },
    async interrupt(_mode: InterruptMode, _detail: string): Promise<void> {
      // Nothing can be in flight: no run was ever started.
    },
    async dispose(): Promise<void> {
      listeners.clear();
    },
  };
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const logger = options.logger ?? nullLogger;
  const { source } = options;
  const notebook = createObservationNotebook();
  const screenContext: ScreenContextService =
    options.screenContext ?? new FakeScreenContextService();

  // Follow-ups 7 and 9. Resolved before the session exists, so the number the
  // triggers are measured against is chosen in one place and logged there too.
  const env = options.env ?? process.env;
  const contextWindow = resolveContextWindow(contextWindowInputOf(source), {
    override: options.contextWindow ?? parseContextWindowOverride(env['PILOT_CONTEXT_WINDOW']),
  });

  let telemetry: AgentTelemetrySink | undefined;

  try {
    // PR-039. Thrown rather than branched so a provider that is configured and
    // unusable takes the identical refusal path a capability refusal takes —
    // one refusing session, one place that builds it, one place to change.
    if (options.blockedBy !== undefined) {
      throw options.blockedBy;
    }
    const session = new PiAgentSession({
      conversationId: options.conversationId,
      profile: source.profile,
      models: source.models,
      model: source.model,
      toolSupport: source.toolSupport,
      systemPrompt: buildSystemPrompt(),
      // Follow-up 4, first half.
      tools: [
        asSessionTool(createObserveScreenTool({ screenContext, onObservation: notebook.note })),
      ],
      // Follow-up 4, second half. Passing one without the other is the failure
      // mode the follow-up exists to prevent, so they are written together.
      visualContext: { summaryFor: notebook.summaryFor },
      // Follow-up 20, and the same rule applies: `store` without `restore` is a
      // conversation the model cannot see, so they are written together.
      ...(options.store === undefined ? {} : { store: options.store }),
      ...(options.restore === undefined ? {} : { restore: options.restore }),
      // Follow-ups 7 and 9.
      compaction: { contextWindow: contextWindow.contextWindow },
      // Follow-up 1.
      renderEnvelope: renderAnchoredQuestionEnvelope,
    });
    // Follow-up 9's other half. `context-compacted` says *that* the context was
    // folded and carries the summary text; `lastCompaction` says how much was
    // folded, as two numbers. Only the numbers are recorded — the event's
    // `summary` is deliberately not read here (system-design §17).
    session.subscribe((event) => {
      if (event.type !== 'context-compacted' || telemetry === undefined) {
        return;
      }
      const outcome = session.lastCompaction;
      if (outcome?.kind !== 'compacted') {
        return;
      }
      telemetry.count('context-tokens-before', outcome.tokensBefore);
      telemetry.count('context-tokens-after', outcome.tokensAfter);
    });
    logger.info('agent session ready', {
      provider: source.profile.provider,
      model: source.profile.model,
      vision: session.capabilityReport.vision,
      tools: session.capabilityReport.tools,
      remote: session.capabilityReport.endpoint.isRemote,
      contextWindow: describeContextWindow(contextWindow),
      // Never the transcript, never the summary: how much of each there is.
      // `restored`, not `restoredMessages`: `@pilot/shared` redacts any key
      // matching /messages/ as content, which would hide the count.
      restored: options.restore?.messages.length ?? 0,
      restoredSummary: options.restore?.compaction !== undefined,
      durable: options.store !== undefined,
    });
    return {
      session,
      capability: { ok: true, report: session.capabilityReport },
      notebook,
      screenContext,
      contextWindow,
      lastCompaction: () => session.lastCompaction,
      contextSummary: () => {
        const context = session.activeContext();
        return {
          transcriptMessages: session.messages.length,
          contextMessages: context.length,
          contextImages: context.filter(containsImageBytes).length,
        };
      },
      attachTelemetry: (sink: AgentTelemetrySink) => {
        telemetry = sink;
      },
      dispose: () => session.dispose(),
    };
  } catch (cause) {
    const error = toPilotError(cause).toJSON();
    // The gate is the only thing that has run, so nothing has been sent. Said
    // out loud because "refused" and "failed after asking" are very different
    // privacy claims (system-design §12).
    logger.warn(
      options.blockedBy === undefined
        ? 'capability gate refused the configured model'
        : 'the configured provider is unusable; the session will refuse every question',
      {
        code: error.code,
        provider: source.profile.provider,
        model: source.profile.model,
        providerRequests: source.requestCount(),
      },
    );
    const session = createRefusedAgentSession(options.conversationId, source.profile, error);
    return {
      session,
      capability: { ok: false, error },
      notebook,
      screenContext,
      contextWindow,
      // A refused session has no Pi `Agent` and therefore no compaction
      // controller. `undefined` is the same answer "nothing has compacted yet"
      // gives, which is correct here too: nothing ever will.
      lastCompaction: () => undefined,
      contextSummary: () => null,
      attachTelemetry: () => undefined,
      dispose: () => session.dispose(),
    };
  }
}
