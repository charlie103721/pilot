import { describe, expect, it } from 'vitest';
import { PILOT_ERROR_CODES, PilotError, type SerializedPilotError } from '@pilot/shared';
import {
  LIFECYCLE_FAILURES,
  LIFECYCLE_FAILURE_FOR_CODE,
  LIFECYCLE_GUIDANCE,
  lifecycleError,
  readLifecycleGuidance,
  withLifecycleGuidance,
} from '../../src/lifecycle/guidance.js';

/**
 * Typed user guidance (PR-040).
 *
 * The property under test is **totality**: every failure that can reach the
 * panel has a sentence saying what happened, a sentence saying what to do, and
 * one of exactly two endings. A code with no answer is the defect this module
 * exists to prevent, and the type system catches most of it — these catch the
 * rest, including "the table says something, but not something useful".
 */

function serialize(error: PilotError): SerializedPilotError {
  return error.toJSON();
}

describe('the taxonomy is total', () => {
  it('answers for every PilotErrorCode, with both sentences', () => {
    for (const code of PILOT_ERROR_CODES) {
      const guidance = readLifecycleGuidance(serialize(new PilotError(code, `${code} happened`)));
      expect(guidance, code).not.toBeNull();
      expect(guidance?.remedy.length, code).toBeGreaterThan(20);
      expect(guidance?.userMessage.length, code).toBeGreaterThan(10);
      expect(['recovered', 'safe-terminal'], code).toContain(guidance?.disposition);
    }
  });

  it('maps every code onto a declared kind', () => {
    for (const code of PILOT_ERROR_CODES) {
      expect(LIFECYCLE_FAILURES, code).toContain(LIFECYCLE_FAILURE_FOR_CODE[code]);
    }
  });

  it('gives every kind a remedy that says more than "try again"', () => {
    for (const failure of LIFECYCLE_FAILURES) {
      const guidance = LIFECYCLE_GUIDANCE[failure];
      expect(guidance.failure).toBe(failure);
      expect(guidance.remedy.toLowerCase(), failure).not.toBe('try again.');
      expect(guidance.remedy.length, failure).toBeGreaterThan(20);
    }
  });

  it('is null only for no error at all', () => {
    expect(readLifecycleGuidance(null)).toBeNull();
  });
});

describe('whose words the user reads', () => {
  it('keeps a message the producer wrote for a person', () => {
    const error = serialize(
      new PilotError('protected-content', 'stream state = protected', {
        userMessage: 'This application does not allow Pilot to see its window.',
      }),
    );

    const guidance = readLifecycleGuidance(error);

    expect(guidance?.userMessage).toBe('This application does not allow Pilot to see its window.');
    expect(guidance?.failure).toBe('capture-blocked');
  });

  it('replaces a message that was only ever a log line', () => {
    // `PilotError.userMessage` defaults to `message`, which is how an adapter's
    // technical sentence reached the panel before PR-030 and PR-040.
    const error = serialize(new PilotError('helper-unavailable', 'helper exited during pull'));

    const guidance = readLifecycleGuidance(error);

    expect(guidance?.userMessage).not.toContain('exited during pull');
    expect(guidance?.userMessage).toBe(LIFECYCLE_GUIDANCE['helper-unavailable'].userMessage);
  });
});

describe('the producer can name the ending the code cannot', () => {
  it('prefers an explicit kind over the code mapping', () => {
    // Same code, two endings: a helper the supervisor will restart, and one it
    // has given up on. Only the supervisor knows which.
    const restarted = withLifecycleGuidance(
      serialize(new PilotError('helper-unavailable', 'exit 9')),
      'helper-restarted',
    );
    const gone = withLifecycleGuidance(
      serialize(new PilotError('helper-unavailable', 'exit 9')),
      'helper-unavailable',
    );

    expect(readLifecycleGuidance(restarted)?.disposition).toBe('recovered');
    expect(readLifecycleGuidance(restarted)?.explicit).toBe(true);
    expect(readLifecycleGuidance(gone)?.disposition).toBe('safe-terminal');
  });

  it('ignores a `recovery` detail that names nothing', () => {
    const error = serialize(
      new PilotError('timeout', 'gone', { details: { recovery: 'not-a-kind' } }),
    );

    const guidance = readLifecycleGuidance(error);

    expect(guidance?.explicit).toBe(false);
    expect(guidance?.failure).toBe(LIFECYCLE_FAILURE_FOR_CODE.timeout);
  });
});

describe('lifecycleError', () => {
  it('carries its kind and disposition across serialisation', () => {
    const error = lifecycleError('capture-blocked', { details: { cause: 'capture-stopped' } });

    const guidance = readLifecycleGuidance(error.toJSON());

    expect(error.code).toBe('protected-content');
    expect(error.details?.['cause']).toBe('capture-stopped');
    expect(guidance?.failure).toBe('capture-blocked');
    expect(guidance?.disposition).toBe('safe-terminal');
  });

  it('marks a recovered failure as nothing to retry', () => {
    // `recovered` means Pilot already carried on; there is nothing left for a
    // caller to try again, and `retryable` is what a caller reads.
    expect(lifecycleError('helper-restarted').retryable).toBe(false);
    expect(lifecycleError('capture-blocked').retryable).toBe(true);
  });
});
