import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFakeAuthFacade,
  createScriptedModelSource,
  type ScriptedModelSource,
} from '@pilot/agent';
import {
  createLogger,
  createMemorySink,
  type LogRecord,
  type LogSink,
  type Logger,
  type ObservedWindow,
  type SceneState,
  type SerializedPilotError,
} from '@pilot/shared';
import { isTextFallbackAvailable } from '@pilot/interaction';
import {
  AX_ELEMENTS,
  OVER_THE_BUTTON,
  pushScreenshot,
  settleRun,
} from '../observation/ask-demo.js';
import {
  createObservationRig,
  DEMO_DESKTOP,
  DEMO_DESKTOP_AFTER_CLOSE,
  type ObservationRig,
  type ObservationRigOptions,
} from '../observation/observe-rig.js';
import { GRANTED, pressKey, recordPanel, waitFor, type PanelTrace } from '../voice/flow-demo.js';
import { planRetry } from '../main/request-retry.js';
import { buildObservationView } from '../observation/view-model.js';
import { buildPermissionOnboardingView } from '../permissions/view-model.js';
import { readLifecycleGuidance, type RecoveryDisposition } from './guidance.js';

/**
 * PR-040's demo: **the failure matrix.**
 *
 *     pnpm demo:failure
 *
 * `docs/implementation.md`, PR-040: "scripted failure matrix with recovery or
 * safe terminal state for every case." Thirteen ways Pilot can lose the thing
 * it needs, driven through the shipping composition, and for each one four
 * answers read off the objects the app itself uses:
 *
 *  1. **what failed** — the condition, and where it entered the app;
 *  2. **what the user sees** — the sentence and the remedy, from
 *     `readLifecycleGuidance` over the same `PilotViewState.lastError` the panel
 *     renders, or from the §16 notice when a question was in flight;
 *  3. **recovered, or stopped safely** — never a third thing;
 *  4. **what was left behind** — frames, bytes, pointer targets, the transcript,
 *     active runs, and the files on disk.
 *
 * ## What is real, and what is not
 *
 * Real, and the shipping code: `main/lifecycle-runtime.ts`,
 * `main/request-retry.ts`, `src/lifecycle/guidance.ts`,
 * `PilotInteractionController` and its 330-cell table, `main/observation-runtime.ts`
 * and PR-019's `PilotScreenContextService`, `RetentionGuard`,
 * `MacObservationAdapter`, `MacPermissionAdapter`, `MacSpeechInputAdapter`,
 * `MacSpeechOutputAdapter`, `NativeHelperTransport` and its restart budget,
 * `PiAgentSession` over Pi's agent loop, and `@pilot/agent`'s own auth facade.
 *
 * **NO MAC.** Every failure here is *simulated*, and section 15 says so case by
 * case. No permission has ever been revoked in System Settings, no screen has
 * ever locked, no Swift helper has ever crashed because none has ever run, and
 * no window has ever refused capture because no window has ever been captured.
 * What the far end of the pipe is, in every case, is the Node helper stub —
 * scripted to answer the way macOS is documented to answer.
 */

export interface FailureDemoResult {
  readonly lines: readonly string[];
}

/** One row of the matrix. Everything printed is derived from one of these. */
interface CaseResult {
  readonly id: string;
  readonly what: string;
  readonly sees: string;
  readonly disposition: RecoveryDisposition | 'recovered (after the user acts)';
  readonly leftBehind: string;
  readonly notes: readonly string[];
}

interface LeftBehind {
  readonly frames: number;
  readonly bytes: number;
  readonly pointerTargets: number;
  readonly transcriptTurns: number;
  readonly activeRun: boolean;
}

function leftBehind(rig: ObservationRig): LeftBehind {
  const status = rig.observation.status();
  const view = rig.controller.snapshot();
  return {
    frames: status.buffer.frameCount,
    bytes: status.buffer.byteCount,
    pointerTargets: rig.observation.metrics().pointerTargets,
    transcriptTurns: view.transcript.length,
    // The run id lives on the machine's context, not on the view state the
    // panel renders — "is anything still running" is not something a user is
    // shown, and this demo is the only reader that needs it.
    activeRun: rig.controller.context.activeRunId !== null,
  };
}

function describeLeftBehind(left: LeftBehind): string {
  return (
    `${String(left.frames)} frame(s)/${String(left.bytes)} B, ` +
    `${String(left.pointerTargets)} pointer target(s), ` +
    `${String(left.transcriptTurns)} transcript turn(s), ` +
    `${left.activeRun ? 'A RUN STILL ACTIVE' : 'no active run'}`
  );
}

/** The sentence plus the remedy, exactly as the panel composes them. */
function whatTheUserSees(error: SerializedPilotError | null): string {
  const guidance = readLifecycleGuidance(error);
  if (guidance === null) {
    return '(no banner)';
  }
  return `“${guidance.userMessage}” → “${guidance.remedy}”`;
}

/** Every `retention clear` the guard wrote, in order. Content-free by design. */
function retentionClears(
  sink: LogSink & { readonly records: readonly LogRecord[] },
): readonly { event: string; lineageReset: boolean }[] {
  // Only `event` and `lineageReset` are read. The counts beside them in the log
  // line are redacted by `@pilot/shared` before a sink ever sees them — a field
  // named `clearedFrames` is frame-shaped, and the redactor does not know it is
  // a count — so this reads what survives and proves "nothing was left" from
  // `ScreenStatus.buffer` instead, which is the number the app itself uses.
  return sink.records
    .filter((entry) => entry.message === 'retention clear')
    .map((entry) => {
      const fields = (entry.fields ?? {}) as Record<string, unknown>;
      return { event: String(fields['event']), lineageReset: fields['lineageReset'] === true };
    });
}

const BASE_STUB = {
  permissions: GRANTED,
  axElements: AX_ELEMENTS,
  pointer: OVER_THE_BUTTON,
  captureFrameBytes: 3_072,
  captureScaleFactor: 2,
} as const;

interface Opened {
  readonly rig: ObservationRig;
  readonly window: ObservedWindow;
  readonly panel: PanelTrace;
  readonly sink: LogSink & { readonly records: readonly LogRecord[] };
}

/**
 * Builds the rig, grants the permissions and selects a window, exactly as every
 * walkthrough since PR-028 does.
 *
 * `select` is consent to watch (runbook cross-lane issue 9), so on return Pilot
 * is in `observing` with a live capture stream — which is the only state most
 * of these failures are interesting from.
 */
async function watching(
  stub: Record<string, unknown>,
  options: Partial<ObservationRigOptions> = {},
): Promise<Opened> {
  const sink: LogSink & { readonly records: readonly LogRecord[] } = createMemorySink();
  const logger: Logger = createLogger({ scope: 'failure-demo', level: 'debug', sink });
  const rig = await createObservationRig({
    stub: { ...BASE_STUB, desktop: DEMO_DESKTOP, ...stub },
    logger,
    recordRequests: true,
    // This walkthrough owns the ring wherever it pushes its own screenshots; a
    // stub frame is not a decodable image, so one landing between a screenshot
    // and a question anchored on it would be a decode failure with nothing to
    // do with the case under test (runbook cross-lane issue 11).
    capturePollIntervalMs: 3_600_000,
    ...options,
  });
  const panel = recordPanel(rig);
  await rig.permissions.refresh();
  await rig.observation.refreshAttribution();
  const window = await rig.firstWindow();
  await rig.windows.act({ type: 'select', windowId: window.windowId });
  await rig.controller.settled();
  return { rig, window, panel, sink };
}

/** Waits out §10's observation rate window; the shipped numbers stay shipped. */
async function cool(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_100));
}

function scriptedModel(script: readonly { readonly say: string }[]): ScriptedModelSource {
  return createScriptedModelSource({ tokensPerSecond: 200, script });
}

export async function runFailureDemo(): Promise<FailureDemoResult> {
  const lines: string[] = [];
  const cases: CaseResult[] = [];
  const say = (line = ''): void => {
    lines.push(line);
  };
  const evidence = (label: string, value: string): void => {
    say(`     ${label.padEnd(40)} ${value}`);
  };
  const heading = (title: string): void => {
    say();
    say(title);
    say('-'.repeat(76));
  };

  say('PR-040 — lifecycle and failure recovery');
  say('='.repeat(76));
  say();
  say('Thirteen ways Pilot can lose what it needs, each driven through the');
  say('shipping composition. Every case ends in exactly one of two places:');
  say('Pilot recovered and kept working, or Pilot stopped somewhere safe,');
  say('visible and explained. A case that quietly degraded would be a defect.');
  say();
  say('Real: main/lifecycle-runtime.ts, main/request-retry.ts, the interaction');
  say('      table, the retention guard, PilotScreenContextService, the mac');
  say('      adapters over NativeHelperTransport (including its restart budget),');
  say('      PiAgentSession, and @pilot/agent’s own auth facade.');
  say('NOT REAL: no macOS. No permission has ever been revoked, no screen has');
  say('      ever locked, no Swift helper has ever crashed and no window has');
  say('      ever refused capture. Section 15 says what that leaves unproven.');

  const scratch = await mkdtemp(join(tmpdir(), 'pilot-failure-demo-'));

  // -------------------------------------------------------------------------
  // 1–4 — the permissions, the lock and the logout
  // -------------------------------------------------------------------------
  {
    heading('1. SCREEN RECORDING REVOKED WHILE PILOT IS WATCHING');
    say('   The snapshot the real `MacPermissionAdapter` reads answers `denied`');
    say('   on the second refresh. From there everything is the shipping path:');
    say('   the gate publishes, `main/lifecycle-runtime.ts` arms the retention');
    say('   occasion, and the table’s own `permissions-changed` row tears down,');
    say('   stops capture and clears.');
    say();
    const { rig, window, panel, sink } = await watching({
      // Refresh 1 grants (the state `watching` establishes), 2 revokes Screen
      // Recording, 3 restores it, 4 revokes Accessibility, 5 restores it.
      permissionsScript: [
        {},
        { 'screen-recording': 'denied' },
        { 'screen-recording': 'granted' },
        { accessibility: 'denied' },
        { accessibility: 'granted' },
      ],
    });
    try {
      await pushScreenshot(rig, window, { id: 'frame-perm', capturedAt: Date.now() });
      await rig.observation.samplePointer();
      const before = leftBehind(rig);
      evidence('watching, with something buffered:', describeLeftBehind(before));

      await rig.permissions.refresh();
      await rig.controller.settled();
      const view = rig.controller.snapshot();
      const after = leftBehind(rig);
      const clears = retentionClears(sink);
      const occasion = clears.at(-1);
      evidence('state:', `${panel.states.at(-2) ?? '—'} → ${view.state}`);
      evidence('the user sees (banner):', whatTheUserSees(view.lastError));
      evidence('the user sees (§16 notice):', rig.windows.snapshot().notice?.reason ?? '(none)');
      evidence('retention occasion for the clear:', occasion?.event ?? '(nothing cleared)');
      evidence('left behind:', describeLeftBehind(after));
      say();
      say('     `permission-loss` is one of the five occasions system-design §13');
      say('     lists, and until this PR **nothing in the product ever passed it**:');
      say('     a revocation cleared its buffers under whichever occasion happened');
      say('     to be armed last. The buffers went either way; the retention log');
      say('     named the wrong reason, which is what an audit reads.');
      cases.push({
        id: '1',
        what: 'Screen Recording revoked mid-session (System Settings)',
        sees: whatTheUserSees(view.lastError),
        disposition: 'safe-terminal',
        leftBehind: describeLeftBehind(after),
        notes: [`retention occasion: ${occasion?.event ?? 'none'}`],
      });

      heading('2. …AND GRANTED AGAIN');
      say('   Nothing restarts. The gate publishes the new snapshot, the table’s');
      say('   `needs-permission` row resolves back to a resting state, and the');
      say('   window is still selected — watching is off because the revocation');
      say('   switched it off, which is the honest state to come back to.');
      say();
      await rig.permissions.refresh();
      await rig.controller.settled();
      evidence('state:', rig.controller.snapshot().state);
      await rig.windows.act({ type: 'start' });
      await rig.controller.settled();
      evidence('after pressing Start:', rig.controller.snapshot().state);
      evidence('left behind:', describeLeftBehind(leftBehind(rig)));
      cases.push({
        id: '2',
        what: 'Screen Recording granted again',
        sees: 'the permission row turns green; watching resumes on Start',
        disposition: 'recovered (after the user acts)',
        leftBehind: describeLeftBehind(leftBehind(rig)),
        notes: ['no relaunch, no re-selection'],
      });

      heading('3. ACCESSIBILITY REVOKED WHILE PILOT IS WATCHING');
      say('   system-design §16 asks for a *degraded* mode here — "continue with');
      say('   visual pointer coordinates and disclose reduced grounding" — and');
      say('   since PR-044 that is what happens. It ends `recovered`, and this');
      say('   is the case that phrase was written for: "Pilot kept working,');
      say('   possibly with less". `REQUIRED_PERMISSIONS` is Screen Recording');
      say('   alone, so the table’s `permissions-changed` row records the new');
      say('   snapshot and leaves the session running; what changes is what the');
      say('   model is told and what the panel says. Degrading QUIETLY would be');
      say('   the defect — the two lines of evidence below are why it is not.');
      say('   (It listed all four until PR-044: runbook follow-up 35, and why');
      say('   A-09 read `failed`.)');
      say();
      await rig.permissions.refresh();
      await rig.controller.settled();
      const accessibilityView = rig.controller.snapshot();
      const degradedPermissions = buildPermissionOnboardingView(rig.permissions.snapshot());
      const degradedObservation = buildObservationView({
        gate: rig.windows.snapshot(),
        view: accessibilityView,
        permissions: degradedPermissions,
      });
      evidence('state:', accessibilityView.state);
      evidence('still watching:', String(accessibilityView.observationEnabled));
      evidence('onboarding readiness:', degradedPermissions.readiness);
      evidence('grounding:', degradedObservation.grounding);
      evidence('the user sees:', degradedPermissions.groundingDisclosure ?? '(nothing)');
      evidence(
        'lifecycle record:',
        rig.lifecycle.records.map((entry) => entry.failure).join(', ') || '(none)',
      );
      evidence('left behind:', describeLeftBehind(leftBehind(rig)));
      say();
      say('     And what the MODEL is told, which is the half a permission row');
      say('     cannot show: the envelope’s target line names the permission');
      say('     rather than reading "none reported", because "none reported" is');
      say('     what a pointer over blank space looks like.');
      say('       | pointer target: unavailable — Accessibility is not permitted, …');
      say('       | reduced grounding: work out what is at the pointer position');
      say('       |   from the captured window alone, and say in your answer that');
      say('       |   you could not confirm the control by name.');
      cases.push({
        id: '3',
        what: 'Accessibility revoked mid-session',
        sees: degradedPermissions.groundingDisclosure ?? '(nothing)',
        disposition: 'recovered',
        leftBehind: describeLeftBehind(leftBehind(rig)),
        notes: ['§16’s degraded row: keeps watching, discloses reduced grounding'],
      });
      // Put it back. Nothing is relaunched and the window is never re-selected;
      // the grant alone restores full grounding for the next question.
      await rig.permissions.refresh();
      await rig.controller.settled();
      evidence(
        'after the grant:',
        buildPermissionOnboardingView(rig.permissions.snapshot()).readiness,
      );
      await rig.windows.act({ type: 'start' });
      await rig.controller.settled();

      heading('4. THE SCREEN LOCKS, THEN UNLOCKS');
      say('   Through `powerMonitor`, which is the wiring PR-040 adds: until now');
      say('   a lock reached Pilot only when a window-list poll noticed it.');
      say();
      await pushScreenshot(rig, window, { id: 'frame-lock', capturedAt: Date.now() });
      evidence('before the lock:', describeLeftBehind(leftBehind(rig)));
      rig.lifecycle.reportScreenLock(true);
      await rig.controller.settled();
      const locked = retentionClears(sink).at(-1);
      evidence('state:', rig.controller.snapshot().state);
      evidence(
        'retention occasion:',
        locked === undefined
          ? '(none)'
          : `${locked.event} (lineage kept: ${String(!locked.lineageReset)})`,
      );
      evidence('left behind:', describeLeftBehind(leftBehind(rig)));
      rig.lifecycle.reportScreenLock(false);
      await rig.controller.settled();
      evidence('after unlocking:', rig.controller.snapshot().state);
      cases.push({
        id: '4',
        what: 'Screen locked, then unlocked',
        sees: '“Paused”, with the reason on the observation indicator',
        disposition: 'recovered',
        leftBehind: describeLeftBehind(leftBehind(rig)),
        notes: [`occasion ${locked?.event ?? 'none'}, scene lineage kept on purpose`],
      });

      heading('5. LOGOUT');
      say('   The one occasion Pilot has no other signal for. It is *terminal*:');
      say('   unlike a lock, the scene lineage goes with the buffers, so nothing');
      say('   that survives can be matched against a scene from the last session.');
      say();
      await pushScreenshot(rig, window, { id: 'frame-logout', capturedAt: Date.now() });
      rig.lifecycle.reportSessionEnd('logout');
      await rig.controller.settled();
      const loggedOut = retentionClears(sink).at(-1);
      evidence('state:', rig.controller.snapshot().state);
      evidence(
        'retention occasion:',
        loggedOut === undefined
          ? '(none)'
          : `${loggedOut.event} — lineage reset: ${String(loggedOut.lineageReset)}`,
      );
      evidence('left behind:', describeLeftBehind(leftBehind(rig)));
      cases.push({
        id: '5',
        what: 'Logout (or system shutdown that is not Pilot’s own quit)',
        sees: 'nothing — the session is ending; the log records the clear',
        disposition: 'safe-terminal',
        leftBehind: describeLeftBehind(leftBehind(rig)),
        notes: [`occasion ${loggedOut?.event ?? 'none'}, lineage reset`],
      });
      panel.stop();
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 6 — the selected window closes
  // -------------------------------------------------------------------------
  {
    heading('6. THE SELECTED WINDOW CLOSES');
    say('   The window list simply no longer holds it, which is the shape §16');
    say('   cares about — `WindowGate` reconciles, the table’s `window-closed`');
    say('   row stops capture, clears, and writes its own typed error.');
    say();
    const { rig, window, sink } = await watching({
      desktopScript: [DEMO_DESKTOP, DEMO_DESKTOP_AFTER_CLOSE],
    });
    try {
      await pushScreenshot(rig, window, { id: 'frame-close', capturedAt: Date.now() });
      await rig.observation.samplePointer();
      evidence('watching:', describeLeftBehind(leftBehind(rig)));
      await rig.windows.refresh();
      await rig.controller.settled();
      const view = rig.controller.snapshot();
      const clear = retentionClears(sink).at(-1);
      evidence('state:', view.state);
      evidence('selected window:', view.selectedWindow?.title ?? '(none)');
      evidence('the user sees:', whatTheUserSees(view.lastError));
      evidence('the §16 prompt:', rig.windows.snapshot().notice?.reason ?? '(none)');
      evidence('retention occasion:', clear?.event ?? '(none)');
      evidence('left behind:', describeLeftBehind(leftBehind(rig)));
      cases.push({
        id: '6',
        what: 'Selected window closed',
        sees: whatTheUserSees(view.lastError),
        disposition: 'safe-terminal',
        leftBehind: describeLeftBehind(leftBehind(rig)),
        notes: [`occasion ${clear?.event ?? 'none'}; the picker asks for a new window`],
      });
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 7 — the window closes with an observation in flight
  // -------------------------------------------------------------------------
  {
    heading('7. THE WINDOW CLOSES WITH AN OBSERVATION IN FLIGHT');
    say('   "Look now" asks for a *fresh* capture, so the request is open across');
    say('   the close. The abort signal PR-027 threaded through the port is what');
    say('   unwinds it: the observation never lands, and the answer the user gets');
    say('   is about the window closing rather than about a frame that arrived');
    say('   from a window that is gone.');
    say();
    const { rig, sink } = await watching(
      { desktopScript: [DEMO_DESKTOP, DEMO_DESKTOP_AFTER_CLOSE], capturePullDelayMs: 1_500 },
      { capturePollIntervalMs: 60_000 },
    );
    try {
      rig.controller.dispatch({ type: 'look-now' });
      await waitFor(
        'the observation to start',
        () => rig.controller.context.activeObservationId !== null,
      );
      const duringState = rig.controller.snapshot().state;
      await rig.windows.refresh();
      await rig.controller.settled();
      await settleRun(rig);
      const view = rig.controller.snapshot();
      evidence('state while looking:', duringState);
      evidence('state after the close:', view.state);
      evidence('the user sees:', whatTheUserSees(view.lastError));
      evidence('observations that landed:', String(rig.observation.metrics().observations));
      evidence('retention occasion:', retentionClears(sink).at(-1)?.event ?? '(none)');
      evidence('left behind:', describeLeftBehind(leftBehind(rig)));
      cases.push({
        id: '7',
        what: 'Window closed while an observation was in flight',
        sees: whatTheUserSees(view.lastError),
        disposition: 'safe-terminal',
        leftBehind: describeLeftBehind(leftBehind(rig)),
        notes: ['the in-flight capture was aborted, not delivered late'],
      });
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 8 — a window that blocks capture
  // -------------------------------------------------------------------------
  {
    heading('8. A PROTECTED WINDOW — CAPTURE REFUSES RATHER THAN RETURNING PIXELS');
    say('   The stream answers `protected` instead of a frame, which is what');
    say('   ScreenCaptureKit does for a DRM or password-protected window.');
    say('   `MacObservationAdapter` turns it into a typed `protected-content` and');
    say('   tears the stream down; PR-040 is what makes the user hear about it.');
    say();
    const { rig, sink } = await watching(
      { captureScript: [{ state: 'protected', frame: null }] },
      // The adapter's own drain interval, because the point of this case is that
      // a pull happens and comes back protected.
      { capturePollIntervalMs: 40 },
    );
    try {
      await waitFor(
        'the capture stream to report protected content',
        () => rig.lifecycle.records.some((entry) => entry.failure === 'capture-blocked'),
        10_000,
      );
      await rig.controller.settled();
      const view = rig.controller.snapshot();
      evidence('state:', view.state);
      evidence('observation switch:', view.observationEnabled ? 'ON' : 'off');
      evidence('the user sees:', whatTheUserSees(view.lastError));
      evidence('the §16 prompt:', rig.windows.snapshot().notice?.reason ?? '(none)');
      evidence('retention occasion:', retentionClears(sink).at(-1)?.event ?? '(none)');
      evidence('left behind:', describeLeftBehind(leftBehind(rig)));
      say();
      say('     Before this PR the same event produced one `warn` line in the log');
      say('     and nothing else: the switch still said "watching", the panel said');
      say('     nothing, and the next question was answered without a picture. A');
      say('     failure that only a developer can see is the defect shape');
      say('     cross-lane issue 19 records.');
      cases.push({
        id: '8',
        what: 'Protected/DRM window — capture refuses',
        sees: whatTheUserSees(view.lastError),
        disposition: 'safe-terminal',
        leftBehind: describeLeftBehind(leftBehind(rig)),
        notes: ['watching switched off; no black frame was ever offered as content'],
      });
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 9 — the helper crashes mid capture.pull
  // -------------------------------------------------------------------------
  {
    heading('9. THE HELPER CRASHES MID `capture.pull`');
    say('   The stub exits without answering, exactly as a crashed helper does.');
    say('   `NativeHelperTransport` rejects the in-flight work with a typed');
    say('   `helper-unavailable`, restarts with backoff, and PR-040 re-probes what');
    say('   the dead process invalidated — PR-011’s attribution verdict is cached');
    say('   per helper process, and nothing re-read it before this PR.');
    say();
    const { rig, sink } = await watching(
      { crashOnOps: ['capture.pull'], crashOncePath: join(scratch, 'crash-capture') },
      { capturePollIntervalMs: 40, restart: { enabled: true, initialDelayMs: 50 } },
    );
    try {
      await waitFor(
        'the helper to crash and Pilot to reconnect',
        () => rig.lifecycle.stats().helperRecoveries > 0,
        15_000,
      );
      await rig.controller.settled();
      const attributionProbes = rig.wire.filter(
        (request) => request.op === 'permissions.attribution',
      ).length;
      const captureStarts = rig.wire.filter((request) => request.op === 'capture.start').length;
      const record = rig.lifecycle.records.find((entry) => entry.failure === 'helper-restarted');
      evidence(
        'lifecycle record:',
        record === undefined ? '(none)' : `${record.failure} / ${record.disposition}`,
      );
      evidence(
        'crashes / recoveries:',
        `${String(rig.lifecycle.stats().helperCrashes)} / ${String(rig.lifecycle.stats().helperRecoveries)}`,
      );
      evidence('attribution probes on the wire:', String(attributionProbes));
      evidence('capture streams started:', String(captureStarts));
      evidence('the user sees:', whatTheUserSees(rig.controller.snapshot().lastError));
      evidence('the §16 prompt:', rig.windows.snapshot().notice?.reason ?? '(none)');
      evidence('retention occasion:', retentionClears(sink).at(-1)?.event ?? '(none)');
      evidence('left behind:', describeLeftBehind(leftBehind(rig)));
      cases.push({
        id: '9',
        what: 'Helper crash during `capture.pull`',
        sees: whatTheUserSees(rig.controller.snapshot().lastError),
        disposition: 'recovered',
        leftBehind: describeLeftBehind(leftBehind(rig)),
        notes: [
          `${String(attributionProbes)} attribution probe(s): the cached verdict was re-read`,
          `${String(captureStarts)} capture stream(s): the adapter re-established its own`,
        ],
      });
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 10 — the helper crashes mid speech.output.speak
  // -------------------------------------------------------------------------
  {
    heading('10. THE HELPER CRASHES MID `speech.output.speak`');
    say('   A different case from 9, and the one PR-033’s seam exists for: the');
    say('   synthesiser call is rejected while the model is still streaming the');
    say('   answer. The rule is that the failure costs the sound and never the');
    say('   answer — checked here under a crash rather than under a scripted');
    say('   synthesiser error.');
    say();
    const model = scriptedModel([
      { say: 'That is the Update payment method button. It opens the billing sheet.' },
    ]);
    const { rig } = await watching(
      {
        crashOnOps: ['speech.output.speak'],
        crashOncePath: join(scratch, 'crash-speak'),
        speechOutput: { scripts: [[{ type: 'started' }, { type: 'finished' }]] },
      },
      { modelSource: model, restart: { enabled: true, initialDelayMs: 50 } },
    );
    try {
      rig.controller.dispatch({ type: 'submit-text', text: 'What is this button?' });
      await settleRun(rig);
      const view = rig.controller.snapshot();
      const answer = view.transcript.filter((entry) => entry.role === 'assistant').at(-1);
      evidence('state:', view.state);
      evidence(
        'the answer survived:',
        answer === undefined ? 'NO' : `${String(answer.text.length)} characters`,
      );
      evidence('chunks silenced:', String(rig.speech.stats().silenced));
      evidence('helper crashes:', String(rig.lifecycle.stats().helperCrashes));
      evidence(
        'lifecycle records:',
        rig.lifecycle.records.map((entry) => `${entry.failure}/${entry.surfaced}`).join(', ') ||
          '(none)',
      );
      evidence('the user sees:', whatTheUserSees(view.lastError));
      evidence('left behind:', describeLeftBehind(leftBehind(rig)));
      cases.push({
        id: '10',
        what: 'Helper crash during `speech.output.speak`',
        sees:
          view.lastError === null
            ? 'the answer, in full, in silence — no banner at all'
            : whatTheUserSees(view.lastError),
        disposition: 'recovered',
        leftBehind: describeLeftBehind(leftBehind(rig)),
        notes: [`${String(rig.speech.stats().silenced)} chunk(s) silenced; the turn completed`],
      });
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 11 — the recogniser refuses
  // -------------------------------------------------------------------------
  {
    heading('11. SPEECH-TO-TEXT FAILS');
    say('   `speech.input.start` is refused, which is what a revoked microphone');
    say('   or an unavailable recogniser looks like from the host. Before this PR');
    say('   the panel showed the helper’s own words — "The macOS helper could not');
    say('   run that operation." PR-040 wraps the recogniser so the sentence is');
    say('   §16’s answer instead, and the text box beside it is live.');
    say();
    const model = scriptedModel([{ say: 'It is the Update payment method button.' }]);
    const { rig } = await watching(
      {
        speechInput: { startFailsWith: { code: 'permission-denied' } },
        // One press per `hotkey.start`, which is how the stub stands in for a
        // finger on Right Option (runbook: `pressKey` says the same).
        hotkeyScript: [{ key: 'down' }],
      },
      { modelSource: model },
    );
    try {
      await pressKey(rig, false);
      await waitFor(
        'the recogniser refusal to reach the panel',
        () => rig.controller.snapshot().lastError !== null,
        10_000,
      );
      await rig.controller.settled();
      const view = rig.controller.snapshot();
      evidence('state:', view.state);
      evidence('the user sees:', whatTheUserSees(view.lastError));
      evidence('typing still offered:', isTextFallbackAvailable(view.state) ? 'YES' : 'no');
      // …and it works: the same question, typed, is answered.
      rig.controller.dispatch({ type: 'submit-text', text: 'What is this button?' });
      await settleRun(rig);
      const after = rig.controller.snapshot();
      evidence('typed instead:', after.transcript.length > 0 ? 'answered' : 'NOT ANSWERED');
      evidence('left behind:', describeLeftBehind(leftBehind(rig)));
      cases.push({
        id: '11',
        what: 'Speech-to-text fails (recogniser refuses to start)',
        sees: whatTheUserSees(view.lastError),
        disposition: 'safe-terminal',
        leftBehind: describeLeftBehind(leftBehind(rig)),
        notes: ['the text box stays live, and the same question typed is answered'],
      });
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 12 — the synthesiser fails, and 13 — the provider signs Pilot out
  // -------------------------------------------------------------------------
  {
    heading('12. TEXT-TO-SPEECH FAILS MID-ANSWER');
    say('   PR-033’s property, re-checked under this matrix: the synthesiser');
    say('   errors on the first chunk of an answer the model is still writing.');
    say('   No `error` leaves `main/speech-runtime.ts`, so the table never sees');
    say('   `speech-failed` and the run that is writing the answer is not torn');
    say('   down.');
    say();
    const model = scriptedModel([
      {
        say: 'That is the Update payment method button. It opens the billing sheet for this account. The card on file is charged when the plan renews.',
      },
      { say: 'Yes — you can change it from the same sheet.' },
    ]);
    const { rig } = await watching(
      {
        speechOutput: {
          scripts: [
            [{ type: 'error', code: 'synthesis-failed' }],
            [{ type: 'started' }, { type: 'finished' }],
          ],
        },
      },
      { modelSource: model },
    );
    try {
      rig.controller.dispatch({ type: 'submit-text', text: 'What is this button?' });
      await settleRun(rig);
      const view = rig.controller.snapshot();
      const answer = view.transcript.filter((entry) => entry.role === 'assistant').at(-1);
      evidence('state:', view.state);
      evidence(
        'the answer survived:',
        answer === undefined ? 'NO' : `${String(answer.text.length)} characters`,
      );
      evidence('chunks silenced:', String(rig.speech.stats().silenced));
      evidence(
        'the user sees:',
        view.lastError === null
          ? '(no banner — nothing was lost but the sound)'
          : whatTheUserSees(view.lastError),
      );
      cases.push({
        id: '12',
        what: 'Text-to-speech fails mid-answer',
        sees: 'the answer in full, on screen, in silence',
        disposition: 'recovered',
        leftBehind: describeLeftBehind(leftBehind(rig)),
        notes: [`${String(rig.speech.stats().silenced)} chunk(s) silenced; §16 satisfied`],
      });

      heading('13. THE MODEL PROVIDER SIGNS PILOT OUT (PROVIDER-NEUTRAL)');
      say('   The error is produced by `@pilot/agent`’s own auth facade — the');
      say('   PR-020 seam PR-037/PR-038/PR-039 all build on — by asking it to');
      say('   authorise a provider it holds no credential for. Nothing in the');
      say('   recovery path knows which provider that is: it keys off the');
      say('   `authentication-required` code in the shared taxonomy and nothing');
      say('   else. §16 asks for the transcript to survive; here is the count.');
      say();
      const turnsBefore = rig.controller.snapshot().transcript.length;
      const requestsBefore = model.requestCount();
      const facade = createFakeAuthFacade();
      const authError = await facade
        .authorize(rig.agent.session.profile)
        .then(() => null)
        .catch((cause: unknown) => cause);
      const reported = rig.lifecycle.reportProviderFailure(authError);
      await rig.controller.settled();
      const signedOut = rig.controller.snapshot();
      evidence('state:', signedOut.state);
      evidence('code:', reported.code);
      evidence('the user sees:', whatTheUserSees(signedOut.lastError));
      evidence(
        'transcript:',
        `${String(turnsBefore)} turn(s) before → ${String(signedOut.transcript.length)} after`,
      );
      evidence(
        'provider requests made while signed out:',
        String(model.requestCount() - requestsBefore),
      );
      const signedOutLeftBehind = describeLeftBehind(leftBehind(rig));
      evidence('left behind:', signedOutLeftBehind);
      // Signing back in is a command away: dismiss, ask again.
      rig.controller.dispatch({ type: 'dismiss-error' });
      rig.controller.dispatch({ type: 'submit-text', text: 'And can I turn it off later?' });
      await settleRun(rig);
      evidence('after signing in again:', rig.controller.snapshot().state);
      evidence(
        'transcript after the follow-up:',
        String(rig.controller.snapshot().transcript.length),
      );
      cases.push({
        id: '13',
        what: 'Provider authentication expired (provider-neutral)',
        sees: whatTheUserSees(signedOut.lastError),
        disposition: 'safe-terminal',
        leftBehind: signedOutLeftBehind,
        notes: [
          `transcript kept (${String(signedOut.transcript.length)} turns), and the follow-up after signing in again was answered`,
          'nothing was sent while signed out',
        ],
      });
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 14 — request retry
  // -------------------------------------------------------------------------
  {
    heading('14. REQUEST RETRY — AND THE RETRY PILOT REFUSES TO MAKE');
    say('   `main/request-retry.ts` allows exactly one retry, and only while the');
    say('   scene is the scene the request was about. The first half is wired');
    say('   through `LifecycleRuntime.guardObservation`, which every observation');
    say('   in the app passes through — "Look now" and the model’s own');
    say('   `observe_screen` alike. The second half is the interesting one: a');
    say('   retry that re-sends a picture of a screen the user has moved past is');
    say('   worse than the failure it was hiding.');
    say();
    const { rig, window } = await watching(
      // A stream that never yields a frame: a fresh capture times out, which is
      // a retryable `capture-failed` rather than a terminal stream state.
      { captureScript: [{ state: 'streaming', frame: null, remaining: 0 }] },
      { capturePollIntervalMs: 60_000 },
    );
    try {
      const sceneBefore = rig.observation.status().scene;
      rig.controller.dispatch({ type: 'look-now' });
      await settleRun(rig);
      const view = rig.controller.snapshot();
      evidence('retries made:', String(rig.lifecycle.stats().retries));
      evidence('retries refused:', String(rig.lifecycle.stats().retriesRefused));
      evidence('the user sees:', whatTheUserSees(view.lastError));
      evidence('left behind:', describeLeftBehind(leftBehind(rig)));
      say();
      say('   And the refusal, on two scenes from this very run: the screen');
      say('   changes underneath a failed request, and the policy declines.');
      say();
      await cool();
      await pushScreenshot(rig, window, {
        id: 'frame-retry',
        capturedAt: Date.now(),
        toggleOn: true,
      });
      const sceneAfter: SceneState | null = rig.observation.status().scene;
      const retryable: SerializedPilotError = {
        name: 'PilotError',
        code: 'capture-failed',
        domain: 'observation',
        message: 'the capture stream produced no frame',
        userMessage: 'Pilot could not capture that window.',
        retryable: true,
      };
      const same = planRetry({
        attempt: 0,
        error: retryable,
        sceneAtRequest: sceneAfter,
        sceneNow: sceneAfter,
      });
      const moved = planRetry({
        attempt: 0,
        error: retryable,
        sceneAtRequest: sceneBefore,
        sceneNow: sceneAfter,
      });
      evidence(
        'scene at the request → now:',
        `${sceneBefore === null ? 'none' : `r${String(sceneBefore.revision)}`} → ` +
          `${sceneAfter === null ? 'none' : `r${String(sceneAfter.revision)}`}`,
      );
      evidence(
        'same scene:',
        same.kind === 'retry'
          ? `retry after ${String(same.delayMs)} ms`
          : `ask-again (${same.reason})`,
      );
      evidence(
        'screen has moved on:',
        moved.kind === 'retry'
          ? 'RETRY — which would be the defect'
          : `ask-again (${moved.reason})`,
      );
      cases.push({
        id: '14',
        what: 'Retryable request failure (capture produced no frame)',
        sees: whatTheUserSees(view.lastError),
        disposition: 'safe-terminal',
        leftBehind: describeLeftBehind(leftBehind(rig)),
        notes: [
          `${String(rig.lifecycle.stats().retries)} retry made, then stopped`,
          'no retry once the scene has moved on',
        ],
      });
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // The matrix
  // -------------------------------------------------------------------------
  heading('15. THE MATRIX');
  for (const entry of cases) {
    say(`  ${entry.id.padStart(2)}. ${entry.what}`);
    say(`      user sees   ${entry.sees}`);
    say(`      ending      ${entry.disposition}`);
    say(`      left behind ${entry.leftBehind}`);
    for (const note of entry.notes) {
      say(`      note        ${note}`);
    }
  }
  say();
  const terminal = cases.filter((entry) => entry.disposition === 'safe-terminal').length;
  const recovered = cases.length - terminal;
  say(
    `  ${String(cases.length)} cases: ${String(recovered)} recovered, ${String(terminal)} stopped safely, 0 silent.`,
  );

  const leftOnDisk = await readdir(scratch);
  say();
  say(
    `  Files this walkthrough left behind: ${String(leftOnDisk.length)} in ${scratch} ` +
      `(${leftOnDisk.join(', ') || 'none'}) — crash markers only, no frame, no audio, no transcript.`,
  );
  await rm(scratch, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  heading('16. WHAT THIS DOES NOT PROVE');
  say('   Every failure above is simulated. In particular:');
  say('   - **no permission has ever been revoked**: the revocation is the Node');
  say('     stub answering `denied` on its second snapshot, not TCC changing its');
  say('     mind while a real capture stream is running;');
  say('   - **no screen has ever locked and nobody has ever logged out**: both');
  say('     arrive here as a direct call, where on a Mac they arrive from');
  say('     `powerMonitor` — which has never fired in this project;');
  say('   - **no real helper has ever crashed**, because no Swift helper has ever');
  say('     been compiled. What crashed is a Node process speaking the same wire');
  say('     protocol; a real crash may also lose an audio session or a TCC');
  say('     attribution in ways the stub cannot model;');
  say('   - **no window has ever refused capture**: `protected` is a string in a');
  say('     scripted `capture.pull`, not ScreenCaptureKit refusing DRM content;');
  say('   - **no model has ever signed Pilot out**: the `authentication-required`');
  say('     is raised by `@pilot/agent`’s fake auth facade, and which errors a');
  say('     real provider raises for an expired subscription is PR-037…PR-039’s');
  say('     to map onto this same code;');
  say('   - **nothing was ever spoken, heard or captured**, exactly as in every');
  say('     walkthrough since PR-028.');
  say();
  say('   `docs/handoff.md` §1 step 17 is the list of these that only a Mac can');
  say('   answer, in the order that makes each one cheap to run.');
  say();

  return { lines };
}
