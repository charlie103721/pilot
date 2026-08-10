import { createScriptedModelSource, type ScriptedModelSource } from '@pilot/agent';
import { encodePng, renderSyntheticScreen } from '@pilot/observation';
import type { PilotViewState } from '@pilot/platform';
import { asFrameId, type CapturedFrame, type ObservedWindow } from '@pilot/shared';
import { createObservationRig, DEMO_DESKTOP, type ObservationRig } from './observe-rig.js';

/**
 * PR-031's demo: **point at something, type a question about it, and get an
 * answer grounded in what you were pointing at.**
 *
 *     pnpm demo:ask
 *
 * This is the PR where the product's core idea first works end to end, so it is
 * worth being exact about which parts of "end to end" are real and which are
 * stand-ins. Real, and the shipping code: the pointer timeline and the question
 * anchor (`ObservationCore.anchorQuestion`), the question envelope (PR-024),
 * the interaction transition table, `PiAgentSession` and Pi's agent loop, the
 * `observe_screen` tool, the §10 policy, the image pipeline — which really
 * decodes, really crops and really encodes — `MacAccessibilityAdapter`,
 * `MacObservationAdapter` and `NativeHelperTransport`.
 *
 * Stand-ins, and what follows from each:
 *
 *  - **No real pointer, and no real accessibility element.** There is no macOS
 *    here (runbook §5 amendment 8). The pointer positions and the elements
 *    below come from the Node helper stub, over the real protocol, through the
 *    real adapter. So "the crop is centred on what the user pointed at" is
 *    **not** verified by this demo: what is verified is that it is centred on
 *    the pointer sample the anchor selected.
 *  - **No real pixels from a screen.** The stub's frames are deterministic
 *    bytes that are not a decodable image (runbook cross-lane issue 11), and a
 *    pointer crop has to decode. So the frames here are synthetic *screenshots*
 *    (PR-018's `renderSyntheticScreen` + `encodePng`) pushed through the same
 *    `ObservationSession.ingestFrame` the capture stream arrives on. Every byte
 *    the pipeline reads and writes is real; nothing behind them was on a screen.
 *  - **No real model.** No sign-in, no credentials, no request has ever left
 *    this machine (`docs/handoff.md` §2). The model is Pi's faux provider with
 *    its replies scripted, so *that* it calls `observe_screen` — and with which
 *    `moment` — is chosen here rather than decided by a model.
 *
 * Section 7 restates all of that at the end, where it cannot be skipped.
 */

export interface AskDemoResult {
  readonly lines: readonly string[];
}

const GRANTED = {
  'screen-recording': 'granted',
  accessibility: 'granted',
  microphone: 'granted',
  'speech-recognition': 'granted',
} as const;

/** The Safari window the stub describes (`DEMO_WINDOWS[0]`). */
const WINDOW_BOUNDS = { x: 100, y: 80, width: 1200, height: 800 } as const;

/** Screen point over the "Update payment method" button. */
export const OVER_THE_BUTTON = { x: 700, y: 480 } as const;
/** Screen point over the sidebar: far from the button, still inside. */
export const OVER_THE_SIDEBAR = { x: 220, y: 200 } as const;
/**
 * Screen point over the *other* window, which is stacked on top of the selected
 * one. Inside the selected window's frame, owned by a different application.
 */
export const OVER_A_STACKED_WINDOW = { x: 1100, y: 650 } as const;
/** Screen point outside the selected window's frame entirely. */
export const OUTSIDE_THE_WINDOW = { x: 1500, y: 950 } as const;

/**
 * Elements the stub's hit test can find. The third belongs to the *other*
 * window's application, and nothing Pilot produces may ever describe it.
 */
export const AX_ELEMENTS = [
  {
    bounds: { x: 640, y: 440, width: 220, height: 80 },
    role: 'AXButton',
    label: 'Update payment method',
    ownerPid: 501,
  },
  {
    bounds: { x: 120, y: 120, width: 300, height: 480 },
    role: 'AXOutline',
    label: 'Account settings',
    ownerPid: 501,
  },
  // Owned by the *other* application (Notes, pid 733) and stacked on top of the
  // selected window. Nothing Pilot produces may ever describe it.
  {
    bounds: { x: 1000, y: 600, width: 300, height: 90 },
    role: 'AXTextArea',
    label: 'Private release notes',
    ownerPid: 733,
  },
  // Outside the selected window's frame altogether.
  {
    bounds: { x: 1400, y: 900, width: 260, height: 120 },
    role: 'AXStaticText',
    label: 'Another desktop entirely',
    ownerPid: 733,
  },
] as const;

/**
 * Bigger than `pointerCropPixels` (640) in both directions, so a pointer crop is
 * a genuine sub-region of the frame and moving the pointer really does change
 * the picture. A 640×400 frame would make every crop the whole frame.
 */
export const FRAME_SIZE = { width: 1280, height: 800 } as const;

const RESTING = new Set<PilotViewState['state']>(['idle', 'observing', 'paused', 'error']);

/** Waits for the run to finish. Bounded, so a wedged run fails rather than hangs. */
export async function settleRun(rig: ObservationRig): Promise<void> {
  await rig.controller.settled();
  const deadline = Date.now() + 20_000;
  while (!RESTING.has(rig.controller.snapshot().state)) {
    if (Date.now() > deadline) {
      throw new Error(`run never settled; stuck in ${rig.controller.snapshot().state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await rig.controller.settled();
}

/**
 * Waits out §10's observation rate window rather than reconfiguring the policy,
 * so the numbers under test stay the shipped ones (the same choice PR-030's
 * demo made).
 */
async function cool(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_100));
}

/**
 * One synthetic screenshot, as a `CapturedFrame`.
 *
 * Built separately from ingesting it because section 5 has to push a frame from
 * inside a synchronous agent callback: encoding there would race the tool call
 * it is meant to precede.
 */
export async function buildScreenshot(
  window: ObservedWindow,
  options: { readonly id: string; readonly capturedAt: number; readonly toggleOn?: boolean },
): Promise<CapturedFrame> {
  const screen = renderSyntheticScreen({
    size: FRAME_SIZE,
    ...(options.toggleOn === undefined ? {} : { toggleOn: options.toggleOn }),
  });
  return {
    frameId: asFrameId(options.id),
    windowId: window.windowId,
    capturedAt: options.capturedAt,
    size: FRAME_SIZE,
    scaleFactor: 2,
    encoding: 'png',
    bytes: await encodePng(screen.pixels),
  };
}

/**
 * Pushes a screenshot into the session the capture stream feeds.
 *
 * This is the *only* substitution: `ObservationSession.ingestFrame` is the same
 * entry point `MacObservationAdapter`'s frames arrive through, the content
 * fingerprint runs, the scene revision moves, and the ring admits or refuses on
 * its own rules.
 */
export async function pushScreenshot(
  rig: ObservationRig,
  window: ObservedWindow,
  options: { readonly id: string; readonly capturedAt: number; readonly toggleOn?: boolean },
): Promise<boolean> {
  const frame = await buildScreenshot(window, options);
  return rig.observation.session.ingestFrame(frame).ingest.admitted;
}

export interface ProviderRequest {
  /** The rendered `<context>` block of the user turn (system-design §8). */
  readonly context: string | null;
  readonly images: readonly { mimeType: string; base64Length: number }[];
  /** First line of the tool result: the compact §9 summary. */
  readonly summary: string;
}

interface RecordedMessage {
  readonly role?: unknown;
  readonly toolName?: unknown;
  readonly content?: unknown;
}

/**
 * What the provider actually received.
 *
 * The base64 itself is never printed, logged or written (system-design §13);
 * only its length is. The `<context>` block *is* printed in full, because it is
 * the subject of this PR — it is exactly what the model reads about where the
 * user was pointing, and a demo that summarised it would be proving something
 * about the summary.
 */
export function lastRequest(source: ScriptedModelSource): ProviderRequest | null {
  const last = source.requests[source.requests.length - 1];
  if (last === undefined) {
    return null;
  }
  const messages = JSON.parse(last) as readonly RecordedMessage[];
  let context: string | null = null;
  let images: ProviderRequest['images'] = [];
  let summary = '';
  for (const message of messages) {
    const blocks = Array.isArray(message.content)
      ? (message.content as readonly Record<string, unknown>[])
      : [];
    if (message.role === 'user') {
      const text = blocks.find((block) => block['type'] === 'text');
      const body = String(
        text?.['text'] ?? (typeof message.content === 'string' ? message.content : ''),
      );
      const opened = body.indexOf('<context>');
      context = opened === -1 ? null : body.slice(opened).trimEnd();
    }
    if (message.role === 'toolResult' && message.toolName === 'observe_screen') {
      const text = blocks.find((block) => block['type'] === 'text');
      [summary = ''] = String(text?.['text'] ?? '').split('\n');
      images = blocks
        .filter((block) => block['type'] === 'image')
        .map((block) => ({
          mimeType: String(block['mimeType']),
          base64Length: String(block['data'] ?? '').length,
        }));
    }
  }
  return { context, images, summary };
}

function answerOf(rig: ObservationRig): string {
  return String(
    rig.controller
      .snapshot()
      .transcript.filter((entry) => entry.role === 'assistant')
      .at(-1)?.text,
  );
}

/** Normalised window coordinates of a screen point, as §8 prints them. */
function normalized(point: { x: number; y: number }): string {
  const x = (point.x - WINDOW_BOUNDS.x) / WINDOW_BOUNDS.width;
  const y = (point.y - WINDOW_BOUNDS.y) / WINDOW_BOUNDS.height;
  return `${x.toFixed(3)}, ${y.toFixed(3)}`;
}

interface Stub {
  readonly pointer?: { x: number; y: number };
  readonly pointerScript?: readonly { x: number; y: number }[];
}

async function watching(
  stub: Stub,
  model: ScriptedModelSource,
  record = false,
): Promise<{ rig: ObservationRig; window: ObservedWindow }> {
  const rig = await createObservationRig({
    stub: {
      permissions: GRANTED,
      desktop: DEMO_DESKTOP,
      captureFrameBytes: 3_072,
      captureScaleFactor: 2,
      axElements: AX_ELEMENTS,
      ...stub,
    },
    modelSource: model,
    recordRequests: record,
    // This walkthrough owns the ring: it pushes decodable screenshots, and a
    // stub frame (which does not decode) landing between one of them and the
    // question anchored on it would turn `moment: 'question'` into a decode
    // failure. See `ObservationRigOptions.capturePollIntervalMs`.
    capturePollIntervalMs: 3_600_000,
  });
  await rig.permissions.refresh();
  await rig.observation.refreshAttribution();
  const window = await rig.firstWindow();
  await rig.windows.act({ type: 'select', windowId: window.windowId });
  await rig.controller.settled();
  return { rig, window };
}

export async function runAskDemo(): Promise<AskDemoResult> {
  const lines: string[] = [];
  const say = (line = ''): void => {
    lines.push(line);
  };

  say('PR-031 — point-and-ask with text input');
  say('='.repeat(72));
  say();
  say('Real: the pointer timeline and ObservationCore.anchorQuestion (PR-016),');
  say('      the question envelope (PR-024), the interaction transition table,');
  say('      PiAgentSession and Pi’s agent loop, observe_screen (PR-021), the §10');
  say('      policy and the image pipeline (PR-017/018) — which really decodes,');
  say('      crops and encodes — MacAccessibilityAdapter, MacObservationAdapter');
  say('      and NativeHelperTransport.');
  say('Not real: the pointer and the accessibility elements (Node helper stub —');
  say('      no macOS here), the pixels behind the frames (synthetic screenshots,');
  say('      because the stub’s own frames do not decode) and the model (Pi’s faux');
  say('      provider, scripted). Section 7 says what follows from each.');
  say();

  // -------------------------------------------------------------------------
  // 1 + 2 + 3 — the boundary, the question, and which frame answers it
  // -------------------------------------------------------------------------
  {
    const model = createScriptedModelSource({ script: [{ say: '…' }] });
    const { rig, window } = await watching({ pointer: OVER_THE_BUTTON }, model, true);
    try {
      say('1. the one fake boundary PR-031 replaces');
      say(`   platform:  kind=${rig.platform.kind} — ${rig.platform.reason}`);
      say('   before:    FakeQuestionAnchorSource — an empty recording — and');
      say('              ScreenContextInputs.anchor was never set at all, so every');
      say('              envelope read `pointer-unknown` and every observation was');
      say('              read by the facade as "a model-initiated look at now".');
      say('   after:     the real ObservationCore pointer timeline behind the');
      say('              envelope, and the resolved anchor handed to the facade at');
      say('              submission.');
      say(
        `   one core behind both: ` +
          `${String(rig.anchoring.anchors.scene() === rig.observation.core.scene)}`,
      );
      say();

      say('2. point at a UI element, type "what is this?"');
      say(`   watching:  ${window.applicationName} — "${window.title}"`);
      // The screen is captured first and the pointer sampled after it, which is
      // the order the two pollers really produce (2–3 FPS against 30 Hz) and
      // the reason `moment: "question"` can find a frame at or before the
      // anchor at all.
      say(
        `   the screen: frame A admitted=` +
          `${String(await pushScreenshot(rig, window, { id: 'frame-a', capturedAt: Date.now() }))}`,
      );
      await rig.observation.samplePointer();
      say(
        `   pointing:  screen ${String(OVER_THE_BUTTON.x)}, ${String(OVER_THE_BUTTON.y)} → ` +
          `window ${normalized(OVER_THE_BUTTON)}`,
      );
      say(
        `   elements retained beside the timeline: ` +
          `${String(rig.observation.metrics().pointerTargets)}`,
      );

      model.setScript([
        { observe: { view: 'both', moment: 'question' } },
        { say: 'That is the Update payment method button; it opens the billing sheet.' },
      ]);
      rig.controller.dispatch({ type: 'submit-text', text: 'What is this?' });
      await settleRun(rig);

      const anchor = rig.anchoring.lastAnchor();
      const observed = rig.observation.lastObservation();
      say(
        `   anchor:    at=${String(anchor?.at)} skewMs=${String(anchor?.skewMs)} ` +
          `insideWindow=${String(anchor?.insideWindow)} targetRole=${String(anchor?.targetRole)}`,
      );
      say(
        `   observed:  moment=${String(observed?.moment)} view=${String(observed?.view)} ` +
          `pointerKnown=${String(observed?.pointerKnown)} ` +
          `pointerInsideWindow=${String(observed?.pointerInsideWindow)} ` +
          `targetRole=${String(observed?.targetRole)}`,
      );
      say(
        `   images:    ${(observed?.images ?? [])
          .map(
            (image) =>
              `${image.purpose} ${String(image.width)}×${String(image.height)} ` +
              `${image.mimeType.replace('image/', '')} ${String(image.byteLength)} B`,
          )
          .join(', ')}`,
      );
      const provider = lastRequest(model);
      say('   what the model was told about the question — the rendered envelope:');
      for (const line of (provider?.context ?? '(none)').split('\n')) {
        say(`     | ${line}`);
      }
      say(`   what the tool handed back: ${String(provider?.summary)}`);
      say(
        `   the provider received ${String(provider?.images.length)} image(s): ` +
          `${(provider?.images ?? [])
            .map((image) => `${image.mimeType}, ${String(image.base64Length)} base64 chars`)
            .join('; ')}`,
      );
      say(`   and then it answered: "${answerOf(rig)}"`);
      say('   (the base64 itself is never printed, logged or written — §13.)');
      say();

      say('3. the anchor selects the frame from when the question was asked');
      say('   A newer frame lands before the next question is answered.');
      say('   `moment: "question"` must still answer from the frame that was on');
      say('   screen when the user asked, not from the newest one in the ring.');
      await cool();
      await pushScreenshot(rig, window, {
        id: 'frame-b',
        capturedAt: Date.now(),
        toggleOn: true,
      });
      await rig.observation.samplePointer();
      model.setScript([
        { observe: { view: 'window', moment: 'question' } },
        { say: 'The billing sheet is open.' },
      ]);
      rig.controller.dispatch({ type: 'submit-text', text: 'What changed?' });
      await settleRun(rig);
      const answeredFrom = rig.observation.lastObservation()?.frames[0];
      // Only now does a newer frame arrive.
      await pushScreenshot(rig, window, { id: 'frame-c', capturedAt: Date.now() + 5 });
      const newest = rig.observation.core.frames.records().at(-1);
      say(`   anchor at:              ${String(rig.anchoring.lastAnchor()?.at)}`);
      say(
        `   frame answered from:    capturedAt=${String(answeredFrom?.capturedAt)} ` +
          `origin=${String(answeredFrom?.origin)} skewMs=${String(answeredFrom?.skewMs)}`,
      );
      say(`   newest frame in the ring now: capturedAt=${String(newest?.frame.capturedAt)}`);
      say(
        `   the ring holds a newer frame than the one answered from: ` +
          `${String((newest?.frame.capturedAt ?? 0) > (answeredFrom?.capturedAt ?? 0))}`,
      );
      say(
        `   frames retained: ${String(rig.observation.core.frames.records().length)} ` +
          `(the anchor chose, the ring did not)`,
      );
      say();
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 4 — the crop follows the anchor
  // -------------------------------------------------------------------------
  {
    say('4. the pointer crop is taken around the anchor');
    say('   The same window and the same synthetic screen, two pointer positions.');
    say('   §10 step 5 computes the crop rectangle from the *anchor’s* normalised');
    say('   point and the frame size, so moving the pointer moves the picture and');
    say('   the encoded bytes change with it.');
    const model = createScriptedModelSource({ script: [{ say: '…' }] });
    const { rig, window } = await watching(
      { pointerScript: [OVER_THE_BUTTON, OVER_THE_SIDEBAR] },
      model,
    );
    try {
      for (const [label, point] of [
        ['over the button ', OVER_THE_BUTTON],
        ['over the sidebar', OVER_THE_SIDEBAR],
      ] as const) {
        await cool();
        await pushScreenshot(rig, window, {
          id: `frame-${point.x.toString()}`,
          capturedAt: Date.now(),
        });
        await rig.observation.samplePointer();
        model.setScript([
          { observe: { view: 'pointer', moment: 'question' } },
          { say: 'A close-up of what you are pointing at.' },
        ]);
        rig.controller.dispatch({ type: 'submit-text', text: 'What is this?' });
        await settleRun(rig);
        const image = rig.observation.lastObservation()?.images[0];
        const anchor = rig.anchoring.lastAnchor();
        say(
          `   ${label}  pointer ${normalized(point)}  crop ` +
            `${String(image?.width)}×${String(image?.height)} ` +
            `${String(image?.byteLength)} B  targetRole=${String(anchor?.targetRole)}`,
        );
      }
      say('   (the crop is the same size by policy — `pointerCropPixels` — and a');
      say('    different picture, which is what the byte counts show.)');
      say();
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 5 — the scene revised between the question and the tool call
  // -------------------------------------------------------------------------
  {
    say('5. the window changes between the question and the tool call');
    say('   The anchor names a scene *and a revision*. When the screen moves on');
    say('   before the model looks, §10 step 3 does not refuse the observation: it');
    say('   answers and says how far behind the question was, which is how a model');
    say('   can tell "you were on the billing page" from "you are on it".');
    const model = createScriptedModelSource({ script: [{ say: '…' }] });
    const { rig, window } = await watching({ pointer: OVER_THE_BUTTON }, model);
    try {
      await pushScreenshot(rig, window, { id: 'frame-before', capturedAt: Date.now() });
      await rig.observation.samplePointer();
      const revisionAtQuestion = rig.observation.core.scene?.revision ?? 0;

      // Pre-encoded, so the push inside the callback is synchronous and really
      // does land between the two tool calls.
      const later = await buildScreenshot(window, {
        id: 'frame-after',
        capturedAt: Date.now(),
        toggleOn: true,
      });
      let pushed = false;
      const stop = rig.agent.session.subscribe((event) => {
        if (event.type === 'tool-succeeded' && !pushed) {
          pushed = true;
          rig.observation.session.ingestFrame(later);
        }
      });
      model.setScript([
        { observe: { view: 'window', moment: 'question' } },
        { observe: { view: 'window', moment: 'question' } },
        { say: 'The toggle moved while you were asking.' },
      ]);
      rig.controller.dispatch({ type: 'submit-text', text: 'What does this do?' });
      await settleRun(rig);
      stop();

      const second = rig.observation.lastObservation();
      say(`   scene revision when the question was asked: ${String(revisionAtQuestion)}`);
      say(
        `   scene revision when the second look ran:     ` +
          `${String(rig.observation.core.scene?.revision)}`,
      );
      say(
        `   the observation reports requestedSceneStatus=` +
          `${String(second?.requestedSceneStatus)} revisionsBehind=` +
          `${String(second?.revisionsBehind)}`,
      );
      say(
        `   observations allowed: ${String(rig.observation.metrics().observations)}, refused: ${String(rig.observation.metrics().refusals)}`,
      );
      say('   (a `superseded` scene — a different window — is refused instead;');
      say('    that is PR-030’s section 7c, and it is unchanged.)');
      say();
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 6a — outside the window: no target, and none asked for at the wire
  // -------------------------------------------------------------------------
  {
    say('6. a pointer that is not over the selected window identifies nothing');
    say('   (§9/§14). Two different cases, and both would leak the same thing —');
    say('   a label read off a window Pilot has no permission to describe.');
    say();
    say('   a. the pointer is outside the selected window’s frame');
    const model = createScriptedModelSource({
      script: [
        { observe: { view: 'both', moment: 'question' } },
        { say: 'I can see the window, but you were not pointing at it.' },
      ],
    });
    const { rig, window } = await watching({ pointer: OUTSIDE_THE_WINDOW }, model, true);
    try {
      const from = rig.wire.length;
      await pushScreenshot(rig, window, { id: 'frame-outside', capturedAt: Date.now() });
      await rig.observation.samplePointer();
      await rig.observation.samplePointer();
      rig.controller.dispatch({ type: 'submit-text', text: 'What is this?' });
      await settleRun(rig);

      const anchor = rig.anchoring.lastAnchor();
      const observed = rig.observation.lastObservation();
      const request = lastRequest(model);
      say(
        `      pointer:  screen ${String(OUTSIDE_THE_WINDOW.x)}, ` +
          `${String(OUTSIDE_THE_WINDOW.y)} → window ${normalized(OUTSIDE_THE_WINDOW)} ` +
          `— outside [0,1], and a real element sits there`,
      );
      say(
        `      anchor:   insideWindow=${String(anchor?.insideWindow)} ` +
          `targetRole=${String(anchor?.targetRole)}`,
      );
      say(`      elements retained at all: ${String(rig.observation.metrics().pointerTargets)}`);
      say(`      observation targetRole:   ${String(observed?.targetRole)}`);
      say('      what the model was told:');
      for (const line of (request?.context ?? '(none)').split('\n')) {
        say(`        | ${line}`);
      }
      const wire = rig.wire.slice(from);
      say(
        `      at the wire: accessibility.element-at sent ` +
          `${String(wire.filter((call) => call.op === 'accessibility.element-at').length)} time(s)`,
      );
      say(
        `      accessibility.sample includeElement: ${wire
          .filter((call) => call.op === 'accessibility.sample')
          .map((call) => String(call.payload['includeElement'] ?? false))
          .join(', ')}`,
      );
      say('      (PR-013 issues no hit test for a pointer outside the window, and');
      say('       proved it at the wire. The very first sample cannot know which');
      say('       side of the border the pointer is on, so `groundFast` folds one');
      say('       into `accessibility.sample` — scoped to the selected window’s');
      say('       application — and the host discards whatever comes back. Every');
      say('       sample after it is told not to look. `accessibility.element-at`');
      say('       is never sent for an outside pointer at all.)');
      say(
        `      that element’s label anywhere in the model’s prompt: ` +
          `${String(JSON.stringify(request).includes('Another desktop entirely'))}`,
      );
      say();
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 6b — a window stacked on top of the selected one
  // -------------------------------------------------------------------------
  {
    say('   b. the pointer is inside the frame, over another app’s window');
    say('      A notification, a floating palette or — here — the second window');
    say('      of the stub desktop, stacked over the selected one. The point is');
    say('      inside [0,1], so the outside-window rule does not fire; PR-013’s');
    say('      *foreign-application* rule does.');
    const model = createScriptedModelSource({
      script: [
        { observe: { view: 'both', moment: 'question' } },
        { say: 'Something is covering that part of the window.' },
      ],
    });
    const { rig, window } = await watching({ pointer: OVER_A_STACKED_WINDOW }, model, true);
    try {
      const from = rig.wire.length;
      await pushScreenshot(rig, window, { id: 'frame-stacked', capturedAt: Date.now() });
      await rig.observation.samplePointer();
      rig.controller.dispatch({ type: 'submit-text', text: 'What is this?' });
      await settleRun(rig);
      const anchor = rig.anchoring.lastAnchor();
      const request = lastRequest(model);
      const scoped = rig.wire
        .slice(from)
        .filter((call) => call.op === 'accessibility.sample')
        .map((call) => String(call.payload['ownerPid'] ?? 'unscoped'));
      say(
        `      pointer:  screen ${String(OVER_A_STACKED_WINDOW.x)}, ` +
          `${String(OVER_A_STACKED_WINDOW.y)} → window ` +
          `${normalized(OVER_A_STACKED_WINDOW)} — inside [0,1]`,
      );
      say(
        `      anchor:   insideWindow=${String(anchor?.insideWindow)} ` +
          `targetRole=${String(anchor?.targetRole)}`,
      );
      say(`      elements retained at all: ${String(rig.observation.metrics().pointerTargets)}`);
      say(`      at the wire: accessibility.sample ownerPid=${scoped.join(', ')}`);
      say(
        `      the other application’s label anywhere in the model’s prompt: ` +
          `${String(JSON.stringify(request).includes('Private release notes'))}`,
      );
      say('      (**PR-031 had to fix this.** PR-013 built both defences — the');
      say('       helper scopes the hit test with AXUIElementCreateApplication');
      say('       and the host drops an element whose ownerPid disagrees — and');
      say('       both are inert unless the caller passes `ownerPid`, which is');
      say('       optional on AccessibilityGroundingTarget. PR-028 did not, and');
      say('       until this PR nothing consumed the element so nothing showed.');
      say('       `ownerPidFor` in main/observation-runtime.ts now reads it off');
      say('       MacWindowAdapter.lastSnapshot; without it the label above');
      say('       reached the model.)');
      say();
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 6b — an unknown pointer is words, never a coordinate
  // -------------------------------------------------------------------------
  {
    say('   …and a question asked with no pointer at all reaches the model as');
    say('   words. `QuestionEnvelope.pointer` is a required numeric pair, so');
    say('   "unknown" is the sentinel -1,-1 (PR-024, runbook follow-up 2), and');
    say('   `renderAnchoredQuestionEnvelope` is what stops it arriving as a');
    say('   position (follow-up 1, closed by PR-029 and re-checked here now that a');
    say('   real anchor exists).');
    const model = createScriptedModelSource({
      script: [{ say: 'I do not know where you were pointing.' }],
    });
    const { rig } = await watching({ pointer: OVER_THE_BUTTON }, model);
    try {
      // Deliberately no `samplePointer()`: nothing has ever seen the pointer.
      rig.controller.dispatch({ type: 'submit-text', text: 'What is this?' });
      await settleRun(rig);
      const request = lastRequest(model);
      say('   what the model was told:');
      for (const line of (request?.context ?? '(none)').split('\n')) {
        say(`     | ${line}`);
      }
      say(`   anchor handed to the facade: ${String(rig.anchoring.lastAnchor() !== null)}`);
      say(`   why not:                     ${String(rig.anchoring.lastSkip())}`);
      say(
        `   "-1.000" anywhere in the model’s prompt: ` +
          `${String(JSON.stringify(request).includes('-1.000'))}`,
      );
      say();
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 7 — what none of this proves
  // -------------------------------------------------------------------------
  say('7. what none of the above proves (docs/handoff.md §1 step 9, §2)');
  for (const [head, ...rest] of [
    [
      'no real pointer has ever been read, and no real accessibility element has',
      'ever been hit-tested. "The crop is centred on what the user pointed at" is',
      'therefore NOT verified here — only that it is centred on the sample the',
      'anchor selected. The Mac batch is what settles it.',
    ],
    [
      'no pixel above was ever on a screen. The decode, the crop and the encode',
      'are real; the subject is a synthetic screenshot.',
    ],
    [
      'no model chose to call observe_screen, or chose `moment: "question"`. Both',
      'are scripted, so nothing above says whether a real model anchors on the',
      'question when it should — which is the whole premise of system-design §11.',
    ],
    ['the Swift helper has never been compiled, and no TCC prompt has appeared.'],
  ]) {
    say(`   - ${String(head)}`);
    for (const line of rest) {
      say(`     ${line}`);
    }
  }

  return { lines };
}
