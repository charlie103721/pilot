import {
  nullLogger,
  type ConversationId,
  type Logger,
  type ObservationId,
  type ObservedWindow,
} from '@pilot/shared';
import type {
  AgentSession,
  InteractionCommand,
  SpeechInputAdapter,
  SpeechOutputAdapter,
} from '@pilot/platform';
import { FakeSpeechInputAdapter } from '@pilot/platform/fakes';
import {
  FakeQuestionAnchorSource,
  PilotInteractionController,
  PilotQuestionEnvelopeFactory,
  type ObservationControlPort,
  type QuestionAnchorSource,
  type QuestionEnvelopeFactory,
  type Scheduler,
} from '@pilot/interaction';
import { createSpeechOutputRuntime } from './speech-runtime.js';
import type { ObservationInteraction } from './window-gate.js';

/**
 * The real interaction controller, assembled (PR-029).
 *
 * `FakeInteractionController` is gone: what the panel reads is now
 * `@pilot/interaction`'s 330-cell transition table driving a real
 * `PiAgentSession`. Everything the fake used to *patch into* the view state —
 * the selected window closing, a question superseding another, the error state
 * and the way out of it — is now produced by the table, in one place.
 *
 * Every port here is now real in the app, and each default below survives only
 * for the scripted desktop suites that supply nothing:
 *
 *  - **speech in** — `FakeSpeechInputAdapter` (PR-032 wired `MacSpeechInputAdapter`);
 *  - **speech out** — `main/speech-runtime.ts` with no synthesiser (PR-033
 *    wired `MacSpeechOutputAdapter`; `createSilentSpeechOutputAdapter` is gone,
 *    runbook follow-up 24);
 *  - **observation** — {@link createMockObservationControlPort} and, on the
 *    agent side, `FakeScreenContextService` (PR-028 / PR-030).
 *
 * The pointer anchor source was mocked too, and that was not a detail: with no
 * recorded pointer, every envelope was `grounding: 'pointer-unknown'`, which is
 * exactly the case runbook follow-up 1 is about. **PR-031 replaced it** —
 * `main/question-anchor.ts` builds the factory over the real `ObservationCore`
 * and the app passes it as {@link InteractionRuntimeOptions.envelopes}. The
 * default here is still the empty recording, because the scripted desktop
 * suites want a question with no pointer behind it, and because
 * `renderAnchoredQuestionEnvelope` (wired in `agent-runtime.ts`) has to keep
 * proving that an unknown pointer never reaches the model as `-1.000`.
 */

/** What the mocked capture port was asked to do, for the log and the demo. */
export type ObservationPortCallType = 'start' | 'stop' | 'clear' | 'observe';

/**
 * A capture lifecycle that records what it was asked for and captures nothing.
 *
 * PR-028 replaces it with the real `ObservationAdapter` /
 * `ScreenContextService` pair. Recording rather than ignoring keeps the
 * delivery rule ("never silently do nothing") true: the calls are visible in
 * the log and countable in a test, so "Look now" completing here means the
 * machine's path ran, not that a screen was read.
 */
export function createMockObservationControlPort(
  logger: Logger = nullLogger,
): ObservationControlPort & {
  readonly calls: readonly ObservationPortCallType[];
} {
  const calls: ObservationPortCallType[] = [];
  const note = (call: ObservationPortCallType): void => {
    calls.push(call);
    logger.debug('observation port (mocked)', { call });
  };
  return {
    calls,
    async start(_window: ObservedWindow): Promise<void> {
      note('start');
    },
    async stop(): Promise<void> {
      note('stop');
    },
    async clear(): Promise<void> {
      note('clear');
    },
    async observe(_observationId: ObservationId, signal?: AbortSignal): Promise<void> {
      note('observe');
      signal?.throwIfAborted();
    },
  };
}

export interface InteractionRuntimeOptions {
  readonly agent: AgentSession;
  readonly conversationId: ConversationId;
  readonly speechInput?: SpeechInputAdapter;
  readonly speechOutput?: SpeechOutputAdapter;
  /**
   * The pointer timeline behind the envelope's `pointer` field. `FakeQuestion
   * AnchorSource` (an empty recording) unless a caller supplies one; PR-031
   * supplies the real one indirectly, through {@link envelopes}.
   */
  readonly anchors?: QuestionAnchorSource;
  /**
   * The whole envelope factory (PR-031).
   *
   * `anchors` alone is not enough for the question anchor, because setting
   * `ScreenContextInputs.anchor` has to happen at the same instant the envelope
   * is built and from the same resolved sample — `main/question-anchor.ts`
   * therefore owns both, and hands the composed factory in here. Additive and
   * optional: a caller that passes neither still gets PR-024's factory over the
   * empty recording, which is what the scripted desktop suites want.
   */
  readonly envelopes?: QuestionEnvelopeFactory;
  readonly observation?: ObservationControlPort;
  readonly clock?: { now(): number };
  /**
   * What wakes a fragment the model left hanging (PR-027, runbook follow-up 25).
   *
   * The app passes `createTimeoutScheduler()`. The default is PR-027's own:
   * `NULL_SCHEDULER`, which never fires and leaves the tail to be released when
   * the run ends — so every scripted desktop suite stays deterministic without
   * knowing this exists.
   */
  readonly scheduler?: Scheduler;
  readonly logger?: Logger;
}

export interface InteractionRuntime {
  readonly controller: PilotInteractionController;
  readonly speechInput: SpeechInputAdapter;
  readonly speechOutput: SpeechOutputAdapter;
  /**
   * `calls` is present only while the port is the mocked one: the real
   * `ObservationControlPort` (PR-028) records nothing, so a reader must handle
   * `undefined` rather than assume the list exists.
   */
  readonly observation: ObservationControlPort & {
    readonly calls?: readonly ObservationPortCallType[];
  };
}

export function createInteractionRuntime(options: InteractionRuntimeOptions): InteractionRuntime {
  const logger = options.logger ?? nullLogger;
  const speechInput = options.speechInput ?? new FakeSpeechInputAdapter();
  // PR-033: one implementation of the port, in two modes. With no synthesiser
  // supplied it completes every chunk silently — which is exactly what
  // `createSilentSpeechOutputAdapter` used to be, and what a Mac with no
  // installed voice does (runbook follow-up 24).
  const speechOutput = options.speechOutput ?? createSpeechOutputRuntime({ logger }).speechOutput;
  const observation = options.observation ?? createMockObservationControlPort(logger);
  const controller = new PilotInteractionController({
    clock: options.clock ?? { now: () => Date.now() },
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    speechInput,
    speechOutput,
    agent: options.agent,
    envelopes:
      options.envelopes ??
      new PilotQuestionEnvelopeFactory({
        anchors: options.anchors ?? new FakeQuestionAnchorSource(),
      }),
    observation,
    conversationId: options.conversationId,
    // Nothing has reported a permission snapshot yet. `null` means "not known",
    // which the machine treats as "do not block"; `main/index.ts` forwards the
    // permission gate's first real snapshot as a `permissions-changed` event.
    permissions: null,
  });
  return { controller, speechInput, speechOutput, observation };
}

/**
 * The window gate's view of the interaction side (runbook follow-up 10).
 *
 * PR-009 had to reproduce `@pilot/interaction`'s `windows-changed` and
 * `window-closed` rows by hand, because the fake controller had no event input.
 * With the real controller `report` is the identity function it was always
 * shaped to be, and the §16 behaviour is asserted in exactly one place — the
 * transition table.
 */
export function createObservationInteraction(
  controller: PilotInteractionController,
): ObservationInteraction {
  return {
    snapshot: () => controller.snapshot(),
    subscribe: controller.subscribe,
    dispatch: (command: InteractionCommand) => {
      controller.dispatch(command);
    },
    report: (event) => {
      controller.send(event);
    },
  };
}
