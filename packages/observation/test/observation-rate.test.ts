import { describe, expect, it } from 'vitest';
import { createFakeClock, FAKE_EPOCH_MS } from '@pilot/platform/fakes';
import { ObservationRateLimiter } from '../src/observation-rate.js';
import { defineScreenPolicy } from '../src/screen-policy.js';

/**
 * PR-017: the observation rate limit (§10, "no more than two observation calls
 * per second"), at its boundary.
 *
 * Every reading comes from the injected clock. There is no timer here and no
 * `Date.now()` anywhere in the limiter, so these assertions are exact rather
 * than approximately exact.
 */

function subject(maxRequestsPerSecond = 2) {
  const clock = createFakeClock();
  const policy = defineScreenPolicy({ capture: { maxRequestsPerSecond } });
  return { clock, limiter: new ObservationRateLimiter({ clock, policy }) };
}

describe('ObservationRateLimiter', () => {
  it('allows exactly the policy budget inside one window', () => {
    const { limiter } = subject();
    expect(limiter.take(FAKE_EPOCH_MS).allowed).toBe(true);
    expect(limiter.take(FAKE_EPOCH_MS + 100).allowed).toBe(true);
    expect(limiter.take(FAKE_EPOCH_MS + 200).allowed).toBe(false);
  });

  it('reads the clock when no timestamp is given', () => {
    const { clock, limiter } = subject(1);
    expect(limiter.take().allowed).toBe(true);
    expect(limiter.take().allowed).toBe(false);
    clock.advance(1000);
    expect(limiter.take().allowed).toBe(true);
  });

  it('frees a slot at exactly windowMs, not a millisecond later', () => {
    const { limiter } = subject();
    limiter.take(FAKE_EPOCH_MS);
    limiter.take(FAKE_EPOCH_MS + 1);

    // 999 ms after the first call, the window still holds both.
    expect(limiter.check(FAKE_EPOCH_MS + 999).allowed).toBe(false);
    // At exactly +1000 ms the first call has left the half-open window.
    expect(limiter.check(FAKE_EPOCH_MS + 1000).allowed).toBe(true);
  });

  it('reports how long to wait, and the wait is exactly right', () => {
    const { limiter } = subject();
    limiter.take(FAKE_EPOCH_MS);
    limiter.take(FAKE_EPOCH_MS + 400);
    const rejected = limiter.take(FAKE_EPOCH_MS + 600);

    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBe(400);
    expect(limiter.check(FAKE_EPOCH_MS + 600 + rejected.retryAfterMs).allowed).toBe(true);
  });

  it('slides rather than resetting on a fixed boundary', () => {
    const { limiter } = subject();
    // Two calls at the end of one notional second…
    limiter.take(FAKE_EPOCH_MS + 900);
    limiter.take(FAKE_EPOCH_MS + 950);
    // …must not be joined by two more at the start of the next one.
    expect(limiter.take(FAKE_EPOCH_MS + 1010).allowed).toBe(false);
    expect(limiter.take(FAKE_EPOCH_MS + 1901).allowed).toBe(true);
  });

  it('does not consume budget on a dry-run check', () => {
    const { limiter } = subject();
    expect(limiter.check(FAKE_EPOCH_MS).allowed).toBe(true);
    expect(limiter.check(FAKE_EPOCH_MS).allowed).toBe(true);
    expect(limiter.inWindow(FAKE_EPOCH_MS)).toBe(0);
  });

  it('counts a rejected call without letting it extend the block', () => {
    const { limiter } = subject();
    limiter.take(FAKE_EPOCH_MS);
    limiter.take(FAKE_EPOCH_MS + 10);
    limiter.take(FAKE_EPOCH_MS + 20);
    limiter.take(FAKE_EPOCH_MS + 30);

    expect(limiter.metrics()).toMatchObject({ allowed: 2, rejected: 2 });
    expect(limiter.check(FAKE_EPOCH_MS + 1000).allowed).toBe(true);
  });

  it('forgets its history on reset, so a pause does not throttle what follows', () => {
    const { limiter } = subject();
    limiter.take(FAKE_EPOCH_MS);
    limiter.take(FAKE_EPOCH_MS + 1);
    expect(limiter.check(FAKE_EPOCH_MS + 2).allowed).toBe(false);

    limiter.reset();
    expect(limiter.check(FAKE_EPOCH_MS + 2).allowed).toBe(true);
    expect(limiter.metrics().resets).toBe(1);
  });

  it('honours a custom window width', () => {
    const clock = createFakeClock();
    const policy = defineScreenPolicy({ capture: { maxRequestsPerSecond: 1, rateWindowMs: 250 } });
    const limiter = new ObservationRateLimiter({ clock, policy });

    expect(limiter.take(FAKE_EPOCH_MS).allowed).toBe(true);
    expect(limiter.take(FAKE_EPOCH_MS + 249).allowed).toBe(false);
    expect(limiter.take(FAKE_EPOCH_MS + 250).allowed).toBe(true);
  });
});
