import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toPilotError, type SerializedPilotError } from '@pilot/shared';
import { codexActChannel, codexChangedEvent, codexGetChannel } from '../ipc/codex-channels.js';
import {
  DISABLED_CODEX_GATE_STATE,
  type CodexAction,
  type CodexGateState,
} from '../ipc/codex-schemas.js';
import { PilotClient } from './ipc-client.js';

/**
 * Codex subscription status, for the panel (PR-037).
 *
 * Shaped exactly like `use-conversation.ts`, `use-permissions.ts` and
 * `use-windows.ts`: the event is subscribed *before* the first read, so a
 * device code that arrives during startup is not lost, and the hook holds no
 * derived state — the status sentence and the remedy are written once, in
 * `packages/agent/src/codex-auth.ts`, and travel over the wire.
 *
 * There is no credential here and there cannot be one: `CodexGateState` is
 * validated against a `strictObject` on the way out of the main process.
 */

export interface CodexShell {
  readonly gate: CodexGateState;
  readonly transportError: SerializedPilotError | null;
  refresh(): void;
  signIn(): void;
  cancelSignIn(): void;
  signOut(): void;
}

export function useCodex(): CodexShell {
  const client = useMemo(() => PilotClient.fromWindow(), []);
  const [gate, setGate] = useState<CodexGateState>(DISABLED_CODEX_GATE_STATE);
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
    const unsubscribe = client.subscribe<CodexGateState>(codexChangedEvent, (next) => {
      if (mounted.current) {
        setGate(next);
      }
    });

    void client
      .invoke(codexGetChannel, {})
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

  const act = useCallback(
    (action: CodexAction) => {
      if (client === null) {
        return;
      }
      void client
        .invoke(codexActChannel, action)
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

  return {
    gate,
    transportError,
    refresh: useCallback(() => act({ type: 'refresh' }), [act]),
    signIn: useCallback(() => act({ type: 'sign-in' }), [act]),
    cancelSignIn: useCallback(() => act({ type: 'cancel-sign-in' }), [act]),
    signOut: useCallback(() => act({ type: 'sign-out' }), [act]),
  };
}
