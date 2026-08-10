import { createHash } from 'node:crypto';
import { isPilotError, type PilotError } from '@pilot/shared';
import {
  HELPER_READY_EVENT,
  defineHelperOperation,
  echoOperation,
  healthOperation,
  helperReadyEventSchema,
  type HelperCrashReport,
  type HelperTransportState,
  type NativeHelperTransport,
} from '@pilot/platform-mac';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createStubTransport, deterministicBytes, once } from './support/harness.js';

/**
 * Host-side transport tests.
 *
 * Every case runs against `test/support/helper-stub.ts`, an independent Node
 * implementation of the same framed protocol. The Swift helper cannot be built
 * on Linux (runbook §2), so this stub is the deterministic harness that keeps
 * the TypeScript side fully covered here.
 */

const started: NativeHelperTransport[] = [];

function track(transport: NativeHelperTransport): NativeHelperTransport {
  started.push(transport);
  return transport;
}

afterEach(async () => {
  while (started.length > 0) {
    const transport = started.pop();
    await transport?.stop();
  }
});

async function rejects(promise: Promise<unknown>): Promise<PilotError> {
  try {
    await promise;
  } catch (error) {
    if (isPilotError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the promise to reject with a PilotError');
}

describe('startup and health', () => {
  it('starts the helper and answers a health probe', async () => {
    const transport = track(createStubTransport({ helperVersion: '1.2.3-stub' }));
    await transport.start();

    expect(transport.state).toBe('ready');
    expect(transport.pid).toBeGreaterThan(0);

    const result = await transport.request(healthOperation, {});
    expect(result.payload.status).toBe('ok');
    expect(result.payload.helperVersion).toBe('1.2.3-stub');
    expect(result.payload.protocolVersion).toBe(1);
    expect(result.binary).toHaveLength(0);
  });

  it('surfaces a helper.ready event', async () => {
    const transport = track(createStubTransport({ emitReadyEvent: true }));
    const ready = once<{ op: string; payload: unknown }>((listener) =>
      transport.on('event', listener),
    );
    await transport.start();

    const event = await ready;
    expect(event.op).toBe(HELPER_READY_EVENT);
    expect(helperReadyEventSchema.safeParse(event.payload).success).toBe(true);
  });

  it('reports a missing helper binary as helper-unavailable', async () => {
    const transport = track(
      createStubTransport({}, { command: '/nonexistent/pilot-helper', args: [] }),
    );
    const error = await rejects(transport.start());

    expect(error.code).toBe('helper-unavailable');
    expect(transport.state).toBe('failed');
  });

  it('reports an unresponsive helper instead of hanging', async () => {
    const transport = track(
      createStubTransport({ dropRequests: true }, { handshakeTimeoutMs: 200 }),
    );
    const crash = once<HelperCrashReport>((listener) => transport.on('crash', listener));

    const error = await rejects(transport.start());
    expect(error.code).toBe('helper-unavailable');
    expect((await crash).reason).toBe('handshake-failed');
    expect(transport.state).toBe('failed');
  });

  it('rejects requests once the transport has failed', async () => {
    const transport = track(
      createStubTransport({ crashOnStart: true }, { handshakeTimeoutMs: 500 }),
    );
    await rejects(transport.start());

    const error = await rejects(transport.request(healthOperation, {}));
    expect(error.code).toBe('helper-unavailable');
  });
});

describe('request/response correlation', () => {
  it('round-trips text through echo', async () => {
    const transport = track(createStubTransport());
    await transport.start();

    const result = await transport.request(echoOperation, { text: 'hello helper' });
    expect(result.payload).toEqual({ text: 'hello helper', binaryLength: 0 });
  });

  it('round-trips a binary fixture byte for byte', async () => {
    const transport = track(createStubTransport());
    await transport.start();

    const fixture = deterministicBytes(256 * 1024);
    const digest = createHash('sha256').update(fixture).digest('hex');

    const result = await transport.request(echoOperation, { text: 'binary' }, { binary: fixture });

    expect(result.payload.binaryLength).toBe(fixture.length);
    expect(result.binary).toHaveLength(fixture.length);
    expect(createHash('sha256').update(result.binary).digest('hex')).toBe(digest);
  });

  it('keeps concurrent requests correlated to their own responses', async () => {
    const transport = track(createStubTransport());
    await transport.start();

    const texts = Array.from({ length: 25 }, (_, index) => `message-${String(index)}`);
    const results = await Promise.all(
      texts.map((text, index) =>
        transport.request(echoOperation, { text }, { binary: deterministicBytes(64, index + 1) }),
      ),
    );

    expect(results.map((result) => result.payload.text)).toEqual(texts);
    for (const [index, result] of results.entries()) {
      expect(result.binary.equals(deterministicBytes(64, index + 1))).toBe(true);
    }
  });

  it('surfaces a response for an unknown request id instead of dropping it', async () => {
    // The stub answers every request twice; the second copy correlates to
    // nothing, which must be reported rather than silently discarded.
    const transport = track(createStubTransport({ duplicateResponse: true }));
    await transport.start();

    const protocolError = once<PilotError>((listener) => transport.on('protocol-error', listener));
    await transport.request(echoOperation, { text: 'hi' });

    const error = await protocolError;
    expect(error.code).toBe('invalid-request');
    expect(error.message).toMatch(/unknown request id/);
    // The transport stays usable: an unmatched response is reported, not fatal.
    expect(transport.state).toBe('ready');
    expect((await transport.request(healthOperation, {})).payload.status).toBe('ok');
  });

  it('times out and reports the mismatch when the helper answers a mangled id', async () => {
    const transport = track(createStubTransport({ corruptResponseId: true }));
    await transport.start();

    const protocolError = once<PilotError>((listener) => transport.on('protocol-error', listener));
    const error = await rejects(
      transport.request(echoOperation, { text: 'hi' }, { timeoutMs: 300 }),
    );

    expect(error.code).toBe('timeout');
    expect((await protocolError).message).toMatch(/unknown request id/);
  });

  it('rejects a response that answers the wrong operation', async () => {
    const transport = track(createStubTransport({ corruptResponseOp: true }));
    await transport.start();

    const error = await rejects(transport.request(echoOperation, { text: 'hi' }));
    expect(error.code).toBe('invalid-request');
    expect(error.details).toMatchObject({ expected: 'echo', received: 'health' });
  });

  it('rejects a response whose payload fails the operation schema', async () => {
    const brokenEcho = defineHelperOperation({
      name: 'echo',
      request: z.strictObject({ text: z.string() }),
      response: z.strictObject({ text: z.string(), binaryLength: z.literal(-1) }),
      requestBinary: true,
      responseBinary: true,
    });
    const transport = track(createStubTransport());
    await transport.start();
    transport.register(brokenEcho);

    const error = await rejects(transport.request(brokenEcho, { text: 'hi' }));
    expect(error.code).toBe('invalid-request');
    expect(error.message).toMatch(/Invalid response payload/);
  });

  it('propagates a typed error reported by the helper', async () => {
    const unknownOperation = defineHelperOperation({
      name: 'not.implemented',
      request: z.strictObject({}),
      response: z.strictObject({}),
      requestBinary: false,
      responseBinary: false,
    });
    const transport = track(createStubTransport());
    await transport.start();

    const error = await rejects(transport.request(unknownOperation, {}));
    expect(error.code).toBe('invalid-request');
    expect(error.message).toMatch(/unknown operation/);
  });

  it('rejects a request payload that fails its own schema before sending', async () => {
    const transport = track(createStubTransport());
    await transport.start();

    const error = await rejects(
      transport.request(echoOperation, { text: 42 } as unknown as { text: string }),
    );
    expect(error.code).toBe('invalid-request');
    expect(error.details).toMatchObject({ op: 'echo' });
  });

  it('refuses a binary payload on an operation that does not accept one', async () => {
    const transport = track(createStubTransport());
    await transport.start();

    const error = await rejects(
      transport.request(healthOperation, {}, { binary: Buffer.from('nope') }),
    );
    expect(error.code).toBe('invalid-request');
  });
});

describe('deadlines and cancellation', () => {
  it('times out a request the helper never answers', async () => {
    const transport = track(createStubTransport({ dropOps: ['echo'] }));
    await transport.start();

    const error = await rejects(
      transport.request(echoOperation, { text: 'hi' }, { timeoutMs: 150 }),
    );
    expect(error.code).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(transport.state).toBe('ready');
    expect(transport.pendingRequestCount).toBe(0);
  });

  it('cancels a request when the caller aborts', async () => {
    const transport = track(createStubTransport({ dropOps: ['echo'] }));
    await transport.start();

    const controller = new AbortController();
    const pending = transport.request(
      echoOperation,
      { text: 'hi' },
      { signal: controller.signal, timeoutMs: 5_000 },
    );
    controller.abort();

    const error = await rejects(pending);
    expect(error.code).toBe('cancelled');
    expect(transport.pendingRequestCount).toBe(0);
  });

  it('rejects immediately for an already-aborted signal', async () => {
    const transport = track(createStubTransport());
    await transport.start();

    const error = await rejects(
      transport.request(echoOperation, { text: 'hi' }, { signal: AbortSignal.abort() }),
    );
    expect(error.code).toBe('cancelled');
  });
});

describe('crash handling and supervision', () => {
  it('rejects in-flight work and reports the crash', async () => {
    const transport = track(
      createStubTransport({ crashOnOps: ['echo'], exitCode: 7, stderrLine: 'stub: boom' }),
    );
    await transport.start();

    const crash = once<HelperCrashReport>((listener) => transport.on('crash', listener));
    const error = await rejects(transport.request(echoOperation, { text: 'hi' }));
    expect(error.code).toBe('helper-unavailable');

    const report = await crash;
    expect(report.reason).toBe('exit');
    expect(report.exitCode).toBe(7);
    expect(report.abandonedRequests).toBe(1);
    expect(report.stderrTail.join('\n')).toMatch(/boom/);
    expect(report.willRestart).toBe(false);
    expect(transport.state).toBe('failed');
  });

  it('restarts a crashed helper and serves requests again', async () => {
    const transport = track(
      createStubTransport(
        { crashOnOps: ['echo'] },
        { restart: { enabled: true, initialDelayMs: 10, factor: 2, maxRestarts: 3 } },
      ),
    );
    await transport.start();
    const firstPid = transport.pid;

    const states: HelperTransportState[] = [];
    transport.on('state', (state) => states.push(state));

    await rejects(transport.request(echoOperation, { text: 'crash me' }));
    await once<HelperTransportState>(
      (listener) => transport.on('state', listener),
      4_000,
      (state) => state === 'ready',
    );

    expect(states).toContain('restarting');
    expect(transport.state).toBe('ready');
    expect(transport.pid).not.toBe(firstPid);
    expect((await transport.request(healthOperation, {})).payload.status).toBe('ok');
  });

  it('queues a request issued while the helper is restarting', async () => {
    const transport = track(
      createStubTransport(
        { crashOnOps: ['echo'] },
        { restart: { enabled: true, initialDelayMs: 25, factor: 2, maxRestarts: 3 } },
      ),
    );
    await transport.start();

    await rejects(transport.request(echoOperation, { text: 'crash me' }));
    expect(transport.state).toBe('restarting');

    // Issued mid-restart: it must wait for the new helper, not fail fast.
    const result = await transport.request(healthOperation, {});
    expect(result.payload.status).toBe('ok');
  });

  it('backs off exponentially and gives up after the restart budget', async () => {
    const transport = track(
      createStubTransport(
        { crashOnStart: true },
        {
          handshakeTimeoutMs: 1_000,
          readyTimeoutMs: 8_000,
          restart: {
            enabled: true,
            initialDelayMs: 10,
            factor: 2,
            maxDelayMs: 80,
            maxRestarts: 3,
            windowMs: 60_000,
          },
        },
      ),
    );
    const reports: HelperCrashReport[] = [];
    transport.on('crash', (report) => reports.push(report));

    const error = await rejects(transport.start());

    expect(error.code).toBe('helper-unavailable');
    expect(transport.state).toBe('failed');
    expect(reports).toHaveLength(4);
    expect(reports.map((report) => report.restartDelayMs)).toEqual([10, 20, 40, undefined]);
    expect(reports.map((report) => report.willRestart)).toEqual([true, true, true, false]);
    expect(transport.lastError?.code).toBe('helper-unavailable');
  });
});

describe('protocol violations from the helper', () => {
  const cases = [
    { name: 'a malformed frame header', stub: { emitBadMagic: true }, code: 'invalid-request' },
    {
      name: 'an oversized declared frame',
      stub: { emitOversizedHeader: true },
      code: 'payload-too-large',
    },
    {
      name: 'a future protocol version',
      stub: { emitFutureVersion: true },
      code: 'protocol-version-mismatch',
    },
  ] as const;

  for (const testCase of cases) {
    it(`kills the helper on ${testCase.name}`, async () => {
      const transport = track(createStubTransport(testCase.stub, { handshakeTimeoutMs: 1_000 }));
      const protocolError = once<PilotError>((listener) =>
        transport.on('protocol-error', listener),
      );

      const startError = await rejects(transport.start());
      expect(startError.code).toBe('helper-unavailable');
      expect((await protocolError).code).toBe(testCase.code);
      expect(transport.state).toBe('failed');
    });
  }
});

describe('shutdown', () => {
  it('stops a healthy helper', async () => {
    const transport = createStubTransport();
    await transport.start();
    await transport.stop();

    expect(transport.state).toBe('stopped');
    expect(transport.pid).toBeUndefined();
  });

  it('escalates to SIGKILL when the helper ignores SIGTERM', async () => {
    const transport = createStubTransport({ ignoreSigterm: true }, { shutdownGraceMs: 100 });
    await transport.start();

    await transport.stop();
    expect(transport.state).toBe('stopped');
  });

  it('rejects in-flight requests with cancelled', async () => {
    const transport = createStubTransport({ dropOps: ['echo'] });
    await transport.start();

    const pending = transport.request(echoOperation, { text: 'hi' }, { timeoutMs: 5_000 });
    const stopped = transport.stop();

    const error = await rejects(pending);
    expect(error.code).toBe('cancelled');
    await stopped;
  });

  it('does not restart after an explicit stop', async () => {
    const transport = createStubTransport({}, { restart: { enabled: true, initialDelayMs: 10 } });
    await transport.start();
    await transport.stop();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(transport.state).toBe('stopped');
    expect(transport.pid).toBeUndefined();
  });
});
