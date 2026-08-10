import { nullLogger, toPilotError, type Logger, type UtteranceId } from '@pilot/shared';
import type { InteractionCommand, PilotViewState } from '@pilot/platform';
import type { FakeSpeechInputAdapter } from '@pilot/platform/fakes';
import type { PilotInteractionController } from '@pilot/interaction';
import type { ConversationFixtureName } from '../ipc/schemas.js';
import type { ConversationGate } from './conversation-gate.js';

/**
 * The panel's "Replay" bar, driving a **real** conversation (PR-029).
 *
 * PR-010 shipped a fixture replay that patched view states onto the fake
 * controller, because nothing in that build could *cause* a conversation. This
 * build can: each control below dispatches the same commands the panel's own
 * buttons dispatch, into the real interaction controller, which submits a real
 * question envelope to a real `PiAgentSession`. Only the provider is faux, and
 * only speech and observation are still mocked.
 *
 * That is why this replaces `createFakeConversationDriver` in the app rather
 * than sitting beside it: two descriptions of "what a conversation looks like"
 * would drift, and the fixture one is now the weaker of the two. (The fixture
 * replay survives in `conversation-fixtures.ts` for PR-010's headless panel
 * walkthrough and its privacy tests, which need scripted words and a scripted
 * clock and never touch an agent.)
 *
 * Everything here waits on the controller rather than on a timer, with one
 * bounded ceiling so a wedged run cannot hang the IPC call that started it.
 */

/** The question the replay bar asks when it types one. */
export const DEMO_TYPED_QUESTION = 'What does this Auto Renew toggle actually do?';

/** Ceiling on any single wait. A dev affordance must not hang the panel. */
const WAIT_TIMEOUT_MS = 10_000;
const POLL_MS = 10;

/**
 * `void` is allowed so PR-010's synchronous fixture replay still satisfies the
 * shell's option — the tests that drive the panel from scripted view states use
 * it, and the shell awaits either shape.
 */
export type LiveConversationDriver = (fixture: ConversationFixtureName) => Promise<void> | void;

export interface LiveConversationDriverOptions {
  readonly controller: PilotInteractionController;
  readonly gate: ConversationGate;
  /**
   * The mocked recogniser. Needed for exactly one thing the commands cannot
   * express: making recognition *fail*, which is the §16 case where the text
   * box is the only way left to ask.
   */
  readonly speech: Pick<FakeSpeechInputAdapter, 'emitError'>;
  readonly logger?: Logger;
}

const RESTING: ReadonlySet<PilotViewState['state']> = new Set([
  'idle',
  'observing',
  'paused',
  'needs-permission',
  'error',
]);

export function createLiveConversationDriver(
  options: LiveConversationDriverOptions,
): LiveConversationDriver {
  const { controller, gate, speech } = options;
  const logger = options.logger ?? nullLogger;

  /** Exactly the shell's own dispatch, so an abort is counted once (§17). */
  const dispatch = (command: InteractionCommand): void => {
    gate.noteCommand(command);
    controller.dispatch(command);
  };

  const waitFor = async (what: string, predicate: () => boolean): Promise<boolean> => {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!predicate()) {
      if (Date.now() > deadline) {
        logger.warn('conversation replay gave up waiting', { what });
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return true;
  };

  /** True once the newest assistant turn has any text at all. */
  const answerStarted = (): boolean => {
    const newest = controller.snapshot().transcript.at(-1);
    return newest?.role === 'assistant' && newest.text.length > 0;
  };

  const settle = async (): Promise<void> => {
    await controller.settled();
    await waitFor('the answer to finish', () => RESTING.has(controller.snapshot().state));
  };

  const ask = async (): Promise<void> => {
    dispatch({ type: 'submit-text', text: DEMO_TYPED_QUESTION });
    await settle();
  };

  const speak = async (): Promise<void> => {
    dispatch({ type: 'push-to-talk-down' });
    await controller.settled();
    // The mocked recogniser answers on `stop()`, so the transcript arrives
    // synchronously with the key release, exactly as `push-to-talk-up` intends.
    dispatch({ type: 'push-to-talk-up' });
    await settle();
  };

  return async (fixture: ConversationFixtureName): Promise<void> => {
    try {
      switch (fixture) {
        case 'typed-question':
          await ask();
          return;

        case 'spoken-question':
          await speak();
          return;

        case 'interrupted-answer': {
          dispatch({ type: 'submit-text', text: DEMO_TYPED_QUESTION });
          await controller.settled();
          // Interrupt once the model has actually said something, so the panel
          // shows a half-finished answer rather than an empty one.
          await waitFor('the answer to start', answerStarted);
          dispatch({ type: 'interrupt' });
          await settle();
          return;
        }

        case 'stt-failure': {
          dispatch({ type: 'push-to-talk-down' });
          await controller.settled();
          const utteranceId: UtteranceId | null = controller.liveUtteranceId;
          if (utteranceId === null) {
            logger.warn('conversation replay could not start an utterance to fail');
            return;
          }
          speech.emitError(utteranceId, 'The recogniser stopped responding');
          await controller.settled();
          return;
        }

        case 'reset':
          // The commands first, the ring second: clearing before dispatching
          // would leave whatever those two commands recorded behind, and
          // "reset" that leaves a sample behind is not a reset.
          dispatch({ type: 'clear-conversation' });
          dispatch({ type: 'dismiss-error' });
          await controller.settled();
          gate.telemetry.clear();
          return;
      }
    } catch (cause) {
      // A replay control must not be able to take the app down; the panel's own
      // error surface reports whatever the controller reported.
      logger.warn('conversation replay failed', { fixture, code: toPilotError(cause).code });
    }
  };
}
