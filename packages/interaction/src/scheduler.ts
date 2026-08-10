/**
 * PR-027 — the one place a delay may exist in this lane.
 *
 * ## Why this is a port and not a `setTimeout`
 *
 * The interaction machine owns no timers. That is not an accident of style: it
 * is the reason a whole conversation, including every interruption in it,
 * replays identically in a test with no fake timers, no `await sleep`, and no
 * flakes. Runbook §8 follow-up 6 asks for one behaviour that genuinely needs
 * real time — a fragment the model left hanging should be spoken once it has
 * waited long enough, even if the run then goes completely quiet — and the
 * cheapest way to get it would have been a `setTimeout` inside the controller.
 *
 * That would have been the wrong trade. Instead the delay is a *port*, exactly
 * like `Clock` and every adapter: production passes {@link createTimeoutScheduler},
 * tests pass `ManualScheduler` (`./fakes.ts`) and fire it by hand. The machine
 * still owns no timers, the library still reads no wall clock, and the tests
 * are still fully deterministic — the feature is paid for in one injected
 * interface rather than in the property that makes this lane trustworthy.
 *
 * The scheduler decides *when* to ask; the machine still decides what to do,
 * and rejects the request outright if the fragment it names is no longer
 * waiting (`stale-phrase-timeout`). A scheduler that fires early, late, twice,
 * or after everything is over cannot make the machine speak the wrong thing.
 */

/** Cancels a scheduled callback. Idempotent; safe after it has fired. */
export type CancelScheduled = () => void;

export interface Scheduler {
  /**
   * Run `callback` once, no earlier than `delayMs` from now.
   *
   * Implementations may fire later (a busy event loop) but must never fire
   * before. Callers must tolerate a callback that never comes.
   */
  schedule(delayMs: number, callback: () => void): CancelScheduled;
}

/**
 * The production scheduler: `setTimeout`, unref'd.
 *
 * Unref'd deliberately — a pending phrase timeout must never be the reason a
 * Node process stays alive, and in Electron's main process the same timer would
 * otherwise keep a quitting app from exiting.
 */
export function createTimeoutScheduler(): Scheduler {
  return {
    schedule(delayMs: number, callback: () => void): CancelScheduled {
      const timer = setTimeout(callback, Math.max(0, delayMs));
      timer.unref?.();
      return () => {
        clearTimeout(timer);
      };
    },
  };
}

/** A scheduler that never fires. The default: the feature is opt-in. */
export const NULL_SCHEDULER: Scheduler = {
  schedule(): CancelScheduled {
    return () => undefined;
  },
};
