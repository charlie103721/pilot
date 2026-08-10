import { PilotError, toPilotError } from '@pilot/shared';

/**
 * Framed stdio wire format for the embedded native helper (system-design §4:
 * "IPC messages are typed, length-bounded, and restricted to explicit
 * operations").
 *
 * A frame is a fixed 16-byte header followed by two length-prefixed bodies:
 * a UTF-8 JSON message and an opaque binary payload. The binary payload is
 * part of the format from day one so later PRs (PR-012 capture frames,
 * PR-014 audio) can attach bytes without a second protocol or a base64
 * detour through JSON.
 *
 * ```text
 * offset  size  field
 *      0     4  magic, ASCII "PILT"
 *      4     1  protocolVersion (uint8)
 *      5     1  flags (uint8) — reserved, must be 0
 *      6     2  reserved (uint16 big-endian) — must be 0
 *      8     4  messageLength (uint32 big-endian), UTF-8 JSON, must be > 0
 *     12     4  binaryLength (uint32 big-endian), may be 0
 *     16     …  message bytes, then binary bytes
 * ```
 *
 * All multi-byte integers are big-endian (network order) so the Swift and
 * TypeScript sides agree without an endianness negotiation.
 *
 * Every rejection here is a typed {@link PilotError}. A decoder that has
 * rejected a frame is poisoned: the byte stream is no longer trustworthy, so
 * it refuses further input rather than resynchronising on a guess.
 */

export const HELPER_PROTOCOL_VERSION = 1;

/** ASCII magic that opens every frame. */
export const FRAME_MAGIC = 'PILT';

const MAGIC_BYTES = Buffer.from(FRAME_MAGIC, 'ascii');

export const FRAME_HEADER_BYTES = 16;

const OFFSET_VERSION = 4;
const OFFSET_FLAGS = 5;
const OFFSET_RESERVED = 6;
const OFFSET_MESSAGE_LENGTH = 8;
const OFFSET_BINARY_LENGTH = 12;

/**
 * Hard ceiling on the JSON message body of one frame. Matches
 * `MAX_IPC_MESSAGE_BYTES` in `@pilot/shared` so a payload that can cross the
 * renderer boundary can also cross the helper boundary.
 */
export const MAX_FRAME_MESSAGE_BYTES = 1_048_576;

/**
 * Hard ceiling on the binary body of one frame (32 MiB). Sized for a single
 * full-resolution Retina window capture; anything larger is a bug, not a
 * frame.
 */
export const MAX_FRAME_BINARY_BYTES = 33_554_432;

/** Hard ceiling on one complete frame, header included. */
export const MAX_FRAME_BYTES =
  FRAME_HEADER_BYTES + MAX_FRAME_MESSAGE_BYTES + MAX_FRAME_BINARY_BYTES;

const EMPTY = Buffer.alloc(0);

export interface FrameHeader {
  readonly version: number;
  readonly flags: number;
  readonly messageLength: number;
  readonly binaryLength: number;
  /** `FRAME_HEADER_BYTES + messageLength + binaryLength`. */
  readonly totalLength: number;
}

/** One decoded frame. `binary` is empty when the frame carried no payload. */
export interface HelperFrame {
  readonly message: Buffer;
  readonly binary: Buffer;
}

function malformed(message: string, details: Record<string, unknown>): PilotError {
  return new PilotError('invalid-request', message, {
    userMessage: 'Pilot could not talk to its macOS helper.',
    retryable: false,
    details,
  });
}

function tooLarge(message: string, details: Record<string, unknown>): PilotError {
  return new PilotError('payload-too-large', message, {
    userMessage: 'Pilot could not talk to its macOS helper.',
    retryable: false,
    details,
  });
}

/**
 * Reads and validates a frame header. Called with only the first
 * {@link FRAME_HEADER_BYTES} bytes available, so an oversized frame is
 * rejected from its declared length before a single body byte is buffered.
 */
export function parseFrameHeader(buffer: Buffer, offset = 0): FrameHeader {
  if (buffer.length - offset < FRAME_HEADER_BYTES) {
    throw malformed('Frame header is truncated', {
      available: buffer.length - offset,
      required: FRAME_HEADER_BYTES,
    });
  }

  if (
    buffer.compare(MAGIC_BYTES, 0, MAGIC_BYTES.length, offset, offset + MAGIC_BYTES.length) !== 0
  ) {
    throw malformed('Frame header has the wrong magic', {
      expected: FRAME_MAGIC,
      received: buffer.subarray(offset, offset + MAGIC_BYTES.length).toString('hex'),
    });
  }

  const version = buffer.readUInt8(offset + OFFSET_VERSION);
  if (version !== HELPER_PROTOCOL_VERSION) {
    throw new PilotError(
      'protocol-version-mismatch',
      `Unsupported helper frame version ${String(version)}`,
      {
        userMessage: 'Pilot and its macOS helper are running mismatched versions.',
        retryable: false,
        details: { expected: HELPER_PROTOCOL_VERSION, received: version },
      },
    );
  }

  const flags = buffer.readUInt8(offset + OFFSET_FLAGS);
  const reserved = buffer.readUInt16BE(offset + OFFSET_RESERVED);
  if (flags !== 0 || reserved !== 0) {
    throw malformed('Frame header uses reserved bits', { flags, reserved });
  }

  const messageLength = buffer.readUInt32BE(offset + OFFSET_MESSAGE_LENGTH);
  const binaryLength = buffer.readUInt32BE(offset + OFFSET_BINARY_LENGTH);

  if (messageLength === 0) {
    throw malformed('Frame header declares an empty message body', { messageLength });
  }
  if (messageLength > MAX_FRAME_MESSAGE_BYTES) {
    throw tooLarge('Frame message body exceeds the protocol limit', {
      messageLength,
      limit: MAX_FRAME_MESSAGE_BYTES,
    });
  }
  if (binaryLength > MAX_FRAME_BINARY_BYTES) {
    throw tooLarge('Frame binary body exceeds the protocol limit', {
      binaryLength,
      limit: MAX_FRAME_BINARY_BYTES,
    });
  }

  const totalLength = FRAME_HEADER_BYTES + messageLength + binaryLength;
  if (totalLength > MAX_FRAME_BYTES) {
    throw tooLarge('Frame exceeds the protocol limit', {
      totalLength,
      limit: MAX_FRAME_BYTES,
    });
  }

  return { version, flags, messageLength, binaryLength, totalLength };
}

/** Encodes one frame. Throws before writing anything if the bodies are oversized. */
export function encodeFrame(message: string, binary: Uint8Array = EMPTY): Buffer {
  const messageBytes = Buffer.from(message, 'utf8');
  if (messageBytes.length === 0) {
    throw malformed('Refusing to encode a frame with an empty message body', {});
  }
  if (messageBytes.length > MAX_FRAME_MESSAGE_BYTES) {
    throw tooLarge('Frame message body exceeds the protocol limit', {
      messageLength: messageBytes.length,
      limit: MAX_FRAME_MESSAGE_BYTES,
    });
  }
  if (binary.byteLength > MAX_FRAME_BINARY_BYTES) {
    throw tooLarge('Frame binary body exceeds the protocol limit', {
      binaryLength: binary.byteLength,
      limit: MAX_FRAME_BINARY_BYTES,
    });
  }

  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + messageBytes.length + binary.byteLength);
  MAGIC_BYTES.copy(frame, 0);
  frame.writeUInt8(HELPER_PROTOCOL_VERSION, OFFSET_VERSION);
  frame.writeUInt8(0, OFFSET_FLAGS);
  frame.writeUInt16BE(0, OFFSET_RESERVED);
  frame.writeUInt32BE(messageBytes.length, OFFSET_MESSAGE_LENGTH);
  frame.writeUInt32BE(binary.byteLength, OFFSET_BINARY_LENGTH);
  messageBytes.copy(frame, FRAME_HEADER_BYTES);
  if (binary.byteLength > 0) {
    Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength).copy(
      frame,
      FRAME_HEADER_BYTES + messageBytes.length,
    );
  }
  return frame;
}

/**
 * Incremental decoder over a byte stream that arrives in arbitrary chunks.
 *
 * `push` returns every complete frame the chunk finished. The first malformed
 * or oversized header poisons the decoder: it throws that error then, and
 * rethrows it for every later `push`, because a stream whose framing is wrong
 * cannot be resynchronised safely.
 */
export class FrameDecoder {
  #buffer: Buffer = EMPTY;
  #failure: PilotError | undefined;

  /** Bytes received but not yet consumed by a complete frame. */
  get bufferedBytes(): number {
    return this.#buffer.length;
  }

  /** The error that poisoned this decoder, if any. */
  get failure(): PilotError | undefined {
    return this.#failure;
  }

  push(chunk: Uint8Array): HelperFrame[] {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }

    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.#buffer =
      this.#buffer.length === 0 ? Buffer.from(incoming) : Buffer.concat([this.#buffer, incoming]);

    const frames: HelperFrame[] = [];
    try {
      for (;;) {
        if (this.#buffer.length < FRAME_HEADER_BYTES) {
          break;
        }
        const header = parseFrameHeader(this.#buffer);
        if (this.#buffer.length < header.totalLength) {
          break;
        }
        const messageEnd = FRAME_HEADER_BYTES + header.messageLength;
        frames.push({
          message: Buffer.from(this.#buffer.subarray(FRAME_HEADER_BYTES, messageEnd)),
          binary:
            header.binaryLength === 0
              ? EMPTY
              : Buffer.from(this.#buffer.subarray(messageEnd, header.totalLength)),
        });
        this.#buffer = Buffer.from(this.#buffer.subarray(header.totalLength));
      }
    } catch (error) {
      this.#failure = toPilotError(error, 'invalid-request');
      this.#buffer = EMPTY;
      throw this.#failure;
    }

    return frames;
  }

  /** Discards buffered bytes and clears the poison flag. */
  reset(): void {
    this.#buffer = EMPTY;
    this.#failure = undefined;
  }
}
