import { afterEach, describe, expect, it } from 'vitest';
import { PilotError, asWindowId, type CapturedFrame } from '@pilot/shared';
import type { ObservationEvent } from '@pilot/platform';
import { MacObservationAdapter, type NativeHelperTransport } from '@pilot/platform-mac';
import { createStubTransport } from './support/harness.js';
import {
  CAPTURE_OPTIONS,
  ScriptedWindowAdapter,
  captureWindow,
} from './support/capture-harness.js';
import type { StubConfig } from './support/helper-stub.js';

/**
 * The macOS `ObservationAdapter`, driven end to end against the Node stub.
 *
 * The stub scripts what each `capture.pull` answers, so every path — a normal
 * frame, a protected window, a lost window, a lock, a backlog — is reached
 * without a timer or a sleep. `drain()` runs exactly one poll tick, and the
 * background poll interval is set long enough that it never fires during a
 * test.
 */

const transports: NativeHelperTransport[] = [];
const adapters: MacObservationAdapter[] = [];

interface Harness {
  readonly adapter: MacObservationAdapter;
  readonly frames: CapturedFrame[];
  readonly events: ObservationEvent[];
  readonly windows: ScriptedWindowAdapter;
}

async function createHarness(
  stub: StubConfig = {},
  options: Partial<ConstructorParameters<typeof MacObservationAdapter>[0]> = {},
): Promise<Harness> {
  const transport = createStubTransport(stub);
  transports.push(transport);
  await transport.start();

  const windows = new ScriptedWindowAdapter();
  const adapter = new MacObservationAdapter({
    transport,
    windows,
    pollIntervalMs: 60_000,
    ...options,
  });
  adapters.push(adapter);

  const frames: CapturedFrame[] = [];
  const events: ObservationEvent[] = [];
  adapter.subscribe((frame) => frames.push(frame));
  adapter.subscribeEvents((event) => events.push(event));
  return { adapter, frames, events, windows };
}

function stopEvents(events: readonly ObservationEvent[]): readonly ObservationEvent[] {
  return events.filter((event) => event.type === 'capture-stopped');
}

function dropEvents(events: readonly ObservationEvent[]): readonly ObservationEvent[] {
  return events.filter((event) => event.type === 'frames-dropped');
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    adapter.dispose();
  }
  for (const transport of transports.splice(0)) {
    await transport.stop();
  }
});

// ---------------------------------------------------------------------------
// Start and stop
// ---------------------------------------------------------------------------

describe('start', () => {
  it('configures the stream at the policy-downscaled size and announces it', async () => {
    const { adapter, events } = await createHarness();

    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    expect(adapter.session).not.toBeNull();
    expect(adapter.captureSize).toEqual({ width: 1440, height: 960 });
    expect(events[0]).toEqual({
      type: 'capture-started',
      windowId: asWindowId('mac-window-42'),
      captureSize: { width: 1440, height: 960 },
    });
  });

  it('exposes geometry whose captureSize is the stream size, not the backing size', async () => {
    const { adapter } = await createHarness();
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    const geometry = adapter.captureGeometry;

    expect(geometry?.captureSize).toEqual({ width: 1440, height: 960 });
    // The window is still 1200×800 pt on a 2× display; only the capture shrank.
    expect(geometry?.bounds).toEqual({ x: 100, y: 80, width: 1200, height: 800 });
    expect(geometry?.scaleFactor).toBe(2);
  });

  it('refuses a window id that is not a macOS window', async () => {
    const { adapter } = await createHarness();

    await expect(
      adapter.start(captureWindow({ windowId: asWindowId('win-window-3') }), CAPTURE_OPTIONS),
    ).rejects.toMatchObject({ code: 'window-not-found' });
  });

  it('reports a helper that starts a stream for a different window', async () => {
    const { adapter } = await createHarness({ captureSessionWindowNumber: 99 });

    await expect(adapter.start(captureWindow(), CAPTURE_OPTIONS)).rejects.toMatchObject({
      code: 'capture-failed',
    });
    expect(adapter.session).toBeNull();
  });

  it('surfaces a helper-side start failure', async () => {
    const { adapter } = await createHarness({ captureStartFails: 'ScreenCaptureKit refused' });

    await expect(adapter.start(captureWindow(), CAPTURE_OPTIONS)).rejects.toBeInstanceOf(
      PilotError,
    );
  });

  it('subscribes to window lifecycle only while capturing', async () => {
    const { adapter, windows } = await createHarness();

    expect(windows.subscriberCount).toBe(0);
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);
    expect(windows.subscriberCount).toBe(1);
    await adapter.stop();
    expect(windows.subscriberCount).toBe(0);
  });
});

describe('stop', () => {
  it('stops the stream and says why', async () => {
    const { adapter, events } = await createHarness();
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.stop();

    expect(adapter.session).toBeNull();
    expect(stopEvents(events)).toEqual([{ type: 'capture-stopped', reason: 'requested' }]);
  });

  it('is a no-op when nothing is running', async () => {
    const { adapter, events } = await createHarness();

    await adapter.stop();

    expect(stopEvents(events)).toHaveLength(0);
  });

  it('clearBuffers stops the stream so no captured byte survives on either side', async () => {
    const { adapter } = await createHarness();
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.clearBuffers();

    expect(adapter.session).toBeNull();
    expect(adapter.state).toBe('stopped');
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe('streaming', () => {
  it('delivers frames of the selected window with an increasing sequence', async () => {
    const { adapter, frames } = await createHarness({ captureFrameBytes: 512 });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.drain();
    await adapter.drain();

    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame.windowId).toBe(asWindowId('mac-window-42'));
      expect(frame.encoding).toBe('jpeg');
      expect(frame.bytes.byteLength).toBe(512);
      expect(frame.size).toEqual({ width: 1440, height: 960 });
    }
    expect(frames[0]!.frameId).not.toBe(frames[1]!.frameId);
  });

  it('drains a backlog in one tick, bounded by maxDrainPerTick', async () => {
    const { adapter, frames } = await createHarness(
      { captureScript: [{ frame: {}, remaining: 5 }] },
      { maxDrainPerTick: 3 },
    );
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.drain();

    // The queue still reports a backlog, but one tick never takes more than
    // its bound: backpressure is bounded work, not an unbounded loop.
    expect(frames).toHaveLength(3);
  });

  it('stops draining as soon as the queue is empty', async () => {
    const { adapter, frames } = await createHarness(
      { captureScript: [{ frame: {}, remaining: 1 }, { frame: {}, remaining: 0 }, { frame: {} }] },
      { maxDrainPerTick: 8 },
    );
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.drain();

    expect(frames).toHaveLength(2);
  });

  it('reports frames the helper dropped to stay bounded', async () => {
    const { adapter, events } = await createHarness({
      captureScript: [
        { frame: {}, dropped: 0 },
        { frame: {}, dropped: 4 },
      ],
    });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.drain();
    await adapter.drain();

    expect(dropEvents(events)).toContainEqual({
      type: 'frames-dropped',
      reason: 'producer-backpressure',
      count: 4,
    });
    expect(adapter.metrics().helperDropped).toBe(4);
  });

  it('counts nothing but real work in its metrics', async () => {
    const { adapter } = await createHarness({ captureFrameBytes: 128 });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);
    await adapter.drain();

    const metrics = adapter.metrics();

    expect(metrics.framesDelivered).toBe(1);
    expect(metrics.bytesDelivered).toBe(128);
    expect(metrics.pulls).toBeGreaterThanOrEqual(1);
    expect(metrics.lastState).toBe('streaming');
  });
});

// ---------------------------------------------------------------------------
// Frame admission
// ---------------------------------------------------------------------------

describe('frame admission', () => {
  it('drops a frame that belongs to another window', async () => {
    const { adapter, frames, events } = await createHarness({
      captureScript: [{ frame: { windowNumber: 77 } }],
    });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.drain();

    expect(frames).toHaveLength(0);
    expect(dropEvents(events)).toEqual([
      { type: 'frames-dropped', reason: 'foreign-window', count: 1 },
    ]);
  });

  it('drops a zero-length frame rather than emitting one', async () => {
    const { adapter, frames, events } = await createHarness({
      captureScript: [{ frame: { bytes: 0 } }],
    });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.drain();

    expect(frames).toHaveLength(0);
    expect(dropEvents(events)).toEqual([
      { type: 'frames-dropped', reason: 'empty-bytes', count: 1 },
    ]);
  });

  it('drops a repeated sequence number', async () => {
    const { adapter, frames, events } = await createHarness({
      captureScript: [{ frame: { sequence: 5 } }, { frame: { sequence: 5 } }],
    });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.drain();
    await adapter.drain();

    expect(frames).toHaveLength(1);
    expect(dropEvents(events)).toEqual([{ type: 'frames-dropped', reason: 'duplicate', count: 1 }]);
  });

  it('drops a frame whose declared length disagrees with its body', async () => {
    const { adapter, frames, events } = await createHarness({
      captureScript: [{ frame: { bytes: 64, declaredByteLength: 65 } }],
    });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.drain();

    expect(frames).toHaveLength(0);
    expect(dropEvents(events)).toEqual([
      { type: 'frames-dropped', reason: 'byte-length-mismatch', count: 1 },
    ]);
  });

  it('drops a frame no downstream buffer could hold', async () => {
    const { adapter, frames, events } = await createHarness(
      { captureScript: [{ frame: { bytes: 4_096 } }] },
      { maxFrameBytes: 1_024 },
    );
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.drain();

    expect(frames).toHaveLength(0);
    expect(dropEvents(events)).toEqual([{ type: 'frames-dropped', reason: 'too-large', count: 1 }]);
  });

  it('keeps a timestamp the helper reports within tolerance', async () => {
    const { adapter, frames } = await createHarness({ captureScript: [{ frame: { ageMs: 40 } }] });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.drain();

    expect(adapter.metrics().dropped['clock-skew']).toBe(0);
    expect(Math.abs(frames[0]!.capturedAt - Date.now())).toBeLessThan(2_000);
  });

  it('replaces an implausible timestamp with the host clock rather than trusting it', async () => {
    const { adapter, frames } = await createHarness({
      captureScript: [{ frame: { ageMs: 600_000 } }],
    });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.drain();

    expect(frames).toHaveLength(1);
    expect(adapter.metrics().dropped['clock-skew']).toBe(1);
    // The frame is still delivered, and now on a base the ring will accept.
    expect(Math.abs(frames[0]!.capturedAt - Date.now())).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------
// Failure states
// ---------------------------------------------------------------------------

describe('protected content', () => {
  it('stops with a typed failure instead of delivering a blank frame', async () => {
    const { adapter, frames, events } = await createHarness({
      captureScript: [{ state: 'protected', frame: null }],
    });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.drain();

    expect(frames).toHaveLength(0);
    const stopped = stopEvents(events)[0];
    expect(stopped).toMatchObject({ type: 'capture-stopped', reason: 'protected-content' });
    expect((stopped as { error: PilotError }).error.code).toBe('protected-content');
    expect(adapter.session).toBeNull();
  });

  it('makes captureFresh report protected content', async () => {
    const { adapter } = await createHarness({
      captureScript: [{ state: 'protected', frame: null }],
    });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await expect(adapter.captureFresh()).rejects.toMatchObject({ code: 'protected-content' });
  });
});

describe('window loss', () => {
  it('stops when the helper reports the window is gone', async () => {
    const { adapter, events } = await createHarness({
      captureScript: [{ frame: {} }, { state: 'window-lost', frame: null }],
    });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.drain();
    await adapter.drain();

    const stopped = stopEvents(events)[0];
    expect(stopped).toMatchObject({ type: 'capture-stopped', reason: 'window-lost' });
    expect((stopped as { error: PilotError }).error.code).toBe('window-closed');
    expect(adapter.session).toBeNull();
  });

  it('stops mid-stream when the window adapter reports the close', async () => {
    const { adapter, windows, events, frames } = await createHarness();
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);
    await adapter.drain();
    expect(frames).toHaveLength(1);

    windows.emit({ type: 'window-closed', windowId: asWindowId('mac-window-42') });

    expect(adapter.session).toBeNull();
    expect(stopEvents(events)).toHaveLength(1);
    // Nothing arrives after the close, even if the poller ticks again.
    await adapter.drain();
    expect(frames).toHaveLength(1);
  });

  it('ignores the close of a window that is not the selected one', async () => {
    const { adapter, windows, events } = await createHarness();
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    windows.emit({ type: 'window-closed', windowId: asWindowId('mac-window-77') });

    expect(adapter.session).not.toBeNull();
    expect(stopEvents(events)).toHaveLength(0);
  });

  it('does not resume after a window loss', async () => {
    const { adapter, windows } = await createHarness();
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    windows.emit({ type: 'window-closed', windowId: asWindowId('mac-window-42') });
    windows.emit({ type: 'screen-unlocked' });
    await Promise.resolve();

    expect(adapter.session).toBeNull();
  });
});

describe('screen lock', () => {
  it('stops capture while the screen is locked', async () => {
    const { adapter, windows, events } = await createHarness();
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    windows.emit({ type: 'screen-locked' });

    expect(adapter.session).toBeNull();
    const stopped = stopEvents(events)[0];
    expect(stopped).toMatchObject({ type: 'capture-stopped', reason: 'screen-locked' });
    expect((stopped as { error: PilotError }).error.code).toBe('screen-locked');
  });

  it('resumes capture when the screen unlocks', async () => {
    const { adapter, windows, events } = await createHarness();
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);
    const first = adapter.session?.streamId;

    windows.emit({ type: 'screen-locked' });
    windows.emit({ type: 'screen-unlocked' });
    await waitFor(() => adapter.session !== null);

    expect(adapter.session).not.toBeNull();
    expect(adapter.session?.streamId).not.toBe(first);
    expect(events.filter((event) => event.type === 'capture-started')).toHaveLength(2);
  });

  it('stops when the helper itself reports the lock', async () => {
    const { adapter, events } = await createHarness({
      captureScript: [{ state: 'screen-locked', frame: null }],
    });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.drain();

    expect(stopEvents(events)[0]).toMatchObject({ reason: 'screen-locked' });
  });

  it('does not resume a stream that was never running', async () => {
    const { adapter, windows } = await createHarness();

    windows.emit({ type: 'screen-unlocked' });
    await Promise.resolve();

    expect(adapter.session).toBeNull();
  });
});

describe('stream failure', () => {
  it('reports a failed stream as capture-failed', async () => {
    const { adapter, events } = await createHarness({
      captureScript: [{ state: 'failed', frame: null, failure: 'SCStream stopped: -3801' }],
    });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await adapter.drain();

    const stopped = stopEvents(events)[0];
    expect((stopped as { error: PilotError }).error.code).toBe('capture-failed');
    expect((stopped as { error: PilotError }).error.details).toMatchObject({
      failure: 'SCStream stopped: -3801',
    });
  });

  it('re-establishes the stream when the helper has forgotten it', async () => {
    const { adapter } = await createHarness({
      captureScript: [{ state: 'stopped', frame: null }, { frame: {} }],
    });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);
    const first = adapter.session?.streamId;

    await adapter.drain();
    await waitFor(() => adapter.session !== null && adapter.session.streamId !== first);

    expect(adapter.session?.streamId).not.toBe(first);
    expect(adapter.metrics().streamRestarts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fresh capture
// ---------------------------------------------------------------------------

describe('captureFresh', () => {
  it('refuses when no stream is running', async () => {
    const { adapter } = await createHarness();

    await expect(adapter.captureFresh()).rejects.toMatchObject({ code: 'observation-disabled' });
  });

  it('returns a frame captured at or after the moment it was asked', async () => {
    const { adapter } = await createHarness();
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);
    const asked = Date.now();

    const frame = await adapter.captureFresh();

    expect(frame.capturedAt).toBeGreaterThanOrEqual(asked - 1);
    expect(frame.windowId).toBe(asWindowId('mac-window-42'));
    expect(adapter.metrics().freshCaptures).toBe(1);
  });

  it('skips frames the stream produced before the request', async () => {
    const { adapter } = await createHarness({
      captureScript: [
        { frame: { sequence: 1, ageMs: 500 } },
        { frame: { sequence: 2, ageMs: 400 } },
        { frame: { sequence: 3, ageMs: 0 } },
      ],
    });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    const frame = await adapter.captureFresh();

    // The frame id ends in the sequence number, so this is "the third frame",
    // not "one of the two the stream had already produced".
    expect(frame.frameId.endsWith('-3')).toBe(true);
    expect(adapter.metrics().framesDelivered).toBe(1);
  });

  it('also delivers the fresh frame to stream subscribers', async () => {
    const { adapter, frames } = await createHarness();
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    const fresh = await adapter.captureFresh();

    expect(frames).toContain(fresh);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const { adapter } = await createHarness();
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await expect(adapter.captureFresh(AbortSignal.abort())).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('aborts a capture that is waiting on the helper', async () => {
    const { adapter } = await createHarness({
      capturePullDelayMs: 5_000,
      captureScript: [{ frame: {} }],
    });
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    const controller = new AbortController();
    const pending = adapter.captureFresh(controller.signal);
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('gives up with a typed failure when no frame arrives in time', async () => {
    const { adapter } = await createHarness(
      { captureScript: [{ state: 'starting', frame: null }] },
      { freshCaptureTimeoutMs: 60 },
    );
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);

    await expect(adapter.captureFresh()).rejects.toMatchObject({ code: 'capture-failed' });
  });
});

/** Polls a predicate; the adapter's restarts are scheduled, not awaited. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
