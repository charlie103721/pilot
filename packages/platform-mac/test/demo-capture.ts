/**
 * PR-012 demo: selected-window capture.
 *
 * ```sh
 * pnpm build                                              # runs against dist/
 * pnpm --filter @pilot/platform-mac demo:capture          # Node stub (Linux and macOS)
 * PILOT_HELPER_BINARY=… pnpm --filter @pilot/platform-mac demo:capture   # Swift helper (macOS)
 * ```
 *
 * **What implementation.md asks for and what this is.** The stated demo is
 * "stream only a selected real window and stop/clear on loss or pause". A real
 * window needs a Mac, a compositor and a Screen Recording grant, and there is
 * none of that here (runbook amendment 8), so **the real demo cannot run on
 * this machine and this is not it.**
 *
 * What this does run, end to end and for real, is the host half: the screen
 * policy applied to a window, the framed binary transport carrying pixels, the
 * six frame guarantees `@pilot/observation` depends on, the selected-window
 * check, protected content, window loss, screen lock, an aborted fresh capture
 * and backpressure — with a scripted stream standing in for the compositor.
 *
 * It prints which target it selected on its first line and **which window it
 * selected on its second**, matching PR-003 and PR-011. Against the Swift
 * helper it enumerates real windows and picks one; against the stub it uses a
 * fixture desktop. Everything after that line is scoped to that one window.
 */

import { fileURLToPath } from 'node:url';
import {
  MacObservationAdapter,
  MacWindowAdapter,
  NativeHelperTransport,
  macWindowNumber,
  resolveCaptureStream,
  resolveHelperBinary,
  type HelperTransportOptions,
} from '@pilot/platform-mac';
import {
  MVP_SCREEN_POLICY,
  asDisplayId,
  asWindowId,
  type CaptureOptions,
  type CapturedFrame,
  type ObservedWindow,
} from '@pilot/shared';
import type { ObservationEvent, WindowEvent } from '@pilot/platform';

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const STUB_PATH = fileURLToPath(new URL('./support/helper-stub.ts', import.meta.url));

const OPTIONS: CaptureOptions = {
  sampleFps: MVP_SCREEN_POLICY.sampleFps,
  maxEdgePixels: MVP_SCREEN_POLICY.fullFrameMaxEdge,
  includeCursor: false,
};

/** The desktop the stub reports, so `windows.list` has something to answer with. */
const STUB_DESKTOP = {
  windows: [
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
  ],
  displays: [
    {
      displayNumber: 1,
      bounds: { x: 0, y: 0, width: 1728, height: 1117 },
      scaleFactor: 2,
      isPrimary: true,
    },
  ],
  screenLocked: false,
};

/** The fixture used when nothing can be enumerated at all. */
const FIXTURE_WINDOW: ObservedWindow = {
  windowId: asWindowId('mac-window-42'),
  displayId: asDisplayId('mac-display-1'),
  title: 'Billing Settings',
  applicationName: 'Safari',
  applicationBundleId: 'com.apple.Safari',
  bounds: { x: 100, y: 80, width: 1200, height: 800 },
  scaleFactor: 2,
  isOnScreen: true,
};

/** A window adapter that only forwards the lifecycle events the demo stages. */
class DemoWindows {
  readonly #listeners = new Set<(event: WindowEvent) => void>();

  subscribe = (listener: (event: WindowEvent) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  emit(event: WindowEvent): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }

  async list(): Promise<readonly ObservedWindow[]> {
    return [];
  }

  async get(): Promise<ObservedWindow | null> {
    return null;
  }

  async geometry(): Promise<null> {
    return null;
  }
}

interface Target {
  readonly label: string;
  readonly usingStub: boolean;
  readonly options: HelperTransportOptions;
}

function chooseTarget(stub: Record<string, unknown>): Target {
  try {
    const binary = resolveHelperBinary();
    return {
      label: `Swift helper (${binary.source}: ${binary.path}) — real ScreenCaptureKit`,
      usingStub: false,
      options: { command: binary.path },
    };
  } catch {
    return {
      label: 'Node stub (no Swift helper built; see the README for the Mac steps)',
      usingStub: true,
      options: {
        command: process.execPath,
        args: [STUB_PATH],
        env: { ...process.env, PILOT_HELPER_STUB: JSON.stringify(stub) },
      },
    };
  }
}

async function connect(stub: Record<string, unknown>): Promise<NativeHelperTransport> {
  const target = chooseTarget(stub);
  const transport = new NativeHelperTransport({
    ...target.options,
    requestTimeoutMs: 8_000,
    handshakeTimeoutMs: 8_000,
    restart: { enabled: false },
  });
  await transport.start();
  return transport;
}

/**
 * Picks the window to capture: the first enumerable one on a real Mac, the
 * stub's fixture desktop otherwise.
 */
async function selectWindow(): Promise<ObservedWindow> {
  const transport = await connect({ desktop: STUB_DESKTOP });
  try {
    const windows = new MacWindowAdapter({ transport, pollIntervalMs: 60_000 });
    const listed = await windows.list();
    windows.dispose();
    const chosen = listed.find(
      (window) => window.isOnScreen && window.bounds.width > 200 && window.bounds.height > 200,
    );
    return chosen ?? listed[0] ?? FIXTURE_WINDOW;
  } catch {
    return FIXTURE_WINDOW;
  } finally {
    await transport.stop();
  }
}

function describeFrame(frame: CapturedFrame): string {
  return [
    `frameId=${frame.frameId}`,
    `windowId=${frame.windowId}`,
    `${String(frame.size.width)}x${String(frame.size.height)}`,
    `scale=${frame.scaleFactor.toFixed(2)}`,
    `${frame.encoding}`,
    `${String(frame.bytes.byteLength)}B`,
    `age=${String(Date.now() - frame.capturedAt)}ms`,
  ].join(' ');
}

interface Stage {
  readonly adapter: MacObservationAdapter;
  readonly windows: DemoWindows;
  readonly frames: CapturedFrame[];
  readonly events: ObservationEvent[];
}

async function section(
  title: string,
  stub: Record<string, unknown>,
  body: (stage: Stage) => Promise<void>,
): Promise<void> {
  say(`\n${title}`);
  const transport = await connect(stub);
  const windows = new DemoWindows();
  const adapter = new MacObservationAdapter({
    transport,
    windows: windows as never,
    pollIntervalMs: 60_000,
  });
  const frames: CapturedFrame[] = [];
  const events: ObservationEvent[] = [];
  adapter.subscribe((frame) => frames.push(frame));
  adapter.subscribeEvents((event) => events.push(event));
  try {
    await body({ adapter, windows, frames, events });
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    say(`   FAILED: ${failure.code ?? 'unknown'} — ${failure.message ?? String(error)}`);
  } finally {
    adapter.dispose();
    await transport.stop();
  }
}

/** Drains until enough frames have arrived, or the budget runs out. */
async function drainUntil(
  adapter: MacObservationAdapter,
  frames: readonly CapturedFrame[],
  wanted: number,
  budgetMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (frames.length < wanted && Date.now() < deadline && adapter.session !== null) {
    await adapter.drain();
    if (frames.length < wanted) {
      await sleep(120);
    }
  }
}

async function main(): Promise<void> {
  say(`target: ${chooseTarget({}).label}`);
  const selected = await selectWindow();
  const windowNumber = macWindowNumber(selected.windowId) ?? 42;
  say(`selected window: ${selected.applicationName} — "${selected.title}" (${selected.windowId})`);
  say('Pilot captures this window and nothing else. Never a display, never a substitute.');

  say('\n1. screen policy applied to the selection (system-design §10)');
  const resolved = resolveCaptureStream(selected, windowNumber, OPTIONS);
  say(
    `   window ${String(selected.bounds.width)}x${String(selected.bounds.height)} pt at ${String(selected.scaleFactor)}x` +
      ` -> ${String(resolved.sourceSize.width)}x${String(resolved.sourceSize.height)} backing px`,
  );
  say(
    `   capped at ${String(OPTIONS.maxEdgePixels)} px longest edge -> stream ${String(resolved.size.width)}x${String(resolved.size.height)}` +
      ` (effective scale ${resolved.scaleFactor.toFixed(2)})`,
  );
  say(
    `   sampling at ${String(resolved.sampleFps)} FPS -> one frame every ${String(resolved.frameIntervalMs)}ms`,
  );

  /** Normal frames, then a backlog, then a foreign frame, then an empty one. */
  const captureScript = [
    { frame: { bytes: 24_576 } },
    { frame: { bytes: 24_576 }, remaining: 3, dropped: 2 },
    { frame: { bytes: 24_576 }, remaining: 2 },
    { frame: { bytes: 24_576 }, remaining: 0 },
    { frame: { windowNumber: windowNumber + 1, bytes: 24_576 } },
    { frame: { bytes: 0 } },
    { frame: { bytes: 24_576 } },
  ];

  await section(
    '2. streaming the selected window',
    {
      desktop: STUB_DESKTOP,
      captureScript,
      captureFrameBytes: 24_576,
      captureScaleFactor: resolved.scaleFactor,
    },
    async ({ adapter, frames, events }) => {
      await adapter.start(selected, OPTIONS);
      const geometry = adapter.captureGeometry;
      say(
        `   captureSize override for the geometry module: ${String(geometry?.captureSize.width)}x${String(geometry?.captureSize.height)}` +
          ` (window still ${String(geometry?.bounds.width)}x${String(geometry?.bounds.height)} pt at ${String(geometry?.scaleFactor)}x)`,
      );
      await drainUntil(adapter, frames, 4);
      // Two more ticks: against the stub these reach the scripted foreign and
      // empty frames of section 4. Against a real stream they are two more
      // ordinary frames, and section 4 correctly reports nothing refused.
      await adapter.drain();
      await adapter.drain();
      for (const frame of frames) {
        say(`   ${describeFrame(frame)}`);
      }
      if (frames.length === 0) {
        say(`   no frames arrived; capture state is "${adapter.state}"`);
        return;
      }

      say('\n3. the six guarantees @pilot/observation depends on');
      const unique = new Set(frames.map((frame) => frame.frameId));
      const detached = frames.every(
        (frame) =>
          frame.bytes.byteOffset === 0 && frame.bytes.buffer.byteLength === frame.bytes.byteLength,
      );
      const oldest = Math.max(...frames.map((frame) => Date.now() - frame.capturedAt));
      say(
        `   1 capturedAt on the epoch clock base — oldest ${String(oldest)}ms, ring bound ${String(MVP_SCREEN_POLICY.ringDurationMs)}ms`,
      );
      say(`   2 byteLength is the whole retained cost — detached buffers: ${String(detached)}`);
      say(
        `   3 frameId unique per capture — ${String(unique.size)} ids for ${String(frames.length)} frames`,
      );
      say(
        `   4 windowId matches the selection exactly — ${String(frames.every((frame) => frame.windowId === selected.windowId))}`,
      );
      say(
        `   5 no zero-length frame emitted — min bytes ${String(Math.min(...frames.map((frame) => frame.bytes.byteLength)))}`,
      );
      say(
        `   6 no buffer recycling — distinct backing stores: ${String(new Set(frames.map((frame) => frame.bytes.buffer)).size)}`,
      );

      say('\n4. what was refused, and why');
      const dropped = adapter.metrics().dropped;
      say(
        `   foreign-window (a frame of window ${String(windowNumber + 1)}): ${String(dropped['foreign-window'])}`,
      );
      say(`   empty-bytes (a frame with no pixels): ${String(dropped['empty-bytes'])}`);
      say(
        `   producer-backpressure (dropped by the helper's bounded queue): ${String(dropped['producer-backpressure'])}`,
      );
      const backlog = events.filter(
        (event) => event.type === 'frames-dropped' && event.reason === 'producer-backpressure',
      );
      say(`   reported as ${String(backlog.length)} frames-dropped event(s), never as silence`);
    },
  );

  await section(
    '5. fresh capture on demand, and aborting one',
    {
      desktop: STUB_DESKTOP,
      captureScript: [{ frame: { ageMs: 5_000 } }, { frame: { ageMs: 0 } }],
    },
    async ({ adapter }) => {
      await adapter.start(selected, OPTIONS);
      const asked = Date.now();
      const fresh = await adapter.captureFresh();
      say(`   captureFresh -> ${describeFrame(fresh)}`);
      say(
        `   anything the stream produced before the request was discarded: capturedAt is ${String(fresh.capturedAt - asked)}ms relative to it`,
      );

      const controller = new AbortController();
      controller.abort();
      try {
        await adapter.captureFresh(controller.signal);
        say('   aborted captureFresh -> UNEXPECTEDLY RETURNED');
      } catch (error) {
        say(`   aborted captureFresh -> ${(error as { code?: string }).code ?? 'unknown'}`);
      }
    },
  );

  await section(
    '6. protected content is reported, never delivered as a black frame',
    { desktop: STUB_DESKTOP, captureScript: [{ state: 'protected', frame: null }] },
    async ({ adapter, frames }) => {
      await adapter.start(selected, OPTIONS);
      try {
        await adapter.captureFresh();
        say('   captureFresh -> returned a frame (the real window does not block capture)');
      } catch (error) {
        const failure = error as { code?: string; userMessage?: string };
        say(`   captureFresh -> ${failure.code ?? 'unknown'}: ${failure.userMessage ?? ''}`);
      }
      say(`   frames delivered: ${String(frames.length)}`);
      say(`   capture state: ${adapter.state}`);
    },
  );

  await section(
    '7. window loss and screen lock stop capture and clear buffers',
    { desktop: STUB_DESKTOP, captureScript: [{ frame: {} }] },
    async ({ adapter, windows, frames, events }) => {
      await adapter.start(selected, OPTIONS);
      await drainUntil(adapter, frames, 1, 1_500);
      windows.emit({ type: 'screen-locked' });
      say(`   screen-locked -> session=${String(adapter.session)} state=${adapter.state}`);
      windows.emit({ type: 'screen-unlocked' });
      await sleep(120);
      say(`   screen-unlocked -> capture resumed: ${String(adapter.session !== null)}`);
      windows.emit({ type: 'window-closed', windowId: selected.windowId });
      say(`   window-closed -> session=${String(adapter.session)} state=${adapter.state}`);
      for (const event of events) {
        if (event.type === 'capture-stopped') {
          say(`   stop reason=${event.reason} code=${event.error?.code ?? '—'}`);
        }
      }
      windows.emit({ type: 'screen-unlocked' });
      await sleep(120);
      say(`   a closed window does not resume on unlock: ${String(adapter.session === null)}`);
    },
  );

  if (chooseTarget({}).usingStub) {
    say('\nNot demonstrated here (needs a Mac): the SCContentFilter itself, a real');
    say('ScreenCaptureKit stream, real JPEG encoding, the mach -> epoch timestamp');
    say('conversion against a real sample buffer, and whether native/ compiles at all.');
    say('The Mac steps are in docs/handoff.md §1.');
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`demo failed: ${String(error)}\n`);
  process.exitCode = 1;
});
