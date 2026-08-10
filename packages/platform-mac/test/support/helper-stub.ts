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

// ---------------------------------------------------------------------------
// PR-013 shapes
// ---------------------------------------------------------------------------

export type StubSecureBasis = 'role' | 'subrole' | 'ancestor' | 'none';

export type StubElementOutcome =
  'reported' | 'no-element' | 'not-trusted' | 'query-failed' | 'not-requested';

/**
 * One accessibility element the stub can report, plus the screen rectangle it
 * occupies. The stub hit-tests these rectangles the way
 * `AXUIElementCopyElementAtPosition` hit-tests a real tree.
 */
export interface StubAxElement {
  bounds: StubRect;
  role?: string | null;
  subrole?: string | null;
  label?: string | null;
  value?: string | null;
  /**
   * Owning application. When `accessibility.element-at` is given an `ownerPid`
   * the stub considers only elements with that owner, mirroring
   * `AXUIElementCreateApplication` scoping.
   */
  ownerPid?: number | null;
}

// PR-015 shapes
// ---------------------------------------------------------------------------

export type StubHotkeyTapState =
  'active' | 'stopped' | 'accessibility-denied' | 'creation-failed' | 'disabled';

export type StubHotkeyTapChange =
  | 'started'
  | 'stopped'
  | 'disabled-by-timeout'
  | 'disabled-by-user-input'
  | 're-enabled'
  | 'failed';

export interface StubHotkeyBinding {
  keyCode: number;
  label: string;
  isModifierKey: boolean;
  requiredModifiers: string[];
}

/**
 * One scripted thing the "tap" does after `hotkey.start` has been answered.
 *
 * The stub deliberately plays a script *verbatim*, including auto-repeat and
 * duplicate phases that the real Swift gate would have dropped. That makes it a
 * hostile helper, which is the useful kind: it proves the host-side coalescer
 * works on its own rather than inheriting correctness from a Swift file that
 * has never been compiled.
 */
export type StubHotkeyStep =
  | { key: 'down' | 'up'; autorepeat?: boolean; keyCode?: number }
  | { tap: StubHotkeyTapChange; state?: StubHotkeyTapState; detail?: string; held?: boolean };

/** One state of the desktop, as `windows.list` would report it. */
export interface StubDesktop {
  windows?: StubWindow[];
  displays?: StubDisplay[];
  screenLocked?: boolean;
}

// ---------------------------------------------------------------------------
// PR-012 shapes
// ---------------------------------------------------------------------------

export type StubCaptureState =
  'starting' | 'streaming' | 'protected' | 'window-lost' | 'screen-locked' | 'stopped' | 'failed';

/** One frame the scripted stream produces. */
export interface StubCaptureFrame {
  /** Defaults to a per-stream counter starting at 1. */
  sequence?: number;
  /** Defaults to the window `capture.start` named. Set it to forge a foreign frame. */
  windowNumber?: number;
  /** Absolute epoch ms. Overrides `ageMs`. */
  capturedAt?: number;
  /** Epoch ms offset backwards from now. Default 0. */
  ageMs?: number;
  timestampFallback?: boolean;
  width?: number;
  height?: number;
  scaleFactor?: number;
  encoding?: 'jpeg' | 'png';
  /** Bytes actually written into the frame's binary body. Default 2048. */
  bytes?: number;
  /** Header `byteLength`, when it must disagree with the body. */
  declaredByteLength?: number;
  contentChanged?: boolean;
}

/** What one `capture.pull` answers with. The last entry repeats forever. */
export interface StubCapturePull {
  state?: StubCaptureState;
  frame?: StubCaptureFrame | null;
  remaining?: number;
  /** Cumulative helper-side drops, as the real helper reports them. */
  dropped?: number;
  failure?: string | null;
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

  // -------------------------------------------------------------------------
  // PR-013
  // -------------------------------------------------------------------------

  /** Pointer position reported by `accessibility.sample`. */
  pointer?: { x: number; y: number };
  /**
   * Successive pointer positions. Call *n* of `accessibility.sample` answers
   * with entry *n*, and the last entry repeats — the same scripted-sequence
   * device `desktopScript` uses, so pointer movement is driven without timers.
   */
  pointerScript?: Array<{ x: number; y: number }>;
  /** `AXIsProcessTrusted()`. Default true; false is the degraded mode. */
  axTrusted?: boolean;
  /** How the pointer position was read. Default `cg-event`. */
  pointerSource?: 'cg-event' | 'ns-event' | 'unavailable';
  /** Elements the hit test can find. The last match wins, as the topmost would. */
  axElements?: StubAxElement[];
  /** Make every hit test report `query-failed`, as a broken AX tree would. */
  axQueryFails?: boolean;
  // PR-014
  // -------------------------------------------------------------------------

  /** Recogniser facts and the scripted behaviour of `speech.input.*`. */
  speechInput?: StubSpeechInputConfig;
  /** Voices and the scripted behaviour of `speech.output.*`. */
  speechOutput?: StubSpeechOutputConfig;
  // PR-012
  // -------------------------------------------------------------------------

  /** Make `capture.start` fail with this message. */
  captureStartFails?: string;
  /** Answer `capture.start` with a different window than the one requested. */
  captureSessionWindowNumber?: number;
  /** Bytes in every generated frame when no script is supplied. Default 2048. */
  captureFrameBytes?: number;
  /**
   * Captured pixels per window point, as the helper computes it from the real
   * window's frame. The stub has no window to measure, so it is stated.
   */
  captureScaleFactor?: number;
  /**
   * Successive `capture.pull` answers. The last entry repeats. Without one the
   * stub streams an endless sequence of freshly stamped frames.
   */
  captureScript?: StubCapturePull[];
  /** Delay before answering `capture.pull`, to drive the abort path. */
  capturePullDelayMs?: number;
  // PR-015
  // -------------------------------------------------------------------------

  /** `AXIsProcessTrusted()` stand-in. Default true. */
  hotkeyAccessibility?: boolean;
  /** `CGEventTapCreate` returns null even though Accessibility is granted. */
  hotkeyTapFails?: boolean;
  /** Script played after every `hotkey.start`. */
  hotkeyScript?: StubHotkeyStep[];
  /**
   * Successive scripts. Call *n* of `hotkey.start` plays entry *n*, and the
   * last entry repeats — the same shape as `desktopScript`.
   *
   * The cursor lives in the stub **process**, so a helper restart begins again
   * at entry 0. That is faithful: a restarted helper has no tap and no memory
   * of the key either. Use `hotkeyScript` when the behaviour should survive a
   * restart.
   */
  hotkeyScripts?: StubHotkeyStep[][];
}

// ---------------------------------------------------------------------------
// PR-014 shapes
//
// The stub is a **driver, not a model**: it emits exactly what a script says,
// including things a well-behaved recogniser would never do. That is the
// point. Apple Speech finalises before the key is released, finalises twice,
// and calls back after `cancel()`; a stub that quietly refused to reproduce
// those would make the host's defences untestable, and the host would look
// correct right up until it met a real recogniser.
//
// The equivalent guarantees on the *helper* side (one ending per utterance,
// microphone released on an early final) live in `SpeechTerminalLedger` and
// are covered by `SpeechModelTests.swift`.
// ---------------------------------------------------------------------------

export interface StubSpeechEvent {
  type: 'partial' | 'final' | 'error';
  transcript?: string;
  code?: string;
  message?: string;
  /** Attribute the event to another utterance. Drives the stale-result paths. */
  utteranceId?: string;
}

/** Events emitted when the host makes a particular call. */
export interface StubSpeechStep {
  on: 'start' | 'stop' | 'cancel';
  emit: StubSpeechEvent[];
}

/** One utterance's worth of scripted recogniser behaviour. */
export interface StubSpeechScript {
  steps: StubSpeechStep[];
}

export interface StubSpeechFailure {
  /** `PilotError` code carried in the failure envelope. */
  code: string;
  /**
   * Failure code prefixed onto the message, the way the Swift helper writes it
   * (`"<failure-code>: <message>"`). Present so the host's remapping of a
   * helper failure into Pilot's own wording is exercised against the stub too.
   */
  failureCode?: string;
  message?: string;
}

export interface StubSpeechInputConfig {
  recognizerAvailable?: boolean;
  supportsOnDevice?: boolean;
  locale?: string | null;
  supportedLocales?: string[];
  recognizerOffline?: boolean;
  /** Make `speech.input.start` answer with a typed failure. */
  startFailsWith?: StubSpeechFailure;
  /** One script per `start`; the last entry repeats. */
  scripts?: StubSpeechScript[];
  /** Ring capacity, so the overflow/`dropped` path can be exercised. */
  queueCapacity?: number;
}

export interface StubSpeechVoice {
  identifier: string;
  name: string;
  language: string;
  quality: string;
}

export interface StubSpeechOutputEvent {
  type: 'started' | 'finished' | 'stopped' | 'error';
  code?: string;
  message?: string;
}

export interface StubSpeechOutputConfig {
  available?: boolean;
  voices?: StubSpeechVoice[];
  startFailsWith?: StubSpeechFailure;
  /**
   * Events enqueued by each `speak` call; the last entry repeats. Defaults to
   * `started` alone, which leaves the utterance playing until something stops
   * it — the state an interruption test needs.
   */
  scripts?: StubSpeechOutputEvent[][];
  queueCapacity?: number;
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

// ---------------------------------------------------------------------------
// PR-014 speech
// ---------------------------------------------------------------------------

interface StubQueuedEvent {
  sequence: number;
  body: Record<string, unknown>;
}

/**
 * Sequence-numbered, bounded event ring.
 *
 * Mirrors `SpeechEventQueue` in `native/Sources/PilotHelperCore/SpeechModel.swift`
 * — reimplemented rather than shared, for the same reason the wire format is:
 * a queue that only agrees with itself proves nothing about the two sides
 * agreeing with each other.
 */
class StubSpeechQueue {
  private readonly capacity: number;
  private events: StubQueuedEvent[] = [];
  private lastSequence = 0;
  private droppedCount = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  append(body: Record<string, unknown>): number {
    this.lastSequence += 1;
    this.events.push({ sequence: this.lastSequence, body });
    while (this.events.length > this.capacity) {
      this.events.shift();
      this.droppedCount += 1;
    }
    return this.lastSequence;
  }

  drain(since: number): {
    events: Record<string, unknown>[];
    sequence: number;
    dropped: number;
  } {
    this.events = this.events.filter((entry) => entry.sequence > since);
    return {
      events: this.events.map((entry) => ({ ...entry.body, sequence: entry.sequence })),
      sequence: this.lastSequence,
      dropped: this.droppedCount,
    };
  }
}

/** Scripted `speech.input.*`. */
class StubSpeechInput {
  private readonly config: StubSpeechInputConfig;
  private readonly queue: StubSpeechQueue;
  private cursor = 0;
  private script: StubSpeechScript | null = null;
  private active: string | null = null;
  private recording = false;

  constructor(config: StubSpeechInputConfig) {
    this.config = config;
    this.queue = new StubSpeechQueue(config.queueCapacity ?? 256);
  }

  facts(): Record<string, unknown> {
    return {
      recognizerAvailable: this.config.recognizerAvailable ?? true,
      supportsOnDevice: this.config.supportsOnDevice ?? true,
      locale: this.config.locale === undefined ? 'en-US' : this.config.locale,
      supportedLocales: this.config.supportedLocales ?? ['en-US', 'en-GB'],
      recognizerOffline: this.config.recognizerOffline ?? false,
    };
  }

  get startFailure(): StubSpeechFailure | undefined {
    return this.config.startFailsWith;
  }

  start(utteranceId: string): void {
    const scripts = this.config.scripts ?? [];
    this.script =
      scripts.length === 0 ? null : (scripts[Math.min(this.cursor, scripts.length - 1)] ?? null);
    this.cursor += 1;
    this.active = utteranceId;
    this.recording = true;
    this.run('start', utteranceId);
  }

  stop(utteranceId: string): boolean {
    if (this.active !== utteranceId || !this.recording) {
      return false;
    }
    this.recording = false;
    this.run('stop', utteranceId);
    return true;
  }

  cancel(utteranceId: string): boolean {
    if (this.active !== utteranceId) {
      return false;
    }
    this.recording = false;
    this.run('cancel', utteranceId);
    this.active = null;
    return true;
  }

  poll(since: number): Record<string, unknown> {
    const drained = this.queue.drain(since);
    return {
      events: drained.events,
      sequence: drained.sequence,
      dropped: drained.dropped,
      recording: this.recording,
      activeUtteranceId: this.active,
    };
  }

  private run(trigger: StubSpeechStep['on'], utteranceId: string): void {
    for (const step of this.script?.steps ?? []) {
      if (step.on !== trigger) {
        continue;
      }
      for (const event of step.emit) {
        const target = event.utteranceId ?? utteranceId;
        if (event.type === 'error') {
          this.queue.append({
            type: 'error',
            utteranceId: target,
            code: event.code ?? 'recognizer-failed',
            message: event.message ?? 'scripted failure',
          });
        } else {
          this.queue.append({
            type: event.type,
            utteranceId: target,
            transcript: event.transcript ?? '',
          });
        }
        // A real recogniser that has produced a terminal result has let go of
        // the microphone, whether or not the key is still held.
        if (event.type !== 'partial' && target === this.active) {
          this.recording = false;
        }
      }
    }
  }
}

/** Scripted `speech.output.*`. */
class StubSpeechOutput {
  private readonly config: StubSpeechOutputConfig;
  private readonly queue: StubSpeechQueue;
  private cursor = 0;
  private pending: string[] = [];

  constructor(config: StubSpeechOutputConfig) {
    this.config = config;
    this.queue = new StubSpeechQueue(config.queueCapacity ?? 256);
  }

  availability(): Record<string, unknown> {
    const voices = this.config.voices ?? [
      {
        identifier: 'com.apple.voice.compact.en-US.Samantha',
        name: 'Samantha',
        language: 'en-US',
        quality: 'default',
      },
    ];
    return {
      available: this.config.available ?? voices.length > 0,
      voices: this.config.available === false ? [] : voices,
    };
  }

  get speakFailure(): StubSpeechFailure | undefined {
    return this.config.startFailsWith;
  }

  speak(speechId: string): boolean {
    const queued = this.pending.length > 0;
    this.pending.push(speechId);
    const scripts = this.config.scripts ?? [[{ type: 'started' }]];
    const script = scripts[Math.min(this.cursor, scripts.length - 1)] ?? [{ type: 'started' }];
    this.cursor += 1;
    for (const event of script) {
      if (event.type === 'error') {
        this.queue.append({
          type: 'error',
          speechId,
          code: event.code ?? 'synthesis-failed',
          message: event.message ?? 'scripted failure',
        });
      } else {
        this.queue.append({ type: event.type, speechId });
      }
      if (event.type !== 'started') {
        this.pending = this.pending.filter((entry) => entry !== speechId);
      }
    }
    return queued;
  }

  stop(speechId: string | null): string[] {
    if (speechId !== null && !this.pending.includes(speechId)) {
      return [];
    }
    const stopped = [...this.pending];
    this.pending = [];
    return stopped;
  }

  poll(since: number): Record<string, unknown> {
    const drained = this.queue.drain(since);
    return {
      events: drained.events,
      sequence: drained.sequence,
      dropped: drained.dropped,
      speaking: this.pending.length > 0,
      activeSpeechId: this.pending[0] ?? null,
    };
  }
}

/** `"<failure-code>: <message>"`, exactly as `HelperServer.speechFailure` writes it. */
function speechFailureMessage(failure: StubSpeechFailure, fallback: string): string {
  const message = failure.message ?? fallback;
  return failure.failureCode === undefined ? message : `${failure.failureCode}: ${message}`;
}

/**
 * The scripted capture stream (PR-012).
 *
 * Stands in for the ScreenCaptureKit engine in
 * `native/Sources/PilotHelperCore/CaptureEngine.swift`. It reproduces the parts
 * of that engine the host can actually observe — the bounded queue's `dropped`
 * and `remaining` counters, the `notBefore` discard rule that makes a fresh
 * capture fresh, the terminal states, and a binary body whose length matches
 * the header — and nothing else. It knows nothing about `src/`.
 */
class StubCaptureStream {
  private readonly config: StubConfig;
  private readonly script: StubCapturePull[];
  private index = 0;
  private sequence = 0;
  private delivered = 0;
  private dropped = 0;

  streamId: string | null = null;
  windowNumber = 0;
  width = 0;
  height = 0;
  scaleFactor = 1;
  encoding: 'jpeg' | 'png' = 'jpeg';

  constructor(config: StubConfig) {
    this.config = config;
    this.script = config.captureScript ?? [];
  }

  start(request: Record<string, unknown>): Record<string, unknown> {
    this.streamId = `stream-${String(Date.now())}-${String(process.pid)}`;
    this.windowNumber =
      this.config.captureSessionWindowNumber ?? (request.windowNumber as number) ?? 0;
    this.width = (request.width as number) ?? 1;
    this.height = (request.height as number) ?? 1;
    this.encoding = ((request.encoding as string) ?? 'jpeg') === 'png' ? 'png' : 'jpeg';
    this.scaleFactor = this.config.captureScaleFactor ?? 1;
    this.index = 0;
    this.sequence = 0;
    this.delivered = 0;
    this.dropped = 0;
    return {
      streamId: this.streamId,
      windowNumber: this.windowNumber,
      width: this.width,
      height: this.height,
      scaleFactor: this.scaleFactor,
      sampleFps: (request.sampleFps as number) ?? 3,
      encoding: this.encoding,
      startedAt: Date.now(),
    };
  }

  stop(): Record<string, unknown> {
    const wasRunning = this.streamId !== null;
    this.streamId = null;
    return {
      stopped: wasRunning,
      delivered: this.delivered,
      dropped: this.dropped,
      discarded: 0,
    };
  }

  /** Advances the script, honouring `notBefore` the way the helper's queue does. */
  pull(notBefore: number | undefined): { payload: Record<string, unknown>; binary: Buffer } {
    if (this.streamId === null) {
      return {
        payload: {
          state: 'stopped',
          frame: null,
          remaining: 0,
          dropped: this.dropped,
          delivered: this.delivered,
          failure: null,
        },
        binary: Buffer.alloc(0),
      };
    }

    let entry = this.next();
    if (notBefore !== undefined) {
      // Discard queued frames older than the moment the host asked, exactly as
      // the helper does; the state of the last discarded entry is what remains.
      let guard = 0;
      while (entry.frame != null && this.capturedAt(entry.frame) < notBefore && guard < 64) {
        this.dropped += 1;
        guard += 1;
        entry = this.next();
      }
      if (entry.frame != null && this.capturedAt(entry.frame) < notBefore) {
        entry = { ...entry, frame: null };
      }
    }

    const state = entry.state ?? 'streaming';
    if (entry.dropped !== undefined) {
      this.dropped = entry.dropped;
    }
    if (entry.frame == null) {
      return {
        payload: {
          state,
          frame: null,
          remaining: entry.remaining ?? 0,
          dropped: this.dropped,
          delivered: this.delivered,
          failure: entry.failure ?? null,
        },
        binary: Buffer.alloc(0),
      };
    }

    const frame = entry.frame;
    this.sequence = frame.sequence ?? this.sequence + 1;
    const byteCount = frame.bytes ?? this.config.captureFrameBytes ?? 2048;
    const binary = deterministicPixels(byteCount, this.sequence);
    this.delivered += 1;
    return {
      payload: {
        state,
        frame: {
          streamId: this.streamId,
          sequence: this.sequence,
          windowNumber: frame.windowNumber ?? this.windowNumber,
          capturedAt: this.capturedAt(frame),
          timestampFallback: frame.timestampFallback ?? false,
          width: frame.width ?? this.width,
          height: frame.height ?? this.height,
          scaleFactor: frame.scaleFactor ?? this.scaleFactor,
          encoding: frame.encoding ?? this.encoding,
          byteLength: frame.declaredByteLength ?? binary.length,
          contentChanged: frame.contentChanged ?? true,
        },
        remaining: entry.remaining ?? 0,
        dropped: this.dropped,
        delivered: this.delivered,
        failure: entry.failure ?? null,
      },
      binary,
    };
  }

  private capturedAt(frame: StubCaptureFrame): number {
    return frame.capturedAt ?? Date.now() - (frame.ageMs ?? 0);
  }

  private next(): StubCapturePull {
    if (this.script.length === 0) {
      return { state: 'streaming', frame: {} };
    }
    const entry = this.script[Math.min(this.index, this.script.length - 1)] ?? {};
    this.index += 1;
    return entry;
  }
}

/** Deterministic stand-in for encoded pixels; never zero-filled. */
function deterministicPixels(length: number, seed: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 31 + seed * 7 + 1) & 0xff;
  }
  return bytes;
}

const DEFAULT_STUB_BINDING: StubHotkeyBinding = {
  keyCode: 61,
  label: 'Right Option',
  isModifierKey: true,
  requiredModifiers: [],
};

/** Live tap state, mutated by `hotkey.start`/`.stop` and by a played script. */
class StubHotkeyTable {
  private readonly config: StubConfig;
  private readonly scripts: StubHotkeyStep[][];
  private startCount = 0;
  private sequence = 0;
  binding: StubHotkeyBinding = DEFAULT_STUB_BINDING;
  tap: StubHotkeyTapState = 'stopped';
  held = false;
  detail = '';
  counters = {
    emitted: 0,
    suppressed: 0,
    disabledByTimeout: 0,
    disabledByUserInput: 0,
    reEnabled: 0,
  };

  constructor(config: StubConfig) {
    this.config = config;
    this.scripts =
      config.hotkeyScripts ?? (config.hotkeyScript === undefined ? [] : [config.hotkeyScript]);
  }

  get accessibilityTrusted(): boolean {
    return this.config.hotkeyAccessibility !== false;
  }

  start(binding: StubHotkeyBinding): void {
    this.binding = binding;
    this.held = false;
    if (!this.accessibilityTrusted) {
      this.tap = 'accessibility-denied';
      this.detail = 'AXIsProcessTrusted() is false; grant Accessibility to Pilot';
      return;
    }
    if (this.config.hotkeyTapFails === true) {
      this.tap = 'creation-failed';
      this.detail = 'CGEventTapCreate returned null although Accessibility is granted';
      return;
    }
    this.tap = 'active';
    this.detail = '';
  }

  stop(): void {
    this.tap = 'stopped';
    this.held = false;
    this.detail = '';
  }

  /** The script for this `hotkey.start`. The last entry repeats. */
  nextScript(): StubHotkeyStep[] {
    if (this.scripts.length === 0) {
      return [];
    }
    const script = this.scripts[Math.min(this.startCount, this.scripts.length - 1)] ?? [];
    this.startCount += 1;
    return script;
  }

  keyPayload(step: { key: 'down' | 'up'; autorepeat?: boolean; keyCode?: number }): unknown {
    this.sequence += 1;
    this.counters.emitted += 1;
    this.held = step.key === 'down';
    return {
      phase: step.key,
      keyCode: step.keyCode ?? this.binding.keyCode,
      at: Date.now(),
      sequence: this.sequence,
      autorepeat: step.autorepeat === true,
    };
  }

  applyTapChange(step: {
    tap: StubHotkeyTapChange;
    state?: StubHotkeyTapState;
    detail?: string;
    held?: boolean;
  }): void {
    if (step.tap === 'disabled-by-timeout') {
      this.counters.disabledByTimeout += 1;
    }
    if (step.tap === 'disabled-by-user-input') {
      this.counters.disabledByUserInput += 1;
    }
    if (step.tap === 're-enabled') {
      this.counters.reEnabled += 1;
    }
    this.tap =
      step.state ??
      (step.tap === 're-enabled' || step.tap === 'started'
        ? 'active'
        : step.tap === 'stopped'
          ? 'stopped'
          : 'disabled');
    if (step.detail !== undefined) {
      this.detail = step.detail;
    }
    if (step.held !== undefined) {
      this.held = step.held;
    }
    if (this.tap !== 'active') {
      // A tap that is off cannot know whether the key is still down.
      this.held = false;
    }
  }

  status(): unknown {
    return {
      binding: this.binding,
      tap: this.tap,
      accessibilityTrusted: this.accessibilityTrusted,
      held: this.held,
      detail: this.detail,
      counters: { ...this.counters },
    };
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

// ---------------------------------------------------------------------------
// PR-013 operation handling
// ---------------------------------------------------------------------------

/** The role and subrole macOS uses for a password field. */
const SECURE_TEXT_FIELD = 'AXSecureTextField';

/** Successive pointer positions, advanced by each `accessibility.sample`. */
class StubPointerScript {
  private index = 0;
  private readonly points: Array<{ x: number; y: number }>;

  constructor(points: Array<{ x: number; y: number }>) {
    this.points = points;
  }

  next(): { x: number; y: number } {
    const point = this.points[Math.min(this.index, this.points.length - 1)] ?? { x: 0, y: 0 };
    this.index += 1;
    return point;
  }
}

function containsPoint(rect: StubRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/**
 * Classifies a secure field the way `SecureFieldClassifier` does in Swift.
 * Written out again rather than shared, for the same reason the wire format is:
 * a stub that agrees with the code under test by construction proves nothing.
 */
function secureBasisOf(element: StubAxElement): StubSecureBasis {
  if (element.role === SECURE_TEXT_FIELD) {
    return 'role';
  }
  if (element.subrole === SECURE_TEXT_FIELD) {
    return 'subrole';
  }
  return 'none';
}

interface StubHitTest {
  element: unknown;
  outcome: StubElementOutcome;
}

function hitTest(
  config: StubConfig,
  x: number,
  y: number,
  ownerPid: number | null,
  includeValue: boolean,
): StubHitTest {
  if (config.axTrusted === false) {
    return { element: null, outcome: 'not-trusted' };
  }
  if (config.axQueryFails === true) {
    return { element: null, outcome: 'query-failed' };
  }
  const candidates = (config.axElements ?? []).filter((element) => {
    if (!containsPoint(element.bounds, x, y)) {
      return false;
    }
    // `AXUIElementCreateApplication(pid)` cannot answer with another
    // application's element, so neither can the stub.
    return ownerPid === null || (element.ownerPid ?? null) === ownerPid;
  });
  const found = candidates[candidates.length - 1];
  if (found === undefined) {
    return { element: null, outcome: 'no-element' };
  }
  const basis = secureBasisOf(found);
  const isSecure = basis !== 'none';
  return {
    outcome: 'reported',
    element: {
      role: found.role ?? null,
      subrole: found.subrole ?? null,
      label: found.label ?? null,
      // A secure element's value is never read, whatever the caller asked for.
      value: includeValue && !isSecure ? (found.value ?? null) : null,
      bounds: found.bounds,
      isSecure,
      secureBasis: basis,
      secureAncestorDepth: null,
      ownerPid: found.ownerPid ?? null,
    },
  };
}

function main(): void {
  const config = readConfig();
  const exitCode = config.exitCode ?? 9;
  const startedAt = Date.now();
  const helperVersion = config.helperVersion ?? '0.0.0-stub';
  const echoBinary = config.echoBinary ?? true;
  const permissions = new StubPermissionTable(config);
  const hotkey = new StubHotkeyTable(config);
  let eventCounter = 0;
  const desktops = new StubDesktopScript(
    config.desktopScript ?? (config.desktop === undefined ? [{}] : [config.desktop]),
  );
  const pointers = new StubPointerScript(
    config.pointerScript ?? [config.pointer ?? { x: 0, y: 0 }],
  );
  const speechInput = new StubSpeechInput(config.speechInput ?? {});
  const speechOutput = new StubSpeechOutput(config.speechOutput ?? {});
  const capture = new StubCaptureStream(config);
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

  /** Writes one unsolicited event frame, exactly as the Swift helper does. */
  const emit = (op: string, payload: unknown): void => {
    eventCounter += 1;
    write(
      encodeFrame(
        JSON.stringify({
          kind: 'event',
          protocolVersion: PROTOCOL_VERSION,
          id: `evt-${String(eventCounter)}`,
          op,
          issuedAt: Date.now(),
          payload,
        }),
      ),
    );
  };

  /**
   * Plays a hotkey script one step at a time, on the immediate queue.
   *
   * Deferred rather than written inline with the response so the host's
   * `hotkey.start` promise settles before the first key arrives — which is the
   * order a real tap produces, and the order that makes tests read the way the
   * feature behaves.
   */
  const playHotkeyScript = (steps: StubHotkeyStep[]): void => {
    if (steps.length === 0) {
      return;
    }
    setImmediate(() => {
      for (const step of steps) {
        if ('key' in step) {
          emit('hotkey.key', hotkey.keyPayload(step));
        } else {
          hotkey.applyTapChange(step);
          emit('hotkey.tap', { change: step.tap, status: hotkey.status() });
        }
      }
    });
  };

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
    let pendingHotkeyScript: StubHotkeyStep[] = [];

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
    } else if (request.op === 'accessibility.sample') {
      const point = pointers.next();
      const includeElement = payloadOf?.includeElement === true;
      const ownerPid = typeof payloadOf?.ownerPid === 'number' ? payloadOf.ownerPid : null;
      const hit = includeElement
        ? hitTest(config, point.x, point.y, ownerPid, payloadOf?.includeValue === true)
        : { element: null, outcome: 'not-requested' as StubElementOutcome };
      body = ok({
        point,
        pointerSource: config.pointerSource ?? 'cg-event',
        sampledAt: Date.now(),
        axTrusted: config.axTrusted !== false,
        element: hit.element,
        outcome: hit.outcome,
      });
    } else if (request.op === 'accessibility.element-at') {
      const point = payloadOf?.point as { x?: unknown; y?: unknown } | undefined;
      if (typeof point?.x !== 'number' || typeof point.y !== 'number') {
        body = fail('accessibility.element-at requires a point');
      } else {
        const ownerPid = typeof payloadOf?.ownerPid === 'number' ? payloadOf.ownerPid : null;
        const hit = hitTest(config, point.x, point.y, ownerPid, payloadOf?.includeValue === true);
        body = ok({
          axTrusted: config.axTrusted !== false,
          element: hit.element,
          outcome: hit.outcome,
        });
      }
    } else if (request.op === 'speech.input.availability') {
      body = ok({
        facts: speechInput.facts(),
        microphone: permissions.probe('microphone').state,
        speechRecognition: permissions.probe('speech-recognition').state,
      });
    } else if (request.op === 'speech.input.start') {
      const utteranceId = payloadOf?.utteranceId;
      const onDevice = payloadOf?.onDevice;
      if (typeof utteranceId !== 'string' || typeof onDevice !== 'boolean') {
        body = fail('speech.input.start requires utteranceId and onDevice');
      } else if (speechInput.startFailure !== undefined) {
        const failure = speechInput.startFailure;
        body = envelope({
          ok: false,
          error: serializedError(
            failure.code,
            failure.code === 'permission-denied' ? 'permission' : 'speech',
            speechFailureMessage(failure, 'scripted start failure'),
          ),
        });
      } else {
        speechInput.start(utteranceId);
        const locale = payloadOf?.locale;
        body = ok({
          started: true,
          onDevice,
          locale: typeof locale === 'string' ? locale : (speechInput.facts().locale ?? null),
        });
      }
    } else if (request.op === 'speech.input.stop') {
      const utteranceId = payloadOf?.utteranceId;
      body =
        typeof utteranceId === 'string'
          ? ok({ accepted: speechInput.stop(utteranceId) })
          : fail('speech.input.stop requires an utteranceId');
    } else if (request.op === 'speech.input.cancel') {
      const utteranceId = payloadOf?.utteranceId;
      body =
        typeof utteranceId === 'string'
          ? ok({ accepted: speechInput.cancel(utteranceId) })
          : fail('speech.input.cancel requires an utteranceId');
    } else if (request.op === 'speech.input.poll') {
      const since = payloadOf?.sinceSequence;
      body =
        typeof since === 'number'
          ? ok(speechInput.poll(since))
          : fail('speech.input.poll requires a sinceSequence');
    } else if (request.op === 'speech.output.availability') {
      body = ok(speechOutput.availability());
    } else if (request.op === 'speech.output.speak') {
      const speechId = payloadOf?.speechId;
      const text = payloadOf?.text;
      if (typeof speechId !== 'string' || typeof text !== 'string' || text.length === 0) {
        body = fail('speech.output.speak requires speechId and text');
      } else if (speechOutput.speakFailure !== undefined) {
        const failure = speechOutput.speakFailure;
        body = envelope({
          ok: false,
          error: serializedError(
            failure.code,
            'speech',
            speechFailureMessage(failure, 'scripted speak failure'),
          ),
        });
      } else {
        body = ok({ accepted: true, queued: speechOutput.speak(speechId) });
      }
    } else if (request.op === 'speech.output.stop') {
      const speechId = payloadOf?.speechId;
      body = ok({
        stopped: speechOutput.stop(typeof speechId === 'string' ? speechId : null),
      });
    } else if (request.op === 'speech.output.poll') {
      const since = payloadOf?.sinceSequence;
      body =
        typeof since === 'number'
          ? ok(speechOutput.poll(since))
          : fail('speech.output.poll requires a sinceSequence');
    } else if (request.op === 'capture.start') {
      if (config.captureStartFails !== undefined) {
        body = fail(config.captureStartFails);
      } else if (typeof payloadOf?.windowNumber !== 'number') {
        body = fail('capture.start requires a windowNumber');
      } else {
        body = ok({ session: capture.start(payloadOf) });
      }
    } else if (request.op === 'capture.stop') {
      body = ok(capture.stop());
    } else if (request.op === 'capture.pull') {
      const notBefore = payloadOf?.notBefore;
      const result = capture.pull(typeof notBefore === 'number' ? notBefore : undefined);
      attachment = result.binary;
      body = ok(result.payload);
    } else if (request.op === 'hotkey.start') {
      const binding = payloadOf?.binding as Partial<StubHotkeyBinding> | undefined;
      if (
        typeof binding?.keyCode !== 'number' ||
        typeof binding.label !== 'string' ||
        typeof binding.isModifierKey !== 'boolean'
      ) {
        body = fail('hotkey.start requires a well-formed binding');
      } else {
        hotkey.start({
          keyCode: binding.keyCode,
          label: binding.label,
          isModifierKey: binding.isModifierKey,
          requiredModifiers: binding.requiredModifiers ?? [],
        });
        body = ok({ status: hotkey.status() });
        pendingHotkeyScript = hotkey.nextScript();
      }
    } else if (request.op === 'hotkey.stop') {
      hotkey.stop();
      body = ok({ status: hotkey.status() });
    } else if (request.op === 'hotkey.status') {
      body = ok({ status: hotkey.status() });
    } else {
      body = fail(`unknown operation "${request.op}"`);
    }

    write(encodeFrame(body, attachment));
    if (config.duplicateResponse === true) {
      write(encodeFrame(body, attachment));
    }
    playHotkeyScript(pendingHotkeyScript);

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
        const delayMs =
          request.op === 'capture.pull' && config.capturePullDelayMs !== undefined
            ? config.capturePullDelayMs
            : (config.responseDelayMs ?? 0);
        if (delayMs > 0) {
          setTimeout(() => {
            respond(request, frame.binary);
          }, delayMs);
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
