import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { helperBinaryCandidates } from '@pilot/platform-mac';
import {
  asFrameId,
  asObservationId,
  isPilotError,
  type CapturedFrame,
  type PermissionSnapshot,
} from '@pilot/shared';
import { encodePng, renderSyntheticScreen } from '@pilot/observation';
import { FIXTURE_PERMISSIONS_GRANTED } from '@pilot/platform/fakes';
import { AX_ELEMENTS, OVER_THE_BUTTON } from '../../src/observation/ask-demo.js';
import { observationPermissionConditions } from '../../src/main/observation-runtime.js';
import { CAPTURE_ENCODING, describePlatformChoice } from '../../src/main/platform-runtime.js';
import {
  createObservationRig,
  DEMO_DESKTOP,
  DEMO_DESKTOP_AFTER_CLOSE,
  type ObservationRig,
} from '../../src/observation/observe-rig.js';

/**
 * The observation boundary, end to end (PR-028).
 *
 * Every test here runs the **shipping composition** — `WindowGate`,
 * `PilotInteractionController`, `ObservationSession`, `ObservationCore`,
 * `PilotScreenContextService`, `MacObservationAdapter`, `MacWindowAdapter`,
 * `MacPermissionAdapter`, `MacAccessibilityAdapter` and the real framed stdio
 * transport — against the Node helper stub. The only thing standing in is the
 * process on the far end of the pipe.
 *
 * **What this cannot say anything about**: whether ScreenCaptureKit produces a
 * frame, whether macOS credits a grant to Pilot, whether a real accessibility
 * tree answers a hit test. There is no macOS and no Swift toolchain on this
 * machine (runbook §5 amendment 8) and none of that has ever run.
 * `docs/handoff.md` §1 carries the commands that settle it.
 *
 * The five behaviours `docs/implementation.md` asks PR-028 to demonstrate are
 * one `describe` each, in the order the demo prints them.
 */

const GRANTED = {
  'screen-recording': 'granted',
  accessibility: 'granted',
  microphone: 'granted',
  'speech-recognition': 'granted',
} as const;

const rigs: ObservationRig[] = [];

async function rig(stub: Record<string, unknown> = {}): Promise<ObservationRig> {
  const created = await createObservationRig({
    stub: { permissions: GRANTED, desktop: DEMO_DESKTOP, ...stub },
  });
  rigs.push(created);
  await created.permissions.refresh();
  await created.observation.refreshAttribution();
  return created;
}

/** Selects the first window and lets the effect queue settle. */
async function watchFirstWindow(current: ObservationRig): Promise<string> {
  const window = await current.firstWindow();
  await current.windows.act({ type: 'select', windowId: window.windowId });
  await current.controller.settled();
  return window.windowId;
}

interface Drainable {
  drain(): Promise<void>;
  metrics(): {
    framesDelivered: number;
    bytesDelivered: number;
    lastState: string;
    dropped: Record<string, number>;
  };
  state: string;
}

function capture(current: ObservationRig): Drainable {
  return current.platform.capture as unknown as Drainable;
}

async function drain(current: ObservationRig, ticks: number): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    await capture(current).drain();
  }
}

afterEach(async () => {
  for (const created of rigs.splice(0)) {
    await created.dispose();
  }
});

describe('the platform choice', () => {
  it('runs the macOS adapters against the stub, and says so', async () => {
    const current = await rig();
    expect(current.platform.kind).toBe('macos-stub');
    expect(current.platform.capture?.constructor.name).toBe('MacObservationAdapter');
    expect(current.platform.windows.constructor.name).toBe('MacWindowAdapter');
    expect(current.platform.permissions.constructor.name).toBe('MacPermissionAdapter');
    expect(current.observation.captureAvailable).toBe(true);
    // The fake window-lifecycle controls are PR-028's to remove; they survive
    // for the fakes build only, and this is not it.
    expect(current.platform.fakeWindows).toBeNull();
    expect(current.windows.snapshot().demoEvents).toBe(false);
  });

  it('falls back to the fakes with a reason, never silently', () => {
    expect(describePlatformChoice({ env: {}, platform: 'linux' })).toEqual({
      kind: 'fakes',
      reason: 'platform is linux, not darwin',
    });
    expect(
      describePlatformChoice({ env: { PILOT_PLATFORM: 'fakes' }, platform: 'darwin' }),
    ).toEqual({ kind: 'fakes', reason: 'PILOT_PLATFORM=fakes' });
    // The darwin branch depends on whether this machine has actually built the
    // Swift helper, so the expectation is derived from that rather than
    // assumed. Written on Linux, where the helper could never exist, this
    // asserted the fakes case unconditionally and failed the first time it ran
    // on a Mac with a built helper — which is the case it most needed to allow.
    const onDarwin = describePlatformChoice({ env: {}, platform: 'darwin' });
    const built = helperBinaryCandidates({ env: {} }).some((candidate) =>
      existsSync(candidate.path),
    );
    if (built) {
      expect(onDarwin.kind).toBe('macos');
      expect(onDarwin.reason).toContain('helper binary');
    } else {
      // The reason names every path searched: a Mac running on fakes because
      // the helper was never built must not look like a Mac whose capture is
      // broken.
      expect(onDarwin.kind).toBe('fakes');
      expect(onDarwin.reason).toContain('no helper binary');
    }
  });
});

describe('1. selecting a window starts capture', () => {
  it('turns observation on and opens a stream for that window and no other', async () => {
    const current = await rig();
    expect(current.controller.snapshot().observationEnabled).toBe(false);
    expect(current.observation.session.state).toBe('idle');

    const windowId = await watchFirstWindow(current);

    const view = current.controller.snapshot();
    expect(view.state).toBe('observing');
    expect(view.observationEnabled).toBe(true);
    expect(view.selectedWindow?.windowId).toBe(windowId);
    expect(current.observation.session.state).toBe('observing');
    expect(current.observation.core.scene?.windowId).toBe(windowId);
    expect(current.observation.metrics().starts).toBe(1);
  });
});

describe('2. frames reach the ring', () => {
  /**
   * PR-012's six frame guarantees, through the desktop wiring.
   *
   * `packages/platform-mac/test/capture-frame-contract.test.ts` asserts them
   * against `FrameRing` directly, one describe each. This asserts them where
   * PR-028 puts them: the same adapter feeding the ring the *application* owns.
   * Every one of them fails as **silence** rather than as an error, which is why
   * they are worth restating at the integration seam rather than trusting.
   */
  it('honours all six frame guarantees the ring depends on', async () => {
    const current = await rig({ captureFrameBytes: 2_048 });
    await watchFirstWindow(current);

    await drain(current, 5);

    const records = current.observation.core.frames.records();
    // 1. `capturedAt` is on the system clock base — a mach-style timestamp
    //    would be rejected as `stale` and the ring would be empty.
    expect(records).toHaveLength(5);
    expect(current.observation.core.frames.metrics().rejected.stale).toBe(0);
    // 2. `byteLength` is the real retained cost, so the ring's byte bound
    //    governs the memory actually held.
    expect(current.observation.core.status().buffer.byteCount).toBe(5 * 2_048);
    for (const record of records) {
      expect(record.byteLength).toBe(record.frame.bytes.byteLength);
      expect(record.frame.bytes.byteOffset).toBe(0);
      expect(record.frame.bytes.buffer.byteLength).toBe(record.frame.bytes.byteLength);
    }
    // 3. `frameId` is unique per capture — a repeat is rejected as `duplicate`.
    expect(new Set(records.map((record) => record.frame.frameId)).size).toBe(5);
    expect(current.observation.core.frames.metrics().rejected.duplicate).toBe(0);
    // 4. `windowId` is exactly the selected window's, so nothing is rejected as
    //    foreign. (The other half — a frame from another window is *dropped* —
    //    is the test below.)
    for (const record of records) {
      expect(record.frame.windowId).toBe(current.observation.core.scene?.windowId);
    }
    expect(current.observation.metrics().framesRejected).toBe(0);
    // 5. No zero-length frame is ever emitted.
    for (const record of records) {
      expect(record.frame.bytes.byteLength).toBeGreaterThan(0);
    }
    // 6. Frames are retained by reference and never recycled: distinct backing
    //    stores, and the ring holds the very object the adapter emitted.
    expect(new Set(records.map((record) => record.frame.bytes.buffer)).size).toBe(5);
    expect(capture(current).metrics().framesDelivered).toBe(5);
  });

  it('drops an empty frame at the adapter, so the ring never sees it', async () => {
    const current = await rig({
      captureScript: [{ frame: { bytes: 0 } }, { frame: { bytes: 512 } }],
    });
    await watchFirstWindow(current);

    await drain(current, 2);

    expect(current.observation.core.status().buffer.frameCount).toBe(1);
    expect(current.observation.core.frames.metrics().rejected['empty-bytes']).toBe(0);
    expect(capture(current).metrics().dropped['empty-bytes']).toBe(1);
  });

  it('asks for `png`, closing runbook follow-up 18', async () => {
    const current = await rig();
    await watchFirstWindow(current);
    await drain(current, 1);

    // The stub echoes the encoding the host asked `capture.start` for, so this
    // reads the request as it crossed the wire rather than a local constant.
    expect(CAPTURE_ENCODING).toBe('png');
    expect(current.observation.core.frames.newest()?.frame.encoding).toBe('png');
  });

  it('records the pointer and its accessibility target alongside the frames', async () => {
    const current = await rig({
      pointer: { x: 700, y: 480 },
      axElements: [
        {
          bounds: { x: 640, y: 440, width: 220, height: 80 },
          role: 'AXButton',
          label: 'Update payment method',
          ownerPid: 501,
        },
      ],
    });
    await watchFirstWindow(current);

    expect(await current.observation.samplePointer()).toBe(true);

    const sample = current.observation.core.pointer.newest();
    expect(sample?.pointer.accessibilityTarget?.role).toBe('AXButton');
    expect(sample?.pointer.normalizedPoint.x).toBeGreaterThan(0);
    expect(sample?.pointer.normalizedPoint.x).toBeLessThan(1);
  });

  it('counts the pointer samples it took (runbook follow-up 31)', async () => {
    // Until PR-036 this read 0 on the shipping path however many samples had
    // been taken: `ObservationSession` only increments its own counter on the
    // `samplePointer()` fallback, and the app takes `groundFast`. It cost
    // nothing while nothing consumed the metric; PR-036's telemetry does.
    const current = await rig({ pointer: { x: 700, y: 480 } });
    await watchFirstWindow(current);
    expect(current.observation.metrics().pointerSamples).toBe(0);

    expect(await current.observation.samplePointer()).toBe(true);
    // One coalescing bucket apart: `PointerTimeline` keeps the last sample
    // inside `DEFAULT_POINTER_MIN_INTERVAL_MS`, so two calls back to back are
    // one admitted sample (runbook cross-lane issue 14).
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await current.observation.samplePointer()).toBe(true);

    expect(current.observation.metrics().pointerSamples).toBe(2);
    expect(current.observation.metrics().groundedPointerSamples).toBe(2);
    // The number the metric reports is the number of samples the timeline
    // *admitted*, which is the same rule `ObservationSession` counts by.
    expect(current.observation.core.pointer.samples()).toHaveLength(2);
  });

  it('drops a frame from another window rather than delivering it', async () => {
    // PR-012's fourth frame guarantee, asserted where it matters: through the
    // desktop wiring into the real ring, not only in the adapter's own suite.
    const current = await rig({
      captureScript: [{ frame: { windowNumber: 77 } }, { frame: {} }],
    });
    await watchFirstWindow(current);

    await drain(current, 2);

    expect(current.observation.core.status().buffer.frameCount).toBe(1);
    expect(capture(current).metrics().dropped['foreign-window']).toBe(1);
  });
});

describe('3. an observation reaches the diagnostics', () => {
  it('produces a §9 observation and content-free numbers for the ring', async () => {
    const current = await rig();
    await watchFirstWindow(current);
    await drain(current, 2);

    await current.observation.port.observe(asObservationId('obs-1'));

    const metadata = current.observation.lastObservation();
    expect(metadata?.view).toBe('window');
    expect(metadata?.moment).toBe('current');
    expect(metadata?.images).toHaveLength(1);
    expect(metadata?.frames[0]?.origin).toBe('fresh');

    const metrics = current.conversation.telemetry.snapshot().samples.map((s) => s.metric);
    expect(metrics).toContain('capture-to-observation');
    expect(metrics).toContain('image-bytes');
    expect(metrics).toContain('active-images');
    // §17 permits timings and counts. Nothing else may reach the ring, and
    // `TelemetryRing` has no method that would take a title or a transcript.
    for (const sample of current.conversation.telemetry.snapshot().samples) {
      expect(typeof sample.value).toBe('number');
    }
  });

  it('renders a real pointer crop when the frame is a real image', async () => {
    // The stub's frames are deterministic bytes, not a decodable PNG, so the
    // decode-and-crop half of §10 step 5 cannot be reached through it. This is
    // the one place that path is exercised: a genuine PNG, encoded by the same
    // codec the pipeline decodes with, pushed into the same ring the adapter
    // pushes into.
    const current = await rig({ pointer: { x: 700, y: 480 } });
    const windowId = await watchFirstWindow(current);
    await current.observation.samplePointer();

    const screen = renderSyntheticScreen({ size: { width: 640, height: 400 } });
    const frame: CapturedFrame = {
      frameId: asFrameId('frame-synthetic-1'),
      windowId: windowId as CapturedFrame['windowId'],
      capturedAt: Date.now(),
      size: { width: 640, height: 400 },
      scaleFactor: 2,
      encoding: 'png',
      bytes: await encodePng(screen.pixels),
    };
    expect(current.observation.session.ingestFrame(frame).ingest.admitted).toBe(true);

    const result = await current.observation.screenContext.observeDetailed({
      view: 'both',
      moment: 'question',
    });

    expect(result.observation.images.map((image) => image.purpose)).toEqual(['window', 'pointer']);
    for (const image of result.observation.images) {
      expect(image.base64.length).toBeGreaterThan(0);
    }
  });
});

describe('4. pause clears immediately, through the retention guard', () => {
  it('empties the ring and drops the decoded frame in one guarded call', async () => {
    const current = await rig();
    await watchFirstWindow(current);
    await drain(current, 4);
    await current.observation.port.observe(asObservationId('obs-pause'));
    expect(current.observation.core.status().buffer.frameCount).toBeGreaterThan(0);

    const clearsBefore = current.observation.retention.clears;
    current.controller.dispatch({ type: 'pause' });
    await current.controller.settled();

    expect(current.controller.snapshot().state).toBe('paused');
    const status = current.observation.core.status();
    expect(status.buffer.frameCount).toBe(0);
    expect(status.buffer.byteCount).toBe(0);
    expect(status.pointer.sampleCount).toBe(0);
    // Runbook follow-up 17: the session clears the core directly, which is not
    // the guard. The guard is what also resets the rate limiter and drops the
    // decoded screenshot, and it throws rather than reporting a clear that did
    // not work.
    expect(current.observation.retention.clears).toBeGreaterThan(clearsBefore);
    expect(current.observation.retention.hasImageCache).toBe(true);
    expect(current.observation.core.isEmpty()).toBe(true);
  });

  it('refuses an observation asked for while paused', async () => {
    const current = await rig();
    await watchFirstWindow(current);
    current.controller.dispatch({ type: 'pause' });
    await current.controller.settled();

    await expect(current.observation.port.observe(asObservationId('obs-x'))).rejects.toSatisfy(
      (error: unknown) => isPilotError(error) && error.code === 'observation-paused',
    );
  });
});

describe('5. the selected window closing stops and clears', () => {
  it('stops capture, clears the buffers and asks for a new selection', async () => {
    const current = await rig({
      desktopScript: [DEMO_DESKTOP, DEMO_DESKTOP_AFTER_CLOSE],
    });
    await watchFirstWindow(current);
    await drain(current, 3);
    expect(current.observation.core.status().buffer.frameCount).toBe(3);

    // The real `MacWindowAdapter` diff produces `window-closed`; nothing here
    // fabricates the event.
    await current.windows.refresh();
    await current.controller.settled();

    const view = current.controller.snapshot();
    expect(view.state).toBe('error');
    expect(view.lastError?.code).toBe('window-closed');
    expect(view.selectedWindow).toBeNull();
    expect(view.observationEnabled).toBe(false);
    expect(current.observation.core.isEmpty()).toBe(true);
    expect(current.observation.session.state).not.toBe('observing');
    // system-design §16: the user is prompted for a new selection, and the
    // prompt survives the panel being shut.
    expect(current.windows.snapshot().notice).toMatchObject({
      reason: 'selected-window-closed',
      wasObserving: true,
    });
  });
});

describe('6. a permission state that refuses', () => {
  it('refuses every observation while no snapshot has arrived', async () => {
    const current = await rig();
    await watchFirstWindow(current);
    await drain(current, 2);

    // Exactly the state PR-019 designed the `'unknown'` default for: a facade
    // nobody supplied permission states to.
    current.observation.notePermissions(null);

    await expect(current.observation.port.observe(asObservationId('obs-p'))).rejects.toSatisfy(
      (error: unknown) => isPilotError(error) && error.code === 'permission-denied',
    );
  });

  it('refuses a grant macOS does not credit to Pilot', async () => {
    // Runbook follow-up 16's second half. Every permission reads `granted`;
    // PR-011's verdict says the helper is the responsible process, so the grant
    // does not reach Pilot and an observation would capture nothing while
    // reporting no error at all.
    const current = await rig({ attribution: { responsibleProcessPid: 4321 } });
    expect((await current.observation.refreshAttribution())?.verdict).toBe('helper-attributed');
    await watchFirstWindow(current);
    await drain(current, 2);

    await expect(current.observation.port.observe(asObservationId('obs-a'))).rejects.toSatisfy(
      (error: unknown) => isPilotError(error) && error.code === 'permission-denied',
    );
  });

  it('refuses the control at the window gate when Screen Recording is denied', async () => {
    const current = await rig({
      permissions: { ...GRANTED, 'screen-recording': 'denied' },
    });
    const window = await current.firstWindow();

    const state = await current.windows.act({ type: 'select', windowId: window.windowId });

    expect(state.lastError?.code).toBe('permission-denied');
    expect(current.controller.snapshot().selectedWindow).toBeNull();
    expect(current.observation.metrics().starts).toBe(0);
  });

  /**
   * PR-044, system-design §13 and §16. A revocation used to be followed by the
   * machine's own whole-buffer clear, which took the retained accessibility
   * elements with it. Losing Accessibility no longer stops anything, so nothing
   * clears — and labels read under a permission the user has just withdrawn
   * would simply stay in the pointer-target log. They are dropped on their own,
   * and the ring is deliberately *not*: §16's degraded mode is the picture plus
   * the point, and emptying the ring would take the picture away.
   */
  it('drops the retained accessibility elements when Accessibility is withdrawn, and keeps the frames', async () => {
    const current = await rig({ axElements: AX_ELEMENTS, pointer: OVER_THE_BUTTON });
    await watchFirstWindow(current);
    await drain(current, 2);
    await current.observation.samplePointer();

    expect(current.observation.metrics().pointerTargets).toBeGreaterThan(0);
    const framesBefore = current.observation.core.status().buffer.frameCount;
    expect(framesBefore).toBeGreaterThan(0);

    current.observation.notePermissions({
      ...FIXTURE_PERMISSIONS_GRANTED,
      accessibility: { kind: 'accessibility', state: 'denied', canRequest: false },
    });

    expect(current.observation.metrics().pointerTargets).toBe(0);
    expect(current.observation.core.status().buffer.frameCount).toBe(framesBefore);
    // The observation itself is still permitted — Screen Recording is untouched.
    await expect(
      current.observation.port.observe(asObservationId('obs-degraded')),
    ).resolves.not.toThrow();
  });

  it('drops nothing when Accessibility was already refused, or is merely unknown', async () => {
    const current = await rig({ axElements: AX_ELEMENTS, pointer: OVER_THE_BUTTON });
    await watchFirstWindow(current);
    await drain(current, 2);
    await current.observation.samplePointer();
    const targets = current.observation.metrics().pointerTargets;
    expect(targets).toBeGreaterThan(0);

    // Hazard 22: an unknown permission is not a refusal, and neither snapshot
    // here is a *transition* out of granted.
    current.observation.notePermissions(null);
    expect(current.observation.metrics().pointerTargets).toBe(targets);
    current.observation.notePermissions({
      ...FIXTURE_PERMISSIONS_GRANTED,
      accessibility: { kind: 'accessibility', state: 'unknown', canRequest: true },
    });
    expect(current.observation.metrics().pointerTargets).toBe(targets);
  });
});

describe('observationPermissionConditions', () => {
  const snapshot = (screen: 'granted' | 'denied'): PermissionSnapshot => ({
    'screen-recording': { kind: 'screen-recording', state: screen, canRequest: false },
    accessibility: { kind: 'accessibility', state: 'granted', canRequest: false },
    microphone: { kind: 'microphone', state: 'granted', canRequest: false },
    'speech-recognition': { kind: 'speech-recognition', state: 'granted', canRequest: false },
  });

  it('reports `unknown` before anything has been read', () => {
    expect(observationPermissionConditions(null)).toEqual({
      screenRecording: 'unknown',
      accessibility: 'unknown',
    });
  });

  it('passes the platform through when attribution is fine, or unanswerable', () => {
    expect(observationPermissionConditions(snapshot('granted'))).toEqual({
      screenRecording: 'granted',
      accessibility: 'granted',
    });
    for (const verdict of ['matched', 'unknown'] as const) {
      expect(
        observationPermissionConditions(snapshot('granted'), {
          verdict,
          confidence: 'direct',
          reason: 'test',
          expected: { pid: 1, bundleIdentifier: null, bundlePath: null },
          attributed: { pid: 1, bundleIdentifier: null, bundlePath: null },
          evidence: {},
        } as never),
      ).toEqual({ screenRecording: 'granted', accessibility: 'granted' });
    }
  });

  it('denies on a failing verdict, because the grant does not reach Pilot', () => {
    for (const verdict of ['helper-attributed', 'bundle-mismatch'] as const) {
      expect(
        observationPermissionConditions(snapshot('granted'), {
          verdict,
          confidence: 'direct',
          reason: 'test',
          expected: { pid: 1, bundleIdentifier: null, bundlePath: null },
          attributed: { pid: 2, bundleIdentifier: null, bundlePath: null },
          evidence: {},
        } as never),
      ).toEqual({ screenRecording: 'denied', accessibility: 'denied' });
    }
  });
});
