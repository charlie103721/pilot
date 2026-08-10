import {
  asConversationId,
  createCounterIdSource,
  createIdFactory,
  type InteractionState,
  type RunId,
} from '@pilot/shared';
import {
  FIXTURE_PERMISSIONS_GRANTED,
  FIXTURE_WINDOWS,
  FIXTURE_WINDOW_RETINA,
  FakeSpeechInputAdapter,
  FakeSpeechOutputAdapter,
  createFakeClock,
  type FakeClock,
} from '@pilot/platform/fakes';
import { PilotInteractionController } from './controller.js';
import {
  FakeQuestionEnvelopeFactory,
  InterruptibleAgentSession,
  ManualScheduler,
  RecordingObservationPort,
} from './fakes.js';
import type { InteractionInput } from './inputs.js';
import type { VoiceDiagnostic } from './voice-diagnostics.js';

/**
 * The PR-027 demo: interruption and cancellation, end to end.
 *
 * `docs/implementation.md` asks for "interrupt during thinking and speaking
 * without late output resurfacing". Eight scenes, each one a case interruption
 * has to survive:
 *
 *  1. interrupted while thinking — the abandoned answer stops mid-stream;
 *  2. interrupted while speaking — the sentence queued behind the one being
 *     spoken is dropped, not deferred;
 *  3. interrupted during `observe_screen` — aborted, which is what makes the
 *     capture unwind and lets the replacement question start (PR-035; this
 *     scene said "steered" until then, and runbook §8 follow-up 14 is why it
 *     no longer does);
 *  4. the abandoned run finishes anyway, and its answer goes nowhere;
 *  5. two interruptions in quick succession;
 *  6. interrupted between the answer and its first spoken word;
 *  7. interrupted while the question was still being submitted — the
 *     cross-process cancellation, where there is no run id to name yet;
 *  8. a run that stalls mid-sentence, with and without a scheduler.
 *
 * Every scene prints the four places late output could resurface and does not:
 * the panel transcript, the synthesiser, the machine's rejections, and the
 * binding's discards.
 *
 * Deterministic by construction: injected clock, counter identifiers, scripted
 * agent, scripted synthesiser, manual scheduler. No wall clock, no timers, no
 * I/O — `pnpm demo:interrupt` prints the same text everywhere and
 * `test/demo-interrupt.test.ts` pins it.
 */

const CONVERSATION_ID = asConversationId('conv-interrupt-demo');
const WINDOW = FIXTURE_WINDOW_RETINA;
const PHRASE_TIMEOUT_MS = 1_000;

export interface InterruptDemoScene {
  readonly name: string;
  readonly description: string;
  /** What happened, in order, in the language of the product. */
  readonly timeline: readonly string[];
  /** Text that actually reached the synthesiser, in the order it reached it. */
  readonly spoken: readonly string[];
  readonly path: readonly InteractionState[];
  readonly transcript: readonly string[];
  /** How the agent run was stopped: `abort` or `steer`. */
  readonly interrupts: readonly string[];
  readonly rejections: readonly string[];
  readonly discards: readonly string[];
  readonly cancellations: readonly string[];
  readonly lastError: string;
}

export interface InterruptDemoResult {
  readonly scenes: readonly InterruptDemoScene[];
  readonly lines: readonly string[];
}

interface Harness {
  readonly controller: PilotInteractionController;
  readonly clock: FakeClock;
  readonly agent: InterruptibleAgentSession;
  readonly speechOutput: FakeSpeechOutputAdapter;
  readonly observation: RecordingObservationPort;
  readonly scheduler: ManualScheduler;
  readonly timeline: string[];
  readonly path: InteractionState[];
  readonly rejections: string[];
  readonly discards: string[];
  readonly cancellations: string[];
  note(line: string): void;
  send(input: InteractionInput): Promise<void>;
  /** Select the window (once) and ask a typed question. */
  ask(text: string): Promise<RunId>;
  /** Stream one delta after letting the clock run. */
  say(text: string, pauseMs?: number): Promise<void>;
  /** Let the synthesiser finish whatever it is saying. */
  play(times?: number): Promise<void>;
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

interface HarnessOptions {
  /** Wake the phrase timeout up (scene 8). Off everywhere else, as in the app today. */
  readonly scheduled?: boolean;
  readonly manualObservation?: boolean;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const clock = createFakeClock();
  const scheduler = new ManualScheduler();
  const speechOutput = new FakeSpeechOutputAdapter();
  const observation = new RecordingObservationPort(
    options.manualObservation === true ? { manual: true } : {},
  );
  const agent = new InterruptibleAgentSession({ conversationId: CONVERSATION_ID });
  const controller = new PilotInteractionController({
    clock,
    ids: createIdFactory(createCounterIdSource()),
    conversationId: CONVERSATION_ID,
    speechInput: new FakeSpeechInputAdapter(),
    speechOutput,
    agent,
    envelopes: new FakeQuestionEnvelopeFactory(),
    observation,
    permissions: FIXTURE_PERMISSIONS_GRANTED,
    windows: FIXTURE_WINDOWS,
    phraseTimeoutMs: PHRASE_TIMEOUT_MS,
    ...(options.scheduled === true ? { scheduler } : {}),
  });

  const timeline: string[] = [];
  const path: InteractionState[] = [controller.snapshot().state];
  const rejections: string[] = [];
  const discards: string[] = [];
  const cancellations: string[] = [];

  controller.subscribe((view) => {
    if (view.state !== path[path.length - 1]) {
      path.push(view.state);
    }
  });
  controller.subscribeRejections((rejection) => {
    rejections.push(`${rejection.input} in ${rejection.from}: ${rejection.reason}`);
  });
  controller.subscribeVoiceDiagnostics((diagnostic) => {
    discards.push(describeDiagnostic(diagnostic));
  });
  controller.subscribeCancellations((record) => {
    cancellations.push(`${record.work} ${record.id}: ${record.reason}`);
  });

  const send = async (input: InteractionInput): Promise<void> => {
    controller.send(input);
    await controller.settled();
  };

  return {
    controller,
    clock,
    agent,
    speechOutput,
    observation,
    scheduler,
    timeline,
    path,
    rejections,
    discards,
    cancellations,
    note: (line) => timeline.push(line),
    send,
    ask: async (text) => {
      if (controller.context.selectedWindow === null) {
        await send({ type: 'select-window', windowId: WINDOW.windowId });
      }
      timeline.push(`user asks: "${text}"`);
      await send({ type: 'submit-text', text });
      const runId = controller.context.activeRunId;
      if (runId === null) {
        throw new Error('demo expected the agent to have started a run');
      }
      return runId;
    },
    say: async (text, pauseMs = 20) => {
      clock.advance(pauseMs);
      agent.stream(text);
      await controller.settled();
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
): Promise<InterruptDemoScene> {
  await harness.controller.settled();
  const view = harness.controller.snapshot();
  const scene: InterruptDemoScene = {
    name,
    description,
    timeline: [...harness.timeline],
    spoken: harness.speechOutput.spoken.map((request) => request.text),
    path: [...harness.path],
    transcript: view.transcript.map(
      (entry) => `${entry.role}: ${JSON.stringify(entry.text)}${entry.pending ? ' (pending)' : ''}`,
    ),
    interrupts: harness.agent.interrupts.map((interrupt) => interrupt.mode),
    rejections: [...harness.rejections],
    discards: [...harness.discards],
    cancellations: [...harness.cancellations],
    lastError: view.lastError === null ? '(none)' : view.lastError.code,
  };
  await harness.controller.dispose();
  return scene;
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/** 1. A new question arrives while the model is still answering the last one. */
async function sceneInterruptThinking(): Promise<InterruptDemoScene> {
  const harness = createHarness();
  await harness.ask('what is this?');
  await harness.say('That is the Auto Renew toggle. ');
  await harness.play();
  harness.note('user presses push-to-talk again, mid-answer');
  await harness.send({ type: 'push-to-talk-down' });
  harness.note(`the run was told to stop: ${harness.agent.interrupts.map((i) => i.mode).join()}`);

  harness.note('the abandoned run keeps talking');
  harness.agent.lateDelta('It renews the plan every month. ');
  harness.agent.lateComplete('That is the Auto Renew toggle. It renews the plan every month.');
  await harness.controller.settled();

  await harness.send({ type: 'push-to-talk-up' });
  await harness.controller.settled();
  return finish(
    harness,
    'interrupted while thinking',
    'A new push-to-talk stops speech and aborts the run; everything the old run says afterwards is discarded.',
  );
}

/** 2. Interrupted while speaking, with the next sentence already queued. */
async function sceneInterruptSpeaking(): Promise<InterruptDemoScene> {
  const harness = createHarness();
  await harness.ask('what is this?');
  await harness.say('That is the Auto Renew toggle. ');
  await harness.say('It renews the plan every month. ');
  harness.note(
    `sentence 1 is being spoken, sentence 2 is queued (${String(
      harness.controller.pendingSpeechChunks,
    )} chunk waiting)`,
  );

  harness.note('user asks something else');
  await harness.send({ type: 'submit-text', text: 'no wait, what is that?' });
  harness.note(
    `queued chunks after the interruption: ${String(harness.controller.pendingSpeechChunks)}`,
  );
  await harness.say('That is the plan name. ');
  await harness.play(2);
  return finish(
    harness,
    'interrupted while speaking',
    'The sentence queued behind the one being spoken is dropped, not spoken after the interruption.',
  );
}

/**
 * 3. system-design §15: a capture in flight, stopped.
 *
 * PR-006 chose `steer` for this state so the tool call could unwind rather than
 * be cut in half, and this scene printed `steer` until PR-035 decided otherwise
 * (runbook §8 follow-up 14). What `abort` buys is visible in the scene itself:
 * the run's `AbortSignal` fires, which is the signal `observe_screen` checks
 * before its capture, passes to `ScreenContextService.observe` and uses to
 * discard a result that arrives late — so the capture unwinds *and* the run
 * ends, which is what lets a replacement question start.
 */
async function sceneInterruptObservation(): Promise<InterruptDemoScene> {
  const harness = createHarness();
  await harness.ask('what is this?');
  await harness.say('Let me look at your screen. ');
  await harness.play();
  harness.agent.startTool('observe_screen');
  await harness.controller.settled();
  harness.note('the model called observe_screen; the capture is in flight');

  harness.note('user presses Stop');
  await harness.send({ type: 'interrupt' });
  harness.note(
    `mode: ${harness.agent.interrupts.map((i) => i.mode).join()} — the run's abort signal fired ` +
      `(${harness.agent.runAborted ? 'aborted' : 'not aborted'}), which is what observe_screen ` +
      `checks before it captures and what discards a frame that lands afterwards`,
  );

  harness.note('whatever the aborted run says next is still discarded');
  harness.agent.lateDelta('The Auto Renew toggle is off.');
  await harness.controller.settled();
  return finish(
    harness,
    'interrupted during a screen observation',
    'The run is aborted: the tool’s signal fires, the capture unwinds into a `cancelled` refusal, and no run is left holding the conversation.',
  );
}

/** 4. The provider had already written the rest of the answer. */
async function sceneLateCompletion(): Promise<InterruptDemoScene> {
  const harness = createHarness();
  await harness.ask('what is this?');
  await harness.say('That is the Auto Renew toggle. ');
  await harness.play();
  harness.note('user presses Stop');
  await harness.send({ type: 'interrupt' });

  harness.note('the aborted run completes anyway — its answer was already in flight');
  harness.agent.lateComplete('That is the Auto Renew toggle. It renews the plan every month.');
  await harness.controller.settled();
  await harness.play();
  return finish(
    harness,
    'a run that completes after being aborted',
    'The completion is discarded as `stale-run`: no transcript entry, no speech, no state change.',
  );
}

/** 5. Three questions, two interruptions, one answer. */
async function sceneQuickSuccession(): Promise<InterruptDemoScene> {
  const harness = createHarness();
  await harness.ask('what is this?');
  await harness.say('That is the Auto Renew toggle. ');
  harness.note('interruption 1: a new question while the first answer is being spoken');
  await harness.send({ type: 'submit-text', text: 'no wait, what is that?' });
  await harness.say('That is the plan name. ');
  harness.note('interruption 2: another one, before the second answer finished either');
  await harness.send({ type: 'submit-text', text: 'and that one?' });
  await harness.say('That is the renewal date. ');
  harness.note('each abort named the run it was for; neither reached the run that replaced it');
  await harness.send({
    type: 'run-completed',
    runId: harness.controller.context.activeRunId!,
    text: 'That is the renewal date.',
  });
  await harness.play(2);
  return finish(
    harness,
    'two interruptions in quick succession',
    'Each superseded answer stops where it was; only the live one is spoken to the end.',
  );
}

/** 6. The window between `run-completed` and the first `speech-started`. */
async function sceneInterruptBeforeFirstWord(): Promise<InterruptDemoScene> {
  const harness = createHarness();
  const runId = await harness.ask('what is this?');
  harness.note('the whole answer arrives at once, unterminated');
  harness.agent.stream('It looks like the Auto Renew toggle');
  harness.controller.send({ type: 'run-completed', runId, text: '' });
  harness.note(
    `the answer has a speech id (${
      harness.controller.context.activeSpeechId ?? '(none)'
    }) but not a spoken word yet`,
  );
  // Same tick: the user interrupts before the chunk has reached the synthesiser.
  harness.controller.send({ type: 'interrupt' });
  await harness.controller.settled();
  return finish(
    harness,
    'interrupted between the answer and its first word',
    'The stream had an identifier and a queued chunk but had never started; nothing is spoken, then or later.',
  );
}

/** 7. Interrupted before the agent had a run to interrupt. */
async function sceneInterruptDuringSubmission(): Promise<InterruptDemoScene> {
  const harness = createHarness();
  await harness.send({ type: 'select-window', windowId: WINDOW.windowId });
  harness.note('user asks a question and changes their mind in the same breath');
  harness.controller.send({ type: 'submit-text', text: 'what is this?' });
  harness.controller.send({ type: 'interrupt' });
  await harness.controller.settled();
  harness.note(
    `questions that reached the agent: ${String(harness.agent.submitted.length)} — there was no ` +
      `run id to interrupt, so the submission's own abort signal stopped it`,
  );

  harness.note('and the next question submits cleanly, because no run was left holding the slot');
  await harness.ask('what is that?');
  await harness.say('That is the plan name. ');
  await harness.play();
  return finish(
    harness,
    'interrupted while the question was still being submitted',
    'The window where `interrupt()` has no run to name is covered by the AbortSignal passed to `submit()`.',
  );
}

/** 8. The stalled run — runbook §8 follow-up 6. */
async function sceneStalledRun(): Promise<InterruptDemoScene> {
  const harness = createHarness({ scheduled: true });
  await harness.ask('what is happening?');
  await harness.say('Checking the billing page');
  harness.note(
    `the model has gone quiet mid-sentence; a wake-up is armed for ${String(
      harness.scheduler.nextDelayMs,
    )} ms`,
  );

  harness.note(`nothing further arrives from the model for ${String(PHRASE_TIMEOUT_MS)} ms`);
  harness.clock.advance(PHRASE_TIMEOUT_MS);
  harness.scheduler.fire();
  await harness.controller.settled();
  harness.note('the waiting fragment is spoken without any run event at all');
  await harness.play();

  harness.note('the model comes back and finishes the answer');
  await harness.say(' and the payment method — both are fine.');
  await harness.send({
    type: 'run-completed',
    runId: harness.controller.context.activeRunId!,
    text: 'Checking the billing page and the payment method — both are fine.',
  });
  await harness.play(2);
  return finish(
    harness,
    'a run that stalls mid-sentence',
    `With an injected scheduler the fragment is released after ${String(PHRASE_TIMEOUT_MS)} ms; without one it waits for the next run event, as in PR-026.`,
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function block(label: string, values: readonly string[], empty = '(nothing)'): readonly string[] {
  if (values.length === 0) {
    return [`   ${label.padEnd(20)}${empty}`];
  }
  const [first, ...rest] = values;
  return [
    `   ${label.padEnd(20)}${first ?? empty}`,
    ...rest.map((value) => `   ${''.padEnd(20)}${value}`),
  ];
}

function describeScene(scene: InterruptDemoScene, index: number): readonly string[] {
  return [
    `## ${String(index + 1)}. ${scene.name}`,
    `   ${scene.description}`,
    '',
    ...block('what happened', scene.timeline),
    '',
    ...block('spoken aloud', scene.spoken),
    ...block('panel transcript', scene.transcript),
    ...block('state path', [scene.path.join(' -> ')]),
    ...block('run interrupted by', scene.interrupts),
    ...block('machine rejected', scene.rejections),
    ...block('binding discarded', scene.discards),
    ...block('work cancelled', scene.cancellations),
    ...block('user-visible error', [scene.lastError]),
  ];
}

export async function runInterruptDemo(): Promise<InterruptDemoResult> {
  const scenes = [
    await sceneInterruptThinking(),
    await sceneInterruptSpeaking(),
    await sceneInterruptObservation(),
    await sceneLateCompletion(),
    await sceneQuickSuccession(),
    await sceneInterruptBeforeFirstWord(),
    await sceneInterruptDuringSubmission(),
    await sceneStalledRun(),
  ];

  const lines = [
    'Pilot — PR-027 interruption and cancellation demo (agent and synthesiser are fakes)',
    'Injected clock, counter identifiers, manual scheduler: no wall clock, no timers, no I/O.',
    '',
    ...scenes.flatMap((scene, index) => [...describeScene(scene, index), '']),
    'Nothing a superseded run produced after the interruption reaches the panel',
    'transcript or the synthesiser. What the transcript keeps is what had already',
    'been said before it — that is history, not late output, and nothing is ever',
    'appended to it afterwards.',
    '',
    'Every discard is accounted for — as a machine rejection, a binding',
    'diagnostic, or a cancellation — and none of them is an error the user has',
    'to deal with.',
  ];

  return { scenes, lines };
}
