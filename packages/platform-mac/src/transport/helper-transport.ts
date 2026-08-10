import {
  PilotError,
  cancelledError,
  createIdFactory,
  deserializePilotError,
  nullLogger,
  toPilotError,
  type IdFactory,
  type Logger,
  type RequestId,
} from '@pilot/shared';
import type { Unsubscribe } from '@pilot/platform';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { HelperChannel } from './channel.js';
import {
  createHelperRequestMessage,
  type HelperEventMessage,
  type HelperMessage,
} from '../protocol/messages.js';
import {
  HELPER_OPERATIONS,
  healthOperation,
  type HelperOperation,
} from '../protocol/operations.js';
import { TypedEmitter } from './emitter.js';

/**
 * Supervises the embedded native helper.
 *
 * The helper is started by Pilot and is not a user-managed service
 * (system-design §4), so everything about its lifetime is this class's
 * problem: spawning it, proving it answers, restarting it with backoff when it
 * dies, and making sure every in-flight request fails with a typed error
 * instead of hanging forever.
 *
 * Failure modes and the error each produces:
 *
 * | Failure                             | Code                                   |
 * | ----------------------------------- | -------------------------------------- |
 * | binary missing / spawn failed       | `helper-unavailable`                   |
 * | helper exits with work in flight    | `helper-unavailable`                   |
 * | helper never answers a request      | `timeout`                              |
 * | helper never answers the probe      | `helper-unavailable`                   |
 * | restart budget exhausted            | `helper-unavailable` (terminal)        |
 * | malformed header / oversized frame  | `invalid-request`, `payload-too-large` |
 * | response for an unknown id          | `invalid-request` (emitted)            |
 * | response for the wrong operation    | `invalid-request` (rejects)            |
 * | caller aborts                       | `cancelled`                            |
 *
 * Logging note: frame bodies are never logged. Only operation names, request
 * ids, state and byte counts reach the logger, which additionally redacts
 * anything binary-shaped (`@pilot/shared` logging).
 */

export type HelperTransportState = 'stopped' | 'starting' | 'ready' | 'restarting' | 'failed';

export type HelperCrashReason = 'exit' | 'spawn-error' | 'handshake-failed' | 'protocol-error';

export interface HelperCrashReport {
  readonly at: number;
  readonly reason: HelperCrashReason;
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Uptime of the process that just died, in milliseconds. */
  readonly uptimeMs: number;
  /** Restarts counted inside the current restart window, including this one. */
  readonly restartsInWindow: number;
  readonly willRestart: boolean;
  readonly restartDelayMs: number | undefined;
  /** Requests that were in flight and have just been rejected. */
  readonly abandonedRequests: number;
  /** Last stderr lines from the helper, truncated. Never frame content. */
  readonly stderrTail: readonly string[];
  /** The typed error every in-flight request was rejected with. */
  readonly error: PilotError;
}

export interface HelperRestartPolicy {
  readonly enabled: boolean;
  readonly initialDelayMs: number;
  readonly factor: number;
  readonly maxDelayMs: number;
  /** Restarts allowed inside `windowMs` before the transport gives up. */
  readonly maxRestarts: number;
  readonly windowMs: number;
}

export const DEFAULT_RESTART_POLICY: HelperRestartPolicy = {
  enabled: true,
  initialDelayMs: 250,
  factor: 2,
  maxDelayMs: 5_000,
  maxRestarts: 5,
  windowMs: 60_000,
};

export interface HelperTransportOptions {
  /** Absolute path to the helper executable. */
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
  readonly idFactory?: IdFactory;
  readonly clock?: () => number;
  /** Default per-request deadline. */
  readonly requestTimeoutMs?: number;
  /** Deadline for the startup `health` probe. */
  readonly handshakeTimeoutMs?: number;
  /** How long a request waits for a starting or restarting helper. */
  readonly readyTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL on `stop()`. */
  readonly shutdownGraceMs?: number;
  readonly restart?: Partial<HelperRestartPolicy>;
  /** Stderr lines retained for crash reports. */
  readonly stderrTailLines?: number;
}

export interface HelperRequestOptions {
  readonly binary?: Uint8Array;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface HelperResponse<Payload> {
  readonly payload: Payload;
  /** Binary body of the response frame; empty when the operation sent none. */
  readonly binary: Buffer;
}

export interface HelperTransportEvents extends Record<string, unknown> {
  state: HelperTransportState;
  crash: HelperCrashReport;
  event: HelperEventMessage;
  /** A protocol violation that belongs to no single request. */
  'protocol-error': PilotError;
}

type SettleResult =
  | { readonly ok: true; readonly value: HelperResponse<unknown> }
  | { readonly ok: false; readonly error: PilotError };

interface PendingRequest {
  readonly id: RequestId;
  readonly op: string;
  readonly startedAt: number;
  readonly timer: NodeJS.Timeout | undefined;
  readonly settle: (result: SettleResult) => void;
}

interface FailureCause {
  readonly reason: HelperCrashReason;
  readonly error: PilotError;
}

const STDERR_LINE_MAX_LENGTH = 500;
const EMPTY_BUFFER = Buffer.alloc(0);

function unavailable(
  message: string,
  details: Record<string, unknown>,
  cause?: unknown,
): PilotError {
  return new PilotError('helper-unavailable', message, {
    userMessage: 'Pilot cannot reach its macOS helper.',
    retryable: true,
    details,
    ...(cause === undefined ? {} : { cause }),
  });
}

interface ResolvedOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly logger: Logger;
  readonly idFactory: IdFactory;
  readonly clock: () => number;
  readonly requestTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly readyTimeoutMs: number;
  readonly shutdownGraceMs: number;
  readonly stderrTailLines: number;
  readonly restart: HelperRestartPolicy;
}

export class NativeHelperTransport {
  readonly #options: ResolvedOptions;
  readonly #emitter: TypedEmitter<HelperTransportEvents>;
  readonly #registry = new Map<string, HelperOperation<unknown, unknown>>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #restartTimestamps: number[] = [];
  readonly #stderrTail: string[] = [];
  readonly #readyWaiters = new Set<{
    readonly resolve: () => void;
    readonly reject: (error: PilotError) => void;
    readonly timer: NodeJS.Timeout;
  }>();

  #state: HelperTransportState = 'stopped';
  #child: ChildProcessWithoutNullStreams | undefined;
  #channel: HelperChannel | undefined;
  #childStartedAt = 0;
  #stderrPartial = '';
  #stopping = false;
  #stopResolvers: Array<() => void> = [];
  #restartTimer: NodeJS.Timeout | undefined;
  #failureCause: FailureCause | undefined;
  #launchPromise: Promise<void> | undefined;
  #lastError: PilotError | undefined;

  constructor(options: HelperTransportOptions) {
    const logger = (options.logger ?? nullLogger).child('helper-transport', {
      command: options.command,
    });
    this.#options = {
      command: options.command,
      args: options.args ?? [],
      cwd: options.cwd,
      env: options.env,
      logger,
      idFactory: options.idFactory ?? createIdFactory(),
      clock: options.clock ?? (() => Date.now()),
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 5_000,
      readyTimeoutMs: options.readyTimeoutMs ?? 10_000,
      shutdownGraceMs: options.shutdownGraceMs ?? 1_000,
      stderrTailLines: options.stderrTailLines ?? 20,
      restart: { ...DEFAULT_RESTART_POLICY, ...(options.restart ?? {}) },
    };
    this.#emitter = new TypedEmitter<HelperTransportEvents>((error, event) => {
      this.#options.logger.warn('helper transport listener threw', {
        event: String(event),
        reason: toPilotError(error).message,
      });
    });
    for (const operation of Object.values(HELPER_OPERATIONS) as readonly HelperOperation<
      unknown,
      unknown
    >[]) {
      this.register(operation);
    }
  }

  get state(): HelperTransportState {
    return this.#state;
  }

  /** Process id of the running helper, when there is one. */
  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** Requests currently awaiting a response. */
  get pendingRequestCount(): number {
    return this.#pending.size;
  }

  /** The failure that put the transport into `failed`, if any. */
  get lastError(): PilotError | undefined {
    return this.#lastError;
  }

  /**
   * Registers an operation so its responses are schema-validated. PR-011
   * onward extends `HELPER_OPERATIONS`; anything registered here is accepted.
   */
  register<Request, Response>(operation: HelperOperation<Request, Response>): void {
    this.#registry.set(operation.name, operation as unknown as HelperOperation<unknown, unknown>);
  }

  on<E extends keyof HelperTransportEvents>(
    event: E,
    listener: (payload: HelperTransportEvents[E]) => void,
  ): Unsubscribe {
    return this.#emitter.on(event, listener);
  }

  /**
   * Spawns the helper and waits for it to answer a `health` probe. Resolves
   * only when the helper is ready; rejects with `helper-unavailable` when the
   * restart budget is exhausted before that happens.
   */
  async start(): Promise<void> {
    if (this.#state === 'ready') {
      return;
    }
    if (this.#state === 'starting' || this.#state === 'restarting') {
      await this.#waitForReady();
      return;
    }

    this.#stopping = false;
    this.#lastError = undefined;
    this.#restartTimestamps.length = 0;
    this.#setState('starting');
    // Registered before the launch so a failure during the very first attempt
    // still has a waiter to reject; the no-op catch keeps Node from seeing it
    // as unhandled between here and the `await` below.
    const ready = this.#waitForReady();
    ready.catch(() => undefined);
    await this.#launch();
    await ready;
  }

  /**
   * Sends one request and awaits its correlated response.
   *
   * Never settles silently: an unknown id, an operation mismatch, a schema
   * violation, a crash, an abort and a deadline all reject with a typed error.
   */
  async request<Request, Response>(
    operation: HelperOperation<Request, Response>,
    payload: Request,
    options: HelperRequestOptions = {},
  ): Promise<HelperResponse<Response>> {
    if (options.binary !== undefined && !operation.requestBinary) {
      throw new PilotError(
        'invalid-request',
        `Operation "${operation.name}" does not accept a binary payload`,
        {
          userMessage: 'Pilot could not talk to its macOS helper.',
          retryable: false,
          details: { op: operation.name },
        },
      );
    }

    await this.#waitForReady();
    return this.#dispatch(operation, payload, options, this.#options.requestTimeoutMs);
  }

  /** Terminates the helper and rejects everything still in flight with `cancelled`. */
  async stop(): Promise<void> {
    if (this.#restartTimer !== undefined) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    this.#stopping = true;

    const child = this.#child;
    if (child === undefined) {
      this.#rejectPending(cancelledError('Helper request'));
      this.#rejectReadyWaiters(unavailable('Helper transport is stopped', {}));
      this.#setState('stopped');
      return;
    }

    const done = new Promise<void>((resolve) => {
      this.#stopResolvers.push(resolve);
    });

    this.#rejectPending(cancelledError('Helper request'));
    this.#rejectReadyWaiters(unavailable('Helper transport is stopping', {}));

    try {
      child.stdin.end();
    } catch {
      // The pipe may already be gone; the signal below is what matters.
    }
    child.kill('SIGTERM');

    const graceTimer = setTimeout(() => {
      if (this.#child === child) {
        this.#options.logger.warn('helper ignored SIGTERM; sending SIGKILL', { pid: child.pid });
        child.kill('SIGKILL');
      }
    }, this.#options.shutdownGraceMs);
    graceTimer.unref();

    await done;
    clearTimeout(graceTimer);
  }

  // -------------------------------------------------------------------------
  // Launch and supervision
  // -------------------------------------------------------------------------

  #launch(): Promise<void> {
    const existing = this.#launchPromise;
    if (existing !== undefined) {
      return existing;
    }
    const promise = this.#launchOnce().finally(() => {
      this.#launchPromise = undefined;
    });
    this.#launchPromise = promise;
    return promise;
  }

  async #launchOnce(): Promise<void> {
    this.#failureCause = undefined;
    this.#stderrPartial = '';
    this.#childStartedAt = this.#options.clock();

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#options.command, [...this.#options.args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
        ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
      });
    } catch (error) {
      this.#report(
        'spawn-error',
        unavailable('Could not spawn the macOS helper', { command: this.#options.command }, error),
        { exitCode: null, signal: null, pid: undefined },
      );
      return;
    }

    this.#child = child;
    this.#options.logger.info('helper started', { pid: child.pid });

    // Permanent guards. `HelperChannel` reports stream failures while it is
    // attached; these keep a late EPIPE after the channel closes from becoming
    // an unhandled `error` event.
    child.stdin.on('error', () => undefined);
    child.stdout.on('error', () => undefined);

    child.once('error', (error: Error) => {
      if (this.#child !== child) {
        return;
      }
      this.#child = undefined;
      this.#closeChannel();
      this.#report(
        'spawn-error',
        unavailable('Could not spawn the macOS helper', { command: this.#options.command }, error),
        { exitCode: null, signal: null, pid: child.pid },
      );
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.#collectStderr(chunk);
    });

    child.once('exit', (code, signal) => {
      if (this.#child !== child) {
        return;
      }
      this.#child = undefined;
      this.#closeChannel();
      this.#onChildExit(code, signal, child.pid);
    });

    this.#channel = new HelperChannel({
      readable: child.stdout,
      writable: child.stdin,
      handlers: {
        onMessage: (message, binary) => {
          this.#onMessage(message, binary);
        },
        onFailure: (error) => {
          this.#onProtocolFailure(error, child);
        },
      },
    });

    try {
      await this.#dispatch(healthOperation, {}, {}, this.#options.handshakeTimeoutMs);
    } catch (error) {
      if (this.#child !== child) {
        // The exit or spawn-error path already reported this death.
        return;
      }
      this.#options.logger.warn('helper handshake failed', {
        pid: child.pid,
        reason: toPilotError(error).code,
      });
      this.#failureCause = {
        reason: 'handshake-failed',
        error: unavailable(
          'macOS helper did not answer the startup health probe',
          { command: this.#options.command, timeoutMs: this.#options.handshakeTimeoutMs },
          error,
        ),
      };
      child.kill('SIGKILL');
      return;
    }

    if (this.#child !== child || this.#stopping) {
      return;
    }
    this.#setState('ready');
    this.#resolveReadyWaiters();
  }

  #onChildExit(code: number | null, signal: NodeJS.Signals | null, pid: number | undefined): void {
    if (this.#stopping) {
      this.#rejectPending(cancelledError('Helper request'));
      this.#setState('stopped');
      const resolvers = this.#stopResolvers;
      this.#stopResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
      this.#options.logger.info('helper stopped', { pid, exitCode: code, signal });
      return;
    }

    const cause = this.#failureCause;
    this.#failureCause = undefined;
    const error =
      cause?.error ?? unavailable('macOS helper exited unexpectedly', { exitCode: code, signal });
    this.#report(cause?.reason ?? 'exit', error, { exitCode: code, signal, pid });
  }

  #onProtocolFailure(error: PilotError, child: ChildProcessWithoutNullStreams): void {
    this.#options.logger.error('helper protocol failure', {
      pid: child.pid,
      code: error.code,
      reason: error.message,
    });
    this.#emitter.emit('protocol-error', error);
    // The byte stream is no longer frame-aligned. Kill the helper; the exit
    // path decides whether to restart it.
    if (this.#child === child) {
      this.#failureCause = { reason: 'protocol-error', error };
      child.kill('SIGKILL');
    }
  }

  /** Crash accounting: reject work, emit a report, schedule a restart or give up. */
  #report(
    reason: HelperCrashReason,
    error: PilotError,
    exit: {
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly pid: number | undefined;
    },
  ): void {
    const at = this.#options.clock();
    const abandoned = this.#pending.size;
    this.#rejectPending(error);

    const policy = this.#options.restart;
    this.#restartTimestamps.push(at);
    this.#pruneRestartWindow(at);
    const restartsInWindow = this.#restartTimestamps.length;
    const willRestart = policy.enabled && restartsInWindow <= policy.maxRestarts;
    const restartDelayMs = willRestart ? this.#backoffDelay(restartsInWindow) : undefined;

    const report: HelperCrashReport = {
      at,
      reason,
      pid: exit.pid,
      exitCode: exit.exitCode,
      signal: exit.signal,
      uptimeMs: Math.max(0, at - this.#childStartedAt),
      restartsInWindow,
      willRestart,
      restartDelayMs,
      abandonedRequests: abandoned,
      stderrTail: [...this.#stderrTail],
      error,
    };

    this.#options.logger.error('helper crashed', {
      reason,
      pid: exit.pid,
      exitCode: exit.exitCode,
      signal: exit.signal,
      uptimeMs: report.uptimeMs,
      restartsInWindow,
      willRestart,
      restartDelayMs,
      abandonedRequests: abandoned,
    });
    this.#emitter.emit('crash', report);

    if (!willRestart) {
      this.#lastError = unavailable(
        'macOS helper is unavailable',
        {
          reason,
          restartsInWindow,
          maxRestarts: policy.maxRestarts,
          windowMs: policy.windowMs,
        },
        error,
      );
      this.#setState('failed');
      this.#rejectReadyWaiters(this.#lastError);
      return;
    }

    this.#setState('restarting');
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      if (this.#stopping) {
        return;
      }
      void this.#launch();
    }, restartDelayMs ?? 0);
  }

  #backoffDelay(attempt: number): number {
    const policy = this.#options.restart;
    const exponent = Math.max(0, attempt - 1);
    return Math.min(
      policy.maxDelayMs,
      Math.round(policy.initialDelayMs * policy.factor ** exponent),
    );
  }

  #pruneRestartWindow(now: number): void {
    const cutoff = now - this.#options.restart.windowMs;
    while (this.#restartTimestamps.length > 0 && (this.#restartTimestamps[0] ?? 0) < cutoff) {
      this.#restartTimestamps.shift();
    }
  }

  #collectStderr(chunk: string): void {
    const text = this.#stderrPartial + chunk;
    const lines = text.split('\n');
    this.#stderrPartial = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') {
        continue;
      }
      this.#stderrTail.push(line.slice(0, STDERR_LINE_MAX_LENGTH));
      while (this.#stderrTail.length > this.#options.stderrTailLines) {
        this.#stderrTail.shift();
      }
    }
  }

  #closeChannel(): void {
    this.#channel?.close();
    this.#channel = undefined;
  }

  // -------------------------------------------------------------------------
  // Request correlation
  // -------------------------------------------------------------------------

  #dispatch<Request, Response>(
    operation: HelperOperation<Request, Response>,
    payload: Request,
    options: HelperRequestOptions,
    timeoutMs: number,
  ): Promise<HelperResponse<Response>> {
    const channel = this.#channel;
    if (channel === undefined || channel.closed) {
      return Promise.reject(unavailable('macOS helper is not running', { op: operation.name }));
    }

    const parsed = operation.request.safeParse(payload);
    if (!parsed.success) {
      return Promise.reject(
        new PilotError('invalid-request', `Invalid request payload for "${operation.name}"`, {
          userMessage: 'Pilot could not talk to its macOS helper.',
          retryable: false,
          details: {
            op: operation.name,
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              code: issue.code,
            })),
          },
        }),
      );
    }

    const id = this.#options.idFactory.request();
    const message = createHelperRequestMessage(operation.name, parsed.data, {
      id,
      issuedAt: this.#options.clock(),
    });
    const effectiveTimeout = options.timeoutMs ?? timeoutMs;

    return new Promise<HelperResponse<Response>>((resolve, reject) => {
      let removeAbort: (() => void) | undefined;

      const finish = (result: SettleResult): void => {
        const entry = this.#pending.get(id);
        if (entry === undefined) {
          return;
        }
        this.#pending.delete(id);
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer);
        }
        removeAbort?.();
        if (result.ok) {
          resolve(result.value as HelperResponse<Response>);
        } else {
          reject(result.error);
        }
      };

      let timer: NodeJS.Timeout | undefined;
      if (effectiveTimeout > 0) {
        timer = setTimeout(() => {
          this.#options.logger.warn('helper request timed out', {
            op: operation.name,
            requestId: id,
            timeoutMs: effectiveTimeout,
          });
          finish({
            ok: false,
            error: new PilotError(
              'timeout',
              `macOS helper did not answer "${operation.name}" in time`,
              {
                userMessage: 'Pilot’s macOS helper stopped responding.',
                retryable: true,
                details: { op: operation.name, timeoutMs: effectiveTimeout, requestId: id },
              },
            ),
          });
        }, effectiveTimeout);
        timer.unref();
      }

      this.#pending.set(id, {
        id,
        op: operation.name,
        startedAt: this.#options.clock(),
        timer,
        settle: finish,
      });

      const signal = options.signal;
      if (signal !== undefined) {
        if (signal.aborted) {
          finish({ ok: false, error: cancelledError(`Helper request "${operation.name}"`) });
          return;
        }
        const onAbort = (): void => {
          finish({ ok: false, error: cancelledError(`Helper request "${operation.name}"`) });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbort = () => {
          signal.removeEventListener('abort', onAbort);
        };
      }

      try {
        channel.send(message, options.binary);
      } catch (error) {
        finish({ ok: false, error: toPilotError(error, 'helper-unavailable') });
      }
    });
  }

  #onMessage(message: HelperMessage, binary: Buffer): void {
    if (message.kind === 'event') {
      this.#emitter.emit('event', message);
      return;
    }

    if (message.kind === 'request') {
      this.#emitProtocolError(
        new PilotError('invalid-request', 'macOS helper sent an unsolicited request', {
          userMessage: 'Pilot could not talk to its macOS helper.',
          retryable: false,
          details: { op: message.op, requestId: message.id },
        }),
      );
      return;
    }

    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      // Never a silent drop: a response nobody is waiting for means the helper
      // is confused, or the request already timed out.
      this.#emitProtocolError(
        new PilotError('invalid-request', 'macOS helper answered an unknown request id', {
          userMessage: 'Pilot could not talk to its macOS helper.',
          retryable: false,
          details: { op: message.op, requestId: message.id },
        }),
      );
      return;
    }

    if (pending.op !== message.op) {
      pending.settle({
        ok: false,
        error: new PilotError('invalid-request', 'macOS helper answered the wrong operation', {
          userMessage: 'Pilot could not talk to its macOS helper.',
          retryable: false,
          details: { expected: pending.op, received: message.op, requestId: message.id },
        }),
      });
      return;
    }

    if (!message.ok) {
      let error: PilotError;
      try {
        error = deserializePilotError(message.error);
      } catch (cause) {
        error = new PilotError('invalid-request', 'macOS helper sent an unreadable error', {
          userMessage: 'Pilot could not talk to its macOS helper.',
          retryable: false,
          details: { op: message.op, requestId: message.id },
          cause,
        });
      }
      pending.settle({ ok: false, error });
      return;
    }

    const operation = this.#registry.get(pending.op);
    if (operation === undefined) {
      pending.settle({
        ok: false,
        error: new PilotError('invalid-request', 'Response for an unregistered operation', {
          userMessage: 'Pilot could not talk to its macOS helper.',
          retryable: false,
          details: { op: pending.op, requestId: message.id },
        }),
      });
      return;
    }

    if (binary.length > 0 && !operation.responseBinary) {
      pending.settle({
        ok: false,
        error: new PilotError(
          'invalid-request',
          `Operation "${pending.op}" must not return a binary payload`,
          {
            userMessage: 'Pilot could not talk to its macOS helper.',
            retryable: false,
            details: { op: pending.op, requestId: message.id, binaryLength: binary.length },
          },
        ),
      });
      return;
    }

    const parsed = operation.response.safeParse(message.payload);
    if (!parsed.success) {
      pending.settle({
        ok: false,
        error: new PilotError('invalid-request', `Invalid response payload for "${pending.op}"`, {
          userMessage: 'Pilot could not talk to its macOS helper.',
          retryable: false,
          details: {
            op: pending.op,
            requestId: message.id,
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              code: issue.code,
            })),
          },
        }),
      });
      return;
    }

    pending.settle({
      ok: true,
      value: { payload: parsed.data, binary: binary.length === 0 ? EMPTY_BUFFER : binary },
    });
  }

  #emitProtocolError(error: PilotError): void {
    this.#options.logger.warn('helper protocol error', {
      code: error.code,
      reason: error.message,
    });
    this.#emitter.emit('protocol-error', error);
  }

  #rejectPending(error: PilotError): void {
    if (this.#pending.size === 0) {
      return;
    }
    for (const entry of [...this.#pending.values()]) {
      entry.settle({ ok: false, error });
    }
    this.#pending.clear();
  }

  // -------------------------------------------------------------------------
  // Readiness
  // -------------------------------------------------------------------------

  #waitForReady(): Promise<void> {
    if (this.#state === 'ready') {
      return Promise.resolve();
    }
    if (this.#state === 'failed') {
      return Promise.reject(this.#lastError ?? unavailable('macOS helper is unavailable', {}));
    }
    if (this.#state === 'stopped') {
      return Promise.reject(unavailable('macOS helper is not running', {}));
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#readyWaiters.delete(waiter);
        reject(
          unavailable('macOS helper did not become ready in time', {
            timeoutMs: this.#options.readyTimeoutMs,
            state: this.#state,
          }),
        );
      }, this.#options.readyTimeoutMs);
      timer.unref();
      const waiter = { resolve, reject, timer };
      this.#readyWaiters.add(waiter);
    });
  }

  #resolveReadyWaiters(): void {
    for (const waiter of [...this.#readyWaiters]) {
      this.#readyWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  #rejectReadyWaiters(error: PilotError): void {
    for (const waiter of [...this.#readyWaiters]) {
      this.#readyWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #setState(next: HelperTransportState): void {
    if (this.#state === next) {
      return;
    }
    this.#state = next;
    this.#options.logger.debug('helper transport state', { state: next });
    this.#emitter.emit('state', next);
  }
}
