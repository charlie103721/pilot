import {
  defineChannel,
  defineEventChannel,
  type ChannelDefinition,
  type EventChannelDefinition,
} from '@pilot/shared';
import {
  acknowledgementSchema,
  appInfoSchema,
  emptyPayloadSchema,
  interactionCommandSchema,
  panelVisibilitySchema,
  pilotViewStateSchema,
  setPanelVisibleSchema,
  viewScenarioSchema,
} from './schemas.js';

/**
 * The renderer ↔ main channel catalogue.
 *
 * PR-001 shipped the envelope machinery (`defineChannel`, `parseRequestEnvelope`)
 * but deliberately left the catalogue itself to the desktop lane. This file is
 * that catalogue: every renderer → main message and every main → renderer event
 * in the MVP shell is named here exactly once, with schemas for both
 * directions. Later desktop PRs (PR-008 permissions, PR-009 window picker,
 * PR-010 conversation panel) extend this file rather than inventing channel
 * names of their own.
 *
 * Naming: `pilot:<area>/<action>`. Request channels are always
 * `renderer-to-main` — the renderer never serves a request, because the main
 * process must not depend on an unprivileged process answering.
 *
 * Nothing here carries credentials or capture handles (system-design §4, §14):
 * the view state contains text and metadata only, and frames never enter an
 * envelope.
 */

/**
 * Physical Electron IPC channels. Every logical channel above is multiplexed
 * over these two, so the main process has exactly one `ipcMain.handle` entry
 * point to validate and there is no way to add an unvalidated back door by
 * registering another raw listener.
 */
export const IPC_TRANSPORT = {
  /** `ipcRenderer.invoke` → `ipcMain.handle`. Carries a request envelope. */
  request: 'pilot:transport/request',
  /** `webContents.send` → `ipcRenderer.on`. Carries an event envelope. */
  event: 'pilot:transport/event',
} as const;

/** Name exposed on `window` by the preload bridge. */
export const PRELOAD_BRIDGE_KEY = 'pilotBridge';

export const appInfoChannel = defineChannel({
  name: 'pilot:app/info',
  direction: 'renderer-to-main',
  request: emptyPayloadSchema,
  response: appInfoSchema,
});

export const viewStateGetChannel = defineChannel({
  name: 'pilot:view-state/get',
  direction: 'renderer-to-main',
  request: emptyPayloadSchema,
  response: pilotViewStateSchema,
});

export const interactionDispatchChannel = defineChannel({
  name: 'pilot:interaction/dispatch',
  direction: 'renderer-to-main',
  request: interactionCommandSchema,
  response: pilotViewStateSchema,
});

export const panelSetVisibleChannel = defineChannel({
  name: 'pilot:panel/set-visible',
  direction: 'renderer-to-main',
  request: setPanelVisibleSchema,
  response: panelVisibilitySchema,
});

/**
 * Drives the fake shell into a named visible state. PR-002 only — the real
 * states come from the interaction lane, and this channel is removed when
 * PR-010 wires the real controller.
 */
export const demoScenarioChannel = defineChannel({
  name: 'pilot:demo/apply-scenario',
  direction: 'renderer-to-main',
  request: viewScenarioSchema,
  response: pilotViewStateSchema,
});

export const quitChannel = defineChannel({
  name: 'pilot:app/quit',
  direction: 'renderer-to-main',
  request: emptyPayloadSchema,
  response: acknowledgementSchema,
});

export const viewStateChangedEvent = defineEventChannel({
  name: 'pilot:view-state/changed',
  payload: pilotViewStateSchema,
});

export const panelVisibilityEvent = defineEventChannel({
  name: 'pilot:panel/visibility',
  payload: panelVisibilitySchema,
});

/** Every request channel, in registration order. */
export const REQUEST_CHANNELS = [
  appInfoChannel,
  viewStateGetChannel,
  interactionDispatchChannel,
  panelSetVisibleChannel,
  demoScenarioChannel,
  quitChannel,
] as const;

/** Every event channel. */
export const EVENT_CHANNELS = [viewStateChangedEvent, panelVisibilityEvent] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the catalogue is heterogeneous by design; lookups re-validate through the channel's own schemas.
export type AnyRequestChannel = ChannelDefinition<any, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above.
export type AnyEventChannel = EventChannelDefinition<any>;

const REQUEST_CHANNELS_BY_NAME: ReadonlyMap<string, AnyRequestChannel> = new Map(
  REQUEST_CHANNELS.map((channel) => [channel.name, channel as AnyRequestChannel]),
);

const EVENT_CHANNELS_BY_NAME: ReadonlyMap<string, AnyEventChannel> = new Map(
  EVENT_CHANNELS.map((channel) => [channel.name, channel as AnyEventChannel]),
);

export function findRequestChannel(name: string): AnyRequestChannel | undefined {
  return REQUEST_CHANNELS_BY_NAME.get(name);
}

export function findEventChannel(name: string): AnyEventChannel | undefined {
  return EVENT_CHANNELS_BY_NAME.get(name);
}
