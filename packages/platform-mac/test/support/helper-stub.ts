/**
 * Node stand-in for the Swift helper.
 *
 * The Swift toolchain does not exist on the Linux development machine
 * (runbook §2), so this process is the deterministic harness the delivery
 * rules require: it speaks the exact same framed protocol as
 * `native/Sources/PilotHelperCore`, and every host-side test runs against it.
 *
 * It is deliberately a *second, independent implementation* of the wire
 * format — it imports nothing from `src/` — so a codec that only agrees with
 * itself cannot pass. It mirrors the Swift implementation byte for byte.
 *
 * Run it with plain `node` (Node 24 strips the types):
 *
 * ```sh
 * PILOT_HELPER_STUB='{"crashAfterRequests":1}' node test/support/helper-stub.ts
 * ```
 *
 * Behaviour is configured through the `PILOT_HELPER_STUB` environment
 * variable, a JSON object matching {@link StubConfig}.
 */

export interface StubConfig {
  /** Reported by `health`. */
  helperVersion?: string;
  /** Delay before the stub starts reading stdin. */
  startupDelayMs?: number;
  /** Emit a `helper.ready` event on start. Default false. */
  emitReadyEvent?: boolean;
  /** Delay before every response. Used to drive the request timeout path. */
  responseDelayMs?: number;
  /** Never answer anything. Used to drive the unresponsive-helper path. */
  dropRequests?: boolean;
  /** Never answer these operations. */
  dropOps?: string[];
  /** Exit after this many requests have been answered. */
  crashAfterRequests?: number;
  /** Exit without answering when one of these operations is requested. */
  crashOnOps?: string[];
  /** Exit immediately, before reading anything. */
  crashOnStart?: boolean;
  /** Exit code used by the crash options. Default 9. */
  exitCode?: number;
  /** Line written to stderr on start, so crash reports have something to show. */
  stderrLine?: string;
  /** Answer with a request id nobody asked for. `health` is left intact so the handshake still works. */
  corruptResponseId?: boolean;
  /** Answer with the wrong operation name. `health` is left intact. */
  corruptResponseOp?: boolean;
  /** Send an extra, unsolicited response frame after answering. */
  duplicateResponse?: boolean;
  /** Write a header with the wrong magic instead of a valid first frame. */
  emitBadMagic?: boolean;
  /** Write a header whose declared message length is over the protocol limit. */
  emitOversizedHeader?: boolean;
  /** Write a header carrying a future protocol version. */
  emitFutureVersion?: boolean;
  /**
   * Ignore SIGTERM *and* a closed stdin so the shutdown path has to escalate
   * to SIGKILL.
   */
  ignoreSigterm?: boolean;
  /** Echo the request's binary payload back. Default true. */
  echoBinary?: boolean;
}

// ---------------------------------------------------------------------------
// Wire format (independent reimplementation — keep in sync with the docs)
// ---------------------------------------------------------------------------

const MAGIC = Buffer.from('PILT', 'ascii');
const PROTOCOL_VERSION = 1;
const HEADER_BYTES = 16;
const MAX_MESSAGE_BYTES = 1_048_576;
const MAX_BINARY_BYTES = 33_554_432;

interface StubFrame {
  message: Buffer;
  binary: Buffer;
}

function encodeFrame(messageJson: string, binary: Buffer = Buffer.alloc(0)): Buffer {
  const message = Buffer.from(messageJson, 'utf8');
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt8(PROTOCOL_VERSION, 4);
  header.writeUInt8(0, 5);
  header.writeUInt16BE(0, 6);
  header.writeUInt32BE(message.length, 8);
  header.writeUInt32BE(binary.length, 12);
  return Buffer.concat([header, message, binary]);
}

class StubDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): StubFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: StubFrame[] = [];
    for (;;) {
      if (this.buffer.length < HEADER_BYTES) {
        break;
      }
      if (this.buffer.compare(MAGIC, 0, 4, 0, 4) !== 0) {
        throw new Error('stub: bad frame magic');
      }
      if (this.buffer.readUInt8(4) !== PROTOCOL_VERSION) {
        throw new Error('stub: unsupported frame version');
      }
      if (this.buffer.readUInt8(5) !== 0 || this.buffer.readUInt16BE(6) !== 0) {
        throw new Error('stub: reserved header bits set');
      }
      const messageLength = this.buffer.readUInt32BE(8);
      const binaryLength = this.buffer.readUInt32BE(12);
      if (messageLength === 0 || messageLength > MAX_MESSAGE_BYTES) {
        throw new Error('stub: message length out of range');
      }
      if (binaryLength > MAX_BINARY_BYTES) {
        throw new Error('stub: binary length out of range');
      }
      const total = HEADER_BYTES + messageLength + binaryLength;
      if (this.buffer.length < total) {
        break;
      }
      frames.push({
        message: Buffer.from(this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + messageLength)),
        binary: Buffer.from(this.buffer.subarray(HEADER_BYTES + messageLength, total)),
      });
      this.buffer = Buffer.from(this.buffer.subarray(total));
    }
    return frames;
  }
}

// ---------------------------------------------------------------------------
// Stub behaviour
// ---------------------------------------------------------------------------

interface RequestMessage {
  kind: string;
  protocolVersion: number;
  id: string;
  op: string;
  issuedAt: number;
  payload: unknown;
}

function readConfig(): StubConfig {
  const raw = process.env.PILOT_HELPER_STUB;
  if (raw === undefined || raw === '') {
    return {};
  }
  return JSON.parse(raw) as StubConfig;
}

function serializedError(code: string, domain: string, message: string): unknown {
  return {
    name: 'PilotError',
    code,
    domain,
    message,
    userMessage: 'The macOS helper could not run that operation.',
    retryable: false,
  };
}

function main(): void {
  const config = readConfig();
  const exitCode = config.exitCode ?? 9;
  const startedAt = Date.now();
  const helperVersion = config.helperVersion ?? '0.0.0-stub';
  const echoBinary = config.echoBinary ?? true;
  let answered = 0;

  if (config.stderrLine !== undefined) {
    process.stderr.write(`${config.stderrLine}\n`);
  }

  if (config.crashOnStart === true) {
    process.exit(exitCode);
  }

  const stubborn = config.ignoreSigterm === true;
  if (stubborn) {
    process.on('SIGTERM', () => {
      process.stderr.write('stub: ignoring SIGTERM\n');
    });
    // Without a live handle the process would exit as soon as stdin closes,
    // which is exactly what this mode must not do.
    setInterval(() => undefined, 1_000);
  }

  const write = (buffer: Buffer): void => {
    process.stdout.write(buffer);
  };

  if (config.emitBadMagic === true) {
    const header = Buffer.alloc(HEADER_BYTES);
    header.write('NOPE', 0, 'ascii');
    header.writeUInt32BE(2, 8);
    write(Buffer.concat([header, Buffer.from('{}', 'utf8')]));
  }

  if (config.emitOversizedHeader === true) {
    const header = Buffer.alloc(HEADER_BYTES);
    MAGIC.copy(header, 0);
    header.writeUInt8(PROTOCOL_VERSION, 4);
    header.writeUInt32BE(MAX_MESSAGE_BYTES + 1, 8);
    write(header);
  }

  if (config.emitFutureVersion === true) {
    const header = Buffer.alloc(HEADER_BYTES);
    MAGIC.copy(header, 0);
    header.writeUInt8(PROTOCOL_VERSION + 1, 4);
    header.writeUInt32BE(2, 8);
    write(Buffer.concat([header, Buffer.from('{}', 'utf8')]));
  }

  if (config.emitReadyEvent === true) {
    write(
      encodeFrame(
        JSON.stringify({
          kind: 'event',
          protocolVersion: PROTOCOL_VERSION,
          id: 'evt-ready',
          op: 'helper.ready',
          issuedAt: Date.now(),
          payload: { helperVersion, protocolVersion: PROTOCOL_VERSION, pid: process.pid },
        }),
      ),
    );
  }

  const respond = (request: RequestMessage, binary: Buffer): void => {
    const corruptible = request.op !== 'health';
    const id =
      config.corruptResponseId === true && corruptible ? `${request.id}-wrong` : request.id;
    const op = config.corruptResponseOp === true && corruptible ? 'health' : request.op;

    let body: string;
    let attachment: Buffer = Buffer.alloc(0);

    if (request.op === 'health') {
      body = JSON.stringify({
        kind: 'response',
        protocolVersion: PROTOCOL_VERSION,
        id,
        op,
        issuedAt: Date.now(),
        ok: true,
        payload: {
          status: 'ok',
          helperVersion,
          protocolVersion: PROTOCOL_VERSION,
          pid: process.pid,
          uptimeMs: Date.now() - startedAt,
        },
      });
    } else if (request.op === 'echo') {
      const text = (request.payload as { text?: unknown } | null)?.text;
      if (typeof text !== 'string') {
        body = JSON.stringify({
          kind: 'response',
          protocolVersion: PROTOCOL_VERSION,
          id,
          op,
          issuedAt: Date.now(),
          ok: false,
          error: serializedError('invalid-request', 'ipc', 'echo requires a text field'),
        });
      } else {
        if (echoBinary) {
          attachment = binary;
        }
        body = JSON.stringify({
          kind: 'response',
          protocolVersion: PROTOCOL_VERSION,
          id,
          op,
          issuedAt: Date.now(),
          ok: true,
          payload: { text, binaryLength: binary.length },
        });
      }
    } else {
      body = JSON.stringify({
        kind: 'response',
        protocolVersion: PROTOCOL_VERSION,
        id,
        op,
        issuedAt: Date.now(),
        ok: false,
        error: serializedError('invalid-request', 'ipc', `unknown operation "${request.op}"`),
      });
    }

    write(encodeFrame(body, attachment));
    if (config.duplicateResponse === true) {
      write(encodeFrame(body, attachment));
    }

    answered += 1;
    if (config.crashAfterRequests !== undefined && answered >= config.crashAfterRequests) {
      process.exit(exitCode);
    }
  };

  const decoder = new StubDecoder();

  const begin = (): void => {
    process.stdin.on('data', (chunk: Buffer) => {
      let frames: StubFrame[];
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        process.stderr.write(`stub: ${(error as Error).message}\n`);
        process.exit(exitCode);
      }
      for (const frame of frames) {
        const request = JSON.parse(frame.message.toString('utf8')) as RequestMessage;
        if (request.kind !== 'request') {
          continue;
        }
        if ((config.crashOnOps ?? []).includes(request.op)) {
          process.stderr.write(`stub: crashing on "${request.op}"\n`);
          process.exit(exitCode);
        }
        if (config.dropRequests === true || (config.dropOps ?? []).includes(request.op)) {
          continue;
        }
        if (config.responseDelayMs !== undefined && config.responseDelayMs > 0) {
          setTimeout(() => {
            respond(request, frame.binary);
          }, config.responseDelayMs);
        } else {
          respond(request, frame.binary);
        }
      }
    });
    process.stdin.on('end', () => {
      if (!stubborn) {
        process.exit(0);
      }
    });
  };

  if (config.startupDelayMs !== undefined && config.startupDelayMs > 0) {
    setTimeout(begin, config.startupDelayMs);
  } else {
    begin();
  }
}

main();
