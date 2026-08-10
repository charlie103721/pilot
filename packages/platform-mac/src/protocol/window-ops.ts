import { z } from 'zod';
import { defineHelperOperation } from './operation-kit.js';

/**
 * Window enumeration operations (PR-011).
 *
 * ## Why the helper enumerates and the host diffs
 *
 * The helper answers `windows.list` with a complete snapshot and nothing else.
 * It runs no timer, holds no previous state and pushes no lifecycle events.
 * Everything about "appeared / closed / retitled / moved / resized" is derived
 * host-side by comparing two consecutive snapshots
 * (`src/windows/window-diff.ts`).
 *
 * That split is deliberate. Helper-side events would need a background thread
 * writing frames concurrently with the request loop, which means a write lock
 * and a second failure surface — in Swift that cannot be compiled or run on
 * this machine. Snapshot diffing puts the entire lifecycle rule set in
 * TypeScript, where every case is covered by tests that actually execute
 * (runbook amendment 8). The cost is polling latency, bounded by the adapter's
 * interval; the benefit is that a helper restart re-derives the same events
 * from the same rules with no state to resynchronise.
 *
 * ## Why `CGWindowListCopyWindowInfo` rather than `SCShareableContent`
 *
 * It is synchronous, needs no concurrency, and — importantly — degrades in an
 * observable way: without Screen Recording, macOS returns the window list but
 * withholds `kCGWindowName`. `titleAvailable: false` on every window is a
 * second, independent signal that Screen Recording is not actually in force,
 * which is exactly the cross-check a permission attribution bug would need.
 * PR-012 needs `SCShareableContent` for capture filters regardless; it is not
 * needed to enumerate.
 */

const finite = z.number().finite();

export const nativeRectSchema = z.strictObject({
  x: finite,
  y: finite,
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});

/**
 * One window as the window server describes it.
 *
 * `windowNumber` is the `CGWindowID`. It is the sole input to the stable
 * `WindowId` (see `src/windows/window-model.ts`), and `ownerPid` exists so a
 * recycled `CGWindowID` can be detected rather than silently inherited.
 */
export const nativeWindowSchema = z.strictObject({
  /** `CGWindowID` (`kCGWindowNumber`). Unique while the window lives. */
  windowNumber: z.number().int().nonnegative(),
  /** `kCGWindowOwnerPID`. Identifies the owning application process. */
  ownerPid: z.number().int().nonnegative(),
  /** `kCGWindowOwnerName`. */
  applicationName: z.string().max(300),
  /** Bundle identifier of the owning application, when resolvable. */
  applicationBundleId: z.string().max(300).nullable(),
  /** `kCGWindowName`. Null when macOS withheld it (no Screen Recording grant). */
  title: z.string().max(1000).nullable(),
  /**
   * False when the title was withheld rather than genuinely empty. A window
   * really can have an empty title; that is not the same as being blind to it.
   */
  titleAvailable: z.boolean(),
  /** `kCGWindowBounds`, top-left origin global screen points. */
  bounds: nativeRectSchema,
  /** `CGDirectDisplayID` of the display holding the window's centre. */
  displayNumber: z.number().int().nonnegative().nullable(),
  /** `kCGWindowIsOnscreen`. */
  isOnScreen: z.boolean(),
  /** `kCGWindowLayer`. 0 is the normal application layer. */
  layer: z.number().int(),
});

export type NativeWindow = z.infer<typeof nativeWindowSchema>;

export const nativeDisplaySchema = z.strictObject({
  /** `CGDirectDisplayID`. */
  displayNumber: z.number().int().nonnegative(),
  bounds: nativeRectSchema,
  /** Backing pixels per point, derived from the display mode. */
  scaleFactor: z.number().finite().positive(),
  isPrimary: z.boolean(),
});

export type NativeDisplay = z.infer<typeof nativeDisplaySchema>;

/** Upper bound on windows returned in one snapshot; the rest are dropped. */
export const MAX_ENUMERATED_WINDOWS = 512;

export const windowSnapshotSchema = z.strictObject({
  windows: z.array(nativeWindowSchema).max(MAX_ENUMERATED_WINDOWS),
  displays: z.array(nativeDisplaySchema).max(64),
  /** `CGSSessionScreenIsLocked`. Capture must stop while true (system-design §14). */
  screenLocked: z.boolean(),
  /**
   * True when macOS withheld titles for every window it returned — the
   * signature of an absent Screen Recording grant, whatever the TCC probe
   * claims. A cross-check on attribution, not a permission state of its own.
   */
  titlesWithheld: z.boolean(),
  /** Helper clock reading for the snapshot, ms since epoch. */
  capturedAt: z.number().int().nonnegative(),
});

export type WindowSnapshot = z.infer<typeof windowSnapshotSchema>;

/** Every observable window, plus the displays and lock state that frame them. */
export const windowListOperation = defineHelperOperation({
  name: 'windows.list',
  request: z.strictObject({
    /**
     * Include windows outside the normal application layer (menu bar extras,
     * the Dock, screen savers). Excluded by default: they are never a useful
     * observation target and they churn constantly, which would make lifecycle
     * events noise.
     */
    includeAllLayers: z.boolean().optional(),
  }),
  response: windowSnapshotSchema,
  requestBinary: false,
  responseBinary: false,
});

/** One window by `CGWindowID`, with the display it sits on. */
export const windowGetOperation = defineHelperOperation({
  name: 'windows.get',
  request: z.strictObject({ windowNumber: z.number().int().nonnegative() }),
  response: z.strictObject({
    window: nativeWindowSchema.nullable(),
    display: nativeDisplaySchema.nullable(),
    screenLocked: z.boolean(),
  }),
  requestBinary: false,
  responseBinary: false,
});
