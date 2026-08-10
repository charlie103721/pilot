import { PilotError, toPilotError } from '@pilot/shared';
import type { Readable, Writable } from 'node:stream';
import { FrameDecoder, encodeFrame } from '../protocol/frame.js';
import {
  decodeHelperMessage,
  encodeHelperMessage,
  type HelperMessage,
} from '../protocol/messages.js';

/**
 * Binds the framed protocol to a pair of streams (the helper's stdout/stdin).
 *
 * The channel owns exactly one concern: bytes in, validated messages out, and
 * messages in, bytes out. It knows nothing about supervision, correlation or
 * operations. A framing or validation failure is fatal for the channel — it
 * reports the typed error once and stops reading, because the remaining bytes
 * cannot be trusted to be frame-aligned.
 */

export interface HelperChannelHandlers {
  onMessage(message: HelperMessage, binary: Buffer): void;
  /** Framing, validation or stream failure. The channel is dead once this fires. */
  onFailure(error: PilotError): void;
}

export interface HelperChannelOptions {
  readonly readable: Readable;
  readonly writable: Writable;
  readonly handlers: HelperChannelHandlers;
}

export class HelperChannel {
  readonly #readable: Readable;
  readonly #writable: Writable;
  readonly #handlers: HelperChannelHandlers;
  readonly #decoder = new FrameDecoder();
  #closed = false;

  constructor(options: HelperChannelOptions) {
    this.#readable = options.readable;
    this.#writable = options.writable;
    this.#handlers = options.handlers;

    this.#readable.on('data', this.#onData);
    this.#readable.on('error', this.#onStreamError);
    this.#writable.on('error', this.#onStreamError);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Bytes received but not yet consumed by a complete frame. */
  get bufferedBytes(): number {
    return this.#decoder.bufferedBytes;
  }

  /**
   * Encodes and writes one frame. Throws synchronously (typed) when the
   * message or payload is oversized, or when the channel is already closed —
   * a caller never has to guess whether its write was silently dropped.
   */
  send(message: HelperMessage, binary?: Uint8Array): void {
    if (this.#closed) {
      throw new PilotError('helper-unavailable', 'Helper channel is closed', {
        userMessage: 'Pilot lost contact with its macOS helper.',
        retryable: true,
        details: { op: message.op },
      });
    }
    const frame = encodeFrame(encodeHelperMessage(message), binary);
    this.#writable.write(frame);
  }

  /** Stops reading and detaches listeners. Does not destroy the streams. */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#readable.off('data', this.#onData);
    this.#readable.off('error', this.#onStreamError);
    this.#writable.off('error', this.#onStreamError);
  }

  #onData = (chunk: Buffer): void => {
    if (this.#closed) {
      return;
    }
    let frames;
    try {
      frames = this.#decoder.push(chunk);
    } catch (error) {
      this.#fail(toPilotError(error, 'invalid-request'));
      return;
    }
    for (const frame of frames) {
      let message: HelperMessage;
      try {
        message = decodeHelperMessage(frame.message);
      } catch (error) {
        this.#fail(toPilotError(error, 'invalid-request'));
        return;
      }
      this.#handlers.onMessage(message, frame.binary);
      if (this.#closed) {
        return;
      }
    }
  };

  #onStreamError = (error: unknown): void => {
    this.#fail(
      new PilotError('helper-unavailable', 'Helper stream failed', {
        userMessage: 'Pilot lost contact with its macOS helper.',
        retryable: true,
        cause: error,
      }),
    );
  };

  #fail(error: PilotError): void {
    if (this.#closed) {
      return;
    }
    this.close();
    this.#handlers.onFailure(error);
  }
}
