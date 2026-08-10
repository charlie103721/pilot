import { nullLogger, type Logger, type ObservedWindow } from '@pilot/shared';
import { NativeHelperTransport, type MacHotkeyAdapter } from '@pilot/platform-mac';
import {
  createTimeoutScheduler,
  type PilotInteractionController,
  type Scheduler,
} from '@pilot/interaction';
import { createAgentRuntime } from '../main/agent-runtime.js';
import { ConversationGate } from '../main/conversation-gate.js';
import {
  createInteractionRuntime,
  createObservationInteraction,
} from '../main/interaction-runtime.js';
import {
  createObservationRuntime,
  retentionEventForFeed,
  type ObservationRuntime,
} from '../main/observation-runtime.js';
import { createPlatformRuntime, type PlatformRuntime } from '../main/platform-runtime.js';
import {
  createQuestionAnchorRuntime,
  type QuestionAnchorRuntime,
} from '../main/question-anchor.js';
import { PermissionGate } from '../main/permission-gate.js';
import { createSettingsShortcut } from '../main/settings-shortcut.js';
import { createSpeechOutputRuntime, type SpeechOutputRuntime } from '../main/speech-runtime.js';
import { createVoiceRuntime, type VoiceRuntime } from '../main/voice-runtime.js';
import { WindowGate } from '../main/window-gate.js';
import { createDevelopmentModelSource, type ModelSource } from '@pilot/agent';
import { asConversationId } from '@pilot/shared';
import type { AgentRuntime } from '../main/agent-runtime.js';

/**
 * The shell's observation path, assembled exactly as `main/index.ts` assembles
 * it, over the Node helper stub (PR-028).
 *
 * There is no macOS and no Swift toolchain on this machine (runbook §5
 * amendment 8), so `docs/implementation.md`'s demo for PR-028 — "select a real
 * window, inspect local frames/pointer target, pause, and verify immediate
 * clearing" — **cannot be run here**. This is its stub-driven equivalent: every
 * line of it is the shipping composition (`WindowGate`, `PilotInteractionController`,
 * `ObservationSession`, `PilotScreenContextService`, `MacObservationAdapter`,
 * `MacWindowAdapter`, `MacPermissionAdapter`, `MacAccessibilityAdapter`,
 * `NativeHelperTransport`) and the only stand-in is the process on the far end
 * of the pipe. What that stand-in cannot say anything about is listed in
 * `docs/handoff.md` §1 and printed by the demo itself.
 *
 * Shared with `test/main/observation-runtime.test.ts` on purpose: a demo that
 * assembles the app differently from the tests proves something about a third
 * thing.
 */

/** Absolute path to `packages/platform-mac/test/support/helper-stub.ts`. */
export function helperStubPath(): string {
  return new URL('../../../../packages/platform-mac/test/support/helper-stub.ts', import.meta.url)
    .pathname;
}

/**
 * The desktop the stub describes: one 2× display and two ordinary windows.
 *
 * Declared here rather than imported from `packages/platform-mac/test/support`
 * for the reason that package declares its own: a fixture shared with the code
 * under test cannot catch a drift between them. These are the same numbers
 * `@pilot/platform/fakes` uses, so a comparison across the two builds compares
 * like with like.
 */
export const DEMO_DISPLAYS = [
  {
    displayNumber: 1,
    bounds: { x: 0, y: 0, width: 1728, height: 1117 },
    scaleFactor: 2,
    isPrimary: true,
  },
] as const;

export const DEMO_WINDOWS = [
  {
    windowNumber: 42,
    ownerPid: 501,
    applicationName: 'Safari',
    applicationBundleId: 'com.apple.Safari',
    title: 'Billing Settings',
    titleAvailable: true,
    bounds: { x: 100, y: 80, width: 1200, height: 800 },
    displayNumber: 1,
    isOnScreen: true,
    layer: 0,
  },
  {
    windowNumber: 77,
    ownerPid: 733,
    applicationName: 'Notes',
    applicationBundleId: 'com.apple.Notes',
    title: 'Release checklist',
    titleAvailable: true,
    bounds: { x: 420, y: 200, width: 700, height: 520 },
    displayNumber: 1,
    isOnScreen: true,
    layer: 0,
  },
] as const;

/** The same desktop with the selected window gone. */
export const DEMO_DESKTOP_AFTER_CLOSE = {
  windows: [DEMO_WINDOWS[1]],
  displays: DEMO_DISPLAYS,
} as const;

export const DEMO_DESKTOP = { windows: DEMO_WINDOWS, displays: DEMO_DISPLAYS } as const;

export interface ObservationRigOptions {
  /** Stub behaviour, as `StubConfig` in `packages/platform-mac/test/support`. */
  readonly stub?: Record<string, unknown>;
  readonly stubPath?: string;
  readonly logger?: Logger;
  /** Long by default: the rig drives every poll itself, so nothing races. */
  readonly pointerSampleIntervalMs?: number;
  /**
   * Drain interval for the capture stream (PR-031). Left at the adapter's own
   * default so PR-028's and PR-030's walkthroughs are unchanged; a caller that
   * pushes its own decodable frames sets it long and owns the ring, because a
   * stub frame landing between a screenshot and the question anchored on it
   * would make `moment: 'question'` fail to decode.
   */
  readonly capturePollIntervalMs?: number;
  /**
   * The model (PR-030). Defaults to {@link createDevelopmentModelSource}, which
   * answers every question the same way and never calls a tool. Pass
   * `createScriptedModelSource` to make the model call `observe_screen`.
   */
  readonly modelSource?: ModelSource;
  /**
   * Record every helper operation this rig sends (PR-031).
   *
   * The outside-window rule is a claim about what Pilot *asks the platform*,
   * not only about what it does with the answer: PR-013 proved it at the wire
   * by showing `accessibility.element-at` is never sent for a pointer outside
   * the selected window. With the question anchor wired, that claim has to hold
   * for the application and not only for the adapter, so the rig can record the
   * wire and a test can read it. Off by default — recording costs an array per
   * request and proves nothing the tests do not ask for.
   */
  readonly recordRequests?: boolean;
  /**
   * Stuck-key watchdog interval for the push-to-talk tap (PR-032). Long by
   * default, like every other timer here: a walkthrough that raced a
   * one-second watchdog would print a synthetic release nobody asked for.
   */
  readonly holdWatchdogIntervalMs?: number;
  /**
   * Drain interval for the recogniser's event queue (PR-032). Left at
   * `MacSpeechInputAdapter`'s own 60 ms, because unlike every other poller here
   * this one is what makes a *partial* transcript arrive at all, and the point
   * of the demo is watching them arrive.
   */
  readonly speechPollIntervalMs?: number;
  /**
   * The phrase-timeout wake-up (PR-033, runbook follow-up 25).
   *
   * Defaults to `createTimeoutScheduler()`, which is what `main/index.ts`
   * passes. A walkthrough that wants PR-026's behaviour — the tail released
   * only when the run ends — passes `NULL_SCHEDULER` and says so.
   */
  readonly scheduler?: Scheduler;
}

/**
 * What the stub's synthesiser does unless a caller scripts it (PR-033).
 *
 * The stub's own default is `started` alone, which is right for the
 * interruption tests `packages/platform-mac` wrote it for and wrong for an
 * application: an utterance that never finishes leaves the machine in
 * `speaking` for ever — runbook cross-lane issue 10, one layer down. A rig that
 * assembles the *app* therefore completes the utterance, and a caller that
 * wants a hanging one (or a failing one) says so in its own `speechOutput`.
 */
export const DEMO_SPEECH_OUTPUT = {
  scripts: [[{ type: 'started' }, { type: 'finished' }]],
} as const;

/** One operation, as it crossed the framed stdio protocol. */
export interface RecordedRequest {
  readonly op: string;
  readonly payload: Record<string, unknown>;
}

export interface ObservationRig {
  readonly platform: PlatformRuntime;
  readonly observation: ObservationRuntime;
  readonly controller: PilotInteractionController;
  readonly permissions: PermissionGate;
  readonly windows: WindowGate;
  readonly conversation: ConversationGate;
  readonly transport: NativeHelperTransport;
  /**
   * The agent, holding the *same* `PilotScreenContextService` the port drives
   * (PR-030). `agent.screenContext === observation.screenContext`.
   */
  readonly agent: AgentRuntime;
  /**
   * The question anchor (PR-031), over the *same* `ObservationCore` the pointer
   * poller feeds and the same inputs the facade reads.
   */
  readonly anchoring: QuestionAnchorRuntime;
  /**
   * Push-to-talk (PR-032), over the *same* `MacHotkeyAdapter` the panel's
   * availability comes from and dispatching into the same controller.
   *
   * **Not started.** `voice.start()` establishes attribution and installs the
   * tap; a rig that installed it on construction would play the stub's hotkey
   * script into every PR-028/030/031 walkthrough that never asked for a key.
   */
  readonly voice: VoiceRuntime;
  /**
   * Speech output (PR-033), over the *same* `MacSpeechOutputAdapter` the
   * controller speaks through. `speech.stats()` counts what was spoken and what
   * was silenced; `speech.speechOutput` is the seam itself, for the one call a
   * machine never makes — a `stop()` for a stream that was never started.
   */
  readonly speech: SpeechOutputRuntime;
  /**
   * The tap itself, for the two things `VoiceRuntime` deliberately does not
   * expose: re-issuing `hotkey.start` (which is how the Node stub is asked to
   * play its *next* scripted key — on a Mac the user simply presses the key)
   * and running the stuck-key watchdog by hand.
   */
  readonly hotkey: MacHotkeyAdapter;
  /**
   * Every helper operation sent since the rig was built, oldest first — empty
   * unless {@link ObservationRigOptions.recordRequests} was set.
   */
  readonly wire: readonly RecordedRequest[];
  /** The first selectable window the platform reports. */
  firstWindow(): Promise<ObservedWindow>;
  dispose(): Promise<void>;
}

/**
 * Builds the rig and starts the helper.
 *
 * The four wirings that make the difference between a working observation path
 * and one that looks broken are all here, and each is a recorded follow-up:
 * permission states plus the attribution verdict into the facade (16), the
 * retention occasion onto every clear (17), the real port into
 * `createInteractionRuntime` (23), and — PR-030, the other half of 23 — the
 * real `ScreenContextService` into `createAgentRuntime`.
 */
export async function createObservationRig(
  options: ObservationRigOptions = {},
): Promise<ObservationRig> {
  const logger = options.logger ?? nullLogger;
  const stubPath = options.stubPath ?? helperStubPath();
  // The caller's script wins; see DEMO_SPEECH_OUTPUT for why there is a default
  // at all.
  const stub: Record<string, unknown> = { speechOutput: DEMO_SPEECH_OUTPUT, ...options.stub };
  const transport = new NativeHelperTransport({
    command: process.execPath,
    args: [stubPath],
    env: { ...process.env, PILOT_HELPER_STUB: JSON.stringify(stub) },
    requestTimeoutMs: 5_000,
    handshakeTimeoutMs: 5_000,
    readyTimeoutMs: 8_000,
    shutdownGraceMs: 250,
    restart: { enabled: false },
    logger,
  });

  // The recorder sits between the adapters and the transport, so what it sees
  // is exactly what crossed the pipe — not what a caller intended to send.
  const wire: RecordedRequest[] = [];
  const observed =
    options.recordRequests !== true
      ? transport
      : (new Proxy(transport, {
          get(target, property): unknown {
            if (property === 'request') {
              return (operation: { name: string }, payload: unknown, extra?: unknown) => {
                wire.push({
                  op: operation.name,
                  payload: (payload ?? {}) as RecordedRequest['payload'],
                });
                return (
                  target.request as unknown as (
                    a: unknown,
                    b: unknown,
                    c: unknown,
                  ) => Promise<unknown>
                ).call(target, operation, payload, extra);
              };
            }
            // Two arguments, not three: the private fields of
            // `NativeHelperTransport` are only reachable when the receiver *is*
            // the transport, and a proxy receiver would make every getter throw.
            const value: unknown = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as NativeHelperTransport);

  const platform = createPlatformRuntime({
    env: { ...process.env, PILOT_HELPER_STUB_PATH: stubPath },
    transport: observed,
    logger,
    // Nothing polls on its own: the rig calls `refresh()` where the app would
    // have waited for a tick, so a walkthrough reads the same every time.
    pollIntervalMs: 3_600_000,
    ...(options.capturePollIntervalMs === undefined
      ? {}
      : { capturePollIntervalMs: options.capturePollIntervalMs }),
    holdWatchdogIntervalMs: options.holdWatchdogIntervalMs ?? 3_600_000,
    ...(options.speechPollIntervalMs === undefined
      ? {}
      : { speechPollIntervalMs: options.speechPollIntervalMs }),
    // `permissionIdentity` is left to the platform runtime's own stub default
    // (the identity `helper-stub.ts` claims), so PR-011's verdict comes back
    // `matched` and the *failing* verdict stays a scriptable case rather than
    // the only case.
  });
  // The rig owns the helper process, so it starts it; `platform.start()` only
  // starts a transport it created itself.
  await transport.start();
  await platform.start();

  // The rig always runs against a helper, so `createPlatformRuntime` always
  // takes a `macos-stub` branch and both voice adapters exist. Stated rather
  // than assumed, because the alternative is a confusing failure much later.
  const hotkeyAdapter = platform.hotkey;
  const speechAdapter = platform.speechInput;
  const synthesiser = platform.speechOutput;
  if (hotkeyAdapter === null || speechAdapter === null || synthesiser === null) {
    throw new Error(`the rig expected the macOS adapters, got kind=${platform.kind}`);
  }

  const observation = createObservationRuntime({
    capture: platform.capture,
    windows: platform.windows,
    accessibility: platform.accessibility,
    ...(platform.permissions.attribution === undefined
      ? {}
      : { attribution: platform.permissions.attribution.bind(platform.permissions) }),
    logger,
    pointerSampleIntervalMs: options.pointerSampleIntervalMs ?? 3_600_000,
  });

  const conversationId = asConversationId('conv-observe-demo');
  // PR-030's one-argument change, in the rig exactly as in `main/index.ts`:
  // `observe_screen` reaches the same `PilotScreenContextService` instance the
  // interaction table's "Look now" drives.
  const agent = createAgentRuntime({
    conversationId,
    source: options.modelSource ?? createDevelopmentModelSource(),
    screenContext: observation.screenContext,
    logger,
  });
  // PR-031's wiring, in the rig exactly as in `main/index.ts`.
  const anchoring = createQuestionAnchorRuntime({
    core: observation.core,
    inputs: observation.inputs,
    targets: observation.targets,
    logger,
  });
  // PR-032's wiring, in the rig exactly as in `main/index.ts`: the real
  // recogniser behind the machine's `start-listening`/`stop-listening`. And
  // PR-033's: the real synthesiser behind `speak`/`stop-speech`, plus the
  // phrase-timeout scheduler the app now passes.
  const speech = createSpeechOutputRuntime({
    adapter: synthesiser,
    // Disposing the runtime silences the synthesiser too. `platform.dispose()`
    // does it again later and `MacSpeechOutputAdapter.dispose` is idempotent;
    // what matters is that the sound stops at the first teardown step, not the
    // last.
    dispose: () => synthesiser.dispose(),
    logger,
  });
  const { controller } = createInteractionRuntime({
    agent: agent.session,
    conversationId,
    observation: observation.port,
    envelopes: anchoring.envelopes,
    speechInput: speechAdapter,
    speechOutput: speech.speechOutput,
    scheduler: options.scheduler ?? createTimeoutScheduler(),
    logger,
  });
  await speech.start();
  controller.subscribe((view) => {
    observation.noteViewState(view);
    anchoring.noteActiveUtterance(controller.context.activeUtteranceId);
  });
  observation.noteViewState(controller.snapshot());

  const permissions = new PermissionGate({
    adapter: platform.permissions,
    settings: createSettingsShortcut({ platform: 'darwin', adapter: platform.permissions }),
    logger,
  });
  permissions.subscribe((state) => {
    observation.notePermissions(state.snapshot);
    if (state.snapshot !== null) {
      controller.send({ type: 'permissions-changed', permissions: state.snapshot });
    }
  });

  // PR-032. `voice.pushToTalk` rather than the adapter, so the panel's
  // availability carries the attribution refusal too (runbook follow-up 12),
  // and `speechInput` as the disclosure source (follow-up 13).
  const voice = createVoiceRuntime({
    hotkey: hotkeyAdapter,
    dispatch: (command) => {
      conversation.noteCommand(command);
      controller.dispatch(command);
    },
    ...(platform.permissions.attribution === undefined
      ? {}
      : { attribution: platform.permissions.attribution.bind(platform.permissions) }),
    logger,
  });
  const conversation = new ConversationGate({
    interaction: controller,
    hotkey: voice.pushToTalk,
    speech: speechAdapter,
    logger,
  });
  observation.attachTelemetry(conversation.telemetry);
  const observationInteraction = createObservationInteraction(controller);
  const windows = new WindowGate({
    windows: platform.windows,
    interaction: {
      ...observationInteraction,
      dispatch: (command) => {
        conversation.noteCommand(command);
        if (command.type === 'pause') {
          observation.noteRetentionEvent('pause');
        } else if (command.type === 'select-window') {
          observation.noteRetentionEvent('window-change');
        } else if (command.type === 'set-observation-enabled' && !command.enabled) {
          observation.noteRetentionEvent('observation-disabled');
        }
        observationInteraction.dispatch(command);
      },
      report: (event) => {
        const retentionEvent = retentionEventForFeed(event);
        if (retentionEvent !== null) {
          observation.noteRetentionEvent(retentionEvent);
        }
        observationInteraction.report(event);
      },
    },
    permissions,
    demoEvents: platform.fakeWindows !== null,
    logger,
  });

  await observation.refreshAttribution();

  return {
    platform,
    observation,
    controller,
    permissions,
    windows,
    conversation,
    transport,
    agent,
    anchoring,
    voice,
    speech,
    hotkey: hotkeyAdapter,
    wire,
    async firstWindow(): Promise<ObservedWindow> {
      const state = await windows.refresh();
      const window = state.windows[0];
      if (window === undefined) {
        // The gate turns a listing failure into `lastError` rather than a
        // throw, so an empty picker and a broken helper look the same from
        // outside. Say which one it was.
        throw new Error(
          `the stub desktop reported no selectable window (lastError: ${
            state.lastError?.code ?? 'none'
          })`,
        );
      }
      return window;
    },
    async dispose(): Promise<void> {
      // Voice first, exactly as in `main/index.ts`: the tap releases a held key
      // before the controller that would have to handle the press is torn down.
      // Then the synthesiser, still ahead of the controller, so a teardown
      // mid-sentence stops the sound at once (PR-033).
      await voice.dispose();
      await speech.dispose();
      windows.dispose();
      conversation.dispose();
      permissions.dispose();
      await controller.dispose();
      await observation.dispose();
      await agent.dispose();
      await platform.dispose();
      await transport.stop();
    },
  };
}
