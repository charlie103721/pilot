import { afterEach, describe, expect, it } from 'vitest';
import { createFakeClock } from '@pilot/platform/fakes';
import {
  DEFAULT_PUSH_TO_TALK_BINDING,
  hotkeyBlockingPermission,
  hotkeyUnavailableMessage,
  isHotkeyUsable,
  type HotkeyAvailability,
  type HotkeyEvent,
} from '@pilot/platform';
import { isTextFallbackAvailable } from '@pilot/interaction';
import { MacHotkeyAdapter, echoOperation, type NativeHelperTransport } from '@pilot/platform-mac';
import { createStubTransport } from './support/harness.js';
import type { StubConfig, StubHotkeyStep } from './support/helper-stub.js';

/**
 * The macOS `HotkeyAdapter`, driven end to end against the Node stub.
 *
 * The demo `docs/implementation.md` asks for — "observe reliable press/release
 * events while Pilot is not focused" — **cannot run here**: there is no macOS,
 * no Swift toolchain and no keyboard (runbook amendment 8). What runs instead
 * is the whole host half against a stub that speaks the same framed protocol
 * and plays a scripted tap, including the misbehaviours a real one produces:
 * key repeat, a tap the system switches off, a permission that is not granted,
 * and a key still held when the tap dies.
 *
 * Two deliberate properties of these tests:
 *
 * - **The stub does not coalesce.** It replays the script verbatim, so what is
 *   proven here is the host's own coalescing rather than correctness inherited
 *   from a Swift file that has never been compiled.
 * - **Nothing asserts the interleaving of the `hotkey.start` response with the
 *   events that follow it.** That ordering is genuinely not guaranteed — the
 *   response frame and the first event frames can arrive in one read, and the
 *   transport dispatches both before the awaited continuation runs. Asserting
 *   it would be asserting a property the system does not have; the adapter
 *   instead refuses to let the older response overwrite the newer event.
 */

const transports: NativeHelperTransport[] = [];
const adapters: MacHotkeyAdapter[] = [];

interface Harness {
  readonly adapter: MacHotkeyAdapter;
  readonly transport: NativeHelperTransport;
  readonly clock: ReturnType<typeof createFakeClock>;
  readonly events: HotkeyEvent[];
}

async function start(
  stub: StubConfig = {},
  options: Partial<ConstructorParameters<typeof MacHotkeyAdapter>[0]> = {},
): Promise<Harness> {
  const transport = createStubTransport(stub);
  transports.push(transport);
  await transport.start();
  const clock = createFakeClock(0);
  const adapter = new MacHotkeyAdapter({
    transport,
    clock: () => clock.now(),
    // Long enough that the watchdog never fires on its own; tests call
    // `sweep()` when they mean to test it.
    holdWatchdogIntervalMs: 600_000,
    ...options,
  });
  adapters.push(adapter);
  const events: HotkeyEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  return { adapter, transport, clock, events };
}

/**
 * Waits until the collected events satisfy `predicate`.
 *
 * Polls the array rather than subscribing, so an event that has already been
 * emitted still counts. A subscribe-and-wait helper silently misses those and
 * fails as a timeout, which reads like a broken feature rather than a test that
 * arrived late.
 */
async function until(
  events: readonly HotkeyEvent[],
  predicate: (events: readonly HotkeyEvent[]) => boolean,
  label: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate(events)) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${label}; saw [${events.map((e) => e.type).join(', ')}]`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const has = (type: HotkeyEvent['type']) => (events: readonly HotkeyEvent[]) =>
  events.some((event) => event.type === type);

const countOf = (events: readonly HotkeyEvent[], type: HotkeyEvent['type']): number =>
  events.filter((event) => event.type === type).length;

const availabilities = (events: readonly HotkeyEvent[]): HotkeyAvailability[] =>
  events.flatMap((event) =>
    event.type === 'hotkey-availability-changed' ? [event.availability] : [],
  );

const press: StubHotkeyStep[] = [{ key: 'down' }, { key: 'up' }];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    adapter.dispose();
  }
  for (const transport of transports.splice(0)) {
    await transport.stop();
  }
});

describe('MacHotkeyAdapter', () => {
  it('defaults to Right Option and reports it as stopped until started', async () => {
    const { adapter } = await start();
    const status = await adapter.status();

    expect(status.binding).toEqual(DEFAULT_PUSH_TO_TALK_BINDING);
    expect(status.availability).toEqual({ status: 'stopped' });
    expect(isHotkeyUsable(status.availability)).toBe(false);
  });

  it('delivers one press and one release for a held key', async () => {
    const { adapter, events } = await start({ hotkeyScript: press });
    const status = await adapter.start();
    expect(status.availability).toEqual({ status: 'active' });

    await until(events, has('hotkey-up'), 'the release');

    const keys = events.filter((event) => event.type !== 'hotkey-availability-changed');
    expect(keys.map((event) => event.type)).toEqual(['hotkey-down', 'hotkey-up']);
    expect(keys[0]).toMatchObject({ type: 'hotkey-down', sequence: 1 });
    expect(keys[1]).toMatchObject({ type: 'hotkey-up', sequence: 1, synthetic: false });
    expect(availabilities(events)).toContainEqual({ status: 'active' });
  });

  it('coalesces a key-repeat storm into one press and one release', async () => {
    // Without this the interaction machine answers every repeat with
    // `illegal-transition` — see PR-025's demo.
    const storm: StubHotkeyStep[] = [
      { key: 'down' },
      ...Array.from({ length: 24 }, () => ({ key: 'down', autorepeat: true }) as StubHotkeyStep),
      { key: 'up' },
    ];
    const { adapter, events } = await start({ hotkeyScript: storm });
    await adapter.start();
    await until(events, has('hotkey-up'), 'the release');

    const keys = events.filter((event) => event.type !== 'hotkey-availability-changed');
    expect(keys.map((event) => event.type)).toEqual(['hotkey-down', 'hotkey-up']);

    const status = await adapter.status();
    expect(status.counters).toMatchObject({ downs: 1, ups: 1, suppressed: 24 });
  });

  it('coalesces duplicate presses that carry no repeat flag', async () => {
    // A helper that forgets to set `autorepeat` must not be able to storm the
    // machine either.
    const script: StubHotkeyStep[] = [{ key: 'down' }, { key: 'down' }, { key: 'down' }];
    const { adapter, events } = await start({ hotkeyScript: script });
    await adapter.start();
    await until(events, has('hotkey-down'), 'the press');

    const status = await adapter.status();
    expect(countOf(events, 'hotkey-down')).toBe(1);
    expect(status.counters).toMatchObject({ downs: 1, suppressed: 2 });
    expect(status.held).toBe(true);
  });

  it('discards a report about any key it did not bind', async () => {
    // The host-side share of "this is not a keylogger": an event naming another
    // key is dropped, not forwarded and not logged.
    const script: StubHotkeyStep[] = [
      { key: 'down', keyCode: 0 },
      { key: 'up', keyCode: 0 },
      { key: 'down' },
      { key: 'up' },
    ];
    const { adapter, events } = await start({ hotkeyScript: script });
    await adapter.start();
    await until(events, has('hotkey-up'), 'the release');

    expect(countOf(events, 'hotkey-down')).toBe(1);
    expect(adapter.discardedForeignKeyEvents).toBe(2);
  });

  describe('a tap the system switches off', () => {
    it('reports it and recovers when the helper re-enables it', async () => {
      const script: StubHotkeyStep[] = [
        { tap: 'disabled-by-timeout' },
        { tap: 're-enabled' },
        { key: 'down' },
        { key: 'up' },
      ];
      const { adapter, events } = await start({ hotkeyScript: script });
      await adapter.start();
      await until(events, has('hotkey-up'), 'a press after recovery');

      // The disabled state is reported, not swallowed…
      expect(availabilities(events)).toContainEqual({
        status: 'unavailable',
        reason: 'listener-disabled',
        detail: 'the event tap was disabled by the system',
      });
      // …and the last thing it says is that the tap works again.
      expect(availabilities(events).at(-1)).toEqual({ status: 'active' });
      // The press after recovery arrives: the adapter re-armed rather than
      // staying dead quietly.
      expect(countOf(events, 'hotkey-down')).toBe(1);

      const status = await adapter.status();
      expect(status.availability).toEqual({ status: 'active' });
      expect(status.counters).toMatchObject({ listenerDisabled: 1, listenerRestored: 1 });
    });

    it('releases a key that was held when the tap died', async () => {
      // The failure this whole PR defends against: a press with no release
      // leaves the interaction machine in `listening` with the microphone open.
      const script: StubHotkeyStep[] = [{ key: 'down' }, { tap: 'disabled-by-user-input' }];
      const { adapter, events } = await start({ hotkeyScript: script });
      await adapter.start();
      await until(events, has('hotkey-up'), 'the synthetic release');

      expect(events.find((event) => event.type === 'hotkey-up')).toMatchObject({
        type: 'hotkey-up',
        synthetic: true,
        reason: 'listener-lost',
        sequence: 1,
      });

      // Order matters: the release comes before the availability change that
      // explains it, so a consumer tearing down on "unavailable" has already
      // stopped recording.
      const types = events.map((event) => event.type);
      expect(types.indexOf('hotkey-up')).toBeLessThan(
        types.lastIndexOf('hotkey-availability-changed'),
      );
      expect((await adapter.status()).held).toBe(false);
    });

    it('gives up loudly when the tap cannot be restored', async () => {
      const script: StubHotkeyStep[] = [{ tap: 'disabled-by-timeout' }, { tap: 'failed' }];
      const { adapter, events } = await start({ hotkeyScript: script });
      await adapter.start();
      await until(
        events,
        (collected) =>
          availabilities(collected).some((availability) => availability.status === 'unavailable'),
        'the unavailable state',
      );

      const status = await adapter.status();
      expect(status.availability).toMatchObject({
        status: 'unavailable',
        reason: 'listener-disabled',
      });
      expect(isHotkeyUsable(status.availability)).toBe(false);
      expect(hotkeyUnavailableMessage(status.availability)).toContain('Type your question');
    });
  });

  describe('Accessibility is not granted', () => {
    it('resolves with a typed unavailable state instead of throwing', async () => {
      const { adapter, events } = await start({ hotkeyAccessibility: false });
      const status = await adapter.start();

      expect(status.availability).toEqual({
        status: 'unavailable',
        reason: 'permission-missing',
        permission: 'accessibility',
        detail: 'AXIsProcessTrusted() is false; grant Accessibility to Pilot',
      });
      expect(hotkeyBlockingPermission(status.availability)).toBe('accessibility');
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('hotkey-availability-changed');
    });

    it('leaves the in-panel typed fallback reachable', async () => {
      // system-design §16, and runbook follow-up 4: the user must never be left
      // with no way to ask. `isTextFallbackAvailable` is PR-025's own answer,
      // derived from the transition table, and it is what PR-032's panel has to
      // consult when this adapter reports `unavailable`.
      const { adapter } = await start({ hotkeyAccessibility: false });
      const status = await adapter.start();

      expect(isHotkeyUsable(status.availability)).toBe(false);
      for (const state of ['idle', 'observing', 'error'] as const) {
        expect(isTextFallbackAvailable(state)).toBe(true);
      }
      expect(hotkeyUnavailableMessage(status.availability)).toContain('Accessibility');
    });

    it('distinguishes a refused tap from a missing permission', async () => {
      // Accessibility granted and macOS still says no — on macOS 10.15+ this is
      // usually Input Monitoring, which is not a permission Pilot models.
      const { adapter } = await start({ hotkeyTapFails: true });
      const status = await adapter.start();

      expect(status.availability).toMatchObject({
        status: 'unavailable',
        reason: 'listener-rejected',
      });
      expect(hotkeyBlockingPermission(status.availability)).toBeNull();
    });
  });

  describe('rebinding', () => {
    const f13 = {
      keyCode: 105,
      label: 'F13',
      isModifierKey: false,
      requiredModifiers: [],
    } as const;

    it('listens for the new key and ignores the old one', async () => {
      const script: StubHotkeyStep[] = [
        { key: 'down', keyCode: 61 },
        { key: 'down' },
        { key: 'up' },
      ];
      const { adapter, events } = await start({ hotkeyScripts: [[], script] });
      await adapter.start();
      const status = await adapter.start(f13);
      expect(status.binding).toEqual(f13);

      await until(events, has('hotkey-up'), 'the release on the new binding');

      const downs = events.filter((event) => event.type === 'hotkey-down');
      expect(downs).toHaveLength(1);
      expect(downs[0]).toMatchObject({ binding: f13 });
      // The old key produced a report and it went nowhere.
      expect(adapter.discardedForeignKeyEvents).toBe(1);
    });

    it('releases a key held on the previous binding', async () => {
      const { adapter, clock, events } = await start({ hotkeyScript: [{ key: 'down' }] });
      await adapter.start();
      await until(events, has('hotkey-down'), 'the press');

      clock.advance(120);
      await adapter.start(f13);

      expect(events.find((event) => event.type === 'hotkey-up')).toMatchObject({
        synthetic: true,
        reason: 'stopped',
        heldMs: 120,
      });
    });
  });

  describe('the stuck-key watchdog', () => {
    it('releases a press that outlived the maximum hold', async () => {
      const { adapter, clock, events } = await start(
        { hotkeyScript: [{ key: 'down' }] },
        { maxHoldMs: 5_000 },
      );
      await adapter.start();
      await until(events, has('hotkey-down'), 'the press');

      clock.advance(4_999);
      adapter.sweep();
      expect(countOf(events, 'hotkey-up')).toBe(0);

      clock.advance(1);
      adapter.sweep();
      expect(events.find((event) => event.type === 'hotkey-up')).toMatchObject({
        synthetic: true,
        reason: 'held-too-long',
        heldMs: 5_000,
      });
    });
  });

  describe('the helper going away', () => {
    it('releases a held key and names the helper as the reason', async () => {
      const { adapter, transport, clock, events } = await start({
        hotkeyScript: [{ key: 'down' }],
      });
      await adapter.start();
      await until(events, has('hotkey-down'), 'the press');

      clock.advance(250);
      await transport.stop();
      await until(events, has('hotkey-up'), 'the synthetic release');

      expect(events.find((event) => event.type === 'hotkey-up')).toMatchObject({
        synthetic: true,
        reason: 'helper-lost',
        heldMs: 250,
      });
      expect(availabilities(events).at(-1)).toMatchObject({
        status: 'unavailable',
        reason: 'helper-unavailable',
      });
    });

    it('reinstalls the tap after the helper restarts', async () => {
      // The tap dies with the process. A hotkey that silently stops working
      // after a helper restart is exactly the invisible failure this PR exists
      // to prevent.
      // `hotkeyScript` (not `hotkeyScripts`) because a restart is a *new stub
      // process* with a fresh script cursor — the same reason a real helper
      // comes back with no tap and no memory of the key.
      const transport = createStubTransport(
        { hotkeyScript: press, crashOnOps: ['echo'] },
        { restart: { enabled: true, initialDelayMs: 10, maxRestarts: 3 } },
      );
      transports.push(transport);
      await transport.start();
      const adapter = new MacHotkeyAdapter({ transport, holdWatchdogIntervalMs: 600_000 });
      adapters.push(adapter);
      const events: HotkeyEvent[] = [];
      adapter.subscribe((event) => events.push(event));

      await adapter.start();
      await until(events, has('hotkey-up'), 'the first press');
      expect(countOf(events, 'hotkey-down')).toBe(1);

      // `echo` is the stub's crash trigger: it kills the helper the way a real
      // crash takes the tap with it.
      await expect(transport.request(echoOperation, { text: 'die' })).rejects.toThrow();
      await until(
        events,
        (collected) =>
          availabilities(collected).some(
            (availability) =>
              availability.status === 'unavailable' && availability.reason === 'helper-unavailable',
          ),
        'the helper being reported unavailable',
      );

      // Nobody calls `start()` again: the adapter reinstalls the tap on the
      // transport's return to `ready`, and the restarted helper delivers a real
      // press through it.
      await until(
        events,
        (collected) => countOf(collected, 'hotkey-down') === 2,
        'a press through the reinstalled tap',
      );
      expect(events.filter((event) => event.type === 'hotkey-up').every((e) => !e.synthetic)).toBe(
        true,
      );
      expect((await adapter.status()).availability).toEqual({ status: 'active' });
    });
  });

  it('releases a held key when stopped', async () => {
    const { adapter, clock, events } = await start({ hotkeyScript: [{ key: 'down' }] });
    await adapter.start();
    await until(events, has('hotkey-down'), 'the press');

    clock.advance(80);
    const status = await adapter.stop();

    expect(events.find((event) => event.type === 'hotkey-up')).toMatchObject({
      synthetic: true,
      reason: 'stopped',
      heldMs: 80,
    });
    expect(status.availability).toEqual({ status: 'stopped' });
    expect(status.held).toBe(false);
  });

  it('releases a held key when disposed', async () => {
    const { adapter, clock, events } = await start({ hotkeyScript: [{ key: 'down' }] });
    await adapter.start();
    await until(events, has('hotkey-down'), 'the press');

    clock.advance(40);
    adapter.dispose();

    expect(events.find((event) => event.type === 'hotkey-up')).toMatchObject({
      synthetic: true,
      reason: 'stopped',
      heldMs: 40,
    });
  });
});
