import { z } from 'zod';
import { HELPER_PROTOCOL_VERSION } from './frame.js';

/**
 * The closed set of operations the helper exposes (system-design §4:
 * "restricted to explicit operations").
 *
 * PR-003 ships transport only: `health` and `echo`. PR-011 onward add
 * permissions, window enumeration, capture, pointer and speech operations by
 * appending to this table — the transport itself never grows a generic
 * "run anything" call.
 */

export interface HelperOperation<Request, Response> {
  readonly name: string;
  readonly request: z.ZodType<Request>;
  readonly response: z.ZodType<Response>;
  /** Whether a request for this operation may attach a binary payload. */
  readonly requestBinary: boolean;
  /** Whether a response for this operation may attach a binary payload. */
  readonly responseBinary: boolean;
}

export function defineHelperOperation<Request, Response>(
  operation: HelperOperation<Request, Response>,
): HelperOperation<Request, Response> {
  return operation;
}

export type HelperOperationRequest<O> = O extends HelperOperation<infer R, unknown> ? R : never;
export type HelperOperationResponse<O> = O extends HelperOperation<unknown, infer R> ? R : never;

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
} as const;

export const HELPER_OPERATION_NAMES: readonly string[] = Object.values(HELPER_OPERATIONS).map(
  (operation) => operation.name,
);
