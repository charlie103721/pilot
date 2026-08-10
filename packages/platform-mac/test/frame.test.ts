import { isPilotError, type PilotError } from '@pilot/shared';
import {
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  FrameDecoder,
  HELPER_PROTOCOL_VERSION,
  MAX_FRAME_BINARY_BYTES,
  MAX_FRAME_MESSAGE_BYTES,
  encodeFrame,
  parseFrameHeader,
} from '@pilot/platform-mac';
import { describe, expect, it } from 'vitest';
import { deterministicBytes } from './support/harness.js';

function expectPilotError(run: () => unknown, code: string): PilotError {
  try {
    run();
  } catch (error) {
    if (!isPilotError(error)) {
      throw error;
    }
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected a PilotError with code "${code}"`);
}

function header(overrides: {
  magic?: string;
  version?: number;
  flags?: number;
  reserved?: number;
  messageLength?: number;
  binaryLength?: number;
}): Buffer {
  const buffer = Buffer.alloc(FRAME_HEADER_BYTES);
  buffer.write(overrides.magic ?? FRAME_MAGIC, 0, 4, 'ascii');
  buffer.writeUInt8(overrides.version ?? HELPER_PROTOCOL_VERSION, 4);
  buffer.writeUInt8(overrides.flags ?? 0, 5);
  buffer.writeUInt16BE(overrides.reserved ?? 0, 6);
  buffer.writeUInt32BE(overrides.messageLength ?? 2, 8);
  buffer.writeUInt32BE(overrides.binaryLength ?? 0, 12);
  return buffer;
}

describe('frame header', () => {
  it('lays the header out exactly as documented', () => {
    const frame = encodeFrame('{"a":1}', Buffer.from([1, 2, 3]));

    expect(frame.subarray(0, 4).toString('ascii')).toBe('PILT');
    expect(frame.readUInt8(4)).toBe(HELPER_PROTOCOL_VERSION);
    expect(frame.readUInt8(5)).toBe(0);
    expect(frame.readUInt16BE(6)).toBe(0);
    expect(frame.readUInt32BE(8)).toBe(7);
    expect(frame.readUInt32BE(12)).toBe(3);
    expect(frame.length).toBe(FRAME_HEADER_BYTES + 7 + 3);
  });

  it('rejects the wrong magic', () => {
    expectPilotError(() => parseFrameHeader(header({ magic: 'NOPE' })), 'invalid-request');
  });

  it('rejects an unsupported protocol version', () => {
    expectPilotError(
      () => parseFrameHeader(header({ version: HELPER_PROTOCOL_VERSION + 1 })),
      'protocol-version-mismatch',
    );
  });

  it('rejects reserved bits that are set', () => {
    expectPilotError(() => parseFrameHeader(header({ flags: 1 })), 'invalid-request');
    expectPilotError(() => parseFrameHeader(header({ reserved: 7 })), 'invalid-request');
  });

  it('rejects an empty message body', () => {
    expectPilotError(() => parseFrameHeader(header({ messageLength: 0 })), 'invalid-request');
  });

  it('rejects a truncated header', () => {
    expectPilotError(
      () => parseFrameHeader(Buffer.alloc(FRAME_HEADER_BYTES - 1)),
      'invalid-request',
    );
  });

  it('rejects oversized bodies from the declared lengths alone', () => {
    const oversizedMessage = expectPilotError(
      () => parseFrameHeader(header({ messageLength: MAX_FRAME_MESSAGE_BYTES + 1 })),
      'payload-too-large',
    );
    expect(oversizedMessage.details?.limit).toBe(MAX_FRAME_MESSAGE_BYTES);

    const oversizedBinary = expectPilotError(
      () => parseFrameHeader(header({ binaryLength: MAX_FRAME_BINARY_BYTES + 1 })),
      'payload-too-large',
    );
    expect(oversizedBinary.details?.limit).toBe(MAX_FRAME_BINARY_BYTES);
  });
});

describe('encodeFrame', () => {
  it('refuses an empty message', () => {
    expectPilotError(() => encodeFrame(''), 'invalid-request');
  });

  it('refuses an oversized message before allocating a frame', () => {
    const message = 'x'.repeat(MAX_FRAME_MESSAGE_BYTES + 1);
    expectPilotError(() => encodeFrame(message), 'payload-too-large');
  });

  it('refuses an oversized binary payload', () => {
    // Declared length only; nothing this large is ever allocated in the test.
    const oversized = { byteLength: MAX_FRAME_BINARY_BYTES + 1 } as unknown as Uint8Array;
    expectPilotError(() => encodeFrame('{}', oversized), 'payload-too-large');
  });
});

describe('FrameDecoder', () => {
  it('round-trips a message with no binary body', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(encodeFrame('{"kind":"event"}'));

    expect(frames).toHaveLength(1);
    expect(frames[0]?.message.toString('utf8')).toBe('{"kind":"event"}');
    expect(frames[0]?.binary).toHaveLength(0);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('round-trips a binary body byte for byte', () => {
    const payload = deterministicBytes(64 * 1024);
    const decoder = new FrameDecoder();
    const frames = decoder.push(encodeFrame('{"op":"echo"}', payload));

    expect(frames).toHaveLength(1);
    expect(frames[0]?.binary.equals(payload)).toBe(true);
  });

  it('reassembles frames split across arbitrary chunk boundaries', () => {
    const stream = Buffer.concat([
      encodeFrame('{"n":1}', Buffer.from('one')),
      encodeFrame('{"n":2}'),
      encodeFrame('{"n":3}', deterministicBytes(1024, 7)),
    ]);

    const decoder = new FrameDecoder();
    const collected: string[] = [];
    for (let offset = 0; offset < stream.length; offset += 7) {
      for (const frame of decoder.push(stream.subarray(offset, offset + 7))) {
        collected.push(frame.message.toString('utf8'));
      }
    }

    expect(collected).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('yields several frames delivered in one chunk', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(
      Buffer.concat([encodeFrame('{"n":1}'), encodeFrame('{"n":2}'), encodeFrame('{"n":3}')]),
    );
    expect(frames.map((frame) => frame.message.toString('utf8'))).toEqual([
      '{"n":1}',
      '{"n":2}',
      '{"n":3}',
    ]);
  });

  it('holds an incomplete frame without emitting it', () => {
    const frame = encodeFrame('{"n":1}', Buffer.from('abcd'));
    const decoder = new FrameDecoder();

    expect(decoder.push(frame.subarray(0, frame.length - 1))).toEqual([]);
    expect(decoder.bufferedBytes).toBe(frame.length - 1);
    expect(decoder.push(frame.subarray(frame.length - 1))).toHaveLength(1);
  });

  it('rejects an oversized frame from its header, before the body arrives', () => {
    const decoder = new FrameDecoder();
    const error = expectPilotError(
      () => decoder.push(header({ messageLength: MAX_FRAME_MESSAGE_BYTES + 1 })),
      'payload-too-large',
    );
    expect(error.retryable).toBe(false);
  });

  it('poisons itself after a malformed header and refuses further input', () => {
    const decoder = new FrameDecoder();
    expectPilotError(() => decoder.push(header({ magic: 'XXXX' })), 'invalid-request');
    expect(decoder.failure?.code).toBe('invalid-request');
    // A valid frame afterwards must still be refused: the stream is no longer
    // known to be frame-aligned.
    expectPilotError(() => decoder.push(encodeFrame('{"n":1}')), 'invalid-request');
  });

  it('recovers after an explicit reset', () => {
    const decoder = new FrameDecoder();
    expectPilotError(() => decoder.push(header({ magic: 'XXXX' })), 'invalid-request');
    decoder.reset();
    expect(decoder.failure).toBeUndefined();
    expect(decoder.push(encodeFrame('{"n":1}'))).toHaveLength(1);
  });
});
