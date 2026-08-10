/**
 * Injected time source.
 *
 * Every module in this package reads time through a {@link Clock}. Library code
 * must never call `Date.now()` directly — {@link systemClock} is the single
 * adapter that does, so tests can substitute a `FakeClock`
 * (`@pilot/platform/fakes`) and control eviction, coalescing and scene
 * timestamps exactly.
 */
export interface Clock {
  now(): number;
}

/** A clock a test (or the demo) can drive forwards by hand. */
export interface AdjustableClock extends Clock {
  advance(milliseconds: number): void;
}

/** The only place in this package that reads wall-clock time. */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/**
 * Milliseconds are stored as integers everywhere the value reaches a contract
 * schema (`SceneState.updatedAt`, `ScreenStatus.buffer.*`), which require
 * non-negative integers.
 */
export function toTimestamp(value: number): number {
  return Math.max(0, Math.trunc(value));
}
