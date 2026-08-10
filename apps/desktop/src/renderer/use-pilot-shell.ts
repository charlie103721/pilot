import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toPilotError, type SerializedPilotError } from '@pilot/shared';
import type { InteractionCommand, PilotViewState } from '@pilot/platform';
import {
  interactionDispatchChannel,
  panelSetVisibleChannel,
  viewStateChangedEvent,
  viewStateGetChannel,
} from '../ipc/channels.js';
import { BRIDGE_MISSING_ERROR, PilotClient } from './ipc-client.js';

/**
 * Connection state of the panel.
 *
 * `connecting` is deliberately distinct from `ready`: an empty panel that is
 * still loading and an empty panel that failed must not look the same.
 */
export type ShellStatus =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'unavailable'; readonly error: SerializedPilotError };

export interface PilotShell {
  readonly status: ShellStatus;
  readonly view: PilotViewState | null;
  /** Failure of the most recent command, cleared when the next one succeeds. */
  readonly commandError: SerializedPilotError | null;
  dispatch(command: InteractionCommand): void;
  setPanelVisible(visible: boolean): void;
}

export function usePilotShell(): PilotShell {
  const client = useMemo(() => PilotClient.fromWindow(), []);
  const [status, setStatus] = useState<ShellStatus>(
    client === null
      ? { kind: 'unavailable', error: BRIDGE_MISSING_ERROR.toJSON() }
      : { kind: 'connecting' },
  );
  const [view, setView] = useState<PilotViewState | null>(null);
  const [commandError, setCommandError] = useState<SerializedPilotError | null>(null);
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
    const unsubscribe = client.subscribe<PilotViewState>(viewStateChangedEvent, (next) => {
      if (mounted.current) {
        setView(next);
      }
    });

    void client
      .invoke(viewStateGetChannel, {})
      .then((initial) => {
        if (!mounted.current) {
          return;
        }
        setView(initial);
        setStatus({ kind: 'ready' });
      })
      .catch((cause: unknown) => {
        if (mounted.current) {
          setStatus({ kind: 'unavailable', error: toPilotError(cause).toJSON() });
        }
      });

    return unsubscribe;
  }, [client]);

  const run = useCallback(
    (work: (connected: PilotClient) => Promise<PilotViewState | void>) => {
      if (client === null) {
        return;
      }
      void work(client)
        .then((next) => {
          if (!mounted.current) {
            return;
          }
          setCommandError(null);
          if (next !== undefined) {
            setView(next);
          }
        })
        .catch((cause: unknown) => {
          if (mounted.current) {
            setCommandError(toPilotError(cause).toJSON());
          }
        });
    },
    [client],
  );

  const dispatch = useCallback(
    (command: InteractionCommand) => {
      run((connected) => connected.invoke(interactionDispatchChannel, command));
    },
    [run],
  );

  const setPanelVisible = useCallback(
    (visible: boolean) => {
      run(async (connected) => {
        await connected.invoke(panelSetVisibleChannel, { visible });
      });
    },
    [run],
  );

  return { status, view, commandError, dispatch, setPanelVisible };
}
