import { afterEach, describe, expect, it } from 'vitest';
import {
  asWindowId,
  createJsonSink,
  createLogger,
  type AccessibilityNode,
  type ObservedWindow,
} from '@pilot/shared';
import {
  createScriptedModelSource,
  verifySelectedWindowOnly,
  type ScriptedModelSource,
  type ScriptedStep,
} from '@pilot/agent';
import { ObservationCore, systemClock } from '@pilot/observation';
import { createObservationAnchorSource, PointerTargetLog } from '../../src/main/question-anchor.js';
import { ownerPidFor } from '../../src/main/observation-runtime.js';
import {
  AX_ELEMENTS,
  buildScreenshot,
  lastRequest,
  OUTSIDE_THE_WINDOW,
  OVER_A_STACKED_WINDOW,
  OVER_THE_BUTTON,
  OVER_THE_SIDEBAR,
  pushScreenshot,
  settleRun,
} from '../../src/observation/ask-demo.js';
import {
  createObservationRig,
  DEMO_DESKTOP,
  type ObservationRig,
} from '../../src/observation/observe-rig.js';

/**
 * PR-031 — point at something, ask about it in words.
 *
 * The one fake boundary this PR replaces is the **question anchor**:
 * `ScreenContextInputs.anchor` was the last unwired input on the observation
 * side, and `FakeQuestionAnchorSource` — an empty recording — was the last fake
 * behind the question envelope. Everything below runs the shipping composition
 * assembled by `src/observation/observe-rig.ts` exactly as `main/index.ts`
 * assembles it, against the Node helper stub.
 *
 * **What is not real, and cannot be here** (runbook §5 amendment 8,
 * `docs/handoff.md` §2):
 *
 *  - *The pointer, and the accessibility elements.* There is no macOS. Every
 *    position and every element comes from the stub, over the real protocol,
 *    through the real adapter. So "the crop is centred on what the user pointed
 *    at" is **not** proved here: what is proved is that it is centred on the
 *    pointer sample the anchor selected.
 *  - *The pixels.* The stub's frames are not a decodable image and a pointer
 *    crop must decode, so the frames are synthetic screenshots pushed through
 *    `ObservationSession.ingestFrame` — the same entry point the capture stream
 *    arrives on (runbook cross-lane issue 11 prescribes exactly this).
 *  - *The model.* Pi's faux provider, scripted, so *that* `observe_screen` is
 *    called and with which `moment` is decided here.
 *
 * The groups that matter most are 4 and 5: an element belonging to a window
 * Pilot is not observing must never be identified, and an unknown pointer must
 * never reach the model as a coordinate. A regression in either is a privacy
 * breach rather than a bug, so each is proved end to end *and* at the wire.
 */

const GRANTED = {
  'screen-recording': 'granted',
  accessibility: 'granted',
  microphone: 'granted',
  'speech-recognition': 'granted',
} as const;

const LOOK_BOTH: ScriptedStep = { observe: { view: 'both', moment: 'question' } };
const LOOK_WINDOW: ScriptedStep = { observe: { view: 'window', moment: 'question' } };
const LOOK_POINTER: ScriptedStep = { observe: { view: 'pointer', moment: 'question' } };

let open: ObservationRig[] = [];

afterEach(async () => {
  const rigs = open;
  open = [];
  for (const rig of rigs) {
    await rig.dispose();
  }
});

interface Harness {
  readonly rig: ObservationRig;
  readonly model: ScriptedModelSource;
  readonly window: ObservedWindow;
  readonly lines: readonly string[];
}

/** The app, watching the stub's first window, with a scripted model behind it. */
async function watching(
  options: {
    readonly script?: readonly ScriptedStep[];
    readonly pointer?: { x: number; y: number };
    readonly pointerScript?: readonly { x: number; y: number }[];
    readonly vision?: boolean;
    readonly record?: boolean;
    /** Successive permission snapshots, advanced by each `permissions.refresh()`. */
    readonly permissionsScript?: readonly Record<string, string>[];
  } = {},
): Promise<Harness> {
  const lines: string[] = [];
  const model = createScriptedModelSource({
    ...(options.vision === undefined ? {} : { vision: options.vision }),
    script: options.script ?? [],
  });
  const rig = await createObservationRig({
    stub: {
      permissions: GRANTED,
      desktop: DEMO_DESKTOP,
      captureFrameBytes: 3_072,
      captureScaleFactor: 2,
      axElements: AX_ELEMENTS,
      ...(options.pointer === undefined ? {} : { pointer: options.pointer }),
      ...(options.pointerScript === undefined ? {} : { pointerScript: options.pointerScript }),
      ...(options.permissionsScript === undefined
        ? {}
        : { permissionsScript: options.permissionsScript }),
    },
    modelSource: model,
    ...(options.record === true ? { recordRequests: true } : {}),
    // These cases own the ring: they push decodable screenshots, and a stub
    // frame (which does not decode) arriving between one of them and the
    // question anchored on it would turn `moment: 'question'` into a decode
    // failure — a race, not a defect, and one that would make the anchor look
    // flaky rather than wrong.
    capturePollIntervalMs: 3_600_000,
    logger: createLogger({
      scope: 'test.question-anchor',
      level: 'debug',
      sink: createJsonSink((line) => lines.push(line)),
    }),
  });
  open.push(rig);
  await rig.permissions.refresh();
  await rig.observation.refreshAttribution();
  const window = await rig.firstWindow();
  await rig.windows.act({ type: 'select', windowId: window.windowId });
  await rig.controller.settled();
  return { rig, model, window, lines };
}

/**
 * One screen, then one pointer sample — the order the two pollers really
 * produce (2–3 FPS against 30 Hz), and the reason `moment: 'question'` finds a
 * frame at or before the anchor.
 */
async function pointAt(harness: Harness, frameId: string, toggleOn = false): Promise<void> {
  await pushScreenshot(harness.rig, harness.window, {
    id: frameId,
    capturedAt: Date.now(),
    ...(toggleOn ? { toggleOn: true } : {}),
  });
  await harness.rig.observation.samplePointer();
}

async function ask(harness: Harness, text = 'What is this?'): Promise<void> {
  harness.rig.controller.dispatch({ type: 'submit-text', text });
  await settleRun(harness.rig);
}

/** Everything the provider was sent, as one string. Never printed, only searched. */
function promptOf(model: ScriptedModelSource): string {
  return model.requests.join('\n');
}

// ---------------------------------------------------------------------------

describe('1. a typed question is anchored on the pointer at submission', () => {
  it('sets the anchor, grounds the envelope and reaches the model as an element', async () => {
    const harness = await watching({
      script: [LOOK_BOTH, { say: 'That is the Update payment method button.' }],
      pointer: OVER_THE_BUTTON,
    });
    await pointAt(harness, 'frame-a');
    await ask(harness);

    // The §6 anchor: the pointer at utterance end, inside the window, with the
    // element that was under it.
    const anchor = harness.rig.anchoring.lastAnchor();
    expect(harness.rig.anchoring.lastSkip()).toBeNull();
    expect(anchor?.insideWindow).toBe(true);
    expect(anchor?.targetRole).toBe('AXButton');
    expect(Math.abs(anchor?.skewMs ?? Infinity)).toBeLessThanOrEqual(1_000);

    // The §9 observation the tool ran: a *question*-time look, with a pointer
    // crop, and the element named. Every one of these was impossible before
    // this PR — `moment: 'question'` fell back to "now", `view: 'pointer'`
    // cropped around whatever sample was newest, and `targetRole` was `null`
    // because `pointerTarget` was never supplied.
    const observed = harness.rig.observation.lastObservation();
    expect(observed?.moment).toBe('question');
    expect(observed?.pointerKnown).toBe(true);
    expect(observed?.pointerInsideWindow).toBe(true);
    expect(observed?.targetRole).toBe('AXButton');
    expect(observed?.images.map((image) => image.purpose)).toEqual(['window', 'pointer']);
    expect(observed?.questionAt).toBe(anchor?.at);

    // And what the model was actually told about the question.
    const context = lastRequest(harness.model)?.context ?? '';
    expect(context).toContain('(window-relative, inside the selected window)');
    expect(context).toContain('pointer target: AXButton — Update payment method');

    expect(harness.rig.controller.snapshot().state).toBe('observing');
  }, 60_000);

  it('withdraws the anchor once the question has been answered', async () => {
    // `moment: 'current'` still reads the anchor — for its pointer, its
    // `requestedScene` and its element — so a "Look now" after an answer would
    // otherwise be grounded on the pointer of a question already answered.
    const harness = await watching({
      script: [{ say: 'A plain answer.' }],
      pointer: OVER_THE_BUTTON,
    });
    await pointAt(harness, 'frame-a');

    let liveDuringRun: unknown = null;
    const stop = harness.rig.agent.session.subscribe((event) => {
      if (event.type === 'run-started') {
        liveDuringRun = harness.rig.anchoring.active();
      }
    });
    await ask(harness);
    stop();

    expect(liveDuringRun).not.toBeNull();
    expect(harness.rig.anchoring.active()).toBeNull();
    // The *record* survives, because the diagnostics want to know what the last
    // question was grounded on.
    expect(harness.rig.anchoring.lastAnchor()).not.toBeNull();
  }, 60_000);

  it('keeps image bytes out of the log and out of the anchor record', async () => {
    const harness = await watching({
      script: [LOOK_BOTH, { say: 'done' }],
      pointer: OVER_THE_BUTTON,
    });
    await pointAt(harness, 'frame-a');
    await ask(harness);

    expect(harness.rig.observation.lastObservation()?.totalImageBytes).toBeGreaterThan(0);
    // A base64 payload is the only thing in this system that looks like a long
    // unbroken run of base64 characters.
    const base64ish = /[A-Za-z0-9+/]{200,}/;
    expect(harness.lines.length).toBeGreaterThan(0);
    expect(harness.lines.filter((line) => base64ish.test(line))).toHaveLength(0);
    expect(JSON.stringify(harness.rig.anchoring.lastAnchor())).not.toMatch(base64ish);
    expect(JSON.stringify(harness.rig.observation.lastObservation())).not.toMatch(base64ish);
  }, 60_000);
});

describe('2. the anchor selects the question-time frame, not the newest', () => {
  it('answers from the frame that was on screen when the question was asked', async () => {
    const harness = await watching({
      script: [LOOK_WINDOW, { say: 'The billing sheet is open.' }],
      pointer: OVER_THE_BUTTON,
    });
    await pointAt(harness, 'frame-a');

    // A newer frame lands while the question is in flight — which is the
    // ordinary case at 3 FPS, not a contrived one.
    const later = await buildScreenshot(harness.window, {
      id: 'frame-newer',
      capturedAt: Date.now() + 50,
      toggleOn: true,
    });
    const stop = harness.rig.agent.session.subscribe((event) => {
      if (event.type === 'run-started') {
        harness.rig.observation.session.ingestFrame(later);
      }
    });
    await ask(harness);
    stop();

    const chosen = harness.rig.observation.lastObservation()?.frames[0];
    const anchor = harness.rig.anchoring.lastAnchor();
    expect(chosen?.origin).toBe('ring');
    // At or before the anchor, and not the frame that arrived after it.
    expect(chosen?.capturedAt).toBeLessThanOrEqual(anchor?.at ?? 0);
    expect(chosen?.capturedAt).toBeLessThan(later.capturedAt);
    const newest = harness.rig.observation.core.frames.records().at(-1)?.frame;
    expect(newest?.frameId).toBe('frame-newer');
    expect(newest?.capturedAt).toBeGreaterThan(chosen?.capturedAt ?? 0);
  }, 60_000);
});

describe('3. the pointer crop is taken around the anchor', () => {
  it('produces a different picture for a different anchoring pointer', async () => {
    const harness = await watching({
      script: [LOOK_POINTER, { say: 'A close-up.' }],
      pointerScript: [OVER_THE_BUTTON, OVER_THE_SIDEBAR],
    });

    const crops: { width: number; height: number; byteLength: number }[] = [];
    for (const id of ['frame-1', 'frame-2']) {
      // §10 allows two observations a second; the shipped numbers stand.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await pointAt(harness, id);
      harness.model.setScript([LOOK_POINTER, { say: 'A close-up.' }]);
      await ask(harness);
      // A refused observation would leave `lastObservation()` on the previous
      // one and the comparison below would pass by accident.
      expect(harness.rig.observation.metrics().refusals).toBe(0);
      expect(harness.rig.observation.metrics().observations).toBe(crops.length + 1);
      const image = harness.rig.observation.lastObservation()?.images[0];
      expect(image?.purpose).toBe('pointer');
      crops.push({
        width: image?.width ?? 0,
        height: image?.height ?? 0,
        byteLength: image?.byteLength ?? 0,
      });
    }

    const [first, second] = crops;
    // Same crop size — `pointerCropPixels` is policy, not a function of where
    // the pointer is …
    expect(first?.width).toBe(second?.width);
    expect(first?.height).toBe(second?.height);
    // … and a genuinely different sub-region of the same synthetic screen.
    expect(first?.byteLength).not.toBe(second?.byteLength);
    // Which element was under each anchoring sample, in order.
    expect(harness.rig.anchoring.lastAnchor()?.targetRole).toBe('AXOutline');
  }, 60_000);
});

describe('4. a pointer that is not over the selected window identifies nothing', () => {
  it('outside the window: no target end to end, and no hit test at the wire', async () => {
    const harness = await watching({
      script: [LOOK_BOTH, { say: 'You were not pointing at the window.' }],
      pointer: OUTSIDE_THE_WINDOW,
      record: true,
    });
    const from = harness.rig.wire.length;
    await pointAt(harness, 'frame-a');
    // A second sample, so the adapter has learned which side of the border the
    // pointer is on.
    await harness.rig.observation.samplePointer();
    await ask(harness);

    const anchor = harness.rig.anchoring.lastAnchor();
    expect(anchor?.insideWindow).toBe(false);
    expect(anchor?.targetRole).toBeNull();
    // Nothing was ever written down: the log refuses an outside-window sample,
    // so there is no element to leak even if a later reader asked for one.
    expect(harness.rig.observation.metrics().pointerTargets).toBe(0);
    expect(harness.rig.observation.lastObservation()?.targetRole).toBeNull();
    expect(harness.rig.anchoring.active()).toBeNull();

    const context = lastRequest(harness.model)?.context ?? '';
    expect(context).toContain('outside the selected window; no element was identified');
    expect(context).not.toContain('pointer target:');
    expect(promptOf(harness.model)).not.toContain('Another desktop entirely');

    // The proof at the wire, which is what PR-013 established and what this PR
    // has to keep true for the *application*: the hit test is never issued.
    const wire = harness.rig.wire.slice(from);
    expect(wire.filter((call) => call.op === 'accessibility.element-at')).toHaveLength(0);
    const samples = wire.filter((call) => call.op === 'accessibility.sample');
    expect(samples.length).toBeGreaterThanOrEqual(2);
    // Once the adapter knows the pointer is outside it stops asking. The first
    // sample cannot know, so it asks once — scoped to the selected window's own
    // application, and the host discards the answer (`groundPointer` defence 2).
    expect(samples.at(-1)?.payload['includeElement']).toBe(false);
  }, 60_000);

  it('inside the frame but over another application: the element is dropped', async () => {
    const harness = await watching({
      script: [LOOK_BOTH, { say: 'Something is covering that.' }],
      pointer: OVER_A_STACKED_WINDOW,
      record: true,
    });
    const from = harness.rig.wire.length;
    await pointAt(harness, 'frame-a');
    await ask(harness);

    // The pointer really is inside the selected window's frame …
    expect(harness.rig.anchoring.lastAnchor()?.insideWindow).toBe(true);
    // … and the element under it belongs to the other window's application, so
    // no target is identified and none is retained.
    expect(harness.rig.anchoring.lastAnchor()?.targetRole).toBeNull();
    expect(harness.rig.observation.metrics().pointerTargets).toBe(0);
    expect(promptOf(harness.model)).not.toContain('Private release notes');

    // PR-031's fix: the hit test is scoped to the selected window's owning
    // application. Without `ownerPid` on the wire, both of PR-013's defences
    // are inert and that label reached the model.
    const samples = harness.rig.wire
      .slice(from)
      .filter((call) => call.op === 'accessibility.sample');
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(sample.payload['ownerPid']).toBe(501);
    }
  }, 60_000);
});

describe('5. an unknown pointer reaches the model as words, never as a coordinate', () => {
  it('renders `pointer: unknown` and never -1.000, now that a real anchor exists', async () => {
    const harness = await watching({
      script: [{ say: 'I do not know where you were pointing.' }],
      pointer: OVER_THE_BUTTON,
    });
    // Deliberately no `samplePointer()`: nothing has ever seen the pointer.
    await ask(harness);

    const context = lastRequest(harness.model)?.context ?? '';
    expect(context).toContain('pointer: unknown — no pointer position was recorded');
    // The sentinel is `UNKNOWN_NORMALIZED_POINT` (-1,-1), which
    // `renderQuestionEnvelope` would have printed as a position.
    expect(promptOf(harness.model)).not.toContain('-1.000');
    expect(promptOf(harness.model)).not.toContain('-1, -1');

    // And the facade was told nothing rather than something wrong.
    expect(harness.rig.anchoring.active()).toBeNull();
    expect(harness.rig.anchoring.lastAnchor()).toBeNull();
    expect(harness.rig.anchoring.lastSkip()).toBe('no-pointer-sample');
  }, 60_000);

  it('refuses to anchor when there is no scene to ground against', async () => {
    // Switching observation off ends the scene, and a question asked after it
    // has nothing to be anchored to. The envelope still goes — system-design
    // §16 keeps the text box the way out of every degraded state — it simply
    // says the pointer is unknown.
    const harness = await watching({
      script: [{ say: 'I am not watching a window.' }],
      pointer: OVER_THE_BUTTON,
    });
    await pointAt(harness, 'frame-a');
    harness.rig.controller.dispatch({ type: 'set-observation-enabled', enabled: false });
    await harness.rig.controller.settled();
    expect(harness.rig.observation.core.scene).toBeNull();

    await ask(harness);
    expect(harness.rig.anchoring.lastSkip()).toBe('no-scene');
    expect(harness.rig.anchoring.lastAnchor()).toBeNull();
    expect(harness.rig.anchoring.active()).toBeNull();
    expect(lastRequest(harness.model)?.context ?? '').toContain('pointer: unknown');
    expect(promptOf(harness.model)).not.toContain('-1.000');
  }, 60_000);
});

describe('6. the scene is revised between the question and the tool call', () => {
  it('answers, and reports how far behind the question was', async () => {
    const harness = await watching({
      script: [LOOK_WINDOW, LOOK_WINDOW, { say: 'It moved while you were asking.' }],
      pointer: OVER_THE_BUTTON,
    });
    await pointAt(harness, 'frame-before');
    const revisionAtQuestion = harness.rig.observation.core.scene?.revision ?? 0;

    // Pre-encoded, so the push from inside the agent callback is synchronous
    // and really does land between the two tool calls.
    const later = await buildScreenshot(harness.window, {
      id: 'frame-after',
      capturedAt: Date.now(),
      toggleOn: true,
    });
    let pushed = false;
    const stop = harness.rig.agent.session.subscribe((event) => {
      if (event.type === 'tool-succeeded' && !pushed) {
        pushed = true;
        harness.rig.observation.session.ingestFrame(later);
      }
    });
    await ask(harness);
    stop();

    expect(harness.rig.observation.core.scene?.revision).toBeGreaterThan(revisionAtQuestion);
    const second = harness.rig.observation.lastObservation();
    // Not refused: a revision behind is answerable, and the model is told.
    expect(second?.requestedSceneStatus).toBe('stale-revision');
    expect(second?.revisionsBehind).toBeGreaterThanOrEqual(1);
    expect(harness.rig.observation.metrics().observations).toBe(2);
    expect(harness.rig.observation.metrics().refusals).toBe(0);
    // A *different window* is the other case, and it is still refused —
    // `verifySelectedWindowOnly` against the service's own status. §10 allows
    // two observations a second and two have just run, so wait the window out
    // rather than reconfigure the policy: the numbers under test are shipped.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const again = await harness.rig.observation.screenContext.observe({
      view: 'window',
      moment: 'question',
    });
    expect(
      verifySelectedWindowOnly(again, harness.rig.observation.screenContext.status()),
    ).toBeUndefined();
    expect(again.sceneId).toBe(harness.rig.observation.screenContext.status().scene?.sceneId);
  }, 60_000);
});

describe('7. retention drops the anchor and the retained elements with the ring', () => {
  it('a pause empties all three in one guarded call', async () => {
    const harness = await watching({
      script: [LOOK_BOTH, { say: 'done' }],
      pointer: OVER_THE_BUTTON,
    });
    await pointAt(harness, 'frame-a');
    await ask(harness);
    expect(harness.rig.observation.metrics().pointerTargets).toBeGreaterThan(0);

    // Re-arm a live anchor, then pause without answering.
    harness.rig.observation.inputs.setAnchor(harness.rig.anchoring.lastAnchor()?.anchor ?? null);
    expect(harness.rig.anchoring.active()).not.toBeNull();

    harness.rig.controller.dispatch({ type: 'pause' });
    await harness.rig.controller.settled();

    expect(harness.rig.observation.core.status().buffer.frameCount).toBe(0);
    expect(harness.rig.observation.metrics().pointerTargets).toBe(0);
    // A role and a label read off a screen are screen content (§13); they go
    // when the pixels do, in the same call, so there is no window in which the
    // ring is empty and a label read off it is still in memory.
    expect(harness.rig.anchoring.active()).toBeNull();
  }, 60_000);
});

/**
 * PR-044 — system-design §16, "Accessibility denied: continue with visual
 * pointer coordinates and disclose reduced grounding" (runbook follow-up 35).
 *
 * The stub's accessibility hit test does not consult the permission snapshot —
 * `axTrusted` and the TCC state are separate switches on the far end of the
 * pipe, as they are separate APIs on a real Mac — so it keeps offering the
 * button after the revocation. That makes this the sharpest form of the test:
 * an element is available and Pilot refuses to use it, on both routes to the
 * model.
 */
describe('9. Accessibility refused: a picture and a point, and nothing named', () => {
  it('names no element in the envelope or in the tool result, and says why', async () => {
    const harness = await watching({
      script: [LOOK_BOTH, { say: 'Something near the middle of the window.' }],
      pointer: OVER_THE_BUTTON,
      permissionsScript: [{}, { accessibility: 'denied' }],
    });
    await pointAt(harness, 'frame-a');

    // Sampled while the permission was granted, so the log holds the element —
    // this is the case the second defence exists for.
    expect(harness.rig.observation.metrics().pointerTargets).toBeGreaterThan(0);

    await harness.rig.permissions.refresh();
    await harness.rig.controller.settled();
    // Pilot did not stop, and the frames are still there: Screen Recording is
    // untouched and §16 asks Pilot to go on using them.
    expect(harness.rig.controller.snapshot().state).toBe('observing');
    expect(harness.rig.observation.core.status().buffer.frameCount).toBeGreaterThan(0);
    // The labels, however, were read under a permission the user has withdrawn.
    expect(harness.rig.observation.metrics().pointerTargets).toBe(0);

    await pointAt(harness, 'frame-b');
    await ask(harness);

    // Route 1: the question envelope.
    const context = lastRequest(harness.model)?.context ?? '';
    expect(context).toContain('(window-relative, inside the selected window)');
    expect(context).toContain('pointer target: unavailable');
    expect(context).toContain('Accessibility is not permitted');
    expect(context).toContain('reduced grounding:');
    expect(context).not.toContain('none reported');

    // Route 2: the `observe_screen` tool result, which carries the anchor's own
    // element. A crop labelled "AXButton — Update payment method" would be the
    // same leak by another door.
    expect(harness.rig.anchoring.lastAnchor()?.targetRole).toBeNull();
    expect(harness.rig.observation.lastObservation()?.targetRole).toBeNull();
    // …and the picture and the point survived, which is the mode's whole point.
    expect(harness.rig.observation.lastObservation()?.pointerKnown).toBe(true);
    expect(harness.rig.observation.lastObservation()?.pointerInsideWindow).toBe(true);
    expect(harness.rig.observation.lastObservation()?.images.length ?? 0).toBeGreaterThan(0);

    // Nothing anywhere in the provider traffic names the control.
    expect(promptOf(harness.model)).not.toContain('Update payment method');
    expect(promptOf(harness.model)).not.toContain('AXButton');
  }, 60_000);

  it('names the element again as soon as the permission comes back', async () => {
    const harness = await watching({
      script: [LOOK_BOTH, { say: 'The Update payment method button.' }],
      pointer: OVER_THE_BUTTON,
      permissionsScript: [{}, { accessibility: 'denied' }, { accessibility: 'granted' }],
    });
    await harness.rig.permissions.refresh();
    await harness.rig.controller.settled();
    await harness.rig.permissions.refresh();
    await harness.rig.controller.settled();

    await pointAt(harness, 'frame-a');
    await ask(harness);

    const context = lastRequest(harness.model)?.context ?? '';
    expect(context).toContain('pointer target: AXButton — Update payment method');
    expect(context).not.toContain('unavailable');
    expect(harness.rig.anchoring.lastAnchor()?.targetRole).toBe('AXButton');
    // No relaunch and no re-selection: the same rig, the same selected window.
    expect(harness.rig.controller.snapshot().selectedWindow?.windowId).toBe(
      harness.window.windowId,
    );
  }, 60_000);
});

describe('8. the capability gate still refuses before any anchor is used', () => {
  it('never observes, even with a pointer, an element and a frame all in place', async () => {
    const harness = await watching({
      script: [LOOK_BOTH, { say: 'unreachable' }],
      pointer: OVER_THE_BUTTON,
      vision: false,
    });
    await pointAt(harness, 'frame-a');
    await ask(harness);

    expect(harness.rig.agent.capability.ok).toBe(false);
    expect(harness.model.requestCount()).toBe(0);
    expect(harness.rig.observation.metrics().observations).toBe(0);
    expect(harness.rig.controller.snapshot().state).toBe('error');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The pieces, on their own
// ---------------------------------------------------------------------------

describe('PointerTargetLog', () => {
  const node: AccessibilityNode = { role: 'AXButton', label: 'Save', isSecure: false };
  const windowId = asWindowId('mac-window-42');

  it('retains nothing for a sample outside the window, or with no element', () => {
    const log = new PointerTargetLog();
    expect(log.note({ at: 1, windowId, insideWindow: false, node })).toBe(false);
    expect(log.note({ at: 2, windowId, insideWindow: true, node: null })).toBe(false);
    expect(log.size).toBe(0);
    expect(log.at(1, windowId)).toBeNull();
  });

  it('answers by exact instant and window, never by nearest', () => {
    const log = new PointerTargetLog();
    log.note({ at: 100, windowId, insideWindow: true, node });
    expect(log.at(100, windowId)).toEqual(node);
    expect(log.at(101, windowId)).toBeNull();
    expect(log.at(100, asWindowId('mac-window-77'))).toBeNull();
  });

  it('is bounded, and drops the oldest first', () => {
    const log = new PointerTargetLog({ maxRecords: 2 });
    log.note({ at: 1, windowId, insideWindow: true, node });
    log.note({ at: 2, windowId, insideWindow: true, node });
    log.note({ at: 3, windowId, insideWindow: true, node });
    expect(log.size).toBe(2);
    expect(log.at(1, windowId)).toBeNull();
    expect(log.at(3, windowId)).toEqual(node);
  });

  it('clears, and says how much it dropped', () => {
    const log = new PointerTargetLog();
    log.note({ at: 1, windowId, insideWindow: true, node });
    expect(log.clear()).toEqual({ recordCount: 1 });
    expect(log.size).toBe(0);
    expect(log.clears).toBe(1);
  });
});

describe('createObservationAnchorSource (runbook follow-up 3)', () => {
  it('reports an empty timeline as `empty`, not as an error', () => {
    const core = new ObservationCore({ clock: systemClock });
    const anchors = createObservationAnchorSource(core);
    expect(anchors.scene()).toBeNull();
    expect(anchors.pointerBetween(0, Date.now())).toEqual([]);
    const selection = anchors.pointerAt(Date.now());
    expect(selection.found).toBe(false);
    expect(selection.found ? null : selection.reason).toBe('empty');
  });
});

describe('ownerPidFor', () => {
  it('returns undefined for an adapter with no snapshot to read', () => {
    const window = { windowId: asWindowId('mac-window-42') } as ObservedWindow;
    expect(ownerPidFor({} as never, window)).toBeUndefined();
  });

  it('matches the window number exactly, with no first-match fallback', () => {
    const adapter = {
      lastSnapshot: {
        windows: [
          { windowNumber: 77, ownerPid: 733 },
          { windowNumber: 42, ownerPid: 501 },
        ],
      },
    } as never;
    expect(ownerPidFor(adapter, { windowId: asWindowId('mac-window-42') } as ObservedWindow)).toBe(
      501,
    );
    expect(
      ownerPidFor(adapter, { windowId: asWindowId('mac-window-9') } as ObservedWindow),
    ).toBeUndefined();
    // A window id from another platform has no macOS window number at all.
    expect(
      ownerPidFor(adapter, { windowId: asWindowId('fake-window-1') } as ObservedWindow),
    ).toBeUndefined();
  });
});
