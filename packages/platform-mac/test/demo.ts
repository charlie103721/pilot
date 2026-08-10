/**
 * PR-003 demo: exchange a typed request/response and a binary fixture with the
 * helper, then watch the supervisor recover from a crash.
 *
 * ```sh
 * pnpm build                                   # the demo runs against dist/
 * pnpm --filter @pilot/platform-mac demo       # Node stub (Linux and macOS)
 * PILOT_HELPER_BINARY=… pnpm --filter @pilot/platform-mac demo   # Swift helper (macOS)
 * ```
 *
 * With no `PILOT_HELPER_BINARY` and no SwiftPM build output, it runs against
 * `test/support/helper-stub.ts` and says so. The crash/restart section only
 * runs against the stub — the Swift helper has no "crash on demand" operation.
 */

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  NativeHelperTransport,
  defineHelperOperation,
  echoOperation,
  healthOperation,
  helperBinaryCandidates,
  resolveHelperBinary,
  type HelperCrashReport,
  type HelperTransportOptions,
} from '@pilot/platform-mac';

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function deterministicBytes(length: number, seed = 0x9e3779b9): Buffer {
  const bytes = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

const STUB_PATH = fileURLToPath(new URL('./support/helper-stub.ts', import.meta.url));

interface Target {
  readonly label: string;
  readonly usingStub: boolean;
  readonly options: HelperTransportOptions;
}

function chooseTarget(): Target {
  try {
    const binary = resolveHelperBinary();
    return {
      label: `Swift helper (${binary.source}: ${binary.path})`,
      usingStub: false,
      options: { command: binary.path },
    };
  } catch {
    return {
      label: 'Node stub (no Swift helper built; see the README for the Mac steps)',
      usingStub: true,
      options: {
        command: process.execPath,
        args: [STUB_PATH],
        env: { ...process.env, PILOT_HELPER_STUB: JSON.stringify({ crashOnOps: ['boom'] }) },
      },
    };
  }
}

/** Deliberately unbounded, so the frame ceiling is what rejects the request. */
const oversizeOperation = defineHelperOperation({
  name: 'oversize',
  request: z.strictObject({ text: z.string() }),
  response: z.strictObject({}),
  requestBinary: false,
  responseBinary: false,
});

/** Stub-only operation used to demonstrate crash reporting and restart. */
const boomOperation = defineHelperOperation({
  name: 'boom',
  request: z.strictObject({}),
  response: z.strictObject({}),
  requestBinary: false,
  responseBinary: false,
});

async function main(): Promise<void> {
  const target = chooseTarget();
  say(`helper target: ${target.label}`);
  if (target.usingStub) {
    say(
      `searched: ${helperBinaryCandidates()
        .map((c) => c.path)
        .join(', ')}`,
    );
  }

  const transport = new NativeHelperTransport({
    ...target.options,
    restart: { enabled: true, initialDelayMs: 100, maxRestarts: 3 },
  });

  const crashes: HelperCrashReport[] = [];
  transport.on('crash', (report) => crashes.push(report));
  transport.on('state', (state) => say(`  state -> ${state}`));
  transport.on('protocol-error', (error) => say(`  protocol error: ${error.code}`));

  say('\n1. start (spawn + health handshake)');
  await transport.start();
  const health = await transport.request(healthOperation, {});
  say(`   pid=${String(transport.pid)} version=${health.payload.helperVersion}`);

  say('\n2. typed request/response');
  const echoed = await transport.request(echoOperation, { text: 'point, ask, hear' });
  say(`   echo -> ${JSON.stringify(echoed.payload)}`);

  say('\n3. binary fixture round trip (256 KiB)');
  const fixture = deterministicBytes(256 * 1024);
  const sent = createHash('sha256').update(fixture).digest('hex');
  const returned = await transport.request(echoOperation, { text: 'binary' }, { binary: fixture });
  const received = createHash('sha256').update(returned.binary).digest('hex');
  say(`   sent ${String(fixture.length)} bytes sha256=${sent.slice(0, 16)}…`);
  say(`   back ${String(returned.binary.length)} bytes sha256=${received.slice(0, 16)}…`);
  say(`   identical: ${String(sent === received)}`);

  say('\n4. explicit failure states (deadlines and crashes are covered by the test suite)');
  try {
    // Over the 1 MiB message ceiling: rejected before a byte reaches the pipe.
    await transport.request(oversizeOperation, { text: 'x'.repeat(1_048_577) });
  } catch (error) {
    say(`   oversized message -> ${(error as { code?: string }).code ?? 'unknown'}`);
  }
  try {
    await transport.request(echoOperation, { text: 42 as unknown as string });
  } catch (error) {
    say(`   invalid request payload -> ${(error as { code?: string }).code ?? 'unknown'}`);
  }
  const controller = new AbortController();
  const cancelled = transport.request(echoOperation, { text: 'x' }, { signal: controller.signal });
  controller.abort();
  try {
    await cancelled;
  } catch (error) {
    say(`   abort -> ${(error as { code?: string }).code ?? 'unknown'}`);
  }

  if (target.usingStub) {
    say('\n5. crash, crash report, restart (stub only)');
    try {
      await transport.request(boomOperation, {});
    } catch (error) {
      say(`   in-flight request -> ${(error as { code?: string }).code ?? 'unknown'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    const report = crashes.at(-1);
    say(
      `   crash report: reason=${report?.reason ?? '?'} exitCode=${String(report?.exitCode)} ` +
        `abandoned=${String(report?.abandonedRequests)} willRestart=${String(report?.willRestart)}`,
    );
    const afterRestart = await transport.request(healthOperation, {});
    say(`   restarted pid=${String(transport.pid)} status=${afterRestart.payload.status}`);
  } else {
    say('\n5. crash/restart demo skipped: the Swift helper has no crash-on-demand operation.');
  }

  say('\n6. stop');
  await transport.stop();
  say(`   state=${transport.state}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`demo failed: ${String(error)}\n`);
  process.exitCode = 1;
});
