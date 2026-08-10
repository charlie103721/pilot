import { PilotError } from '@pilot/shared';
import type { Unsubscribe } from '../common.js';

/**
 * Shared plumbing for the fakes.
 *
 * Everything here is synchronous and deterministic: no timers, no randomness,
 * no I/O. Fakes advance only when a test tells them to.
 */

export class Emitter<Event> {
  readonly #listeners = new Set<(event: Event) => void>();

  subscribe = (listener: (event: Event) => void): Unsubscribe => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  emit(event: Event): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

export interface FakeClock {
  now(): number;
  advance(milliseconds: number): void;
}

/** Fixed epoch so fixture timestamps are stable across runs. */
export const FAKE_EPOCH_MS = 1_760_000_000_000;

export function createFakeClock(start: number = FAKE_EPOCH_MS): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

export function throwIfAborted(signal: AbortSignal | undefined, what: string): void {
  if (signal?.aborted === true) {
    throw new PilotError('cancelled', `${what} was cancelled`, {
      userMessage: 'The request was cancelled.',
      retryable: true,
    });
  }
}
