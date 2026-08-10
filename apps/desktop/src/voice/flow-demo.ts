import { readdirSync } from 'node:fs';
import { createScriptedModelSource, type ScriptedModelSource } from '@pilot/agent';
import { isTextFallbackAvailable, speechChunkId } from '@pilot/interaction';
import { hotkeyUnavailableMessage, type PilotViewState } from '@pilot/platform';
import { macWindowNumber } from '@pilot/platform-mac';
import {
  asSpeechId,
  asWindowId,
  createLogger,
  createMemorySink,
  MVP_SCREEN_POLICY,
  type LogRecord,
  type Logger,
  type LogSink,
  type ObservedWindow,
} from '@pilot/shared';
import {
  AX_ELEMENTS,
  lastRequest,
  OUTSIDE_THE_WINDOW,
  OVER_A_STACKED_WINDOW,
  OVER_THE_BUTTON,
  pushScreenshot,
  settleRun,
} from '../observation/ask-demo.js';
import {
  createObservationRig,
  DEMO_DESKTOP,
  DEMO_WINDOWS,
  type ObservationRig,
  type ObservationRigOptions,
} from '../observation/observe-rig.js';

/**
 * PR-034's demo: **the MVP scenario, as one trace.**
 *
 *     pnpm demo:flow
 *
 * `docs/mvp-01-point-ask-hear.md` §2 is the scenario: select a window, point at
 * something, hold the key, ask, hear a grounded answer, ask a follow-up,
 * interrupt. PR-028 through PR-033 built every boundary it needs. **This PR adds
 * no capability.** It joins the pieces and checks that they hold together as one
 * trace rather than as six passing suites — because "the MVP flow works" is a
 * sentence someone will quote, and it is only worth quoting if a single run of
 * the shipping composition produced it.
 *
 * Nothing here is a harness. Every object below is the one `main/index.ts`
 * builds, assembled by `src/observation/observe-rig.ts` in the same order and
 * with the same arguments; the only stand-in is the process on the far end of
 * the framed stdio pipe.
 *
 * ## What is real, and what is not
 *
 * Real, and the shipping code: `WindowGate`, `PermissionGate`,
 * `PilotInteractionController` and its 330-cell table, `MacHotkeyAdapter`,
 * `MacSpeechInputAdapter`, `MacSpeechOutputAdapter`, `MacObservationAdapter`,
 * `MacAccessibilityAdapter`, `MacWindowAdapter`, `NativeHelperTransport`,
 * `ObservationSession`, `ObservationCore`, `PilotScreenContextService`, the §10
 * policy and the image pipeline (which really decodes, crops and encodes),
 * `PiAgentSession`, Pi's agent loop, the `observe_screen` tool, the question
 * anchor, `main/voice-runtime.ts` and `main/speech-runtime.ts`.
 *
 * **NO MAC, NO KEY, NO MICROPHONE, NO SPEAKER, NO MODEL.** There is no macOS
 * here (runbook §5 amendment 8): the key transitions, the transcripts, the
 * pointer positions, the accessibility elements and every speech callback come
 * from the Node helper stub; the pixels are synthetic screenshots (the stub's
 * own frames do not decode — runbook cross-lane issue 11); and *that* the model
 * calls `observe_screen` is scripted, because the model is Pi's faux provider
 * and no request has ever left this machine (`docs/handoff.md` §2).
 *
 * Section 4 says, row by row, which of `docs/mvp-01-point-ask-hear.md` §18's
 * A-01…A-15 this trace evidences and which it cannot. PR-043 owns running the
 * matrix; this owns the single trace.
 */

export interface FlowDemoResult {
  readonly lines: readonly string[];
}

const GRANTED = {
  'screen-recording': 'granted',
  accessibility: 'granted',
  microphone: 'granted',
  'speech-recognition': 'granted',
} as const;

/** What the scripted recogniser "hears" while the key is held. */
const PARTIALS_ONE = ['what', 'what is', 'what is this'] as const;
const QUESTION_ONE = 'What is this?';
const PARTIALS_TWO = ['and can i', 'and can i turn it'] as const;
const QUESTION_TWO = 'And can I turn it off later?';

/** Three sentences, so the answer is spoken as more than one utterance. */
const ANSWER_ONE =
  'That is the Update payment method button. ' +
  'It opens the billing sheet for this account. ' +
  'The card on file is charged when the plan renews.';
const ANSWER_TWO = 'Yes. You can switch it off from the same sheet at any time.';

/**
 * Slow enough that the answer is visibly *streamed* — and that a second press
 * can land while the first answer is still being spoken, which is the
 * interruption in `docs/mvp-01-point-ask-hear.md` §2 step 14. Fast enough that
 * the whole trace stays under half a minute.
 */
const TOKENS_PER_SECOND = 12;

/**
 * The rows of `docs/mvp-01-point-ask-hear.md` §7 this scenario must walk, as
 * `[from, event, to]`.
 *
 * Checked against the recorded state path rather than narrated, because a demo
 * that *says* which transitions it took is describing itself. The two §7 rows
 * missing here are `pause` and "any state + recoverable failure", which other
 * walkthroughs own.
 */
const MVP_TRANSITIONS = [
  ['idle', 'valid window selected', 'observing'],
  ['observing', 'push-to-talk down', 'listening'],
  ['listening', 'push-to-talk up', 'transcribing'],
  ['transcribing', 'transcript accepted', 'thinking'],
  ['thinking', 'screen tool starts', 'observing-screen'],
  ['observing-screen', 'tool result returned', 'thinking'],
  ['thinking', 'first speakable sentence', 'speaking'],
  ['speaking', 'new push-to-talk', 'listening'],
] as const;

/** Whitespace-insensitive comparison of what was spoken with what was written. */
function sameWords(left: string, right: string): boolean {
  const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim();
  return flatten(left) === flatten(right);
}

/** Bounded wait on observable state. No fixed sleeps: a wedged demo fails loudly. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * One pointer coalescing bucket.
 *
 * `PointerTimeline` keeps the last sample inside one
 * `DEFAULT_POINTER_MIN_INTERVAL_MS` (33 ms at 30 Hz), so two `samplePointer()`
 * calls back to back are *one* sample — runbook cross-lane issue 14. The real
 * 30 Hz poller is 33 ms apart for the same reason; widening the bucket to make
 * a demo read better would delete the property under test.
 */
async function nextPointerBucket(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

/**
 * Everything the panel saw, in order, recorded from the one view stream the
 * renderer subscribes to.
 *
 * A trace is only one trace if it is read from one place. `PilotViewState` is
 * that place: `ConversationPanel.tsx` renders `state`, `liveTranscript`,
 * `transcript` and `speaking`, and nothing here reads any of them from
 * anywhere else.
 */
interface PanelTrace {
  readonly states: readonly string[];
  readonly speakingEdges: readonly string[];
  readonly live: readonly string[];
  stop(): void;
}

function recordPanel(rig: ObservationRig): PanelTrace {
  const first = rig.controller.snapshot();
  const states: string[] = [first.state];
  const speakingEdges: string[] = [];
  const live: string[] = [];
  let lastSpeaking = first.speaking;
  const off = rig.controller.subscribe((view) => {
    if (view.state !== states[states.length - 1]) {
      states.push(view.state);
    }
    if (view.speaking !== lastSpeaking) {
      lastSpeaking = view.speaking;
      speakingEdges.push(view.speaking ? 'speaking' : 'silent');
    }
    const partial = view.liveTranscript;
    if (partial !== null && partial !== '' && partial !== live[live.length - 1]) {
      live.push(partial);
    }
  });
  return { states, speakingEdges, live, stop: off };
}

/** Every `speech.output.speak` that crossed the framed stdio protocol, in order. */
function spoken(rig: ObservationRig): readonly { id: string; text: string }[] {
  return rig.wire
    .filter((request) => request.op === 'speech.output.speak')
    .map((request) => ({
      id: String(request.payload['speechId']),
      text: String(request.payload['text']),
    }));
}

function answerOf(rig: ObservationRig): string {
  return String(
    rig.controller
      .snapshot()
      .transcript.filter((entry) => entry.role === 'assistant')
      .at(-1)?.text,
  );
}

function questionOf(rig: ObservationRig): string {
  return String(
    rig.controller
      .snapshot()
      .transcript.filter((entry) => entry.role === 'user')
      .at(-1)?.text,
  );
}

/**
 * Presses the key.
 *
 * On a Mac this is a finger on Right Option while another application is in
 * front. Here the stub plays the next entry of `hotkeyScripts`, which it does
 * once per `hotkey.start` — so re-issuing `hotkey.start` is how this walkthrough
 * asks for the *next* scripted transition. `MacHotkeyAdapter` cannot tell a
 * scripted key event from a real one, which is the whole point of the stub.
 */
async function pressKey(rig: ObservationRig, started: boolean): Promise<void> {
  const before = rig.voice.stats().downs;
  await (started ? rig.hotkey.start() : rig.voice.start());
  await waitFor('the key press to reach the machine', () => rig.voice.stats().downs > before);
}

async function releaseKey(rig: ObservationRig): Promise<void> {
  const before = rig.voice.stats().ups;
  await rig.hotkey.start();
  await waitFor('the key release to reach the machine', () => rig.voice.stats().ups > before);
}

/** Files under the repository, excluding build output and dependencies. */
function listTree(root: string): readonly string[] {
  const skip = new Set([
    'node_modules',
    '.git',
    '.claude',
    'dist',
    'release',
    'resources',
    'coverage',
    '.build',
  ]);
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skip.has(entry.name)) {
        continue;
      }
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
      } else {
        found.push(path);
      }
    }
  };
  walk(root);
  return found;
}

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');

/** A run of base64 long enough to be a payload rather than an identifier. */
const BASE64_RUN = /[A-Za-z0-9+/]{120,}={0,2}/;

interface Watched {
  readonly rig: ObservationRig;
  readonly window: ObservedWindow;
  readonly panel: PanelTrace;
}

async function watching(
  stub: Record<string, unknown>,
  model: ScriptedModelSource,
  logger: Logger,
  options: Partial<ObservationRigOptions> = {},
): Promise<Watched> {
  const rig = await createObservationRig({
    stub: {
      permissions: GRANTED,
      desktop: DEMO_DESKTOP,
      axElements: AX_ELEMENTS,
      captureFrameBytes: 3_072,
      captureScaleFactor: 2,
      ...stub,
    },
    modelSource: model,
    recordRequests: true,
    logger,
    // This trace owns the ring: it pushes decodable screenshots, and a stub
    // frame — which is not a decodable image — landing between one of them and
    // the question anchored on it would turn `moment: 'question'` into a decode
    // failure. See `ObservationRigOptions.capturePollIntervalMs`.
    capturePollIntervalMs: 3_600_000,
    // The recogniser's own 60 ms drain, because partial transcripts arriving is
    // part of what the trace shows.
    speechPollIntervalMs: 60,
    ...options,
  });
  const panel = recordPanel(rig);
  await rig.permissions.refresh();
  await rig.observation.refreshAttribution();
  const window = await rig.firstWindow();
  await rig.windows.act({ type: 'select', windowId: window.windowId });
  await rig.controller.settled();
  return { rig, window, panel };
}

export async function runFlowDemo(): Promise<FlowDemoResult> {
  const lines: string[] = [];
  const say = (line = ''): void => {
    lines.push(line);
  };
  const evidence = (label: string, value: string): void => {
    say(`     ${label.padEnd(46)} ${value}`);
  };

  say('PR-034 — complete voice screen-grounding flow');
  say('='.repeat(72));
  say();
  say('The MVP scenario (docs/mvp-01-point-ask-hear.md §2) as ONE trace, through');
  say('the shipping composition: select a window, point, hold the key, speak, let');
  say('the model look, read the answer and hear it — then interrupt it and ask a');
  say('follow-up. PR-034 adds no capability; it checks that PR-028…PR-033 hold');
  say('together in a single run rather than in six passing suites.');
  say();
  say('Real: WindowGate, PermissionGate, PilotInteractionController, the mac');
  say('      adapters (hotkey, speech in/out, capture, accessibility, windows)');
  say('      over NativeHelperTransport, ObservationSession, ObservationCore,');
  say('      PilotScreenContextService, the §10 policy and image pipeline,');
  say('      PiAgentSession, Pi’s agent loop, observe_screen, the question');
  say('      anchor, main/voice-runtime.ts and main/speech-runtime.ts.');
  say('NOT REAL: no macOS, no key, no microphone, no speaker, no model. Sections');
  say('      4 and 5 say exactly what that leaves unproven.');
  say();

  const sink: LogSink & { readonly records: readonly LogRecord[] } = createMemorySink();
  const logger = createLogger({ scope: 'flow-demo', level: 'debug', sink });
  const filesBefore = listTree(REPO_ROOT);

  // Scripted before the rig exists, not between the release and the run: the
  // question is submitted the instant the recogniser finalises, so a script set
  // after the key comes up would race the run it is meant to drive.
  const model = createScriptedModelSource({
    tokensPerSecond: TOKENS_PER_SECOND,
    script: [{ observe: { view: 'both', moment: 'question' } }, { say: ANSWER_ONE }],
  });
  const { rig, window, panel } = await watching(
    {
      // Two presses and two releases: entry n plays on call n of `hotkey.start`.
      hotkeyScripts: [[{ key: 'down' }], [{ key: 'up' }], [{ key: 'down' }], [{ key: 'up' }]],
      // A recogniser that emits partials while the key is held and one accepted
      // transcript when capture ends — the shape Apple Speech has. One script
      // per utterance.
      speechInput: {
        scripts: [
          {
            steps: [
              {
                on: 'start',
                emit: PARTIALS_ONE.map((transcript) => ({ type: 'partial', transcript })),
              },
              { on: 'stop', emit: [{ type: 'final', transcript: QUESTION_ONE }] },
            ],
          },
          {
            steps: [
              {
                on: 'start',
                emit: PARTIALS_TWO.map((transcript) => ({ type: 'partial', transcript })),
              },
              { on: 'stop', emit: [{ type: 'final', transcript: QUESTION_TWO }] },
            ],
          },
        ],
      },
      // The pointer leaves the window, crosses another application’s window and
      // comes to rest on the control the question is about — all while the key
      // is held, which only a spoken question can produce.
      pointerScript: [OUTSIDE_THE_WINDOW, OVER_A_STACKED_WINDOW, OVER_THE_BUTTON],
    },
    model,
    logger,
  );

  try {
    // -----------------------------------------------------------------------
    // 0 — the composition
    // -----------------------------------------------------------------------
    say('0. the composition under test');
    evidence('platform:', `kind=${rig.platform.kind} — ${rig.platform.reason}`);
    evidence('model:', model.description);
    evidence(
      'capability gate:',
      rig.agent.capability.ok
        ? `vision=${String(rig.agent.capability.report.vision)} ` +
            `tools=${String(rig.agent.capability.report.tools)} ` +
            `remote=${String(rig.agent.capability.report.endpoint.isRemote)}`
        : `REFUSED — ${rig.agent.capability.error.code}`,
    );
    evidence('provider requests so far:', String(model.requestCount()));
    say('     (the gate runs in the PiAgentSession constructor, before a tool is');
    say('      registered and before Pi’s Agent exists, so a refusal costs zero');
    say('      provider requests — mvp-01 §12, A-11’s mechanism.)');
    evidence(
      'one screen context:',
      `agent.screenContext === observation.screenContext: ` +
        `${String(rig.agent.screenContext === rig.observation.screenContext)}`,
    );
    evidence(
      'one observation core:',
      `anchor source and pointer poller share it: ` +
        `${String(rig.anchoring.anchors.scene() === rig.observation.core.scene)}`,
    );
    evidence(
      'speech output:',
      `real=${String(rig.speech.real)} voices=${rig.speech.voices().length}`,
    );
    say();

    // -----------------------------------------------------------------------
    // 1 — the trace
    // -----------------------------------------------------------------------
    say('1. THE TRACE — one spoken question, one grounded and spoken answer');
    say('-'.repeat(72));
    say();

    say('   [1] a window is selected, and only that window is watched');
    evidence('picker:', `${String(rig.windows.snapshot().windows.length)} window(s) enumerated`);
    evidence('chosen:', `${window.applicationName} — "${window.title}" (${window.windowId})`);
    evidence(
      'not chosen:',
      `${DEMO_WINDOWS[1].applicationName} — "${DEMO_WINDOWS[1].title}" ` +
        `(a second application, on top of the first)`,
    );
    evidence(
      'state:',
      `${rig.controller.snapshot().state} observationEnabled=` +
        `${String(rig.controller.snapshot().observationEnabled)}`,
    );
    const started = rig.wire.filter((call) => call.op === 'capture.start');
    evidence(
      'at the wire:',
      `capture.start × ${String(started.length)} for windowNumber ` +
        `${started.map((call) => String(call.payload['windowNumber'])).join(', ')} ` +
        `(the selected window is ${String(macWindowNumber(window.windowId))})`,
    );
    say();

    say('   [2] the selected window’s pixels reach the ring');
    say('       (the stub’s own frames are deterministic bytes that do not decode,');
    say('        so the screenshots here are synthetic and pushed through the same');
    say('        ObservationSession.ingestFrame the capture stream arrives on.)');
    const admitted = await pushScreenshot(rig, window, {
      id: 'frame-question',
      capturedAt: Date.now(),
    });
    evidence('a frame of the selected window:', `admitted=${String(admitted)}`);
    const foreignFrame = await pushScreenshot(
      rig,
      { ...window, windowId: asWindowId(`mac-window-${String(DEMO_WINDOWS[1].windowNumber)}`) },
      { id: 'frame-foreign', capturedAt: Date.now() },
    );
    evidence(
      'a frame stamped with the other window:',
      `admitted=${String(foreignFrame)}, rejected=${String(
        rig.observation.metrics().framesRejected,
      )}`,
    );
    evidence(
      'ring:',
      `frames=${String(rig.observation.core.status().buffer.frameCount)} ` +
        `bytes=${String(rig.observation.core.status().buffer.byteCount)}`,
    );
    say();

    say('   [3] the key goes down: Pilot listens, and the pointer moves');
    await pressKey(rig, false);
    evidence(
      'attribution first:',
      `${String(rig.voice.attribution()?.verdict)} ` +
        `(${String(rig.voice.attribution()?.confidence)}) — established before the tap`,
    );
    evidence('state:', rig.controller.snapshot().state);
    await waitFor(
      'the first partial transcript',
      () => (rig.controller.snapshot().liveTranscript ?? '') !== '',
    );
    // Outside the window, then over another application's window, then onto the
    // control the question is about — one pointer bucket apart, as the 30 Hz
    // poller would produce them.
    await rig.observation.samplePointer();
    await nextPointerBucket();
    await rig.observation.samplePointer();
    await nextPointerBucket();
    await rig.observation.samplePointer();
    await waitFor('every partial', () => panel.live.length >= PARTIALS_ONE.length);
    say('     what the panel rendered as the words arrived:');
    for (const partial of panel.live) {
      say(`       | ${partial}`);
    }
    evidence('pointer path:', `outside the window → over another app’s window → on the button`);
    say();

    say('   [4] the key comes up: the question is transcribed and anchored');
    await releaseKey(rig);
    const heldFrom = rig.controller.context.utteranceStartedAt;
    const heldTo = rig.controller.context.utteranceEndedAt;
    evidence('state:', rig.controller.snapshot().state);
    await waitFor('the transcript to become the question', () => questionOf(rig) === QUESTION_ONE);
    evidence('the accepted transcript:', `"${questionOf(rig)}"`);
    evidence('utterance:', `${String((heldTo ?? 0) - (heldFrom ?? 0))} ms of held key`);
    const path = rig.anchoring.anchors.pointerBetween(heldFrom ?? 0, heldTo ?? 0);
    evidence('pointer samples in it:', String(path.length));
    const anchor = rig.anchoring.lastAnchor();
    evidence(
      'anchor:',
      `at=${String(anchor?.at)} skewMs=${String(anchor?.skewMs)} ` +
        `insideWindow=${String(anchor?.insideWindow)} targetRole=${String(anchor?.targetRole)}`,
    );
    evidence(
      'anchored on:',
      `the pointer sample at push-to-talk release (mvp-01 §8), not the newest`,
    );
    say();

    say('   [5] the model asks to look; the §10 policy answers');
    // Bounded waits on observable state, never a sleep: the run is still going.
    await waitFor(
      'the model’s observation to complete',
      () => rig.observation.lastObservation() !== null,
    );
    const observed = rig.observation.lastObservation();
    // Read while the ring still holds it: `ringDurationMs` is 3 000 ms, so by
    // the end of the trace this frame has aged out — which is the bound, not a
    // gap in the evidence.
    const ringWindows = [
      ...new Set(rig.observation.core.frames.records().map((record) => record.frame.windowId)),
    ];
    evidence(
      'tool call:',
      `observe_screen view=${String(observed?.view)} moment=${String(observed?.moment)}`,
    );
    evidence(
      'scene:',
      `${String(observed?.sceneId)} revision ${String(observed?.sceneRevision)} ` +
        `window "${String(observed?.windowTitle)}"`,
    );
    evidence(
      'frames chosen:',
      (observed?.frames ?? [])
        .map((frame) => `${frame.purpose}:${frame.origin} skewMs=${String(frame.skewMs)}`)
        .join(', '),
    );
    evidence(
      'images produced:',
      (observed?.images ?? [])
        .map(
          (image) =>
            `${image.purpose} ${String(image.width)}×${String(image.height)} ` +
            `${image.mimeType.replace('image/', '')} ${String(image.byteLength)} B`,
        )
        .join(', '),
    );
    evidence(
      'policy in force:',
      `fullFrameMaxEdge=${String(MVP_SCREEN_POLICY.fullFrameMaxEdge)} ` +
        `pointerCropPixels=${String(MVP_SCREEN_POLICY.pointerCropPixels)} ` +
        `maxActiveFullFrames=${String(MVP_SCREEN_POLICY.maxActiveFullFrames)} ` +
        `persistRawFrames=${String(MVP_SCREEN_POLICY.persistRawFrames)}`,
    );
    evidence('redaction:', String(observed?.redaction.guarantee));
    evidence(
      'pointer, as the tool saw it:',
      `known=${String(observed?.pointerKnown)} ` +
        `insideWindow=${String(observed?.pointerInsideWindow)} ` +
        `targetRole=${String(observed?.targetRole)}`,
    );
    await waitFor(
      'the tool result to reach the provider',
      () => (lastRequest(model)?.images.length ?? 0) > 0,
    );
    const request = lastRequest(model);
    say('     what the model was told about the question — the rendered envelope:');
    for (const line of (request?.context ?? '(none)').split('\n')) {
      say(`       | ${line}`);
    }
    evidence('the tool’s own summary:', String(request?.summary));
    evidence(
      'the provider received:',
      (request?.images ?? [])
        .map((image) => `${image.mimeType}, ${String(image.base64Length)} base64 chars`)
        .join('; '),
    );
    say('     (the base64 itself is never printed, logged or written — §13, and');
    say('      section 2c checks that on this very trace.)');
    say();

    say('   [6] the answer streams into the panel while it is being spoken');
    await waitFor('the first word on screen', () => answerOf(rig) !== 'undefined');
    await waitFor('the first chunk to reach the synthesiser', () => spoken(rig).length > 0);
    // Read in this order and at this moment on purpose: mvp-01 checkpoint D is
    // "TTS starts before the complete response finishes", and the only way to
    // show it is to catch the answer still `pending` when the first utterance
    // has already been handed over.
    const streamingWhenSpoken = rig.controller
      .snapshot()
      .transcript.filter((entry) => entry.role === 'assistant')
      .at(-1)?.pending;
    evidence('so far, on screen:', `"${answerOf(rig)}"`);
    evidence(
      'still streaming when the first chunk was spoken:',
      `pending=${String(streamingWhenSpoken)}`,
    );
    say();

    say('   [7] …and it is spoken, in order, sentence by sentence');
    await waitFor('two utterances to be spoken', () => rig.speech.stats().accepted >= 2);
    const chunks = spoken(rig);
    const stream = chunks[0]?.id.split('#')[0] ?? '(none)';
    for (const [index, chunk] of chunks.entries()) {
      const expected = speechChunkId(asSpeechId(stream), index);
      say(`       ${chunk.id} = speechChunkId(stream, ${String(index)}) = ${expected}`);
      say(`         "${chunk.text}"`);
    }
    evidence(
      'the chunks, in order, are:',
      ANSWER_ONE.replace(/\s+/g, ' ').startsWith(
        chunks
          .map((chunk) => chunk.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
        ? 'the opening of the answer on screen, in order'
        : 'NOT a prefix of the answer on screen',
    );
    evidence(
      'synthesiser:',
      `accepted=${String(rig.speech.stats().accepted)} ` +
        `silenced=${String(rig.speech.stats().silenced)}`,
    );
    evidence('the panel’s speaking bit:', panel.speakingEdges.join(' → '));
    say();

    // -----------------------------------------------------------------------
    // 8 — the interruption, in the same trace
    // -----------------------------------------------------------------------
    say('   [8] a second press interrupts it mid-answer (mvp-01 §2 steps 13–14)');
    const interruptedAt = answerOf(rig);
    const before = spoken(rig).length;
    const stopsBefore = rig.speech.stats().stops;
    await pressKey(rig, true);
    await waitFor(
      'the synthesiser to be told to stop',
      () => rig.speech.stats().stops > stopsBefore,
    );
    evidence('state:', rig.controller.snapshot().state);
    evidence('speaking:', String(rig.controller.snapshot().speaking));
    evidence(
      'the answer it was speaking:',
      `left on screen, ${String(interruptedAt.length)} characters of it`,
    );
    evidence('utterances spoken before the stop:', String(before));
    // The follow-up's reply, queued while the machine is listening and before
    // the release that submits it. The aborted run asks for nothing more.
    model.setScript([{ say: ANSWER_TWO }]);
    await rig.observation.samplePointer();
    await releaseKey(rig);
    await waitFor('the follow-up to be transcribed', () => questionOf(rig) === QUESTION_TWO);
    await settleRun(rig);
    const after = spoken(rig);
    const stale = after.slice(before).filter((chunk) => chunk.id.startsWith(`${stream}#`));
    evidence('the follow-up:', `"${questionOf(rig)}"`);
    evidence('answered:', `"${answerOf(rig)}"`);
    evidence(
      'observations in the whole trace:',
      `${String(rig.observation.metrics().observations)} ` +
        `(the follow-up was answered without a second look)`,
    );
    evidence('stale chunks of the old answer spoken after the stop:', String(stale.length));
    say('     the new answer, as the synthesiser received it:');
    for (const chunk of after.slice(before)) {
      say(`       ${chunk.id}  "${chunk.text}"`);
    }
    evidence(
      'the new chunks, joined:',
      sameWords(
        after
          .slice(before)
          .map((chunk) => chunk.text)
          .join(' '),
        ANSWER_TWO,
      )
        ? 'exactly the answer on screen'
        : 'NOT the answer on screen',
    );
    say();

    say('   the state path, read off the one view stream the panel renders:');
    say(`     ${panel.states.join(' → ')}`);
    say('   the mvp-01 §7 rows this trace actually walked — each one read back');
    say('   out of that path as a consecutive pair, not asserted from a comment:');
    for (const [from, event, to] of MVP_TRANSITIONS) {
      const walked = panel.states.some(
        (state, index) => state === from && panel.states[index + 1] === to,
      );
      say(
        `     ${`${from} + ${event}`.padEnd(48)}→ ${to.padEnd(18)}` +
          `${walked ? 'walked' : 'NOT WALKED'}`,
      );
    }
    say('   (the two §7 rows this trace does not walk are `pause` — that is');
    say('    `pnpm demo:observe` §4 — and a recoverable failure reaching `error`,');
    say('    which is `pnpm demo:talk` §5.)');
    say();

    // -----------------------------------------------------------------------
    // 2 — the invariants, on this same trace
    // -----------------------------------------------------------------------
    say('2. the invariants every earlier PR established, checked on THIS trace');
    say('-'.repeat(72));
    const everySent = JSON.stringify(model.requests);

    say('   a. selected-window-only (§9, §14, A-01)');
    const captureCalls = rig.wire.filter(
      (call) => call.op === 'capture.start' || call.op === 'capture.pull',
    );
    evidence(
      'capture ops:',
      `${String(captureCalls.length)} — every windowNumber: ` +
        `${[
          ...new Set(
            rig.wire
              .filter((call) => call.op === 'capture.start')
              .map((call) => String(call.payload['windowNumber'])),
          ),
        ].join(', ')}`,
    );
    evidence('frames the ring held when the model looked:', `windowId ${ringWindows.join(', ')}`);
    evidence(
      'frames it holds now:',
      `${String(rig.observation.core.frames.records().length)} — the ring is bounded to ` +
        `${String(MVP_SCREEN_POLICY.ringDurationMs)} ms and the trace outlived it`,
    );
    evidence(
      'the other window’s title anywhere in the prompt:',
      String(everySent.includes(DEMO_WINDOWS[1].title)),
    );
    say('     (there is no whole-display request to make: observe_screen takes');
    say('      `view` and `moment` and nothing else.)');
    say();

    say('   b. the capability gate ran before anything was sent (§12, A-11)');
    evidence(
      'gate:',
      rig.agent.capability.ok
        ? `passed — vision=${String(rig.agent.capability.report.vision)} ` +
            `tools=${String(rig.agent.capability.report.tools)}`
        : 'refused',
    );
    evidence(
      'tool registered:',
      'observe_screen — only reachable because the gate passed (PR-020/PR-021)',
    );
    say();

    say('   c. no image bytes to disk or to a log line (§13, A-14)');
    // The strongest form of the check: take the base64 the provider actually
    // received and look for *those very bytes* anywhere a log line went.
    let marker: string | null = null;
    for (const request of model.requests) {
      const found = /"data":"([A-Za-z0-9+/=]{200,})"/.exec(request);
      if (found?.[1] !== undefined) {
        marker = found[1].slice(0, 48);
      }
    }
    const logged = JSON.stringify(sink.records);
    evidence('log records emitted at debug level:', String(sink.records.length));
    evidence(
      'the base64 the model received, in any log line:',
      marker === null ? 'NO IMAGE WAS SENT — nothing to look for' : String(logged.includes(marker)),
    );
    evidence('any base64-shaped run in any log line:', String(BASE64_RUN.test(logged)));
    evidence('any data: URI in any log line:', String(logged.includes('data:image')));
    const filesAfter = listTree(REPO_ROOT);
    const created = filesAfter.filter((path) => !filesBefore.includes(path));
    evidence(
      'files created under the repository:',
      created.length === 0 ? '0' : created.join(', '),
    );
    say('     (the logger redacts by key *and* by shape — packages/shared/src/');
    say('      logging.ts — so what this reads is that the rule was never even');
    say('      approached, not that a redactor caught something. The file check is');
    say('      a whole-tree diff, not an fs interception: it says nothing was');
    say('      written anywhere under the repository, and nothing about /tmp.)');
    say();

    say('   d. no accessibility target outside the selected window (§9, §14)');
    const samples = rig.wire.filter((call) => call.op === 'accessibility.sample');
    const elementAt = rig.wire.filter((call) => call.op === 'accessibility.element-at');
    evidence(
      'accessibility.sample:',
      samples
        .map(
          (call) =>
            `ownerPid=${String(call.payload['ownerPid'] ?? 'UNSCOPED')}` +
            `/includeElement=${String(call.payload['includeElement'] ?? false)}`,
        )
        .join(' '),
    );
    evidence(
      'accessibility.element-at:',
      elementAt.length === 0
        ? 'never sent'
        : elementAt
            .map((call) => `ownerPid=${String(call.payload['ownerPid'] ?? 'UNSCOPED')}`)
            .join(' '),
    );
    evidence('pointer samples the wire carried:', String(samples.length));
    evidence('elements retained beside them:', String(rig.observation.metrics().pointerTargets));
    evidence(
      'the outside element’s label anywhere in the prompt:',
      String(everySent.includes('Another desktop entirely')),
    );
    evidence(
      'the stacked window’s label anywhere in the prompt:',
      String(everySent.includes('Private release notes')),
    );
    say('     (Read that first row against `MacAccessibilityAdapter.groundFast`.');
    say('      Sample 1 is the first of the session, so it asks — and the pointer');
    say('      turns out to be *outside* the window, so `groundPointer` throws the');
    say('      element away. Sample 2 is told not to ask, because sample 1 was');
    say('      outside; the pointer is now inside the frame but over another');
    say('      application’s window, so one follow-up `element-at` is issued —');
    say('      runbook follow-up 30 — scoped to the selected window’s ownerPid,');
    say('      and the foreign element is discarded again. Samples 3 and 4 are on');
    say('      the button and are the two elements retained. Every request carries');
    say('      ownerPid=501: without it both of PR-013’s defences are inert, which');
    say('      is the defect PR-031 found in PR-028’s wiring.)');
    say();

    say('   e. the unknown-pointer sentinel never reaches the model (follow-ups 1, 2)');
    evidence('"-1.000" anywhere in any request:', String(everySent.includes('-1.000')));
    evidence(
      'every question in this trace was anchored:',
      String(rig.anchoring.lastSkip() === null),
    );
    say('     (`QuestionEnvelope.pointer` is a required numeric pair, so "unknown"');
    say('      is the sentinel -1,-1; `renderAnchoredQuestionEnvelope` turns it');
    say('      into words. `pnpm demo:ask` §6 asks a question with no pointer at');
    say('      all and reads the same absence.)');
    say();

    say('   f. the §16 text fallback is reachable from every state this trace hit');
    evidence(
      'states visited:',
      [...new Set(panel.states)]
        .map(
          (state) =>
            `${state}=${isTextFallbackAvailable(state as PilotViewState['state']) ? 'yes' : 'NO'}`,
        )
        .join(' '),
    );
    say('     (only `needs-permission` and `paused` deny a typed question, and this');
    say('      trace visited neither. Section 3 types one for real, in the state a');
    say('      refused push-to-talk leaves the user in.)');
    say();

    // -----------------------------------------------------------------------
    // 3 — the newest frame, and what the answer was grounded on
    // -----------------------------------------------------------------------
    say('   g. the answer was grounded on the question-time frame, not the newest');
    await pushScreenshot(rig, window, {
      id: 'frame-later',
      capturedAt: Date.now(),
      toggleOn: true,
    });
    const answeredFrom = observed?.frames[0];
    const newest = rig.observation.core.frames.records().at(-1);
    evidence('answered from:', `capturedAt=${String(answeredFrom?.capturedAt)}`);
    evidence('newest in the ring now:', `capturedAt=${String(newest?.frame.capturedAt)}`);
    evidence(
      'the ring moved on:',
      String((newest?.frame.capturedAt ?? 0) > (answeredFrom?.capturedAt ?? 0)),
    );
    say();
  } finally {
    panel.stop();
    await rig.dispose();
  }

  // -------------------------------------------------------------------------
  // 4 — a refusal that leaves the user able to continue
  // -------------------------------------------------------------------------
  say('3. a refusal, and the flow the user is left with (§14, §15, §16)');
  say('-'.repeat(72));
  say('   The refusal chosen here is the plan’s top structural risk: macOS credits');
  say('   Pilot’s grants to the *helper* rather than to Pilot. Every permission');
  say('   reads `granted` and neither half of this flow may proceed on it — the tap');
  say('   is never installed (a microphone the grant does not reach would hear');
  say('   silence), and the §10 conditions read `denied` so no image is ever made.');
  say('   What PR-034 has to show is that the user is not stuck: the question can');
  say('   still be asked, the refusal reaches the model as something it can reason');
  say('   about, and the answer is still streamed and still spoken.');
  say();
  {
    const refusedModel = createScriptedModelSource({
      tokensPerSecond: TOKENS_PER_SECOND,
      script: [
        { observe: { view: 'both', moment: 'question' } },
        { say: 'I cannot see your screen, so I can only answer from what you told me.' },
      ],
    });
    const denied = await createObservationRig({
      stub: {
        permissions: GRANTED,
        desktop: DEMO_DESKTOP,
        axElements: AX_ELEMENTS,
        captureFrameBytes: 3_072,
        captureScaleFactor: 2,
        pointer: OVER_THE_BUTTON,
        // macOS holds the helper responsible, not the application.
        attribution: { responsibleProcessPid: 4321 },
        hotkeyScripts: [[{ key: 'down' }, { key: 'up' }]],
      },
      modelSource: refusedModel,
      recordRequests: true,
      capturePollIntervalMs: 3_600_000,
      speechPollIntervalMs: 60,
      logger,
    });
    try {
      await denied.permissions.refresh();
      await denied.observation.refreshAttribution();
      const target = await denied.firstWindow();
      await denied.windows.act({ type: 'select', windowId: target.windowId });
      await denied.controller.settled();
      await denied.observation.samplePointer();

      await denied.voice.start();
      const availability = denied.voice.availability();
      evidence(
        'permissions macOS reports:',
        `screen-recording=${String(
          denied.permissions.snapshot().snapshot?.['screen-recording'].state,
        )} microphone=${String(denied.permissions.snapshot().snapshot?.microphone.state)}`,
      );
      evidence(
        'attribution:',
        `${String(denied.voice.attribution()?.verdict)} ` +
          `(${String(denied.voice.attribution()?.reason)})`,
      );
      evidence('the push-to-talk tap was installed:', String(denied.voice.enabled));
      evidence('presses that became commands:', String(denied.voice.stats().downs));
      evidence(
        'what the panel tells the user:',
        `${availability.status}/${
          availability.status === 'unavailable' ? availability.reason : '—'
        } — "${String(hotkeyUnavailableMessage(availability))}"`,
      );
      evidence(
        'text fallback from here:',
        String(isTextFallbackAvailable(denied.controller.snapshot().state)),
      );
      say();
      say('     …so the user types the question instead:');
      denied.controller.dispatch({ type: 'submit-text', text: QUESTION_ONE });
      await settleRun(denied);
      const refusal = lastRequest(refusedModel);
      evidence('question:', `"${questionOf(denied)}"`);
      evidence(
        'observations allowed / refused:',
        `${String(denied.observation.metrics().observations)} / ` +
          `${String(denied.observation.metrics().refusals)}`,
      );
      evidence('what the tool handed the model:', String(refusal?.summary));
      evidence('images the provider received:', String(refusal?.images.length));
      evidence('answer:', `"${answerOf(denied)}"`);
      evidence(
        'spoken:',
        `${String(denied.speech.stats().accepted)} chunk(s) reached the synthesiser`,
      );
      evidence('state afterwards:', denied.controller.snapshot().state);
      evidence(
        'still able to ask again:',
        String(isTextFallbackAvailable(denied.controller.snapshot().state)),
      );
      say();
    } finally {
      await denied.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 5 — the acceptance matrix, honestly
  // -------------------------------------------------------------------------
  say('4. which of mvp-01 §18’s A-01…A-15 this trace evidences');
  say('-'.repeat(72));
  say('   PR-043 owns running the matrix on a Mac. This is what one Linux trace');
  say('   against the Node helper stub and Pi’s faux provider can and cannot say.');
  say();
  for (const [id, verdict, note] of [
    [
      'A-01',
      'partial',
      'only the selected window entered the ring — checked at the wire and by ' +
        'rejecting a frame stamped with the other window. No ScreenCaptureKit ran.',
    ],
    [
      'A-02',
      'no',
      'the answer identifies the target because the script says so. Whether a ' +
        'model reads the crop is unknown until a real one does.',
    ],
    [
      'A-03',
      'partial',
      'the follow-up was answered with no second observation — but the model ' +
        'did not decide that; the script did.',
    ],
    ['A-04', 'no', 'one pointer target in this trace; `pnpm demo:ask` §4 moves it.'],
    ['A-05', 'no', 'no transient tooltip; `pnpm demo:ask` §3 is the frame-selection case.'],
    ['A-06', 'no', '`before-and-after` is never requested here.'],
    ['A-07', 'no', 'pause and clearing are `pnpm demo:observe` §4.'],
    [
      'A-08',
      'partial',
      'the interruption stopped the synthesiser and no stale chunk followed — ' +
        'measured as a JSON round trip over a pipe, not as sound stopping.',
    ],
    ['A-09', 'no', 'Accessibility is granted throughout; the degraded mode is PR-013’s demo.'],
    [
      'A-10',
      'no',
      'Screen Recording is granted throughout; `pnpm demo:observe` §6a is the refusal.',
    ],
    [
      'A-11',
      'partial',
      'the gate ran before any request and passed. The refusing direction is ' +
        'PR-020’s suite, not this trace.',
    ],
    ['A-12', 'no', 'two turns is not a long conversation; that is PR-036.'],
    ['A-13', 'no', 'no restart, and the ConversationStore is not wired yet (PR-036).'],
    [
      'A-14',
      'partial',
      'every log record this trace emitted was scanned, and nothing was written ' +
        'to disk. A packaged app’s logs and session files are PR-041’s.',
    ],
    ['A-15', 'no', 'nothing packaged ran; that is PR-042 and a Mac.'],
  ] as const) {
    say(`   ${id}  ${verdict.padEnd(8)}${note}`);
  }
  say();

  // -------------------------------------------------------------------------
  // 6 — what was never executed
  // -------------------------------------------------------------------------
  say('5. what none of the above proves (docs/handoff.md §1, §2)');
  for (const [head, ...rest] of [
    [
      'NO MAC. The Swift helper has never been compiled, no ScreenCaptureKit',
      'stream has produced a pixel, no CGEventTap has been created, no',
      'AVAudioEngine or SFSpeechRecognizer has run, no AVSpeechSynthesizer has',
      'spoken, and no TCC prompt has ever appeared.',
    ],
    [
      'NOTHING WAS HEARD AND NOTHING WAS SAID ALOUD. Every partial and every',
      'final transcript above is a string the stub was handed, and every',
      'started/finished/stopped is its scripted synthesiser.',
    ],
    [
      'NO MODEL CHOSE ANYTHING. That observe_screen was called, with which view',
      'and which moment, is scripted. The two questions the product turns on —',
      'does a model look when it needs to, and does it answer about the thing',
      'you were pointing at — are untouched by this trace.',
    ],
    [
      'NO PIXEL WAS EVER ON A SCREEN. The decode, the crop, the resize and the',
      'encode are real; the subject is a synthetic screenshot.',
    ],
    [
      'THE TIMINGS ARE STUB TIMINGS. A JSON round trip over a pipe is not a',
      'window server, a recogniser or a speaker.',
    ],
  ]) {
    say(`   - ${String(head)}`);
    for (const line of rest) {
      say(`     ${line}`);
    }
  }

  return { lines };
}
