import { fileURLToPath } from 'node:url';
import { NativeHelperTransport, type HelperTransportOptions } from '@pilot/platform-mac';
import type { StubConfig } from './helper-stub.js';

/** Absolute path to the Node stub that speaks the helper protocol. */
export const HELPER_STUB_PATH = fileURLToPath(new URL('./helper-stub.ts', import.meta.url));

/**
 * Builds a transport pointed at the Node stub instead of the Swift helper.
 *
 * Timeouts default to small values so the failure paths run in milliseconds
 * rather than seconds; every test that exercises a deadline sets its own.
 */
export function createStubTransport(
  stub: StubConfig = {},
  options: Partial<HelperTransportOptions> = {},
): NativeHelperTransport {
  return new NativeHelperTransport({
    command: process.execPath,
    args: [HELPER_STUB_PATH],
    env: { ...process.env, PILOT_HELPER_STUB: JSON.stringify(stub) },
    requestTimeoutMs: 2_000,
    handshakeTimeoutMs: 2_000,
    readyTimeoutMs: 4_000,
    shutdownGraceMs: 250,
    restart: { enabled: false },
    ...options,
  });
}

/** Deterministic pseudo-random bytes; the binary fixture for round-trip tests. */
export function deterministicBytes(length: number, seed = 0x9e3779b9): Buffer {
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

/** Resolves with the next payload emitted for `event`, or rejects on timeout. */
export function once<T>(
  subscribe: (listener: (payload: T) => void) => () => void,
  timeoutMs = 4_000,
  predicate: (payload: T) => boolean = () => true,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out after ${String(timeoutMs)}ms waiting for an event`));
    }, timeoutMs);
    const unsubscribe = subscribe((payload) => {
      if (!predicate(payload)) {
        return;
      }
      clearTimeout(timer);
      unsubscribe();
      resolve(payload);
    });
  });
}
