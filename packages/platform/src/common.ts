/** Removes a previously registered listener. Calling it twice is a no-op. */
export type Unsubscribe = () => void;

/** A listener registration shape shared by every adapter that emits events. */
export type Subscribe<Event> = (listener: (event: Event) => void) => Unsubscribe;
