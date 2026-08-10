/**
 * Privacy-safe structured logger.
 *
 * `docs/system-design.md` §13 lists what may never be logged: credentials and
 * OAuth tokens, base64 images, raw audio, and full prompts containing screen
 * text. This logger enforces that mechanically rather than by convention:
 * every field passed to it is walked and any value that looks like a secret,
 * an image, an audio buffer, or any binary blob is replaced with a marker
 * before it reaches a sink.
 *
 * The logger never throws by default — dropping a log line is worse than
 * losing a field — but `onViolation: 'throw'` turns redaction into an error so
 * tests can assert that production code does not attempt to log payloads.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Readonly<Record<string, unknown>>;

export interface LogRecord {
  readonly timestamp: number;
  readonly level: LogLevel;
  readonly scope: string;
  readonly message: string;
  readonly fields: Record<string, unknown>;
  /** Field paths whose values were replaced by the redactor. */
  readonly redactedPaths: readonly string[];
}

export interface LogSink {
  write(record: LogRecord): void;
}

export const REDACTED_CREDENTIAL = '[redacted:credential]';
export const REDACTED_IMAGE = '[redacted:image]';
export const REDACTED_AUDIO = '[redacted:audio]';
export const REDACTED_CONTENT = '[redacted:content]';
export const REDACTED_CIRCULAR = '[redacted:circular]';
export const REDACTED_DEPTH = '[redacted:depth]';

const CREDENTIAL_KEY_PATTERN =
  /(pass(word|phrase)?|secret|token|api[-_]?key|apikey|authorization|auth[-_]?header|credential|cookie|bearer|refresh|private[-_]?key|client[-_]?secret|signature|session[-_]?key)/i;

const IMAGE_KEY_PATTERN =
  /(base64|image|images|screenshot|thumbnail|frame|frames|bitmap|png|jpeg|jpg|data[-_]?url|pixels)/i;

const AUDIO_KEY_PATTERN = /(audio|pcm|waveform|samples|mic[-_]?buffer|utterance[-_]?audio)/i;

const CONTENT_KEY_PATTERN =
  /(transcript|prompt|prompts|messages|screen[-_]?text|ocr[-_]?text|response[-_]?text|answer)/i;

const DATA_URI_PATTERN = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/\r\n]+={0,2}$/;

export interface RedactionOptions {
  /** Strings at or above this length are treated as suspicious payloads. */
  readonly base64MinLength: number;
  /** Strings longer than this are truncated. */
  readonly maxStringLength: number;
  /** Maximum object/array nesting walked before replacing with a marker. */
  readonly maxDepth: number;
  /** Maximum array entries kept. */
  readonly maxArrayLength: number;
  /**
   * When false (the default), transcript/prompt-shaped fields are redacted
   * because they may contain screen text.
   */
  readonly allowContentText: boolean;
}

export const DEFAULT_REDACTION_OPTIONS: RedactionOptions = {
  base64MinLength: 256,
  maxStringLength: 512,
  maxDepth: 6,
  maxArrayLength: 32,
  allowContentText: false,
};

export interface RedactionResult {
  readonly value: unknown;
  readonly redactedPaths: readonly string[];
}

function isBinaryLike(value: unknown): value is ArrayBufferView | ArrayBuffer | SharedArrayBuffer {
  return (
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) ||
    ArrayBuffer.isView(value)
  );
}

function looksLikeBase64Payload(value: string, options: RedactionOptions): boolean {
  if (DATA_URI_PATTERN.test(value)) {
    return true;
  }
  if (value.length < options.base64MinLength) {
    return false;
  }
  return BASE64_PATTERN.test(value);
}

/**
 * Walks a value and replaces anything that must never be logged.
 * Exported so tests and other packages can assert on the rules directly.
 */
export function redactValue(
  input: unknown,
  options: RedactionOptions = DEFAULT_REDACTION_OPTIONS,
): RedactionResult {
  const redactedPaths: string[] = [];
  const seen = new WeakSet<object>();

  const markerForKey = (key: string): string | undefined => {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      return REDACTED_CREDENTIAL;
    }
    if (IMAGE_KEY_PATTERN.test(key)) {
      return REDACTED_IMAGE;
    }
    if (AUDIO_KEY_PATTERN.test(key)) {
      return REDACTED_AUDIO;
    }
    if (!options.allowContentText && CONTENT_KEY_PATTERN.test(key)) {
      return REDACTED_CONTENT;
    }
    return undefined;
  };

  const walk = (value: unknown, path: string, key: string | undefined, depth: number): unknown => {
    if (key !== undefined) {
      const marker = markerForKey(key);
      if (marker !== undefined) {
        redactedPaths.push(path);
        return marker;
      }
    }

    if (value === null || value === undefined) {
      return value;
    }

    if (isBinaryLike(value)) {
      redactedPaths.push(path);
      return `[redacted:binary:${value.byteLength}B]`;
    }

    switch (typeof value) {
      case 'string': {
        if (looksLikeBase64Payload(value, options)) {
          redactedPaths.push(path);
          return REDACTED_IMAGE;
        }
        if (value.length > options.maxStringLength) {
          redactedPaths.push(path);
          return `${value.slice(0, options.maxStringLength)}…[truncated:${value.length}]`;
        }
        return value;
      }
      case 'number':
      case 'boolean':
        return value;
      case 'bigint':
        return `${value.toString()}n`;
      case 'function':
        return '[function]';
      case 'symbol':
        return value.toString();
      default:
        break;
    }

    if (depth >= options.maxDepth) {
      redactedPaths.push(path);
      return REDACTED_DEPTH;
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: walk(value.message, `${path}.message`, undefined, depth + 1),
        ...('code' in value ? { code: (value as { code?: unknown }).code } : {}),
      };
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (value instanceof Map || value instanceof Set) {
      return `[${value.constructor.name}:${value.size}]`;
    }

    if (seen.has(value as object)) {
      redactedPaths.push(path);
      return REDACTED_CIRCULAR;
    }
    seen.add(value as object);

    if (Array.isArray(value)) {
      const kept = value.slice(0, options.maxArrayLength);
      const mapped: unknown[] = kept.map((entry, index) =>
        walk(entry, `${path}[${index}]`, key, depth + 1),
      );
      if (value.length > options.maxArrayLength) {
        mapped.push(`[truncated:${value.length - options.maxArrayLength} more]`);
      }
      return mapped;
    }

    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path === '' ? childKey : `${path}.${childKey}`;
      output[childKey] = walk(childValue, childPath, childKey, depth + 1);
    }
    return output;
  };

  return { value: walk(input, '', undefined, 0), redactedPaths };
}

export interface Logger {
  readonly scope: string;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(scope: string, boundFields?: LogFields): Logger;
}

export interface LoggerOptions {
  readonly scope: string;
  readonly level?: LogLevel;
  readonly sink?: LogSink;
  readonly clock?: () => number;
  readonly redaction?: RedactionOptions;
  /** `'redact'` (default) replaces offending values; `'throw'` fails loudly. */
  readonly onViolation?: 'redact' | 'throw';
  readonly boundFields?: LogFields;
}

export class LogRedactionError extends Error {
  readonly redactedPaths: readonly string[];

  constructor(redactedPaths: readonly string[]) {
    super(`Refusing to log redacted fields: ${redactedPaths.join(', ')}`);
    this.name = 'LogRedactionError';
    this.redactedPaths = redactedPaths;
  }
}

/** Collects records in memory. Used by tests and the diagnostics view. */
export function createMemorySink(): LogSink & { readonly records: readonly LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    records,
    write(record: LogRecord): void {
      records.push(record);
    },
  };
}

/** Writes newline-delimited JSON to a text writer (defaults to stderr). */
export function createJsonSink(write: (line: string) => void): LogSink {
  return {
    write(record: LogRecord): void {
      write(JSON.stringify(record));
    },
  };
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? createJsonSink((line) => process.stderr.write(`${line}\n`));
  const clock = options.clock ?? (() => Date.now());
  const redaction = options.redaction ?? DEFAULT_REDACTION_OPTIONS;
  const onViolation = options.onViolation ?? 'redact';
  const boundFields = options.boundFields ?? {};

  const emit = (recordLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[recordLevel] < LEVEL_ORDER[level]) {
      return;
    }
    const merged = { ...boundFields, ...(fields ?? {}) };
    const redactedFields = redactValue(merged, redaction);
    const redactedMessage = redactValue(message, redaction);
    const redactedPaths = [
      ...redactedMessage.redactedPaths.map(() => 'message'),
      ...redactedFields.redactedPaths,
    ];

    if (onViolation === 'throw' && redactedPaths.length > 0) {
      throw new LogRedactionError(redactedPaths);
    }

    sink.write({
      timestamp: clock(),
      level: recordLevel,
      scope: options.scope,
      message: String(redactedMessage.value),
      fields: (redactedFields.value ?? {}) as Record<string, unknown>,
      redactedPaths,
    });
  };

  return {
    scope: options.scope,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (scope, childFields) =>
      createLogger({
        ...options,
        scope: `${options.scope}.${scope}`,
        boundFields: { ...boundFields, ...(childFields ?? {}) },
      }),
  };
}

/** A logger that discards everything. Convenient default for library code. */
export const nullLogger: Logger = createLogger({
  scope: 'null',
  level: 'error',
  sink: { write: () => undefined },
});
