import { PilotError, toPilotError, type ObserveScreenRequest } from '@pilot/shared';
import {
  describeObserveScreenFailure,
  failureForErrorCode,
  type OBSERVE_SCREEN_TOOL_NAME,
} from '@pilot/agent';
import { OBSERVATION_FAILURE_TOOL } from '../observation/failure-view.js';

/**
 * Gives a "Look now" refusal the same shape the `observe_screen` tool gives a
 * model-requested one (PR-030).
 *
 * PR-021 owns the taxonomy: eleven coarse {@link failureForErrorCode} kinds,
 * each with one sentence for the user and a `retryable` flag
 * ({@link describeObserveScreenFailure}). The tool already attaches all of it.
 * The manual observation did not: it threw whatever `PilotScreenContextService`
 * threw, and `PilotError.userMessage` **defaults to the technical message**, so
 * an adapter failure reached the panel as, say, "helper exited during
 * capture.pull" — a sentence written for a log, shown to a person.
 *
 * The rule this file applies, in order:
 *
 *  1. An error that already carries the tool's marker is returned untouched.
 *     The model path is PR-021's and this must not rewrite it.
 *  2. Otherwise the PR-021 kind is derived from the `PilotErrorCode`, and
 *     `failure`/`retryable` come from it — one taxonomy, whoever looked.
 *  3. **A curated `userMessage` survives.** `@pilot/observation`'s §10 rule
 *     table (`POLICY_RULE_TABLE`) says more than the coarse kind can: PR-021
 *     renders `protected-content` as "This application blocks screen capture",
 *     while the rule that actually fired may have been
 *     `unmaskable-secure-region` — "Pilot cannot hide a password field it
 *     cannot locate, so it will not send this". Replacing the second with the
 *     first would be a coarser *and less true* sentence. So the curated one is
 *     kept and PR-021's is the fallback for errors that have none, which is
 *     exactly the raw-adapter case above.
 *
 * `details` is rebuilt rather than spread: it is persisted and shipped to the
 * renderer, so only fields known to be content-free are copied over —
 * `policyRule` and `policyStep` are closed vocabularies from PR-017's table.
 */

/**
 * Compile-time drift guard between the renderer-safe constant and PR-021's.
 * If the tool is ever renamed, this line fails `pnpm typecheck`.
 */
const TOOL_NAMES_AGREE: typeof OBSERVE_SCREEN_TOOL_NAME = OBSERVATION_FAILURE_TOOL;

export function toObservationFailureError(
  cause: unknown,
  request: ObserveScreenRequest,
): PilotError {
  // `capture-failed` rather than `internal`: something that escapes the facade
  // during an observation failed to capture, and PR-021 maps it to a
  // retry-once `blank-capture` instead of a dead end.
  const error = toPilotError(cause, 'capture-failed');
  const existing = error.details;
  if (existing !== undefined && existing['tool'] === TOOL_NAMES_AGREE) {
    return error;
  }

  const failure = failureForErrorCode(error.code);
  const shape = describeObserveScreenFailure(failure);
  const policyRule = existing?.['policyRule'];
  const policyStep = existing?.['policyStep'];

  return new PilotError(error.code, error.message, {
    // Rule 3: a message the producer wrote for a person beats a generic one.
    userMessage: error.userMessage === error.message ? shape.userMessage : error.userMessage,
    retryable: shape.retryable,
    details: {
      tool: TOOL_NAMES_AGREE,
      failure,
      view: request.view,
      moment: request.moment,
      ...(typeof policyRule === 'string' ? { policyRule } : {}),
      ...(typeof policyStep === 'string' ? { policyStep } : {}),
    },
    cause: error,
  });
}
