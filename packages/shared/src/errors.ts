import { z } from 'zod';

/**
 * Typed error taxonomy.
 *
 * Every failure that crosses a package or process boundary is a `PilotError`
 * with a stable `code`. UI code switches on `code`, never on `message`.
 * `userMessage` is the only field safe to render to a user.
 */

export const PILOT_ERROR_DOMAINS = [
  'permission',
  'platform',
  'observation',
  'policy',
  'agent',
  'speech',
  'ipc',
  'internal',
] as const;

export type PilotErrorDomain = (typeof PILOT_ERROR_DOMAINS)[number];

export const PILOT_ERROR_CODES = [
  // permission
  'permission-denied',
  'permission-unknown',
  'permission-restricted',
  // platform
  'platform-unavailable',
  'helper-unavailable',
  'window-not-found',
  'window-closed',
  'screen-locked',
  // observation
  'observation-disabled',
  'observation-paused',
  'capture-failed',
  'protected-content',
  'frame-unavailable',
  'scene-mismatch',
  // policy
  'rate-limited',
  'image-limit-exceeded',
  'payload-too-large',
  // agent
  'provider-unavailable',
  'authentication-required',
  'unsupported-capability',
  'run-already-active',
  // speech
  'speech-input-failed',
  'speech-output-failed',
  'speech-unavailable',
  // ipc
  'invalid-request',
  'unknown-channel',
  'protocol-version-mismatch',
  // generic
  'cancelled',
  'timeout',
  'internal',
] as const;

export type PilotErrorCode = (typeof PILOT_ERROR_CODES)[number];

export const PILOT_ERROR_DOMAIN_BY_CODE: Readonly<Record<PilotErrorCode, PilotErrorDomain>> = {
  'permission-denied': 'permission',
  'permission-unknown': 'permission',
  'permission-restricted': 'permission',
  'platform-unavailable': 'platform',
  'helper-unavailable': 'platform',
  'window-not-found': 'platform',
  'window-closed': 'platform',
  'screen-locked': 'platform',
  'observation-disabled': 'observation',
  'observation-paused': 'observation',
  'capture-failed': 'observation',
  'protected-content': 'observation',
  'frame-unavailable': 'observation',
  'scene-mismatch': 'observation',
  'rate-limited': 'policy',
  'image-limit-exceeded': 'policy',
  'payload-too-large': 'policy',
  'provider-unavailable': 'agent',
  'authentication-required': 'agent',
  'unsupported-capability': 'agent',
  'run-already-active': 'agent',
  'speech-input-failed': 'speech',
  'speech-output-failed': 'speech',
  'speech-unavailable': 'speech',
  'invalid-request': 'ipc',
  'unknown-channel': 'ipc',
  'protocol-version-mismatch': 'ipc',
  cancelled: 'internal',
  timeout: 'internal',
  internal: 'internal',
};

const DEFAULT_RETRYABLE: ReadonlySet<PilotErrorCode> = new Set<PilotErrorCode>([
  'capture-failed',
  'frame-unavailable',
  'rate-limited',
  'provider-unavailable',
  'timeout',
  'helper-unavailable',
]);

export interface PilotErrorOptions {
  /** Text safe to show the user. Defaults to the technical message. */
  readonly userMessage?: string;
  /** Whether retrying the same operation may succeed. */
  readonly retryable?: boolean;
  /**
   * Structured, JSON-serialisable context. Must never contain credentials,
   * image bytes, audio buffers, or screen text; the logger redacts these but
   * callers should not put them here in the first place.
   */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class PilotError extends Error {
  readonly code: PilotErrorCode;
  readonly domain: PilotErrorDomain;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: PilotErrorCode, message: string, options: PilotErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PilotError';
    this.code = code;
    this.domain = PILOT_ERROR_DOMAIN_BY_CODE[code];
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(code);
    this.userMessage = options.userMessage ?? message;
    this.details = options.details;
  }

  toJSON(): SerializedPilotError {
    return {
      name: 'PilotError',
      code: this.code,
      domain: this.domain,
      message: this.message,
      userMessage: this.userMessage,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: { ...this.details } }),
    };
  }
}

export const serializedPilotErrorSchema = z.strictObject({
  name: z.literal('PilotError'),
  code: z.enum(PILOT_ERROR_CODES),
  domain: z.enum(PILOT_ERROR_DOMAINS),
  message: z.string(),
  userMessage: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type SerializedPilotError = z.infer<typeof serializedPilotErrorSchema>;

export function isPilotError(value: unknown): value is PilotError {
  return value instanceof PilotError;
}

/** Normalises an unknown thrown value into a `PilotError`. */
export function toPilotError(
  value: unknown,
  fallbackCode: PilotErrorCode = 'internal',
): PilotError {
  if (isPilotError(value)) {
    return value;
  }
  if (value instanceof Error) {
    if (value.name === 'AbortError') {
      return new PilotError('cancelled', value.message, { cause: value });
    }
    return new PilotError(fallbackCode, value.message, { cause: value });
  }
  return new PilotError(fallbackCode, String(value));
}

export function deserializePilotError(value: unknown): PilotError {
  const parsed = serializedPilotErrorSchema.parse(value);
  return new PilotError(parsed.code, parsed.message, {
    userMessage: parsed.userMessage,
    retryable: parsed.retryable,
    ...(parsed.details === undefined ? {} : { details: parsed.details }),
  });
}

export function cancelledError(what: string): PilotError {
  return new PilotError('cancelled', `${what} was cancelled`, {
    userMessage: 'The request was cancelled.',
    retryable: true,
  });
}
