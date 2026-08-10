import { nullLogger, type Logger } from '@pilot/shared';

/**
 * Single-instance enforcement.
 *
 * Pilot must never run twice: two instances would hold two capture sessions,
 * two menu bar items and two microphone claims. Electron's primitive is
 * `app.requestSingleInstanceLock()`, which is impossible to unit test, so the
 * decision lives here behind a port and `main/index.ts` supplies the real app.
 */

export interface SingleInstanceHost {
  /** True when this process won the lock and is the primary instance. */
  requestSingleInstanceLock(): boolean;
  /** Registers a listener invoked in the primary when a second one starts. */
  onSecondInstance(listener: (argv: readonly string[]) => void): void;
  /** Terminates this process. Only ever called on the losing instance. */
  quit(): void;
}

export interface SingleInstanceOptions {
  readonly host: SingleInstanceHost;
  /**
   * Called in the primary instance when a second launch is attempted. The
   * conventional behaviour — and what the shell does — is to reveal the panel.
   */
  readonly onSecondInstance: (argv: readonly string[]) => void;
  readonly logger?: Logger;
}

export interface SingleInstanceResult {
  /** False when another instance already holds the lock. */
  readonly isPrimary: boolean;
}

/**
 * Acquires the lock, or quits. Returns `isPrimary: false` when the caller must
 * stop initialising — the caller is responsible for returning early, because
 * `app.quit()` is asynchronous and the rest of startup would otherwise still
 * run and briefly create a second tray item.
 */
export function enforceSingleInstance(options: SingleInstanceOptions): SingleInstanceResult {
  const logger = options.logger ?? nullLogger;
  const isPrimary = options.host.requestSingleInstanceLock();

  if (!isPrimary) {
    logger.info('another Pilot instance is already running; quitting');
    options.host.quit();
    return { isPrimary: false };
  }

  options.host.onSecondInstance((argv) => {
    logger.info('second launch attempt; revealing existing instance', { argc: argv.length });
    options.onSecondInstance(argv);
  });

  return { isPrimary: true };
}
