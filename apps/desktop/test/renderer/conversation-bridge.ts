import { toPilotError, type SpeechRecognitionDisclosure } from '@pilot/shared';
import type { FakeInteractionController, FakeHotkeyAdapter } from '@pilot/platform/fakes';
import type { HotkeyAvailability } from '@pilot/platform';
import type { BridgeResult } from '../../src/ipc/bridge.js';
import {
  conversationActChannel,
  conversationChangedEvent,
  conversationGetChannel,
  demoConversationChannel,
} from '../../src/ipc/channels.js';
import {
  conversationActionSchema,
  conversationFixtureSchema,
  conversationGateStateSchema,
} from '../../src/ipc/schemas.js';
import type { ConversationGate } from '../../src/main/conversation-gate.js';
import type {
  ConversationFixtureDriver,
  ReplayClock,
} from '../../src/main/conversation-fixtures.js';
import { conversationHarness } from '../main/support.js';

/**
 * The conversation half of the panel's bridge, backed by the real gate.
 *
 * Same shape and same reason as `window-bridge.ts`: the renderer tests talk to
 * an actual {@link ConversationGate}, with both directions schema-checked
 * exactly as the preload checks them. A telemetry sample that could not survive
 * the wire — because someone added a field carrying text to it — fails here
 * rather than in production.
 */

export interface ConversationBridge {
  readonly gate: ConversationGate;
  readonly clock: ReplayClock;
  readonly hotkeyAdapter: FakeHotkeyAdapter;
  readonly replay: ConversationFixtureDriver;
  invoke(channelName: string, payload: unknown): Promise<BridgeResult<unknown>> | null;
  subscribe(channelName: string, listener: (payload: unknown) => void): (() => void) | null;
}

export interface ConversationBridgeOptions {
  readonly controller: FakeInteractionController;
  readonly hotkey?: HotkeyAvailability;
  readonly withHotkey?: boolean;
  readonly disclosure?: SpeechRecognitionDisclosure;
  readonly capacity?: number;
}

export function conversationBridge(options: ConversationBridgeOptions): ConversationBridge {
  const harness = conversationHarness({
    controller: options.controller,
    ...(options.hotkey === undefined ? {} : { hotkey: options.hotkey }),
    ...(options.withHotkey === undefined ? {} : { withHotkey: options.withHotkey }),
    ...(options.disclosure === undefined ? {} : { disclosure: options.disclosure }),
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
  });
  const listeners = new Set<(payload: unknown) => void>();
  let refreshed = false;

  harness.gate.subscribe((state) => {
    const encoded = conversationGateStateSchema.parse(state);
    for (const listener of [...listeners]) {
      listener(encoded);
    }
  });

  const ok = async (work: () => Promise<unknown> | unknown): Promise<BridgeResult<unknown>> => {
    try {
      return { ok: true, payload: conversationGateStateSchema.parse(await work()) };
    } catch (cause) {
      return { ok: false, error: toPilotError(cause).toJSON() };
    }
  };

  return {
    gate: harness.gate,
    clock: harness.clock,
    hotkeyAdapter: harness.hotkeyAdapter,
    replay: harness.replay,
    invoke(channelName: string, payload: unknown): Promise<BridgeResult<unknown>> | null {
      switch (channelName) {
        case conversationGetChannel.name:
          // The panel's first read settles the voice facts, exactly as
          // `DesktopShell` does by refreshing on start and on every reveal.
          return ok(() => {
            if (refreshed) {
              return harness.gate.snapshot();
            }
            refreshed = true;
            return harness.gate.refresh();
          });
        case conversationActChannel.name:
          return ok(() => harness.gate.act(conversationActionSchema.parse(payload)));
        case demoConversationChannel.name:
          return ok(() => {
            const fixture = conversationFixtureSchema.parse(payload);
            harness.replay(fixture);
            return harness.gate.noteFixture(fixture);
          });
        default:
          return null;
      }
    },
    subscribe(channelName: string, listener: (payload: unknown) => void): (() => void) | null {
      if (channelName !== conversationChangedEvent.name) {
        return null;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
