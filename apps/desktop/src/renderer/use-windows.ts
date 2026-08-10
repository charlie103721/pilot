import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toPilotError, type SerializedPilotError, type WindowId } from '@pilot/shared';
import {
  demoWindowEventChannel,
  windowsActChannel,
  windowsChangedEvent,
  windowsGetChannel,
} from '../ipc/channels.js';
import type { WindowAction, WindowDemoEvent, WindowGateState } from '../ipc/schemas.js';
import { PilotClient } from './ipc-client.js';

/**
 * Window list and observation controls for the panel.
 *
 * Shaped exactly like `use-permissions.ts`, and for the same two reasons:
 *
 *  - the initial state has `listedAt: null`, which the view model renders as
 *    "checking" — so an empty picker never implies "no windows are open" before
 *    Pilot has looked;
 *  - `pilot:windows/changed` is subscribed *before* the first read, so the
 *    selected window closing during startup is not lost.
 *
 * This hook holds no derived state. The indicator, the control availability and
 * the §16 prompt are all computed in `src/observation/view-model.ts` from this
 * plus the view state and the permission view.
 */

export interface WindowsShell {
  readonly gate: WindowGateState;
  /** Failure of the transport itself, as opposed to a refused action. */
  readonly transportError: SerializedPilotError | null;
  refresh(): void;
  select(windowId: WindowId): void;
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  dismissNotice(): void;
  applyDemoEvent(event: WindowDemoEvent): void;
}

/** What the panel shows before main has answered anything. */
export const INITIAL_WINDOW_GATE_STATE: WindowGateState = {
  windows: [],
  listedAt: null,
  listing: true,
  notice: null,
  lastError: null,
  demoEvents: false,
};

export function useWindows(): WindowsShell {
  // Memoised: a fresh client on every render would re-run the subscription
  // effect on every render.
  const client = useMemo(() => PilotClient.fromWindow(), []);
  const [gate, setGate] = useState<WindowGateState>(INITIAL_WINDOW_GATE_STATE);
  const [transportError, setTransportError] = useState<SerializedPilotError | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (client === null) {
      return;
    }
    const unsubscribe = client.subscribe<WindowGateState>(windowsChangedEvent, (next) => {
      if (mounted.current) {
        setGate(next);
      }
    });

    void client
      .invoke(windowsGetChannel, {})
      .then((initial) => {
        if (mounted.current) {
          setGate(initial);
        }
      })
      .catch((cause: unknown) => {
        if (mounted.current) {
          setTransportError(toPilotError(cause).toJSON());
        }
      });

    return unsubscribe;
  }, [client]);

  const run = useCallback(
    (work: (connected: PilotClient) => Promise<WindowGateState>) => {
      if (client === null) {
        return;
      }
      void work(client)
        .then((next) => {
          if (mounted.current) {
            setTransportError(null);
            setGate(next);
          }
        })
        .catch((cause: unknown) => {
          if (mounted.current) {
            setTransportError(toPilotError(cause).toJSON());
          }
        });
    },
    [client],
  );

  const act = useCallback(
    (action: WindowAction) => {
      run((connected) => connected.invoke(windowsActChannel, action));
    },
    [run],
  );

  return {
    gate,
    transportError,
    refresh: useCallback(() => act({ type: 'refresh' }), [act]),
    select: useCallback((windowId: WindowId) => act({ type: 'select', windowId }), [act]),
    start: useCallback(() => act({ type: 'start' }), [act]),
    stop: useCallback(() => act({ type: 'stop' }), [act]),
    pause: useCallback(() => act({ type: 'pause' }), [act]),
    resume: useCallback(() => act({ type: 'resume' }), [act]),
    dismissNotice: useCallback(() => act({ type: 'dismiss-notice' }), [act]),
    applyDemoEvent: useCallback(
      (event: WindowDemoEvent) => {
        run((connected) => connected.invoke(demoWindowEventChannel, event));
      },
      [run],
    ),
  };
}
