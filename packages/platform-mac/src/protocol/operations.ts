import { z } from 'zod';
import {
  accessibilityElementAtOperation,
  accessibilitySampleOperation,
} from './accessibility-ops.js';
import { HELPER_PROTOCOL_VERSION } from './frame.js';
import {
  defineHelperOperation,
  type HelperOperation,
  type HelperOperationRequest,
  type HelperOperationResponse,
} from './operation-kit.js';
import {
  permissionAttributionOperation,
  permissionOpenSettingsOperation,
  permissionRequestOperation,
  permissionSnapshotOperation,
  permissionStatusOperation,
} from './permission-ops.js';
import { windowGetOperation, windowListOperation } from './window-ops.js';

/**
 * The closed set of operations the helper exposes (system-design §4:
 * "restricted to explicit operations").
 *
 * PR-003 shipped transport only: `health` and `echo`. PR-011 appends the
 * permission and window operations; PR-013 appends the accessibility ones. The
 * transport itself never grows a generic "run anything" call, and
 * `HELPER_PROTOCOL_VERSION` is unchanged — adding operations is backwards
 * compatible in both directions, because an unknown operation is already a
 * typed `invalid-request` on the helper and an unregistered response is already
 * a typed `invalid-request` on the host.
 */

export {
  defineHelperOperation,
  type HelperOperation,
  type HelperOperationRequest,
  type HelperOperationResponse,
};

/** Liveness probe. Also the startup handshake — a helper that cannot answer it is not up. */
export const healthOperation = defineHelperOperation({
  name: 'health',
  request: z.strictObject({}),
  response: z.strictObject({
    status: z.literal('ok'),
    helperVersion: z.string().min(1).max(64),
    protocolVersion: z.literal(HELPER_PROTOCOL_VERSION),
    pid: z.number().int().nonnegative(),
    uptimeMs: z.number().int().nonnegative(),
  }),
  requestBinary: false,
  responseBinary: false,
});

export const ECHO_TEXT_MAX_LENGTH = 4096;

/**
 * Round-trips a short text and an optional binary payload. This is the
 * transport's own conformance test: it is the only operation that exercises
 * the binary body end to end until PR-012.
 */
export const echoOperation = defineHelperOperation({
  name: 'echo',
  request: z.strictObject({
    text: z.string().max(ECHO_TEXT_MAX_LENGTH),
  }),
  response: z.strictObject({
    text: z.string().max(ECHO_TEXT_MAX_LENGTH),
    binaryLength: z.number().int().nonnegative(),
  }),
  requestBinary: true,
  responseBinary: true,
});

export type HealthRequest = HelperOperationRequest<typeof healthOperation>;
export type HealthResponse = HelperOperationResponse<typeof healthOperation>;
export type EchoRequest = HelperOperationRequest<typeof echoOperation>;
export type EchoResponse = HelperOperationResponse<typeof echoOperation>;

/** Event emitted by the helper once it is ready to serve requests. */
export const HELPER_READY_EVENT = 'helper.ready';

export const helperReadyEventSchema = z.strictObject({
  helperVersion: z.string().min(1).max(64),
  protocolVersion: z.literal(HELPER_PROTOCOL_VERSION),
  pid: z.number().int().nonnegative(),
});

export type HelperReadyEvent = z.infer<typeof helperReadyEventSchema>;

export const HELPER_OPERATIONS = {
  health: healthOperation,
  echo: echoOperation,
  // PR-011
  permissionStatus: permissionStatusOperation,
  permissionSnapshot: permissionSnapshotOperation,
  permissionRequest: permissionRequestOperation,
  permissionOpenSettings: permissionOpenSettingsOperation,
  permissionAttribution: permissionAttributionOperation,
  windowList: windowListOperation,
  windowGet: windowGetOperation,
  // PR-013
  accessibilitySample: accessibilitySampleOperation,
  accessibilityElementAt: accessibilityElementAtOperation,
} as const;

export const HELPER_OPERATION_NAMES: readonly string[] = Object.values(HELPER_OPERATIONS).map(
  (operation) => operation.name,
);
