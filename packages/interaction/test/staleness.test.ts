import { describe, expect, it } from 'vitest';
import { asObservationId, asRunId, asSpeechId, asUtteranceId, asWindowId } from '@pilot/shared';
import { STALE_REJECTION_REASONS, isStaleRejection } from '@pilot/interaction';
import type { TransitionOutcome } from '@pilot/interaction';
import { SAMPLE_ERROR, TEST_RUN_ID, TEST_TOOL_CALL_ID, WINDOW, driveTo } from './support.js';

function rejection(outcome: TransitionOutcome): string {
  if (outcome.kind !== 'rejected') {
    throw new Error(`expected a rejection, got a transition to "${outcome.to}"`);
  }
  return outcome.rejection.reason;
}

/**
 * system-design §15: "Every utterance, observation request, and TTS stream has
 * an ID … Results from stale window selections, scene IDs, or utterance IDs are
 * discarded." These tests prove the discard, not just the intent.
 */
describe('utterance identity', () => {
  it('rejects a transcript for an utterance that a new push-to-talk superseded', () => {
    const harness = driveTo('transcribing');
    const firstUtterance = harness.machine.context.activeUtteranceId!;

    // The user gives up waiting and presses push-to-talk again.
    const restarted = harness.machine.send({ type: 'push-to-talk-down' });
    expect(restarted.kind).toBe('accepted');
    const secondUtterance = harness.machine.context.activeUtteranceId!;
    expect(secondUtterance).not.toBe(firstUtterance);

    // The first recogniser finally answers. It must not become a question.
    const late = harness.machine.send({
      type: 'transcript-final',
      utteranceId: firstUtterance,
      text: 'the abandoned question',
    });
    expect(rejection(late)).toBe('stale-utterance');
    expect(harness.machine.state).toBe('listening');
    expect(harness.machine.viewState.transcript).toEqual([]);
  });

  it('rejects a duplicate accepted transcript for the same utterance', () => {
    const harness = driveTo('transcribing');
    const utteranceId = harness.machine.context.activeUtteranceId!;
    expect(
      harness.machine.send({ type: 'transcript-final', utteranceId, text: 'What is this?' }).kind,
    ).toBe('accepted');

    const duplicate = harness.machine.send({
      type: 'transcript-final',
      utteranceId,
      text: 'What is this?',
    });
    expect(rejection(duplicate)).toBe('duplicate-transcript');
    expect(harness.machine.viewState.transcript).toHaveLength(1);
  });

  it('rejects partials for an utterance that is not the active one', () => {
    const harness = driveTo('listening');
    const outcome = harness.machine.send({
      type: 'transcript-partial',
      utteranceId: asUtteranceId('utt-somebody-else'),
      text: 'noise',
    });
    expect(rejection(outcome)).toBe('stale-utterance');
    expect(harness.machine.viewState.liveTranscript).toBe('');
  });

  it('rejects a run that claims to belong to a superseded utterance', () => {
    const harness = driveTo('thinking');
    const outcome = harness.machine.send({
      type: 'run-started',
      utteranceId: asUtteranceId('utt-somebody-else'),
      runId: asRunId('run-other'),
    });
    expect(rejection(outcome)).toBe('stale-utterance');
  });
});

describe('interruption discards the old run', () => {
  it('a new push-to-talk stops speech, aborts the run and starts a new utterance', () => {
    const harness = driveTo('speaking');
    const oldUtterance = harness.machine.context.activeUtteranceId!;
    const oldSpeech = harness.machine.context.activeSpeechId!;
    const spokenSoFar = harness.machine.viewState.transcript.length;

    const outcome = harness.machine.send({ type: 'push-to-talk-down' });
    expect(outcome.kind).toBe('accepted');
    if (outcome.kind !== 'accepted') {
      return;
    }
    expect(outcome.to).toBe('listening');
    expect(outcome.effects.map((effect) => effect.type)).toEqual([
      'stop-speech',
      'interrupt-run',
      'start-listening',
    ]);
    expect(harness.machine.context.activeUtteranceId).not.toBe(oldUtterance);
    expect(harness.machine.context.activeRunId).toBeNull();
    expect(harness.machine.context.activeSpeechId).toBeNull();

    // Everything the old run still has to say is now stale.
    expect(
      rejection(
        harness.machine.send({ type: 'run-text-delta', runId: TEST_RUN_ID, text: ' and also…' }),
      ),
    ).toBe('stale-run');
    expect(
      rejection(harness.machine.send({ type: 'run-completed', runId: TEST_RUN_ID, text: 'late' })),
    ).toBe('stale-run');
    expect(
      rejection(harness.machine.send({ type: 'run-aborted', runId: TEST_RUN_ID, reason: 'late' })),
    ).toBe('stale-run');
    expect(
      rejection(
        harness.machine.send({ type: 'run-failed', runId: TEST_RUN_ID, error: SAMPLE_ERROR }),
      ),
    ).toBe('stale-run');
    expect(
      rejection(
        harness.machine.send({
          type: 'tool-started',
          runId: TEST_RUN_ID,
          toolCallId: TEST_TOOL_CALL_ID,
          toolName: 'observe_screen',
        }),
      ),
    ).toBe('stale-run');

    // Speech events from the stopped stream cannot resurrect the speaking state.
    expect(rejection(harness.machine.send({ type: 'speech-finished', speechId: oldSpeech }))).toBe(
      'stale-speech',
    );
    expect(rejection(harness.machine.send({ type: 'speech-started', speechId: oldSpeech }))).toBe(
      'stale-speech',
    );

    expect(harness.machine.state).toBe('listening');
    expect(harness.machine.viewState.speaking).toBe(false);
    expect(harness.machine.viewState.transcript).toHaveLength(spokenSoFar);
  });

  it('a typed question interrupts the same way a spoken one does', () => {
    const harness = driveTo('speaking');
    const outcome = harness.machine.send({
      type: 'submit-text',
      text: 'never mind, what is this?',
    });
    expect(outcome.kind).toBe('accepted');
    if (outcome.kind !== 'accepted') {
      return;
    }
    expect(outcome.to).toBe('thinking');
    expect(outcome.effects.map((effect) => effect.type)).toEqual([
      'stop-speech',
      'interrupt-run',
      'submit-question',
    ]);
    expect(
      rejection(harness.machine.send({ type: 'run-completed', runId: TEST_RUN_ID, text: 'late' })),
    ).toBe('stale-run');
  });
});

describe('other identity guards', () => {
  it('rejects events about a window Pilot is not watching', () => {
    const harness = driveTo('observing');
    expect(
      rejection(
        harness.machine.send({ type: 'window-closed', windowId: asWindowId('window-other') }),
      ),
    ).toBe('stale-window');
    expect(harness.machine.state).toBe('observing');
    expect(harness.machine.send({ type: 'window-closed', windowId: WINDOW.windowId }).kind).toBe(
      'accepted',
    );
  });

  it('rejects the completion of an observation it is no longer waiting for', () => {
    const harness = driveTo('observing');
    const started = harness.machine.send({ type: 'look-now' });
    expect(started.kind).toBe('accepted');
    const observationId = harness.machine.context.activeObservationId!;

    expect(
      rejection(
        harness.machine.send({
          type: 'observation-finished',
          observationId: asObservationId('obs-somebody-else'),
        }),
      ),
    ).toBe('stale-observation');
    expect(harness.machine.state).toBe('observing-screen');
    expect(harness.machine.send({ type: 'observation-finished', observationId }).kind).toBe(
      'accepted',
    );
    expect(harness.machine.state).toBe('observing');
  });

  it('rejects speech events for a stream that is not the active one', () => {
    const harness = driveTo('speaking');
    expect(
      rejection(
        harness.machine.send({ type: 'speech-stopped', speechId: asSpeechId('speech-old') }),
      ),
    ).toBe('stale-speech');
    expect(harness.machine.state).toBe('speaking');
  });
});

describe('rejection reporting', () => {
  it('surfaces refused commands in the view state but keeps discards internal', () => {
    const harness = driveTo('observing');

    // A discarded late result is hygiene, not something to show the user.
    harness.machine.send({
      type: 'speech-finished',
      speechId: asSpeechId('speech-from-a-past-life'),
    });
    expect(harness.machine.viewState.lastError).toBeNull();

    // A refused command is something the user did and must be told about.
    harness.machine.send({ type: 'push-to-talk-up' });
    expect(harness.machine.viewState.lastError?.details).toMatchObject({
      reason: 'illegal-transition',
      from: 'observing',
      input: 'push-to-talk-up',
    });

    expect(harness.machine.send({ type: 'dismiss-error' }).kind).toBe('accepted');
    expect(harness.machine.viewState.lastError).toBeNull();
  });

  it('classifies exactly the identity reasons as stale', () => {
    expect([...STALE_REJECTION_REASONS].sort()).toEqual([
      'duplicate-transcript',
      'stale-observation',
      'stale-phrase-timeout',
      'stale-run',
      'stale-speech',
      'stale-utterance',
      'stale-window',
    ]);
    expect(isStaleRejection('illegal-transition')).toBe(false);
  });
});
