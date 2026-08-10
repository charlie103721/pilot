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

// ---------------------------------------------------------------------------
// PR-011 shapes
//
// Declared inline, not imported from `src/`, for the same reason the wire
// format is reimplemented below: a stub that shares types with the code under
// test cannot catch a contract drift between them.
// ---------------------------------------------------------------------------

export type StubPermissionKind =
  'screen-recording' | 'accessibility' | 'microphone' | 'speech-recognition';

export type StubPermissionState = 'unknown' | 'denied' | 'restricted' | 'granted';

export interface StubPermissionProbe {
  kind: StubPermissionKind;
  state: StubPermissionState;
  canRequest: boolean;
  api: 'cg-preflight' | 'ax-trusted' | 'av-authorization' | 'sf-authorization' | 'unavailable';
  raw: string;
  restrictedRepresentable: boolean;
  requiresRelaunch: boolean;
}

export interface StubAttributionEvidence {
  helperPid: number;
  parentPid: number;
  helperExecutablePath: string | null;
  helperBundleIdentifier: string | null;
  enclosingAppBundlePath: string | null;
  enclosingAppBundleIdentifier: string | null;
  responsibleProcessPid: number | null;
  responsibleProcessQueried: boolean;
  mainBundleIsApp: boolean;
}

export interface StubRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StubWindow {
  windowNumber: number;
  ownerPid: number;
  applicationName: string;
  applicationBundleId: string | null;
  title: string | null;
  titleAvailable: boolean;
  bounds: StubRect;
  displayNumber: number | null;
  isOnScreen: boolean;
  layer: number;
}

export interface StubDisplay {
  displayNumber: number;
  bounds: StubRect;
  scaleFactor: number;
  isPrimary: boolean;
}

/** One state of the desktop, as `windows.list` would report it. */
export interface StubDesktop {
  windows?: StubWindow[];
  displays?: StubDisplay[];
  screenLocked?: boolean;
}

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

  // -------------------------------------------------------------------------
  // PR-011
  // -------------------------------------------------------------------------

  /** Permission states reported by `permissions.status` and `.snapshot`. */
  permissions?: Partial<Record<StubPermissionKind, StubPermissionState>>;
  /** Per-permission overrides of the probe metadata. */
  permissionProbeOverrides?: Partial<
    Record<StubPermissionKind, Partial<Omit<StubPermissionProbe, 'kind'>>>
  >;
  /**
   * State each permission moves to when `permissions.request` prompts for it.
   * Omitted kinds stay where they are, which is what macOS does for a
   * permission the user has already refused.
   */
  permissionsAfterRequest?: Partial<Record<StubPermissionKind, StubPermissionState>>;
  /** Drop a permission from `permissions.snapshot`, to exercise the host's completeness check. */
  omitPermissionsFromSnapshot?: StubPermissionKind[];
  /** Make `permissions.open-settings` report failure. */
  openSettingsFails?: boolean;
  /** Evidence returned by `permissions.attribution`. Defaults to a correctly attributed bundle. */
  attribution?: Partial<StubAttributionEvidence>;

  /** The desktop reported by the first `windows.list`. */
  desktop?: StubDesktop;
  /**
   * Successive desktops. Call *n* of `windows.list` answers with entry *n*,
   * and the last entry repeats. This is how lifecycle events are driven
   * deterministically: no timers, no sleeping, no races.
   */
  desktopScript?: StubDesktop[];
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

// ---------------------------------------------------------------------------
// PR-011 operation handling
// ---------------------------------------------------------------------------

const PERMISSION_KINDS: StubPermissionKind[] = [
  'screen-recording',
  'accessibility',
  'microphone',
  'speech-recognition',
];

/**
 * Which macOS API each permission is answered by, and what that API can say.
 * Mirrors `SystemPermissionService`; the whole point of the stub is that the
 * host cannot tell the difference.
 */
const PROBE_SHAPE: Record<
  StubPermissionKind,
  Pick<StubPermissionProbe, 'api' | 'restrictedRepresentable' | 'requiresRelaunch'>
> = {
  'screen-recording': {
    api: 'cg-preflight',
    restrictedRepresentable: false,
    requiresRelaunch: true,
  },
  accessibility: { api: 'ax-trusted', restrictedRepresentable: false, requiresRelaunch: false },
  microphone: { api: 'av-authorization', restrictedRepresentable: true, requiresRelaunch: false },
  'speech-recognition': {
    api: 'sf-authorization',
    restrictedRepresentable: true,
    requiresRelaunch: false,
  },
};

const SETTINGS_URL: Record<StubPermissionKind, string> = {
  'screen-recording':
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  'speech-recognition':
    'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition',
};

const DEFAULT_ATTRIBUTION: StubAttributionEvidence = {
  helperPid: 4321,
  parentPid: 1234,
  helperExecutablePath: '/Applications/Pilot.app/Contents/MacOS/PilotHelper',
  helperBundleIdentifier: null,
  enclosingAppBundlePath: '/Applications/Pilot.app',
  enclosingAppBundleIdentifier: 'com.pilot.app',
  responsibleProcessPid: 1234,
  responsibleProcessQueried: true,
  mainBundleIsApp: false,
};

/** Live permission state, mutated by `permissions.request`. */
class StubPermissionTable {
  private readonly states = new Map<StubPermissionKind, StubPermissionState>();
  private readonly config: StubConfig;

  // Parameter properties are not supported by Node's type stripping, so the
  // assignments here are written out. Same in `StubDesktopScript` below.
  constructor(config: StubConfig) {
    this.config = config;
    for (const kind of PERMISSION_KINDS) {
      this.states.set(kind, config.permissions?.[kind] ?? 'unknown');
    }
  }

  probe(kind: StubPermissionKind): StubPermissionProbe {
    const state = this.states.get(kind) ?? 'unknown';
    const shape = PROBE_SHAPE[kind];
    const base: StubPermissionProbe = {
      kind,
      state,
      // Only `unknown` can still be prompted for: `denied` means macOS will
      // not ask twice, `restricted` is policy, `granted` is done.
      canRequest: state === 'unknown',
      api: shape.api,
      raw: state,
      restrictedRepresentable: shape.restrictedRepresentable,
      requiresRelaunch: shape.requiresRelaunch,
    };
    return { ...base, ...(this.config.permissionProbeOverrides?.[kind] ?? {}), kind };
  }

  request(kind: StubPermissionKind): { probe: StubPermissionProbe; prompted: boolean } {
    const before = this.probe(kind);
    if (!before.canRequest) {
      return { probe: before, prompted: false };
    }
    const next = this.config.permissionsAfterRequest?.[kind];
    if (next !== undefined) {
      this.states.set(kind, next);
    }
    return { probe: this.probe(kind), prompted: true };
  }

  snapshot(): StubPermissionProbe[] {
    const omitted = new Set(this.config.omitPermissionsFromSnapshot ?? []);
    return PERMISSION_KINDS.filter((kind) => !omitted.has(kind)).map((kind) => this.probe(kind));
  }
}

/** Successive desktops, advanced by each `windows.list` call. */
class StubDesktopScript {
  private index = 0;
  private readonly frames: StubDesktop[];

  constructor(frames: StubDesktop[]) {
    this.frames = frames;
  }

  next(): StubDesktop {
    const frame = this.frames[Math.min(this.index, this.frames.length - 1)] ?? {};
    this.index += 1;
    return frame;
  }

  /** The desktop most recently handed out, without advancing. */
  current(): StubDesktop {
    return this.frames[Math.min(Math.max(this.index - 1, 0), this.frames.length - 1)] ?? {};
  }
}

function desktopPayload(desktop: StubDesktop, includeAllLayers: boolean): unknown {
  const all = desktop.windows ?? [];
  const windows = includeAllLayers ? all : all.filter((window) => window.layer === 0);
  return {
    windows,
    displays: desktop.displays ?? [],
    screenLocked: desktop.screenLocked ?? false,
    titlesWithheld: windows.length > 0 && windows.every((window) => !window.titleAvailable),
    capturedAt: Date.now(),
  };
}

function main(): void {
  const config = readConfig();
  const exitCode = config.exitCode ?? 9;
  const startedAt = Date.now();
  const helperVersion = config.helperVersion ?? '0.0.0-stub';
  const echoBinary = config.echoBinary ?? true;
  const permissions = new StubPermissionTable(config);
  const desktops = new StubDesktopScript(
    config.desktopScript ?? (config.desktop === undefined ? [{}] : [config.desktop]),
  );
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

    const envelope = (fields: Record<string, unknown>): string =>
      JSON.stringify({
        kind: 'response',
        protocolVersion: PROTOCOL_VERSION,
        id,
        op,
        issuedAt: Date.now(),
        ...fields,
      });
    const ok = (payload: unknown): string => envelope({ ok: true, payload });
    const fail = (message: string): string =>
      envelope({ ok: false, error: serializedError('invalid-request', 'ipc', message) });

    const payloadOf = request.payload as Record<string, unknown> | null;
    const kindOf = (): StubPermissionKind | null => {
      const raw = payloadOf?.kind;
      return typeof raw === 'string' && (PERMISSION_KINDS as string[]).includes(raw)
        ? (raw as StubPermissionKind)
        : null;
    };

    let body: string;
    let attachment: Buffer = Buffer.alloc(0);

    if (request.op === 'health') {
      body = ok({
        status: 'ok',
        helperVersion,
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
      });
    } else if (request.op === 'echo') {
      const text = (request.payload as { text?: unknown } | null)?.text;
      if (typeof text !== 'string') {
        body = fail('echo requires a text field');
      } else {
        if (echoBinary) {
          attachment = binary;
        }
        body = ok({ text, binaryLength: binary.length });
      }
    } else if (request.op === 'permissions.status') {
      const kind = kindOf();
      body =
        kind === null ? fail('unknown permission kind') : ok({ probe: permissions.probe(kind) });
    } else if (request.op === 'permissions.snapshot') {
      body = ok({ probes: permissions.snapshot() });
    } else if (request.op === 'permissions.request') {
      const kind = kindOf();
      body = kind === null ? fail('unknown permission kind') : ok(permissions.request(kind));
    } else if (request.op === 'permissions.open-settings') {
      const kind = kindOf();
      body =
        kind === null
          ? fail('unknown permission kind')
          : ok({ opened: config.openSettingsFails !== true, target: SETTINGS_URL[kind] });
    } else if (request.op === 'permissions.attribution') {
      const expected = payloadOf?.expected as { hostPid?: unknown } | undefined;
      if (typeof expected?.hostPid !== 'number') {
        body = fail('permissions.attribution requires an expected.hostPid');
      } else {
        body = ok({ evidence: { ...DEFAULT_ATTRIBUTION, ...(config.attribution ?? {}) } });
      }
    } else if (request.op === 'windows.list') {
      body = ok(desktopPayload(desktops.next(), payloadOf?.includeAllLayers === true));
    } else if (request.op === 'windows.get') {
      const windowNumber = payloadOf?.windowNumber;
      if (typeof windowNumber !== 'number') {
        body = fail('windows.get requires a windowNumber');
      } else {
        const desktop = desktops.current();
        const window =
          (desktop.windows ?? []).find((entry) => entry.windowNumber === windowNumber) ?? null;
        const display =
          window === null
            ? null
            : ((desktop.displays ?? []).find(
                (entry) => entry.displayNumber === window.displayNumber,
              ) ?? null);
        body = ok({ window, display, screenLocked: desktop.screenLocked ?? false });
      }
    } else {
      body = fail(`unknown operation "${request.op}"`);
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
