import { z } from 'zod';
import { defineHelperOperation } from './operation-kit.js';
import { nativeRectSchema } from './window-ops.js';

/**
 * Pointer and Accessibility operations (PR-013).
 *
 * Appended to the closed operation set exactly as PR-011 appended the
 * permission and window operations: two new names, no change to
 * `HELPER_PROTOCOL_VERSION`, and an unknown operation still answered as a typed
 * `invalid-request` by whichever side does not know it.
 *
 * ## Why the pointer and the hit test share one operation
 *
 * `accessibility.sample` answers "where is the pointer, and what is under it"
 * in a single round trip. At the ~30 Hz of system-design §17 the alternative —
 * `getPointer()` then `elementAt()` — is sixty round trips a second through a
 * single-threaded stdio loop, and the two answers would be taken at different
 * instants, so the element could belong to a position the pointer has already
 * left. One operation makes the pair atomic and halves the traffic.
 *
 * `accessibility.element-at` still exists because `AccessibilityAdapter`
 * (system-design §5) exposes `elementAt(point)` for an arbitrary point.
 *
 * ## Why the helper is told which application to look inside
 *
 * `ownerPid` scopes the hit test to one application's accessibility tree
 * (`AXUIElementCreateApplication`) instead of the system-wide element. Without
 * it, a hit test at a point that lies inside the selected window's frame can
 * still return an element belonging to a window **on top of** it — a floating
 * palette, a notification, another app entirely — and Pilot would describe
 * content from a window it is not observing. The scoping is the first of three
 * defences; the other two are host-side (`src/accessibility/pointer-grounding.ts`).
 *
 * ## Why a secure field is a *basis*, not just a flag
 *
 * system-design §14 is explicit that accessibility-based redaction is best
 * effort. A bare `isSecure: boolean` invites the reading "false means safe",
 * which is exactly the claim that cannot be made: macOS marks
 * `AXSecureTextField`, and nothing marks a token pasted into a plain text view,
 * a password rendered by a canvas, or a secret sitting in a window title. So
 * the wire carries *why* the answer is what it is, and `secureBasis: 'none'`
 * reads as "nothing macOS exposes marks this element as secure" rather than as
 * a safety guarantee.
 */

/** How the helper read the pointer position, or why it could not. */
export const POINTER_SOURCES = [
  /** `CGEvent(source: nil)?.location` — global, top-left origin, no AX grant needed. */
  'cg-event',
  /** `NSEvent.mouseLocation`, flipped from AppKit's bottom-left origin. */
  'ns-event',
  /** Neither call produced a position. */
  'unavailable',
] as const;

export type PointerSource = (typeof POINTER_SOURCES)[number];

/**
 * What the hit test did.
 *
 * `not-trusted` and `query-failed` are kept apart from `no-element`: the first
 * two mean Pilot could not look, the third means it looked and there was
 * nothing there. Collapsing them would make a denied Accessibility permission
 * indistinguishable from an empty region of a window.
 */
export const ELEMENT_OUTCOMES = [
  'reported',
  'no-element',
  'not-trusted',
  'query-failed',
  'not-requested',
] as const;

export type ElementOutcome = (typeof ELEMENT_OUTCOMES)[number];

/**
 * Why an element is (or is not) considered secure.
 *
 * Ordered from strongest to weakest evidence. `none` is the absence of
 * evidence and must never be read as evidence of absence.
 */
export const SECURE_FIELD_BASES = [
  /** `AXRole` is `AXSecureTextField`. */
  'role',
  /** `AXSubrole` is `AXSecureTextField` — how AppKit and WebKit mark password fields. */
  'subrole',
  /** An ancestor within the bounded walk is a secure field. */
  'ancestor',
  /** Nothing macOS exposes marks this element as secure. Not a safety claim. */
  'none',
] as const;

export type SecureFieldBasis = (typeof SECURE_FIELD_BASES)[number];

/** How many ancestors the helper inspects before giving up. Bounded: the walk is on the 30 Hz path. */
export const MAX_SECURE_ANCESTOR_DEPTH = 4;

const text = (max: number) => z.string().max(max).nullable();

/**
 * One accessibility element, as the helper observed it.
 *
 * Every field is nullable because every one of them is an
 * `AXUIElementCopyAttributeValue` that can fail independently — an element with
 * a role and no title is ordinary, not an error.
 */
export const accessibilityElementSchema = z.strictObject({
  /** `AXRole`, e.g. `AXButton`, `AXTextField`. */
  role: text(120),
  /** `AXSubrole`, e.g. `AXSecureTextField`. */
  subrole: text(120),
  /** `AXTitle`, else `AXDescription`, else the title element's value. */
  label: text(500),
  /**
   * `AXValue`, and only when the request asked for it **and** the element was
   * not classified secure. Null is the default answer, not an error.
   */
  value: text(500),
  /** `AXFrame` in global screen points, top-left origin — the same space as window bounds. */
  bounds: nativeRectSchema.nullable(),
  /** True when {@link secureBasis} is anything but `none`. Best effort (system-design §14). */
  isSecure: z.boolean(),
  secureBasis: z.enum(SECURE_FIELD_BASES),
  /** Ancestor distance at which a secure field was found; null unless `secureBasis` is `ancestor`. */
  secureAncestorDepth: z.number().int().nonnegative().nullable(),
  /**
   * `AXUIElementGetPid` of the element. Carried so the host can reject an
   * element belonging to an application other than the selected window's.
   */
  ownerPid: z.number().int().nonnegative().nullable(),
});

export type AccessibilityElement = z.infer<typeof accessibilityElementSchema>;

const hitTestRequestFields = {
  /**
   * Restrict the hit test to this application's accessibility tree. Omitted or
   * null means the system-wide element, which can answer with an element from
   * any window on screen.
   */
  ownerPid: z.number().int().nonnegative().nullable().optional(),
  /**
   * Read `AXValue` as well. Off by default: values are where secrets live, and
   * the secure-field flag that would protect them is best effort.
   */
  includeValue: z.boolean().optional(),
};

const hitTestResponseFields = {
  /** `AXIsProcessTrusted()` at the moment of the call. False means no hit test ran. */
  axTrusted: z.boolean(),
  element: accessibilityElementSchema.nullable(),
  outcome: z.enum(ELEMENT_OUTCOMES),
};

/**
 * Pointer position, and optionally the element under it, at one instant.
 *
 * The pointer half needs no Accessibility grant: `CGEvent(source: nil)?.location`
 * is available to any process. That is what makes the degraded mode of
 * system-design §16 real — with Accessibility denied this operation still
 * answers with a position, and only `element` goes missing.
 */
export const accessibilitySampleOperation = defineHelperOperation({
  name: 'accessibility.sample',
  request: z.strictObject({
    /** Hit-test the pointer position too. Off by default; `getPointer()` does not need it. */
    includeElement: z.boolean().optional(),
    ...hitTestRequestFields,
  }),
  response: z.strictObject({
    point: z.strictObject({ x: z.number().finite(), y: z.number().finite() }),
    pointerSource: z.enum(POINTER_SOURCES),
    /** Helper clock reading for the sample, ms since epoch. */
    sampledAt: z.number().int().nonnegative(),
    ...hitTestResponseFields,
  }),
  requestBinary: false,
  responseBinary: false,
});

/** The element at an arbitrary screen point (`AccessibilityAdapter.elementAt`). */
export const accessibilityElementAtOperation = defineHelperOperation({
  name: 'accessibility.element-at',
  request: z.strictObject({
    point: z.strictObject({ x: z.number().finite(), y: z.number().finite() }),
    ...hitTestRequestFields,
  }),
  response: z.strictObject(hitTestResponseFields),
  requestBinary: false,
  responseBinary: false,
});

export type AccessibilitySampleResponse = z.infer<typeof accessibilitySampleOperation.response>;
export type AccessibilityElementAtResponse = z.infer<
  typeof accessibilityElementAtOperation.response
>;
