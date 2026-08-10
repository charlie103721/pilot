import { afterEach, describe, expect, it } from 'vitest';
import { PilotError, asConversationId, asSpeechId, type SpeechId } from '@pilot/shared';
import type { SpeechOutputAdapter, SpeechOutputEvent, SpeechOutputRequest } from '@pilot/platform';
import { FakeAgentSession, FakeSpeechOutputAdapter } from '@pilot/platform/fakes';
import {
  speechChunkId,
  type CancelScheduled,
  type PilotInteractionController,
  type Scheduler,
} from '@pilot/interaction';
import { createInteractionRuntime } from '../../src/main/interaction-runtime.js';
import { createSpeechOutputRuntime } from '../../src/main/speech-runtime.js';

/**
 * The speech-output seam (PR-033) — `main/speech-runtime.ts`.
 *
 * Three properties are load-bearing and each one is a way this PR can fail
 * silently:
 *
 * 1. **The per-chunk identifiers are echoed, never rewritten** (runbook
 *    follow-up 5). `SpeechOutputBinding` matches every callback against the
 *    chunk in flight; an id of the seam's own invention would have every
 *    callback discarded as `unknown-chunk` and the answer would never report
 *    completion.
 * 2. **No `error` leaves the seam** (system-design §16). The table takes
 *    `speech-failed` to `error` and tears the run down with it, so a synthesiser
 *    failure would abort the model run that is still writing the answer.
 * 3. **`stop()` never throws** (follow-up 15), including for a stream the
 *    synthesiser never started, because an exception there arrives as `failure`
 *    and then as `error` — an interruption that breaks the turn.
 *
 * Nothing here has ever made a sound: the doubles below are
 * `FakeSpeechOutputAdapter` and a hand-written failing adapter, and the demo's
 * end of it (`pnpm demo:speak`) runs against the Node helper stub.
 */

const CHUNK_0 = speechChunkId(asSpeechId('speech-1'), 0);
const CHUNK_1 = speechChunkId(asSpeechId('speech-1'), 1);

function recorder(adapter: SpeechOutputAdapter): SpeechOutputEvent[] {
  const events: SpeechOutputEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  return events;
}

/** An adapter whose every `speak` rejects — a dead helper, or no voice at all. */
function refusingAdapter(): SpeechOutputAdapter & { readonly stopCalls: number } {
  const state = { stopCalls: 0 };
  return {
    get stopCalls(): number {
      return state.stopCalls;
    },
    async availability() {
      return { available: true, voices: ['fake-voice'] };
    },
    async speak(_request: SpeechOutputRequest): Promise<void> {
      throw new PilotError('speech-output-failed', 'the synthesiser is gone');
    },
    async stop(): Promise<void> {
      state.stopCalls += 1;
      throw new PilotError('speech-output-failed', 'nothing to stop');
    },
    subscribe: () => () => undefined,
  };
}

const controllers: PilotInteractionController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    await controller.dispose();
  }
});

describe('the identifiers the machine matches against', () => {
  it('forwards started, finished and stopped with the id the request carried', async () => {
    const adapter = new FakeSpeechOutputAdapter();
    const runtime = createSpeechOutputRuntime({ adapter });
    const events = recorder(runtime.speechOutput);

    await runtime.speechOutput.speak({ speechId: CHUNK_0, text: 'One.' });
    adapter.finish();
    await runtime.speechOutput.speak({ speechId: CHUNK_1, text: 'Two.' });
    await runtime.speechOutput.stop(CHUNK_1);

    expect(events).toEqual([
      { type: 'started', speechId: CHUNK_0 },
      { type: 'finished', speechId: CHUNK_0 },
      { type: 'started', speechId: CHUNK_1 },
      { type: 'stopped', speechId: CHUNK_1 },
    ]);
    // Follow-up 5, at the seam: the request carried `<speechId>#<n>` and every
    // event names the same chunk. A stream id here would be `speech-1`.
    expect(adapter.spoken.map((request) => request.speechId)).toEqual([CHUNK_0, CHUNK_1]);
  });

  it('names the failing chunk, not the stream, when it invents the completion', async () => {
    const runtime = createSpeechOutputRuntime({ adapter: refusingAdapter() });
    const events = recorder(runtime.speechOutput);

    await runtime.speechOutput.speak({ speechId: CHUNK_1, text: 'Two.' });
    await Promise.resolve();

    expect(events.map((event) => event.speechId)).toEqual([CHUNK_1, CHUNK_1]);
    expect(events.map((event) => event.type)).toEqual(['started', 'finished']);
  });
});

describe('a synthesiser failure is silence, never an error (§16)', () => {
  it('turns an error callback into a completion for the same chunk', async () => {
    const adapter = new FakeSpeechOutputAdapter();
    const runtime = createSpeechOutputRuntime({ adapter });
    const events = recorder(runtime.speechOutput);

    await runtime.speechOutput.speak({ speechId: CHUNK_0, text: 'One.' });
    adapter.emitError(CHUNK_0, 'the voice went away');

    expect(events).toEqual([
      { type: 'started', speechId: CHUNK_0 },
      { type: 'finished', speechId: CHUNK_0 },
    ]);
    expect(runtime.stats().silenced).toBe(1);
  });

  it('never rejects when the synthesiser refuses the text', async () => {
    const runtime = createSpeechOutputRuntime({ adapter: refusingAdapter() });

    await expect(runtime.speechOutput.speak({ speechId: CHUNK_0, text: 'One.' })).resolves.toBe(
      undefined,
    );
    expect(runtime.stats().accepted).toBe(0);
    expect(runtime.stats().silenced).toBe(1);
  });

  it('asks nothing of a platform that has said it has no voice', async () => {
    const adapter = new FakeSpeechOutputAdapter({ available: false, voices: [] });
    const runtime = createSpeechOutputRuntime({ adapter });

    const reported = await runtime.start();
    await runtime.speechOutput.speak({ speechId: CHUNK_0, text: 'One.' });

    expect(reported.available).toBe(false);
    expect(runtime.available()).toBe(false);
    expect(adapter.spoken).toEqual([]);
    expect(runtime.stats().silenced).toBe(1);
  });

  it('completes every chunk on a build with no synthesiser at all', async () => {
    // What `createSilentSpeechOutputAdapter` used to be (follow-up 24): now the
    // degraded mode of the one implementation, not a second one.
    const runtime = createSpeechOutputRuntime();
    const events = recorder(runtime.speechOutput);

    await runtime.speechOutput.speak({ speechId: CHUNK_0, text: 'One.' });
    await Promise.resolve();

    expect(runtime.real).toBe(false);
    expect(await runtime.speechOutput.availability()).toEqual({ available: false, voices: [] });
    expect(events.map((event) => event.type)).toEqual(['started', 'finished']);
  });
});

describe('stopping (runbook follow-up 15)', () => {
  it('is a no-op for a stream the synthesiser never started', async () => {
    const adapter = new FakeSpeechOutputAdapter();
    const runtime = createSpeechOutputRuntime({ adapter });
    const events = recorder(runtime.speechOutput);

    await expect(runtime.speechOutput.stop(CHUNK_1)).resolves.toBe(undefined);

    expect(events).toEqual([]);
    expect(adapter.stopCalls).toEqual([CHUNK_1]);
    expect(runtime.stats().lastStopMs).not.toBeNull();
  });

  it('swallows an adapter that treats such a stop as an error', async () => {
    const adapter = refusingAdapter();
    const runtime = createSpeechOutputRuntime({ adapter });

    await expect(runtime.speechOutput.stop(CHUNK_1)).resolves.toBe(undefined);

    expect(adapter.stopCalls).toBe(1);
  });

  it('retracts a chunk it was completing itself', async () => {
    const runtime = createSpeechOutputRuntime();
    const events = recorder(runtime.speechOutput);

    // Deliberately not awaited: the completion is a microtask, and the point of
    // this test is the interruption that lands before it.
    const speaking = runtime.speechOutput.speak({ speechId: CHUNK_0, text: 'One.' });
    await runtime.speechOutput.stop(CHUNK_0);
    await speaking;
    await Promise.resolve();

    // `started`, then `stopped` — and no `finished` afterwards, because the
    // interruption won the race with the microtask that would have completed it.
    expect(events.map((event) => event.type)).toEqual(['started', 'stopped']);
  });

  it('is inert after dispose, so the controller can be torn down behind it', async () => {
    const adapter = new FakeSpeechOutputAdapter();
    let disposed = 0;
    const runtime = createSpeechOutputRuntime({
      adapter,
      dispose: async () => {
        disposed += 1;
      },
    });

    await runtime.dispose();
    await runtime.dispose();
    await runtime.speechOutput.speak({ speechId: CHUNK_0, text: 'One.' });
    await runtime.speechOutput.stop(CHUNK_0);

    expect(disposed).toBe(1);
    expect(adapter.spoken).toEqual([]);
    expect(adapter.stopCalls).toEqual([]);
  });
});

describe('through the real controller and PR-026’s binding', () => {
  function harness(adapter: SpeechOutputAdapter): {
    readonly controller: PilotInteractionController;
    readonly errors: SpeechId[];
  } {
    const conversationId = asConversationId('conv-speech-runtime');
    const runtime = createSpeechOutputRuntime({ adapter });
    const { controller } = createInteractionRuntime({
      agent: new FakeAgentSession({ conversationId }),
      conversationId,
      speechOutput: runtime.speechOutput,
    });
    controllers.push(controller);
    const errors: SpeechId[] = [];
    controller.subscribe((view) => {
      if (view.state === 'error') {
        errors.push(asSpeechId('reached-error'));
      }
    });
    return { controller, errors };
  }

  it('speaks an answer in several chunks, in order, and reports one completion', async () => {
    const adapter = new FakeSpeechOutputAdapter();
    const { controller, errors } = harness(adapter);

    controller.dispatch({
      type: 'submit-text',
      text: 'What does this do?',
    });
    await controller.settled();
    // `FakeAgentSession` answers in one go; each completed sentence becomes a
    // chunk, and the fake synthesiser needs telling that each one ended.
    for (let index = 0; index < 8 && adapter.activeSpeechId !== null; index += 1) {
      adapter.finish();
      await controller.settled();
    }
    await controller.settled();

    const ids = adapter.spoken.map((request) => request.speechId);
    expect(ids.length).toBeGreaterThan(0);
    const stream = String(ids[0]).split('#')[0] ?? '';
    // Ordered, contiguous, and all under one stream id — which is precisely
    // what `SpeechOutputBinding` matches its callbacks against.
    expect(ids).toEqual(ids.map((_id, index) => speechChunkId(asSpeechId(stream), index)));
    expect(errors).toEqual([]);
    expect(controller.snapshot().speaking).toBe(false);
  });

  it('keeps the answer, and the run, when the synthesiser fails a chunk', async () => {
    const adapter = new FakeSpeechOutputAdapter();
    const { controller, errors } = harness(adapter);

    controller.dispatch({ type: 'submit-text', text: 'What does this do?' });
    await controller.settled();
    const failing = adapter.activeSpeechId;
    expect(failing).not.toBeNull();
    adapter.emitError(failing as SpeechId, 'the voice went away');
    for (let index = 0; index < 8 && adapter.activeSpeechId !== null; index += 1) {
      adapter.finish();
      await controller.settled();
    }
    await controller.settled();

    const view = controller.snapshot();
    // The whole point: the failure never reached the machine, so the run was
    // never torn down and the answer is still on screen and complete.
    expect(errors).toEqual([]);
    expect(view.state).not.toBe('error');
    expect(view.lastError).toBeNull();
    const answer = view.transcript.filter((entry) => entry.role === 'assistant').at(-1);
    expect(answer?.text ?? '').not.toBe('');
    expect(answer?.pending).toBe(false);
  });
});

describe('the phrase-timeout scheduler (runbook follow-up 25)', () => {
  /** Counts every arming, including ones cancelled before they fire. */
  function countingScheduler(): Scheduler & { readonly armed: number } {
    const state = { armed: 0 };
    return {
      get armed(): number {
        return state.armed;
      },
      schedule(_delayMs: number, _callback: () => void): CancelScheduled {
        state.armed += 1;
        return () => undefined;
      },
    };
  }

  async function run(scheduler?: Scheduler): Promise<PilotInteractionController> {
    const conversationId = asConversationId('conv-speech-scheduler');
    const adapter = new FakeSpeechOutputAdapter();
    const { controller } = createInteractionRuntime({
      agent: new FakeAgentSession({ conversationId }),
      conversationId,
      speechOutput: createSpeechOutputRuntime({ adapter }).speechOutput,
      ...(scheduler === undefined ? {} : { scheduler }),
    });
    controllers.push(controller);
    controller.dispatch({ type: 'submit-text', text: 'What does this do?' });
    await controller.settled();
    for (let index = 0; index < 8 && adapter.activeSpeechId !== null; index += 1) {
      adapter.finish();
      await controller.settled();
    }
    await controller.settled();
    return controller;
  }

  it('reaches the controller when the app passes one', async () => {
    const scheduler = countingScheduler();
    await run(scheduler);

    // PR-029 passed none, so a fragment the model left hanging waited for the
    // run to end. `main/index.ts` now passes `createTimeoutScheduler()`; that
    // the controller arms it at all is the whole of the wiring.
    expect(scheduler.armed).toBeGreaterThan(0);
  });

  it('still answers with no scheduler at all, which is the default', async () => {
    const controller = await run();

    expect(controller.snapshot().lastError).toBeNull();
    expect(
      controller
        .snapshot()
        .transcript.filter((entry) => entry.role === 'assistant')
        .at(-1)?.pending,
    ).toBe(false);
  });
});
