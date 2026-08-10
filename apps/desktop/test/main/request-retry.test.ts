import { describe, expect, it } from 'vitest';
import { asSceneId, asWindowId, type SceneState, type SerializedPilotError } from '@pilot/shared';
import { planRetry, retryAfterMsOf, sceneIsUnchanged } from '../../src/main/request-retry.js';

/**
 * When Pilot may retry, and when it must not (PR-040).
 *
 * The interesting half is the refusals. A retry that succeeds is worth very
 * little; a retry that re-sends a picture of a screen the user has already left
 * is worse than the failure it was hiding, so most of this file is about the
 * cases where the right answer is "ask again".
 */

function scene(overrides: Partial<SceneState> = {}): SceneState {
  return {
    sceneId: asSceneId('scene-1'),
    revision: 3,
    windowId: asWindowId('window-42'),
    windowTitle: 'Billing Settings',
    fingerprint: 'fp-1',
    updatedAt: 1_700_000_000_000,
    lastObservedRevision: 3,
    ...overrides,
  };
}

function failure(overrides: Partial<SerializedPilotError> = {}): SerializedPilotError {
  return {
    name: 'PilotError',
    code: 'capture-failed',
    domain: 'observation',
    message: 'the capture stream produced no frame',
    userMessage: 'Pilot could not capture that window.',
    retryable: true,
    ...overrides,
  };
}

describe('the three questions, in order', () => {
  it('retries a transient failure on an unchanged scene', () => {
    const now = scene();

    const plan = planRetry({ attempt: 0, error: failure(), sceneAtRequest: now, sceneNow: now });

    expect(plan).toEqual({ kind: 'retry', attempt: 1, delayMs: 0 });
  });

  it('never retries a failure the taxonomy calls final', () => {
    const now = scene();

    const plan = planRetry({
      attempt: 0,
      error: failure({ code: 'protected-content', retryable: false }),
      sceneAtRequest: now,
      sceneNow: now,
    });

    expect(plan).toEqual({
      kind: 'ask-again',
      reason: 'not-retryable',
      guidance: 'capture-blocked',
    });
  });

  it('stops after one retry rather than looping', () => {
    const now = scene();

    const plan = planRetry({ attempt: 1, error: failure(), sceneAtRequest: now, sceneNow: now });

    expect(plan.kind).toBe('ask-again');
    expect(plan.kind === 'ask-again' ? plan.reason : null).toBe('attempts-exhausted');
  });
});

describe('the screen must still be the screen the request was about', () => {
  it('refuses when the same window has changed underneath', () => {
    const plan = planRetry({
      attempt: 0,
      error: failure(),
      sceneAtRequest: scene({ revision: 3 }),
      sceneNow: scene({ revision: 4 }),
    });

    expect(plan).toEqual({
      kind: 'ask-again',
      reason: 'scene-changed',
      guidance: 'stale-request',
    });
  });

  it('refuses when a different window is being watched', () => {
    const plan = planRetry({
      attempt: 0,
      error: failure(),
      sceneAtRequest: scene(),
      sceneNow: scene({ sceneId: asSceneId('scene-2'), windowId: asWindowId('window-77') }),
    });

    expect(plan.kind === 'ask-again' ? plan.reason : null).toBe('scene-changed');
  });

  it('refuses when there is no longer a scene to compare against', () => {
    const plan = planRetry({
      attempt: 0,
      error: failure(),
      sceneAtRequest: scene(),
      sceneNow: null,
    });

    expect(plan.kind === 'ask-again' ? plan.reason : null).toBe('scene-lost');
  });

  it('compares lineage and revision, and nothing else', () => {
    const before = scene();
    // A newer `updatedAt` and a different observed revision are not changes to
    // what is *on* the screen; the fingerprint is what moves the revision.
    expect(
      sceneIsUnchanged(before, scene({ updatedAt: 1_700_000_009_999, lastObservedRevision: 2 })),
    ).toBe(true);
    expect(sceneIsUnchanged(before, scene({ revision: 4 }))).toBe(false);
    expect(sceneIsUnchanged(null, before)).toBe(false);
  });
});

describe('how long to wait', () => {
  it('honours a refusal that said when to come back', () => {
    const now = scene();

    const plan = planRetry({
      attempt: 0,
      error: failure({ code: 'rate-limited', details: { retryAfterMs: 420 } }),
      sceneAtRequest: now,
      sceneNow: now,
    });

    expect(plan.kind === 'retry' ? plan.delayMs : null).toBe(420);
  });

  it('reads no delay out of an error that named none', () => {
    expect(retryAfterMsOf(failure())).toBe(0);
    expect(retryAfterMsOf(failure({ details: { retryAfterMs: -1 } }))).toBe(0);
    expect(retryAfterMsOf(failure({ details: { retryAfterMs: 'soon' } }))).toBe(0);
  });

  it('never waits less than the floor the caller asked for', () => {
    const now = scene();

    const plan = planRetry({
      attempt: 0,
      error: failure(),
      sceneAtRequest: now,
      sceneNow: now,
      budget: { minDelayMs: 50 },
    });

    expect(plan.kind === 'retry' ? plan.delayMs : null).toBe(50);
  });
});
