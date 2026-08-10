import { describe, expect, it } from 'vitest';
import {
  PilotError,
  asConversationId,
  createCounterIdSource,
  createIdFactory,
  type RunId,
  type SpeechId,
} from '@pilot/shared';
import type {
  SpeechOutputAdapter,
  SpeechOutputEvent,
  SpeechOutputRequest,
  Unsubscribe,
} from '@pilot/platform';
import {
  FIXTURE_PERMISSIONS_GRANTED,
  FIXTURE_WINDOWS,
  FIXTURE_WINDOW_RETINA,
  FakeAgentSession,
  FakeSpeechInputAdapter,
  FakeSpeechOutputAdapter,
  createFakeClock,
  type FakeClock,
} from '@pilot/platform/fakes';
import {
  FakeQuestionEnvelopeFactory,
  InterruptibleAgentSession,
  ManualScheduler,
  PilotInteractionController,
  RecordingObservationPort,
  STEER_INTERRUPTION_MESSAGE,
  SpeechOutputBinding,
  speechChunkId,
  type CancellationRecord,
  type InteractionInput,
  type VoiceDiagnostic,
} from '@pilot/interaction';

/**
 * PR-027 — interruption and cancellation.
 *
 * `docs/implementation.md` asks for "interrupt during thinking and speaking
 * without late output resurfacing", and the brief names five cases explicitly:
 * an interruption mid-`observe_screen` (which steers rather than aborts), a
 * `speak` effect already queued when the interruption lands, a run that
 * completes *after* being aborted, two interruptions in quick succession, and
 * an interruption arriving between `run-completed` and the first
 * `speech-started`. Each is a test below.
 *
 * "Late output does not resurface" is checked in the three places it could:
 * the panel transcript, the synthesiser, and the diagnostics — where it must
 * appear as a *discard*, never as a real event.
 *
 * Everything is deterministic: injected clock, counter identifiers, scripted
 * agent, scripted synthesiser, manual scheduler. No wall clock, no timers.
 */

const WINDOW = FIXTURE_WINDOW_RETINA;

/**
 * Let queued effects run *without* waiting for them all to finish.
 *
 * `settled()` cannot be used when a fake is deliberately holding one effect
 * open — that is the situation under test. Draining a fixed number of microtask
 * turns is deterministic and, unlike a timer, adds no real time.
 */
async function flush(turns = 40): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// A synthesiser that can be held mid-utterance
// ---------------------------------------------------------------------------

/**
 * `FakeSpeechOutputAdapter` completes `speak()` immediately, which is exactly
 * what PR-026 needed and exactly what an interruption test must not have: a
 * queue that is never busy can never be jumped. This one holds every `speak()`
 * call open until the test releases it, and stamps the injected clock on each
 * call, so "the stop did not wait for the work in front of it" is a measurement
 * rather than an impression (system-design §17: TTS interruption under 300 ms).
 */
class GatedSpeechOutput implements SpeechOutputAdapter {
  readonly spoken: { readonly request: SpeechOutputRequest; readonly at: number }[] = [];
  readonly stopCalls: { readonly speechId: SpeechId | undefined; readonly at: number }[] = [];
  readonly #listeners = new Set<(event: SpeechOutputEvent) => void>();
  readonly #clock: FakeClock;
  #release: (() => void) | null = null;
  #active: SpeechId | null = null;

  constructor(clock: FakeClock) {
    this.#clock = clock;
  }

  subscribe = (listener: (event: SpeechOutputEvent) => void): Unsubscribe => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async availability(): Promise<{ available: boolean; voices: readonly string[] }> {
    return { available: true, voices: ['gated-voice'] };
  }

  async speak(request: SpeechOutputRequest): Promise<void> {
    this.spoken.push({ request, at: this.#clock.now() });
    await new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    this.#active = request.speechId;
    this.#emit({ type: 'started', speechId: request.speechId });
  }

  async stop(speechId?: SpeechId): Promise<void> {
    this.stopCalls.push({ speechId, at: this.#clock.now() });
    const target = speechId ?? this.#active;
    if (target !== undefined && target !== null && this.#active === target) {
      this.#active = null;
      this.#emit({ type: 'stopped', speechId: target });
    }
  }

  /** Let the utterance the synthesiser is holding start. */
  release(): void {
    const release = this.#release;
    this.#release = null;
    release?.();
  }

  get holding(): boolean {
    return this.#release !== null;
  }

  #emit(event: SpeechOutputEvent): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  readonly speechOutput?: SpeechOutputAdapter;
  readonly agent?: FakeAgentSession | InterruptibleAgentSession;
  readonly observation?: RecordingObservationPort;
  readonly scheduler?: ManualScheduler;
  readonly phraseTimeoutMs?: number;
}

function createHarness(options: HarnessOptions = {}) {
  const clock = createFakeClock();
  const conversationId = asConversationId('conv-interrupt');
  const speechInput = new FakeSpeechInputAdapter({
    script: [
      { final: 'What is this?' },
      { final: 'No wait, what is that?' },
      { final: 'And that one?' },
    ],
  });
  const speechOutput = options.speechOutput ?? new FakeSpeechOutputAdapter();
  const agent = options.agent ?? new FakeAgentSession({ conversationId, mode: 'manual' });
  const observation = options.observation ?? new RecordingObservationPort();
  const controller = new PilotInteractionController({
    clock,
    ids: createIdFactory(createCounterIdSource()),
    conversationId,
    speechInput,
    speechOutput,
    agent,
    envelopes: new FakeQuestionEnvelopeFactory(),
    observation,
    permissions: FIXTURE_PERMISSIONS_GRANTED,
    windows: FIXTURE_WINDOWS,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.phraseTimeoutMs === undefined ? {} : { phraseTimeoutMs: options.phraseTimeoutMs }),
  });

  const rejections: string[] = [];
  controller.subscribeRejections((rejection) => {
    rejections.push(`${rejection.input}:${rejection.reason}`);
  });
  const diagnostics: VoiceDiagnostic[] = [];
  controller.subscribeVoiceDiagnostics((diagnostic) => diagnostics.push(diagnostic));
  const cancellations: CancellationRecord[] = [];
  controller.subscribeCancellations((record) => cancellations.push(record));

  const send = async (input: InteractionInput): Promise<void> => {
    controller.send(input);
    await controller.settled();
  };

  return {
    clock,
    controller,
    speechInput,
    speechOutput,
    agent,
    observation,
    rejections,
    diagnostics,
    cancellations,
    send,
    /** Select a window and ask a typed question; returns the agent's run id. */
    ask: async (text: string): Promise<RunId> => {
      if (controller.context.selectedWindow === null) {
        await send({ type: 'select-window', windowId: WINDOW.windowId });
      }
      await send({ type: 'submit-text', text });
      const runId = controller.context.activeRunId;
      if (runId === null) {
        throw new Error('expected the agent to have started a run');
      }
      return runId;
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

/** Assistant text the panel would render, per utterance. */
function answers(harness: Harness): readonly string[] {
  return harness.controller
    .snapshot()
    .transcript.filter((entry) => entry.role === 'assistant')
    .map((entry) => entry.text);
}

function spokenText(harness: Harness): readonly string[] {
  const output = harness.speechOutput;
  if (output instanceof FakeSpeechOutputAdapter) {
    return output.spoken.map((request) => request.text);
  }
  if (output instanceof GatedSpeechOutput) {
    return output.spoken.map((entry) => entry.request.text);
  }
  throw new Error('unknown speech output fake');
}

/**
 * The whole point of the PR, in one assertion.
 *
 * Nothing the superseded run produced may appear in the panel transcript, reach
 * the synthesiser, or show up in the diagnostics as anything but a discard.
 */
function expectNoLateOutput(
  harness: Harness,
  before: { readonly answers: readonly string[]; readonly spoken: readonly string[] },
): void {
  expect(answers(harness)).toEqual(before.answers);
  expect(spokenText(harness)).toEqual(before.spoken);
  for (const diagnostic of harness.diagnostics) {
    // Every voice diagnostic is by construction a record of something that was
    // *not* acted on; a real event never becomes one.
    expect(diagnostic.kind).toMatch(
      /^(discarded-event|ignored-call|discarded-chunk|discarded-speech-event|ignored-speech-call)$/,
    );
  }
}

// ---------------------------------------------------------------------------
// Interrupting a run
// ---------------------------------------------------------------------------

describe('interrupting while the model is thinking', () => {
  it('aborts the run, and nothing it says afterwards resurfaces', async () => {
    const harness = createHarness();
    const { controller, agent, send } = harness;
    const runId = await harness.ask('what is this?');

    await send({ type: 'run-text-delta', runId, text: 'That is the Auto Renew toggle. ' });
    const before = { answers: answers(harness), spoken: spokenText(harness) };
    expect(before.spoken).toEqual(['That is the Auto Renew toggle.']);

    await send({ type: 'interrupt' });
    expect(controller.snapshot().state).toBe('observing');
    expect((agent as FakeAgentSession).interrupts).toEqual([
      { mode: 'abort', reason: 'interrupted by the user' },
    ]);

    // The run had more to say. None of it lands anywhere.
    const late = controller.send({ type: 'run-text-delta', runId, text: ' It is currently off.' });
    expect(late.kind === 'rejected' && late.rejection.reason).toBe('stale-run');
    await send({ type: 'run-completed', runId, text: 'That is the Auto Renew toggle. Off.' });
    await send({ type: 'speech-finished', speechId: 'speech-000001' as SpeechId });

    expectNoLateOutput(harness, before);
    expect(harness.rejections).toEqual([
      // The fake reports the abort it was asked for; the machine has already
      // forgotten the run, so even that is discarded rather than acted on.
      'run-aborted:stale-run',
      'run-text-delta:stale-run',
      'run-completed:stale-run',
      'speech-finished:stale-speech',
    ]);
    expect(controller.snapshot().lastError).toBeNull();
    await controller.dispose();
  });

  it('cancels a question that is interrupted while it is still being submitted', async () => {
    const conversationId = asConversationId('conv-interrupt');
    const agent = new InterruptibleAgentSession({ conversationId });
    const harness = createHarness({ agent });
    const { controller, send } = harness;

    await send({ type: 'select-window', windowId: WINDOW.windowId });
    // No `settled()`: the submission is still queued when the interruption lands,
    // so there is no run id yet and `interrupt()` has nothing to name.
    controller.send({ type: 'submit-text', text: 'what is this?' });
    const cancelled = controller.context.activeUtteranceId;
    controller.send({ type: 'interrupt' });
    await controller.settled();

    // The signal is what stops it: the agent never starts a run nobody wants,
    // and therefore never holds the one-run-per-conversation slot against the
    // next question (system-design §15).
    expect(agent.submitted).toEqual([]);
    expect(agent.activeRunId).toBeNull();
    // Cancelled by the effect's own identity check — the submission had not
    // started, so there was not even a signal to abort yet. Same outcome by a
    // cheaper route.
    expect(harness.cancellations).toEqual([
      { work: 'question', id: cancelled, reason: 'superseded', at: expect.any(Number) },
    ]);
    expect(controller.snapshot().lastError).toBeNull();
    expect(controller.snapshot().state).toBe('observing');

    // And the next question submits cleanly.
    await send({ type: 'submit-text', text: 'what is that?' });
    expect(agent.submitted).toHaveLength(1);
    await controller.dispose();
  });
});

describe('interrupting while Pilot is speaking', () => {
  it('stops speech, drops the queued chunk, and never speaks it later', async () => {
    const harness = createHarness();
    const { controller, speechOutput, send } = harness;
    const runId = await harness.ask('what is this?');

    // Two finished sentences: the first is at the synthesiser, the second is
    // queued behind it in the binding.
    await send({ type: 'run-text-delta', runId, text: 'That is the Auto Renew toggle. ' });
    await send({ type: 'run-text-delta', runId, text: 'It renews every month. ' });
    expect(controller.pendingSpeechChunks).toBe(1);
    const before = { answers: answers(harness), spoken: spokenText(harness) };

    await send({ type: 'push-to-talk-down' });
    expect(controller.snapshot().state).toBe('listening');
    expect(controller.pendingSpeechChunks).toBe(0);
    expect((speechOutput as FakeSpeechOutputAdapter).stopCalls).toHaveLength(1);

    // The queued chunk was dropped, not deferred.
    expect(
      harness.diagnostics.filter(
        (diagnostic) => diagnostic.kind === 'discarded-chunk' && diagnostic.reason === 'stopped',
      ),
    ).toHaveLength(1);
    expectNoLateOutput(harness, before);
    await controller.dispose();
  });

  it('discards a `speak` effect that was still queued when the interruption landed', async () => {
    const clock = createFakeClock();
    const speechOutput = new GatedSpeechOutput(clock);
    const conversationId = asConversationId('conv-interrupt');
    const agent = new FakeAgentSession({ conversationId, mode: 'manual' });
    // Built by hand so the gated synthesiser shares the harness clock.
    const controller = new PilotInteractionController({
      clock,
      ids: createIdFactory(createCounterIdSource()),
      conversationId,
      speechInput: new FakeSpeechInputAdapter(),
      speechOutput,
      agent,
      envelopes: new FakeQuestionEnvelopeFactory(),
      observation: new RecordingObservationPort(),
      permissions: FIXTURE_PERMISSIONS_GRANTED,
      windows: FIXTURE_WINDOWS,
    });

    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'submit-text', text: 'what is this?' });
    await controller.settled();
    const runId = controller.context.activeRunId!;

    // The first chunk is in flight inside the synthesiser, so the controller's
    // ordinary effect queue is blocked behind it; the second is queued there.
    controller.send({ type: 'run-text-delta', runId, text: 'That is the toggle. ' });
    await flush();
    expect(speechOutput.holding).toBe(true);
    controller.send({ type: 'run-text-delta', runId, text: 'It renews monthly. ' });
    await flush();
    expect(speechOutput.spoken).toHaveLength(1);

    // A slow synthesiser must not delay the interruption (system-design §17).
    const interruptedAt = clock.now();
    controller.send({ type: 'push-to-talk-down' });
    await flush();

    expect(speechOutput.stopCalls).toHaveLength(1);
    // Stopped at the instant of the interruption, not when the utterance in
    // front of it eventually finished: the clock does not move in between, so
    // the elapsed time is 0 ms against §17's 300 ms budget.
    expect(speechOutput.stopCalls[0]?.at).toBe(interruptedAt);
    // The synthesiser is *still* holding the utterance the stop overtook.
    expect(speechOutput.holding).toBe(true);

    // Five seconds later it finally lets go. Neither the chunk that was in
    // flight nor the one queued behind it may reach the synthesiser as new
    // speech.
    clock.advance(5_000);
    speechOutput.release();
    await controller.settled();
    expect(speechOutput.spoken.map((entry) => entry.request.text)).toEqual(['That is the toggle.']);
    expect(controller.pendingSpeechChunks).toBe(0);
    expect(controller.snapshot().state).toBe('listening');
    await controller.dispose();
  });

  it('an interruption between `run-completed` and the first `speech-started` speaks nothing', async () => {
    const clock = createFakeClock();
    const speechOutput = new GatedSpeechOutput(clock);
    const conversationId = asConversationId('conv-interrupt');
    const agent = new FakeAgentSession({ conversationId, mode: 'manual' });
    const controller = new PilotInteractionController({
      clock,
      ids: createIdFactory(createCounterIdSource()),
      conversationId,
      speechInput: new FakeSpeechInputAdapter(),
      speechOutput,
      agent,
      envelopes: new FakeQuestionEnvelopeFactory(),
      observation: new RecordingObservationPort(),
      permissions: FIXTURE_PERMISSIONS_GRANTED,
      windows: FIXTURE_WINDOWS,
    });
    const states: string[] = [];
    controller.subscribe((view) => states.push(view.state));

    controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
    controller.dispatch({ type: 'submit-text', text: 'what is this?' });
    await controller.settled();
    const runId = controller.context.activeRunId!;

    // The whole answer arrives at once, with no terminator until the run ends:
    // nothing is spoken until `run-completed`, which is the window this test is
    // about.
    controller.send({ type: 'run-text-delta', runId, text: 'It looks like the toggle' });
    controller.send({ type: 'run-completed', runId, text: 'It looks like the toggle' });
    const speechId = controller.context.activeSpeechId;
    expect(speechId).not.toBeNull();
    expect(controller.snapshot().state).toBe('speaking');

    // The interruption lands in the window between the two: the `speak` effect
    // has been emitted and the stream has an identifier, but no chunk has
    // reached the synthesiser and no `speech-started` has come back.
    controller.send({ type: 'interrupt' });
    await controller.settled();

    expect(controller.snapshot().state).toBe('observing');
    expect(controller.snapshot().speaking).toBe(false);
    // Nothing was ever handed over: the answer is not spoken late, and it is
    // not spoken at all.
    expect(speechOutput.spoken).toEqual([]);
    expect(controller.voiceDiagnostics).toEqual([
      {
        kind: 'discarded-chunk',
        speechId,
        utteranceId: expect.any(String),
        sequence: 0,
        characters: 'It looks like the toggle'.length,
        reason: 'stopped',
      },
    ]);

    // Releasing the synthesiser afterwards changes nothing — there is nothing
    // in it to release, and the state never returns to `speaking`.
    speechOutput.release();
    await controller.settled();
    expect(states.slice(-1)).toEqual(['observing']);
    expect(controller.snapshot().speaking).toBe(false);
    await controller.dispose();
  });

  it('never opens a stream that was stopped before its first chunk was handed over', async () => {
    // The same race one layer down, where it is exactly expressible: the
    // machine emitted `stop-speech` while the `speak` effect was still queued.
    const adapter = new FakeSpeechOutputAdapter();
    const events: SpeechOutputEvent[] = [];
    const diagnostics: VoiceDiagnostic[] = [];
    const binding = new SpeechOutputBinding({
      speechOutput: adapter,
      onEvent: (event) => events.push(event),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    const speechId = 'speech-late' as SpeechId;
    await binding.stop(speechId);
    await binding.speak({
      speechId,
      utteranceId: 'utt-late' as never,
      text: 'the answer nobody is waiting for',
      final: true,
    });
    await binding.settled();

    expect(adapter.spoken).toEqual([]);
    expect(events).toEqual([]);
    expect(diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      'ignored-speech-call',
      'discarded-chunk',
    ]);
    expect(diagnostics[1]).toMatchObject({ reason: 'stopped' });
    await binding.dispose();
  });
});

describe('a run that finishes after it was abandoned', () => {
  it('completes into nothing: no transcript, no speech, no state change', async () => {
    const conversationId = asConversationId('conv-interrupt');
    const agent = new InterruptibleAgentSession({ conversationId });
    const harness = createHarness({ agent });
    const { controller, send } = harness;

    await send({ type: 'select-window', windowId: WINDOW.windowId });
    await send({ type: 'submit-text', text: 'what is this?' });
    agent.stream('That is the Auto Renew toggle. ');
    await controller.settled();
    const before = { answers: answers(harness), spoken: spokenText(harness) };

    await send({ type: 'interrupt' });
    expect(agent.runAborted).toBe(true);
    expect(controller.snapshot().state).toBe('observing');

    // The provider had already produced more, and its completion was in flight.
    agent.lateDelta(' It is currently off.');
    agent.lateComplete('That is the Auto Renew toggle. It is currently off.');
    await controller.settled();

    expectNoLateOutput(harness, before);
    expect(harness.rejections).toEqual([
      'run-aborted:stale-run',
      'text-delta:stale-run'.replace('text-delta', 'run-text-delta'),
      'run-completed:stale-run',
    ]);
    await controller.dispose();
  });
});

describe('a screen observation in flight', () => {
  it('steers the run rather than aborting it, so the capture can unwind', async () => {
    const conversationId = asConversationId('conv-interrupt');
    const agent = new InterruptibleAgentSession({ conversationId });
    const harness = createHarness({ agent });
    const { controller, send } = harness;

    await send({ type: 'select-window', windowId: WINDOW.windowId });
    await send({ type: 'submit-text', text: 'what is this?' });
    agent.startTool('observe_screen');
    await controller.settled();
    expect(controller.snapshot().state).toBe('observing-screen');

    await send({ type: 'interrupt' });

    // system-design §15, PR-006: `steer` while a capture is in flight. The run
    // is told to stop *and keeps its abort signal unfired*, which is what lets
    // `observe_screen` finish and unwind instead of being cut in half.
    expect(agent.interrupts).toEqual([{ mode: 'steer', detail: STEER_INTERRUPTION_MESSAGE }]);
    expect(agent.steers).toEqual([STEER_INTERRUPTION_MESSAGE]);
    expect(agent.runAborted).toBe(false);
    expect(agent.toolInFlight).toBe(true);
    expect(controller.snapshot().state).toBe('observing');

    // Everything it produces from here is still discarded, steered or not.
    agent.lateDelta('The toggle is off.');
    await controller.settled();
    expect(answers(harness)).toEqual([]);
    await controller.dispose();
  });

  /**
   * Pinned, not endorsed. A steer leaves the run alive, so the `submit-question`
   * the machine emits in the same transition meets a run that is still going.
   * With the fakes PR-006 shipped this was invisible — they stop on any
   * interrupt — and with a real `PiAgentSession` it is a user-visible error.
   * The fix is a design decision about what "steer" means for a replacement
   * question, and it needs the real agent: runbook §8 follow-up 7, PR-035.
   * This test exists so the behaviour cannot change without someone noticing.
   */
  it('cannot yet start a replacement question while the steered run is still going (PR-035)', async () => {
    const conversationId = asConversationId('conv-interrupt');
    const agent = new InterruptibleAgentSession({ conversationId });
    const harness = createHarness({ agent });
    const { controller, send } = harness;

    await send({ type: 'select-window', windowId: WINDOW.windowId });
    await send({ type: 'submit-text', text: 'what is this?' });
    agent.startTool('observe_screen');
    await controller.settled();

    await send({ type: 'submit-text', text: 'no wait, what is that?' });

    expect(agent.interrupts).toEqual([
      { mode: 'steer', detail: STEER_INTERRUPTION_MESSAGE },
      // The refusal is a recoverable failure, and its teardown aborts the
      // steered run — so Pilot recovers rather than wedging. It still did not
      // do what the user asked, which is why this is a follow-up and not a
      // feature.
      { mode: 'abort', detail: 'recoverable failure' },
    ]);
    expect(agent.submitted).toHaveLength(1);
    expect(controller.snapshot().state).toBe('error');
    expect(controller.snapshot().lastError?.code).toBe('run-already-active');
    expect(agent.runAborted).toBe(true);
    await controller.dispose();
  });

  it('carries an abort through to the run signal `observe_screen` respects', async () => {
    const conversationId = asConversationId('conv-interrupt');
    const agent = new InterruptibleAgentSession({ conversationId });
    const harness = createHarness({ agent });
    const { controller, send } = harness;

    await send({ type: 'select-window', windowId: WINDOW.windowId });
    await send({ type: 'submit-text', text: 'what is this?' });
    agent.startTool('observe_screen');
    await controller.settled();
    expect(agent.runAborted).toBe(false);

    // Quitting, locking, losing the window — anything that must stop Pilot
    // outright rather than steer it — aborts the run, and the abort is what the
    // tool's `AbortSignal` is derived from (PR-021 checks it before the capture,
    // passes it to `ScreenContextService.observe`, and discards a result that
    // arrives after it).
    await controller.dispose();
    expect(agent.interrupts.at(-1)).toEqual({ mode: 'abort', detail: 'controller disposed' });
    expect(agent.runAborted).toBe(true);
  });

  it('aborts a user-requested observation the machine stopped waiting for', async () => {
    const observation = new RecordingObservationPort({ manual: true });
    const harness = createHarness({ observation });
    const { controller, send } = harness;

    await send({ type: 'select-window', windowId: WINDOW.windowId });
    controller.send({ type: 'look-now' });
    await Promise.resolve();
    expect(observation.observing).toBe(true);
    expect(controller.snapshot().state).toBe('observing-screen');

    controller.send({ type: 'interrupt' });
    expect(observation.aborted()).toBe(true);
    await controller.settled();

    expect(harness.cancellations).toEqual([
      { work: 'observation', id: expect.any(String), reason: 'superseded', at: expect.any(Number) },
    ]);
    // A cancelled observation is not a failure and does not report completion.
    expect(controller.snapshot().state).toBe('observing');
    expect(controller.snapshot().lastError).toBeNull();
    expect(harness.rejections).toEqual([]);
    await controller.dispose();
  });
});

describe('interruptions in quick succession', () => {
  it('abandons every superseded question and answers only the last', async () => {
    const harness = createHarness();
    const { controller, agent, send } = harness;

    const first = await harness.ask('what is this?');
    await send({ type: 'run-text-delta', runId: first, text: 'That is the toggle. ' });

    await send({ type: 'submit-text', text: 'no wait, what is that?' });
    const second = controller.context.activeRunId!;
    await send({ type: 'run-text-delta', runId: second, text: 'That is the plan name. ' });

    await send({ type: 'submit-text', text: 'and that one?' });
    const third = controller.context.activeRunId!;
    expect(new Set([first, second, third]).size).toBe(3);

    await send({ type: 'run-text-delta', runId: third, text: 'That is the renewal date. ' });
    await send({ type: 'run-completed', runId: third, text: 'That is the renewal date.' });

    expect((agent as FakeAgentSession).interrupts).toEqual([
      { mode: 'abort', reason: 'superseded by a typed question' },
      { mode: 'abort', reason: 'superseded by a typed question' },
    ]);
    // Each superseded answer stopped where it was; only the live one continued.
    expect(spokenText(harness)).toEqual([
      'That is the toggle.',
      'That is the plan name.',
      'That is the renewal date.',
    ]);
    const before = { answers: answers(harness), spoken: spokenText(harness) };
    await send({ type: 'run-completed', runId: first, text: 'late one' });
    await send({ type: 'run-completed', runId: second, text: 'late two' });
    expectNoLateOutput(harness, before);
    await controller.dispose();
  });

  it('drops a question that a second interruption supersedes before it is submitted', async () => {
    const harness = createHarness();
    const { controller, agent } = harness;

    await harness.send({ type: 'select-window', windowId: WINDOW.windowId });
    // Both land in the same tick: the first question's submission is still
    // queued when the second replaces it.
    controller.send({ type: 'submit-text', text: 'what is this?' });
    const abandoned = controller.context.activeUtteranceId;
    controller.send({ type: 'submit-text', text: 'no wait, what is that?' });
    const live = controller.context.activeUtteranceId;
    await controller.settled();

    expect(abandoned).not.toBe(live);
    expect((agent as FakeAgentSession).submitted.map((envelope) => envelope.utteranceId)).toEqual([
      live,
    ]);
    expect(harness.cancellations).toEqual([
      { work: 'question', id: abandoned, reason: 'superseded', at: expect.any(Number) },
    ]);
    expect(controller.snapshot().lastError).toBeNull();
    await controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// The stalled run (runbook §8 follow-up 6)
// ---------------------------------------------------------------------------

describe('a run that stalls mid-sentence', () => {
  const PHRASE_TIMEOUT_MS = 1_000;

  it('says nothing without a scheduler — PR-026 behaviour, unchanged', async () => {
    const harness = createHarness({ phraseTimeoutMs: PHRASE_TIMEOUT_MS });
    const runId = await harness.ask('what is this?');
    await harness.send({ type: 'run-text-delta', runId, text: 'Checking the billing page' });

    harness.clock.advance(PHRASE_TIMEOUT_MS * 5);
    await harness.controller.settled();
    expect(spokenText(harness)).toEqual([]);
    expect(harness.controller.context.pendingAnswer).toBe('Checking the billing page');
    await harness.controller.dispose();
  });

  it('speaks the waiting fragment when the scheduler fires', async () => {
    const scheduler = new ManualScheduler();
    const harness = createHarness({ scheduler, phraseTimeoutMs: PHRASE_TIMEOUT_MS });
    const runId = await harness.ask('what is this?');
    await harness.send({ type: 'run-text-delta', runId, text: 'Checking the billing page' });

    expect(scheduler.pending).toBe(1);
    expect(scheduler.nextDelayMs).toBe(PHRASE_TIMEOUT_MS);

    // The model has gone quiet. Time passes on the injected clock, the
    // scheduler fires, and the fragment is spoken — with no further run event.
    harness.clock.advance(PHRASE_TIMEOUT_MS);
    expect(scheduler.fire()).toBe(1);
    await harness.controller.settled();

    expect(spokenText(harness)).toEqual(['Checking the billing page']);
    expect(harness.controller.context.pendingAnswer).toBe('');
    expect(harness.controller.snapshot().state).toBe('speaking');
    expect(harness.rejections).toEqual([]);
    await harness.controller.dispose();
  });

  it('discards a timer that fires after the fragment was already spoken', async () => {
    const scheduler = new ManualScheduler();
    const harness = createHarness({ scheduler, phraseTimeoutMs: PHRASE_TIMEOUT_MS });
    const runId = await harness.ask('what is this?');
    await harness.send({ type: 'run-text-delta', runId, text: 'Checking the billing page' });

    // The model finishes the sentence first; the armed timer is now about a
    // fragment that no longer exists.
    await harness.send({ type: 'run-text-delta', runId, text: ' and it is fine. ' });
    expect(spokenText(harness)).toEqual(['Checking the billing page and it is fine.']);

    harness.clock.advance(PHRASE_TIMEOUT_MS * 2);
    scheduler.fire();
    await harness.controller.settled();

    // Cancelled rather than delivered — and had it been delivered late anyway,
    // the machine's identity guard would have discarded it.
    expect(spokenText(harness)).toEqual(['Checking the billing page and it is fine.']);
    expect(harness.rejections).toEqual([]);

    const stale = harness.controller.send({ type: 'phrase-timeout', pendingSince: 1 });
    expect(stale.kind === 'rejected' && stale.rejection.reason).toBe('stale-phrase-timeout');
    expect(harness.controller.snapshot().lastError).toBeNull();
    await harness.controller.dispose();
  });

  it('cancels the wake-up when the answer is interrupted', async () => {
    const scheduler = new ManualScheduler();
    const harness = createHarness({ scheduler, phraseTimeoutMs: PHRASE_TIMEOUT_MS });
    const runId = await harness.ask('what is this?');
    await harness.send({ type: 'run-text-delta', runId, text: 'Checking the billing page' });
    expect(scheduler.pending).toBe(1);

    await harness.send({ type: 'interrupt' });
    expect(scheduler.pending).toBe(0);

    harness.clock.advance(PHRASE_TIMEOUT_MS * 2);
    expect(scheduler.fire()).toBe(0);
    expect(spokenText(harness)).toEqual([]);
    await harness.controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Contract guards
// ---------------------------------------------------------------------------

describe('cancellation is not failure', () => {
  it('never writes a cancelled submission or observation to lastError', async () => {
    const observation = new RecordingObservationPort({ manual: true });
    const harness = createHarness({ observation });
    const { controller, send } = harness;

    await send({ type: 'select-window', windowId: WINDOW.windowId });
    controller.send({ type: 'look-now' });
    await Promise.resolve();
    controller.send({ type: 'push-to-talk-down' });
    await controller.settled();

    expect(controller.snapshot().lastError).toBeNull();
    expect(controller.snapshot().state).toBe('listening');
    expect(harness.cancellations.map((record) => record.work)).toEqual(['observation']);
    await controller.dispose();
  });

  it('still reports a genuine adapter failure as an error', async () => {
    const observation = new (class extends RecordingObservationPort {
      override async observe(): Promise<void> {
        throw new PilotError('capture-failed', 'the capture failed');
      }
    })();
    const harness = createHarness({ observation });
    await harness.send({ type: 'select-window', windowId: WINDOW.windowId });
    await harness.send({ type: 'look-now' });

    expect(harness.controller.snapshot().state).toBe('error');
    expect(harness.controller.snapshot().lastError?.code).toBe('capture-failed');
    await harness.controller.dispose();
  });
});

describe('the speech chunk identifiers PR-014 must echo', () => {
  it('names every chunk after its stream', () => {
    expect(speechChunkId('speech-1' as SpeechId, 3)).toBe('speech-1#3');
  });
});
