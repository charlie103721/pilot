import { toPilotError } from '@pilot/shared';
import type { FakeWindowAdapter } from '@pilot/platform/fakes';
import type { PilotInteractionController } from '@pilot/interaction';
import type { BridgeResult } from '../../src/ipc/bridge.js';
import {
  demoWindowEventChannel,
  windowsActChannel,
  windowsChangedEvent,
  windowsGetChannel,
} from '../../src/ipc/channels.js';
import {
  windowActionSchema,
  windowDemoEventSchema,
  windowGateStateSchema,
} from '../../src/ipc/schemas.js';
import type { WindowGate, ObservationPermissionSource } from '../../src/main/window-gate.js';
import type { WindowDemoDriver } from '../../src/main/window-demo.js';
import { windowHarness } from '../main/support.js';

/**
 * The window half of the panel's bridge, backed by the real gate.
 *
 * Same shape and same reason as `permission-bridge.ts`: the renderer tests talk
 * to an actual {@link WindowGate} over the PR-001 fake window adapter and — since
 * PR-029 — the **real** interaction controller, with both directions
 * schema-checked exactly as the preload checks them. A renderer test that passes
 * is therefore evidence about the shipped path, and a gate state that could not
 * survive the wire fails here rather than in production.
 *
 * The controller is created here rather than injected: it is the one the window
 * gate acts on, so a suite that renders the picker must serve `pilot:view-state`
 * from {@link WindowBridge.controller}. A suite that only needs a window *list*
 * (`app.test.tsx`, `conversation.test.tsx`) can ignore it and keep driving the
 * panel from its own fake view state.
 */

export interface WindowBridge {
  readonly gate: WindowGate;
  readonly adapter: FakeWindowAdapter;
  /** The real controller the gate acts on. */
  readonly controller: PilotInteractionController;
  /** The fake window-event controls, as `main/index.ts` builds them. */
  readonly demo: WindowDemoDriver;
  /** Serves a window channel, or returns null when it is not one. */
  invoke(channelName: string, payload: unknown): Promise<BridgeResult<unknown>> | null;
  /** Subscribes to the window event channel, or returns null. */
  subscribe(channelName: string, listener: (payload: unknown) => void): (() => void) | null;
}

export interface WindowBridgeOptions {
  readonly permissions: ObservationPermissionSource;
  readonly adapter?: FakeWindowAdapter;
  /** Omit the fake window controls, as a build on a real adapter would. */
  readonly demoEvents?: boolean;
}

export function windowBridge(options: WindowBridgeOptions): WindowBridge {
  const harness = windowHarness({
    permissions: options.permissions,
    ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
    demoEvents: options.demoEvents ?? true,
    now: () => 1_700_000_000_000,
  });
  const listeners = new Set<(payload: unknown) => void>();

  harness.gate.subscribe((state) => {
    const encoded = windowGateStateSchema.parse(state);
    for (const listener of [...listeners]) {
      listener(encoded);
    }
  });

  const ok = async (work: () => Promise<unknown> | unknown): Promise<BridgeResult<unknown>> => {
    try {
      return { ok: true, payload: windowGateStateSchema.parse(await work()) };
    } catch (cause) {
      return { ok: false, error: toPilotError(cause).toJSON() };
    }
  };

  return {
    gate: harness.gate,
    adapter: harness.adapter,
    controller: harness.controller,
    demo: harness.demo,
    invoke(channelName: string, payload: unknown): Promise<BridgeResult<unknown>> | null {
      switch (channelName) {
        case windowsGetChannel.name:
          // The panel's first read settles the list, exactly as `DesktopShell`
          // does by refreshing on start and on every reveal.
          return ok(() =>
            harness.gate.snapshot().listedAt === null
              ? harness.gate.refresh()
              : harness.gate.snapshot(),
          );
        case windowsActChannel.name:
          return ok(() => harness.gate.act(windowActionSchema.parse(payload)));
        case demoWindowEventChannel.name:
          return ok(async () => {
            await harness.demo(windowDemoEventSchema.parse(payload));
            // Re-listed before answering, exactly as `DesktopShell` does.
            return harness.gate.refresh();
          });
        default:
          return null;
      }
    },
    subscribe(channelName: string, listener: (payload: unknown) => void): (() => void) | null {
      if (channelName !== windowsChangedEvent.name) {
        return null;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
