import { toPilotError } from '@pilot/shared';
import type { FakePermissionAdapter } from '@pilot/platform/fakes';
import type { BridgeResult } from '../../src/ipc/bridge.js';
import {
  demoPermissionFixtureChannel,
  permissionsActChannel,
  permissionsChangedEvent,
  permissionsGetChannel,
} from '../../src/ipc/channels.js';
import {
  permissionActionSchema,
  permissionFixtureSchema,
  permissionGateStateSchema,
  type PermissionFixtureName,
} from '../../src/ipc/schemas.js';
import type { PermissionGate } from '../../src/main/permission-gate.js';
import { permissionHarness } from '../main/support.js';

/**
 * The permission half of the panel's bridge, backed by the real gate.
 *
 * The renderer tests talk to an actual {@link PermissionGate} over an actual
 * fake adapter, with both directions schema-checked exactly as the preload
 * checks them. That means a renderer test that passes is evidence about the
 * shipped path, and a gate state that could not survive the wire fails here
 * rather than in production.
 */

export interface PermissionBridge {
  readonly gate: PermissionGate;
  readonly adapter: FakePermissionAdapter;
  /** Serves a permission channel, or returns null when it is not one. */
  invoke(channelName: string, payload: unknown): Promise<BridgeResult<unknown>> | null;
  /** Subscribes to the permission event channel, or returns null. */
  subscribe(channelName: string, listener: (payload: unknown) => void): (() => void) | null;
  /** Completes a first read held open by `stallFirstRead`. */
  releaseFirstRead(): void;
}

export interface PermissionBridgeOptions {
  readonly fixture?: PermissionFixtureName;
  readonly platform?: string;
  /**
   * Holds the panel's first read open, so the "checking" state can be observed
   * for as long as a test needs it. Released with `releaseFirstRead()`.
   */
  readonly stallFirstRead?: boolean;
}

export function permissionBridge(options: PermissionBridgeOptions = {}): PermissionBridge {
  const harness = permissionHarness({
    fixture: options.fixture ?? 'granted',
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    now: () => 1_700_000_000_000,
  });
  const listeners = new Set<(payload: unknown) => void>();
  let release: (() => void) | null = null;
  const stalled =
    options.stallFirstRead === true
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : Promise.resolve();

  harness.gate.subscribe((state) => {
    const encoded = permissionGateStateSchema.parse(state);
    for (const listener of [...listeners]) {
      listener(encoded);
    }
  });

  const ok = async (work: () => Promise<unknown> | unknown): Promise<BridgeResult<unknown>> => {
    try {
      return { ok: true, payload: permissionGateStateSchema.parse(await work()) };
    } catch (cause) {
      return { ok: false, error: toPilotError(cause).toJSON() };
    }
  };

  return {
    gate: harness.gate,
    adapter: harness.adapter,
    releaseFirstRead(): void {
      release?.();
      release = null;
    },
    invoke(channelName: string, payload: unknown): Promise<BridgeResult<unknown>> | null {
      switch (channelName) {
        case permissionsGetChannel.name:
          // The panel's first read settles the gate, exactly as `DesktopShell`
          // does by refreshing on start and on every reveal.
          return ok(async () => {
            await stalled;
            return harness.gate.snapshot().checkedAt === null
              ? harness.gate.refresh()
              : harness.gate.snapshot();
          });
        case permissionsActChannel.name:
          return ok(() => harness.gate.act(permissionActionSchema.parse(payload)));
        case demoPermissionFixtureChannel.name:
          return ok(() => harness.gate.applyFixture(permissionFixtureSchema.parse(payload)));
        default:
          return null;
      }
    },
    subscribe(channelName: string, listener: (payload: unknown) => void): (() => void) | null {
      if (channelName !== permissionsChangedEvent.name) {
        return null;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
