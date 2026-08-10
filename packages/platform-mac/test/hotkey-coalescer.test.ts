import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@pilot/platform/fakes';
import {
  DEFAULT_MAX_HOLD_MS,
  DEFAULT_MIN_RETRIGGER_MS,
  HotkeyCoalescer,
  type CoalescedHotkeyTransition,
  type RawHotkeyTransition,
} from '@pilot/platform-mac';

/**
 * The host-side coalescing rules, on an injected clock.
 *
 * Every rule that depends on elapsed time is exercised by moving a fake clock,
 * never by sleeping — the whole reason `HotkeyCoalescer` takes a `clock` is
 * that a wall-clock version of these tests would be flaky in exactly the places
 * the rules matter.
 */

function down(overrides: Partial<RawHotkeyTransition> = {}): RawHotkeyTransition {
  return { phase: 'down', autorepeat: false, sequence: 1, ...overrides };
}

function up(overrides: Partial<RawHotkeyTransition> = {}): RawHotkeyTransition {
  return { phase: 'up', autorepeat: false, sequence: 2, ...overrides };
}

function make(options: { minRetriggerMs?: number; maxHoldMs?: number } = {}): {
  clock: ReturnType<typeof createFakeClock>;
  coalescer: HotkeyCoalescer;
} {
  // Zero-based so the asserted timestamps read as elapsed milliseconds.
  const clock = createFakeClock(0);
  const coalescer = new HotkeyCoalescer({ clock: () => clock.now(), ...options });
  coalescer.listen();
  return { clock, coalescer };
}

function emitted(outcome: ReturnType<HotkeyCoalescer['accept']>): CoalescedHotkeyTransition | null {
  return 'emit' in outcome ? outcome.emit : null;
}

describe('HotkeyCoalescer', () => {
  it('pairs one press with one release', () => {
    const { clock, coalescer } = make();
    const pressed = emitted(coalescer.accept(down()));
    clock.advance(420);
    const released = emitted(coalescer.accept(up()));

    expect(pressed).toMatchObject({ type: 'down', sequence: 1 });
    expect(released).toMatchObject({ type: 'up', sequence: 1, heldMs: 420, synthetic: false });
    expect(coalescer.held).toBe(false);
  });

  it('folds a key-repeat storm into a single press', () => {
    // PR-025's demo shows the alternative: the state machine answering every
    // repeat with `illegal-transition`, at the keyboard repeat rate.
    const { clock, coalescer } = make();
    expect(emitted(coalescer.accept(down()))).toMatchObject({ type: 'down' });

    const outcomes = [];
    for (let index = 0; index < 30; index += 1) {
      clock.advance(33);
      outcomes.push(coalescer.accept(down({ autorepeat: true, sequence: index + 2 })));
    }

    expect(outcomes.every((outcome) => 'suppressed' in outcome)).toBe(true);
    expect(
      outcomes.map((outcome) => ('suppressed' in outcome ? outcome.suppressed.reason : '')),
    ).toEqual(Array.from({ length: 30 }, () => 'auto-repeat'));
    expect(coalescer.counts).toMatchObject({ downs: 1, ups: 0, suppressed: 30 });
  });

  it('suppresses a second press with no intervening release, repeat flag or not', () => {
    const { clock, coalescer } = make();
    coalescer.accept(down());
    clock.advance(100);
    const second = coalescer.accept(down({ autorepeat: false, sequence: 2 }));

    expect(second).toEqual({
      suppressed: { reason: 'already-held', phase: 'down', at: 100, sequence: 2 },
    });
  });

  it('suppresses a release with nothing held', () => {
    const { coalescer } = make();
    expect(coalescer.accept(up())).toEqual({
      suppressed: { reason: 'stray-up', phase: 'up', at: 0, sequence: 2 },
    });
  });

  it('treats a press within the retrigger window as switch chatter', () => {
    const { clock, coalescer } = make();
    coalescer.accept(down());
    clock.advance(10);
    coalescer.accept(up());

    clock.advance(DEFAULT_MIN_RETRIGGER_MS - 1);
    expect(coalescer.accept(down({ sequence: 3 }))).toMatchObject({
      suppressed: { reason: 'retrigger-too-fast' },
    });

    clock.advance(1);
    expect(emitted(coalescer.accept(down({ sequence: 4 })))).toMatchObject({
      type: 'down',
      sequence: 2,
    });
  });

  it('ignores transitions while not listening', () => {
    const clock = createFakeClock(0);
    const coalescer = new HotkeyCoalescer({ clock: () => clock.now() });
    expect(coalescer.accept(down())).toMatchObject({ suppressed: { reason: 'not-listening' } });
    expect(coalescer.held).toBe(false);
  });

  describe('the pairing invariant', () => {
    it('synthesises the release when the listener is lost mid-press', () => {
      const { clock, coalescer } = make();
      coalescer.accept(down());
      clock.advance(900);

      const released = coalescer.release('listener-lost');
      expect(released).toMatchObject({
        type: 'up',
        sequence: 1,
        heldMs: 900,
        synthetic: true,
        reason: 'listener-lost',
      });
      expect(coalescer.held).toBe(false);
    });

    it('is a no-op when nothing is held', () => {
      const { coalescer } = make();
      expect(coalescer.release('helper-lost')).toBeNull();
      expect(coalescer.counts.synthetic).toBe(0);
    });

    it('releases before it stops listening, so teardown order is safe', () => {
      const { clock, coalescer } = make();
      coalescer.accept(down());
      clock.advance(50);

      const released = coalescer.unlisten('stopped');
      expect(released).toMatchObject({ synthetic: true, reason: 'stopped' });
      expect(coalescer.listening).toBe(false);
    });

    it('does not emit a second release for a key already released', () => {
      const { clock, coalescer } = make();
      coalescer.accept(down());
      clock.advance(20);
      coalescer.accept(up());

      expect(coalescer.release('listener-lost')).toBeNull();
      expect(coalescer.counts).toMatchObject({ downs: 1, ups: 1, synthetic: 0 });
    });
  });

  describe('the stuck-key watchdog', () => {
    it('does nothing before the maximum hold', () => {
      const { clock, coalescer } = make();
      coalescer.accept(down());
      clock.advance(DEFAULT_MAX_HOLD_MS - 1);
      expect(coalescer.sweep()).toBeNull();
      expect(coalescer.held).toBe(true);
    });

    it('releases a press that outlived the maximum hold', () => {
      // macOS really does lose a modifier key-up across a Space switch. Without
      // this the machine sits in `listening` with the microphone open.
      const { clock, coalescer } = make({ maxHoldMs: 5_000 });
      coalescer.accept(down());
      clock.advance(5_000);

      expect(coalescer.sweep()).toMatchObject({
        type: 'up',
        synthetic: true,
        reason: 'held-too-long',
        heldMs: 5_000,
      });
      expect(coalescer.sweep()).toBeNull();
    });

    it('does nothing when no key is held', () => {
      const { coalescer } = make();
      expect(coalescer.sweep()).toBeNull();
    });
  });

  it('keeps the retrigger guard across a restart of listening', () => {
    // A helper restart must not let a key that bounced during the outage
    // register as a fresh press.
    const { clock, coalescer } = make();
    coalescer.accept(down());
    clock.advance(10);
    coalescer.accept(up());

    coalescer.unlisten('helper-lost');
    coalescer.listen();

    clock.advance(5);
    expect(coalescer.accept(down({ sequence: 9 }))).toMatchObject({
      suppressed: { reason: 'retrigger-too-fast' },
    });
  });

  it('numbers presses so a down and its up can be matched', () => {
    const { clock, coalescer } = make();
    const first = emitted(coalescer.accept(down()));
    clock.advance(100);
    const firstUp = emitted(coalescer.accept(up()));
    clock.advance(1_000);
    const second = emitted(coalescer.accept(down({ sequence: 3 })));
    clock.advance(100);
    const secondUp = emitted(coalescer.accept(up({ sequence: 4 })));

    expect([first, firstUp, second, secondUp].map((event) => event?.sequence)).toEqual([
      1, 1, 2, 2,
    ]);
  });
});
