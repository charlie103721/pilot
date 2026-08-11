import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toPilotError, type SerializedPilotError } from '@pilot/shared';
import {
  conversationActChannel,
  conversationChangedEvent,
  conversationGetChannel,
  demoConversationChannel,
} from '../ipc/channels.js';
import {
  DEFAULT_TELEMETRY_CAPACITY,
  type ConversationAction,
  type ConversationFixtureName,
  type ConversationGateState,
} from '../ipc/schemas.js';
import { PilotClient } from './ipc-client.js';

/**
 * Developer telemetry and the voice affordances, for the panel.
 *
 * Shaped exactly like `use-permissions.ts` and `use-windows.ts`, and for the
 * same reasons: the event is subscribed *before* the first read, so a sample
 * recorded during startup is not lost, and the hook holds no derived state —
 * every summary, tally and availability decision is computed in
 * `src/conversation/view-model.ts` and `src/diagnostics/view-model.ts`.
 */

export interface ConversationShell {
  readonly gate: ConversationGateState;
  /** Failure of the transport itself, as opposed to a refused action. */
  readonly transportError: SerializedPilotError | null;
  refresh(): void;
  clearTelemetry(): void;
  setDiagnosticsVisible(visible: boolean): void;
  replayFixture(fixture: ConversationFixtureName): void;
}

/** What the panel shows before main has answered anything. */
export const INITIAL_CONVERSATION_GATE_STATE: ConversationGateState = {
  telemetry: {
    samples: [],
    capacity: DEFAULT_TELEMETRY_CAPACITY,
    recorded: 0,
    dropped: 0,
  },
  diagnosticsVisible: false,
  pushToTalk: null,
  disclosure: null,
  fixture: null,
  demoFixtures: false,
  // PR-038. Null until the main process says which model is configured; a
  // panel that has not been told must show nothing rather than guess "local".
  modelDisclosure: null,
  // Follow-up 46. Null until the main process says which profile is in force.
  // The panel shows nothing rather than guessing, and the gap is one IPC round
  // trip — the shipping composition always answers, for all four profiles.
  modelStatus: null,
};

export function useConversation(): ConversationShell {
  const client = useMemo(() => PilotClient.fromWindow(), []);
  const [gate, setGate] = useState<ConversationGateState>(INITIAL_CONVERSATION_GATE_STATE);
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
    const unsubscribe = client.subscribe<ConversationGateState>(
      conversationChangedEvent,
      (next) => {
        if (mounted.current) {
          setGate(next);
        }
      },
    );

    void client
      .invoke(conversationGetChannel, {})
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
    (work: (connected: PilotClient) => Promise<ConversationGateState>) => {
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
    (action: ConversationAction) => {
      run((connected) => connected.invoke(conversationActChannel, action));
    },
    [run],
  );

  return {
    gate,
    transportError,
    refresh: useCallback(() => act({ type: 'refresh' }), [act]),
    clearTelemetry: useCallback(() => act({ type: 'clear-telemetry' }), [act]),
    setDiagnosticsVisible: useCallback(
      (visible: boolean) => act({ type: 'set-diagnostics-visible', visible }),
      [act],
    ),
    replayFixture: useCallback(
      (fixture: ConversationFixtureName) => {
        run((connected) => connected.invoke(demoConversationChannel, fixture));
      },
      [run],
    ),
  };
}
