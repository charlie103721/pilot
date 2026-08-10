import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUSH_TO_TALK_BINDING,
  HOTKEY_UNAVAILABLE_REASONS,
  hotkeyBlockingPermission,
  hotkeyUnavailableMessage,
  isHotkeyUsable,
  type HotkeyAvailability,
  type HotkeyEvent,
} from '@pilot/platform';
import { FakeHotkeyAdapter, createFakeClock } from '@pilot/platform/fakes';

/**
 * The push-to-talk contract and its fake (PR-015).
 *
 * A separate file from `fakes.contract.test.ts` on purpose: three sibling PRs
 * are editing this package's neighbourhood concurrently, and a new file merges
 * mechanically where an edit to a shared test file does not.
 */

function make(): {
  adapter: FakeHotkeyAdapter;
  clock: ReturnType<typeof createFakeClock>;
  events: HotkeyEvent[];
} {
  const clock = createFakeClock(0);
  const adapter = new FakeHotkeyAdapter({ clock: () => clock.now() });
  const events: HotkeyEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  return { adapter, clock, events };
}

describe('the hotkey contract', () => {
  it('defaults to Right Option, which never auto-repeats and types nothing', () => {
    expect(DEFAULT_PUSH_TO_TALK_BINDING).toEqual({
      keyCode: 61,
      label: 'Right Option',
      isModifierKey: true,
      requiredModifiers: [],
    });
  });

  it('treats only `active` as usable', () => {
    expect(isHotkeyUsable({ status: 'active' })).toBe(true);
    expect(isHotkeyUsable({ status: 'stopped' })).toBe(false);
    expect(
      isHotkeyUsable({ status: 'unavailable', reason: 'permission-missing', detail: '' }),
    ).toBe(false);
  });

  it('offers the user a way forward for every unavailable reason', () => {
    // system-design §16 never permits a state in which the user has no way to
    // ask a question, so every message says what is wrong *and* that typing
    // still works.
    for (const reason of HOTKEY_UNAVAILABLE_REASONS) {
      const availability: HotkeyAvailability = { status: 'unavailable', reason, detail: 'x' };
      const message = hotkeyUnavailableMessage(availability);
      expect(message, reason).toBeTruthy();
      expect(message, reason).toMatch(/type your question/i);
    }
    expect(hotkeyUnavailableMessage({ status: 'active' })).toBeNull();
  });

  it('names the permission to request only when one would help', () => {
    expect(
      hotkeyBlockingPermission({
        status: 'unavailable',
        reason: 'permission-missing',
        permission: 'accessibility',
        detail: '',
      }),
    ).toBe('accessibility');
    expect(
      hotkeyBlockingPermission({ status: 'unavailable', reason: 'listener-rejected', detail: '' }),
    ).toBeNull();
    expect(hotkeyBlockingPermission({ status: 'active' })).toBeNull();
  });
});

describe('FakeHotkeyAdapter', () => {
  it('emits a paired press and release', async () => {
    const { adapter, clock, events } = make();
    await adapter.start();
    adapter.pressDown();
    clock.advance(350);
    adapter.pressUp();

    expect(events.map((event) => event.type)).toEqual([
      'hotkey-availability-changed',
      'hotkey-down',
      'hotkey-up',
    ]);
    expect(events[2]).toMatchObject({ heldMs: 350, synthetic: false, sequence: 1 });
  });

  it('suppresses a press while the key is already held', async () => {
    const { adapter, events } = make();
    await adapter.start();
    adapter.pressDown();
    adapter.pressDown();
    adapter.pressDown();

    expect(events.filter((event) => event.type === 'hotkey-down')).toHaveLength(1);
    expect((await adapter.status()).counters).toMatchObject({ downs: 1, suppressed: 2 });
  });

  it('ignores presses while it is not active', async () => {
    const { adapter, events } = make();
    adapter.pressDown();
    expect(events).toHaveLength(0);
    expect(adapter.held).toBe(false);
  });

  it('synthesises the release when availability is taken away mid-press', async () => {
    const { adapter, clock, events } = make();
    await adapter.start();
    adapter.pressDown();
    clock.advance(90);
    adapter.setAvailability({
      status: 'unavailable',
      reason: 'listener-disabled',
      detail: 'switched off',
    });

    const release = events.find((event) => event.type === 'hotkey-up');
    expect(release).toMatchObject({ synthetic: true, reason: 'listener-lost', heldMs: 90 });
    // The release precedes the availability change, so a consumer that tears
    // down on "unavailable" has already stopped recording.
    const types = events.map((event) => event.type);
    expect(types.indexOf('hotkey-up')).toBeLessThan(
      types.lastIndexOf('hotkey-availability-changed'),
    );
  });

  it('releases a held key when stopped', async () => {
    const { adapter, clock, events } = make();
    await adapter.start();
    adapter.pressDown();
    clock.advance(15);
    const status = await adapter.stop();

    expect(events.find((event) => event.type === 'hotkey-up')).toMatchObject({
      synthetic: true,
      reason: 'stopped',
    });
    expect(status.availability).toEqual({ status: 'stopped' });
  });

  it('does not throw when started while unavailable', async () => {
    const { adapter } = make();
    adapter.setAvailability({
      status: 'unavailable',
      reason: 'permission-missing',
      permission: 'accessibility',
      detail: 'not trusted',
    });
    const status = await adapter.start();

    expect(status.availability).toMatchObject({ reason: 'permission-missing' });
    expect(isHotkeyUsable(status.availability)).toBe(false);
  });

  it('counts a disabled and restored listener', async () => {
    const { adapter } = make();
    await adapter.start();
    adapter.setAvailability({
      status: 'unavailable',
      reason: 'listener-disabled',
      detail: 'off',
    });
    adapter.setAvailability({ status: 'active' });

    expect((await adapter.status()).counters).toMatchObject({
      listenerDisabled: 1,
      listenerRestored: 1,
    });
  });

  it('closes a press when the binding changes underneath it', async () => {
    const { adapter, events } = make();
    await adapter.start();
    adapter.pressDown();
    adapter.rebind({
      keyCode: 105,
      label: 'F13',
      isModifierKey: false,
      requiredModifiers: [],
    });

    expect(events.find((event) => event.type === 'hotkey-up')).toMatchObject({ synthetic: true });
    expect(adapter.held).toBe(false);
  });
});
