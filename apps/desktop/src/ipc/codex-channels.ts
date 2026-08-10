import { defineChannel, defineEventChannel } from '@pilot/shared';
import { emptyPayloadSchema } from './schemas.js';
import { codexActionSchema, codexGateStateSchema } from './codex-schemas.js';

/**
 * The Codex profile's channels (PR-037).
 *
 * Three of them, in their own file so PR-038 and PR-039 can add theirs without
 * a three-way conflict; `ipc/channels.ts` gains only the catalogue entries,
 * which union cleanly (`docs/runbook.md` cross-lane issue 8: union the *lists*).
 */

/** Current Codex status, read on mount and whenever the panel reopens. */
export const codexGetChannel = defineChannel({
  name: 'pilot:codex/get',
  direction: 'renderer-to-main',
  request: emptyPayloadSchema,
  response: codexGateStateSchema,
});

/** Refresh, sign in, cancel a sign-in, sign out. */
export const codexActChannel = defineChannel({
  name: 'pilot:codex/act',
  direction: 'renderer-to-main',
  request: codexActionSchema,
  response: codexGateStateSchema,
});

/**
 * Pushed whenever the Codex status changes, including changes the panel did not
 * cause: the device code arriving, the sign-in being approved in a browser on
 * another machine, or a token expiring while the panel is open. A sign-in the
 * user has to complete elsewhere cannot be a request/response.
 */
export const codexChangedEvent = defineEventChannel({
  name: 'pilot:codex/changed',
  payload: codexGateStateSchema,
});
