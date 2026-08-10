import {
  asConversationId,
  asRunId,
  createCounterIdSource,
  createIdFactory,
  type InteractionState,
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
  type FakeClock,
} from '@pilot/platform/fakes';
import { PilotInteractionController } from './controller.js';
import { FakeQuestionEnvelopeFactory, RecordingObservationPort } from './fakes.js';
import { speechChunkId } from './speech-output-binding.js';
import type { VoiceDiagnostic } from './voice-diagnostics.js';

/**
 * The PR-026 demo: streamed answer text becoming ordered spoken chunks.
 *
 * `docs/implementation.md` asks for "stream awkward punctuation and hear
 * ordered fake speech chunks". Seven scenes, each one a case the PR has to get
 * right:
 *
 *  1. abbreviations, decimals and dotted identifiers that must not split;
 *  2. lists and newlines, which must;
 *  3. a stream that ends mid-sentence — the tail is spoken, never dropped;
 *  4. the phrase timeout releasing a clause the model left hanging;
 *  5. speech starting mid-run, and continuing across an `observe_screen` call;
 *  6. a late chunk from a superseded run, which is never spoken;
 *  7. a synthesiser reporting completion twice and out of order.
 *
 * Deterministic by construction: injected clock, counter identifiers, scripted
 * agent, scripted synthesiser. No wall clock, no timers, no I/O — `pnpm
 * demo:response` prints the same text everywhere and `test/demo-response.test.ts`
 * pins it.
 */

const CONVERSATION_ID = asConversationId('conv-response-demo');
const WINDOW = FIXTURE_WINDOW_RETINA;
const PHRASE_TIMEOUT_MS = 1_000;

export interface ResponseDemoChunk {
  readonly sequence: number;
  readonly text: string;
  readonly spoken: boolean;
}

export interface ResponseDemoScene {
  readonly name: string;
  readonly description: string;
  /** The deltas the agent streamed, in order, with the clock reading at each. */
  readonly deltas: readonly string[];
  /** What reached the synthesiser, in the order it reached it. */
  readonly chunks: readonly ResponseDemoChunk[];
  readonly path: readonly InteractionState[];
  readonly transcript: string;
  /** Answer text still waiting for a terminator when the scene ended. */
  readonly unspoken: string;
  readonly rejections: readonly string[];
  readonly diagnostics: readonly string[];
}

export interface ResponseDemoResult {
  readonly scenes: readonly ResponseDemoScene[];
  readonly lines: readonly string[];
}

interface Harness {
  readonly controller: PilotInteractionController;
  readonly clock: FakeClock;
  readonly speechOutput: FakeSpeechOutputAdapter;
  readonly agent: FakeAgentSession;
  readonly deltas: string[];
  readonly path: InteractionState[];
  readonly rejections: string[];
  readonly diagnostics: string[];
  /** Ask a typed question and return the run the agent gave it. */
  ask(text: string): Promise<RunId>;
  /** Stream one delta, optionally after letting the clock run. */
  say(runId: RunId, text: string, pauseMs?: number): Promise<void>;
  /** The agent finished the run. */
  done(runId: RunId, text?: string): Promise<void>;
  /** Let the synthesiser finish whatever it is saying. */
  play(times?: number): Promise<void>;
  send(input: Parameters<PilotInteractionController['send']>[0]): Promise<void>;
}

function describeDiagnostic(diagnostic: VoiceDiagnostic): string {
  switch (diagnostic.kind) {
    case 'discarded-event':
      return `discarded ${diagnostic.event} for ${diagnostic.utteranceId}: ${diagnostic.reason}`;
    case 'ignored-call':
      return `ignored ${diagnostic.call}() for ${diagnostic.utteranceId}: ${diagnostic.reason}`;
    case 'discarded-chunk':
      return `dropped chunk #${String(diagnostic.sequence)} (${String(
        diagnostic.characters,
      )} chars) of ${diagnostic.speechId}: ${diagnostic.reason}`;
    case 'discarded-speech-event':
      return `discarded ${diagnostic.event} for ${diagnostic.speechId}: ${diagnostic.reason}`;
    case 'ignored-speech-call':
      return `ignored ${diagnostic.call}() for ${diagnostic.speechId ?? '(any stream)'}: ${
        diagnostic.reason
      }`;
  }
}

function createHarness(): Harness {
  const clock = createFakeClock();
  const speechOutput = new FakeSpeechOutputAdapter();
  const agent = new FakeAgentSession({
    conversationId: CONVERSATION_ID,
    // Manual: the demo streams the deltas itself, one at a time, so it can put
    // the clock between them. `step()` would play a whole turn at once.
    mode: 'manual',
  });
  const controller = new PilotInteractionController({
    clock,
    ids: createIdFactory(createCounterIdSource()),
    conversationId: CONVERSATION_ID,
    speechInput: new FakeSpeechInputAdapter(),
    speechOutput,
    agent,
    envelopes: new FakeQuestionEnvelopeFactory(),
    observation: new RecordingObservationPort(),
    permissions: FIXTURE_PERMISSIONS_GRANTED,
    windows: FIXTURE_WINDOWS,
    phraseTimeoutMs: PHRASE_TIMEOUT_MS,
  });

  const deltas: string[] = [];
  const path: InteractionState[] = [controller.snapshot().state];
  const rejections: string[] = [];
  const diagnostics: string[] = [];

  controller.subscribe((view) => {
    if (view.state !== path[path.length - 1]) {
      path.push(view.state);
    }
  });
  controller.subscribeRejections((rejection) => {
    rejections.push(`${rejection.input} in ${rejection.from}: ${rejection.reason}`);
  });
  controller.subscribeVoiceDiagnostics((diagnostic) => {
    diagnostics.push(describeDiagnostic(diagnostic));
  });

  const send = async (input: Parameters<PilotInteractionController['send']>[0]): Promise<void> => {
    controller.send(input);
    await controller.settled();
  };

  return {
    controller,
    clock,
    speechOutput,
    agent,
    deltas,
    path,
    rejections,
    diagnostics,
    send,
    ask: async (text) => {
      await send({ type: 'select-window', windowId: WINDOW.windowId });
      await send({ type: 'submit-text', text });
      const runId = controller.context.activeRunId;
      if (runId === null) {
        throw new Error('demo expected the agent to have started a run');
      }
      return runId;
    },
    say: async (runId, text, pauseMs = 20) => {
      clock.advance(pauseMs);
      deltas.push(text);
      await send({ type: 'run-text-delta', runId, text });
    },
    done: async (runId, text = '') => {
      clock.advance(20);
      await send({ type: 'run-completed', runId, text });
    },
    play: async (times = 1) => {
      for (let index = 0; index < times; index += 1) {
        clock.advance(30);
        speechOutput.finish();
        await controller.settled();
      }
    },
  };
}

async function finish(
  harness: Harness,
  name: string,
  description: string,
): Promise<ResponseDemoScene> {
  await harness.controller.settled();
  const spokenIds = new Set(harness.speechOutput.spoken.map((request) => request.speechId));
  const scene: ResponseDemoScene = {
    name,
    description,
    deltas: [...harness.deltas],
    chunks: harness.speechOutput.spoken.map((request, index) => ({
      sequence: index,
      text: request.text,
      spoken: spokenIds.has(request.speechId),
    })),
    path: [...harness.path],
    transcript:
      harness.controller
        .snapshot()
        .transcript.filter((entry) => entry.role === 'assistant')
        .map((entry) => JSON.stringify(entry.text))
        .join(' | ') || '(nothing)',
    unspoken: harness.controller.context.pendingAnswer,
    rejections: [...harness.rejections],
    diagnostics: [...harness.diagnostics],
  };
  await harness.controller.dispose();
  return scene;
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/** 1. The punctuation that must *not* end a sentence. */
async function sceneAwkwardPunctuation(): Promise<ResponseDemoScene> {
  const harness = createHarness();
  const runId = await harness.ask('what did the doctor change?');
  await harness.say(runId, 'Dr. Chen set the timeout to 1.5 ');
  await harness.play();
  await harness.say(runId, 'seconds in config.json. ');
  await harness.play();
  await harness.say(runId, 'That is fine, e.g. for a ');
  await harness.say(runId, 'slow network. ');
  await harness.play();
  await harness.say(runId, 'Wait... let me check the ');
  await harness.say(runId, 'other file too.');
  await harness.done(runId);
  await harness.play(2);
  return finish(
    harness,
    'abbreviations, decimals and dotted identifiers',
    '"Dr.", "e.g.", "1.5", "config.json" and "Wait..." all stay inside their sentence.',
  );
}

/** 2. Newlines and list markers. */
async function sceneListsAndNewlines(): Promise<ResponseDemoScene> {
  const harness = createHarness();
  const runId = await harness.ask('how do I turn it off?');
  await harness.say(runId, 'Two things:\n');
  await harness.play();
  await harness.say(runId, '1. Open Billing.\n');
  await harness.play();
  await harness.say(runId, '2. Turn off Auto Renew.\n');
  await harness.done(runId);
  await harness.play(2);
  return finish(
    harness,
    'lists and newlines',
    'A newline ends a phrase; "1." and "2." are list markers, not sentence ends.',
  );
}

/** 3. The stream stops mid-sentence. §7 forbids losing the tail. */
async function sceneUnterminatedStream(): Promise<ResponseDemoScene> {
  const harness = createHarness();
  const runId = await harness.ask('what is this?');
  await harness.say(runId, 'It looks like the Auto Renew toggle');
  await harness.say(runId, ' but I cannot be certain');
  await harness.done(runId);
  await harness.play(2);
  return finish(
    harness,
    'a stream that never terminates',
    'No full stop, no newline, nothing: the tail is still spoken when the run ends.',
  );
}

/** 4. The phrase timeout: a clause the model left hanging. */
async function scenePhraseTimeout(): Promise<ResponseDemoScene> {
  const harness = createHarness();
  const runId = await harness.ask('what is happening?');
  await harness.say(runId, 'Checking the billing page');
  // The model stalls well past the phrase timeout and then carries on without
  // finishing the sentence. Without the timeout this fragment would keep
  // growing silently until a full stop finally arrived; with it, what has been
  // waiting is spoken now.
  await harness.say(runId, ' and the payment method', PHRASE_TIMEOUT_MS + 500);
  await harness.play();
  await harness.say(runId, ' — both are fine.');
  await harness.done(runId);
  await harness.play(2);
  return finish(
    harness,
    'the phrase timeout',
    `A fragment that has waited ${String(PHRASE_TIMEOUT_MS)} ms on the injected clock is spoken at the next delta instead of growing in silence.`,
  );
}

/** 5. Speech starts while the model is still working, and survives a tool call. */
async function sceneSpeechStartsMidRun(): Promise<ResponseDemoScene> {
  const harness = createHarness();
  const runId = await harness.ask('what is this?');
  await harness.say(runId, 'Let me look at your screen. ');
  await harness.send({
    type: 'tool-started',
    runId,
    toolCallId: 'tool-observe' as never,
    toolName: 'observe_screen',
  });
  await harness.play();
  await harness.send({
    type: 'tool-finished',
    runId,
    toolCallId: 'tool-observe' as never,
    toolName: 'observe_screen',
  });
  await harness.say(runId, 'The Auto Renew toggle is off.');
  await harness.done(runId);
  await harness.play(2);
  return finish(
    harness,
    'speech starts mid-run',
    'The first sentence is spoken while the model is still working, and keeps speaking across observe_screen.',
  );
}

/** 6. A superseded run cannot get a word in. */
async function sceneSupersededRun(): Promise<ResponseDemoScene> {
  const harness = createHarness();
  const first = await harness.ask('what is this?');
  // Two finished sentences, but the synthesiser is only speaking the first, so
  // the second is queued behind it.
  await harness.say(first, 'That is the Auto Renew toggle. ');
  await harness.say(first, 'It renews the plan each month. ');

  // A second question supersedes the first: speech stops, the run is aborted,
  // and the chunk still queued behind the sentence being spoken is dropped.
  await harness.send({ type: 'submit-text', text: 'no wait, what is that?' });
  const second = harness.controller.context.activeRunId ?? asRunId('run-missing');

  // The old run keeps talking anyway. None of it may be spoken.
  await harness.say(first, 'And one more thing. ');
  await harness.done(first, 'That is the Auto Renew toggle. It renews the plan each month.');

  await harness.say(second, 'That is the plan name. ');
  await harness.done(second);
  await harness.play(2);
  return finish(
    harness,
    'a superseded run is silenced',
    'Late text from the abandoned run is rejected by the machine; its queued chunk is dropped by the binding.',
  );
}

/** 7. A synthesiser that reports completion twice, and for the wrong chunk. */
async function sceneMisbehavingSynthesiser(): Promise<ResponseDemoScene> {
  const harness = createHarness();
  const runId = await harness.ask('what is this?');
  await harness.say(runId, 'That is the Auto Renew toggle. ');
  await harness.say(runId, 'It renews the plan each month. ');
  await harness.done(runId, '');

  const streamId = harness.controller.context.activeSpeechId ?? ('speech-missing' as SpeechId);
  const chunkZero = speechChunkId(streamId, 0);
  const chunkOne = speechChunkId(streamId, 1);

  // Out of order: chunk 1 reports completion while chunk 0 is still speaking.
  harness.speechOutput.emitFinished(chunkOne);
  await harness.controller.settled();
  // Twice: chunk 0 completes, and then completes again.
  harness.speechOutput.emitFinished(chunkZero);
  await harness.controller.settled();
  harness.speechOutput.emitFinished(chunkZero);
  await harness.controller.settled();
  // The real completion of the last chunk is what ends the turn.
  harness.speechOutput.emitFinished(chunkOne);
  await harness.controller.settled();

  return finish(
    harness,
    'a synthesiser that repeats itself',
    'Per-chunk completions never end the turn; only the last chunk of a closed stream does, and only once.',
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function describeScene(scene: ResponseDemoScene, index: number): readonly string[] {
  const lines = [
    `## ${String(index + 1)}. ${scene.name}`,
    `   ${scene.description}`,
    '',
    '   streamed',
  ];
  for (const delta of scene.deltas) {
    lines.push(`     | ${JSON.stringify(delta)}`);
  }
  lines.push('', '   spoken, in order');
  if (scene.chunks.length === 0) {
    lines.push('     (nothing)');
  }
  for (const chunk of scene.chunks) {
    lines.push(`     ${String(chunk.sequence)}. "${chunk.text}"`);
  }
  lines.push(
    '',
    `   state path          ${scene.path.join(' -> ')}`,
    `   panel transcript    ${scene.transcript}`,
    `   still unspoken      ${scene.unspoken === '' ? '(nothing)' : `"${scene.unspoken}"`}`,
  );
  lines.push(
    scene.diagnostics.length === 0
      ? '   binding discarded   (nothing)'
      : '   binding discarded   ' + scene.diagnostics.join('\n                       '),
  );
  lines.push(
    scene.rejections.length === 0
      ? '   machine rejected    (nothing)'
      : '   machine rejected    ' + scene.rejections.join('\n                       '),
  );
  return lines;
}

export async function runResponseDemo(): Promise<ResponseDemoResult> {
  const scenes = [
    await sceneAwkwardPunctuation(),
    await sceneListsAndNewlines(),
    await sceneUnterminatedStream(),
    await scenePhraseTimeout(),
    await sceneSpeechStartsMidRun(),
    await sceneSupersededRun(),
    await sceneMisbehavingSynthesiser(),
  ];

  const lines = [
    'Pilot — PR-026 response and TTS buffer demo (agent and synthesiser are fakes)',
    `Injected clock, counter identifiers, phrase timeout ${String(PHRASE_TIMEOUT_MS)} ms: no wall clock, no timers, no I/O.`,
    '',
    ...scenes.flatMap((scene, index) => [...describeScene(scene, index), '']),
    'Every answer is spoken in stream order, one chunk at a time, under one',
    'speech identifier. Nothing that belongs to a superseded run reaches the',
    'synthesiser, and nothing a stream produced is left unspoken when it ends.',
  ];

  return { scenes, lines };
}
