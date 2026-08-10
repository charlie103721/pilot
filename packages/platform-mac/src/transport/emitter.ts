import type { Unsubscribe } from '@pilot/platform';

/**
 * Minimal typed event emitter.
 *
 * `node:events` is deliberately not used: its `error` event throws when
 * unhandled, and a listener that throws would take down helper supervision.
 * Here a throwing listener is isolated and reported through `onListenerError`.
 */
export class TypedEmitter<Events extends Record<string, unknown>> {
  readonly #listeners = new Map<keyof Events, Set<(payload: never) => void>>();
  readonly #onListenerError: (error: unknown, event: keyof Events) => void;

  constructor(onListenerError: (error: unknown, event: keyof Events) => void = () => undefined) {
    this.#onListenerError = onListenerError;
  }

  on<E extends keyof Events>(event: E, listener: (payload: Events[E]) => void): Unsubscribe {
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    const entry = listener as (payload: never) => void;
    set.add(entry);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      set.delete(entry);
    };
  }

  emit<E extends keyof Events>(event: E, payload: Events[E]): void {
    const set = this.#listeners.get(event);
    if (set === undefined) {
      return;
    }
    for (const listener of [...set]) {
      try {
        (listener as (value: Events[E]) => void)(payload);
      } catch (error) {
        this.#onListenerError(error, event);
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}
