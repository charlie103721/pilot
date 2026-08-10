import {
  screenRectToNormalizedRect,
  type AccessibilityNode,
  type AccessibilityNodeSummary,
  type NormalizedRect,
  type WindowGeometry,
} from '@pilot/shared';
import { SCREEN_REDACTION_CAVEAT, type ScreenContextPolicy } from './screen-policy.js';

/**
 * Secure-content rules (system-design §10 step 4, §14).
 *
 * > Redact known secure accessibility fields.
 *
 * > Accessibility-based redaction is best effort. Password fields can be masked
 * > when identified, but the product must warn that screenshots can still
 * > contain secrets outside recognized fields.
 *
 * What this module guarantees, exactly
 * ------------------------------------
 * 1. A field the platform reports as `isSecure` never has its **value**
 *    forwarded — not in the observation metadata, not in the pointer target
 *    summary, not in a log. That part is absolute.
 * 2. A secure field whose **bounds** the platform reported is added to the mask
 *    list handed to the image pipeline (PR-018). That part is only as good as
 *    the accessibility tree.
 * 3. A secure field the platform reported *without* bounds cannot be masked. It
 *    is counted as `unmaskableRegions`, and under
 *    `secureContent.requireMaskableBounds` the observation is refused rather
 *    than shipped with a redaction claim it does not meet.
 *
 * What it does **not** guarantee: that the image contains no secrets. Anything
 * the accessibility tree does not mark — a secret in a plain text field, a
 * token in a terminal, a recovery code rendered as a picture, a notification
 * banner from another app overlapping the window — passes through untouched.
 * Every allowed decision therefore carries {@link SCREEN_REDACTION_CAVEAT}
 * whether or not a single pixel was masked, so no caller can read "redaction
 * applied" as "safe".
 */

export type SecureRegionSource =
  /** The accessibility element under the grounded pointer. */
  | 'pointer-target'
  /** A secure field found by scanning the window's accessibility tree. */
  | 'accessibility-scan'
  /** Supplied by the caller for another reason (a test, a manual rule). */
  | 'caller';

/**
 * A region the platform says holds secure content. `normalizedBounds` is
 * optional on purpose: macOS reports a secure text field whose frame it cannot
 * resolve often enough that pretending otherwise would hide the failure.
 */
export interface SecureRegion {
  readonly source: SecureRegionSource;
  readonly label?: string;
  readonly normalizedBounds?: NormalizedRect;
}

/** A region the image pipeline must paint over, in normalised window space. */
export interface RedactionMask {
  readonly normalizedBounds: NormalizedRect;
  readonly source: SecureRegionSource;
  readonly label: string | null;
}

/** What redaction actually did, in terms a caller may repeat to a user. */
export interface RedactionReport {
  readonly mode: ScreenContextPolicy['secureContent']['onSecureTarget'];
  /** Never anything stronger than this. */
  readonly guarantee: 'best-effort';
  readonly maskedRegions: number;
  /** Secure regions with no bounds to mask. */
  readonly unmaskableRegions: number;
  /** Values withheld from the observation metadata. */
  readonly withheldValues: number;
  /** True: only fields the accessibility tree marks secure are recognised. */
  readonly recognizedFieldsOnly: true;
  readonly caveat: string;
}

export type RedactionRejection = 'secure-content-refused' | 'unmaskable-secure-region';

export type RedactionPlan =
  | {
      readonly allowed: true;
      readonly masks: readonly RedactionMask[];
      readonly report: RedactionReport;
    }
  | {
      readonly allowed: false;
      readonly rule: RedactionRejection;
      readonly detail: string;
      readonly report: RedactionReport;
    };

export interface RedactionInput {
  /** The accessibility element under the grounded pointer, when there is one. */
  readonly pointerTarget?: AccessibilityNode;
  /** Further secure regions, e.g. from an accessibility scan (PR-013). */
  readonly secureRegions?: readonly SecureRegion[];
  /** Needed to convert screen-point bounds into normalised window space. */
  readonly geometry: WindowGeometry | null;
}

/**
 * Window-relative summary of the pointer target, safe to send to a model.
 *
 * A secure field keeps its role, its label and its bounds — the model needs to
 * know it is looking at a password box — and loses its value unconditionally.
 */
export function toSafeTargetSummary(
  node: AccessibilityNode,
  geometry: WindowGeometry | null,
): AccessibilityNodeSummary {
  const bounds =
    node.bounds === undefined || geometry === null
      ? undefined
      : screenRectToNormalizedRect(node.bounds, geometry);
  return {
    ...(node.role === undefined ? {} : { role: node.role }),
    ...(node.label === undefined ? {} : { label: node.label }),
    ...(node.isSecure || node.value === undefined ? {} : { value: node.value }),
    ...(bounds === undefined ? {} : { normalizedBounds: bounds }),
    isSecure: node.isSecure,
  };
}

/** Turns a secure accessibility node into a region, if it is secure at all. */
export function secureRegionFromNode(
  node: AccessibilityNode,
  geometry: WindowGeometry | null,
  source: SecureRegionSource = 'pointer-target',
): SecureRegion | null {
  if (!node.isSecure) {
    return null;
  }
  const bounds =
    node.bounds === undefined || geometry === null
      ? undefined
      : screenRectToNormalizedRect(node.bounds, geometry);
  return {
    source,
    ...(node.label === undefined ? {} : { label: node.label }),
    ...(bounds === undefined ? {} : { normalizedBounds: bounds }),
  };
}

function report(
  policy: ScreenContextPolicy,
  masked: number,
  unmaskable: number,
  withheld: number,
): RedactionReport {
  return {
    mode: policy.secureContent.onSecureTarget,
    guarantee: 'best-effort',
    maskedRegions: masked,
    unmaskableRegions: unmaskable,
    withheldValues: withheld,
    recognizedFieldsOnly: true,
    caveat: SCREEN_REDACTION_CAVEAT,
  };
}

/**
 * Step 4 of the §10 execution order, as a pure function: no clock, no state, no
 * pixels. It decides what to mask and whether the observation may proceed; the
 * masking itself is PR-018's.
 */
export function planRedaction(policy: ScreenContextPolicy, input: RedactionInput): RedactionPlan {
  const regions: SecureRegion[] = [];
  let withheld = 0;

  const target = input.pointerTarget;
  if (target !== undefined && target.isSecure) {
    withheld += target.value === undefined ? 0 : 1;
    const region = secureRegionFromNode(target, input.geometry);
    if (region !== null) {
      regions.push(region);
    }
  }
  for (const region of input.secureRegions ?? []) {
    regions.push(region);
  }

  const masks: RedactionMask[] = [];
  let unmaskable = 0;
  for (const region of regions) {
    const bounds = region.normalizedBounds;
    if (bounds === undefined) {
      unmaskable += 1;
      continue;
    }
    masks.push({
      normalizedBounds: bounds,
      source: region.source,
      label: region.label ?? null,
    });
  }

  const summary = report(policy, masks.length, unmaskable, withheld);

  if (regions.length > 0 && policy.secureContent.onSecureTarget === 'reject') {
    return {
      allowed: false,
      rule: 'secure-content-refused',
      detail: `Policy refuses observations containing secure fields (${String(regions.length)} in view)`,
      report: summary,
    };
  }
  if (unmaskable > 0 && policy.secureContent.requireMaskableBounds) {
    return {
      allowed: false,
      rule: 'unmaskable-secure-region',
      detail: `${String(unmaskable)} secure field(s) reported without bounds; they cannot be masked`,
      report: summary,
    };
  }
  return { allowed: true, masks, report: summary };
}
