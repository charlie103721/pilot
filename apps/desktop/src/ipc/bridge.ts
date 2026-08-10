import type { SerializedPilotError } from '@pilot/shared';

/**
 * The shape `contextBridge` exposes to the renderer.
 *
 * Everything here is structured-cloneable or a proxied function. In particular
 * failures are returned as a serialized discriminated union rather than thrown:
 * an exception crossing `contextBridge` loses its class and its custom fields,
 * so a thrown `PilotError` would arrive in the renderer as a bare `Error` and
 * the UI could no longer switch on `code`. The renderer rehydrates the typed
 * error itself (see `renderer/ipc-client.ts`).
 */
export type BridgeResult<T> =
  | { readonly ok: true; readonly payload: T }
  | { readonly ok: false; readonly error: SerializedPilotError };

export interface PilotBridge {
  /** Contract version the preload was built against. */
  readonly protocolVersion: number;
  /** Sends a validated request on a named logical channel. */
  invoke(channelName: string, payload: unknown): Promise<BridgeResult<unknown>>;
  /** Subscribes to a named logical event channel. Returns an unsubscribe. */
  subscribe(channelName: string, listener: (payload: unknown) => void): () => void;
}
