import {
  deserializePilotError,
  PilotError,
  type ChannelRequest,
  type ChannelResponse,
} from '@pilot/shared';
import type { AnyEventChannel, AnyRequestChannel } from '../ipc/channels.js';
import type { BridgeResult, PilotBridge } from '../ipc/bridge.js';

declare global {
  interface Window {
    /** Injected by the preload. Absent when the bridge failed to load. */
    readonly pilotBridge?: PilotBridge;
  }
}

/**
 * Renderer-side IPC client.
 *
 * Converts the bridge's serialized results back into typed `PilotError`s so the
 * UI can switch on `code`, and gives the panel one place to detect that the
 * preload never ran. That last case is not hypothetical — a preload failure
 * produces a blank window, which is exactly the silent failure the delivery
 * rules forbid — so it is modelled as a first-class state rather than an
 * exception.
 */

export class PilotClient {
  readonly #bridge: PilotBridge;

  private constructor(bridge: PilotBridge) {
    this.#bridge = bridge;
  }

  static fromWindow(target: Window = window): PilotClient | null {
    const bridge = target.pilotBridge;
    return bridge === undefined ? null : new PilotClient(bridge);
  }

  get protocolVersion(): number {
    return this.#bridge.protocolVersion;
  }

  async invoke<Channel extends AnyRequestChannel>(
    channel: Channel,
    payload: ChannelRequest<Channel>,
  ): Promise<ChannelResponse<Channel>> {
    const result: BridgeResult<unknown> = await this.#bridge.invoke(channel.name, payload);
    if (!result.ok) {
      throw deserializePilotError(result.error);
    }
    return result.payload as ChannelResponse<Channel>;
  }

  subscribe<Payload>(channel: AnyEventChannel, listener: (payload: Payload) => void): () => void {
    return this.#bridge.subscribe(channel.name, (payload) => listener(payload as Payload));
  }
}

export const BRIDGE_MISSING_ERROR = new PilotError(
  'platform-unavailable',
  'The preload bridge was not injected into the renderer',
  {
    userMessage:
      'Pilot could not connect its window to the application. Quit Pilot and open it again.',
  },
);
