import { nullLogger, type Logger, type ObservedWindow } from '@pilot/shared';
import { NativeHelperTransport } from '@pilot/platform-mac';
import type { PilotInteractionController } from '@pilot/interaction';
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
import { PermissionGate } from '../main/permission-gate.js';
import { createSettingsShortcut } from '../main/settings-shortcut.js';
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
   * The model (PR-030). Defaults to {@link createDevelopmentModelSource}, which
   * answers every question the same way and never calls a tool. Pass
   * `createScriptedModelSource` to make the model call `observe_screen`.
   */
  readonly modelSource?: ModelSource;
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
  const transport = new NativeHelperTransport({
    command: process.execPath,
    args: [stubPath],
    env: { ...process.env, PILOT_HELPER_STUB: JSON.stringify(options.stub ?? {}) },
    requestTimeoutMs: 5_000,
    handshakeTimeoutMs: 5_000,
    readyTimeoutMs: 8_000,
    shutdownGraceMs: 250,
    restart: { enabled: false },
    logger,
  });

  const platform = createPlatformRuntime({
    env: { ...process.env, PILOT_HELPER_STUB_PATH: stubPath },
    transport,
    logger,
    // Nothing polls on its own: the rig calls `refresh()` where the app would
    // have waited for a tick, so a walkthrough reads the same every time.
    pollIntervalMs: 3_600_000,
    // `permissionIdentity` is left to the platform runtime's own stub default
    // (the identity `helper-stub.ts` claims), so PR-011's verdict comes back
    // `matched` and the *failing* verdict stays a scriptable case rather than
    // the only case.
  });
  // The rig owns the helper process, so it starts it; `platform.start()` only
  // starts a transport it created itself.
  await transport.start();
  await platform.start();

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
  const { controller } = createInteractionRuntime({
    agent: agent.session,
    conversationId,
    observation: observation.port,
    logger,
  });
  controller.subscribe((view) => {
    observation.noteViewState(view);
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

  const conversation = new ConversationGate({ interaction: controller, logger });
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
