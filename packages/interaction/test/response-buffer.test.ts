import { describe, expect, it } from 'vitest';
import {
  asConversationId,
  asRunId,
  asToolCallId,
  createCounterIdSource,
  createIdFactory,
  type RunId,
  type SpeechId,
} from '@pilot/shared';
import {
  FIXTURE_PERMISSIONS_GRANTED,
  FIXTURE_WINDOWS,
  FIXTURE_WINDOW_RETINA,
  FakeAgentSession,
  FakeSpeechInputAdapter,
  FakeSpeechOutputAdapter,
  createFakeClock,
} from '@pilot/platform/fakes';
import {
  FakeQuestionEnvelopeFactory,
  PilotInteractionController,
  RecordingObservationPort,
  speechChunkId,
  type VoiceDiagnostic,
} from '@pilot/interaction';

/**
 * PR-026 — the response and TTS buffer, driven through the public controller.
 *
 * `docs/implementation.md` names the cases: abbreviations and decimals that
 * must not split a sentence early, a stream that ends without terminal
 * punctuation, a synthesiser reporting completion out of order or twice, a late
 * chunk from a superseded run, and speech starting mid-run. Every one is a test
 * here, with no adapter stubbed out of the path.
 */

const WINDOW = FIXTURE_WINDOW_RETINA;
const PHRASE_TIMEOUT_MS = 1_000;
const TOOL_CALL = asToolCallId('tool-observe');

function createHarness() {
  const clock = createFakeClock();
  const conversationId = asConversationId('conv-response');
  const speechOutput = new FakeSpeechOutputAdapter();
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
    phraseTimeoutMs: PHRASE_TIMEOUT_MS,
  });

  const diagnostics: VoiceDiagnostic[] = [];
  controller.subscribeVoiceDiagnostics((diagnostic) => diagnostics.push(diagnostic));
  const rejections: string[] = [];
  controller.subscribeRejections((rejection) => rejections.push(rejection.reason));
  const states: string[] = [controller.snapshot().state];
  controller.subscribe((view) => {
    if (states[states.length - 1] !== view.state) {
      states.push(view.state);
    }
  });

  const settle = async (): Promise<void> => {
    await controller.settled();
  };

  return {
    controller,
    clock,
    speechOutput,
    agent,
    diagnostics,
    rejections,
    states,
    /** Ask a typed question and return the run identifier the agent minted. */
    ask: async (text = 'what is this?'): Promise<RunId> => {
      controller.dispatch({ type: 'select-window', windowId: WINDOW.windowId });
      controller.dispatch({ type: 'submit-text', text });
      await settle();
      const runId = controller.context.activeRunId;
      expect(runId).not.toBeNull();
      return runId!;
    },
    say: async (runId: RunId, text: string, pauseMs = 10): Promise<void> => {
      clock.advance(pauseMs);
      controller.send({ type: 'run-text-delta', runId, text });
      await settle();
    },
    done: async (runId: RunId, text = ''): Promise<void> => {
      controller.send({ type: 'run-completed', runId, text });
      await settle();
    },
    play: async (times = 1): Promise<void> => {
      for (let index = 0; index < times; index += 1) {
        speechOutput.finish();
        await settle();
      }
    },
    spokenChunks: (): readonly string[] => speechOutput.spoken.map((request) => request.text),
    settle,
  };
}

describe('streamed answers become ordered speech chunks', () => {
  it('speaks one sentence at a time, in order, while the run is still going', async () => {
    const harness = createHarness();
    const runId = await harness.ask();

    await harness.say(runId, 'That is the Auto Renew toggle. ');
    expect(harness.spokenChunks()).toEqual(['That is the Auto Renew toggle.']);
    // The first spoken sentence is what moves the machine into `speaking`,
    // long before the run completes (mvp-01 §7).
    expect(harness.controller.snapshot().state).toBe('speaking');
    expect(harness.controller.context.activeRunId).toBe(runId);

    await harness.say(runId, 'It renews the plan each month. ');
    // Still one chunk with the synthesiser; the second is queued behind it.
    expect(harness.spokenChunks()).toEqual(['That is the Auto Renew toggle.']);
    expect(harness.controller.pendingSpeechChunks).toBe(1);

    await harness.play();
    expect(harness.spokenChunks()).toEqual([
      'That is the Auto Renew toggle.',
      'It renews the plan each month.',
    ]);
    await harness.controller.dispose();
  });

  it('gives every chunk of one answer the same speech identifier', async () => {
    const harness = createHarness();
    const runId = await harness.ask();
    await harness.say(runId, 'One. Two. ');
    await harness.play();
    await harness.done(runId);

    const streamId = harness.controller.context.activeSpeechId;
    expect(streamId).not.toBeNull();
    expect(harness.speechOutput.spoken.map((request) => request.speechId)).toEqual([
      speechChunkId(streamId!, 0),
      speechChunkId(streamId!, 1),
    ]);
    await harness.controller.dispose();
  });

  it('does not split on an abbreviation or a decimal', async () => {
    const harness = createHarness();
    const runId = await harness.ask();
    await harness.say(runId, 'Dr. Chen set it to 1.5 ');
    await harness.say(runId, 'seconds in config.json. ');

    expect(harness.spokenChunks()).toEqual(['Dr. Chen set it to 1.5 seconds in config.json.']);
    await harness.controller.dispose();
  });

  it('speaks the tail of a stream that never terminates', async () => {
    const harness = createHarness();
    const runId = await harness.ask();
    await harness.say(runId, 'It looks like the Auto Renew toggle');
    await harness.say(runId, ' but I cannot be certain');
    // Nothing is speakable yet: no full stop, no newline.
    expect(harness.spokenChunks()).toEqual([]);
    expect(harness.controller.context.pendingAnswer).toBe(
      'It looks like the Auto Renew toggle but I cannot be certain',
    );

    await harness.done(runId);
    expect(harness.spokenChunks()).toEqual([
      'It looks like the Auto Renew toggle but I cannot be certain',
    ]);
    expect(harness.controller.context.pendingAnswer).toBe('');
    await harness.controller.dispose();
  });

  it('releases a fragment that has waited out the phrase timeout', async () => {
    const harness = createHarness();
    const runId = await harness.ask();
    await harness.say(runId, 'Checking the billing page');
    expect(harness.spokenChunks()).toEqual([]);

    // Still inside the timeout: the fragment keeps growing silently.
    await harness.say(runId, ' and the payment', PHRASE_TIMEOUT_MS - 1);
    expect(harness.spokenChunks()).toEqual([]);

    // Past it: what has been waiting is spoken at the next delta.
    await harness.say(runId, ' method', 2);
    expect(harness.spokenChunks()).toEqual(['Checking the billing page and the payment method']);
    await harness.controller.dispose();
  });

  it('leaves nothing unspoken when the answer arrives only at completion', async () => {
    const harness = createHarness();
    const runId = await harness.ask();
    // A provider that does not stream: no deltas at all.
    await harness.done(runId, 'It is off.');
    expect(harness.spokenChunks()).toEqual(['It is off.']);
    expect(harness.controller.snapshot().state).toBe('speaking');
    await harness.controller.dispose();
  });

  it('says nothing at all when the model produced nothing', async () => {
    const harness = createHarness();
    const runId = await harness.ask();
    await harness.done(runId, '');
    expect(harness.spokenChunks()).toEqual([]);
    expect(harness.controller.snapshot().state).toBe('observing');
    await harness.controller.dispose();
  });
});

describe('speech completion belongs to the answer, not the chunk', () => {
  it('ends the turn only when the last chunk of a closed stream finishes', async () => {
    const harness = createHarness();
    const runId = await harness.ask();
    await harness.say(runId, 'One. Two. ');
    await harness.done(runId);

    await harness.play();
    // The first chunk finished; the answer has not.
    expect(harness.controller.snapshot().state).toBe('speaking');

    await harness.play();
    expect(harness.controller.snapshot().state).toBe('observing');
    expect(harness.controller.context.activeSpeechId).toBeNull();
    await harness.controller.dispose();
  });

  it('survives a synthesiser that reports completion out of order and twice', async () => {
    const harness = createHarness();
    const runId = await harness.ask();
    await harness.say(runId, 'One. Two. ');
    await harness.done(runId);

    const streamId = harness.controller.context.activeSpeechId as SpeechId;
    // The last chunk claims to be done while the first is still speaking.
    harness.speechOutput.emitFinished(speechChunkId(streamId, 1));
    await harness.settle();
    expect(harness.controller.snapshot().state).toBe('speaking');

    harness.speechOutput.emitFinished(speechChunkId(streamId, 0));
    await harness.settle();
    harness.speechOutput.emitFinished(speechChunkId(streamId, 0));
    await harness.settle();
    expect(harness.controller.snapshot().state).toBe('speaking');

    harness.speechOutput.emitFinished(speechChunkId(streamId, 1));
    await harness.settle();
    expect(harness.controller.snapshot().state).toBe('observing');
    // Exactly two utterances reached the synthesiser, in order.
    expect(harness.spokenChunks()).toEqual(['One.', 'Two.']);
    expect(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === 'discarded-speech-event'),
    ).toHaveLength(2);
    await harness.controller.dispose();
  });
});

describe('a superseded run cannot be heard', () => {
  it('rejects its text and drops the chunk it had already queued', async () => {
    const harness = createHarness();
    const first = await harness.ask();
    await harness.say(first, 'That is the Auto Renew toggle. ');
    await harness.say(first, 'It renews the plan each month. ');
    expect(harness.controller.pendingSpeechChunks).toBe(1);

    harness.controller.dispatch({ type: 'submit-text', text: 'no wait, what is that?' });
    await harness.settle();
    expect(harness.controller.pendingSpeechChunks).toBe(0);
    expect(
      harness.diagnostics.some(
        (diagnostic) => diagnostic.kind === 'discarded-chunk' && diagnostic.reason === 'stopped',
      ),
    ).toBe(true);

    const spokenBefore = harness.spokenChunks();
    const late = harness.controller.send({
      type: 'run-text-delta',
      runId: first,
      text: 'And one more thing. ',
    });
    await harness.settle();
    expect(late.kind === 'rejected' && late.rejection.reason).toBe('stale-run');
    expect(harness.spokenChunks()).toEqual(spokenBefore);
    await harness.controller.dispose();
  });

  it('ignores a chunk for a run identifier that was never active', async () => {
    const harness = createHarness();
    await harness.ask();
    const outcome = harness.controller.send({
      type: 'run-text-delta',
      runId: asRunId('run-ghost'),
      text: 'Never spoken. ',
    });
    await harness.settle();
    expect(outcome.kind === 'rejected' && outcome.rejection.reason).toBe('stale-run');
    expect(harness.spokenChunks()).toEqual([]);
    await harness.controller.dispose();
  });
});

describe('speech runs alongside the rest of the turn', () => {
  it('keeps speaking across an observe_screen call', async () => {
    const harness = createHarness();
    const runId = await harness.ask();
    await harness.say(runId, 'Let me look at your screen. ');
    expect(harness.controller.snapshot().state).toBe('speaking');

    harness.controller.send({
      type: 'tool-started',
      runId,
      toolCallId: TOOL_CALL,
      toolName: 'observe_screen',
    });
    await harness.settle();
    expect(harness.controller.snapshot().state).toBe('observing-screen');
    // The speech stream is untouched by the tool call.
    expect(harness.controller.liveSpeechId).toBe(harness.controller.context.activeSpeechId);

    await harness.play();
    // Finishing a chunk mid-run does not end the turn.
    expect(harness.controller.snapshot().state).toBe('observing-screen');

    harness.controller.send({
      type: 'tool-finished',
      runId,
      toolCallId: TOOL_CALL,
      toolName: 'observe_screen',
    });
    await harness.settle();
    await harness.say(runId, 'The toggle is off.');
    await harness.done(runId);
    await harness.play(2);

    expect(harness.spokenChunks()).toEqual(['Let me look at your screen.', 'The toggle is off.']);
    expect(harness.states).toEqual([
      'idle',
      'observing',
      'thinking',
      'speaking',
      'observing-screen',
      'thinking',
      'observing',
    ]);
    await harness.controller.dispose();
  });

  it('releases a fragment stranded behind a slow tool call', async () => {
    const harness = createHarness();
    const runId = await harness.ask();
    await harness.say(runId, 'Let me check');
    expect(harness.spokenChunks()).toEqual([]);

    harness.clock.advance(PHRASE_TIMEOUT_MS + 1);
    harness.controller.send({
      type: 'tool-started',
      runId,
      toolCallId: TOOL_CALL,
      toolName: 'observe_screen',
    });
    await harness.settle();

    expect(harness.spokenChunks()).toEqual(['Let me check']);
    await harness.controller.dispose();
  });

  it('reports a synthesiser failure as a recoverable error', async () => {
    const harness = createHarness();
    const runId = await harness.ask();
    await harness.say(runId, 'That is the toggle. ');
    const streamId = harness.controller.context.activeSpeechId as SpeechId;

    harness.speechOutput.emitError(speechChunkId(streamId, 0), 'the voice went away');
    await harness.settle();

    expect(harness.controller.snapshot().state).toBe('error');
    expect(harness.controller.snapshot().lastError?.code).toBe('speech-output-failed');
    await harness.controller.dispose();
  });
});
