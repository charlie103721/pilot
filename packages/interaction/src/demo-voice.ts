import {
  asConversationId,
  createCounterIdSource,
  createIdFactory,
  envelopePointerKnown,
  type InteractionState,
  type QuestionEnvelope,
  type UtteranceId,
} from '@pilot/shared';
import {
  FAKE_EPOCH_MS,
  FIXTURE_ACCESSIBILITY_NODE,
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
import { PilotQuestionEnvelopeFactory } from './envelope.js';
import { FakeQuestionAnchorSource, RecordingObservationPort } from './fakes.js';
import { recordPointerPath } from './recordings.js';
import { isTextFallbackAvailable } from './speech-binding.js';
import type { VoiceDiagnostic } from './voice-diagnostics.js';
import type { InteractionInput } from './inputs.js';

/**
 * The PR-025 demo: push-to-talk and speech-to-text bound to the real adapter
 * contract, driven entirely by fakes.
 *
 * Five scenes, each a case `docs/implementation.md` asks PR-025 to cover:
 *
 *  1. a complete spoken question becoming an agent submission;
 *  2. a transcript that arrives after its utterance was cancelled;
 *  3. two push-to-talk presses overlapping;
 *  4. speech-to-text failing mid-utterance, and the user typing instead;
 *  5. a finalize that arrives twice.
 *
 * Deterministic by construction: injected clock, counter identifiers, recorded
 * pointer timeline, scripted recogniser and scripted agent. No wall clock, no
 * randomness, no I/O — `pnpm demo:voice` prints the same text everywhere, and
 * `test/demo-voice.test.ts` pins it.
 */

const CONVERSATION_ID = asConversationId('conv-voice-demo');
const WINDOW = FIXTURE_WINDOW_RETINA;

/**
 * One pointer path long enough to cover every scene, so a typed question is
 * anchored exactly as well as a spoken one and the two envelopes can be
 * compared field for field.
 */
const POINTER_TIMELINE = recordPointerPath({
  startedAt: FAKE_EPOCH_MS,
  durationMs: 30_000,
  hz: 10,
  target: FIXTURE_ACCESSIBILITY_NODE,
  targetFrom: 0,
  sceneRevision: 4,
});

export interface VoiceDemoStep {
  readonly n: number;
  readonly action: string;
  readonly state: string;
  readonly detail: string;
}

export interface VoiceDemoScene {
  readonly name: string;
  readonly description: string;
  readonly steps: readonly VoiceDemoStep[];
  readonly path: readonly InteractionState[];
  /** Envelopes that actually reached `AgentSession.submit`. */
  readonly submitted: readonly QuestionEnvelope[];
  readonly rejections: readonly string[];
  readonly diagnostics: readonly string[];
  readonly adapter: {
    readonly started: number;
    readonly stopped: number;
    readonly cancelled: number;
    readonly stillRecording: boolean;
  };
  readonly spokenText: string;
  /** States on the path where the user could have typed instead (§16). */
  readonly textFallbackStates: readonly string[];
}

export interface VoiceDemoResult {
  readonly scenes: readonly VoiceDemoScene[];
  readonly lines: readonly string[];
}

interface Harness {
  readonly controller: PilotInteractionController;
  readonly clock: FakeClock;
  readonly speechInput: FakeSpeechInputAdapter;
  readonly speechOutput: FakeSpeechOutputAdapter;
  readonly agent: FakeAgentSession;
  readonly steps: VoiceDemoStep[];
  readonly path: InteractionState[];
  readonly rejections: string[];
  readonly diagnostics: string[];
  send(input: InteractionInput, detail?: string): Promise<void>;
  /** Send without draining the effect queue, so two commands can overlap. */
  sendNow(input: InteractionInput): void;
  record(action: string, detail?: string): Promise<void>;
}

function describeDiagnostic(diagnostic: VoiceDiagnostic): string {
  switch (diagnostic.kind) {
    case 'discarded-event':
      return `discarded ${diagnostic.event} for ${diagnostic.utteranceId}: ${diagnostic.reason}`;
    case 'ignored-call':
      return `ignored ${diagnostic.call}() for ${diagnostic.utteranceId}: ${diagnostic.reason}`;
    case 'discarded-chunk':
      return `discarded chunk ${String(diagnostic.sequence)} of ${diagnostic.speechId}: ${
        diagnostic.reason
      }`;
    case 'discarded-speech-event':
      return `discarded ${diagnostic.event} for ${diagnostic.speechId}: ${diagnostic.reason}`;
    case 'ignored-speech-call':
      return `ignored ${diagnostic.call}() for ${diagnostic.speechId ?? '(any stream)'}: ${
        diagnostic.reason
      }`;
  }
}

function createHarness(options: {
  readonly transcripts: readonly {
    readonly partials?: readonly string[];
    readonly final: string;
  }[];
  readonly answers: readonly string[];
}): Harness {
  const clock = createFakeClock();
  const speechInput = new FakeSpeechInputAdapter({ script: options.transcripts });
  const speechOutput = new FakeSpeechOutputAdapter();
  const agent = new FakeAgentSession({
    conversationId: CONVERSATION_ID,
    mode: 'auto',
    script: options.answers.map((answer) => ({ deltas: [answer] })),
  });
  const controller = new PilotInteractionController({
    clock,
    ids: createIdFactory(createCounterIdSource()),
    conversationId: CONVERSATION_ID,
    speechInput,
    speechOutput,
    agent,
    envelopes: new PilotQuestionEnvelopeFactory({
      anchors: new FakeQuestionAnchorSource({ samples: POINTER_TIMELINE }),
    }),
    observation: new RecordingObservationPort(),
    permissions: FIXTURE_PERMISSIONS_GRANTED,
    windows: FIXTURE_WINDOWS,
  });

  const steps: VoiceDemoStep[] = [];
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

  const record = async (action: string, detail = ''): Promise<void> => {
    clock.advance(50);
    await controller.settled();
    steps.push({ n: steps.length + 1, action, state: controller.snapshot().state, detail });
  };

  return {
    controller,
    clock,
    speechInput,
    speechOutput,
    agent,
    steps,
    path,
    rejections,
    diagnostics,
    record,
    sendNow: (input) => {
      controller.send(input);
    },
    send: async (input, detail = '') => {
      controller.send(input);
      await record(input.type, detail);
    },
  };
}

async function finish(
  harness: Harness,
  name: string,
  description: string,
): Promise<VoiceDemoScene> {
  await harness.controller.settled();
  const scene: VoiceDemoScene = {
    name,
    description,
    steps: harness.steps,
    path: harness.path,
    submitted: [...harness.agent.submitted],
    rejections: harness.rejections,
    diagnostics: harness.diagnostics,
    adapter: {
      started: harness.speechInput.started.length,
      stopped: harness.speechInput.stopped.length,
      cancelled: harness.speechInput.cancelled.length,
      stillRecording: harness.speechInput.activeUtteranceId !== null,
    },
    spokenText: harness.speechOutput.spokenText,
    textFallbackStates: [...new Set(harness.path)].filter(isTextFallbackAvailable),
  };
  await harness.controller.dispose();
  return scene;
}

function activeUtterance(harness: Harness): UtteranceId {
  const utteranceId = harness.controller.context.activeUtteranceId;
  if (utteranceId === null) {
    throw new Error('demo expected an active utterance');
  }
  return utteranceId;
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/** 1. Point, hold, speak, release — one agent submission. */
async function sceneSpokenQuestion(): Promise<VoiceDemoScene> {
  const harness = createHarness({
    transcripts: [{ partials: ['what', 'what is'], final: 'What is this?' }],
    answers: ['That is the Auto Renew toggle.'],
  });
  await harness.send({ type: 'select-window', windowId: WINDOW.windowId }, WINDOW.title);
  await harness.send({ type: 'push-to-talk-down' }, 'the adapter opens one utterance');

  // A live hypothesis while the key is still held.
  const utteranceId = activeUtterance(harness);
  harness.speechInput.emitPartial(utteranceId, 'what is');
  await harness.record('transcript-partial', 'live transcript while listening');

  await harness.send({ type: 'push-to-talk-up' }, 'stop-listening, then the accepted transcript');
  return finish(
    harness,
    'spoken question',
    'Push-to-talk down and up drive the recogniser; the accepted transcript becomes an envelope.',
  );
}

/** 2. The recogniser answers after the utterance was cancelled. */
async function sceneLateTranscriptAfterCancel(): Promise<VoiceDemoScene> {
  const harness = createHarness({
    transcripts: [{ final: 'the abandoned question' }],
    answers: ['never asked'],
  });
  await harness.send({ type: 'select-window', windowId: WINDOW.windowId }, WINDOW.title);
  await harness.send({ type: 'push-to-talk-down' });
  const abandoned = activeUtterance(harness);
  await harness.send({ type: 'interrupt' }, 'cancel-listening reaches the adapter');

  harness.speechInput.emitLateFinal(abandoned, 'the abandoned question');
  await harness.record('late final', 'the recogniser answers a question nobody is asking');
  return finish(
    harness,
    'late transcript after cancel',
    'A transcript for a cancelled utterance is dropped by the binding and never reaches the machine.',
  );
}

/** 3. A second press arrives before the first question is finished. */
async function sceneOverlappingPresses(): Promise<VoiceDemoScene> {
  const harness = createHarness({
    transcripts: [
      { partials: ['what'], final: 'What is this?' },
      { partials: ['no wait'], final: 'No wait — what is that?' },
    ],
    answers: ['That is the Auto Renew toggle.'],
  });
  await harness.send({ type: 'select-window', windowId: WINDOW.windowId }, WINDOW.title);
  await harness.send({ type: 'push-to-talk-down' }, 'first press');
  await harness.send({ type: 'push-to-talk-down' }, 'key repeat: refused, the utterance is intact');

  // Release and press again in the same tick: the second press supersedes the
  // first before its transcript has been delivered.
  harness.sendNow({ type: 'push-to-talk-up' });
  harness.sendNow({ type: 'push-to-talk-down' });
  await harness.record('push-to-talk-up + down', 'second press overlaps the first utterance');

  await harness.send({ type: 'push-to-talk-up' }, 'only the second question is asked');
  return finish(
    harness,
    'overlapping push-to-talk presses',
    'A repeat press is refused; a genuine second press supersedes the first, whose result is discarded.',
  );
}

/** 4. system-design §16: STT fails, so the user types instead. */
async function sceneSttFailureThenTyping(): Promise<VoiceDemoScene> {
  const harness = createHarness({
    transcripts: [{ final: 'never delivered' }],
    answers: ['That is the Auto Renew toggle.'],
  });
  await harness.send({ type: 'select-window', windowId: WINDOW.windowId }, WINDOW.title);
  await harness.send({ type: 'push-to-talk-down' });
  const failed = activeUtterance(harness);

  harness.speechInput.emitError(failed, 'The recogniser lost the audio session');
  await harness.record('transcript-failed', 'mid-utterance failure; audio released');

  await harness.send(
    { type: 'submit-text', text: 'What is this?' },
    'the same submission path a spoken question takes',
  );

  harness.speechInput.emitLateFinal(failed, 'never delivered');
  await harness.record('late final', 'the failed utterance cannot come back');
  return finish(
    harness,
    'STT failure, then typing',
    'A failed recogniser leaves the user able to type; the typed question produces an equivalent envelope.',
  );
}

/** 5. The same accepted transcript is delivered twice. */
async function sceneDoubleFinalize(): Promise<VoiceDemoScene> {
  const harness = createHarness({
    transcripts: [{ final: 'What is this?' }],
    answers: ['That is the Auto Renew toggle.'],
  });
  await harness.send({ type: 'select-window', windowId: WINDOW.windowId }, WINDOW.title);
  await harness.send({ type: 'push-to-talk-down' });
  const utteranceId = activeUtterance(harness);
  await harness.send({ type: 'push-to-talk-up' }, 'the accepted transcript');

  harness.speechInput.emitLateFinal(utteranceId, 'What is this?');
  await harness.record('duplicate final', 'the adapter repeats itself');
  return finish(
    harness,
    'duplicate finalize',
    'One accepted transcript per utterance: the second finalize is dropped, so one question is asked.',
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function describeEnvelope(envelope: QuestionEnvelope): readonly string[] {
  const anchor = envelope.anchor;
  return [
    `     utterance   ${envelope.utteranceId}`,
    `     transcript  "${envelope.transcript}"`,
    `     grounding   ${anchor?.grounding ?? '(none)'} at ${
      envelopePointerKnown(envelope)
        ? `${envelope.pointer.normalizedX.toFixed(3)}, ${envelope.pointer.normalizedY.toFixed(3)}`
        : 'an unknown position'
    }`,
    `     target      ${envelope.pointer.targetRole ?? '(no role)'} — ${
      envelope.pointer.targetLabel ?? '(no label)'
    }`,
    `     utterance interval ${String(anchor?.utteranceStartedAt ?? 0)} → ${String(
      anchor?.utteranceEndedAt ?? 0,
    )}`,
  ];
}

function describeScene(scene: VoiceDemoScene, index: number): readonly string[] {
  const lines = [
    `## ${String(index + 1)}. ${scene.name}`,
    `   ${scene.description}`,
    '',
    ...scene.steps.map(
      (step) =>
        `   ${String(step.n).padStart(2, ' ')}. ${step.action.padEnd(24, ' ')} -> ${
          step.detail === '' ? step.state : `${step.state.padEnd(14, ' ')}# ${step.detail}`
        }`,
    ),
    '',
    `   state path          ${scene.path.join(' -> ')}`,
    `   adapter calls       start x${String(scene.adapter.started)}, stop x${String(
      scene.adapter.stopped,
    )}, cancel x${String(scene.adapter.cancelled)} (recording afterwards: ${
      scene.adapter.stillRecording ? 'YES' : 'no'
    })`,
    `   questions submitted ${String(scene.submitted.length)}`,
  ];
  for (const envelope of scene.submitted) {
    lines.push(...describeEnvelope(envelope));
  }
  lines.push(
    `   spoken answer       ${scene.spokenText === '' ? '(none)' : scene.spokenText}`,
    `   text fallback in    ${scene.textFallbackStates.join(', ')}`,
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

export async function runVoiceDemo(): Promise<VoiceDemoResult> {
  const scenes = [
    await sceneSpokenQuestion(),
    await sceneLateTranscriptAfterCancel(),
    await sceneOverlappingPresses(),
    await sceneSttFailureThenTyping(),
    await sceneDoubleFinalize(),
  ];

  const spoken = scenes[0]?.submitted[0];
  const typed = scenes[3]?.submitted[0];
  const equivalence =
    spoken === undefined || typed === undefined
      ? ['No envelope pair to compare.']
      : [
          'Spoken and typed questions take one submission path:',
          `  spoken: "${spoken.transcript}" grounded ${spoken.anchor?.grounding ?? '(none)'} on ${
            spoken.pointer.targetLabel ?? '(no label)'
          }`,
          `  typed:  "${typed.transcript}" grounded ${typed.anchor?.grounding ?? '(none)'} on ${
            typed.pointer.targetLabel ?? '(no label)'
          }`,
          `  same envelope keys: ${
            JSON.stringify(Object.keys(spoken).sort()) === JSON.stringify(Object.keys(typed).sort())
              ? 'yes'
              : 'NO'
          }`,
        ];

  const lines = [
    'Pilot — PR-025 voice orchestration demo (push-to-talk and STT against the fakes)',
    'Injected clock, counter identifiers, recorded pointer timeline: no wall clock, no I/O.',
    '',
    ...scenes.flatMap((scene, index) => [...describeScene(scene, index), '']),
    ...equivalence,
    '',
    'Exactly one utterance is ever live at the adapter. Every result from a dead',
    'utterance is dropped by the binding, or — when it was still live at the adapter',
    'and the machine had already moved on — by the identity guard, and is listed above.',
  ];

  return { scenes, lines };
}
