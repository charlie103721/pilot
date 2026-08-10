import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toPilotError, type PermissionKind, type SerializedPilotError } from '@pilot/shared';
import {
  demoPermissionFixtureChannel,
  permissionsActChannel,
  permissionsChangedEvent,
  permissionsGetChannel,
} from '../ipc/channels.js';
import type {
  PermissionAction,
  PermissionFixtureName,
  PermissionGateState,
} from '../ipc/schemas.js';
import {
  buildPermissionOnboardingView,
  type PermissionOnboardingView,
} from '../permissions/view-model.js';
import { PilotClient } from './ipc-client.js';

/**
 * Permission state for the panel.
 *
 * The gate state arrives from main and is turned into a view here, once, so
 * every component below renders derived data and never re-derives a rule. Two
 * details are load-bearing:
 *
 *  - the initial state has `snapshot: null`, which the view model renders as
 *    "checking" — so the panel never briefly implies a refusal it has not
 *    heard about;
 *  - `pilot:permissions/changed` is subscribed *before* the first read, so a
 *    change that lands during startup is not lost.
 */

export interface PermissionsShell {
  readonly view: PermissionOnboardingView;
  /** Failure of the transport itself, as opposed to a refused action. */
  readonly transportError: SerializedPilotError | null;
  refresh(): void;
  request(kind: PermissionKind): void;
  openSettings(kind: PermissionKind): void;
  dismissError(): void;
  applyFixture(name: PermissionFixtureName): void;
}

/** What the panel shows before main has answered anything. */
export const INITIAL_GATE_STATE: PermissionGateState = {
  snapshot: null,
  pending: [],
  checkedAt: null,
  settings: { available: false, platform: 'unknown', reason: 'Pilot has not started up yet.' },
  lastError: null,
  fixture: null,
};

export function usePermissions(): PermissionsShell {
  // Memoised: a fresh client on every render would re-run the subscription
  // effect on every render.
  const client = useMemo(() => PilotClient.fromWindow(), []);
  const [gate, setGate] = useState<PermissionGateState>(INITIAL_GATE_STATE);
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
    const unsubscribe = client.subscribe<PermissionGateState>(permissionsChangedEvent, (next) => {
      if (mounted.current) {
        setGate(next);
      }
    });

    void client
      .invoke(permissionsGetChannel, {})
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
    (work: (connected: PilotClient) => Promise<PermissionGateState>) => {
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
    (action: PermissionAction) => {
      run((connected) => connected.invoke(permissionsActChannel, action));
    },
    [run],
  );

  const applyFixture = useCallback(
    (name: PermissionFixtureName) => {
      run((connected) => connected.invoke(demoPermissionFixtureChannel, name));
    },
    [run],
  );

  const view = useMemo(() => buildPermissionOnboardingView(gate), [gate]);

  return {
    view,
    transportError,
    refresh: useCallback(() => act({ type: 'refresh' }), [act]),
    request: useCallback((kind: PermissionKind) => act({ type: 'request', kind }), [act]),
    openSettings: useCallback(
      (kind: PermissionKind) => act({ type: 'open-settings', kind }),
      [act],
    ),
    dismissError: useCallback(() => act({ type: 'dismiss-error' }), [act]),
    applyFixture,
  };
}
