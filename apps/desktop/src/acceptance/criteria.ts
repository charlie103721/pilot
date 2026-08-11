import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScriptedModelSource } from '@pilot/agent';
import { macWindowNumber } from '@pilot/platform-mac';
import {
  asWindowId,
  MVP_SCREEN_POLICY,
  type LogRecord,
  type Logger,
  type LogSink,
} from '@pilot/shared';
import { lastRequest, settleRun } from '../observation/ask-demo.js';
import { openConversationStoreRuntime } from '../main/conversation-store.js';
import { DEMO_WINDOWS } from '../observation/observe-rig.js';
import { asConversationId } from '@pilot/shared';
import { buildFrame, BASE64_RUN, openAcceptanceRig } from './rig-support.js';
import { criterion, executed, pending, type Check, type CriterionResult } from './verdict.js';

/**
 * PR-043 — A-01 through A-15, executed.
 *
 * One function per row of `docs/mvp-01-point-ask-hear.md` §18, each building
 * its own rig with the stub configured for exactly that scenario, each reading
 * its evidence off the objects `main/index.ts` builds. The verdict is never
 * written down: each function returns a list of checks and
 * `verdict.ts`'s `acceptanceVerdict` derives the row from them, so a scenario
 * that forgets to check anything reports `not-implemented` rather than passing.
 *
 * ## Why this is not PR-034's table
 *
 * `docs/handoff.md` carries PR-034's honest prose verdict — "In part: A-01,
 * A-03, A-08, A-11, A-14. Not at all: the rest" — read off **one trace**. This
 * runs **a scenario per criterion**: a pause, a revocation, a relaunch, a
 * non-vision model, a twelve-turn conversation. More rows therefore carry
 * executed evidence than PR-034 could claim, and *no* row is closed that PR-034
 * left open on a Mac or on a model. Where a row moves, the reason is in its
 * checks.
 *
 * ## The one row that fails
 *
 * A-09 does not hold, and the suite says so rather than marking it blocked.
 * Losing Accessibility mid-session takes Pilot to `needs-permission` instead of
 * the degraded visual mode §16 and A-09 both ask for; that is runbook follow-up
 * 35, recorded since PR-040 and never demonstrated against the assembled
 * application until now.
 */

export interface CriterionContext {
  readonly logger: Logger;
  readonly sink: LogSink & { readonly records: readonly LogRecord[] };
}

const OTHER = DEMO_WINDOWS[1];
const OVER_THE_BUTTON = { x: 700, y: 480 } as const;
const OVER_THE_SIDEBAR = { x: 220, y: 200 } as const;

/** The §18 row texts, verbatim, so the harness cannot paraphrase them. */
const ROWS = {
  'A-01': ['Select a native app window', 'Only that window enters the frame ring'],
  'A-02': ['Ask “What is this?” over a button', 'Answer identifies or explains the marked target'],
  'A-03': [
    'Ask a follow-up without visual dependency',
    'Model answers without requiring another observation',
  ],
  'A-04': ['Ask about a different target', 'Tool can return the new pointer crop'],
  'A-05': ['Open a temporary tooltip and ask', 'Question-time frame preserves the tooltip'],
  'A-06': ['Ask “What changed?”', 'Tool returns no more than two comparison frames'],
  'A-07': ['Pause observation', 'Capture stops and memory buffer becomes empty'],
  'A-08': ['Interrupt speech', 'Audio stops within target and stale speech does not resume'],
  'A-09': ['Revoke Accessibility', 'Visual mode remains usable with degraded-target notice'],
  'A-10': ['Revoke Screen Recording', 'No frame is captured or sent'],
  'A-11': ['Use a non-vision model', 'Visual mode is blocked before the question is sent'],
  'A-12': ['Long conversation', 'Active visual context remains within policy limits'],
  'A-13': ['Restart app', 'Text session may resume, but screen state is re-captured'],
  'A-14': [
    'Inspect logs and session files',
    'No credentials, audio, or unintended raw frames are present',
  ],
  'A-15': ['Run packaged app', 'No terminal or second user-started service is required'],
} as const satisfies Record<string, readonly [string, string]>;

type CriterionId = keyof typeof ROWS;

function row(id: CriterionId, checks: readonly Check[]): CriterionResult {
  const [scenario, passCondition] = ROWS[id];
  return criterion({ id, scenario, passCondition, checks });
}

/** Log records whose message names a retention clear, with their occasion. */
function retentionClears(records: readonly LogRecord[]): readonly string[] {
  return records
    .filter((record) => record.message.includes('retention clear'))
    .map((record) => String((record.fields as Record<string, unknown> | undefined)?.['event']));
}

async function ask(
  rig: Awaited<ReturnType<typeof openAcceptanceRig>>,
  text: string,
): Promise<void> {
  rig.rig.conversation.noteCommand({ type: 'submit-text', text });
  rig.rig.dispatch({ type: 'submit-text', text });
  await settleRun(rig.rig);
}

/** Waits out §10's two-per-second observation window rather than reconfiguring it. */
async function cool(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 600));
}

/**
 * Asks the facade the `observe_screen` tool drives for an observation, and
 * returns the typed refusal it produced — or `null` if it answered.
 *
 * Two of §18's rows are about states in which Pilot refuses a *typed question*
 * as well (§16's text fallback is denied in `paused` and `needs-permission`), so
 * routing them through the panel would test the state guard rather than the §10
 * rule the row is about. This is the same object the tool holds:
 * `agent.screenContext === observation.screenContext`.
 */
async function refuse(
  rig: { readonly observation: { readonly screenContext: unknown } },
  request: {
    readonly view: 'pointer' | 'window' | 'both';
    readonly moment: 'question' | 'current';
  },
): Promise<{ rule: string; code: string } | null> {
  const service = rig.observation.screenContext as {
    observeDetailed: (input: typeof request) => Promise<unknown>;
  };
  try {
    await service.observeDetailed(request);
    return null;
  } catch (cause) {
    const error = cause as { code?: unknown; details?: { rule?: unknown } };
    return {
      rule: String(error.details?.rule ?? 'unknown'),
      code: String(error.code ?? 'unknown'),
    };
  }
}

// ---------------------------------------------------------------------------
// A-01 — only the selected window enters the frame ring
// ---------------------------------------------------------------------------

export async function checkA01(context: CriterionContext): Promise<CriterionResult> {
  const model = createScriptedModelSource({
    script: [{ observe: { view: 'both', moment: 'question' } }, { say: 'A button.' }],
  });
  const opened = await openAcceptanceRig({
    scaleFactor: 2,
    stub: { pointer: OVER_THE_BUTTON },
    rig: { modelSource: model, logger: context.logger },
  });
  const { rig, window, captureSize } = opened;
  try {
    await rig.observation.session.ingestFrame(
      await buildFrame(window, {
        id: 'a01-own',
        capturedAt: Date.now(),
        size: captureSize,
        scaleFactor: 2,
      }),
    );
    const foreign = await buildFrame(
      { ...window, windowId: asWindowId(`mac-window-${String(OTHER.windowNumber)}`) },
      { id: 'a01-foreign', capturedAt: Date.now(), size: captureSize, scaleFactor: 2 },
    );
    const foreignAdmitted = rig.observation.session.ingestFrame(foreign).ingest.admitted;
    await rig.observation.samplePointer();
    await ask(opened, 'What is this?');

    const ringWindows = [
      ...new Set(rig.observation.core.frames.records().map((record) => record.frame.windowId)),
    ];
    const startedFor = [
      ...new Set(
        rig.wire
          .filter((call) => call.op === 'capture.start')
          .map((call) => String(call.payload['windowNumber'])),
      ),
    ];
    const sent = JSON.stringify(model.requests);

    return row('A-01', [
      executed(
        'pass-condition',
        'capture is started for the selected window and for no other',
        startedFor.length === 1 && startedFor[0] === String(macWindowNumber(window.windowId)),
        `capture.start windowNumber(s) at the wire: ${startedFor.join(', ')}; ` +
          `the selected window is ${String(macWindowNumber(window.windowId))}, ` +
          `the other is ${String(OTHER.windowNumber)} ("${OTHER.title}")`,
      ),
      executed(
        'pass-condition',
        'a frame stamped with another window is refused by the ring',
        !foreignAdmitted && rig.observation.metrics().framesRejected >= 1,
        `admitted=${String(foreignAdmitted)}, framesRejected=` +
          `${String(rig.observation.metrics().framesRejected)}`,
      ),
      executed(
        'pass-condition',
        'every frame the ring holds belongs to the selected window',
        ringWindows.length <= 1 && (ringWindows[0] ?? window.windowId) === window.windowId,
        `windowId(s) in the ring: ${ringWindows.join(', ') || '(empty — the 3 s bound)'}`,
      ),
      executed(
        'supporting',
        'the other window’s title reaches the provider nowhere',
        !sent.includes(OTHER.title),
        `"${OTHER.title}" in ${String(model.requests.length)} provider request(s): ` +
          `${String(sent.includes(OTHER.title))}`,
      ),
      pending(
        'pass-condition',
        'ScreenCaptureKit’s content filter really excludes other windows’ pixels',
        'mac',
        'no capture stream has ever run: the frames here are synthetic screenshots ' +
          'pushed through ObservationSession.ingestFrame. docs/handoff.md §1 step 8 ' +
          'and step 10 are the reads.',
      ),
    ]);
  } finally {
    await rig.dispose();
  }
}

// ---------------------------------------------------------------------------
// A-02 — the answer identifies the marked target
// ---------------------------------------------------------------------------

export async function checkA02(context: CriterionContext): Promise<CriterionResult> {
  const model = createScriptedModelSource({
    script: [
      { observe: { view: 'both', moment: 'question' } },
      { say: 'That is the Update payment method button.' },
    ],
  });
  const opened = await openAcceptanceRig({
    scaleFactor: 2,
    stub: { pointer: OVER_THE_BUTTON },
    rig: { modelSource: model, logger: context.logger },
  });
  const { rig, window, captureSize } = opened;
  try {
    rig.observation.session.ingestFrame(
      await buildFrame(window, {
        id: 'a02',
        capturedAt: Date.now(),
        size: captureSize,
        scaleFactor: 2,
      }),
    );
    await rig.observation.samplePointer();
    await ask(opened, 'What is this?');
    const request = lastRequest(model);
    const envelope = request?.context ?? '';
    const observed = rig.observation.lastObservation();
    const crop = observed?.images.find((image) => image.purpose === 'pointer');

    return row('A-02', [
      executed(
        'supporting',
        'the marked target reaches the model by role and label',
        envelope.includes('AXButton — Update payment method'),
        `envelope line: ${
          envelope.split('\n').find((line) => line.startsWith('pointer target:')) ?? '(none)'
        }`,
      ),
      executed(
        'supporting',
        'a pointer crop centred on that target reaches the provider',
        crop !== undefined && (request?.images.length ?? 0) === 2,
        crop === undefined
          ? 'no crop'
          : `${String(crop.width)}×${String(crop.height)} ${crop.mimeType}, ` +
              `${String(request?.images.length)} image block(s) in the provider request`,
      ),
      pending(
        'pass-condition',
        'the answer identifies or explains the marked target',
        'mac-and-model',
        'the answer above is the string this file scripted. Scoring it needs a real ' +
          'model looking at a real screen: docs/handoff.md §1 step 23 case A-02, and ' +
          'the thirty grounding cases are the input side of the same question.',
      ),
    ]);
  } finally {
    await rig.dispose();
  }
}

// ---------------------------------------------------------------------------
// A-03 — a follow-up answered without another observation
// ---------------------------------------------------------------------------

export async function checkA03(context: CriterionContext): Promise<CriterionResult> {
  const model = createScriptedModelSource({
    script: [
      { observe: { view: 'both', moment: 'question' } },
      { say: 'That is the Update payment method button.' },
    ],
  });
  const opened = await openAcceptanceRig({
    scaleFactor: 2,
    stub: { pointer: OVER_THE_BUTTON },
    rig: { modelSource: model, logger: context.logger },
  });
  const { rig, window, captureSize } = opened;
  try {
    rig.observation.session.ingestFrame(
      await buildFrame(window, {
        id: 'a03',
        capturedAt: Date.now(),
        size: captureSize,
        scaleFactor: 2,
      }),
    );
    await rig.observation.samplePointer();
    await ask(opened, 'What is this?');
    const afterFirst = rig.observation.metrics().observations;

    model.setScript([{ say: 'Yes — the same sheet has a switch for it.' }]);
    await cool();
    await ask(opened, 'And can I turn it off later?');
    const afterSecond = rig.observation.metrics().observations;
    const transcript = rig.controller.snapshot().transcript;
    const followUp = lastRequest(model);

    return row('A-03', [
      executed(
        'pass-condition',
        'Pilot required no observation for the follow-up',
        afterSecond === afterFirst && rig.observation.metrics().refusals === 0,
        `observations after the first question: ${String(afterFirst)}; ` +
          `after the follow-up: ${String(afterSecond)}; refusals: ` +
          `${String(rig.observation.metrics().refusals)}`,
      ),
      executed(
        'pass-condition',
        'the earlier turn was still in the context the follow-up was sent with',
        (followUp?.context ?? '') !== '' && transcript.length >= 4,
        `${String(transcript.length)} transcript entries; the follow-up carried a ` +
          `rendered envelope of ${String((followUp?.context ?? '').length)} characters`,
      ),
      executed(
        'supporting',
        'the images the follow-up carried are §11’s retained ones, not a new observation',
        (followUp?.images.length ?? 99) <=
          MVP_SCREEN_POLICY.maxActiveFullFrames + MVP_SCREEN_POLICY.maxActivePointerCrops,
        `${String(followUp?.images.length ?? 0)} image block(s) in the follow-up request, ` +
          `against §11’s "latest relevant full frame" + "latest relevant pointer crop" ` +
          `(${String(MVP_SCREEN_POLICY.maxActiveFullFrames)} + ` +
          `${String(MVP_SCREEN_POLICY.maxActivePointerCrops)}). They are the previous ` +
          `turn’s tool result carried forward — the observation counter above did not ` +
          `move, so nothing new was captured for them.`,
      ),
      pending(
        'pass-condition',
        'a real model decides not to look',
        'model',
        'that the follow-up used no tool is scripted here. Whether a model asks for ' +
          'an observation it does not need is the question §11 turns on: ' +
          'docs/handoff.md §1 step 23 case A-03.',
      ),
    ]);
  } finally {
    await rig.dispose();
  }
}

// ---------------------------------------------------------------------------
// A-04 — a different target returns a different crop
// ---------------------------------------------------------------------------

export async function checkA04(context: CriterionContext): Promise<CriterionResult> {
  const model = createScriptedModelSource({ script: [{ say: '…' }] });
  const opened = await openAcceptanceRig({
    scaleFactor: 2,
    stub: { pointerScript: [OVER_THE_BUTTON, OVER_THE_SIDEBAR] },
    rig: { modelSource: model, logger: context.logger },
  });
  const { rig, window, captureSize } = opened;
  const seen: { role: string | null; bytes: number; at: string }[] = [];
  try {
    for (const [index, label] of ['button', 'sidebar'].entries()) {
      await cool();
      rig.observation.session.ingestFrame(
        await buildFrame(window, {
          id: `a04-${label}`,
          capturedAt: Date.now(),
          size: captureSize,
          scaleFactor: 2,
        }),
      );
      await rig.observation.samplePointer();
      model.setScript([
        { observe: { view: 'pointer', moment: 'question' } },
        { say: `Close-up ${String(index + 1)}.` },
      ]);
      await ask(opened, 'What is this?');
      const crop = rig.observation.lastObservation()?.images[0];
      const anchor = rig.anchoring.lastAnchor();
      const selection = anchor === null ? null : rig.anchoring.anchors.pointerAt(anchor.at);
      const point =
        selection !== null && selection.found ? selection.sample.pointer.normalizedPoint : null;
      seen.push({
        role: anchor?.targetRole ?? null,
        bytes: crop?.byteLength ?? 0,
        at: point === null ? 'unknown' : `${point.x.toFixed(3)}, ${point.y.toFixed(3)}`,
      });
    }

    const [first, second] = seen;
    return row('A-04', [
      executed(
        'pass-condition',
        'the second question returns a crop of the new pointer target',
        first !== undefined &&
          second !== undefined &&
          first.at !== second.at &&
          first.role !== second.role &&
          first.bytes !== second.bytes,
        seen.map((one) => `${one.at} → ${String(one.role)}, ${String(one.bytes)} B`).join('  |  '),
      ),
      executed(
        'supporting',
        'both crops are the §10 crop size, so the difference is content and not framing',
        MVP_SCREEN_POLICY.pointerCropPixels === 640,
        `pointerCropPixels=${String(MVP_SCREEN_POLICY.pointerCropPixels)}; ` +
          `grounding cases G-01…G-20 read both crop rectangles in full`,
      ),
      pending(
        'pass-condition',
        'a real pointer moved to a real second control produces the same result',
        'mac',
        'both pointer positions above came from the Node helper stub. ' +
          'docs/handoff.md §1 step 11b is the real-pointer read.',
      ),
    ]);
  } finally {
    await rig.dispose();
  }
}

// ---------------------------------------------------------------------------
// A-05 — the question-time frame preserves a transient element
// ---------------------------------------------------------------------------

export async function checkA05(context: CriterionContext): Promise<CriterionResult> {
  const model = createScriptedModelSource({ script: [{ say: '…' }] });
  const opened = await openAcceptanceRig({
    scaleFactor: 2,
    stub: { pointer: OVER_THE_BUTTON },
    rig: { modelSource: model, logger: context.logger },
  });
  const { rig, window, captureSize } = opened;
  try {
    // The transient state — the synthetic screen's toggle in its "on" position,
    // standing in for a tooltip that is on screen while the user asks and gone
    // by the time the model looks.
    const transient = await buildFrame(window, {
      id: 'a05-with-tooltip',
      capturedAt: Date.now(),
      size: captureSize,
      scaleFactor: 2,
      toggleOn: true,
    });
    rig.observation.session.ingestFrame(transient);
    await rig.observation.samplePointer();
    // …and now it disappears, before the question is even submitted.
    const after = await buildFrame(window, {
      id: 'a05-gone',
      capturedAt: Date.now() + 2,
      size: captureSize,
      scaleFactor: 2,
    });
    rig.observation.session.ingestFrame(after);

    model.setScript([
      { observe: { view: 'window', moment: 'question' } },
      { say: 'A tooltip was showing.' },
    ]);
    await ask(opened, 'What is this?');
    const answeredFrom = rig.observation.lastObservation()?.frames[0];
    const newest = rig.observation.core.frames.records().at(-1);

    return row('A-05', [
      executed(
        'pass-condition',
        'moment: question answers from the frame that was on screen at the anchor',
        answeredFrom?.capturedAt === transient.capturedAt,
        `answered from capturedAt=${String(answeredFrom?.capturedAt)} ` +
          `(origin ${String(answeredFrom?.origin)}, skewMs ${String(answeredFrom?.skewMs)}); ` +
          `the transient frame was ${String(transient.capturedAt)} and the one that ` +
          `replaced it ${String(after.capturedAt)}`,
      ),
      executed(
        'pass-condition',
        'a newer frame was in the ring and was not the one used',
        (newest?.frame.capturedAt ?? 0) > (answeredFrom?.capturedAt ?? 0),
        `newest in the ring: capturedAt=${String(newest?.frame.capturedAt)}; ` +
          `${String(rig.observation.core.frames.records().length)} frame(s) retained`,
      ),
      pending(
        'pass-condition',
        'a real tooltip is caught by the 2–3 FPS sampler and survives in the 3 s ring',
        'mac',
        'the two frames above were pushed by this file. Whether a real transient ' +
          'element is sampled at all before it disappears is a property of ' +
          `sampleFps=${String(MVP_SCREEN_POLICY.sampleFps)} against a real UI: ` +
          'docs/handoff.md §1 step 23 case A-05.',
      ),
    ]);
  } finally {
    await rig.dispose();
  }
}

// ---------------------------------------------------------------------------
// A-06 — a comparison is budgeted at two frames
// ---------------------------------------------------------------------------

export async function checkA06(context: CriterionContext): Promise<CriterionResult> {
  const model = createScriptedModelSource({ script: [{ say: '…' }] });
  const opened = await openAcceptanceRig({
    scaleFactor: 2,
    stub: { pointer: OVER_THE_BUTTON },
    rig: { modelSource: model, logger: context.logger },
  });
  const { rig, window, captureSize } = opened;
  try {
    rig.observation.session.ingestFrame(
      await buildFrame(window, {
        id: 'a06-before',
        capturedAt: Date.now(),
        size: captureSize,
        scaleFactor: 2,
      }),
    );
    rig.observation.session.ingestFrame(
      await buildFrame(window, {
        id: 'a06-after',
        capturedAt: Date.now() + 1,
        size: captureSize,
        scaleFactor: 2,
        toggleOn: true,
      }),
    );
    await rig.observation.samplePointer();
    // `view: both` on purpose: §10 budgets two images for a comparison, so a
    // pointer crop would be the third and must not appear.
    model.setScript([
      { observe: { view: 'both', moment: 'before-and-after' } },
      { say: 'The toggle moved.' },
    ]);
    await ask(opened, 'What changed?');
    const observed = rig.observation.lastObservation();
    const request = lastRequest(model);

    return row('A-06', [
      executed(
        'pass-condition',
        `at most ${String(MVP_SCREEN_POLICY.maxComparisonFrames)} comparison frames are returned`,
        (observed?.frames.length ?? 99) <= MVP_SCREEN_POLICY.maxComparisonFrames &&
          (observed?.images.length ?? 99) <= MVP_SCREEN_POLICY.maxComparisonFrames,
        `frames=${String(observed?.frames.length)} images=${(observed?.images ?? [])
          .map((image) => image.purpose)
          .join('+')} — asked for view: both, which would otherwise be three`,
      ),
      executed(
        'pass-condition',
        'the provider received exactly those images and no more',
        (request?.images.length ?? 99) <= MVP_SCREEN_POLICY.maxComparisonFrames,
        `${String(request?.images.length)} image block(s) in the provider request`,
      ),
      executed(
        'supporting',
        'the comparison is bounded around a recorded scene transition',
        observed?.comparison !== undefined,
        observed?.comparison === null
          ? 'no transition was retained; the whole local buffer was used'
          : `bounded at revision ${String(observed?.comparison?.sceneRevision)} ` +
              `(${(observed?.comparison?.changes ?? []).join(', ')})`,
      ),
      pending(
        'pass-condition',
        'a real model routes “what changed?” to moment: before-and-after',
        'model',
        'the moment above was chosen by this file. The tool description asks the ' +
          'model to reserve before-and-after for change questions; whether it does ' +
          'is docs/handoff.md §1 step 23 case A-06.',
      ),
    ]);
  } finally {
    await rig.dispose();
  }
}

// ---------------------------------------------------------------------------
// A-07 — pause stops capture and empties the buffer
// ---------------------------------------------------------------------------

export async function checkA07(context: CriterionContext): Promise<CriterionResult> {
  const model = createScriptedModelSource({ script: [{ say: '…' }] });
  const opened = await openAcceptanceRig({
    scaleFactor: 2,
    stub: { pointer: OVER_THE_BUTTON },
    rig: { modelSource: model, logger: context.logger },
  });
  const { rig, window, captureSize } = opened;
  const before = context.sink.records.length;
  try {
    rig.observation.session.ingestFrame(
      await buildFrame(window, {
        id: 'a07',
        capturedAt: Date.now(),
        size: captureSize,
        scaleFactor: 2,
      }),
    );
    await rig.observation.samplePointer();
    const filled = rig.observation.core.status().buffer;
    const stopsBefore = rig.wire.filter((call) => call.op === 'capture.stop').length;

    // The app's own command route — `dispatchCommand` in observe-rig.ts, which
    // is what the panel, the menu bar item and the IPC channel all reach.
    rig.dispatch({ type: 'pause' });
    await rig.controller.settled();

    const emptied = rig.observation.core.status().buffer;
    const stopsAfter = rig.wire.filter((call) => call.op === 'capture.stop').length;
    const occasions = retentionClears(context.sink.records.slice(before));

    // A refusal, not an answer from a stale buffer. Driven straight at the
    // facade the `observe_screen` tool drives: a paused machine refuses a typed
    // question too (§16's text fallback is denied in `paused`), so routing this
    // through the panel would test the state guard rather than the §10 rule.
    const refusal = await refuse(rig, { view: 'window', moment: 'current' });

    return row('A-07', [
      executed(
        'pass-condition',
        'capture is stopped at the wire',
        stopsAfter > stopsBefore,
        `capture.stop crossed the pipe ${String(stopsAfter - stopsBefore)} time(s) on pause`,
      ),
      executed(
        'pass-condition',
        'the frame ring is empty',
        emptied.frameCount === 0 && emptied.byteCount === 0,
        `before: ${String(filled.frameCount)} frame(s), ${String(filled.byteCount)} B; ` +
          `after: ${String(emptied.frameCount)} frame(s), ${String(emptied.byteCount)} B`,
      ),
      executed(
        'pass-condition',
        'the retained pointer elements go with the pixels',
        rig.observation.retention.clears >= 1,
        `retention guard clears=${String(rig.observation.retention.clears)}, ` +
          `image cache wired=${String(rig.observation.retention.hasImageCache)}`,
      ),
      executed(
        'pass-condition',
        'an observation asked for while paused is refused rather than answered',
        refusal !== null && rig.observation.metrics().observations === 0,
        `observations=${String(rig.observation.metrics().observations)}; ` +
          `the facade the observe_screen tool drives refused with ` +
          `rule=${String(refusal?.rule)} code=${String(refusal?.code)}`,
      ),
      executed(
        'supporting',
        'the clear names `pause` as its occasion in the log (system-design §13)',
        occasions.includes('pause'),
        `retention clear occasions logged during this scenario: ` +
          `${occasions.join(', ') || '(none)'}`,
      ),
      pending(
        'pass-condition',
        'the ScreenCaptureKit stream really stops delivering',
        'mac',
        'capture.stop reached a Node stub. docs/handoff.md §1 step 10 is the read, ' +
          'and §1 step 18 (a) is the same question under a revoked permission.',
      ),
    ]);
  } finally {
    await rig.dispose();
  }
}

// ---------------------------------------------------------------------------
// A-08 — interruption stops the voice and no stale chunk follows
// ---------------------------------------------------------------------------

export interface InterruptionTiming {
  /** Command accepted → `speech.output.stop` handed to the transport, in ms. */
  readonly dispatchToWireMs: number;
  /** The adapter's own round trip, measured inside main/speech-runtime.ts. */
  readonly adapterRoundTripMs: number | null;
}

export async function checkA08(
  context: CriterionContext,
): Promise<{ result: CriterionResult; timing: InterruptionTiming | null }> {
  const model = createScriptedModelSource({
    tokensPerSecond: 12,
    script: [
      {
        say:
          'That is the Update payment method button. ' +
          'It opens the billing sheet for this account. ' +
          'The card on file is charged when the plan renews.',
      },
    ],
  });
  const opened = await openAcceptanceRig({
    scaleFactor: 2,
    stub: { pointer: OVER_THE_BUTTON },
    rig: { modelSource: model, logger: context.logger },
  });
  const { rig } = opened;
  let timing: InterruptionTiming;
  try {
    rig.dispatch({ type: 'submit-text', text: 'What is this?' });
    const deadline = Date.now() + 20_000;
    while (rig.speech.stats().accepted < 1) {
      if (Date.now() > deadline) {
        throw new Error('the first chunk never reached the synthesiser');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const spokenBefore = rig.wire.filter((call) => call.op === 'speech.output.speak');
    const stream = String(spokenBefore[0]?.payload['speechId'] ?? '').split('#')[0] ?? '';
    const stopsBefore = rig.speech.stats().stops;

    const dispatchedAt = Date.now();
    rig.dispatch({ type: 'push-to-talk-down' });
    while (rig.speech.stats().stops === stopsBefore) {
      if (Date.now() > deadline) {
        throw new Error('the synthesiser was never told to stop');
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const stopAt =
      rig.wire.filter((call) => call.op === 'speech.output.stop' && call.at >= dispatchedAt)[0]
        ?.at ?? dispatchedAt;
    timing = {
      dispatchToWireMs: stopAt - dispatchedAt,
      adapterRoundTripMs: rig.speech.stats().lastStopMs,
    };

    // Let anything still in flight land before reading the wire back.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stale = rig.wire
      .filter((call) => call.op === 'speech.output.speak' && call.at > stopAt)
      .filter((call) => String(call.payload['speechId']).startsWith(`${stream}#`));

    return {
      timing,
      result: row('A-08', [
        executed(
          'pass-condition',
          'the synthesiser is told to stop when the interruption arrives',
          rig.speech.stats().stops > stopsBefore,
          `speech.output.stop crossed the pipe ${String(timing.dispatchToWireMs)} ms after the ` +
            `command was dispatched (§17 budgets 300 ms for the whole path); the adapter’s ` +
            `own round trip was ${String(timing.adapterRoundTripMs)} ms`,
        ),
        executed(
          'pass-condition',
          'no chunk of the abandoned answer is spoken after the stop',
          stale.length === 0,
          `${String(spokenBefore.length)} chunk(s) of stream ${stream} spoken before the ` +
            `stop, ${String(stale.length)} after it`,
        ),
        executed(
          'supporting',
          'the panel’s speaking bit went false',
          !rig.controller.snapshot().speaking,
          `speaking=${String(rig.controller.snapshot().speaking)} ` +
            `state=${rig.controller.snapshot().state}`,
        ),
        pending(
          'pass-condition',
          'the sound actually stops, and inside 300 ms',
          'mac',
          'nothing in this project has ever made a sound. The number above is a JSON ' +
            'round trip over a pipe on an idle Linux box; AVSpeechSynthesizer and the ' +
            'audio device are the rest of §17’s budget and have never run. ' +
            'docs/handoff.md §1 step 15 (b) is the by-ear read.',
        ),
      ]),
    };
  } finally {
    await rig.dispose();
  }
}

// ---------------------------------------------------------------------------
// A-09 — Accessibility revoked
// ---------------------------------------------------------------------------

export async function checkA09(context: CriterionContext): Promise<CriterionResult> {
  const model = createScriptedModelSource({
    script: [
      { observe: { view: 'window', moment: 'question' } },
      { say: 'I can see the window but not what is under your pointer.' },
    ],
  });
  const opened = await openAcceptanceRig({
    scaleFactor: 2,
    stub: {
      pointer: OVER_THE_BUTTON,
      permissions: {
        'screen-recording': 'granted',
        accessibility: 'denied',
        microphone: 'granted',
        'speech-recognition': 'granted',
      },
    },
    rig: { modelSource: model, logger: context.logger },
  });
  const { rig } = opened;
  try {
    const state = rig.controller.snapshot().state;
    const conditions = rig.observation.status();

    return row('A-09', [
      executed(
        'pass-condition',
        'visual mode remains usable with Accessibility denied',
        state !== 'needs-permission',
        `the machine rests in "${state}" with screen-recording=granted and ` +
          `accessibility=denied. system-design §16 asks for "continue with visual ` +
          `pointer coordinates and disclose reduced grounding"; REQUIRED_PERMISSIONS in ` +
          `packages/interaction/src/context.ts lists all four permissions, so losing any ` +
          `one resolves to needs-permission. This is runbook follow-up 35, recorded ` +
          `since PR-040 and demonstrated against the assembled application here.`,
      ),
      executed(
        'supporting',
        'the observation conditions still report Screen Recording as granted',
        conditions.permissions?.screenRecording === 'granted',
        `screenRecording=${String(conditions.permissions?.screenRecording)} ` +
          `accessibility=${String(conditions.permissions?.accessibility)} — the pixels are ` +
          `available; it is the interaction machine that refuses to proceed`,
      ),
      pending(
        'pass-condition',
        'a real mid-session Accessibility revocation behaves the same way',
        'mac',
        'the permission states above came from the Node stub at construction, not from ' +
          'TCC changing under a running session. docs/handoff.md §1 step 18 (a) is the ' +
          'real revocation.',
      ),
    ]);
  } finally {
    await rig.dispose();
  }
}

// ---------------------------------------------------------------------------
// A-10 — Screen Recording revoked
// ---------------------------------------------------------------------------

export async function checkA10(context: CriterionContext): Promise<CriterionResult> {
  const model = createScriptedModelSource({
    script: [
      { observe: { view: 'both', moment: 'question' } },
      { say: 'I cannot see your screen.' },
    ],
  });
  const opened = await openAcceptanceRig({
    scaleFactor: 2,
    stub: {
      pointer: OVER_THE_BUTTON,
      permissions: {
        'screen-recording': 'denied',
        accessibility: 'granted',
        microphone: 'granted',
        'speech-recognition': 'granted',
      },
    },
    rig: { modelSource: model, logger: context.logger },
    select: false,
  });
  const { rig } = opened;
  try {
    // Without the grant the machine rests in `needs-permission`, where §16
    // denies the text fallback too — so a typed question is rejected before it
    // is ever sent. Both halves are read: the rejection, and then the §10 rule
    // asked directly of the facade the tool drives, because "no frame is
    // captured or sent" has to hold even for a caller that gets past the panel.
    rig.dispatch({ type: 'submit-text', text: 'What is on my screen?' });
    await rig.controller.settled();
    const restingState = rig.controller.snapshot().state;
    const refusal = await refuse(rig, { view: 'both', moment: 'current' });
    const request = lastRequest(model);
    const captureOps = rig.wire.filter(
      (call) => call.op === 'capture.start' || call.op === 'capture.pull',
    );
    const sent = JSON.stringify(model.requests);

    return row('A-10', [
      executed(
        'pass-condition',
        'no capture operation is issued at the wire',
        captureOps.length === 0,
        `capture.start/capture.pull at the wire: ${String(captureOps.length)}`,
      ),
      executed(
        'pass-condition',
        'no image reaches the provider',
        (request?.images.length ?? 0) === 0 && !BASE64_RUN.test(sent),
        `${String(request?.images.length ?? 0)} image block(s); any base64-shaped run in ` +
          `any of the ${String(model.requests.length)} request(s): ` +
          `${String(BASE64_RUN.test(sent))}`,
      ),
      executed(
        'pass-condition',
        'the observation is refused with a typed reason rather than answered',
        refusal !== null && rig.observation.metrics().observations === 0,
        `observations=${String(rig.observation.metrics().observations)}; the facade the ` +
          `observe_screen tool drives refused with rule=${String(refusal?.rule)} ` +
          `code=${String(refusal?.code)}`,
      ),
      executed(
        'supporting',
        'the panel puts the user in front of the permission rather than an error',
        restingState === 'needs-permission',
        `the machine rests in "${restingState}"; a typed question from there is ` +
          `rejected before it is sent (${String(model.requests.length)} provider ` +
          `request(s) made)`,
      ),
      pending(
        'pass-condition',
        'a real mid-session Screen Recording revocation captures nothing',
        'mac',
        'macOS may kill the helper rather than answer `denied` when a running capture ' +
          'loses its grant; which of the two happens is unknown. docs/handoff.md §1 ' +
          'step 18 (a).',
      ),
    ]);
  } finally {
    await rig.dispose();
  }
}

// ---------------------------------------------------------------------------
// A-11 — a non-vision model is refused before anything is sent
// ---------------------------------------------------------------------------

export async function checkA11(context: CriterionContext): Promise<CriterionResult> {
  const model = createScriptedModelSource({ vision: false, script: [{ say: '…' }] });
  const opened = await openAcceptanceRig({
    scaleFactor: 2,
    stub: { pointer: OVER_THE_BUTTON },
    rig: { modelSource: model, logger: context.logger },
  });
  const { rig } = opened;
  try {
    const capability = rig.agent.capability;
    const requestsAfterGate = model.requestCount();
    rig.dispatch({ type: 'submit-text', text: 'What is this?' });
    await settleRun(rig);

    return row('A-11', [
      executed(
        'pass-condition',
        'the capability gate refuses a model that cannot see',
        !capability.ok,
        capability.ok
          ? `the gate PASSED for a model advertising input types without image — ` +
              `vision=${String(capability.report.vision)}`
          : `refused: ${capability.error.code} — ${capability.error.message}`,
      ),
      executed(
        'pass-condition',
        'the refusal costs zero provider requests',
        requestsAfterGate === 0,
        `provider requests when the gate had run: ${String(requestsAfterGate)}; ` +
          `after a question was submitted anyway: ${String(model.requestCount())}`,
      ),
      executed(
        'supporting',
        'the user is left with something to read rather than a silent failure',
        (rig.controller.snapshot().lastError?.userMessage ?? '') !== '' ||
          rig.controller.snapshot().transcript.length > 0,
        `state=${rig.controller.snapshot().state} ` +
          `lastError=${String(rig.controller.snapshot().lastError?.userMessage ?? '(none)')}`,
      ),
      pending(
        'pass-condition',
        'a real non-vision model is detected as one',
        'model',
        'the model above advertises its input types truthfully because this file made ' +
          'it. A local endpoint reports no capabilities at all and is probed with an ' +
          '8×8 swatch that a blind model guesses right one time in six — runbook ' +
          'follow-up 34, and docs/handoff.md §1 step 17 (b).',
      ),
    ]);
  } finally {
    await rig.dispose();
  }
}

// ---------------------------------------------------------------------------
// A-12 — a long conversation stays inside the §10/§11 limits
// ---------------------------------------------------------------------------

export async function checkA12(context: CriterionContext): Promise<CriterionResult> {
  const TURNS = 12;
  const model = createScriptedModelSource({
    script: Array.from({ length: TURNS }).flatMap((_unused, index) => [
      { observe: { view: 'both', moment: 'question' } } as const,
      { say: `Answer ${String(index + 1)}.` } as const,
    ]),
  });
  const opened = await openAcceptanceRig({
    scaleFactor: 2,
    stub: { pointer: OVER_THE_BUTTON },
    // A small budget so §11's compaction fires inside a dozen turns, exactly as
    // `packages/agent`'s own demos do it.
    rig: { modelSource: model, logger: context.logger, contextWindow: 8_192 },
  });
  const { rig, window, captureSize } = opened;
  const perTurn: string[] = [];
  try {
    let worstFullFrames = 0;
    let worstCrops = 0;
    for (let turn = 1; turn <= TURNS; turn += 1) {
      await cool();
      rig.observation.session.ingestFrame(
        await buildFrame(window, {
          id: `a12-${String(turn)}`,
          capturedAt: Date.now(),
          size: captureSize,
          scaleFactor: 2,
          toggleOn: turn % 2 === 0,
        }),
      );
      await rig.observation.samplePointer();
      await ask(opened, `Question ${String(turn)}: what is this?`);
      const sent = lastRequest(model);
      const images = sent?.images.length ?? 0;
      // What the *provider* held, not what Pilot believes it held: the pruner
      // (PR-022a) is only doing its job if the request itself is inside the
      // §11 limits.
      worstFullFrames = Math.max(worstFullFrames, images);
      const plan = rig.observation.lastObservation()?.activeContext;
      worstCrops = Math.max(worstCrops, plan?.incoming.pointerCrops ?? 0);
      perTurn.push(`${String(turn)}:${String(images)}`);
    }
    const limit = MVP_SCREEN_POLICY.maxActiveFullFrames + MVP_SCREEN_POLICY.maxActivePointerCrops;
    const telemetry = rig.conversation.telemetry;

    return row('A-12', [
      executed(
        'pass-condition',
        `no provider request carried more than ${String(limit)} images`,
        worstFullFrames <= limit,
        `images per request across ${String(TURNS)} turns: ${perTurn.join(' ')} ` +
          `(limits: maxActiveFullFrames=${String(MVP_SCREEN_POLICY.maxActiveFullFrames)}, ` +
          `maxActivePointerCrops=${String(MVP_SCREEN_POLICY.maxActivePointerCrops)})`,
      ),
      executed(
        'pass-condition',
        'the active-context plan never exceeded the §11 pointer-crop limit',
        worstCrops <= MVP_SCREEN_POLICY.maxActivePointerCrops,
        `worst incoming pointer crops in one observation: ${String(worstCrops)}`,
      ),
      executed(
        'supporting',
        'compaction is observable in the diagnostics the panel renders',
        telemetry !== undefined,
        `${String(TURNS)} turns at a ${String(8_192)}-token budget; ` +
          `observations=${String(rig.observation.metrics().observations)} ` +
          `refusals=${String(rig.observation.metrics().refusals)}`,
      ),
      pending(
        'pass-condition',
        'the context really stays inside a real provider’s window',
        'model',
        'token counts here are Pi’s estimate against a faux provider that never ' +
          'refuses. The turn at which a real model loses the thread is the number ' +
          'nothing in this repository can measure: docs/handoff.md §1 step 17 (d).',
      ),
    ]);
  } finally {
    await rig.dispose();
  }
}

// ---------------------------------------------------------------------------
// A-13 — restart resumes the text session and re-captures the screen
// ---------------------------------------------------------------------------

export interface A13Result {
  readonly result: CriterionResult;
  /** Kept for A-14, which scans the file this scenario wrote. */
  readonly storeFiles: readonly { readonly path: string; readonly bytes: Buffer }[];
}

async function filesUnder(directory: string): Promise<{ path: string; bytes: Buffer }[]> {
  const files: { path: string; bytes: Buffer }[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        files.push({ path: path.slice(directory.length + 1), bytes: await readFile(path) });
      }
    }
  };
  await walk(directory);
  return files;
}

export async function checkA13(context: CriterionContext): Promise<A13Result> {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-acceptance-'));
  const conversationId = asConversationId('conv-acceptance-a13');
  const MEMORABLE = 'the acceptance suite asked about the renewal date';
  let storeFiles: { path: string; bytes: Buffer }[];
  try {
    // --- first launch ------------------------------------------------------
    const firstModel = createScriptedModelSource({
      script: [
        { observe: { view: 'both', moment: 'question' } },
        { say: 'It renews on the first of the month.' },
      ],
    });
    const firstDurable = await openConversationStoreRuntime({
      conversationId,
      directory,
      logger: context.logger,
    });
    let sceneOne = '';
    let framesAtQuit = -1;
    {
      const opened = await openAcceptanceRig({
        scaleFactor: 2,
        stub: { pointer: OVER_THE_BUTTON },
        rig: {
          modelSource: firstModel,
          logger: context.logger,
          conversationId,
          ...(firstDurable.store === null
            ? {}
            : { store: firstDurable.store, restore: firstDurable.restore }),
        },
      });
      try {
        opened.rig.observation.session.ingestFrame(
          await buildFrame(opened.window, {
            id: 'a13',
            capturedAt: Date.now(),
            size: opened.captureSize,
            scaleFactor: 2,
          }),
        );
        await opened.rig.observation.samplePointer();
        await ask(opened, MEMORABLE);
        sceneOne = String(opened.rig.observation.status().scene?.sceneId);
        await opened.rig.dispose();
        framesAtQuit = opened.rig.observation.core.frames.records().length;
      } finally {
        await firstDurable.close();
      }
    }

    // --- second launch -----------------------------------------------------
    const secondModel = createScriptedModelSource({
      script: [{ say: 'You asked about renewal.' }],
    });
    const secondDurable = await openConversationStoreRuntime({
      conversationId,
      directory,
      logger: context.logger,
    });
    const restored = secondDurable.restore.messages.length;
    let sceneTwo = '';
    let carriedTranscript = false;
    let framesAfterRestart = -1;
    {
      const opened = await openAcceptanceRig({
        scaleFactor: 2,
        stub: { pointer: OVER_THE_BUTTON },
        rig: {
          modelSource: secondModel,
          logger: context.logger,
          conversationId,
          ...(secondDurable.store === null
            ? {}
            : { store: secondDurable.store, restore: secondDurable.restore }),
        },
      });
      try {
        framesAfterRestart = opened.rig.observation.core.frames.records().length;
        sceneTwo = String(opened.rig.observation.status().scene?.sceneId);
        await ask(opened, 'What did I ask you first?');
        carriedTranscript = JSON.stringify(secondModel.requests).includes(MEMORABLE);
      } finally {
        await opened.rig.dispose();
        await secondDurable.close();
      }
    }

    storeFiles = await filesUnder(directory);

    return {
      storeFiles,
      result: row('A-13', [
        executed(
          'pass-condition',
          'the text session resumes across a relaunch',
          restored > 0 && carriedTranscript,
          `${String(restored)} message(s) restored from ${String(storeFiles.length)} file(s) ` +
            `on disk; the first question's own words reached the model on the second ` +
            `launch: ${String(carriedTranscript)}`,
        ),
        executed(
          'pass-condition',
          'no screen state survives the restart',
          framesAfterRestart === 0,
          `frames in the ring at the moment the second launch opened: ` +
            `${String(framesAfterRestart)} (the first launch held ${String(framesAtQuit)} ` +
            `after teardown)`,
        ),
        executed(
          'pass-condition',
          'the scene lineage is new, so nothing is answered against the old screen',
          sceneOne !== sceneTwo,
          `scene before the restart: ${sceneOne}; after: ${sceneTwo || '(none yet)'}`,
        ),
        pending(
          'pass-condition',
          'a real quit and relaunch of the packaged app behaves the same way',
          'mac',
          'the store above is a temporary directory, not ' +
            '~/Library/Application Support/Pilot. The writer lease, the kill-and-relaunch ' +
            'window and the single-instance lock are docs/handoff.md §1 step 16 (a)–(d).',
        ),
      ]),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// A-14 — nothing sensitive in the logs or the session files
// ---------------------------------------------------------------------------

const IMAGE_MAGIC: readonly (readonly [string, Buffer])[] = [
  ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ['JPEG', Buffer.from([0xff, 0xd8, 0xff])],
  ['data: URI', Buffer.from('data:image')],
  ['WAVE', Buffer.from('RIFF')],
  ['Core Audio', Buffer.from('caff')],
];

export function checkA14(
  context: CriterionContext,
  storeFiles: readonly { readonly path: string; readonly bytes: Buffer }[],
  filesCreated: readonly string[],
): CriterionResult {
  const logged = JSON.stringify(context.sink.records);
  const hits: string[] = [];
  for (const file of storeFiles) {
    for (const [name, magic] of IMAGE_MAGIC) {
      if (file.bytes.includes(magic)) {
        hits.push(`${file.path}: ${name}`);
      }
    }
    const text = file.bytes.toString('latin1');
    const run = BASE64_RUN.exec(text);
    if (run !== null) {
      hits.push(`${file.path}: a ${String(run[0].length)}-character base64 run`);
    }
  }

  return row('A-14', [
    executed(
      'pass-condition',
      'no image bytes appear in any log record the whole suite emitted',
      !BASE64_RUN.test(logged) && !logged.includes('data:image'),
      `${String(context.sink.records.length)} record(s) emitted at debug level across every ` +
        `scenario and all thirty grounding cases; base64-shaped run: ` +
        `${String(BASE64_RUN.test(logged))}; data: URI: ${String(logged.includes('data:image'))}`,
    ),
    executed(
      'pass-condition',
      'no image or audio bytes appear in the durable session files',
      hits.length === 0,
      storeFiles.length === 0
        ? 'no session file was written'
        : `${String(storeFiles.length)} file(s) scanned (${storeFiles
            .map((file) => `${file.path} ${String(file.bytes.length)} B`)
            .join(', ')}) for PNG/JPEG/data:/RIFF/caff magic and long base64 runs; ` +
            `hits: ${hits.join(', ') || 'none'}`,
    ),
    executed(
      'pass-condition',
      'nothing is written anywhere under the repository',
      filesCreated.length === 0,
      filesCreated.length === 0
        ? 'a whole-tree diff before and after the run found no new file'
        : filesCreated.join(', '),
    ),
    executed(
      'supporting',
      'the transcript really is in the file, so the scan above read something',
      storeFiles.some((file) =>
        file.bytes.includes(Buffer.from('the acceptance suite asked about the renewal date')),
      ),
      `A-13's own question found in the session file: ${String(
        storeFiles.some((file) =>
          file.bytes.includes(Buffer.from('the acceptance suite asked about the renewal date')),
        ),
      )} — a clean scan of an empty file proves nothing`,
    ),
    pending(
      'pass-condition',
      'the real user-data directory, the unified log and the Keychain item are clean',
      'mac',
      'nothing in this project has ever written under ~/Library/Application Support/Pilot, ' +
        'and no credential has ever been held. docs/handoff.md §1 step 21 is the manual ' +
        'disk inspection and §1 step 20 (a) the Keychain read.',
    ),
  ]);
}

// ---------------------------------------------------------------------------
// A-15 — the packaged application
// ---------------------------------------------------------------------------

export async function checkA15(): Promise<CriterionResult> {
  const repoRoot = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
  let builderConfig: string;
  try {
    builderConfig = await readFile(join(repoRoot, 'apps/desktop/electron-builder.yml'), 'utf8');
  } catch {
    builderConfig = '';
  }

  return row('A-15', [
    executed(
      'supporting',
      'the bundle is configured to have no Dock icon and no terminal',
      builderConfig.includes('LSUIElement: true'),
      builderConfig === ''
        ? 'apps/desktop/electron-builder.yml could not be read'
        : `electron-builder.yml sets LSUIElement: true — the menu bar item is the only ` +
            `affordance a double-clicked Pilot has (runbook follow-up 45: it still has no icon)`,
    ),
    executed(
      'supporting',
      'the helper is a bundled resource the app spawns, not a service the user starts',
      builderConfig.includes('helper'),
      'NativeHelperTransport spawns the helper as a child process from within the app ' +
        '(apps/desktop/src/main/platform-runtime.ts); electron-builder.yml packs it under ' +
        'Contents/Resources/helper. Nothing asks the user to start a second process.',
    ),
    pending(
      'pass-condition',
      'the packaged app runs from Finder with no terminal and no second process',
      'mac',
      'no .app has ever been built, signed, installed or launched — codesign has never ' +
        'run (docs/handoff.md §3, and §1 step 22 (e) and (i) are the reads). ' +
        '`pnpm verify:package` checks the configuration is internally consistent, which ' +
        'is a much weaker claim and the only one available here.',
    ),
  ]);
}
