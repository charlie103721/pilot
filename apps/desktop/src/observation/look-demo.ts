import {
  createScriptedModelSource,
  verifySelectedWindowOnly,
  type ScriptedModelSource,
} from '@pilot/agent';
import type { PilotViewState } from '@pilot/platform';
import type { ScreenObservation } from '@pilot/shared';
import { buildConversationView } from '../conversation/view-model.js';
import { buildPermissionOnboardingView } from '../permissions/view-model.js';
import { LOOK_NOW_REQUEST } from '../main/observation-runtime.js';
import { buildObservationView } from './view-model.js';
import { createObservationRig, DEMO_DESKTOP, type ObservationRig } from './observe-rig.js';

/**
 * PR-030's demo: the **model** asks to look, and so does the **user**.
 *
 * `docs/implementation.md`'s demo for PR-030 is "ask a text question that
 * causes the model to call `observe_screen` and answer from the selected
 * window". Two halves of that cannot run on this machine and it is worth being
 * exact about which:
 *
 *  - **No real pixels.** There is no macOS and no Swift toolchain here (runbook
 *    §5 amendment 8), so ScreenCaptureKit has never produced a frame. Every
 *    frame below comes from the Node helper stub that `packages/platform-mac`
 *    tests itself against, over the real framed stdio protocol, through the
 *    real `MacObservationAdapter`.
 *  - **No real model.** There is no model access here (`docs/handoff.md` §2):
 *    no sign-in, no API key, no request has ever left this machine. The "model"
 *    is Pi's own faux provider with its replies scripted
 *    (`createScriptedModelSource`), so *that* it calls `observe_screen` is
 *    chosen here rather than decided by a model. Everything the call passes
 *    through afterwards — Pi's agent loop, the tool, the §10 policy, the frame
 *    ring, the image pipeline, the tool result the provider then receives — is
 *    the shipping code.
 *
 * What this demo therefore does prove, and nothing here is simulated: the tool
 * reaches PR-019's real `PilotScreenContextService`, a real image reaches the
 * provider's inbox, the machine shows the observing state while it happens,
 * selected-window-only survives the swap, and a refusal reaches the user as a
 * sentence rather than as a log line.
 */

export interface LookDemoResult {
  readonly lines: readonly string[];
}

const RESTING = new Set<PilotViewState['state']>(['idle', 'observing', 'paused', 'error']);

function bytes(count: number): string {
  return count < 1024 ? `${String(count)} B` : `${(count / 1024).toFixed(1)} KiB`;
}

/** Waits for the run to finish. Bounded, so a wedged run fails rather than hangs. */
async function settle(rig: ObservationRig): Promise<void> {
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

/** Records every view state the machine passed through, in order, deduplicated. */
function traceStates(rig: ObservationRig): { states: string[]; stop: () => void } {
  const states: string[] = [];
  const stop = rig.controller.subscribe((view) => {
    if (states[states.length - 1] !== view.state) {
      states.push(view.state);
    }
  });
  return { states, stop };
}

/**
 * What the panel would show at this instant — through the real view models, so
 * the demo cannot claim an indicator the app does not render.
 */
function panel(rig: ObservationRig): {
  looking: boolean;
  lookingNote: string | null;
  capturing: boolean;
  stateLabel: string;
  composerAvailable: boolean;
  failure: ReturnType<typeof buildConversationView>['observationFailure'];
} {
  const view = rig.controller.snapshot();
  const permissions = buildPermissionOnboardingView(rig.permissions.snapshot());
  const observation = buildObservationView({
    gate: rig.windows.snapshot(),
    view,
    permissions,
  });
  const conversation = buildConversationView({
    view,
    gate: rig.conversation.snapshot(),
    observation,
  });
  return {
    looking: observation.looking,
    lookingNote: observation.lookingNote,
    capturing: observation.capturing,
    stateLabel: conversation.stateLabel,
    composerAvailable: conversation.composer.available,
    failure: conversation.observationFailure,
  };
}

/**
 * What the provider actually received, counted rather than printed.
 *
 * The tool result carries base64 image data; §13 forbids writing it anywhere,
 * and a demo that pasted it into a terminal would be the same mistake in a
 * friendlier costume. So the request is parsed and only shapes and sizes are
 * reported.
 */
interface InboxImage {
  readonly mimeType: string;
  readonly base64Length: number;
}

interface ToolReport {
  /** First line of the tool's text block: the compact JSON summary (§9). */
  readonly summary: string;
  readonly images: readonly InboxImage[];
  readonly isError: boolean;
}

interface RecordedMessage {
  readonly role?: unknown;
  readonly toolName?: unknown;
  readonly content?: unknown;
  readonly isError?: unknown;
}

/**
 * The last `observe_screen` result the provider was sent, read out of its own
 * inbox.
 *
 * Only the summary's **first line** is taken. The rest of the text block is the
 * fenced screen content — a window title read off the user's screen — and the
 * images are reported as a mime type and a length. Nothing here can print a
 * pixel, which is the same rule the logger and the transcript follow (§13).
 */
function lastToolResult(source: ScriptedModelSource): ToolReport | null {
  const last = source.requests[source.requests.length - 1];
  if (last === undefined) {
    return null;
  }
  const messages = JSON.parse(last) as readonly RecordedMessage[];
  let report: ToolReport | null = null;
  for (const message of messages) {
    if (message.role !== 'toolResult' || message.toolName !== 'observe_screen') {
      continue;
    }
    const blocks = Array.isArray(message.content)
      ? (message.content as readonly Record<string, unknown>[])
      : [];
    const text = blocks.find((block) => block['type'] === 'text');
    const [summary = ''] = String(text?.['text'] ?? '').split('\n');
    report = {
      summary,
      images: blocks
        .filter((block) => block['type'] === 'image')
        .map((block) => ({
          mimeType: String(block['mimeType']),
          base64Length: String(block['data'] ?? '').length,
        })),
      isError: message.isError === true,
    };
  }
  return report;
}

const GRANTED = {
  'screen-recording': 'granted',
  accessibility: 'granted',
  microphone: 'granted',
  'speech-recognition': 'granted',
} as const;

export async function runLookDemo(): Promise<LookDemoResult> {
  const lines: string[] = [];
  const say = (line: string): void => {
    lines.push(line);
  };

  say('PR-030 — model-requested real observation, and "Look now"');
  say('='.repeat(72));
  say('');
  say('Real: the `observe_screen` tool (PR-021), PilotScreenContextService');
  say('      (PR-019), ObservationSession + ObservationCore, the §10 policy and');
  say('      image pipeline, PiAgentSession and Pi’s agent loop, the interaction');
  say('      transition table, WindowGate, PermissionGate, MacObservationAdapter');
  say('      and NativeHelperTransport.');
  say('Not real: the pixels (Node helper stub — no ScreenCaptureKit here) and the');
  say('      model (Pi’s faux provider with a scripted reply — no sign-in, no');
  say('      credentials, no request ever left this machine). Section 9 lists');
  say('      everything that follows from that.');
  say('');

  const model = createScriptedModelSource({
    script: [{ observe: { view: 'window', moment: 'current' } }, { say: 'placeholder' }],
  });
  const rig = await createObservationRig({
    stub: {
      permissions: GRANTED,
      captureFrameBytes: 3_072,
      captureScaleFactor: 2,
      pointer: { x: 700, y: 480 },
      axElements: [
        {
          bounds: { x: 640, y: 440, width: 220, height: 80 },
          role: 'AXButton',
          label: 'Update payment method',
          ownerPid: 501,
        },
      ],
      desktop: DEMO_DESKTOP,
    },
    modelSource: model,
  });

  try {
    await rig.permissions.refresh();
    await rig.observation.refreshAttribution();

    // -----------------------------------------------------------------------
    // 1. the boundary that changed
    // -----------------------------------------------------------------------
    say('1. the one fake boundary PR-030 replaces');
    say(`   platform:      kind=${rig.platform.kind} — ${rig.platform.reason}`);
    say(
      `   the tool's service is the app's service: ${String(
        rig.agent.screenContext === rig.observation.screenContext,
      )}`,
    );
    say(`   service class: ${rig.agent.screenContext.constructor.name}`);
    say('   (it was `FakeScreenContextService`; `createAgentRuntime({ screenContext })`');
    say('    is the whole change on the agent side — runbook follow-up 23.)');
    say('');

    // -----------------------------------------------------------------------
    // 2. no window selected: the tool refuses before anything is captured
    // -----------------------------------------------------------------------
    say('2. with no window selected, the model is refused — never widened (§9)');
    say(`   selectedWindow: ${String(rig.observation.screenContext.status().selectedWindow)}`);
    rig.controller.dispatch({ type: 'submit-text', text: 'What does this toggle do?' });
    await settle(rig);
    const refusedReport = lastToolResult(model);
    say(`   the tool told the model: ${String(refusedReport?.summary)}`);
    say(
      `   isError=${String(refusedReport?.isError)} ` +
        `images the provider received: ${String(refusedReport?.images.length)}`,
    );
    say(
      `   observations the facade ran: ${String(rig.observation.metrics().observations)} ` +
        `(refusals ${String(rig.observation.metrics().refusals)})`,
    );
    say('   Nothing was captured: the tool checks `status().selectedWindow` first,');
    say('   so a model asking to look at a screen nobody chose costs no capture.');
    say('');

    // -----------------------------------------------------------------------
    // 3. the model looks at the selected window and gets a real image
    // -----------------------------------------------------------------------
    say('3. the model calls observe_screen and receives an image');
    const window = await rig.firstWindow();
    await rig.windows.act({ type: 'select', windowId: window.windowId });
    await rig.controller.settled();
    say(`   watching: ${window.applicationName} — "${window.title}" (${window.windowId})`);

    const capture = rig.platform.capture as unknown as { drain(): Promise<void> };
    for (let tick = 0; tick < 4; tick += 1) {
      await capture.drain();
    }
    await rig.observation.samplePointer();

    model.setScript([
      { observe: { view: 'window', moment: 'current' } },
      { say: 'The Auto Renew toggle renews the plan on the billing date.' },
    ]);
    const trace = traceStates(rig);
    const seen: ReturnType<typeof panel>[] = [];
    const watching = rig.controller.subscribe(() => {
      seen.push(panel(rig));
    });
    rig.controller.dispatch({ type: 'submit-text', text: 'What does this toggle do?' });
    await settle(rig);
    watching();
    trace.stop();

    say(`   states:   ${trace.states.join(' → ')}`);
    const observed = rig.observation.lastObservation();
    say(`   scene:    ${String(observed?.sceneId)} revision ${String(observed?.sceneRevision)}`);
    say(`   window:   "${String(observed?.windowTitle)}"`);
    say(
      `   frames:   ${(observed?.frames ?? [])
        .map((frame) => `${frame.purpose}:${frame.origin}`)
        .join(', ')}`,
    );
    const report = lastToolResult(model);
    say(
      `   the provider received: ${String(report?.images.length)} image(s) — ${(
        report?.images ?? []
      )
        .map((image) => `${image.mimeType}, ${String(image.base64Length)} base64 chars`)
        .join('; ')}`,
    );
    say(`   the tool told the model: ${String(report?.summary)}`);
    say(`   notebook entries: ${String(rig.agent.notebook.size)}`);
    const answer = rig.controller
      .snapshot()
      .transcript.filter((entry) => entry.role === 'assistant')
      .at(-1);
    say(`   and then it answered: "${String(answer?.text)}"`);
    say('   (the base64 itself is never printed, logged or written — §13.)');
    say('');

    // -----------------------------------------------------------------------
    // 4. the observing state, while it is happening
    // -----------------------------------------------------------------------
    say('4. the user can see Pilot looking, while it looks (§14)');
    const looking = seen.find((entry) => entry.looking);
    say(`   observation indicator while looking: looking=${String(looking?.looking)}`);
    say(`   capture indicator at the same moment: capturing=${String(looking?.capturing)}`);
    say(`   the panel says:  ${String(looking?.stateLabel)}`);
    say(`   next to the window: ${String(looking?.lookingNote)}`);
    say(`   after it finished: looking=${String(panel(rig).looking)}`);
    say('   (two facts, not one: capture is a stream Pilot holds open, looking is');
    say('    the moment an image of that window is read.)');
    say('');

    // -----------------------------------------------------------------------
    // 5. "Look now" — the manual observation (runbook amendment 1)
    // -----------------------------------------------------------------------
    say('5. "Look now" — the observation the user asks for');
    const before = rig.observation.metrics().observations;
    const manual = traceStates(rig);
    const manualSeen: boolean[] = [];
    const watchingManual = rig.controller.subscribe(() => {
      manualSeen.push(panel(rig).looking);
    });
    rig.controller.dispatch({ type: 'look-now' });
    await settle(rig);
    watchingManual();
    manual.stop();
    const manualMetadata = rig.observation.lastObservation();
    say(`   request:  view=${LOOK_NOW_REQUEST.view} moment=${LOOK_NOW_REQUEST.moment}`);
    say(`   states:   ${manual.states.join(' → ')}`);
    say(`   observing state seen while it ran: ${String(manualSeen.includes(true))}`);
    say(
      `   observations: ${String(before)} → ${String(rig.observation.metrics().observations)} ` +
        `(scene ${String(manualMetadata?.sceneId)} revision ${String(
          manualMetadata?.sceneRevision,
        )})`,
    );
    say(
      `   images:   ${(manualMetadata?.images ?? [])
        .map((image) => `${image.purpose} ${image.mimeType} ${bytes(image.byteLength)}`)
        .join(', ')}`,
    );
    say(`   lastError after it: ${String(rig.controller.snapshot().lastError?.code ?? 'none')}`);
    say('   (`moment: current` is the honest reading of "look now" — a fresh');
    say('    capture, not whichever frame is in the ring. `view: window` because');
    say('    the pointer crop is anchored on a question, and there is no anchor');
    say('    until PR-031.)');
    say('');

    // -----------------------------------------------------------------------
    // 6. selected-window-only, against the real service
    // -----------------------------------------------------------------------
    say('6. one service, one budget — and one scene');
    say('   The model looked in section 3 and the user looked in section 5, both');
    say('   through the same instance, so §10’s rate limiter counts them together.');
    say('   A third look inside the same second is refused:');
    try {
      await rig.observation.port.observe('observation-demo-third' as never);
      say('   NOT REFUSED — the rate limiter did not count both looks');
    } catch (cause) {
      const error = cause as {
        code?: string;
        userMessage?: string;
        details?: Record<string, unknown>;
      };
      say(
        `   ${String(error.code)} / ${String(error.details?.['failure'])} — ` +
          `"${String(error.userMessage)}" (rule ${String(error.details?.['policyRule'])})`,
      );
    }
    say('   That is the point of passing one instance rather than two: a model');
    say('   cannot spend the user’s budget, or evade it, or see a different scene.');
    say('');

    say('7. selected-window-only survives the swap (§9), checked four ways');
    // Wait out the rate-limit window rather than reconfiguring the policy: the
    // numbers under test are the shipped ones.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const first: ScreenObservation = await rig.observation.screenContext.observe(LOOK_NOW_REQUEST);
    const status = rig.observation.screenContext.status();
    say(
      `   a. lineage matches the service's own status(): ` +
        `${String(verifySelectedWindowOnly(first, status) ?? 'accepted')}`,
    );
    say(
      `      observation scene=${first.sceneId} status scene=${String(status.scene?.sceneId)} ` +
        `selected=${String(status.selectedWindow?.windowId)}`,
    );
    // The frames the observation was allowed to draw on are the ring's, and the
    // §10 `frame-window-identity` rule refuses any that is not the selected
    // window's. This counts them rather than trusting the rule ran.
    const ringFrames = rig.observation.core.frames.records();
    const framesOutside = ringFrames.filter((record) => record.frame.windowId !== window.windowId);
    say(
      `   b. retained frames: ${String(ringFrames.length)}, from any other window: ` +
        `${String(framesOutside.length)}`,
    );

    const other = rig.windows.snapshot().windows.find((row) => row.windowId !== window.windowId);
    if (other !== undefined) {
      await rig.windows.act({ type: 'select', windowId: other.windowId });
      await rig.controller.settled();
      const afterSwitch = rig.observation.screenContext.status();
      say(
        `   c. the same observation after switching to "${other.title}": ` +
          `${String(verifySelectedWindowOnly(first, afterSwitch) ?? 'accepted')}`,
      );
      say(
        `      (status scene is now ${String(afterSwitch.scene?.sceneId)}; the tool ` +
          'refuses it rather than answering from the window the user left)',
      );
    }
    say('   d. there is no whole-display request to make: `observe_screen` has two');
    say('      parameters, `view` and `moment`, and the runtime pins');
    say("      captureSource='selected-window' in ScreenContextConditions.");
    say('');

    // -----------------------------------------------------------------------
    // 7. a refusal, reaching the user
    // -----------------------------------------------------------------------
    say('8. a refused look reaches the user as a sentence (PR-021 + §16)');
    say('   Every permission reads `granted` and the observation is still refused:');
    say('   PR-011 says macOS credits the grant to the helper, so it is not a');
    say('   grant Pilot can use (runbook follow-up 16, wired by PR-028).');
    const refusedModel = createScriptedModelSource({
      script: [
        { observe: { view: 'window', moment: 'current' } },
        { say: 'I could not see the window, so I cannot say what the toggle does.' },
      ],
    });
    const refused = await createObservationRig({
      stub: {
        permissions: GRANTED,
        desktop: DEMO_DESKTOP,
        attribution: { responsibleProcessPid: 4321 },
      },
      modelSource: refusedModel,
    });
    try {
      await refused.permissions.refresh();
      const verdict = await refused.observation.refreshAttribution();
      const target = await refused.firstWindow();
      await refused.windows.act({ type: 'select', windowId: target.windowId });
      await refused.controller.settled();
      say(`   attribution: ${String(verdict?.verdict)} (${String(verdict?.confidence)})`);

      say('');
      say('   a. the model asked to look:');
      refused.controller.dispatch({ type: 'submit-text', text: 'What does this toggle do?' });
      await settle(refused);
      const refusedToolResult = lastToolResult(refusedModel);
      say(`      the tool told the model: ${String(refusedToolResult?.summary)}`);
      say(`      isError=${String(refusedToolResult?.isError)}`);
      const modelFailure = panel(refused).failure;
      say(`      the panel shows: "${String(modelFailure?.userMessage)}"`);
      say(
        `      kind=${String(modelFailure?.failure)} code=${String(modelFailure?.code)} ` +
          `retryable=${String(modelFailure?.retryable)}`,
      );
      say(`      and: ${String(modelFailure?.hint)}`);

      say('');
      say('   b. the user pressed Look now:');
      refused.controller.dispatch({ type: 'dismiss-error' });
      await refused.controller.settled();
      refused.controller.dispatch({ type: 'look-now' });
      await settle(refused);
      const manualFailure = panel(refused).failure;
      say(`      the panel shows: "${String(manualFailure?.userMessage)}"`);
      say(
        `      kind=${String(manualFailure?.failure)} code=${String(manualFailure?.code)} ` +
          `retryable=${String(manualFailure?.retryable)} rule=${String(manualFailure?.policyRule)}`,
      );
      say('      Both paths land on one taxonomy: `main/observation-failure.ts`');
      say('      gives the manual refusal the shape PR-021 gives the tool one, so');
      say('      the panel has one thing to render and the user is not shown an');
      say('      adapter’s log line.');
      say(
        `      state=${refused.controller.snapshot().state}, and the text box is still ` +
          `live: ${String(panel(refused).composerAvailable)} — system-design §16.`,
      );
    } finally {
      await refused.dispose();
    }
    say('');

    // -----------------------------------------------------------------------
    // 8. what none of this proves
    // -----------------------------------------------------------------------
    say('9. what none of the above proves (docs/handoff.md §1 step 8, §2)');
    for (const [head, ...rest] of [
      [
        'no model chose to call observe_screen. The call above is scripted, so',
        'this says nothing about whether a real model looks when it should, or',
        'what it makes of the image once it has it.',
      ],
      [
        'no provider ever received these bytes. Pi’s faux provider accepts the',
        'image block and discards it; provider-side image encoding is exactly',
        'what handoff §2 says the mock cannot show.',
      ],
      [
        'no pixel is real. The stub’s frames are deterministic bytes whose',
        'headers are meaningful and whose contents are not a decodable image,',
        'so the pointer-crop path (§10 step 5) is not reachable here at all.',
      ],
      [
        'no TCC prompt has appeared and no attribution verdict above is',
        'evidence — the stub invents its own identity.',
      ],
      ['the Swift helper has never been compiled.'],
    ]) {
      say(`   - ${String(head)}`);
      for (const line of rest) {
        say(`     ${line}`);
      }
    }
  } finally {
    await rig.dispose();
  }

  return { lines };
}
