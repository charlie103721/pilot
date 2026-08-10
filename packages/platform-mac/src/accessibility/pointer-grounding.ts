import {
  buildGroundedPointer,
  isInsideWindow,
  screenToNormalized,
  type AccessibilityNode,
  type ScreenPoint,
  type ScreenRect,
  type WindowGeometry,
} from '@pilot/shared';
import type {
  AccessibilityGroundingTarget,
  AccessibilityTargetOutcome,
  PointerGroundingSample,
} from '@pilot/platform';
import type { AccessibilityElement, ElementOutcome } from '../protocol/accessibility-ops.js';

/**
 * Turning a raw pointer reading into a grounded sample. Pure, total, and the
 * only place the three grounding rules are written down.
 *
 * ## 1. Coordinates convert in exactly one place
 *
 * system-design §5: "conversion between display-independent screen coordinates
 * and captured pixels happens in one geometry module, not in UI or prompt
 * code". That module is `@pilot/shared/geometry`, and this file calls it rather
 * than doing its own arithmetic — there is not a single division by a width in
 * here. PR-004's frame ring and PR-024's question envelope both consume the
 * result, so an inconsistent second implementation would put a pointer crop and
 * a spoken answer in different places on the same screen.
 *
 * Two consequences worth stating, because they are the ones people expect to be
 * special cases and are not:
 *
 * - **Retina.** Normalisation is a fraction of the window frame, and window
 *   frames are in display-independent *points*. A 2× display therefore changes
 *   nothing about the normalised pointer. It changes `capturedPixelPoint`, which
 *   `screenToCapturedPixel` derives from `captureSize` — not from
 *   `scaleFactor`, so a capture the screen policy has downscaled converts
 *   correctly too.
 * - **Multiple displays.** Screen points are global desktop coordinates, and a
 *   display placed left of or above the primary has a negative origin. Window
 *   bounds live in that same space, so `(point − bounds.origin) / bounds.size`
 *   is already display-agnostic: the pointer at the top-left corner of a window
 *   on a secondary display at `x = −1920` normalises to `0, 0` like any other.
 *
 * ## 2. Outside the window, nothing is identified
 *
 * PR-024 fixed the contract (`grounding: 'pointer-outside-window'`, note: "the
 * pointer was not over the selected window; no element was identified"). The
 * reason is a leak, not tidiness: whatever sits under a pointer outside the
 * selected window belongs to a window Pilot is not observing and has no
 * permission to describe. Three independent things enforce it:
 *
 * 1. {@link shouldHitTest} — the adapter does not ask the helper at all.
 * 2. {@link groundPointer} — an element supplied anyway is discarded here.
 * 3. `buildGroundedPointer` is called without a target, so `GroundedPointer`
 *    itself cannot carry one.
 *
 * ## 3. An element from another application is not this window's element
 *
 * A point inside the selected window's frame can still be covered by a floating
 * palette, a notification or another app's window. The helper scopes its hit
 * test by `ownerPid` where it can; this module rejects the answer as well when
 * the element names a different owner, so a mistake in the native scoping
 * degrades to "no target" rather than to a leak.
 */

/**
 * Whether a hit test should be issued at all.
 *
 * Exported because it is the first of the three defences and the adapter has to
 * make the same decision *before* the round trip, not after it.
 */
export function shouldHitTest(point: ScreenPoint, geometry: WindowGeometry): boolean {
  return isInsideWindow(screenToNormalized(point, geometry));
}

export interface GroundPointerInput {
  /** Injected-clock reading for the sample. */
  readonly at: number;
  readonly screenPoint: ScreenPoint;
  readonly target: AccessibilityGroundingTarget;
  /** Element the helper reported, if a hit test ran. */
  readonly element?: AccessibilityElement | null;
  /** What the hit test did. `not-requested` when none was issued. */
  readonly elementOutcome?: ElementOutcome;
  /** `AXIsProcessTrusted()` as the helper observed it. */
  readonly axTrusted: boolean;
}

export function groundPointer(input: GroundPointerInput): PointerGroundingSample {
  const geometry = input.target.geometry;
  const inside = shouldHitTest(input.screenPoint, geometry);

  if (!inside) {
    // Defence 2. Reached only if defence 1 was bypassed — a caller passing a
    // stale element, or a helper answering an operation it was not asked. The
    // element is dropped rather than trusted.
    return {
      at: input.at,
      windowId: geometry.windowId,
      grounding: 'pointer-outside-window',
      pointer: buildGroundedPointer(input.screenPoint, geometry),
      target: null,
      targetOutcome: 'outside-window',
      degraded: !input.axTrusted,
    };
  }

  const resolved = resolveTarget(input, geometry);
  return {
    at: input.at,
    windowId: geometry.windowId,
    grounding: 'pointer-in-window',
    pointer:
      resolved.node === null
        ? buildGroundedPointer(input.screenPoint, geometry)
        : buildGroundedPointer(input.screenPoint, geometry, resolved.node),
    target: resolved.node,
    targetOutcome: resolved.outcome,
    degraded: !input.axTrusted,
  };
}

interface ResolvedTarget {
  readonly node: AccessibilityNode | null;
  readonly outcome: AccessibilityTargetOutcome;
}

function resolveTarget(input: GroundPointerInput, geometry: WindowGeometry): ResolvedTarget {
  const outcome = input.elementOutcome ?? 'not-requested';
  if (outcome === 'not-requested') {
    return { node: null, outcome: 'not-requested' };
  }
  if (!input.axTrusted || outcome === 'not-trusted') {
    // Degraded mode (system-design §16): the position stands, the element does
    // not exist, and the difference is reported rather than implied.
    return { node: null, outcome: 'accessibility-denied' };
  }
  if (outcome === 'query-failed') {
    return { node: null, outcome: 'unavailable' };
  }
  const element = input.element ?? null;
  if (element === null || outcome === 'no-element') {
    return { node: null, outcome: 'none' };
  }
  if (isForeign(element, input.target, geometry)) {
    return { node: null, outcome: 'foreign-application' };
  }
  return { node: toAccessibilityNode(element), outcome: 'reported' };
}

/**
 * True when the element cannot be part of the selected window.
 *
 * Two cheap checks, both conservative — an inconclusive answer is *not* treated
 * as foreign, because dropping every element whose owner the helper could not
 * read would silently disable grounding on applications with an unusual
 * accessibility tree.
 */
function isForeign(
  element: AccessibilityElement,
  target: AccessibilityGroundingTarget,
  geometry: WindowGeometry,
): boolean {
  if (
    target.ownerPid !== undefined &&
    element.ownerPid !== null &&
    element.ownerPid !== target.ownerPid
  ) {
    return true;
  }
  // An element that shares no area at all with the window is not in it,
  // whatever the hit test claimed. Kept local and private rather than added to
  // the shared geometry module: this is a predicate, not a coordinate
  // conversion, and a second lane adding a helper of the same name to a shared
  // file is a merge hazard the runbook already recorded (cross-lane issue 5).
  return element.bounds !== null && !rectsOverlap(element.bounds, geometry.bounds);
}

function rectsOverlap(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Wire element → domain node.
 *
 * `value` is dropped whenever the element is secure. That is belt and braces:
 * the helper already refuses to read `AXValue` for a secure element, and
 * `buildGroundedPointer` drops it a third time. Three places, because the cost
 * of the redundancy is nothing and the cost of the leak is a password in a
 * model transcript.
 */
export function toAccessibilityNode(element: AccessibilityElement): AccessibilityNode {
  const value = element.isSecure ? null : element.value;
  return {
    ...(element.role === null ? {} : { role: element.role }),
    ...(element.subrole === null ? {} : { subrole: element.subrole }),
    ...(element.label === null ? {} : { label: element.label }),
    ...(value === null ? {} : { value }),
    ...(element.bounds === null ? {} : { bounds: element.bounds }),
    isSecure: element.isSecure,
  };
}

/**
 * What the secure-field flag does and does not promise, in one sentence.
 *
 * Exported so the disclosure the product must show (system-design §14) is
 * written once and quoted rather than paraphrased. PR-018 redacts on
 * `isSecure`; this is the text that keeps the redaction from being mistaken for
 * a guarantee.
 */
export const SECURE_FIELD_DISCLOSURE =
  'Secure-field detection is best effort: Pilot recognises fields macOS marks as secure. ' +
  'Screenshots and window contents can still contain secrets outside recognised fields.';

/** True when two samples describe the same position and the same target. */
export function sameGrounding(a: PointerGroundingSample, b: PointerGroundingSample): boolean {
  return (
    a.windowId === b.windowId &&
    a.grounding === b.grounding &&
    a.targetOutcome === b.targetOutcome &&
    a.degraded === b.degraded &&
    a.pointer.screenPoint.x === b.pointer.screenPoint.x &&
    a.pointer.screenPoint.y === b.pointer.screenPoint.y &&
    targetIdentity(a.target) === targetIdentity(b.target)
  );
}

function targetIdentity(target: AccessibilityNode | null): string {
  if (target === null) {
    return '';
  }
  const bounds = target.bounds;
  return [
    target.role ?? '',
    target.subrole ?? '',
    target.label ?? '',
    target.isSecure ? '1' : '0',
    bounds === undefined ? '' : `${String(bounds.x)},${String(bounds.y)}`,
  ].join(' ');
}
