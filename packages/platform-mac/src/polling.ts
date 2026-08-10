import { toPilotError, type Logger } from '@pilot/shared';

/**
 * Subscription-driven poller.
 *
 * Both macOS adapters observe change by re-reading a snapshot and diffing it
 * (see `src/protocol/window-ops.ts` for why). This is the timer that drives
 * that, with three properties the naive `setInterval` version does not have:
 *
 * - **No stacking.** The next tick is armed after the previous one settles, so
 *   a slow helper cannot build a backlog of overlapping polls.
 * - **No idle work.** It runs only while something is subscribed. A window
 *   list nobody is watching is not worth an IPC round trip every second, and
 *   an adapter that polls forever keeps the helper warm for no reason.
 * - **No held process.** The timer is `unref`'d, so a forgotten poller cannot
 *   keep Node alive at the end of a test or a CLI run.
 *
 * A failing tick is logged at debug and the schedule continues. Poll failures
 * are expected and transient — the helper restarts, and the next tick
 * reconciles from a fresh snapshot rather than from a repaired stream.
 */
export interface PollerOptions {
  readonly intervalMs: number;
  readonly logger: Logger;
  /** Label used in log lines. */
  readonly name: string;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
}

export class Poller {
  readonly #tick: () => Promise<void>;
  readonly #options: PollerOptions;
  readonly #setTimer: typeof setTimeout;
  readonly #clearTimer: typeof clearTimeout;

  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #inFlight: Promise<void> | undefined;

  constructor(tick: () => Promise<void>, options: PollerOptions) {
    this.#tick = tick;
    this.#options = options;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#arm();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * Runs one tick immediately, outside the schedule, and resolves when it has
   * settled. Used to reconcile after a helper restart and to make tests
   * deterministic without waiting on wall-clock time.
   */
  async refresh(): Promise<void> {
    const inFlight = this.#inFlight;
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }
    await this.#run();
  }

  #arm(): void {
    if (!this.#running) {
      return;
    }
    const timer = this.#setTimer(() => {
      void this.#run().finally(() => {
        this.#arm();
      });
    }, this.#options.intervalMs);
    // `unref` is absent on the fake timers some tests inject.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    this.#timer = timer;
  }

  async #run(): Promise<void> {
    const promise = (async () => {
      try {
        await this.#tick();
      } catch (error) {
        this.#options.logger.debug('poll failed', {
          poller: this.#options.name,
          code: toPilotError(error).code,
        });
      }
    })();
    this.#inFlight = promise;
    try {
      await promise;
    } finally {
      this.#inFlight = undefined;
    }
  }
}
