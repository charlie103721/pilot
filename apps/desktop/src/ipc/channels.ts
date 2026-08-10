import {
  defineChannel,
  defineEventChannel,
  type ChannelDefinition,
  type EventChannelDefinition,
} from '@pilot/shared';
import {
  acknowledgementSchema,
  appInfoSchema,
  conversationActionSchema,
  conversationFixtureSchema,
  conversationGateStateSchema,
  emptyPayloadSchema,
  interactionCommandSchema,
  panelVisibilitySchema,
  permissionActionSchema,
  permissionFixtureSchema,
  permissionGateStateSchema,
  pilotViewStateSchema,
  setPanelVisibleSchema,
  windowActionSchema,
  windowDemoEventSchema,
  windowGateStateSchema,
} from './schemas.js';
// PR-037 — Codex subscription profile. The channels are defined in their own
// file (`codex-channels.ts`) and imported here only so the catalogue arrays
// below can list them; consumers import them from that file directly.
import { codexActChannel, codexChangedEvent, codexGetChannel } from './codex-channels.js';

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

/** Current permission state, read on mount and whenever the panel reopens. */
export const permissionsGetChannel = defineChannel({
  name: 'pilot:permissions/get',
  direction: 'renderer-to-main',
  request: emptyPayloadSchema,
  response: permissionGateStateSchema,
});

/**
 * Every permission action the panel can take — recheck, prompt, open settings,
 * dismiss the last refusal — as one validated discriminated union, so adding an
 * affordance later cannot add an unvalidated channel by accident.
 */
export const permissionsActChannel = defineChannel({
  name: 'pilot:permissions/act',
  direction: 'renderer-to-main',
  request: permissionActionSchema,
  response: permissionGateStateSchema,
});

/**
 * Loads a named permission fixture. Development builds only — the real
 * permission adapter (PR-011) has no fixtures and the handler refuses.
 */
export const demoPermissionFixtureChannel = defineChannel({
  name: 'pilot:demo/apply-permissions',
  direction: 'renderer-to-main',
  request: permissionFixtureSchema,
  response: permissionGateStateSchema,
});

/** The observable window list, read on mount and whenever the panel reopens. */
export const windowsGetChannel = defineChannel({
  name: 'pilot:windows/get',
  direction: 'renderer-to-main',
  request: emptyPayloadSchema,
  response: windowGateStateSchema,
});

/**
 * Every observation control the panel can operate — select, start, stop, pause,
 * resume, re-list, dismiss the §16 prompt — as one validated discriminated
 * union, so a new control cannot arrive without a validator behind it.
 */
export const windowsActChannel = defineChannel({
  name: 'pilot:windows/act',
  direction: 'renderer-to-main',
  request: windowActionSchema,
  response: windowGateStateSchema,
});

/**
 * Causes a window-lifecycle event in the fake window adapter. Development
 * builds only — a build on the real macOS adapter (PR-011) has no such control
 * and the handler refuses.
 */
export const demoWindowEventChannel = defineChannel({
  name: 'pilot:demo/window-event',
  direction: 'renderer-to-main',
  request: windowDemoEventSchema,
  response: windowGateStateSchema,
});

/**
 * The conversation panel's own state: developer telemetry, push-to-talk
 * availability and the speech-recognition disclosure. Read on mount and
 * whenever the panel reopens.
 */
export const conversationGetChannel = defineChannel({
  name: 'pilot:conversation/get',
  direction: 'renderer-to-main',
  request: emptyPayloadSchema,
  response: conversationGateStateSchema,
});

/**
 * Every conversation-panel action that is not a command to the interaction
 * controller — clearing the ring buffer, opening the diagnostics surface — as
 * one validated discriminated union, so a new affordance cannot arrive without
 * a validator behind it.
 */
export const conversationActChannel = defineChannel({
  name: 'pilot:conversation/act',
  direction: 'renderer-to-main',
  request: conversationActionSchema,
  response: conversationGateStateSchema,
});

/**
 * Replays a named fixture conversation. Development builds only — a build with
 * a real agent and recogniser has no fixtures and the handler refuses.
 */
export const demoConversationChannel = defineChannel({
  name: 'pilot:demo/conversation',
  direction: 'renderer-to-main',
  request: conversationFixtureSchema,
  response: conversationGateStateSchema,
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

/**
 * Pushed whenever permissions change, including changes Pilot did not cause —
 * the user granting Screen Recording in System Settings while the panel is
 * open. Without this the only way to notice would be to restart the app, which
 * system-design §16 does not allow us to ask for.
 */
export const permissionsChangedEvent = defineEventChannel({
  name: 'pilot:permissions/changed',
  payload: permissionGateStateSchema,
});

/**
 * Pushed whenever the window list or the observation prompt changes, including
 * changes Pilot did not cause — the user closing the window Pilot was watching.
 * system-design §16 requires that to be visible immediately, so it is an event
 * and not something the panel discovers by polling.
 */
export const windowsChangedEvent = defineEventChannel({
  name: 'pilot:windows/changed',
  payload: windowGateStateSchema,
});

/**
 * Pushed whenever the telemetry ring buffer or a voice fact changes. An event
 * rather than something the panel polls for, because the ring is written from
 * the view-state stream: polling would show a diagnostics surface that lags the
 * conversation it is describing.
 */
export const conversationChangedEvent = defineEventChannel({
  name: 'pilot:conversation/changed',
  payload: conversationGateStateSchema,
});

/** Every request channel, in registration order. */
export const REQUEST_CHANNELS = [
  appInfoChannel,
  viewStateGetChannel,
  interactionDispatchChannel,
  panelSetVisibleChannel,
  permissionsGetChannel,
  permissionsActChannel,
  windowsGetChannel,
  windowsActChannel,
  conversationGetChannel,
  conversationActChannel,
  demoPermissionFixtureChannel,
  demoWindowEventChannel,
  demoConversationChannel,
  quitChannel,
  codexGetChannel,
  codexActChannel,
] as const;

/** Every event channel. */
export const EVENT_CHANNELS = [
  viewStateChangedEvent,
  panelVisibilityEvent,
  permissionsChangedEvent,
  windowsChangedEvent,
  conversationChangedEvent,
  codexChangedEvent,
] as const;

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
