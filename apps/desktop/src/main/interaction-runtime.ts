import {
  nullLogger,
  type ConversationId,
  type Logger,
  type ObservationId,
  type ObservedWindow,
  type SpeechId,
} from '@pilot/shared';
import type {
  AgentSession,
  InteractionCommand,
  SpeechInputAdapter,
  SpeechOutputAdapter,
  SpeechOutputEvent,
  SpeechOutputRequest,
  Unsubscribe,
} from '@pilot/platform';
import { FakeSpeechInputAdapter } from '@pilot/platform/fakes';
import {
  FakeQuestionAnchorSource,
  PilotInteractionController,
  PilotQuestionEnvelopeFactory,
  type ObservationControlPort,
  type QuestionAnchorSource,
} from '@pilot/interaction';
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
 * Three ports are still mocked, each owned by a later PR and named here so a
 * reviewer never has to guess which half of the app is real:
 *
 *  - **speech in** — `FakeSpeechInputAdapter` (PR-032 brings `MacSpeechInputAdapter`);
 *  - **speech out** — {@link createSilentSpeechOutputAdapter} (PR-033);
 *  - **observation** — {@link createMockObservationControlPort} and, on the
 *    agent side, `FakeScreenContextService` (PR-028 / PR-030).
 *
 * The pointer anchor source is mocked too, and that is not a detail: with no
 * recorded pointer, every envelope is `grounding: 'pointer-unknown'`, which is
 * exactly the case runbook follow-up 1 is about. `renderAnchoredQuestionEnvelope`
 * (wired in `agent-runtime.ts`) is what stops that reaching the model as a
 * position at `-1, -1`.
 */

/**
 * A speech-output adapter that makes no sound and completes immediately.
 *
 * PR-033 owns real speech. Until then something has to satisfy the port, and
 * the choice matters more than it looks: `FakeSpeechOutputAdapter` from
 * `@pilot/platform/fakes` reports `started` and then waits for a test to call
 * `finish()`, so an app wired to it would enter `speaking` on the first answer
 * and stay there forever. This one reports `started` and then `finished` on the
 * next microtask, which is the shape of a synthesiser that has nothing to say
 * — the panel passes through `speaking` and returns to rest, and nothing claims
 * a sound was produced.
 */
export function createSilentSpeechOutputAdapter(): SpeechOutputAdapter & {
  readonly spoken: readonly SpeechOutputRequest[];
} {
  const listeners = new Set<(event: SpeechOutputEvent) => void>();
  const spoken: SpeechOutputRequest[] = [];
  let active: SpeechId | null = null;
  const emit = (event: SpeechOutputEvent): void => {
    for (const listener of [...listeners]) {
      listener(event);
    }
  };
  return {
    spoken,
    async availability() {
      // Honest: there is no voice on this platform yet.
      return { available: true, voices: [] };
    },
    async speak(request: SpeechOutputRequest): Promise<void> {
      spoken.push(request);
      active = request.speechId;
      emit({ type: 'started', speechId: request.speechId });
      queueMicrotask(() => {
        if (active === request.speechId) {
          active = null;
          emit({ type: 'finished', speechId: request.speechId });
        }
      });
    },
    async stop(speechId?: SpeechId): Promise<void> {
      const target = speechId ?? active;
      if (target !== null && target !== undefined && active === target) {
        active = null;
        emit({ type: 'stopped', speechId: target });
      }
    },
    subscribe: (listener: (event: SpeechOutputEvent) => void): Unsubscribe => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

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
  /** Mocked until PR-031 hands over the real pointer timeline. */
  readonly anchors?: QuestionAnchorSource;
  readonly observation?: ObservationControlPort;
  readonly clock?: { now(): number };
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
  const speechOutput = options.speechOutput ?? createSilentSpeechOutputAdapter();
  const observation = options.observation ?? createMockObservationControlPort(logger);
  const controller = new PilotInteractionController({
    clock: options.clock ?? { now: () => Date.now() },
    speechInput,
    speechOutput,
    agent: options.agent,
    envelopes: new PilotQuestionEnvelopeFactory({
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
