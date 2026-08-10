import { createScriptedModelSource, type ScriptedModelSource } from '@pilot/agent';
import {
  NULL_SCHEDULER,
  interruptModeFor,
  isTextFallbackAvailable,
  speechChunkId,
} from '@pilot/interaction';
import type { PilotViewState } from '@pilot/platform';
import {
  asSpeechId,
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
  OVER_THE_BUTTON,
  lastRequest,
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
import {
  BASE64_RUN,
  GRANTED,
  REPO_ROOT,
  answerOf,
  listTree,
  pressKey,
  questionOf,
  recordPanel,
  releaseKey,
  sameWords,
  spoken,
  waitFor,
  type PanelTrace,
} from './flow-demo.js';

/**
 * PR-035's demo: **end-to-end interruption.**
 *
 *     pnpm demo:interrupt-flow
 *
 * PR-034's trace already interrupts an answer that is being spoken and shows
 * that no chunk of it is spoken afterwards. That is the easy half. This
 * walkthrough is the hard half — the states where an interruption has something
 * to unwind rather than merely something to stop — and the design decision
 * PR-027 recorded and PR-034 declined to take (runbook §8 follow-up 14).
 *
 * Four sections, one per case, each through the shipping composition:
 *
 *  1. **while the model is looking** (`observing-screen`). The decision. A
 *     capture is genuinely in flight — `moment: "current"` goes to the platform
 *     for a fresh frame and the helper is told to take its time over it — and
 *     the new push-to-talk lands in the middle of it.
 *  2. **the abandoned run ends anyway**, after Pilot stopped waiting for it,
 *     and every terminal event it produces is discarded rather than shown.
 *  3. **two interruptions in quick succession**: three questions, two
 *     interruptions, one answer.
 *  4. **between `run-completed` and the first spoken word** — the window where
 *     the answer exists, the synthesiser has it, and not a syllable has been
 *     produced.
 *
 * Then, on the same runs: the three places late output could resurface and does
 * not (§6), the §17 interruption measurement and what it is *not* (§5), and the
 * invariants every earlier PR established (§7).
 *
 * ## The decision, in one paragraph (runbook §8 follow-up 14)
 *
 * PR-006 chose `steer` for `observing-screen` so an `observe_screen` call in
 * flight could unwind rather than be cut in half. With the real
 * `PiAgentSession` that is wrong in every direction, and section 1 shows why:
 * a steer does not end the run, so the replacement question meets
 * `run-already-active`; the steered run keeps producing output the machine has
 * already forgotten; and the capture it was supposed to protect *completes*,
 * putting an image of the screen into the model's context for a question the
 * user has replaced. Aborting is what unwinds it — the tool checks the run's
 * `AbortSignal` before it captures, `ScreenContextService` races the platform
 * capture against it, and `PiAgentSession.interrupt('abort')` waits for Pi's own
 * idle signal — so `interruptModeFor` now returns `abort` in every state.
 *
 * ## What is real, and what is not
 *
 * Real, and the shipping code: `PilotInteractionController` and its table,
 * `SpeechOutputBinding`, `MacHotkeyAdapter`, `MacSpeechInputAdapter`,
 * `MacSpeechOutputAdapter`, `MacObservationAdapter`, `MacAccessibilityAdapter`,
 * `MacWindowAdapter`, `NativeHelperTransport`, `ObservationSession`,
 * `PilotScreenContextService` and the §10 policy, `PiAgentSession`, Pi's agent
 * loop, `observe_screen`, `main/voice-runtime.ts` and `main/speech-runtime.ts`.
 *
 * **NO MAC, NO KEY, NO MICROPHONE, NO SPEAKER, NO MODEL.** Every key
 * transition, transcript, pointer position and speech callback comes from the
 * Node helper stub; the model is Pi's faux provider with its replies scripted.
 * In particular **"speech stopped" here is a JSON round trip over a pipe, not
 * sound ceasing in a room** — section 5 says so with the number beside it, and
 * section 8 says it again.
 */

export interface InterruptDemoResult {
  readonly lines: readonly string[];
}

const QUESTION_ONE = 'What is this?';
const FOLLOW_UP = 'And what does the other one do?';
const QUESTION_TWO = 'No wait, what is that?';
const QUESTION_THREE = 'And that one?';

const ANSWER_ONE =
  'That is the Update payment method button. ' +
  'It opens the billing sheet for this account. ' +
  'The card on file is charged when the plan renews.';
const ANSWER_TWO =
  'That is the plan name. It is the tier this account is on. ' +
  'Changing it is a separate flow from the payment method.';
const ANSWER_THREE = 'That is the renewal date. The plan renews on it every month.';
const ANSWER_FOLLOW_UP = 'That one cancels the plan at the end of the billing period.';

/**
 * Fast enough that a sentence completes well inside `DEFAULT_PHRASE_TIMEOUT_MS`
 * (1 200 ms) — otherwise the phrase timeout releases half a sentence and the
 * walkthrough reads as though the interruption truncated it — and slow enough
 * that an answer can still be interrupted while it is arriving.
 */
const TOKENS_PER_SECOND = 30;

/**
 * How long the helper is told to take over `capture.pull` in section 1.
 *
 * Long enough that a fresh capture is unmistakably *in flight* when the key
 * goes down, and comfortably inside both `DEFAULT_FRESH_CAPTURE_TIMEOUT_MS`
 * (1 500 ms) and the rig's 5 s request timeout, so an uninterrupted run of the
 * same script would not have timed out either.
 */
const CAPTURE_DELAY_MS = 1_200;

/**
 * Waits out a delay this demo itself configured.
 *
 * Not a sleep standing in for a state check: every wait on Pilot's own
 * behaviour is a bounded `waitFor` on observable state. This one waits for the
 * *helper* to finish a delay the stub was told to take, which no state of
 * Pilot's reflects — that is the point of section 1, where the answer must
 * arrive at a Pilot that has stopped waiting for it.
 */
async function waitOutHelperDelay(fromMs: number): Promise<void> {
  const until = fromMs + CAPTURE_DELAY_MS + 400;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Machine rejections, in the language the diagnostics stream uses. */
interface Recorded {
  readonly rejections: string[];
  readonly discards: string[];
  /** When `push-to-talk-down` was accepted, i.e. the instant of each interruption. */
  readonly interruptedAt: number[];
}

function record(rig: ObservationRig): Recorded {
  const rejections: string[] = [];
  const discards: string[] = [];
  const interruptedAt: number[] = [];
  rig.controller.subscribeRejections((rejection) => {
    rejections.push(`${rejection.input} in ${rejection.from}: ${rejection.reason}`);
  });
  rig.controller.subscribeVoiceDiagnostics((diagnostic) => {
    if (diagnostic.kind === 'discarded-chunk') {
      discards.push(
        `chunk #${String(diagnostic.sequence)} of ${diagnostic.speechId} ` +
          `(${String(diagnostic.characters)} chars): ${diagnostic.reason}`,
      );
    } else if (diagnostic.kind === 'discarded-speech-event') {
      discards.push(`${diagnostic.event} for ${diagnostic.speechId}: ${diagnostic.reason}`);
    }
  });
  // One extra fact beside `recordPanel`'s path, and the reason it is separate:
  // §17 wants *when* the interruption was accepted, and the view stream is the
  // only place that instant is observable from outside the controller. The
  // subscriber runs in the same synchronous turn as the command.
  let previous = rig.controller.snapshot().state;
  rig.controller.subscribe((view) => {
    if (view.state === 'listening' && previous !== 'listening') {
      interruptedAt.push(Date.now());
    }
    previous = view.state;
  });
  return { rejections, discards, interruptedAt };
}

/** Every image block any provider request in this run carried. */
function imagesSent(model: ScriptedModelSource): number {
  return (JSON.stringify(model.requests).match(/"type":"image"/g) ?? []).length;
}

interface Opened {
  readonly rig: ObservationRig;
  readonly window: ObservedWindow;
  readonly panel: PanelTrace;
  readonly recorded: Recorded;
}

async function open(
  stub: Record<string, unknown>,
  model: ScriptedModelSource,
  logger: Logger,
  options: Partial<ObservationRigOptions> = {},
): Promise<Opened> {
  const rig = await createObservationRig({
    stub: {
      permissions: GRANTED,
      desktop: DEMO_DESKTOP,
      axElements: AX_ELEMENTS,
      pointer: OVER_THE_BUTTON,
      captureFrameBytes: 3_072,
      captureScaleFactor: 2,
      ...stub,
    },
    modelSource: model,
    recordRequests: true,
    logger,
    // This walkthrough owns the ring, exactly as PR-034's does: a stub frame
    // landing between a pushed screenshot and the question anchored on it would
    // turn a decode into a failure that has nothing to do with interruption.
    capturePollIntervalMs: 3_600_000,
    speechPollIntervalMs: 60,
    ...options,
  });
  const panel = recordPanel(rig);
  const recorded = record(rig);
  await rig.permissions.refresh();
  await rig.observation.refreshAttribution();
  const window = await rig.firstWindow();
  await rig.windows.act({ type: 'select', windowId: window.windowId });
  await rig.controller.settled();
  await rig.observation.samplePointer();
  return { rig, window, panel, recorded };
}

/** `speech.output.stop` operations that crossed the wire after `since`. */
function stopsAfter(rig: ObservationRig, since: number): readonly number[] {
  return rig.wire
    .filter((call) => call.op === 'speech.output.stop' && call.at >= since)
    .map((call) => call.at);
}

/** Every assistant entry the panel holds, in order. */
function answers(rig: ObservationRig): readonly string[] {
  return rig.controller
    .snapshot()
    .transcript.filter((entry) => entry.role === 'assistant')
    .map((entry) => entry.text);
}

/**
 * Reads the wire back as streams, and says whether any of them spoke again
 * after a later one had started.
 *
 * That is the whole claim of an interruption at the synthesiser, and it is a
 * property of the *sequence*: a superseded stream is not allowed to interleave
 * with the one that replaced it, however the queues drained. Each stream's
 * chunks must also be `<speechId>#0`, `#1`, … in order (PR-026's identifiers,
 * PR-014's echo).
 */
function streamOrder(rig: ObservationRig): {
  readonly streams: readonly string[];
  readonly interleaved: readonly string[];
  readonly misnumbered: readonly string[];
} {
  const chunks = spoken(rig);
  const streams: string[] = [];
  const interleaved: string[] = [];
  const misnumbered: string[] = [];
  const counters = new Map<string, number>();
  for (const chunk of chunks) {
    const stream = chunk.id.split('#')[0] ?? '';
    if (!streams.includes(stream)) {
      streams.push(stream);
    } else if (streams[streams.length - 1] !== stream) {
      // It spoke, something else spoke, and then it spoke again.
      interleaved.push(chunk.id);
    }
    const next = counters.get(stream) ?? 0;
    if (chunk.id !== speechChunkId(asSpeechId(stream), next)) {
      misnumbered.push(chunk.id);
    }
    counters.set(stream, next + 1);
  }
  return { streams, interleaved, misnumbered };
}

export async function runInterruptFlowDemo(): Promise<InterruptDemoResult> {
  const lines: string[] = [];
  const say = (line = ''): void => {
    lines.push(line);
  };
  const evidence = (label: string, value: string): void => {
    say(`     ${label.padEnd(46)} ${value}`);
  };

  say('PR-035 — end-to-end interruption');
  say('='.repeat(72));
  say();
  say('A new push-to-talk stops the voice AND cancels the model run, in the');
  say('states where that is hard: while the model is looking at the screen,');
  say('while an abandoned run is still ending, twice in a row, and in the window');
  say('between an answer and its first spoken word. Late output may not resurface');
  say('in the panel, at the synthesiser, or in the diagnostics as a real event.');
  say();
  say('Real: PilotInteractionController and its table, SpeechOutputBinding, the');
  say('      mac adapters over NativeHelperTransport, ObservationSession,');
  say('      PilotScreenContextService and the §10 policy, PiAgentSession, Pi’s');
  say('      agent loop, observe_screen, main/voice-runtime.ts and');
  say('      main/speech-runtime.ts.');
  say('NOT REAL: no macOS, no key, no microphone, no speaker, no model. In');
  say('      particular “speech stopped” below is a JSON round trip over a pipe,');
  say('      not sound ceasing — sections 5 and 8 say so with the numbers.');
  say();

  const sink: LogSink & { readonly records: readonly LogRecord[] } = createMemorySink();
  const logger = createLogger({ scope: 'interrupt-demo', level: 'debug', sink });
  const filesBefore = listTree(REPO_ROOT);

  const models: ScriptedModelSource[] = [];
  const observingRejections: string[] = [];
  const speakingRejections: string[] = [];

  // -------------------------------------------------------------------------
  // 1 — interrupted while the model is looking
  // -------------------------------------------------------------------------
  say('1. INTERRUPTED WHILE THE MODEL IS LOOKING (observing-screen)');
  say('-'.repeat(72));
  say('   The design decision runbook §8 follow-up 14 left open, taken here and');
  say('   shown working. PR-006 chose `steer` for this state so a capture could');
  say('   unwind; PR-035 aborts instead. What that buys is the last two rows of');
  say('   this section: the capture really does unwind, and the replacement');
  say('   question really does start.');
  say();
  {
    const model = createScriptedModelSource({
      tokensPerSecond: TOKENS_PER_SECOND,
      // `moment: "current"` is the only request that goes to the platform for a
      // frame instead of taking one from the ring — so the tool call sits in
      // `observing-screen` for as long as the helper takes.
      script: [{ observe: { view: 'window', moment: 'current' } }, { say: ANSWER_ONE }],
    });
    models.push(model);
    const { rig, window, panel, recorded } = await open(
      {
        capturePullDelayMs: CAPTURE_DELAY_MS,
        hotkeyScripts: [[{ key: 'down' }], [{ key: 'up' }]],
        speechInput: {
          scripts: [
            {
              steps: [
                { on: 'start', emit: [{ type: 'partial', transcript: 'and what does' }] },
                { on: 'stop', emit: [{ type: 'final', transcript: FOLLOW_UP }] },
              ],
            },
          ],
        },
      },
      model,
      logger,
    );
    try {
      evidence(
        'the mode the table now chooses:',
        `interruptModeFor('observing-screen') = ${interruptModeFor(
          'observing-screen',
        )} (was 'steer' until PR-035)`,
      );
      await pushScreenshot(rig, window, { id: 'frame-question', capturedAt: Date.now() });
      const framesBefore = rig.observation.core.frames.records().length;
      const ingestedBefore = rig.observation.metrics().framesIngested;

      // The first question is typed — §16's fallback, and it keeps this section
      // about the interruption rather than about a second recogniser script.
      rig.controller.dispatch({ type: 'submit-text', text: QUESTION_ONE });
      await waitFor(
        'the model to call observe_screen',
        () => rig.controller.snapshot().state === 'observing-screen',
      );
      const toolStartedAt = Date.now();
      const pulls = rig.wire.filter((call) => call.op === 'capture.pull');
      evidence('state:', rig.controller.snapshot().state);
      evidence(
        'the capture in flight:',
        `capture.pull × ${String(pulls.length)} on the wire, helper told to take ` +
          `${String(CAPTURE_DELAY_MS)} ms over it`,
      );

      // The interruption: a real push-to-talk, through the tap.
      await pressKey(rig, false);
      const interruptedAt = recorded.interruptedAt[0] ?? Date.now();
      evidence('state after the press:', rig.controller.snapshot().state);
      evidence(
        'the run the machine was waiting for:',
        `activeRunId=${String(rig.controller.context.activeRunId)}`,
      );

      await waitFor(
        'the observation to unwind',
        () => rig.observation.metrics().refusals > 0,
        8_000,
      );
      const refusal = sink.records.find((entry) => entry.message === 'observation refused');
      evidence(
        'how the capture unwound:',
        `rule=${String(refusal?.fields['rule'])} step=${String(
          refusal?.fields['step'],
        )} code=${String(refusal?.fields['code'])}`,
      );
      evidence(
        'it unwound before the helper answered:',
        `${String((refusal?.timestamp ?? 0) - toolStartedAt)} ms after the tool call started, ` +
          `against a ${String(CAPTURE_DELAY_MS)} ms helper`,
      );
      evidence(
        'the interruption reached it in:',
        `${String((refusal?.timestamp ?? 0) - interruptedAt)} ms`,
      );

      // Now let the helper answer, into a Pilot that stopped waiting for it.
      await waitOutHelperDelay(toolStartedAt);
      evidence(
        'when the helper’s frame finally arrived:',
        `observations=${String(rig.observation.metrics().observations)} ` +
          `refusals=${String(rig.observation.metrics().refusals)} ` +
          `framesIngested=${String(rig.observation.metrics().framesIngested)} ` +
          `(was ${String(ingestedBefore)})`,
      );
      evidence(
        'frames in the ring:',
        `${String(rig.observation.core.frames.records().length)} (was ${String(framesBefore)})`,
      );
      evidence('image blocks any provider request carried:', String(imagesSent(model)));

      // …and the replacement question, which is the half a steer could not do.
      const abandonedRunAt = rig.controller.snapshot().state;
      model.setScript([{ say: ANSWER_FOLLOW_UP }]);
      await releaseKey(rig);
      await waitFor('the follow-up to be transcribed', () => questionOf(rig) === FOLLOW_UP);
      await settleRun(rig);
      evidence(
        'the replacement question:',
        `"${questionOf(rig)}" (its reply was queued while ${abandonedRunAt})`,
      );
      evidence('answered:', `"${answerOf(rig)}"`);
      evidence('what the abandoned tool call told the model:', String(lastRequest(model)?.summary));
      say('     (the record of the abandoned observation stays in the transcript,');
      say('      because it happened — but it says `cancelled` and carries no');
      say('      image. A steer would have put a picture of the screen there');
      say('      instead, for a question the user had already replaced.)');
      evidence(
        'run-already-active anywhere in this run:',
        String(
          JSON.stringify(sink.records).includes('run-already-active') ||
            recorded.rejections.some((entry) => entry.includes('run-already-active')),
        ),
      );
      evidence('lastError:', String(rig.controller.snapshot().lastError?.code ?? '(none)'));
      evidence('provider requests in the whole section:', String(model.requestCount()));
      say('     (two: the question that made it look, and the replacement. The');
      say('      abandoned run asked the provider for nothing more — a steered run');
      say('      would have gone on to answer the question the user replaced.)');
      say();
      evidence('the panel’s state path:', panel.states.join(' → '));
      observingRejections.push(...recorded.rejections);
      say();
    } finally {
      panel.stop();
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 2 — two interruptions in quick succession
  // -------------------------------------------------------------------------
  say('2. TWO INTERRUPTIONS IN QUICK SUCCESSION, AND THE §17 MEASUREMENT');
  say('-'.repeat(72));
  say('   Three questions, two interruptions, one answer. Each press lands while');
  say('   the previous answer is being spoken, so each one has both halves to do:');
  say('   stop the voice, and stop the run.');
  say();
  const stopMeasurements: string[] = [];
  {
    const model = createScriptedModelSource({
      tokensPerSecond: TOKENS_PER_SECOND,
      script: [{ say: ANSWER_ONE }],
    });
    models.push(model);
    const { rig, panel, recorded } = await open(
      {
        hotkeyScripts: [[{ key: 'down' }], [{ key: 'up' }], [{ key: 'down' }], [{ key: 'up' }]],
        // A synthesiser that takes time over a sentence: the first two
        // utterances start and are still speaking when the key goes down, so
        // each interruption really does reach a chunk in flight *and* the
        // sentences queued behind it. The third utterance completes, because
        // the last answer is the one nobody interrupts.
        speechOutput: {
          scripts: [
            [{ type: 'started' }],
            [{ type: 'started' }],
            [{ type: 'started' }, { type: 'finished' }],
          ],
        },
        speechInput: {
          scripts: [
            { steps: [{ on: 'stop', emit: [{ type: 'final', transcript: QUESTION_TWO }] }] },
            { steps: [{ on: 'stop', emit: [{ type: 'final', transcript: QUESTION_THREE }] }] },
          ],
        },
      },
      model,
      logger,
    );
    try {
      const measurements: string[] = [];
      /** What the panel showed of each abandoned answer at the moment it was cut off. */
      const cutOffAt: string[] = [];
      rig.controller.dispatch({ type: 'submit-text', text: QUESTION_ONE });

      for (const [index, next] of [ANSWER_TWO, ANSWER_THREE].entries()) {
        const spokenBefore = spoken(rig).length;
        // Three conditions, and each one is the difference between an
        // interruption that proves something and one that does not: the chunk
        // is on the wire, the machine is in `speaking` (so the press lands on
        // the mvp-01 §7 row `speaking + new push-to-talk`), and a *further*
        // sentence is already queued behind the one being spoken — the chunk
        // that must be dropped rather than spoken later.
        await waitFor(
          `answer ${String(index + 1)} to be spoken with another sentence behind it`,
          () =>
            spoken(rig).length > spokenBefore &&
            rig.controller.snapshot().state === 'speaking' &&
            rig.controller.pendingSpeechChunks > 0,
        );
        const interrupting = answerOf(rig);
        cutOffAt.push(interrupting);
        const from = rig.controller.snapshot().state;
        const pendingBehind = rig.controller.pendingSpeechChunks;
        const stopsBefore = rig.speech.stats().stops;
        await pressKey(rig, index > 0);
        await waitFor(
          'the synthesiser to be told to stop',
          () => rig.speech.stats().stops > stopsBefore,
        );
        const acceptedAt = recorded.interruptedAt[index] ?? 0;
        const stopAt = stopsAfter(rig, acceptedAt)[0] ?? 0;
        measurements.push(
          `#${String(index + 1)}: push-to-talk-down accepted → speech.output.stop handed to ` +
            `the transport: ${String(stopAt - acceptedAt)} ms`,
        );
        evidence(
          `interruption ${String(index + 1)}:`,
          `pressed in "${from}", stopped an answer ${String(interrupting.length)} characters ` +
            `into it, with ${String(pendingBehind)} sentence(s) queued behind the one the ` +
            `synthesiser was speaking`,
        );
        // Queued while the machine is listening and before the release that
        // submits the question — runbook cross-lane issue 16.
        model.setScript([{ say: next }]);
        await releaseKey(rig);
      }
      await waitFor(
        'the last question to be transcribed',
        () => questionOf(rig) === QUESTION_THREE,
      );
      await settleRun(rig);

      const order = streamOrder(rig);
      evidence('questions asked:', '3');
      evidence('answers on screen:', String(answers(rig).length));
      say('     what actually reached the synthesiser, in order:');
      for (const chunk of spoken(rig)) {
        say(`       ${chunk.id}  "${chunk.text}"`);
      }
      const lastStream = order.streams[order.streams.length - 1] ?? '';
      const lastChunks = spoken(rig).filter((chunk) => chunk.id.startsWith(`${lastStream}#`));
      evidence(
        'the last answer, spoken whole:',
        sameWords(lastChunks.map((chunk) => chunk.text).join(' '), ANSWER_THREE)
          ? 'exactly the answer on screen'
          : 'NOT the answer on screen',
      );
      evidence(
        'a superseded stream speaking again:',
        order.interleaved.length === 0
          ? `never — ${String(order.streams.length)} streams, each one contiguous`
          : `A SUPERSEDED STREAM SPOKE AGAIN: ${order.interleaved.join(', ')}`,
      );
      evidence(
        'chunk identifiers off the wire:',
        order.misnumbered.length === 0
          ? 'every one is speechChunkId(stream, n), in order'
          : `NOT speechChunkId: ${order.misnumbered.join(', ')}`,
      );
      // The panel half of the same claim, and the one a user would notice:
      // each abandoned answer must still read exactly as far as it got.
      const finalAnswers = answers(rig);
      evidence(
        'the abandoned answers on screen:',
        cutOffAt
          .map((text, index) =>
            finalAnswers[index] === text
              ? `#${String(index + 1)} unchanged (${String(text.length)} chars)`
              : `#${String(index + 1)} CHANGED AFTER THE INTERRUPTION`,
          )
          .join(', '),
      );
      evidence('lastError:', String(rig.controller.snapshot().lastError?.code ?? '(none)'));
      evidence('the panel’s state path:', panel.states.join(' → '));
      evidence('the panel’s speaking bit:', panel.speakingEdges.join(' → '));
      say();
      // Read after everything has settled, so it is a completed round trip and
      // not a counter caught mid-call.
      measurements.push(
        `the adapter’s own round trip on the last stop, measured inside ` +
          `main/speech-runtime.ts: ${String(rig.speech.stats().lastStopMs)} ms`,
      );
      say('   the §17 measurement (see section 5 for what it is not):');
      for (const measurement of measurements) {
        say(`     ${measurement}`);
      }
      stopMeasurements.push(...measurements);
      speakingRejections.push(...recorded.rejections);
      say();
      say('   what the abandoned runs did after Pilot stopped waiting for them:');
      for (const rejection of recorded.rejections) {
        say(`     ${rejection}`);
      }
      if (recorded.discards.length > 0) {
        say('   what the speech binding refused to hand over:');
        for (const discard of recorded.discards) {
          say(`     ${discard}`);
        }
      }
      say();
    } finally {
      panel.stop();
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 3 — between `run-completed` and the first spoken word
  // -------------------------------------------------------------------------
  say('3. INTERRUPTED BETWEEN `run-completed` AND THE FIRST SPOKEN WORD');
  say('-'.repeat(72));
  say('   The narrowest window there is. The model’s answer has no sentence');
  say('   terminator in it and this rig passes NULL_SCHEDULER, so nothing is');
  say('   speakable until the run ends — PR-026’s behaviour exactly. At');
  say('   `run-completed` the machine mints the stream, hands the whole answer');
  say('   over as one chunk and enters `speaking`; the stub’s synthesiser is');
  say('   scripted to accept that first utterance and never begin it, which is');
  say('   an AVSpeechSynthesizer with the utterance queued and the audio device');
  say('   not yet open. The key goes down there.');
  say();
  {
    const model = createScriptedModelSource({
      tokensPerSecond: 40,
      script: [{ say: 'It looks like the button that updates the payment method' }],
    });
    models.push(model);
    const { rig, panel, recorded } = await open(
      {
        hotkeyScripts: [[{ key: 'down' }], [{ key: 'up' }]],
        // First utterance: accepted, never started. Later ones behave.
        speechOutput: { scripts: [[], [{ type: 'started' }, { type: 'finished' }]] },
        speechInput: {
          scripts: [{ steps: [{ on: 'stop', emit: [{ type: 'final', transcript: FOLLOW_UP }] }] }],
        },
      },
      model,
      logger,
      { scheduler: NULL_SCHEDULER },
    );
    try {
      rig.controller.dispatch({ type: 'submit-text', text: QUESTION_ONE });
      await waitFor(
        'the answer to be complete and in the synthesiser’s hands',
        () => rig.controller.snapshot().state === 'speaking' && rig.speech.stats().accepted >= 1,
      );
      const abandoned = spoken(rig);
      evidence('state:', rig.controller.snapshot().state);
      evidence('the run:', `activeRunId=${String(rig.controller.context.activeRunId)} — it ended`);
      evidence(
        'the speech stream:',
        `activeSpeechId=${String(rig.controller.context.activeSpeechId)}`,
      );
      evidence(
        'handed to the synthesiser:',
        `${String(abandoned.length)} utterance(s), accepted=${String(
          rig.speech.stats().accepted,
        )}: ${abandoned.map((chunk) => chunk.id).join(', ')}`,
      );
      evidence(
        'begun by the synthesiser:',
        `nothing — had a "started"/"finished" pair arrived, the stream would have ` +
          `drained and the machine would have left "speaking" for "observing" ` +
          `(the run is already over). It is still ${rig.controller.snapshot().state}.`,
      );
      evidence('the answer on screen:', `"${answerOf(rig)}"`);

      const stopsBefore = rig.speech.stats().stops;
      model.setScript([{ say: ANSWER_FOLLOW_UP }]);
      await pressKey(rig, false);
      await waitFor(
        'the synthesiser to be told to stop',
        () => rig.speech.stats().stops > stopsBefore,
      );
      evidence('state after the press:', rig.controller.snapshot().state);
      await releaseKey(rig);
      await waitFor('the follow-up to be transcribed', () => questionOf(rig) === FOLLOW_UP);
      await settleRun(rig);

      const after = spoken(rig);
      const stale = after
        .slice(abandoned.length)
        .filter((chunk) =>
          abandoned.some((old) => chunk.id.split('#')[0] === old.id.split('#')[0]),
        );
      evidence('the follow-up:', `"${questionOf(rig)}"`);
      evidence('answered:', `"${answerOf(rig)}"`);
      evidence('chunks of the abandoned answer spoken after the stop:', String(stale.length));
      evidence(
        'the abandoned answer’s text, still on screen:',
        String(
          rig.controller
            .snapshot()
            .transcript.some((entry) => entry.text.startsWith('It looks like the button')),
        ),
      );
      say('     (§16 in the smallest possible form: nothing was heard, and the');
      say('      text the user could read is untouched.)');
      evidence('lastError:', String(rig.controller.snapshot().lastError?.code ?? '(none)'));
      evidence('the panel’s state path:', panel.states.join(' → '));
      if (recorded.discards.length > 0) {
        say('     what the speech binding refused to hand over:');
        for (const discard of recorded.discards) {
          say(`       ${discard}`);
        }
      }
      say();
    } finally {
      panel.stop();
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 4 — where the abandoned runs ended
  // -------------------------------------------------------------------------
  say('4. WHERE THE ABANDONED RUNS ENDED');
  say('-'.repeat(72));
  say('   A run does not stop because Pilot stopped listening: it ends a moment');
  say('   later, on its own terms, and something has to decide where that goes.');
  say('   `InteractionMachine.staleReason` is that decision, and it runs *before*');
  say('   the transition table — so a terminal event for a run the machine has');
  say('   forgotten can never reach a rule and can never produce an effect.');
  say();
  say('   what the abandoned run of section 1 (a cancelled tool call) produced:');
  for (const rejection of observingRejections) {
    say(`     ${rejection}`);
  }
  say('   what the abandoned runs of section 2 (a cancelled stream) produced:');
  for (const rejection of speakingRejections) {
    say(`     ${rejection}`);
  }
  say();
  say('   Read the `run-failed` row twice. Its cell in the table goes to `error`,');
  say('   runs `teardown()` and writes `lastError` — so had the identity guard');
  say('   not rejected it first, interrupting a question mid-observation would');
  say('   have shown the user a failure for a question they had already replaced.');
  say('   The guard is why `lastError` reads `(none)` in every section above.');
  say();
  say('   Note what a real PiAgentSession does *not* produce: `run-completed`.');
  say('   Pi marks an aborted turn, so an interrupted run ends as `run-aborted`');
  say('   (its stream was cancelled) or `run-failed` (its tool call was). The');
  say('   third shape — a provider that had already written the rest of the');
  say('   answer and completes anyway, which `docs/pi-notes.md` says Pi reports');
  say('   as a final assistant message — needs a provider that ignores the abort;');
  say('   it is pinned against `InterruptibleAgentSession` in');
  say('   `packages/interaction/test/interruption.test.ts` ("a run that finishes');
  say('   after it was abandoned"). All three land on the same guard.');
  say();

  // -------------------------------------------------------------------------
  // 5 — the timing, and what it is not
  // -------------------------------------------------------------------------
  say('5. THE INTERRUPTION TIMING, AND WHAT IT DOES NOT MEASURE');
  say('-'.repeat(72));
  for (const measurement of stopMeasurements) {
    say(`   ${measurement}`);
  }
  say();
  say('   What that number IS: the time from the machine accepting');
  say('   `push-to-talk-down` to `speech.output.stop` being handed to the');
  say('   transport — the teardown, the urgent effect queue (`stop-speech` is');
  say('   performed off the ordinary queue precisely so it cannot wait behind a');
  say('   capture or an envelope build), `SpeechOutputBinding.stop`, and');
  say('   `main/speech-runtime.ts`. It is Pilot’s half of §17’s 300 ms.');
  say();
  say('   What it IS NOT, and this matters more than the number:');
  say('     - it is not sound stopping. No AVSpeechSynthesizer has ever run here.');
  say('       On a Mac, everything after this point — the helper dispatching to');
  say('       `stopSpeaking(at: .immediate)`, the synthesiser draining, the audio');
  say('       device going quiet — is unmeasured, and it is the part a person in');
  say('       the room would actually hear.');
  say('     - the far end is a Node process on the same machine reading a pipe,');
  say('       not a Swift helper doing audio work.');
  say('     - it is one run on an idle Linux box. Under load it is a different');
  say('       number, which is why no test asserts it (runbook cross-lane issue 7).');
  say('   §17 is verified on a Mac, by ear, in `docs/handoff.md` §1 step 15.');
  say();

  // -------------------------------------------------------------------------
  // 6 — the three places late output could resurface
  // -------------------------------------------------------------------------
  say('6. THE THREE PLACES LATE OUTPUT COULD RESURFACE');
  say('-'.repeat(72));
  say('   PR-027 proved this against fakes. These are the same three claims read');
  say('   off the shipping composition, in the sections above:');
  say();
  say('   a. the panel transcript — read from the one `PilotViewState` stream the');
  say('      renderer subscribes to. Every section prints the answer on screen');
  say('      after the interruption; none of them gained a word of an abandoned');
  say('      answer, and none of them lost one either (§16).');
  say('   b. the synthesiser — read from `speech.output.speak` *off the framed');
  say('      stdio wire*, not from an intention. Sections 2 and 3 count the chunks');
  say('      of a superseded stream that crossed it after its stop: 0.');
  say('   c. the diagnostics — a discarded result is reported through the');
  say('      rejection stream (section 4) and the binding’s own discard log, and');
  say('      is never written to `lastError`. `lastError` reads `(none)` in every');
  say('      section, including the one whose abandoned run ended in `run-failed`.');
  say();

  // -------------------------------------------------------------------------
  // 7 — the earlier invariants, on these runs
  // -------------------------------------------------------------------------
  say('7. THE EARLIER INVARIANTS, ON THESE RUNS');
  say('-'.repeat(72));
  const everySent = JSON.stringify(models.map((model) => model.requests));
  const logged = JSON.stringify(sink.records);
  const filesAfter = listTree(REPO_ROOT);
  const created = filesAfter.filter((path) => !filesBefore.includes(path));
  evidence(
    'selected-window-only:',
    `the other window’s title anywhere in any prompt: ${String(
      everySent.includes(DEMO_WINDOWS[1].title),
    )}`,
  );
  // The labels are not spelled out here on purpose: nothing belonging to
  // another application may appear anywhere at all, including in this demo's
  // own output (§9, §14). `pnpm demo:flow` §2d makes the same check the same way.
  evidence(
    'no foreign accessibility label:',
    `the stacked window’s label anywhere in any prompt: ` +
      `${String(everySent.includes('Private release notes'))}; the label outside the ` +
      `window: ${String(everySent.includes('Another desktop entirely'))}`,
  );
  evidence(
    'the capability gate:',
    'ran in every PiAgentSession constructor before a tool was registered',
  );
  evidence('log records emitted at debug level:', String(sink.records.length));
  evidence('any base64-shaped run in any log line:', String(BASE64_RUN.test(logged)));
  evidence('any data: URI in any log line:', String(logged.includes('data:image')));
  evidence('files created under the repository:', created.length === 0 ? '0' : created.join(', '));
  evidence(
    'the unknown-pointer sentinel:',
    `"-1.000" in any request: ${String(everySent.includes('-1.000'))}`,
  );
  evidence(
    '§16 text fallback:',
    ['listening', 'thinking', 'speaking', 'observing-screen', 'error']
      .map(
        (state) =>
          `${state}=${isTextFallbackAvailable(state as PilotViewState['state']) ? 'yes' : 'NO'}`,
      )
      .join(' '),
  );
  evidence(
    'the §10 policy in force throughout:',
    `fullFrameMaxEdge=${String(MVP_SCREEN_POLICY.fullFrameMaxEdge)} ` +
      `maxActiveFullFrames=${String(MVP_SCREEN_POLICY.maxActiveFullFrames)} ` +
      `persistRawFrames=${String(MVP_SCREEN_POLICY.persistRawFrames)}`,
  );
  say('     (section 1 is the interesting row here: an interrupted observation');
  say('      produced no image at all, so the strongest statement about image');
  say('      bytes on this run is that there were none to leak. `pnpm demo:flow`');
  say('      §2c makes the same check on a trace where an image *was* sent.)');
  say();
  const withImages = models.filter((model) => imagesSent(model) > 0).length;
  evidence('sections whose provider requests carried an image:', String(withImages));
  say();

  // -------------------------------------------------------------------------
  // 8 — what none of this proves
  // -------------------------------------------------------------------------
  say('8. WHAT NONE OF THE ABOVE PROVES (docs/handoff.md §1, §2)');
  for (const [head, ...rest] of [
    [
      'NOTHING WAS SPOKEN AND NOTHING WAS SILENCED. “The synthesiser was told to',
      'stop” is a JSON frame reaching a Node process over a pipe. No',
      'AVSpeechSynthesizer has been constructed, no audio device opened, and no',
      'sound has ever been produced or stopped by any of this.',
    ],
    [
      'NO KEY WAS PRESSED. Every interruption above is the Node helper stub',
      'playing a scripted `hotkey.key` transition. No CGEventTap exists.',
    ],
    [
      'NO MODEL WAS INTERRUPTED. Pi’s faux provider is what the abort reached.',
      'Whether a real provider stops billing, stops streaming, or finishes the',
      'turn anyway is unknown until a sign-in happens (handoff §2).',
    ],
    [
      'NO PIXEL WAS CANCELLED. The capture that section 1 unwinds is the stub',
      'holding a `capture.pull` open. ScreenCaptureKit has never run.',
    ],
    ['THE TIMINGS ARE STUB TIMINGS, on an idle machine, once. See section 5.'],
  ]) {
    say(`   - ${String(head)}`);
    for (const line of rest) {
      say(`     ${line}`);
    }
  }

  return { lines };
}
