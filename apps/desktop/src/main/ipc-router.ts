import {
  createFailureResponseEnvelope,
  createSuccessResponseEnvelope,
  MAX_IPC_MESSAGE_BYTES,
  parseRequestEnvelope,
  PilotError,
  toPilotError,
  requestIdSchema,
  IPC_PROTOCOL_VERSION,
  type ChannelRequest,
  type ChannelResponse,
  type Logger,
  type RequestEnvelope,
  type RequestId,
  type ResponseEnvelope,
} from '@pilot/shared';
import { nullLogger } from '@pilot/shared';
import { findRequestChannel, type AnyRequestChannel } from '../ipc/channels.js';

/**
 * Renderer → main request router.
 *
 * This module is the single place a renderer payload becomes a typed value.
 * It deliberately does not import `electron`: the electron adapter
 * (`main/index.ts`) hands raw structured-clone values in and gets response
 * envelopes back, so every rule here is unit-testable without a browser.
 *
 * Rules, in order:
 *  1. The encoded message must fit `MAX_IPC_MESSAGE_BYTES` (system-design §14).
 *  2. The envelope must name a channel in the catalogue.
 *  3. `parseRequestEnvelope` must accept the envelope *and* the payload against
 *     that channel's request schema.
 *  4. A handler failure becomes a `PilotError`, never an unstructured throw.
 *
 * Every rejection is returned as a failure envelope carrying a serialized
 * `PilotError`, so the renderer always gets a typed reason and never silence.
 */

export interface RequestContext {
  /** Identifies the sender so a handler can refuse an unexpected window. */
  readonly senderId: number;
}

export type RequestHandler<Channel extends AnyRequestChannel> = (
  payload: ChannelRequest<Channel>,
  context: RequestContext,
) => ChannelResponse<Channel> | Promise<ChannelResponse<Channel>>;

export interface IpcRouterOptions {
  readonly logger?: Logger;
  readonly now?: () => number;
  /** Source of ids for failures that arrive without a usable request id. */
  readonly nextRequestId?: () => RequestId;
}

interface Registration {
  readonly channel: AnyRequestChannel;
  readonly handler: RequestHandler<AnyRequestChannel>;
}

/** Best-effort id recovery so a failure can still be correlated by the renderer. */
function recoverRequestId(raw: unknown): RequestId | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const parsed = requestIdSchema.safeParse((raw as { id?: unknown }).id);
  return parsed.success ? parsed.data : undefined;
}

function recoverChannelName(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) {
    return 'unknown';
  }
  const channel = (raw as { channel?: unknown }).channel;
  return typeof channel === 'string' && channel.length > 0 && channel.length <= 128
    ? channel
    : 'unknown';
}

/**
 * Rejects messages too large to be a legitimate view command before any schema
 * work happens. Electron hands us structured-clone values rather than a string,
 * so the size is measured by encoding; a value that cannot be encoded at all
 * (cycles, functions) is not a valid envelope either.
 */
function assertWithinSizeLimit(raw: unknown): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(raw) ?? 'undefined';
  } catch (cause) {
    throw new PilotError('invalid-request', 'IPC message is not serialisable', {
      userMessage: 'Pilot received a malformed message.',
      cause,
    });
  }
  const byteLength = Buffer.byteLength(encoded, 'utf8');
  if (byteLength > MAX_IPC_MESSAGE_BYTES) {
    throw new PilotError('payload-too-large', 'IPC message exceeds the size limit', {
      userMessage: 'Pilot received a message that was too large.',
      details: { byteLength, limit: MAX_IPC_MESSAGE_BYTES },
    });
  }
}

export class IpcRouter {
  readonly #registrations = new Map<string, Registration>();
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #nextRequestId: () => RequestId;

  constructor(options: IpcRouterOptions = {}) {
    this.#logger = options.logger ?? nullLogger;
    this.#now = options.now ?? (() => Date.now());
    this.#nextRequestId =
      options.nextRequestId ?? (() => requestIdSchema.parse('req-unattributed'));
  }

  register<Channel extends AnyRequestChannel>(
    channel: Channel,
    handler: RequestHandler<Channel>,
  ): this {
    if (findRequestChannel(channel.name) === undefined) {
      throw new PilotError('unknown-channel', `Channel "${channel.name}" is not in the catalogue`, {
        userMessage: 'Pilot tried to serve an unknown channel.',
        details: { channel: channel.name },
      });
    }
    if (this.#registrations.has(channel.name)) {
      throw new PilotError('internal', `Channel "${channel.name}" already has a handler`, {
        details: { channel: channel.name },
      });
    }
    this.#registrations.set(channel.name, {
      channel,
      handler: handler as RequestHandler<AnyRequestChannel>,
    });
    return this;
  }

  has(channelName: string): boolean {
    return this.#registrations.has(channelName);
  }

  /**
   * Validates and dispatches one renderer message. Never throws: an invalid
   * message and a failing handler both produce a failure response envelope.
   */
  async handle(raw: unknown, context: RequestContext): Promise<ResponseEnvelope> {
    let envelope: RequestEnvelope | undefined;
    try {
      assertWithinSizeLimit(raw);

      const channelName = recoverChannelName(raw);
      const registration = this.#registrations.get(channelName);
      if (registration === undefined) {
        throw new PilotError('unknown-channel', `No handler for channel "${channelName}"`, {
          userMessage: 'Pilot received a message for an unknown channel.',
          details: { channel: channelName },
        });
      }

      const parsed = parseRequestEnvelope(registration.channel, raw);
      envelope = parsed.envelope;

      const response = await registration.handler(parsed.payload, context);
      // Channel name and sender only — payloads may carry screen text.
      this.#logger.debug('served renderer request', {
        channel: registration.channel.name,
        senderId: context.senderId,
      });
      return createSuccessResponseEnvelope(
        registration.channel,
        parsed.envelope,
        response,
        this.#now(),
      );
    } catch (cause) {
      const error = toPilotError(cause);
      this.#logger.warn('rejected renderer message', {
        channel: envelope?.channel ?? recoverChannelName(raw),
        code: error.code,
        senderId: context.senderId,
      });
      return createFailureResponseEnvelope(
        envelope ?? this.#syntheticRequest(raw),
        error,
        this.#now(),
      );
    }
  }

  #syntheticRequest(raw: unknown): RequestEnvelope {
    return {
      kind: 'request',
      protocolVersion: IPC_PROTOCOL_VERSION,
      id: recoverRequestId(raw) ?? this.#nextRequestId(),
      channel: recoverChannelName(raw),
      issuedAt: this.#now(),
      payload: null,
    };
  }
}
