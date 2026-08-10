import {
  deserializePilotError,
  nullLogger,
  toPilotError,
  type ConversationId,
  type Logger,
  type ModelProfile,
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
  type CapabilityReport,
  type ModelSource,
  type ObservationNotebook,
} from '@pilot/agent';
import { renderAnchoredQuestionEnvelope } from '@pilot/interaction';

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
 * What is *not* here, on purpose: the `ConversationStore`. PR-023 built it and
 * PR-036 owns wiring it (`openConversationStore` → `restore()` →
 * `new PiAgentSession({ store, restore })` → `store.close()` on quit).
 * `PiAgentSessionOptions.store`/`restore` are additive, so PR-036 adds two
 * options to the object built below and changes nothing else.
 */

export type AgentCapabilityStatus =
  | { readonly ok: true; readonly report: CapabilityReport }
  /** The gate refused. Nothing was sent; `session` refuses every question. */
  | { readonly ok: false; readonly error: SerializedPilotError };

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
  readonly logger?: Logger;
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

  try {
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
      // Follow-up 1.
      renderEnvelope: renderAnchoredQuestionEnvelope,
    });
    logger.info('agent session ready', {
      provider: source.profile.provider,
      model: source.profile.model,
      vision: session.capabilityReport.vision,
      tools: session.capabilityReport.tools,
      remote: session.capabilityReport.endpoint.isRemote,
    });
    return {
      session,
      capability: { ok: true, report: session.capabilityReport },
      notebook,
      screenContext,
      dispose: () => session.dispose(),
    };
  } catch (cause) {
    const error = toPilotError(cause).toJSON();
    // The gate is the only thing that has run, so nothing has been sent. Said
    // out loud because "refused" and "failed after asking" are very different
    // privacy claims (system-design §12).
    logger.warn('capability gate refused the configured model', {
      code: error.code,
      provider: source.profile.provider,
      model: source.profile.model,
      providerRequests: source.requestCount(),
    });
    const session = createRefusedAgentSession(options.conversationId, source.profile, error);
    return {
      session,
      capability: { ok: false, error },
      notebook,
      screenContext,
      dispose: () => session.dispose(),
    };
  }
}
