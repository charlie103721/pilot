import { CAPTURE_ENCODING } from '../main/platform-runtime.js';
import {
  createObservationRig,
  DEMO_DESKTOP,
  DEMO_DESKTOP_AFTER_CLOSE,
  type ObservationRig,
} from './observe-rig.js';

/**
 * PR-028's demo: observe a selected window, look, pause, lose the window.
 *
 * `docs/implementation.md` asks for "select a real window, inspect local
 * frames/pointer target, pause, and verify immediate clearing". **That demo
 * cannot be run on this machine.** There is no macOS and no Swift toolchain
 * here (runbook §5 amendment 8, user-confirmed), so no ScreenCaptureKit stream
 * has ever produced a pixel and no TCC prompt has ever appeared. The Mac
 * commands that do run it are in `docs/handoff.md` §1.
 *
 * This is the equivalent that *can* be run here, and it is not a model of the
 * app — it is the app. `main/platform-runtime.ts`, `main/observation-runtime.ts`,
 * `WindowGate`, `PermissionGate`, `PilotInteractionController`,
 * `ObservationSession`, `PilotScreenContextService` and the four macOS adapters
 * are the shipping objects, wired the way `main/index.ts` wires them. Only the
 * process on the far end of the framed stdio pipe is a stand-in: the Node
 * helper stub that `packages/platform-mac` tests itself against, which is a
 * second, independent implementation of the wire format.
 *
 * Six sections, and the last one is the list of what none of this proves.
 */

export interface ObserveDemoResult {
  readonly lines: readonly string[];
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function bytes(count: number): string {
  return count < 1024 ? `${String(count)} B` : `${(count / 1024).toFixed(1)} KiB`;
}

/** Everything the ring is holding right now, in one line. */
function ring(rig: ObservationRig): string {
  const status = rig.observation.core.status();
  return (
    `frames=${String(status.buffer.frameCount)} ` +
    `bytes=${bytes(status.buffer.byteCount)} ` +
    `pointer=${String(status.pointer.sampleCount)}`
  );
}

function state(rig: ObservationRig): string {
  const view = rig.controller.snapshot();
  return `${pad(view.state, 16)} observationEnabled=${String(view.observationEnabled)}`;
}

async function refuse(rig: ObservationRig, say: (line: string) => void): Promise<void> {
  try {
    await rig.observation.port.observe(
      // A real ObservationId is minted by the machine; this path is entered
      // directly so the refusal is the only thing under test.
      'observation-demo' as never,
    );
    say('   NO REFUSAL — the facade allowed an observation it should not have');
  } catch (cause) {
    const error = cause as { code?: string; message?: string; userMessage?: string };
    say(`   refused: ${String(error.code)} — ${String(error.userMessage ?? error.message)}`);
  }
}

export async function runObserveDemo(): Promise<ObserveDemoResult> {
  const lines: string[] = [];
  const say = (line: string): void => {
    lines.push(line);
  };

  say('PR-028 — observe a real selected window');
  say('='.repeat(72));
  say('');
  say('Real: WindowGate, PermissionGate, PilotInteractionController,');
  say('      ObservationSession, ObservationCore, PilotScreenContextService,');
  say('      MacWindowAdapter, MacPermissionAdapter, MacAccessibilityAdapter,');
  say('      MacObservationAdapter, NativeHelperTransport (framed stdio v1).');
  say('Stub: the process on the far end of the pipe. Nothing below the wire');
  say('      protocol — no ScreenCaptureKit, no TCC, no accessibility tree —');
  say('      has ever run. See section 7.');
  say('');

  // -------------------------------------------------------------------------
  // 1. permissions, and the refusal an unwired facade produces
  // -------------------------------------------------------------------------
  const rig = await createObservationRig({
    stub: {
      // All four: `@pilot/interaction`'s `REQUIRED_PERMISSIONS` keeps the
      // machine in `needs-permission` until every one is granted, and the two
      // voice permissions are not observation's business but are the machine's.
      permissions: {
        'screen-recording': 'granted',
        accessibility: 'granted',
        microphone: 'granted',
        'speech-recognition': 'granted',
      },
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
      // Every `windows.list` answers with the next entry, and the last repeats.
      // Section 5 walks off the end of the first three and the window is gone —
      // driven by the real `MacWindowAdapter` diff, with no timer and nothing
      // faking the event.
      desktopScript: [DEMO_DESKTOP, DEMO_DESKTOP, DEMO_DESKTOP_AFTER_CLOSE],
    },
  });

  try {
    say('1. permissions (runbook follow-up 16)');
    say(`   platform: kind=${rig.platform.kind} — ${rig.platform.reason}`);
    say(`   capture available: ${String(rig.observation.captureAvailable)}`);
    say('');
    say('   Before any permission snapshot has arrived, ScreenContextConditions');
    say('   defaults to `unknown`, which §10 step 1 refuses. This is the state a');
    say('   facade nobody wired is in, permanently:');
    await refuse(rig, say);

    const permissionState = await rig.permissions.refresh();
    const attribution = await rig.observation.refreshAttribution();
    say('');
    say(
      `   after refresh: screen-recording=${String(
        permissionState.snapshot?.['screen-recording'].state,
      )} accessibility=${String(permissionState.snapshot?.accessibility.state)}`,
    );
    say(
      `   attribution:   verdict=${String(attribution?.verdict)} confidence=${String(
        attribution?.confidence,
      )}`,
    );
    say('');

    // -----------------------------------------------------------------------
    // 2. selection starts capture, frames reach the ring
    // -----------------------------------------------------------------------
    say('2. selecting a window starts capture, and the frames reach the ring');
    const window = await rig.firstWindow();
    say(`   picker: ${String(rig.windows.snapshot().windows.length)} window(s) enumerated`);
    say(`   chosen: ${window.applicationName} — "${window.title}" (${window.windowId})`);
    say(`   before: ${state(rig)} ring: ${ring(rig)}`);

    await rig.windows.act({ type: 'select', windowId: window.windowId });
    // `select-window` sets observationEnabled and emits start-capture; the
    // effect queue is asynchronous, so wait for it rather than assuming.
    await rig.controller.settled();
    say(`   after:  ${state(rig)} ring: ${ring(rig)}`);
    say(
      `   capture: adapter=${String(rig.platform.capture?.constructor.name)} ` +
        `requested encoding=${CAPTURE_ENCODING}`,
    );

    const capture = rig.platform.capture as unknown as {
      drain(): Promise<void>;
      metrics(): { framesDelivered: number; bytesDelivered: number; lastState: string };
    };
    for (let tick = 0; tick < 4; tick += 1) {
      await capture.drain();
    }
    await rig.observation.samplePointer();
    const captureMetrics = capture.metrics();
    say(
      `   drained: framesDelivered=${String(captureMetrics.framesDelivered)} ` +
        `bytes=${bytes(captureMetrics.bytesDelivered)} state=${captureMetrics.lastState}`,
    );
    say(`   ring:    ${ring(rig)}`);
    const newest = rig.observation.core.frames.newest();
    say(
      `   newest:  encoding=${String(newest?.frame.encoding)} ` +
        `size=${String(newest?.frame.size.width)}x${String(newest?.frame.size.height)} ` +
        `windowId=${String(newest?.frame.windowId)}`,
    );
    say('   (encoding=png is runbook follow-up 18: a jpeg source frame costs');
    say('    ~165 ms of pure-JS decode per pointer crop and a second generation');
    say('    of loss on exactly the small text grounding depends on.)');
    say('');

    // -----------------------------------------------------------------------
    // 3. an observation, and what the diagnostics see of it
    // -----------------------------------------------------------------------
    say('3. one observation, through the §10 policy');
    await rig.observation.port.observe('observation-demo-look' as never).catch((cause: unknown) => {
      const error = cause as { code?: string; message?: string };
      say(`   REFUSED: ${String(error.code)} — ${String(error.message)}`);
    });
    const metadata = rig.observation.lastObservation();
    say(`   scene:    ${String(metadata?.sceneId)} revision ${String(metadata?.sceneRevision)}`);
    say(`   window:   "${String(metadata?.windowTitle)}"`);
    say(
      `   frames:   ${(metadata?.frames ?? [])
        .map((frame) => `${frame.purpose}:${frame.origin}`)
        .join(', ')}`,
    );
    say(
      `   images:   ${(metadata?.images ?? [])
        .map((image) => `${image.purpose} ${image.mimeType} ${bytes(image.byteLength)}`)
        .join(', ')}`,
    );
    say(
      `   pointer:  known=${String(metadata?.pointerKnown)} ` +
        `insideWindow=${String(metadata?.pointerInsideWindow)} ` +
        `targetRole=${String(metadata?.targetRole)}`,
    );
    say(`   redaction: ${String(metadata?.redaction.guarantee)}`);
    const pointerSample = rig.observation.core.pointer.newest();
    say(
      `   the pointer target the timeline recorded: role=${String(
        pointerSample?.pointer.accessibilityTarget?.role,
      )} label="${String(pointerSample?.pointer.accessibilityTarget?.label)}"`,
    );
    say('   (`targetRole` on the observation stays null until PR-031 supplies the');
    say('    question anchor; the *timeline* target above is what it will carry.)');
    const samples = rig.conversation.telemetry.snapshot().samples;
    say(
      `   diagnostics: ${samples
        .filter((sample) =>
          ['capture-to-observation', 'image-bytes', 'active-images'].includes(sample.metric),
        )
        .map((sample) => `${sample.metric}=${String(sample.value)}`)
        .join(' ')}`,
    );
    say('');

    // -----------------------------------------------------------------------
    // 4. pause clears, immediately and through the guard
    // -----------------------------------------------------------------------
    say('4. pause clears immediately (system-design §13, runbook follow-up 17)');
    say(`   before pause: ${ring(rig)}`);
    rig.controller.dispatch({ type: 'pause' });
    await rig.controller.settled();
    say(`   after pause:  ${ring(rig)}`);
    say(`   state:        ${state(rig)}`);
    say(`   guard clears: ${String(rig.observation.retention.clears)}`);
    say(`   image cache wired into the guard: ${String(rig.observation.retention.hasImageCache)}`);
    say('   An observation asked for while paused is refused, not answered from');
    say('   a buffer that no longer exists:');
    await refuse(rig, say);
    say('');

    // -----------------------------------------------------------------------
    // 5. window loss stops and clears
    // -----------------------------------------------------------------------
    say('5. the selected window closes (system-design §16)');
    rig.controller.dispatch({ type: 'resume' });
    await rig.controller.settled();
    await rig.windows.act({ type: 'select', windowId: window.windowId });
    await rig.controller.settled();
    await capture.drain();
    say(`   watching again: ${state(rig)} ring: ${ring(rig)}`);

    // The stub's desktop script now reports a desktop without that window, so
    // the real `MacWindowAdapter` diff produces `window-closed` — nothing here
    // fakes the event, and nothing here is on a timer.
    for (let attempt = 0; attempt < 4 && rig.windows.snapshot().notice === null; attempt += 1) {
      await rig.windows.refresh();
      await rig.controller.settled();
    }
    const notice = rig.windows.snapshot().notice;
    say(`   after close:    ${state(rig)} ring: ${ring(rig)}`);
    say(
      `   notice:         reason=${String(notice?.reason)} wasObserving=${String(
        notice?.wasObserving,
      )}`,
    );
    say(`   lastError:      ${String(rig.controller.snapshot().lastError?.code)}`);
    say(`   guard clears:   ${String(rig.observation.retention.clears)}`);
    say('');

    // -----------------------------------------------------------------------
    // 6. a permission state that refuses
    // -----------------------------------------------------------------------
    say('6a. a permission state that refuses (Screen Recording denied)');
    const denied = await createObservationRig({
      stub: {
        permissions: {
          'screen-recording': 'denied',
          accessibility: 'granted',
          microphone: 'granted',
          'speech-recognition': 'granted',
        },
        desktop: DEMO_DESKTOP,
      },
    });
    try {
      const permissionSnapshot = await denied.permissions.refresh();
      say(`   screen-recording=${String(permissionSnapshot.snapshot?.['screen-recording'].state)}`);
      const target = await denied.firstWindow();
      const refusal = await denied.windows.act({ type: 'select', windowId: target.windowId });
      say('   the window gate refuses the selection before the machine sees it:');
      say(`   ${String(refusal.lastError?.code)} — ${String(refusal.lastError?.userMessage)}`);
      await refuse(denied, say);
    } finally {
      await denied.dispose();
    }
    say('');

    say('6b. a grant macOS does not credit to Pilot (runbook follow-up 16)');
    say('    Every permission reads `granted`, and the observation is still');
    say('    refused: PR-011 says the responsible process is the helper, so the');
    say('    grant does not reach Pilot. Reporting `granted` here would produce');
    say('    an empty capture that looks like a capture bug.');
    const misattributed = await createObservationRig({
      stub: {
        permissions: {
          'screen-recording': 'granted',
          accessibility: 'granted',
          microphone: 'granted',
          'speech-recognition': 'granted',
        },
        desktop: DEMO_DESKTOP,
        attribution: { responsibleProcessPid: 4321 },
      },
    });
    try {
      const permissionSnapshot = await misattributed.permissions.refresh();
      const verdict = await misattributed.observation.refreshAttribution();
      say(
        `   screen-recording=${String(
          permissionSnapshot.snapshot?.['screen-recording'].state,
        )} attribution=${String(verdict?.verdict)}`,
      );
      const target = await misattributed.firstWindow();
      await misattributed.windows.act({ type: 'select', windowId: target.windowId });
      await misattributed.controller.settled();
      await refuse(misattributed, say);
    } finally {
      await misattributed.dispose();
    }
    say('');

    // -----------------------------------------------------------------------
    // 7. what was never executed
    // -----------------------------------------------------------------------
    say('7. what none of the above proves (docs/handoff.md §1)');
    for (const [head, ...rest] of [
      ['the Swift helper has never been compiled — no `swift build` has run'],
      [
        'ScreenCaptureKit has never produced a pixel. The frames above are the',
        "stub's deterministic bytes: their headers are meaningful, their",
        'contents are not a real PNG, which is why a pointer crop cannot be',
        'rendered here — that path needs a decodable frame and a Mac.',
      ],
      [
        'no TCC prompt has ever appeared, and both attribution verdicts above',
        "are the stub's own claims about a bundle that does not exist",
      ],
      ['no real pointer and no real accessibility element has been read'],
      [
        'idle-frame re-send, protected content and the mach → epoch timestamp',
        'conversion are all unobserved (handoff §1, step 6 items 2, 4 and 5)',
      ],
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
