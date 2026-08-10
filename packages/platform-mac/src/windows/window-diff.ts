import type { ObservedWindow, WindowId } from '@pilot/shared';
import type { WindowChangeKind, WindowEvent } from '@pilot/platform';
import type { NativeWindow, WindowSnapshot } from '../protocol/window-ops.js';
import { isSelectableWindow, macWindowId, toObservedWindow } from './window-model.js';

/**
 * Window lifecycle, derived by comparing two snapshots.
 *
 * This is the whole of "appeared, closed, retitled, moved/resized". The helper
 * contributes no lifecycle logic at all — it answers `windows.list` and
 * forgets — which is what lets every rule below be covered by tests that run
 * on Linux (runbook amendment 8).
 *
 * ## Emission order
 *
 * Within one tick, events are emitted closures-first:
 *
 * 1. `screen-locked` / `screen-unlocked`
 * 2. one `window-closed` per window that disappeared
 * 3. one `window-list-changed` carrying `appeared` and `disappeared`
 * 4. one `window-changed` per window that survived and mutated
 *
 * Closures precede everything so a consumer that tears down on
 * `window-closed` (system-design §16: "selected window closed → stop
 * observation, clear buffer") has already stopped before it is told about
 * whatever replaced it. A recycled `CGWindowID` is the case that makes this
 * matter: it arrives as a close *and* an appearance in the same tick, and the
 * close has to win.
 *
 * ## Identity, not position
 *
 * Windows are matched by `CGWindowID` **and** `ownerPid`. Matching on
 * `CGWindowID` alone would let a recycled id — the window server may reuse one
 * after its window is destroyed — turn into a `window-changed` on a live
 * selection, silently pointing an observation at a different application's
 * window. Requiring the owner to match as well turns that into the close and
 * appearance it actually is.
 */

interface Keyed {
  readonly native: NativeWindow;
  readonly observed: ObservedWindow;
}

/** Identity key: the window-server id plus the process that owns it. */
function identityKey(window: NativeWindow): string {
  return `${String(window.windowNumber)}:${String(window.ownerPid)}`;
}

function index(snapshot: WindowSnapshot): Map<string, Keyed> {
  const entries = new Map<string, Keyed>();
  for (const native of snapshot.windows) {
    if (!isSelectableWindow(native)) {
      continue;
    }
    entries.set(identityKey(native), {
      native,
      observed: toObservedWindow(native, snapshot.displays),
    });
  }
  return entries;
}

/** Every way a surviving window can differ from its previous self. */
export function changesBetween(
  previous: ObservedWindow,
  next: ObservedWindow,
): readonly WindowChangeKind[] {
  const changes: WindowChangeKind[] = [];
  if (previous.title !== next.title) {
    changes.push('title');
  }
  if (previous.bounds.x !== next.bounds.x || previous.bounds.y !== next.bounds.y) {
    changes.push('position');
  }
  if (
    previous.bounds.width !== next.bounds.width ||
    previous.bounds.height !== next.bounds.height
  ) {
    changes.push('size');
  }
  if (previous.displayId !== next.displayId || previous.scaleFactor !== next.scaleFactor) {
    changes.push('display');
  }
  if (previous.isOnScreen !== next.isOnScreen) {
    changes.push('visibility');
  }
  return changes;
}

export interface WindowDiff {
  readonly events: readonly WindowEvent[];
  /** Selectable windows in the new snapshot, in window-server order. */
  readonly windows: readonly ObservedWindow[];
}

/**
 * Diffs two snapshots into contract events.
 *
 * `previous` is `null` for the first snapshot of a session, which produces no
 * events at all: the initial window list is a state to be read with `list()`,
 * not a burst of "everything just appeared" that a subscriber joining midway
 * would have to filter out. The same applies after a helper restart — the
 * first snapshot from the new process is compared against the last snapshot
 * from the old one, so a restart during which nothing moved is silent, and a
 * restart during which the selected window closed still reports the close.
 */
export function diffWindowSnapshots(
  previous: WindowSnapshot | null,
  next: WindowSnapshot,
): WindowDiff {
  const nextIndex = index(next);
  const windows = [...nextIndex.values()].map((entry) => entry.observed);

  if (previous === null) {
    return { events: [], windows };
  }

  const previousIndex = index(previous);
  const events: WindowEvent[] = [];

  if (previous.screenLocked !== next.screenLocked) {
    events.push({ type: next.screenLocked ? 'screen-locked' : 'screen-unlocked' });
  }

  const disappeared: WindowId[] = [];
  for (const [key, entry] of previousIndex) {
    if (!nextIndex.has(key)) {
      disappeared.push(entry.observed.windowId);
    }
  }

  const appeared: ObservedWindow[] = [];
  const changed: WindowEvent[] = [];
  for (const [key, entry] of nextIndex) {
    const before = previousIndex.get(key);
    if (before === undefined) {
      appeared.push(entry.observed);
      continue;
    }
    const changes = changesBetween(before.observed, entry.observed);
    if (changes.length > 0) {
      changed.push({
        type: 'window-changed',
        window: entry.observed,
        changes,
        previous: before.observed,
      });
    }
  }

  for (const windowId of disappeared) {
    events.push({ type: 'window-closed', windowId });
  }

  if (appeared.length > 0 || disappeared.length > 0) {
    events.push({
      type: 'window-list-changed',
      ...(appeared.length > 0 ? { appeared } : {}),
      ...(disappeared.length > 0 ? { disappeared } : {}),
    });
  }

  events.push(...changed);

  return { events, windows };
}

/**
 * Whether a `WindowId` survived into this snapshot.
 *
 * Used by the adapter to answer `get()` without re-querying, and by callers
 * that need to know whether a selection is still valid after a helper restart.
 */
export function snapshotContains(snapshot: WindowSnapshot, windowId: WindowId): boolean {
  return snapshot.windows.some(
    (window) => isSelectableWindow(window) && macWindowId(window.windowNumber) === windowId,
  );
}
