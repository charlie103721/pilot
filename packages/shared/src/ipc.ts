import { z } from 'zod';
import { CONTRACT_VERSION } from './contract.js';
import { PilotError, serializedPilotErrorSchema, type SerializedPilotError } from './errors.js';
import { requestIdSchema, type RequestId } from './ids.js';

/**
 * Versioned IPC envelopes with runtime validation.
 *
 * Every message crossing renderer ↔ main (and, framed differently, main ↔
 * native helper) is wrapped in one of these envelopes. The main process
 * validates every renderer payload (system-design §14) using
 * {@link parseRequestEnvelope}; nothing downstream accepts an unvalidated
 * payload.
 *
 * Envelopes carry no binary data. Frames and audio never travel in an
 * envelope; they use the helper's binary payload channel or stay in the main
 * process entirely.
 */

export const IPC_PROTOCOL_VERSION = CONTRACT_VERSION;

/** Hard ceiling on one encoded envelope. Enforced before parsing. */
export const MAX_IPC_MESSAGE_BYTES = 1_048_576;

const timestamp = z.number().int().nonnegative();

export const requestEnvelopeSchema = z.strictObject({
  kind: z.literal('request'),
  protocolVersion: z.literal(IPC_PROTOCOL_VERSION),
  id: requestIdSchema,
  channel: z.string().min(1).max(128),
  issuedAt: timestamp,
  payload: z.unknown(),
});

export const successResponseEnvelopeSchema = z.strictObject({
  kind: z.literal('response'),
  protocolVersion: z.literal(IPC_PROTOCOL_VERSION),
  id: requestIdSchema,
  channel: z.string().min(1).max(128),
  issuedAt: timestamp,
  ok: z.literal(true),
  payload: z.unknown(),
});

export const failureResponseEnvelopeSchema = z.strictObject({
  kind: z.literal('response'),
  protocolVersion: z.literal(IPC_PROTOCOL_VERSION),
  id: requestIdSchema,
  channel: z.string().min(1).max(128),
  issuedAt: timestamp,
  ok: z.literal(false),
  error: serializedPilotErrorSchema,
});

export const responseEnvelopeSchema = z.discriminatedUnion('ok', [
  successResponseEnvelopeSchema,
  failureResponseEnvelopeSchema,
]);

export const eventEnvelopeSchema = z.strictObject({
  kind: z.literal('event'),
  protocolVersion: z.literal(IPC_PROTOCOL_VERSION),
  id: requestIdSchema,
  channel: z.string().min(1).max(128),
  issuedAt: timestamp,
  payload: z.unknown(),
});

export const ipcEnvelopeSchema = z.union([
  requestEnvelopeSchema,
  successResponseEnvelopeSchema,
  failureResponseEnvelopeSchema,
  eventEnvelopeSchema,
]);

export type RequestEnvelope = z.infer<typeof requestEnvelopeSchema>;
export type SuccessResponseEnvelope = z.infer<typeof successResponseEnvelopeSchema>;
export type FailureResponseEnvelope = z.infer<typeof failureResponseEnvelopeSchema>;
export type ResponseEnvelope = SuccessResponseEnvelope | FailureResponseEnvelope;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type IpcEnvelope = RequestEnvelope | ResponseEnvelope | EventEnvelope;

export type ChannelDirection = 'renderer-to-main' | 'main-to-renderer';

/** A request/response channel with schemas for both directions. */
export interface ChannelDefinition<Request, Response> {
  readonly name: string;
  readonly direction: ChannelDirection;
  readonly request: z.ZodType<Request>;
  readonly response: z.ZodType<Response>;
}

/** A one-way event channel. */
export interface EventChannelDefinition<Payload> {
  readonly name: string;
  readonly payload: z.ZodType<Payload>;
}

export function defineChannel<Request, Response>(
  definition: ChannelDefinition<Request, Response>,
): ChannelDefinition<Request, Response> {
  return definition;
}

export function defineEventChannel<Payload>(
  definition: EventChannelDefinition<Payload>,
): EventChannelDefinition<Payload> {
  return definition;
}

export type ChannelRequest<C> = C extends ChannelDefinition<infer R, unknown> ? R : never;
export type ChannelResponse<C> = C extends ChannelDefinition<unknown, infer R> ? R : never;

function invalid(message: string, details: Record<string, unknown>): PilotError {
  return new PilotError('invalid-request', message, {
    userMessage: 'Pilot received a message it could not process.',
    details,
  });
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw invalid(`Invalid ${what}`, {
      what,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export interface EnvelopeMeta {
  readonly id: RequestId;
  readonly issuedAt: number;
}

export function createRequestEnvelope<Request, Response>(
  channel: ChannelDefinition<Request, Response>,
  payload: Request,
  meta: EnvelopeMeta,
): RequestEnvelope {
  return {
    kind: 'request',
    protocolVersion: IPC_PROTOCOL_VERSION,
    id: meta.id,
    channel: channel.name,
    issuedAt: meta.issuedAt,
    payload: parseWith(channel.request, payload, `request payload for ${channel.name}`),
  };
}

export function createSuccessResponseEnvelope<Request, Response>(
  channel: ChannelDefinition<Request, Response>,
  request: RequestEnvelope,
  payload: Response,
  issuedAt: number,
): SuccessResponseEnvelope {
  return {
    kind: 'response',
    protocolVersion: IPC_PROTOCOL_VERSION,
    id: request.id,
    channel: channel.name,
    issuedAt,
    ok: true,
    payload: parseWith(channel.response, payload, `response payload for ${channel.name}`),
  };
}

export function createFailureResponseEnvelope(
  request: RequestEnvelope,
  error: PilotError,
  issuedAt: number,
): FailureResponseEnvelope {
  return {
    kind: 'response',
    protocolVersion: IPC_PROTOCOL_VERSION,
    id: request.id,
    channel: request.channel,
    issuedAt,
    ok: false,
    error: error.toJSON(),
  };
}

export function createEventEnvelope<Payload>(
  channel: EventChannelDefinition<Payload>,
  payload: Payload,
  meta: EnvelopeMeta,
): EventEnvelope {
  return {
    kind: 'event',
    protocolVersion: IPC_PROTOCOL_VERSION,
    id: meta.id,
    channel: channel.name,
    issuedAt: meta.issuedAt,
    payload: parseWith(channel.payload, payload, `event payload for ${channel.name}`),
  };
}

/** Validates the envelope shape only, without knowing the channel. */
export function parseEnvelope(raw: unknown): IpcEnvelope {
  assertProtocolVersion(raw);
  return parseWith(ipcEnvelopeSchema, raw, 'IPC envelope') as IpcEnvelope;
}

function assertProtocolVersion(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) {
    throw invalid('IPC envelope must be an object', { received: typeof raw });
  }
  const version = (raw as { protocolVersion?: unknown }).protocolVersion;
  if (version !== undefined && version !== IPC_PROTOCOL_VERSION) {
    throw new PilotError(
      'protocol-version-mismatch',
      `Unsupported IPC protocol version ${String(version)}`,
      {
        userMessage: 'Pilot components are running mismatched versions. Restart Pilot.',
        details: { expected: IPC_PROTOCOL_VERSION, received: version },
      },
    );
  }
}

/** Validates an incoming request against a specific channel. */
export function parseRequestEnvelope<Request, Response>(
  channel: ChannelDefinition<Request, Response>,
  raw: unknown,
): { envelope: RequestEnvelope; payload: Request } {
  assertProtocolVersion(raw);
  const envelope = parseWith(requestEnvelopeSchema, raw, 'request envelope');
  if (envelope.channel !== channel.name) {
    throw new PilotError('unknown-channel', `Envelope is for channel "${envelope.channel}"`, {
      userMessage: 'Pilot received a message for an unknown channel.',
      details: { expected: channel.name, received: envelope.channel },
    });
  }
  return {
    envelope,
    payload: parseWith(channel.request, envelope.payload, `request payload for ${channel.name}`),
  };
}

export function parseResponseEnvelope<Request, Response>(
  channel: ChannelDefinition<Request, Response>,
  raw: unknown,
): { envelope: ResponseEnvelope; payload: Response } {
  assertProtocolVersion(raw);
  const envelope = parseWith(responseEnvelopeSchema, raw, 'response envelope') as ResponseEnvelope;
  if (envelope.channel !== channel.name) {
    throw new PilotError('unknown-channel', `Envelope is for channel "${envelope.channel}"`, {
      userMessage: 'Pilot received a message for an unknown channel.',
      details: { expected: channel.name, received: envelope.channel },
    });
  }
  if (!envelope.ok) {
    throw deserializeEnvelopeError(envelope.error);
  }
  return {
    envelope,
    payload: parseWith(channel.response, envelope.payload, `response payload for ${channel.name}`),
  };
}

export function parseEventEnvelope<Payload>(
  channel: EventChannelDefinition<Payload>,
  raw: unknown,
): { envelope: EventEnvelope; payload: Payload } {
  assertProtocolVersion(raw);
  const envelope = parseWith(eventEnvelopeSchema, raw, 'event envelope');
  if (envelope.channel !== channel.name) {
    throw new PilotError('unknown-channel', `Envelope is for channel "${envelope.channel}"`, {
      userMessage: 'Pilot received a message for an unknown channel.',
      details: { expected: channel.name, received: envelope.channel },
    });
  }
  return {
    envelope,
    payload: parseWith(channel.payload, envelope.payload, `event payload for ${channel.name}`),
  };
}

function deserializeEnvelopeError(error: SerializedPilotError): PilotError {
  return new PilotError(error.code, error.message, {
    userMessage: error.userMessage,
    retryable: error.retryable,
    ...(error.details === undefined ? {} : { details: error.details }),
  });
}

export function encodeEnvelope(envelope: IpcEnvelope): string {
  const text = JSON.stringify(envelope);
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > MAX_IPC_MESSAGE_BYTES) {
    throw new PilotError('payload-too-large', 'IPC envelope exceeds the size limit', {
      userMessage: 'Pilot tried to send a message that was too large.',
      details: { byteLength, limit: MAX_IPC_MESSAGE_BYTES, channel: envelope.channel },
    });
  }
  return text;
}

export function decodeEnvelope(text: string): IpcEnvelope {
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > MAX_IPC_MESSAGE_BYTES) {
    throw new PilotError('payload-too-large', 'IPC envelope exceeds the size limit', {
      userMessage: 'Pilot received a message that was too large.',
      details: { byteLength, limit: MAX_IPC_MESSAGE_BYTES },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new PilotError('invalid-request', 'IPC envelope is not valid JSON', {
      userMessage: 'Pilot received a malformed message.',
      cause,
    });
  }
  return parseEnvelope(parsed);
}
