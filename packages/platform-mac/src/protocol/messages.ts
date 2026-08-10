import {
  PilotError,
  requestIdSchema,
  serializedPilotErrorSchema,
  type RequestId,
  type SerializedPilotError,
} from '@pilot/shared';
import { z } from 'zod';
import { HELPER_PROTOCOL_VERSION, MAX_FRAME_MESSAGE_BYTES } from './frame.js';

/**
 * The JSON message body carried by a helper frame.
 *
 * The shape deliberately mirrors `@pilot/shared`'s renderer IPC envelopes
 * (`kind` / `protocolVersion` / `id` / `issuedAt` / `payload`) so the two
 * boundaries read the same way. The differences are intentional:
 *
 * - `op` replaces `channel`: helper traffic is a closed set of explicit
 *   operations, not a namespaced channel space.
 * - binary never appears here. It rides in the frame's second body, so the
 *   message stays small, printable and safe to include in a log line's
 *   metadata (never its content — see the logging note in the transport).
 */

/** Longest accepted operation name. */
export const HELPER_OP_NAME_MAX_LENGTH = 64;

const opNameSchema = z
  .string()
  .min(1)
  .max(HELPER_OP_NAME_MAX_LENGTH)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/, 'operation names are lowercase dotted identifiers');

const timestampSchema = z.number().int().nonnegative();

export const helperRequestMessageSchema = z.strictObject({
  kind: z.literal('request'),
  protocolVersion: z.literal(HELPER_PROTOCOL_VERSION),
  id: requestIdSchema,
  op: opNameSchema,
  issuedAt: timestampSchema,
  payload: z.unknown(),
});

export const helperSuccessMessageSchema = z.strictObject({
  kind: z.literal('response'),
  protocolVersion: z.literal(HELPER_PROTOCOL_VERSION),
  id: requestIdSchema,
  op: opNameSchema,
  issuedAt: timestampSchema,
  ok: z.literal(true),
  payload: z.unknown(),
});

export const helperFailureMessageSchema = z.strictObject({
  kind: z.literal('response'),
  protocolVersion: z.literal(HELPER_PROTOCOL_VERSION),
  id: requestIdSchema,
  op: opNameSchema,
  issuedAt: timestampSchema,
  ok: z.literal(false),
  error: serializedPilotErrorSchema,
});

export const helperEventMessageSchema = z.strictObject({
  kind: z.literal('event'),
  protocolVersion: z.literal(HELPER_PROTOCOL_VERSION),
  id: requestIdSchema,
  op: opNameSchema,
  issuedAt: timestampSchema,
  payload: z.unknown(),
});

export const helperMessageSchema = z.union([
  helperRequestMessageSchema,
  helperSuccessMessageSchema,
  helperFailureMessageSchema,
  helperEventMessageSchema,
]);

export type HelperRequestMessage = z.infer<typeof helperRequestMessageSchema>;
export type HelperSuccessMessage = z.infer<typeof helperSuccessMessageSchema>;
export type HelperFailureMessage = z.infer<typeof helperFailureMessageSchema>;
export type HelperResponseMessage = HelperSuccessMessage | HelperFailureMessage;
export type HelperEventMessage = z.infer<typeof helperEventMessageSchema>;
export type HelperMessage = HelperRequestMessage | HelperResponseMessage | HelperEventMessage;

function invalidMessage(message: string, details: Record<string, unknown>): PilotError {
  return new PilotError('invalid-request', message, {
    userMessage: 'Pilot could not talk to its macOS helper.',
    retryable: false,
    details,
  });
}

/** Encodes a message body. Throws `payload-too-large` rather than emitting an unsendable frame. */
export function encodeHelperMessage(message: HelperMessage): string {
  const text = JSON.stringify(message);
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > MAX_FRAME_MESSAGE_BYTES) {
    throw new PilotError('payload-too-large', 'Helper message exceeds the protocol limit', {
      userMessage: 'Pilot tried to send its macOS helper a message that was too large.',
      retryable: false,
      details: { byteLength, limit: MAX_FRAME_MESSAGE_BYTES, op: message.op },
    });
  }
  return text;
}

/**
 * Parses and validates a message body.
 *
 * Version is checked before shape so a helper built against a different
 * protocol reports `protocol-version-mismatch` instead of a pile of schema
 * issues.
 */
export function decodeHelperMessage(body: Uint8Array | string): HelperMessage {
  const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new PilotError('invalid-request', 'Helper message is not valid JSON', {
      userMessage: 'Pilot could not talk to its macOS helper.',
      retryable: false,
      cause,
    });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidMessage('Helper message must be a JSON object', { received: typeof parsed });
  }

  const version = (parsed as { protocolVersion?: unknown }).protocolVersion;
  if (version !== HELPER_PROTOCOL_VERSION) {
    throw new PilotError(
      'protocol-version-mismatch',
      `Unsupported helper protocol version ${String(version)}`,
      {
        userMessage: 'Pilot and its macOS helper are running mismatched versions.',
        retryable: false,
        details: { expected: HELPER_PROTOCOL_VERSION, received: version },
      },
    );
  }

  const result = helperMessageSchema.safeParse(parsed);
  if (!result.success) {
    throw invalidMessage('Helper message failed validation', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export interface MessageMeta {
  readonly id: RequestId;
  readonly issuedAt: number;
}

export function createHelperRequestMessage(
  op: string,
  payload: unknown,
  meta: MessageMeta,
): HelperRequestMessage {
  return {
    kind: 'request',
    protocolVersion: HELPER_PROTOCOL_VERSION,
    id: meta.id,
    op,
    issuedAt: meta.issuedAt,
    payload,
  };
}

export function createHelperSuccessMessage(
  op: string,
  payload: unknown,
  meta: MessageMeta,
): HelperSuccessMessage {
  return {
    kind: 'response',
    protocolVersion: HELPER_PROTOCOL_VERSION,
    id: meta.id,
    op,
    issuedAt: meta.issuedAt,
    ok: true,
    payload,
  };
}

export function createHelperFailureMessage(
  op: string,
  error: SerializedPilotError,
  meta: MessageMeta,
): HelperFailureMessage {
  return {
    kind: 'response',
    protocolVersion: HELPER_PROTOCOL_VERSION,
    id: meta.id,
    op,
    issuedAt: meta.issuedAt,
    ok: false,
    error,
  };
}

export function createHelperEventMessage(
  op: string,
  payload: unknown,
  meta: MessageMeta,
): HelperEventMessage {
  return {
    kind: 'event',
    protocolVersion: HELPER_PROTOCOL_VERSION,
    id: meta.id,
    op,
    issuedAt: meta.issuedAt,
    payload,
  };
}
