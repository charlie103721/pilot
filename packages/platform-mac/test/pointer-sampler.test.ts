import { afterEach, describe, expect, it } from 'vitest';
import { MVP_SCREEN_POLICY } from '@pilot/shared';
import type { AccessibilityGroundingTarget, PointerGroundingSample } from '@pilot/platform';
import {
  DEFAULT_POINTER_SAMPLE_INTERVAL_MS,
  MacAccessibilityAdapter,
  PointerSampler,
  groundPointer,
  type NativeHelperTransport,
  type PointerGroundingSource,
} from '@pilot/platform-mac';
import type { StubConfig } from './support/helper-stub.js';
import {
  RETINA_GEOMETRY,
  STUB_AX_BUTTON,
  STUB_AX_SECURE_FIELD,
  STUB_WINDOW_SAFARI,
  createStubTransport,
} from './support/harness.js';

/**
 * Pointer sampling at ~30 Hz with coalescing (system-design §17).
 *
 * Every test drives the sampler with `sampleOnce()` and a hand-cranked clock:
 * no wall-clock waiting, no fake timers, and the coalescing boundary asserted
 * at the exact millisecond rather than approached from either side.
 */

const TARGET: AccessibilityGroundingTarget = {
  geometry: RETINA_GEOMETRY,
  ownerPid: STUB_WINDOW_SAFARI.ownerPid,
};

/** A clock the test moves by hand. Nothing in the sampler reads any other. */
function manualClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

/** An in-process grounding source, so the sampler is tested without a transport. */
class ScriptedSource implements PointerGroundingSource {
  #point = { x: 730, y: 495 };
  #trusted = true;
  #failNext = false;
  calls = 0;

  async ground(target: AccessibilityGroundingTarget): Promise<PointerGroundingSample> {
    this.calls += 1;
    if (this.#failNext) {
      this.#failNext = false;
      throw new Error('helper went away');
    }
    return groundPointer({
      at: 0,
      screenPoint: this.#point,
      target,
      element: this.#trusted
        ? {
            role: 'AXButton',
            subrole: null,
            label: 'Auto Renew',
            value: null,
            bounds: STUB_AX_BUTTON.bounds,
            isSecure: false,
            secureBasis: 'none',
            secureAncestorDepth: null,
            ownerPid: STUB_WINDOW_SAFARI.ownerPid,
          }
        : null,
      elementOutcome: this.#trusted ? 'reported' : 'not-trusted',
      axTrusted: this.#trusted,
    });
  }

  moveTo(x: number, y: number): void {
    this.#point = { x, y };
  }

  denyAccessibility(): void {
    this.#trusted = false;
  }

  failOnce(): void {
    this.#failNext = true;
  }
}

describe('the sampling rate', () => {
  it('is the shared policy value, not a literal', () => {
    expect(MVP_SCREEN_POLICY.pointerSampleHz).toBe(30);
    expect(DEFAULT_POINTER_SAMPLE_INTERVAL_MS).toBeCloseTo(1000 / 30, 12);
  });
});

describe('coalescing', () => {
  it('emits at most one sample per bucket, at the boundary', async () => {
    const clock = manualClock(0);
    const source = new ScriptedSource();
    const sampler = new PointerSampler({
      source,
      target: () => TARGET,
      clock: clock.now,
      coalesceIntervalMs: 40,
    });

    // t = 0 → bucket 0. First sample of a bucket is emitted.
    expect(await sampler.sampleOnce()).not.toBeNull();

    // t = 39, still bucket 0, and the pointer has moved. Coalesced: the rate
    // bound applies to changes as well, which is what bounds the stream.
    clock.advance(39);
    source.moveTo(740, 500);
    expect(await sampler.sampleOnce()).toBeNull();

    // t = 40 → bucket 1. Emitted.
    clock.advance(1);
    const third = await sampler.sampleOnce();
    expect(third).not.toBeNull();
    expect(third?.pointer.screenPoint).toEqual({ x: 740, y: 500 });

    const metrics = sampler.metrics();
    expect(metrics.sampled).toBe(3);
    expect(metrics.emitted).toBe(2);
    expect(metrics.coalescedByInterval).toBe(1);
  });

  it('suppresses an identical sample in a new bucket', async () => {
    const clock = manualClock(0);
    const sampler = new PointerSampler({
      source: new ScriptedSource(),
      target: () => TARGET,
      clock: clock.now,
      coalesceIntervalMs: 40,
    });

    expect(await sampler.sampleOnce()).not.toBeNull();
    for (let tick = 0; tick < 5; tick += 1) {
      clock.advance(40);
      expect(await sampler.sampleOnce()).toBeNull();
    }
    const metrics = sampler.metrics();
    expect(metrics.emitted).toBe(1);
    expect(metrics.coalescedByEquality).toBe(5);
    expect(metrics.coalescedByInterval).toBe(0);
  });

  it('never coalesces away a change of target', async () => {
    const clock = manualClock(0);
    const source = new ScriptedSource();
    const sampler = new PointerSampler({
      source,
      target: () => TARGET,
      clock: clock.now,
      coalesceIntervalMs: 40,
    });

    await sampler.sampleOnce();
    clock.advance(40);
    // Same bucket cadence, different position: emitted.
    source.moveTo(500, 310);
    expect(await sampler.sampleOnce()).not.toBeNull();
    clock.advance(40);
    // Moved back. Equality is against the *last emitted* sample, so this is
    // news again, not a duplicate of the first one.
    source.moveTo(730, 495);
    expect(await sampler.sampleOnce()).not.toBeNull();
    expect(sampler.metrics().emitted).toBe(3);
  });

  it('emits the first sample after a reset even if nothing changed', async () => {
    const clock = manualClock(0);
    const sampler = new PointerSampler({
      source: new ScriptedSource(),
      target: () => TARGET,
      clock: clock.now,
      coalesceIntervalMs: 40,
    });

    await sampler.sampleOnce();
    clock.advance(40);
    expect(await sampler.sampleOnce()).toBeNull();
    sampler.reset();
    clock.advance(40);
    expect(await sampler.sampleOnce()).not.toBeNull();
  });
});

describe('what a tick does when it cannot sample', () => {
  it('skips when no window is selected', async () => {
    const clock = manualClock(0);
    const source = new ScriptedSource();
    const sampler = new PointerSampler({
      source,
      target: () => null,
      clock: clock.now,
    });
    expect(await sampler.sampleOnce()).toBeNull();
    expect(source.calls).toBe(0);
    expect(sampler.metrics().skippedNoTarget).toBe(1);
  });

  it('counts a failed tick and keeps going', async () => {
    const clock = manualClock(0);
    const source = new ScriptedSource();
    const sampler = new PointerSampler({
      source,
      target: () => TARGET,
      clock: clock.now,
      coalesceIntervalMs: 40,
    });

    source.failOnce();
    expect(await sampler.sampleOnce()).toBeNull();
    expect(sampler.metrics().failed).toBe(1);

    clock.advance(40);
    expect(await sampler.sampleOnce()).not.toBeNull();
  });
});

describe('what a sample carries', () => {
  it('counts outside-window and degraded samples separately', async () => {
    const clock = manualClock(0);
    const source = new ScriptedSource();
    const sampler = new PointerSampler({
      source,
      target: () => TARGET,
      clock: clock.now,
      coalesceIntervalMs: 40,
    });

    source.moveTo(50, 480);
    const outside = await sampler.sampleOnce();
    expect(outside?.grounding).toBe('pointer-outside-window');
    expect(outside?.target).toBeNull();

    clock.advance(40);
    source.moveTo(730, 495);
    source.denyAccessibility();
    const degraded = await sampler.sampleOnce();
    expect(degraded?.degraded).toBe(true);
    expect(degraded?.targetOutcome).toBe('accessibility-denied');

    const metrics = sampler.metrics();
    expect(metrics.outsideWindow).toBe(1);
    expect(metrics.degraded).toBe(1);
  });
});

describe('subscription lifecycle', () => {
  it('runs only while something is subscribed', () => {
    const sampler = new PointerSampler({
      source: new ScriptedSource(),
      target: () => TARGET,
      clock: manualClock().now,
    });
    expect(sampler.running).toBe(false);
    const first = sampler.subscribe(() => undefined);
    const second = sampler.subscribe(() => undefined);
    expect(sampler.running).toBe(true);
    first();
    expect(sampler.running).toBe(true);
    second();
    expect(sampler.running).toBe(false);
    // Releasing twice must not drive the count negative.
    second();
    expect(sampler.running).toBe(false);
    sampler.dispose();
  });

  it('delivers emitted samples to subscribers', async () => {
    const clock = manualClock(0);
    const source = new ScriptedSource();
    const sampler = new PointerSampler({
      source,
      target: () => TARGET,
      clock: clock.now,
      coalesceIntervalMs: 40,
      // A timer that never fires, so only `sampleOnce` drives the sampler.
      setTimer: (() => 0) as unknown as typeof setTimeout,
      clearTimer: (() => undefined) as unknown as typeof clearTimeout,
    });

    const seen: PointerGroundingSample[] = [];
    const off = sampler.subscribe((sample) => seen.push(sample));
    await sampler.sampleOnce();
    clock.advance(40);
    source.moveTo(500, 310);
    await sampler.sampleOnce();
    off();
    clock.advance(40);
    source.moveTo(600, 320);
    await sampler.sampleOnce();

    expect(seen).toHaveLength(2);
    expect(seen[1]?.pointer.screenPoint).toEqual({ x: 500, y: 310 });
    sampler.dispose();
  });
});

describe('over the real transport', () => {
  const transports: NativeHelperTransport[] = [];

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((transport) => transport.stop()));
  });

  async function start(stub: StubConfig): Promise<NativeHelperTransport> {
    const transport = createStubTransport(stub);
    transports.push(transport);
    await transport.start();
    return transport;
  }

  it('samples a scripted pointer path across the window border', async () => {
    const clock = manualClock(0);
    const transport = await start({
      // Inside on the button, inside on the password field, then outside.
      pointerScript: [
        { x: 730, y: 495 },
        { x: 500, y: 310 },
        { x: 50, y: 480 },
      ],
      axElements: [STUB_AX_BUTTON, STUB_AX_SECURE_FIELD],
    });
    const adapter = new MacAccessibilityAdapter({ transport, clock: clock.now });
    const sampler = new PointerSampler({
      source: adapter,
      target: () => TARGET,
      clock: clock.now,
      coalesceIntervalMs: 40,
    });

    const path: PointerGroundingSample[] = [];
    for (let tick = 0; tick < 3; tick += 1) {
      const sample = await sampler.sampleOnce();
      if (sample !== null) {
        path.push(sample);
      }
      clock.advance(40);
    }

    expect(path.map((sample) => sample.targetOutcome)).toEqual([
      'reported',
      'reported',
      'outside-window',
    ]);
    expect(path[0]?.target?.label).toBe('Auto Renew');
    expect(path[1]?.target?.isSecure).toBe(true);
    expect(path[1]?.target?.value).toBeUndefined();
    expect(path[2]?.grounding).toBe('pointer-outside-window');
    expect(sampler.metrics().outsideWindow).toBe(1);
  });
});
