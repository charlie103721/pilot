import { afterEach, describe, expect, it } from 'vitest';
import {
  PilotError,
  createJsonSink,
  createLogger,
  type ObservedWindow,
  type PilotErrorCode,
} from '@pilot/shared';
import type { PilotViewState } from '@pilot/platform';
import {
  createScriptedModelSource,
  observeScreenParameters,
  verifySelectedWindowOnly,
  type ScriptedModelSource,
  type ScriptedStep,
} from '@pilot/agent';
import {
  createObservationRig,
  DEMO_DESKTOP,
  type ObservationRig,
} from '../../src/observation/observe-rig.js';
import { LOOK_NOW_REQUEST } from '../../src/main/observation-runtime.js';
import { toObservationFailureError } from '../../src/main/observation-failure.js';
import { readObservationFailure } from '../../src/observation/failure-view.js';

/**
 * PR-030 — the model asks to look, at the real screen-context service.
 *
 * The one fake boundary this PR replaces is the `ScreenContextService` behind
 * `observe_screen`: `createAgentRuntime({ screenContext })` now receives
 * PR-019's `PilotScreenContextService` — the same instance the interaction
 * table's "Look now" drives — instead of `FakeScreenContextService`. Everything
 * these cases exercise below the tool is the shipping composition, assembled by
 * `src/observation/observe-rig.ts` exactly as `main/index.ts` assembles it.
 *
 * **What is not real, and cannot be here.**
 *
 *  - *The pixels.* There is no macOS and no Swift toolchain (runbook §5
 *    amendment 8), so the frames come from the Node helper stub over the real
 *    framed stdio protocol. Its bytes are not a decodable image, so the
 *    decode-and-crop half of §10 step 5 is unreachable from here; `view:
 *    'window'` on an unchanged frame is the pass-through path (PR-018) and that
 *    is what runs.
 *  - *The model.* There is no model access (`docs/handoff.md` §2), so Pi's faux
 *    provider is scripted to call the tool. That the call happens is decided
 *    here; everything it goes through afterwards is not.
 *
 * The single most important group is the last one. PR-021 proved
 * selected-window-only four ways against `FakeScreenContextService`; a
 * regression after the swap would be a privacy breach rather than a bug, so it
 * is proved again against the real service and its own `status()`.
 */

const GRANTED = {
  'screen-recording': 'granted',
  accessibility: 'granted',
  microphone: 'granted',
  'speech-recognition': 'granted',
} as const;

const RESTING = new Set<PilotViewState['state']>(['idle', 'observing', 'paused', 'error']);

let open: ObservationRig[] = [];

afterEach(async () => {
  const rigs = open;
  open = [];
  for (const rig of rigs) {
    await rig.dispose();
  }
});

async function rig(
  options: {
    readonly script?: readonly ScriptedStep[];
    readonly stub?: Record<string, unknown>;
  } = {},
): Promise<{ rig: ObservationRig; model: ScriptedModelSource }> {
  const model = createScriptedModelSource({ script: options.script ?? [] });
  const built = await createObservationRig({
    stub: {
      permissions: GRANTED,
      captureFrameBytes: 3_072,
      captureScaleFactor: 2,
      pointer: { x: 700, y: 480 },
      desktop: DEMO_DESKTOP,
      ...(options.stub ?? {}),
    },
    modelSource: model,
  });
  open.push(built);
  await built.permissions.refresh();
  await built.observation.refreshAttribution();
  return { rig: built, model };
}

/** Selects the first window and fills the ring, as the app does on selection. */
async function watchFirstWindow(built: ObservationRig): Promise<ObservedWindow> {
  const window = await built.firstWindow();
  await built.windows.act({ type: 'select', windowId: window.windowId });
  await built.controller.settled();
  const capture = built.platform.capture as unknown as { drain(): Promise<void> };
  for (let tick = 0; tick < 4; tick += 1) {
    await capture.drain();
  }
  await built.observation.samplePointer();
  return window;
}

async function settle(built: ObservationRig): Promise<void> {
  await built.controller.settled();
  const deadline = Date.now() + 20_000;
  while (!RESTING.has(built.controller.snapshot().state)) {
    if (Date.now() > deadline) {
      throw new Error(`run never settled; stuck in ${built.controller.snapshot().state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await built.controller.settled();
}

interface ToolResultRecord {
  readonly summaryLine: string;
  readonly imageBlocks: readonly { mimeType: string; length: number }[];
  readonly isError: boolean;
}

/** The `observe_screen` result the provider was actually sent, images counted. */
function lastToolResult(model: ScriptedModelSource): ToolResultRecord | null {
  const last = model.requests[model.requests.length - 1];
  if (last === undefined) {
    return null;
  }
  const messages = JSON.parse(last) as readonly Record<string, unknown>[];
  let found: ToolResultRecord | null = null;
  for (const message of messages) {
    if (message['role'] !== 'toolResult' || message['toolName'] !== 'observe_screen') {
      continue;
    }
    const blocks = (message['content'] ?? []) as readonly Record<string, unknown>[];
    const text = blocks.find((block) => block['type'] === 'text');
    const [summaryLine = ''] = String(text?.['text'] ?? '').split('\n');
    found = {
      summaryLine,
      imageBlocks: blocks
        .filter((block) => block['type'] === 'image')
        .map((block) => ({
          mimeType: String(block['mimeType']),
          length: String(block['data'] ?? '').length,
        })),
      isError: message['isError'] === true,
    };
  }
  return found;
}

/** The `details` the tool put on the last result message, for the byte checks. */
function toolResultDetails(model: ScriptedModelSource): unknown {
  const last = model.requests[model.requests.length - 1];
  if (last === undefined) {
    return null;
  }
  const messages = JSON.parse(last) as readonly Record<string, unknown>[];
  const results = messages.filter((message) => message['role'] === 'toolResult');
  return results[results.length - 1]?.['details'] ?? null;
}

const LOOK = { observe: { view: 'window', moment: 'current' } } as const;

describe('the model calls observe_screen and reaches the real service', () => {
  it('is wired to the same instance the app drives, not to a fake', async () => {
    const { rig: built } = await rig();
    expect(built.agent.screenContext).toBe(built.observation.screenContext);
    expect(built.agent.screenContext.constructor.name).toBe('PilotScreenContextService');
  }, 60_000);

  it('answers a typed question with a real image of the selected window', async () => {
    const { rig: built, model } = await rig({
      script: [LOOK, { say: 'The Auto Renew toggle renews the plan on the billing date.' }],
    });
    const window = await watchFirstWindow(built);

    built.controller.dispatch({ type: 'submit-text', text: 'What does this toggle do?' });
    await settle(built);

    const result = lastToolResult(model);
    expect(result?.isError).toBe(false);
    // The provider's own inbox: an image block, with real bytes behind it.
    expect(result?.imageBlocks).toHaveLength(1);
    expect(result?.imageBlocks[0]?.mimeType).toBe('image/png');
    expect(result?.imageBlocks[0]?.length).toBeGreaterThan(1_000);
    expect(result?.summaryLine).toContain('"status":"ok"');
    expect(result?.summaryLine).toContain('"source":"selected-window-only"');

    // The facade ran, and it observed the window the user selected.
    const metadata = built.observation.lastObservation();
    expect(built.observation.metrics().observations).toBe(1);
    expect(metadata?.windowTitle).toBe(window.title);
    expect(built.observation.screenContext.status().selectedWindow?.windowId).toBe(window.windowId);

    // The answer arrived after the look, and the observation was written down
    // for PR-022a's pruner (runbook follow-up 4, still wired).
    expect(built.agent.notebook.size).toBe(1);
    const answer = built.controller
      .snapshot()
      .transcript.filter((entry) => entry.role === 'assistant')
      .at(-1);
    expect(answer?.text).toContain('Auto Renew');
  }, 60_000);

  it('shows the observing state while it is looking, and stops showing it after', async () => {
    const { rig: built } = await rig({ script: [LOOK, { say: 'done' }] });
    await watchFirstWindow(built);

    const states: PilotViewState['state'][] = [];
    const stop = built.controller.subscribe((view) => {
      if (states[states.length - 1] !== view.state) {
        states.push(view.state);
      }
    });
    built.controller.dispatch({ type: 'submit-text', text: 'What does this toggle do?' });
    await settle(built);
    stop();

    expect(states).toContain('observing-screen');
    expect(built.controller.snapshot().state).not.toBe('observing-screen');
  }, 60_000);

  it('keeps image bytes out of the log, the diagnostics and the tool details', async () => {
    // PR-023 proved this on real disk. The swap moves real images through a
    // path that logs, so it is proved again here for the log and for the two
    // records a real observation now produces.
    const lines: string[] = [];
    const model = createScriptedModelSource({ script: [LOOK, { say: 'done' }] });
    const built = await createObservationRig({
      stub: {
        permissions: GRANTED,
        captureFrameBytes: 3_072,
        captureScaleFactor: 2,
        desktop: DEMO_DESKTOP,
      },
      modelSource: model,
      logger: createLogger({
        scope: 'test.model-observation',
        level: 'debug',
        sink: createJsonSink((line) => lines.push(line)),
      }),
    });
    open.push(built);
    await built.permissions.refresh();
    await watchFirstWindow(built);

    built.controller.dispatch({ type: 'submit-text', text: 'What does this toggle do?' });
    await settle(built);

    // The observation really happened and really carried bytes …
    const metadata = built.observation.lastObservation();
    expect(metadata?.totalImageBytes).toBeGreaterThan(0);
    expect(lastToolResult(model)?.imageBlocks[0]?.length).toBeGreaterThan(1_000);

    // … and none of them are anywhere they should not be. A base64 payload is
    // the only thing in this system that looks like a long unbroken run of
    // base64 characters.
    const base64ish = /[A-Za-z0-9+/]{200,}/;
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => base64ish.test(line))).toHaveLength(0);
    // `ScreenObservationMetadata` is content-free by construction (PR-019) and
    // is what the diagnostics ring and the observation log read.
    expect(JSON.stringify(metadata)).not.toMatch(base64ish);
    // And the tool's own `details`, which is persisted on the result message.
    expect(JSON.stringify(toolResultDetails(model))).not.toMatch(base64ish);
  }, 60_000);
});

describe('"Look now" — the manual observation (runbook amendment 1)', () => {
  it('asks for a fresh capture of the selected window and completes', async () => {
    const { rig: built } = await rig();
    await watchFirstWindow(built);

    expect(LOOK_NOW_REQUEST).toEqual({ view: 'window', moment: 'current' });
    const before = built.observation.metrics().observations;
    const states: PilotViewState['state'][] = [];
    const stop = built.controller.subscribe((view) => {
      if (states[states.length - 1] !== view.state) {
        states.push(view.state);
      }
    });
    built.controller.dispatch({ type: 'look-now' });
    await settle(built);
    stop();

    expect(states).toContain('observing-screen');
    expect(built.observation.metrics().observations).toBe(before + 1);
    expect(built.observation.lastObservation()?.moment).toBe('current');
    expect(built.observation.lastObservation()?.view).toBe('window');
    expect(built.controller.snapshot().lastError).toBeNull();
    expect(built.controller.snapshot().state).toBe('observing');
  }, 60_000);

  it('reaches the user as a readable sentence when it is refused', async () => {
    // Every permission reads `granted`, and PR-011's verdict says macOS credits
    // the grant to the helper — so the facade refuses (PR-028, follow-up 16).
    const { rig: built } = await rig({ stub: { attribution: { responsibleProcessPid: 4321 } } });
    await watchFirstWindow(built);

    built.controller.dispatch({ type: 'look-now' });
    await settle(built);

    const view = built.controller.snapshot();
    expect(view.state).toBe('error');
    const failure = readObservationFailure(view.lastError);
    expect(failure?.failure).toBe('permission-denied');
    expect(failure?.code).toBe('permission-denied');
    expect(failure?.retryable).toBe(false);
    expect(failure?.policyRule).toBe('screen-recording-permission');
    // A sentence, not an adapter's log line.
    expect(failure?.userMessage).toMatch(/^Pilot /);
    expect(failure?.userMessage).not.toContain('Screen policy [');
  }, 60_000);

  it('leaves the model’s refusal shape untouched, so both paths render the same', async () => {
    const { rig: built, model } = await rig({
      script: [LOOK, { say: 'I could not see the window.' }],
      stub: { attribution: { responsibleProcessPid: 4321 } },
    });
    await watchFirstWindow(built);

    built.controller.dispatch({ type: 'submit-text', text: 'What does this toggle do?' });
    await settle(built);

    const result = lastToolResult(model);
    expect(result?.isError).toBe(true);
    expect(result?.imageBlocks).toHaveLength(0);
    expect(result?.summaryLine).toContain('"failure":"permission-denied"');

    const failure = readObservationFailure(built.controller.snapshot().lastError);
    expect(failure?.failure).toBe('permission-denied');
    expect(failure?.userMessage).toBe(
      'Pilot needs Screen Recording permission to look at your screen.',
    );
  }, 60_000);
});

describe('selected-window-only survives the swap (system-design §9)', () => {
  it('refuses with no window selected, and captures nothing at all', async () => {
    const { rig: built, model } = await rig({
      script: [LOOK, { say: 'I cannot see a window.' }],
    });

    expect(built.observation.screenContext.status().selectedWindow).toBeNull();
    built.controller.dispatch({ type: 'submit-text', text: 'What does this toggle do?' });
    await settle(built);

    const result = lastToolResult(model);
    expect(result?.isError).toBe(true);
    expect(result?.summaryLine).toContain('"failure":"no-window-selected"');
    expect(result?.imageBlocks).toHaveLength(0);
    // Nothing was captured: the refusal is before the facade is asked.
    expect(built.observation.metrics().observations).toBe(0);
    expect(built.observation.metrics().refusals).toBe(0);
  }, 60_000);

  it("accepts an observation whose lineage matches the service's own status()", async () => {
    const { rig: built } = await rig();
    const window = await watchFirstWindow(built);

    const observation = await built.observation.screenContext.observe(LOOK_NOW_REQUEST);
    const status = built.observation.screenContext.status();

    expect(verifySelectedWindowOnly(observation, status)).toBeUndefined();
    expect(status.selectedWindow?.windowId).toBe(window.windowId);
    expect(observation.sceneId).toBe(status.scene?.sceneId);
    // Every frame the ring is holding is the selected window's; the §10
    // `frame-window-identity` rule is what refuses any other.
    const foreign = built.observation.core.frames
      .records()
      .filter((record) => record.frame.windowId !== window.windowId);
    expect(foreign).toHaveLength(0);
  }, 60_000);

  it('refuses an observation of the window the user has since left', async () => {
    const { rig: built } = await rig();
    const window = await watchFirstWindow(built);
    const observation = await built.observation.screenContext.observe(LOOK_NOW_REQUEST);

    const other = built.windows
      .snapshot()
      .windows.find((candidate) => candidate.windowId !== window.windowId);
    expect(other).toBeDefined();
    await built.windows.act({ type: 'select', windowId: other?.windowId ?? window.windowId });
    await built.controller.settled();

    const afterSwitch = built.observation.screenContext.status();
    expect(afterSwitch.scene?.sceneId).not.toBe(observation.sceneId);
    expect(verifySelectedWindowOnly(observation, afterSwitch)).toBe('scene-changed');
  }, 60_000);

  it('has no whole-display request to make, and pins the capture source', async () => {
    const { rig: built } = await rig();
    await watchFirstWindow(built);

    // There is no display parameter for a model to ask with: the schema Pi
    // validates arguments against has exactly two properties.
    expect(Object.keys(observeScreenParameters.properties)).toEqual(['view', 'moment']);
    const observation = await built.observation.screenContext.observe(LOOK_NOW_REQUEST);
    expect(observation.images.map((image) => image.purpose)).toEqual(['window']);

    // And the conditions the facade evaluates §10 step 1 against never widen.
    built.observation.inputs.setConditions({
      permissions: { screenRecording: 'granted', accessibility: 'granted' },
      captureSource: 'display',
    });
    await expect(built.observation.screenContext.observe(LOOK_NOW_REQUEST)).rejects.toMatchObject({
      code: 'invalid-request',
    });
  }, 60_000);
});

describe('the capability gate still refuses before any screen data moves', () => {
  it('never reaches the service when the model has no vision', async () => {
    const model = createScriptedModelSource({ vision: false, script: [LOOK] });
    const built = await createObservationRig({
      stub: { permissions: GRANTED, desktop: DEMO_DESKTOP },
      modelSource: model,
    });
    open.push(built);
    await built.permissions.refresh();
    await watchFirstWindow(built);

    built.controller.dispatch({ type: 'submit-text', text: 'What does this toggle do?' });
    await settle(built);

    expect(built.agent.capability.ok).toBe(false);
    expect(model.requestCount()).toBe(0);
    expect(built.observation.metrics().observations).toBe(0);
    expect(built.controller.snapshot().state).toBe('error');
  }, 60_000);
});

describe('giving a manual refusal the tool’s shape', () => {
  it('adds the PR-021 taxonomy and keeps a curated sentence', () => {
    const policy = new PilotError('rate-limited', 'Screen policy [rate-limit]: too many', {
      userMessage: 'Pilot is looking at the screen too often. Try again in a moment.',
      retryable: true,
      details: { policyRule: 'rate-limit', policyStep: 'validate', retryAfterMs: 900 },
    });

    const wrapped = toObservationFailureError(policy, LOOK_NOW_REQUEST);
    expect(wrapped.code).toBe('rate-limited');
    expect(wrapped.userMessage).toBe(policy.userMessage);
    expect(wrapped.details).toEqual({
      tool: 'observe_screen',
      failure: 'policy-rejected',
      view: 'window',
      moment: 'current',
      policyRule: 'rate-limit',
      policyStep: 'validate',
    });
    // `retryAfterMs` is dropped rather than forwarded: `details` is rebuilt from
    // known-content-free fields, not spread.
    expect(wrapped.details?.['retryAfterMs']).toBeUndefined();
  });

  it('replaces a technical message with PR-021’s sentence when there is no curated one', () => {
    const raw = new Error('helper exited during capture.pull');
    const wrapped = toObservationFailureError(raw, LOOK_NOW_REQUEST);

    expect(wrapped.code).toBe('capture-failed' satisfies PilotErrorCode);
    expect(wrapped.details?.['failure']).toBe('blank-capture');
    expect(wrapped.userMessage).toBe('Pilot could not capture the window just now.');
    expect(wrapped.retryable).toBe(true);
    // The technical text survives where it belongs: in `message`, for the log.
    expect(wrapped.message).toBe('helper exited during capture.pull');
  });

  it('returns a tool-produced error untouched', () => {
    const fromTool = new PilotError('window-closed', 'gone', {
      userMessage: 'The window Pilot was watching is gone. Select a window again.',
      details: { tool: 'observe_screen', failure: 'window-lost' },
    });
    expect(toObservationFailureError(fromTool, LOOK_NOW_REQUEST)).toBe(fromTool);
  });
});
