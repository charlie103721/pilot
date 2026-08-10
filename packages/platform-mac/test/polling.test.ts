import { afterEach, describe, expect, it, vi } from 'vitest';
import { nullLogger } from '@pilot/shared';
import { MacWindowAdapter, type NativeHelperTransport, Poller } from '@pilot/platform-mac';
import {
  STUB_DISPLAYS,
  STUB_WINDOW_SAFARI,
  STUB_WINDOW_TEXTEDIT,
  createStubTransport,
} from './support/harness.js';

/**
 * The poller, and the one behaviour that depends on it being wired to the
 * transport: reconciling the window list after the helper has been restarted.
 */

const transports: NativeHelperTransport[] = [];
const adapters: MacWindowAdapter[] = [];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    adapter.dispose();
  }
  for (const transport of transports.splice(0)) {
    await transport.stop();
  }
});

function poller(tick: () => Promise<void>, intervalMs = 5): Poller {
  return new Poller(tick, { intervalMs, logger: nullLogger, name: 'test' });
}

describe('Poller', () => {
  it('does nothing until started', async () => {
    const tick = vi.fn(async () => undefined);
    const subject = poller(tick);
    expect(subject.running).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(tick).not.toHaveBeenCalled();
  });

  it('ticks on the interval once started', async () => {
    const tick = vi.fn(async () => undefined);
    const subject = poller(tick);
    subject.start();
    await vi.waitFor(() => {
      expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    subject.stop();
  });

  it('stops ticking when stopped', async () => {
    const tick = vi.fn(async () => undefined);
    const subject = poller(tick);
    subject.start();
    await vi.waitFor(() => {
      expect(tick).toHaveBeenCalled();
    });
    subject.stop();
    const seen = tick.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(tick.mock.calls.length).toBe(seen);
  });

  it('is idempotent on start and stop', () => {
    const subject = poller(async () => undefined, 10_000);
    subject.start();
    subject.start();
    expect(subject.running).toBe(true);
    subject.stop();
    subject.stop();
    expect(subject.running).toBe(false);
  });

  it('never overlaps two ticks', async () => {
    // A slow helper must not accumulate a backlog of polls; each tick is armed
    // only after the previous one settles.
    let active = 0;
    let overlapped = false;
    const subject = poller(async () => {
      active += 1;
      if (active > 1) {
        overlapped = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    }, 1);
    subject.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    subject.stop();
    expect(overlapped).toBe(false);
  });

  it('keeps ticking after a failing tick', async () => {
    let calls = 0;
    const subject = poller(async () => {
      calls += 1;
      throw new Error('boom');
    });
    subject.start();
    await vi.waitFor(() => {
      expect(calls).toBeGreaterThanOrEqual(2);
    });
    subject.stop();
  });

  it('refresh runs a tick immediately and resolves when it settles', async () => {
    let done = false;
    const subject = poller(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      done = true;
    }, 10_000);
    await subject.refresh();
    expect(done).toBe(true);
  });

  it('refresh joins an in-flight tick rather than starting a second one', async () => {
    let calls = 0;
    const subject = poller(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }, 10_000);
    await Promise.all([subject.refresh(), subject.refresh()]);
    expect(calls).toBe(1);
  });

  it('refresh does not swallow the schedule when the tick throws', async () => {
    const subject = poller(async () => {
      throw new Error('boom');
    }, 10_000);
    await expect(subject.refresh()).resolves.toBeUndefined();
  });
});

describe('reconciliation after a helper restart', () => {
  it('re-polls as soon as the helper comes back, without waiting out the interval', async () => {
    // A window that closed while the helper was down must not stay "open"
    // until the next scheduled tick — system-design §16 requires observation
    // to stop when the selected window closes, and a 60-second poll interval
    // would keep a dead selection alive for 60 seconds. So the adapter
    // reconciles off the transport's return to `ready`.
    const transport = createStubTransport(
      {
        desktop: { windows: [STUB_WINDOW_SAFARI, STUB_WINDOW_TEXTEDIT], displays: STUB_DISPLAYS },
        crashOnOps: ['boom'],
      },
      { restart: { enabled: true, initialDelayMs: 10, maxRestarts: 3 } },
    );
    transports.push(transport);
    await transport.start();

    // A poll interval far longer than the test: nothing here can be explained
    // by the schedule firing.
    const adapter = new MacWindowAdapter({ transport, pollIntervalMs: 600_000 });
    adapters.push(adapter);
    const off = adapter.subscribe(() => undefined);
    await adapter.refresh();
    const beforeCrash = adapter.lastSnapshot;
    expect(beforeCrash).not.toBeNull();

    const { defineHelperOperation } = await import('@pilot/platform-mac');
    const { z } = await import('zod');
    const boom = defineHelperOperation({
      name: 'boom',
      request: z.strictObject({}),
      response: z.strictObject({}),
      requestBinary: false,
      responseBinary: false,
    });
    await transport.request(boom, {}).catch(() => undefined);

    await vi.waitFor(
      () => {
        expect(adapter.lastSnapshot).not.toBe(beforeCrash);
      },
      { timeout: 4_000 },
    );
    expect(transport.state).toBe('ready');
    off();
  });

  it('does not re-poll on a restart nobody is watching', async () => {
    const transport = createStubTransport(
      {
        desktop: { windows: [STUB_WINDOW_SAFARI], displays: STUB_DISPLAYS },
        crashOnOps: ['boom'],
      },
      { restart: { enabled: true, initialDelayMs: 10, maxRestarts: 3 } },
    );
    transports.push(transport);
    await transport.start();
    const adapter = new MacWindowAdapter({ transport, pollIntervalMs: 600_000 });
    adapters.push(adapter);

    const { defineHelperOperation } = await import('@pilot/platform-mac');
    const { z } = await import('zod');
    const boom = defineHelperOperation({
      name: 'boom',
      request: z.strictObject({}),
      response: z.strictObject({}),
      requestBinary: false,
      responseBinary: false,
    });
    await transport.request(boom, {}).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // No subscribers, so no work: the helper is not kept warm for nobody.
    expect(adapter.lastSnapshot).toBeNull();
  });
});
