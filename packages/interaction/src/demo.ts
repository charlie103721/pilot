import {
  asConversationId,
  createCounterIdSource,
  createIdFactory,
  type RunId,
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
import { PilotInteractionController } from './controller.js';
import { FakeQuestionEnvelopeFactory, RecordingObservationPort } from './fakes.js';
import type { InteractionInput } from './inputs.js';

/**
 * The PR-006 demo: one deterministic conversation, driven entirely by fakes.
 *
 * idle → observing → listening → transcribing → thinking → observing-screen →
 * thinking → speaking → *interrupted* → listening → thinking → *interrupted* →
 * observing → idle, with late events from both superseded runs proved to be
 * discarded.
 *
 * Run it with `pnpm demo:interaction` from the repository root.
 */

export interface DemoStep {
  readonly n: number;
  readonly action: string;
  readonly state: string;
  readonly detail: string;
}

export interface DemoResult {
  readonly steps: readonly DemoStep[];
  readonly states: readonly string[];
  /** Every state the machine passed through, consecutive duplicates removed. */
  readonly path: readonly string[];
  readonly rejections: readonly string[];
  readonly spokenText: string;
  readonly observationCalls: readonly string[];
  readonly lines: readonly string[];
}

export async function runInteractionDemo(): Promise<DemoResult> {
  const clock = createFakeClock();
  const ids = createIdFactory(createCounterIdSource());
  const conversationId = asConversationId('conv-demo');

  const speechInput = new FakeSpeechInputAdapter({
    script: [
      { partials: ['what', 'what is'], final: 'What is this?' },
      { partials: ['and what'], final: 'And what happens if I turn it off?' },
    ],
  });
  const speechOutput = new FakeSpeechOutputAdapter();
  const agent = new FakeAgentSession({
    conversationId,
    mode: 'manual',
    script: [
      {
        toolCalls: [{ name: 'observe_screen' }],
        deltas: ['That is the Auto Renew toggle. ', 'It is currently off.'],
      },
      { deltas: ['Turning it on renews the plan automatically each month.'] },
    ],
  });
  const observation = new RecordingObservationPort();
  const envelopes = new FakeQuestionEnvelopeFactory();

  const controller = new PilotInteractionController({
    clock,
    ids,
    conversationId,
    speechInput,
    speechOutput,
    agent,
    envelopes,
    observation,
    windows: FIXTURE_WINDOWS,
  });

  const rejections: string[] = [];
  controller.subscribeRejections((rejection) => {
    rejections.push(`${rejection.input} in ${rejection.from}: ${rejection.reason}`);
  });

  const path: string[] = [controller.snapshot().state];
  controller.subscribe((view) => {
    if (view.state !== path[path.length - 1]) {
      path.push(view.state);
    }
  });

  // Remember run identifiers as they are handed out, so the demo can replay a
  // late event from a run that has already been superseded.
  const runIds: RunId[] = [];
  agent.subscribe((event) => {
    if (event.type === 'run-started') {
      runIds.push(event.runId);
    }
  });

  const steps: DemoStep[] = [];
  const record = async (action: string, detail = ''): Promise<void> => {
    clock.advance(50);
    await controller.settled();
    steps.push({ n: steps.length + 1, action, state: controller.snapshot().state, detail });
  };
  const send = async (input: InteractionInput, detail = ''): Promise<void> => {
    controller.send(input);
    await record(input.type, detail);
  };

  // 1. The platform reports permissions and the observable window list.
  await send({ type: 'permissions-changed', permissions: FIXTURE_PERMISSIONS_GRANTED });
  await send({ type: 'windows-changed', windows: FIXTURE_WINDOWS });

  // 2. Selecting a valid window starts observing (mvp-01 §7, first row).
  await send(
    { type: 'select-window', windowId: FIXTURE_WINDOW_RETINA.windowId },
    FIXTURE_WINDOW_RETINA.title,
  );

  // 3. Point, ask: push-to-talk down/up, then the accepted transcript.
  await send({ type: 'push-to-talk-down' });
  await send({ type: 'push-to-talk-up' }, 'fake STT finalises "What is this?"');

  // 4. The model looks at the screen, then answers; the answer goes to TTS.
  agent.step();
  await record('agent turn', 'observe_screen, then the streamed answer');

  const supersededRun = runIds[0];
  const supersededSpeech = controller.context.activeSpeechId;

  // 5. A new push-to-talk stops speech and aborts the run (system-design §15).
  await send({ type: 'push-to-talk-down' }, 'interrupts speaking');

  // 6. Late events from the superseded run/speech cannot resurface output.
  if (supersededRun !== undefined) {
    await send(
      { type: 'run-text-delta', runId: supersededRun, text: ' ...and one more thing.' },
      'late delta from the superseded run',
    );
  }
  if (supersededSpeech !== null) {
    await send(
      { type: 'speech-finished', speechId: supersededSpeech },
      'late completion of stopped speech',
    );
  }

  // 7. Second question, interrupted while the model is still thinking.
  await send({ type: 'push-to-talk-up' }, 'fake STT finalises the follow-up');
  const liveRun = controller.context.activeRunId;
  await send({ type: 'interrupt' }, 'aborts the live run');
  if (liveRun !== null) {
    await send(
      { type: 'run-completed', runId: liveRun, text: 'never spoken' },
      'late completion of the aborted run',
    );
  }

  // 8. Turning observation off returns to idle.
  await send({ type: 'set-observation-enabled', enabled: false });

  await controller.dispose();

  const lines = [
    'Pilot — PR-006 interaction state machine demo (all adapters are fakes)',
    '',
    ...steps.map(
      (step) =>
        `${String(step.n).padStart(2, ' ')}. ${step.action.padEnd(26, ' ')} -> ${step.state.padEnd(
          16,
          ' ',
        )}${step.detail === '' ? '' : `# ${step.detail}`}`,
    ),
    '',
    `State path: ${path.join(' -> ')}`,
    '',
    'Discarded (stale / illegal) inputs:',
    ...rejections.map((rejection) => `  - ${rejection}`),
    '',
    `Spoken text: ${speechOutput.spokenText === '' ? '(none)' : speechOutput.spokenText}`,
    `Capture lifecycle: ${observation.callTypes.join(' -> ')}`,
    `Questions submitted: ${envelopes.requests.map((request) => request.transcript).join(' | ')}`,
  ];

  return {
    steps,
    states: steps.map((step) => step.state),
    path,
    rejections,
    spokenText: speechOutput.spokenText,
    observationCalls: observation.callTypes,
    lines,
  };
}
