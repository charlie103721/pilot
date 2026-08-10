import { afterEach, describe, expect, it } from 'vitest';
import { asFrameId, asWindowId, type CapturedFrame } from '@pilot/shared';
import { FrameRing, ObservationCore, systemClock } from '@pilot/observation';
import { MacObservationAdapter, type NativeHelperTransport } from '@pilot/platform-mac';
import { createStubTransport } from './support/harness.js';
import { CAPTURE_OPTIONS, captureWindow } from './support/capture-harness.js';
import type { StubConfig } from './support/helper-stub.js';

/**
 * The six requirements PR-004's `FrameRing` places on whatever produces frames.
 *
 * They are asserted here against the **real ring**, not a restatement of it:
 * the adapter's frames are fed through `ObservationCore.ingestFrame` exactly as
 * the observation session will feed them, and the ring's own rejection
 * counters are the assertion. Violating any of these silently breaks
 * observation — every one of them produces *silence*, not an error — so each
 * gets a test that fails loudly if the guarantee slips.
 */

const transports: NativeHelperTransport[] = [];
const adapters: MacObservationAdapter[] = [];

async function startCapture(stub: StubConfig = {}): Promise<MacObservationAdapter> {
  const transport = createStubTransport(stub);
  transports.push(transport);
  await transport.start();
  const adapter = new MacObservationAdapter({ transport, pollIntervalMs: 60_000 });
  adapters.push(adapter);
  await adapter.start(captureWindow(), CAPTURE_OPTIONS);
  return adapter;
}

/** The adapter wired to a real observation core, as PR-028 will wire it. */
async function startIngesting(
  stub: StubConfig = {},
): Promise<{ adapter: MacObservationAdapter; core: ObservationCore }> {
  const adapter = await startCapture(stub);
  const core = new ObservationCore({ clock: systemClock });
  core.selectWindow(captureWindow());
  core.attach(adapter);
  return { adapter, core };
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    adapter.dispose();
  }
  for (const transport of transports.splice(0)) {
    await transport.stop();
  }
});

describe('1. capturedAt is on the system clock base', () => {
  it('is admitted by the ring rather than rejected as stale', async () => {
    const { adapter, core } = await startIngesting();

    await adapter.drain();
    await adapter.drain();

    expect(core.frames.stats().frameCount).toBe(2);
    expect(core.frames.metrics().rejected.stale).toBe(0);
  });

  it('repairs a helper timestamp that is not on the epoch base', async () => {
    // A mach absolute or CoreMedia presentation timestamp looks like this:
    // milliseconds since boot, not since 1970. Left alone, every frame is
    // hours "old" and the ring rejects the lot as stale — silently.
    const machLike = 4_512_000;
    const { adapter, core } = await startIngesting({
      captureScript: [{ frame: { capturedAt: machLike } }],
    });

    await adapter.drain();

    expect(core.frames.stats().frameCount).toBe(1);
    expect(core.frames.metrics().rejected.stale).toBe(0);
    expect(adapter.metrics().dropped['clock-skew']).toBe(1);
  });

  it('demonstrates what the unrepaired timestamp would have cost', async () => {
    const ring = new FrameRing({ clock: systemClock });
    const machLike: CapturedFrame = {
      frameId: asFrameId('frame-mach'),
      windowId: asWindowId('mac-window-42'),
      capturedAt: 4_512_000,
      size: { width: 1440, height: 960 },
      scaleFactor: 1.2,
      encoding: 'jpeg',
      bytes: new Uint8Array(64).fill(1),
    };

    const admission = ring.push(machLike);

    expect(admission.admitted).toBe(false);
    expect(admission.admitted ? null : admission.reason).toBe('stale');
  });
});

describe('2. byteLength reflects the real retained cost', () => {
  it('matches what the ring accounts for, and owns its whole ArrayBuffer', async () => {
    const { adapter, core } = await startIngesting({ captureFrameBytes: 4_096 });

    await adapter.drain();
    await adapter.drain();
    await adapter.drain();

    const records = core.frames.records();
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.byteLength).toBe(record.frame.bytes.byteLength);
      expect(record.byteLength).toBe(4_096);
      // The decisive part: no view onto a larger buffer, so the ring's byte
      // bound governs the memory that is actually retained.
      expect(record.frame.bytes.byteOffset).toBe(0);
      expect(record.frame.bytes.buffer.byteLength).toBe(record.frame.bytes.byteLength);
    }
    expect(core.frames.stats().byteCount).toBe(3 * 4_096);
  });

  it('refuses a frame larger than the buffer that would hold it', async () => {
    const adapter = await startCapture({ captureScript: [{ frame: { bytes: 4_096 } }] });
    const frames: CapturedFrame[] = [];
    adapter.subscribe((frame) => frames.push(frame));
    const ring = new FrameRing({ clock: systemClock, maxBytes: 1_024 });

    await adapter.drain();
    const admission = ring.push(frames[0]!);

    expect(admission.admitted).toBe(false);
    expect(admission.admitted ? null : admission.reason).toBe('too-large');
  });
});

describe('3. frameId is unique per capture', () => {
  it('never repeats across a long run', async () => {
    const { adapter, core } = await startIngesting();
    const seen = new Set<string>();
    adapter.subscribe((frame) => seen.add(frame.frameId));

    for (let tick = 0; tick < 12; tick += 1) {
      await adapter.drain();
    }

    expect(seen.size).toBe(12);
    expect(core.frames.metrics().rejected.duplicate).toBe(0);
  });

  it('is unique across a stream restart, when the helper re-mints its stream id', async () => {
    const adapter = await startCapture();
    const first = adapter.session?.streamId;
    const ids = new Set<string>();
    adapter.subscribe((frame) => ids.add(frame.frameId));

    await adapter.drain();
    // Restarting mints a new stream id, so sequence 1 of the new stream cannot
    // collide with sequence 1 of the old one.
    await adapter.start(captureWindow(), CAPTURE_OPTIONS);
    await adapter.drain();

    expect(adapter.session?.streamId).not.toBe(first);
    expect(ids.size).toBe(2);
  });
});

describe('4. windowId matches the selected window exactly', () => {
  it('is the branded id PR-011 defines, so ingest is not rejected as foreign', async () => {
    const { adapter, core } = await startIngesting();

    await adapter.drain();

    const record = core.frames.newest();
    expect(record?.frame.windowId).toBe(asWindowId('mac-window-42'));
    expect(record?.frame.windowId).toBe(core.scene?.windowId);
  });

  it('shows what a re-keyed id would cost: silence, not an error', async () => {
    const core = new ObservationCore({ clock: systemClock });
    core.selectWindow(captureWindow());

    const rekeyed: CapturedFrame = {
      frameId: asFrameId('frame-rekeyed'),
      // Anything but `mac-window-<CGWindowID>` — a session nonce, an index, a
      // counter — lands here and stops all ingest without raising anything.
      windowId: asWindowId('mac-window-42-session-3'),
      capturedAt: Date.now(),
      size: { width: 1440, height: 960 },
      scaleFactor: 1.2,
      encoding: 'jpeg',
      bytes: new Uint8Array(64).fill(1),
    };

    const result = core.ingestFrame(rekeyed);

    expect(result.admitted).toBe(false);
    expect(result.admitted ? null : result.reason).toBe('foreign-window');
  });

  it('never emits a frame from another window', async () => {
    const { adapter, core } = await startIngesting({
      captureScript: [{ frame: { windowNumber: 77 } }, { frame: {} }],
    });

    await adapter.drain();
    await adapter.drain();

    expect(core.frames.stats().frameCount).toBe(1);
    // Dropped in the adapter, so the core never even sees it.
    expect(core.frames.metrics().rejected).toMatchObject({ duplicate: 0, 'empty-bytes': 0 });
    expect(adapter.metrics().dropped['foreign-window']).toBe(1);
  });
});

describe('5. a zero-length frame is never emitted', () => {
  it('drops the empty frame in the adapter, so the ring never counts a rejection', async () => {
    const { adapter, core } = await startIngesting({
      captureScript: [{ frame: { bytes: 0 } }, { frame: { bytes: 128 } }],
    });

    await adapter.drain();
    await adapter.drain();

    expect(core.frames.stats().frameCount).toBe(1);
    expect(core.frames.metrics().rejected['empty-bytes']).toBe(0);
    expect(adapter.metrics().dropped['empty-bytes']).toBe(1);
  });

  it('every frame that does reach a subscriber carries bytes', async () => {
    const adapter = await startCapture({
      captureScript: [
        { frame: { bytes: 0 } },
        { frame: { bytes: 1 } },
        { frame: { bytes: 0 } },
        { frame: { bytes: 2_048 } },
      ],
    });
    const frames: CapturedFrame[] = [];
    adapter.subscribe((frame) => frames.push(frame));

    for (let tick = 0; tick < 4; tick += 1) {
      await adapter.drain();
    }

    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame.bytes.byteLength).toBeGreaterThan(0);
    }
  });
});

describe('6. frames are retained by reference and never recycled', () => {
  it('gives each frame its own buffer, and later frames do not disturb earlier ones', async () => {
    const adapter = await startCapture({ captureFrameBytes: 256 });
    const frames: CapturedFrame[] = [];
    adapter.subscribe((frame) => frames.push(frame));

    await adapter.drain();
    const firstSnapshot = Uint8Array.from(frames[0]!.bytes);

    for (let tick = 0; tick < 5; tick += 1) {
      await adapter.drain();
    }

    expect(frames).toHaveLength(6);
    // Distinct backing stores…
    const buffers = new Set(frames.map((frame) => frame.bytes.buffer));
    expect(buffers.size).toBe(6);
    // …and the first frame's pixels are byte-for-byte what they were before
    // five more frames arrived.
    expect([...frames[0]!.bytes]).toEqual([...firstSnapshot]);
  });

  it('holds the same object the ring holds — no copy on ingest', async () => {
    const { adapter, core } = await startIngesting();
    const frames: CapturedFrame[] = [];
    adapter.subscribe((frame) => frames.push(frame));

    await adapter.drain();

    expect(core.frames.newest()?.frame).toBe(frames[0]);
    expect(core.frames.newest()?.frame.bytes).toBe(frames[0]!.bytes);
  });
});
