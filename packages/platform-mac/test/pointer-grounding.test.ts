import { describe, expect, it } from 'vitest';
import type { AccessibilityGroundingTarget } from '@pilot/platform';
import {
  SECURE_FIELD_DISCLOSURE,
  groundPointer,
  sameGrounding,
  shouldHitTest,
  toAccessibilityNode,
  type AccessibilityElement,
} from '@pilot/platform-mac';
import {
  RETINA_GEOMETRY,
  SECONDARY_GEOMETRY,
  STUB_WINDOW_SAFARI,
  STUB_WINDOW_TEXTEDIT,
} from './support/harness.js';

/**
 * The pure grounding rules. No transport, no stub process — these are the
 * arithmetic and the three defences, exercised directly.
 */

const RETINA_TARGET: AccessibilityGroundingTarget = {
  geometry: RETINA_GEOMETRY,
  ownerPid: STUB_WINDOW_SAFARI.ownerPid,
};

const SECONDARY_TARGET: AccessibilityGroundingTarget = {
  geometry: SECONDARY_GEOMETRY,
  ownerPid: STUB_WINDOW_TEXTEDIT.ownerPid,
};

function element(overrides: Partial<AccessibilityElement> = {}): AccessibilityElement {
  return {
    role: 'AXButton',
    subrole: null,
    label: 'Auto Renew',
    value: null,
    bounds: { x: 700, y: 480, width: 60, height: 30 },
    isSecure: false,
    secureBasis: 'none',
    secureAncestorDepth: null,
    ownerPid: STUB_WINDOW_SAFARI.ownerPid,
    ...overrides,
  };
}

describe('normalised geometry', () => {
  it('normalises against the window frame, so a 2x display changes nothing', () => {
    // The Retina window is 1200x800 points at (100, 80) on a 2x display; its
    // capture is 2400x1600 pixels. The centre is the centre either way.
    const sample = groundPointer({
      at: 10,
      screenPoint: { x: 700, y: 480 },
      target: RETINA_TARGET,
      axTrusted: true,
    });
    expect(sample.pointer.normalizedPoint).toEqual({ x: 0.5, y: 0.5 });
    expect(sample.pointer.capturedPixelPoint).toEqual({ x: 1200, y: 800 });
    expect(RETINA_GEOMETRY.scaleFactor).toBe(2);
  });

  it('gives the same normalised point on a 1x display, and different pixels', () => {
    const sample = groundPointer({
      at: 10,
      screenPoint: { x: -1100, y: 440 },
      target: SECONDARY_TARGET,
      axTrusted: true,
    });
    // (−1100 − −1600) / 1000 and (440 − 40) / 700.
    expect(sample.pointer.normalizedPoint.x).toBeCloseTo(0.5, 12);
    expect(sample.pointer.normalizedPoint.y).toBeCloseTo(0.5714285714, 9);
    // 1x, so captured pixels equal points from the window origin.
    expect(sample.pointer.capturedPixelPoint?.x).toBeCloseTo(500, 9);
    expect(SECONDARY_GEOMETRY.scaleFactor).toBe(1);
  });

  it('handles a display with a negative origin without special-casing it', () => {
    const topLeft = groundPointer({
      at: 10,
      screenPoint: { x: SECONDARY_GEOMETRY.bounds.x, y: SECONDARY_GEOMETRY.bounds.y },
      target: SECONDARY_TARGET,
      axTrusted: true,
    });
    expect(topLeft.pointer.normalizedPoint).toEqual({ x: 0, y: 0 });
    expect(topLeft.grounding).toBe('pointer-in-window');
    expect(SECONDARY_GEOMETRY.bounds.x).toBeLessThan(0);
  });

  it('converts through captureSize, so a policy-downscaled capture still lines up', () => {
    const downscaled: AccessibilityGroundingTarget = {
      geometry: { ...RETINA_GEOMETRY, captureSize: { width: 1440, height: 960 } },
    };
    const sample = groundPointer({
      at: 10,
      screenPoint: { x: 700, y: 480 },
      target: downscaled,
      axTrusted: true,
    });
    expect(sample.pointer.normalizedPoint).toEqual({ x: 0.5, y: 0.5 });
    expect(sample.pointer.capturedPixelPoint).toEqual({ x: 720, y: 480 });
  });
});

describe('outside the selected window', () => {
  it('does not ask for a hit test at all', () => {
    expect(shouldHitTest({ x: 700, y: 480 }, RETINA_GEOMETRY)).toBe(true);
    // Left of the window, above it, and inside the *display* but not the window.
    expect(shouldHitTest({ x: 50, y: 480 }, RETINA_GEOMETRY)).toBe(false);
    expect(shouldHitTest({ x: 700, y: 10 }, RETINA_GEOMETRY)).toBe(false);
    // On the far display entirely.
    expect(shouldHitTest({ x: -1100, y: 440 }, RETINA_GEOMETRY)).toBe(false);
  });

  it('reports the PR-024 grounding and identifies nothing', () => {
    const sample = groundPointer({
      at: 10,
      screenPoint: { x: 50, y: 480 },
      target: RETINA_TARGET,
      axTrusted: true,
    });
    expect(sample.grounding).toBe('pointer-outside-window');
    expect(sample.target).toBeNull();
    expect(sample.targetOutcome).toBe('outside-window');
    expect(sample.pointer.accessibilityTarget).toBeUndefined();
    expect(sample.pointer.normalizedPoint.x).toBeLessThan(0);
  });

  it('discards an element supplied for an outside-window position', () => {
    // Defence 2. Reached only if the adapter's pre-check were bypassed; the
    // element is dropped rather than described.
    const sample = groundPointer({
      at: 10,
      screenPoint: { x: 50, y: 480 },
      target: RETINA_TARGET,
      element: element({ label: 'Secret from another window' }),
      elementOutcome: 'reported',
      axTrusted: true,
    });
    expect(sample.target).toBeNull();
    expect(sample.targetOutcome).toBe('outside-window');
    expect(JSON.stringify(sample)).not.toContain('Secret from another window');
  });

  it('treats the far edges as outside — the window is a closed unit interval', () => {
    const right = RETINA_GEOMETRY.bounds.x + RETINA_GEOMETRY.bounds.width;
    expect(shouldHitTest({ x: right, y: 480 }, RETINA_GEOMETRY)).toBe(true);
    expect(shouldHitTest({ x: right + 0.001, y: 480 }, RETINA_GEOMETRY)).toBe(false);
  });
});

describe('elements belonging to another application', () => {
  it('rejects an element whose owner is not the window owner', () => {
    const sample = groundPointer({
      at: 10,
      screenPoint: { x: 700, y: 480 },
      target: RETINA_TARGET,
      element: element({ ownerPid: 999, label: 'Message from Bob' }),
      elementOutcome: 'reported',
      axTrusted: true,
    });
    expect(sample.target).toBeNull();
    expect(sample.targetOutcome).toBe('foreign-application');
  });

  it('rejects an element whose frame shares no area with the window', () => {
    const sample = groundPointer({
      at: 10,
      screenPoint: { x: 700, y: 480 },
      target: RETINA_TARGET,
      element: element({ bounds: { x: -1500, y: 140, width: 100, height: 40 } }),
      elementOutcome: 'reported',
      axTrusted: true,
    });
    expect(sample.targetOutcome).toBe('foreign-application');
  });

  it('keeps an element whose owner the platform could not read', () => {
    // Conservative: an unreadable owner is not evidence of foreignness, and
    // dropping it would disable grounding on unusual accessibility trees.
    const sample = groundPointer({
      at: 10,
      screenPoint: { x: 700, y: 480 },
      target: RETINA_TARGET,
      element: element({ ownerPid: null }),
      elementOutcome: 'reported',
      axTrusted: true,
    });
    expect(sample.targetOutcome).toBe('reported');
  });
});

describe('secure fields', () => {
  const secure = element({
    role: 'AXTextField',
    subrole: 'AXSecureTextField',
    label: 'Password',
    value: 'hunter2',
    bounds: { x: 400, y: 300, width: 220, height: 24 },
    isSecure: true,
    secureBasis: 'subrole',
  });

  it('never carries a secure value, even when the wire supplies one', () => {
    const node = toAccessibilityNode(secure);
    expect(node.isSecure).toBe(true);
    expect(node.value).toBeUndefined();
    expect(node.label).toBe('Password');
  });

  it('keeps the value out of the grounded pointer too', () => {
    const sample = groundPointer({
      at: 10,
      screenPoint: { x: 500, y: 310 },
      target: RETINA_TARGET,
      element: secure,
      elementOutcome: 'reported',
      axTrusted: true,
    });
    expect(sample.target?.isSecure).toBe(true);
    expect(JSON.stringify(sample)).not.toContain('hunter2');
  });

  it('does not claim an unmarked field is safe', () => {
    // `isSecure: false` means "macOS did not mark this", not "no secret here".
    const plain = toAccessibilityNode(
      element({
        role: 'AXTextField',
        label: 'Recovery phrase',
        value: 'correct horse',
        secureBasis: 'none',
      }),
    );
    expect(plain.isSecure).toBe(false);
    expect(SECURE_FIELD_DISCLOSURE).toContain('best effort');
    expect(SECURE_FIELD_DISCLOSURE).toContain('outside recognised fields');
  });
});

describe('degraded accessibility', () => {
  it('keeps the position and names the reason there is no element', () => {
    const sample = groundPointer({
      at: 10,
      screenPoint: { x: 700, y: 480 },
      target: RETINA_TARGET,
      elementOutcome: 'not-trusted',
      axTrusted: false,
    });
    expect(sample.grounding).toBe('pointer-in-window');
    expect(sample.pointer.normalizedPoint).toEqual({ x: 0.5, y: 0.5 });
    expect(sample.target).toBeNull();
    expect(sample.targetOutcome).toBe('accessibility-denied');
    expect(sample.degraded).toBe(true);
  });

  it('separates "looked and found nothing" from "could not look"', () => {
    const empty = groundPointer({
      at: 10,
      screenPoint: { x: 700, y: 480 },
      target: RETINA_TARGET,
      elementOutcome: 'no-element',
      axTrusted: true,
    });
    const broken = groundPointer({
      at: 10,
      screenPoint: { x: 700, y: 480 },
      target: RETINA_TARGET,
      elementOutcome: 'query-failed',
      axTrusted: true,
    });
    expect(empty.targetOutcome).toBe('none');
    expect(empty.degraded).toBe(false);
    expect(broken.targetOutcome).toBe('unavailable');
  });
});

describe('sameGrounding', () => {
  const base = groundPointer({
    at: 10,
    screenPoint: { x: 700, y: 480 },
    target: RETINA_TARGET,
    element: element(),
    elementOutcome: 'reported',
    axTrusted: true,
  });

  it('ignores the timestamp', () => {
    const later = groundPointer({
      at: 999,
      screenPoint: { x: 700, y: 480 },
      target: RETINA_TARGET,
      element: element(),
      elementOutcome: 'reported',
      axTrusted: true,
    });
    expect(sameGrounding(base, later)).toBe(true);
  });

  it('notices a moved pointer and a changed target', () => {
    const moved = groundPointer({
      at: 10,
      screenPoint: { x: 701, y: 480 },
      target: RETINA_TARGET,
      element: element(),
      elementOutcome: 'reported',
      axTrusted: true,
    });
    const relabelled = groundPointer({
      at: 10,
      screenPoint: { x: 700, y: 480 },
      target: RETINA_TARGET,
      element: element({ label: 'Cancel' }),
      elementOutcome: 'reported',
      axTrusted: true,
    });
    expect(sameGrounding(base, moved)).toBe(false);
    expect(sameGrounding(base, relabelled)).toBe(false);
  });
});
