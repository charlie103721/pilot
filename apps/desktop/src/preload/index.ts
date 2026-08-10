import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  createRequestEnvelope,
  IPC_PROTOCOL_VERSION,
  parseEventEnvelope,
  parseResponseEnvelope,
  PilotError,
  toPilotError,
  type RequestId,
} from '@pilot/shared';
import {
  findEventChannel,
  findRequestChannel,
  IPC_TRANSPORT,
  PRELOAD_BRIDGE_KEY,
} from '../ipc/channels.js';
import type { BridgeResult, PilotBridge } from '../ipc/bridge.js';

/**
 * Context-isolated bridge.
 *
 * The renderer never sees `ipcRenderer`, a channel object, or anything from
 * Node. It gets two functions over named logical channels, and both ends of
 * every message are schema-checked: the request payload here before it leaves
 * the renderer world, the response here again before it is handed back, and —
 * authoritatively — in the main process, which trusts nothing this file does.
 *
 * This file is bundled to CommonJS on purpose: `sandbox: true` preloads cannot
 * use ES modules.
 */

let sequence = 0;

function nextRequestId(): RequestId {
  sequence += 1;
  return `req-renderer-${String(sequence).padStart(6, '0')}` as RequestId;
}

function failure(error: unknown): BridgeResult<never> {
  return { ok: false, error: toPilotError(error).toJSON() };
}

const bridge: PilotBridge = {
  protocolVersion: IPC_PROTOCOL_VERSION,

  async invoke(channelName: string, payload: unknown): Promise<BridgeResult<unknown>> {
    const channel = findRequestChannel(channelName);
    if (channel === undefined) {
      return failure(
        new PilotError('unknown-channel', `Unknown channel "${channelName}"`, {
          userMessage: 'Pilot tried to use a channel that does not exist.',
          details: { channel: channelName },
        }),
      );
    }
    try {
      const envelope = createRequestEnvelope(channel, payload, {
        id: nextRequestId(),
        issuedAt: Date.now(),
      });
      const raw: unknown = await ipcRenderer.invoke(IPC_TRANSPORT.request, envelope);
      const { payload: response } = parseResponseEnvelope(channel, raw);
      return { ok: true, payload: response };
    } catch (cause) {
      return failure(cause);
    }
  },

  subscribe(channelName: string, listener: (payload: unknown) => void): () => void {
    const channel = findEventChannel(channelName);
    if (channel === undefined) {
      // Nothing to subscribe to; return a no-op rather than throwing across the
      // bridge, and let the renderer notice through its own bookkeeping.
      return () => undefined;
    }
    const handler = (_event: IpcRendererEvent, raw: unknown): void => {
      try {
        const { payload } = parseEventEnvelope(channel, raw);
        listener(payload);
      } catch {
        // A malformed event from main is a bug in main, not something the
        // renderer can act on. Drop it rather than tearing down the panel.
      }
    };
    ipcRenderer.on(IPC_TRANSPORT.event, handler);
    return () => {
      ipcRenderer.removeListener(IPC_TRANSPORT.event, handler);
    };
  },
};

contextBridge.exposeInMainWorld(PRELOAD_BRIDGE_KEY, bridge);
