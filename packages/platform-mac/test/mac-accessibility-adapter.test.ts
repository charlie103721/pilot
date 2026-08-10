import { afterEach, describe, expect, it } from 'vitest';
import { MacAccessibilityAdapter, type NativeHelperTransport } from '@pilot/platform-mac';
import type { AccessibilityGroundingTarget } from '@pilot/platform';
import type { StubConfig } from './support/helper-stub.js';
import {
  RETINA_GEOMETRY,
  SECONDARY_GEOMETRY,
  STUB_AX_BUTTON,
  STUB_AX_FOREIGN_ELEMENT,
  STUB_AX_SECONDARY_ELEMENT,
  STUB_AX_SECURE_FIELD,
  STUB_WINDOW_SAFARI,
  STUB_WINDOW_TEXTEDIT,
  createStubTransport,
} from './support/harness.js';

/**
 * The macOS accessibility adapter, end to end over the framed protocol against
 * the Node stub. Nothing here has ever spoken to the real Accessibility API —
 * see the README's "What is *not* verified anywhere".
 */

const transports: NativeHelperTransport[] = [];

async function start(stub: StubConfig): Promise<NativeHelperTransport> {
  const transport = createStubTransport(stub);
  transports.push(transport);
  await transport.start();
  return transport;
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.stop()));
});

const RETINA_TARGET: AccessibilityGroundingTarget = {
  geometry: RETINA_GEOMETRY,
  ownerPid: STUB_WINDOW_SAFARI.ownerPid,
};

const SECONDARY_TARGET: AccessibilityGroundingTarget = {
  geometry: SECONDARY_GEOMETRY,
  ownerPid: STUB_WINDOW_TEXTEDIT.ownerPid,
};

const ELEMENTS = [
  STUB_AX_BUTTON,
  STUB_AX_SECURE_FIELD,
  STUB_AX_FOREIGN_ELEMENT,
  STUB_AX_SECONDARY_ELEMENT,
];

/**
 * Records which operations the adapter actually sends.
 *
 * This is how "no hit test outside the window" is proved rather than asserted:
 * the check is on the wire, not on the shape of the answer.
 */
interface RecordedCall {
  readonly op: string;
  readonly payload: Record<string, unknown>;
}

function recordingTransport(transport: NativeHelperTransport): {
  readonly transport: NativeHelperTransport;
  readonly calls: RecordedCall[];
  readonly ops: () => string[];
} {
  const calls: RecordedCall[] = [];
  const facade = {
    request(operation: { name: string }, payload: unknown, options?: unknown) {
      calls.push({ op: operation.name, payload: payload as Record<string, unknown> });
      return (
        transport.request as unknown as (a: unknown, b: unknown, c: unknown) => Promise<unknown>
      ).call(transport, operation, payload, options);
    },
  };
  return {
    transport: facade as unknown as NativeHelperTransport,
    calls,
    ops: () => calls.map((call) => call.op),
  };
}

describe('the AccessibilityAdapter contract', () => {
  it('reads the pointer position', async () => {
    const transport = await start({ pointer: { x: 730, y: 495 } });
    const adapter = new MacAccessibilityAdapter({ transport, clock: () => 1 });
    expect(await adapter.getPointer()).toEqual({ x: 730, y: 495 });
  });

  it('resolves an element at an arbitrary point and reports a miss as null', async () => {
    const transport = await start({ axElements: ELEMENTS });
    const adapter = new MacAccessibilityAdapter({ transport, clock: () => 1 });
    expect((await adapter.elementAt({ x: 730, y: 495 }))?.label).toBe('Auto Renew');
    expect(await adapter.elementAt({ x: 0, y: 0 })).toBeNull();
  });

  it('reports availability, and degradation when accessibility is denied', async () => {
    const granted = new MacAccessibilityAdapter({
      transport: await start({ axElements: ELEMENTS }),
      clock: () => 1,
    });
    expect(await granted.availability()).toEqual({
      trusted: true,
      pointer: true,
      hitTesting: true,
      degraded: false,
    });

    const denied = new MacAccessibilityAdapter({
      transport: await start({ axTrusted: false }),
      clock: () => 1,
    });
    expect(await denied.availability()).toEqual({
      trusted: false,
      // The position needs no grant; that asymmetry is what degraded mode is.
      pointer: true,
      hitTesting: false,
      degraded: true,
    });
  });
});

describe('grounding a pointer against the selected window', () => {
  it('identifies the element under a pointer inside the window', async () => {
    const transport = await start({ pointer: { x: 730, y: 495 }, axElements: ELEMENTS });
    const adapter = new MacAccessibilityAdapter({ transport, clock: () => 42 });

    const sample = await adapter.ground(RETINA_TARGET);
    expect(sample.at).toBe(42);
    expect(sample.windowId).toBe(RETINA_GEOMETRY.windowId);
    expect(sample.grounding).toBe('pointer-in-window');
    expect(sample.targetOutcome).toBe('reported');
    expect(sample.target?.role).toBe('AXButton');
    expect(sample.target?.label).toBe('Auto Renew');
    expect(sample.pointer.normalizedPoint.x).toBeCloseTo(0.525, 12);
    expect(sample.pointer.capturedPixelPoint?.x).toBeCloseTo(1260, 9);
    expect(sample.pointer.capturedPixelPoint?.y).toBeCloseTo(830, 9);
    expect(sample.degraded).toBe(false);
  });

  it('grounds a window on a second, standard-DPI display with a negative origin', async () => {
    const transport = await start({ pointer: { x: -1400, y: 150 }, axElements: ELEMENTS });
    const adapter = new MacAccessibilityAdapter({ transport, clock: () => 1 });

    const sample = await adapter.ground(SECONDARY_TARGET);
    expect(sample.grounding).toBe('pointer-in-window');
    expect(sample.target?.label).toBe('Draft');
    expect(sample.pointer.normalizedPoint.x).toBeCloseTo(0.2, 12);
    expect(sample.pointer.capturedPixelPoint?.x).toBeCloseTo(200, 9);
  });

  it('identifies nothing when the pointer is outside the window', async () => {
    // The pointer sits over the *other* window, which really does have an
    // element under it — and it must not be described.
    const transport = await start({ pointer: { x: -1400, y: 150 }, axElements: ELEMENTS });
    const adapter = new MacAccessibilityAdapter({ transport, clock: () => 1 });

    const sample = await adapter.ground(RETINA_TARGET);
    expect(sample.grounding).toBe('pointer-outside-window');
    expect(sample.target).toBeNull();
    expect(sample.targetOutcome).toBe('outside-window');
    expect(JSON.stringify(sample)).not.toContain('Draft');
  });

  it('never asks the helper what is under an outside-window pointer', async () => {
    // The proof, at the wire: `accessibility.element-at` is never sent. The
    // stub answers `accessibility.sample` without an element, so if the adapter
    // did ask, the request would appear here.
    const { transport, calls, ops } = recordingTransport(
      await start({ pointer: { x: -1400, y: 150 }, axElements: ELEMENTS }),
    );
    const adapter = new MacAccessibilityAdapter({ transport, clock: () => 1 });

    await adapter.ground(RETINA_TARGET);
    expect(ops()).toEqual(['accessibility.sample']);
    expect(ops()).not.toContain('accessibility.element-at');

    // …and the same adapter does ask when the pointer is inside.
    calls.length = 0;
    await adapter.ground(SECONDARY_TARGET);
    expect(ops()).toEqual(['accessibility.sample', 'accessibility.element-at']);
  });

  it('drops an element belonging to a window stacked on top of the selected one', async () => {
    // (960, 540) is inside the Safari window, but the topmost element there
    // belongs to pid 999 — another application's floating surface.
    const transport = await start({ pointer: { x: 960, y: 540 }, axElements: ELEMENTS });
    const adapter = new MacAccessibilityAdapter({
      transport,
      clock: () => 1,
      // The stub scopes by pid the way `AXUIElementCreateApplication` does, so
      // turning the scoping off is what exposes the host-side defence.
      scopeToOwningApplication: false,
    });

    const sample = await adapter.ground(RETINA_TARGET);
    expect(sample.grounding).toBe('pointer-in-window');
    expect(sample.targetOutcome).toBe('foreign-application');
    expect(JSON.stringify(sample)).not.toContain('Message from Bob');
  });

  it('scopes the hit test to the owning application by default', async () => {
    const transport = await start({ pointer: { x: 960, y: 540 }, axElements: ELEMENTS });
    const adapter = new MacAccessibilityAdapter({ transport, clock: () => 1 });
    // Scoped, the foreign element is invisible to the query altogether.
    const sample = await adapter.ground(RETINA_TARGET);
    expect(sample.targetOutcome).toBe('none');
    expect(sample.target).toBeNull();
  });

  it('degrades to position only when accessibility is denied', async () => {
    const transport = await start({
      pointer: { x: 730, y: 495 },
      axElements: ELEMENTS,
      axTrusted: false,
    });
    const adapter = new MacAccessibilityAdapter({ transport, clock: () => 7 });

    const sample = await adapter.ground(RETINA_TARGET);
    expect(sample.grounding).toBe('pointer-in-window');
    expect(sample.pointer.normalizedPoint.x).toBeCloseTo(0.525, 12);
    expect(sample.target).toBeNull();
    expect(sample.targetOutcome).toBe('accessibility-denied');
    expect(sample.degraded).toBe(true);
    expect(adapter.lastTrusted).toBe(false);
  });

  it('reports a failed hit test as unavailable, not as an empty region', async () => {
    const transport = await start({
      pointer: { x: 730, y: 495 },
      axElements: ELEMENTS,
      axQueryFails: true,
    });
    const adapter = new MacAccessibilityAdapter({ transport, clock: () => 1 });
    expect((await adapter.ground(RETINA_TARGET)).targetOutcome).toBe('unavailable');
  });
});

describe('element values', () => {
  it('does not carry values unless the host opts in', async () => {
    const transport = await start({ pointer: { x: 730, y: 495 }, axElements: ELEMENTS });
    const off = new MacAccessibilityAdapter({ transport, clock: () => 1 });
    expect((await off.ground(RETINA_TARGET)).target?.value).toBeUndefined();

    const on = new MacAccessibilityAdapter({
      transport,
      clock: () => 1,
      includeElementValues: true,
    });
    expect((await on.ground(RETINA_TARGET)).target?.value).toBe('on');
  });

  it('never carries a secure field value, even with values opted in', async () => {
    const transport = await start({ pointer: { x: 500, y: 310 }, axElements: ELEMENTS });
    const adapter = new MacAccessibilityAdapter({
      transport,
      clock: () => 1,
      includeElementValues: true,
    });

    const sample = await adapter.ground(RETINA_TARGET);
    expect(sample.target?.isSecure).toBe(true);
    expect(sample.target?.label).toBe('Password');
    expect(sample.target?.value).toBeUndefined();
    expect(JSON.stringify(sample)).not.toContain('hunter2');
  });
});

describe('groundFast', () => {
  it('answers in one round trip', async () => {
    const { transport, calls, ops } = recordingTransport(
      await start({ pointer: { x: 730, y: 495 }, axElements: ELEMENTS }),
    );
    const adapter = new MacAccessibilityAdapter({ transport, clock: () => 5 });

    const sample = await adapter.groundFast(RETINA_TARGET);
    expect(ops()).toEqual(['accessibility.sample']);
    expect(calls[0]?.payload.includeElement).toBe(true);
    expect(sample.target?.label).toBe('Auto Renew');
    expect(sample.at).toBe(5);
  });

  it('still refuses to describe anything outside the window', async () => {
    const transport = await start({ pointer: { x: -1400, y: 150 }, axElements: ELEMENTS });
    const adapter = new MacAccessibilityAdapter({ transport, clock: () => 1 });
    const sample = await adapter.groundFast(RETINA_TARGET);
    expect(sample.grounding).toBe('pointer-outside-window');
    expect(sample.target).toBeNull();
    expect(JSON.stringify(sample)).not.toContain('Draft');
  });

  it('stops hit-testing once the pointer is known to be outside, and resumes on re-entry', async () => {
    const { transport, calls, ops } = recordingTransport(
      await start({
        pointerScript: [
          { x: 730, y: 495 }, // inside
          { x: 50, y: 480 }, // outside
          { x: 50, y: 481 }, // still outside
          { x: 730, y: 495 }, // back inside
        ],
        axElements: ELEMENTS,
      }),
    );
    const adapter = new MacAccessibilityAdapter({ transport, clock: () => 1 });

    // 1. Inside: one request, hit test included.
    expect((await adapter.groundFast(RETINA_TARGET)).targetOutcome).toBe('reported');
    expect(ops()).toEqual(['accessibility.sample']);
    expect(calls[0]?.payload.includeElement).toBe(true);

    // 2. Crossing out: one request. The element that came back is discarded.
    calls.length = 0;
    expect((await adapter.groundFast(RETINA_TARGET)).targetOutcome).toBe('outside-window');
    expect(ops()).toEqual(['accessibility.sample']);

    // 3. Still outside: one request, and the helper is told not to hit-test.
    calls.length = 0;
    expect((await adapter.groundFast(RETINA_TARGET)).targetOutcome).toBe('outside-window');
    expect(ops()).toEqual(['accessibility.sample']);
    expect(calls[0]?.payload.includeElement).toBe(false);

    // 4. Back inside: the follow-up hit test, once.
    calls.length = 0;
    expect((await adapter.groundFast(RETINA_TARGET)).targetOutcome).toBe('reported');
    expect(ops()).toEqual(['accessibility.sample', 'accessibility.element-at']);
  });
});
