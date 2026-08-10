import { PilotError, type InteractionState, type PilotErrorCode } from '@pilot/shared';
import type { InteractionInputType } from './inputs.js';

/**
 * Why the machine refused an input.
 *
 * A refusal is never silent (`docs/implementation.md`, delivery rules: "expose
 * an explicit failure or unavailable state instead of silently doing nothing").
 * Every rejection is returned from `send()`, published on the rejection stream,
 * and surfaced in `PilotViewState.lastError` as a `SerializedPilotError` whose
 * `details.reason` is one of these values.
 */
export const TRANSITION_REJECTION_REASONS = [
  /** The table has no edge for this state and input. */
  'illegal-transition',
  /** The result belongs to an utterance that has been superseded. */
  'stale-utterance',
  /** The event belongs to an agent run that is no longer active. */
  'stale-run',
  /** The event belongs to a speech stream that is no longer active. */
  'stale-speech',
  /** The event belongs to an observation that is no longer awaited. */
  'stale-observation',
  /** The event is about a window that is not the selected one. */
  'stale-window',
  /** A second accepted transcript arrived for the same utterance. */
  'duplicate-transcript',
  /** A required permission is missing. */
  'not-permitted',
  /** Pilot is paused; capture and model calls are suspended. */
  'paused',
  'already-paused',
  'not-paused',
  /** Nothing is running, so there is nothing to interrupt or stop. */
  'nothing-to-interrupt',
  /** No error is showing, so there is nothing to dismiss. */
  'nothing-to-dismiss',
  /** The requested window is not in the known window list. */
  'window-not-found',
  /** Empty text was submitted. */
  'empty-input',
  /** The controller has been disposed. */
  'disposed',
] as const;

export type TransitionRejectionReason = (typeof TRANSITION_REJECTION_REASONS)[number];

const ERROR_CODE_BY_REASON: Readonly<Record<TransitionRejectionReason, PilotErrorCode>> = {
  'illegal-transition': 'invalid-request',
  'stale-utterance': 'cancelled',
  'stale-run': 'cancelled',
  'stale-speech': 'cancelled',
  'stale-observation': 'cancelled',
  'stale-window': 'cancelled',
  'duplicate-transcript': 'cancelled',
  'not-permitted': 'permission-denied',
  paused: 'observation-paused',
  'already-paused': 'invalid-request',
  'not-paused': 'invalid-request',
  'nothing-to-interrupt': 'invalid-request',
  'nothing-to-dismiss': 'invalid-request',
  'window-not-found': 'window-not-found',
  'empty-input': 'invalid-request',
  disposed: 'internal',
};

const USER_MESSAGE_BY_REASON: Readonly<Record<TransitionRejectionReason, string>> = {
  'illegal-transition': 'Pilot cannot do that right now.',
  'stale-utterance': 'That answer was for an earlier question and was discarded.',
  'stale-run': 'That answer was for an earlier question and was discarded.',
  'stale-speech': 'That speech belonged to an earlier answer and was discarded.',
  'stale-observation': 'That screen observation was no longer needed.',
  'stale-window': 'That event was about a window Pilot is not watching.',
  'duplicate-transcript': 'Pilot already has the transcript for that question.',
  'not-permitted': 'Pilot still needs permission before it can do that.',
  paused: 'Pilot is paused. Resume it first.',
  'already-paused': 'Pilot is already paused.',
  'not-paused': 'Pilot is not paused.',
  'nothing-to-interrupt': 'There is nothing to stop right now.',
  'nothing-to-dismiss': 'There is no message to dismiss.',
  'window-not-found': 'That window is no longer available.',
  'empty-input': 'Type a question first.',
  disposed: 'Pilot is shutting down.',
};

/** Rejections that mean "a late or superseded result was discarded". */
export const STALE_REJECTION_REASONS: readonly TransitionRejectionReason[] = [
  'stale-utterance',
  'stale-run',
  'stale-speech',
  'stale-observation',
  'stale-window',
  'duplicate-transcript',
];

export function isStaleRejection(reason: TransitionRejectionReason): boolean {
  return STALE_REJECTION_REASONS.includes(reason);
}

export interface InteractionRejection {
  readonly reason: TransitionRejectionReason;
  readonly from: InteractionState;
  readonly input: InteractionInputType;
  /** Wall-clock reading from the injected clock. */
  readonly at: number;
  readonly error: PilotError;
}

export function rejectionError(
  reason: TransitionRejectionReason,
  from: InteractionState,
  input: InteractionInputType,
): PilotError {
  return new PilotError(
    ERROR_CODE_BY_REASON[reason],
    `Rejected "${input}" in state "${from}": ${reason}`,
    {
      userMessage: USER_MESSAGE_BY_REASON[reason],
      retryable: false,
      details: { reason, from, input },
    },
  );
}
