import { describe, expect, it } from 'vitest';
import {
  LogRedactionError,
  REDACTED_AUDIO,
  REDACTED_CIRCULAR,
  REDACTED_CONTENT,
  REDACTED_CREDENTIAL,
  REDACTED_IMAGE,
  createLogger,
  createMemorySink,
  redactValue,
  type LogRecord,
} from '@pilot/shared';

/** A base64 payload long enough to look like an encoded image. */
const BASE64_IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'.repeat(12);
const DATA_URI = `data:image/jpeg;base64,${'A'.repeat(64)}`;

function loggerWithSink(overrides: Partial<Parameters<typeof createLogger>[0]> = {}) {
  const sink = createMemorySink();
  const logger = createLogger({
    scope: 'test',
    level: 'debug',
    sink,
    clock: () => 1_760_000_000_000,
    ...overrides,
  });
  return { logger, sink };
}

function lastRecord(sink: { readonly records: readonly LogRecord[] }): LogRecord {
  const record = sink.records.at(-1);
  if (record === undefined) {
    throw new Error('no log record was written');
  }
  return record;
}

describe('logger redaction — credentials', () => {
  it('redacts credential-shaped keys anywhere in the tree', () => {
    const { logger, sink } = loggerWithSink();
    logger.info('provider configured', {
      profileId: 'profile-1',
      apiKey: 'sk-live-1234567890',
      auth: { accessToken: 'ya29.secret', refreshToken: 'refresh-secret' },
      headers: { authorization: 'Bearer abc', 'x-request-id': 'req-1' },
      password: 'hunter2',
      clientSecret: 'shh',
    });

    const record = lastRecord(sink);
    expect(record.fields.apiKey).toBe(REDACTED_CREDENTIAL);
    expect(record.fields.password).toBe(REDACTED_CREDENTIAL);
    expect(record.fields.clientSecret).toBe(REDACTED_CREDENTIAL);
    expect(record.fields.auth).toEqual({
      accessToken: REDACTED_CREDENTIAL,
      refreshToken: REDACTED_CREDENTIAL,
    });
    expect(record.fields.headers).toEqual({
      authorization: REDACTED_CREDENTIAL,
      'x-request-id': 'req-1',
    });
    // Non-sensitive fields survive.
    expect(record.fields.profileId).toBe('profile-1');
    expect(record.redactedPaths).toContain('apiKey');
    expect(record.redactedPaths).toContain('auth.accessToken');
    expect(JSON.stringify(record)).not.toContain('hunter2');
    expect(JSON.stringify(record)).not.toContain('sk-live');
  });
});

describe('logger redaction — images', () => {
  it('redacts base64 image payloads by key and by value shape', () => {
    const { logger, sink } = loggerWithSink();
    logger.info('observation returned', {
      observationId: 'obs-1',
      images: [{ mimeType: 'image/jpeg', base64: BASE64_IMAGE, purpose: 'window' }],
      thumbnail: DATA_URI,
      opaquePayload: BASE64_IMAGE,
    });

    const record = lastRecord(sink);
    expect(record.fields.images).toBe(REDACTED_IMAGE);
    expect(record.fields.thumbnail).toBe(REDACTED_IMAGE);
    // Not named like an image, but the value is unmistakably base64.
    expect(record.fields.opaquePayload).toBe(REDACTED_IMAGE);
    expect(record.fields.observationId).toBe('obs-1');
    expect(JSON.stringify(record)).not.toContain(BASE64_IMAGE.slice(0, 32));
  });

  it('redacts a data URI that appears in the log message itself', () => {
    const { logger, sink } = loggerWithSink();
    logger.warn(DATA_URI);
    const record = lastRecord(sink);
    expect(record.message).toBe(REDACTED_IMAGE);
    expect(record.redactedPaths).toContain('message');
  });
});

describe('logger redaction — audio and binary', () => {
  it('redacts audio buffers by key', () => {
    const { logger, sink } = loggerWithSink();
    logger.debug('utterance finalized', {
      utteranceId: 'utt-1',
      audioBuffer: [0.1, 0.2, 0.3],
      pcm: 'AAAA',
      durationMs: 1200,
    });

    const record = lastRecord(sink);
    expect(record.fields.audioBuffer).toBe(REDACTED_AUDIO);
    expect(record.fields.pcm).toBe(REDACTED_AUDIO);
    expect(record.fields.durationMs).toBe(1200);
  });

  it('redacts any binary blob regardless of its key', () => {
    const { logger, sink } = loggerWithSink();
    logger.debug('frame captured', {
      frameBytes: new Uint8Array(1024),
      raw: new ArrayBuffer(2048),
      view: new DataView(new ArrayBuffer(16)),
    });

    const record = lastRecord(sink);
    expect(record.fields.raw).toBe('[redacted:binary:2048B]');
    expect(record.fields.view).toBe('[redacted:binary:16B]');
    // `frameBytes` matches the image key pattern first; either marker is a pass.
    expect(String(record.fields.frameBytes)).toMatch(/redacted/);
  });

  it('redacts an oversized binary blob without serializing it', () => {
    const { logger, sink } = loggerWithSink();
    const oversized = new Uint8Array(16 * 1024 * 1024);
    logger.error('capture failed', { payload: oversized });
    const serialized = JSON.stringify(lastRecord(sink));
    expect(serialized).toContain('redacted:binary:16777216B');
    expect(serialized.length).toBeLessThan(500);
  });
});

describe('logger redaction — screen text and long strings', () => {
  it('redacts transcripts and prompts by default', () => {
    const { logger, sink } = loggerWithSink();
    logger.info('submitting question', {
      utteranceId: 'utt-1',
      transcript: 'What is this button?',
      prompt: 'You are Pilot…',
      screenText: 'Account number 1234',
    });

    const record = lastRecord(sink);
    expect(record.fields.transcript).toBe(REDACTED_CONTENT);
    expect(record.fields.prompt).toBe(REDACTED_CONTENT);
    expect(record.fields.screenText).toBe(REDACTED_CONTENT);
  });

  it('allows content text only when explicitly opted in', () => {
    const { logger, sink } = loggerWithSink({
      redaction: {
        base64MinLength: 256,
        maxStringLength: 512,
        maxDepth: 6,
        maxArrayLength: 32,
        allowContentText: true,
      },
    });
    logger.info('submitting question', { transcript: 'What is this button?' });
    expect(lastRecord(sink).fields.transcript).toBe('What is this button?');
  });

  it('truncates long non-base64 strings', () => {
    const { logger, sink } = loggerWithSink();
    logger.info('long value', { note: 'a b '.repeat(400) });
    expect(String(lastRecord(sink).fields.note)).toMatch(/\[truncated:1600\]$/);
  });
});

describe('logger behaviour', () => {
  it('breaks cycles and bounds depth', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    const result = redactValue({ cyclic });
    expect(JSON.stringify(result.value)).toContain(REDACTED_CIRCULAR);
  });

  it('honours the level filter', () => {
    const { logger, sink } = loggerWithSink({ level: 'warn' });
    logger.debug('ignored');
    logger.info('ignored');
    logger.warn('kept');
    expect(sink.records).toHaveLength(1);
    expect(lastRecord(sink).message).toBe('kept');
  });

  it('merges bound fields from child loggers and redacts them too', () => {
    const { logger, sink } = loggerWithSink();
    const child = logger.child('agent', { conversationId: 'conv-1', apiKey: 'sk-secret' });
    child.info('run started', { runId: 'run-1' });

    const record = lastRecord(sink);
    expect(record.scope).toBe('test.agent');
    expect(record.fields).toEqual({
      conversationId: 'conv-1',
      apiKey: REDACTED_CREDENTIAL,
      runId: 'run-1',
    });
  });

  it('throws instead of redacting when configured to fail loudly', () => {
    const { logger } = loggerWithSink({ onViolation: 'throw' });
    expect(() => logger.info('leak', { apiKey: 'sk-secret' })).toThrowError(LogRedactionError);
    expect(() => logger.info('safe', { runId: 'run-1' })).not.toThrow();
  });
});
