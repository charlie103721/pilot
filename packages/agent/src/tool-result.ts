import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { PilotError, type SerializedPilotError } from '@pilot/shared';

/**
 * Typed tool *results* for failure, and the plumbing that makes Pi treat them
 * as failures.
 *
 * WHY THIS EXISTS
 * ---------------
 * Pi's documented tool contract is "throw on failure instead of encoding errors
 * in `content`" (`AgentTool.execute` doc comment). Its loop then calls
 * `createErrorToolResult(err.message)`, which is literally
 * `{ content: [{ type: "text", text: message }], details: {} }`
 * (`pi-agent-core/dist/agent-loop.js`). Two consequences, both verified by
 * reading that file:
 *
 *  1. **`details` is destroyed.** Everything structured about the failure — the
 *     `PilotError` code, whether it is retryable, what the user should do — is
 *     flattened into one English sentence. `packages/agent/src/session.ts` then
 *     has nothing to build a typed `tool-failed` event from, and PR-010's UI
 *     cannot tell "permission denied" from "window closed".
 *  2. **The model's view is a bare `Error.message`.** PR-021 needs the model to
 *     be able to *reason* about the failure (retry? ask the user to re-select a
 *     window? answer without looking?), which needs more than one sentence.
 *
 * So Pilot tools return a normal result whose `details` carries a serialized
 * {@link PilotError}, and the session installs {@link markFailedToolResults} as
 * Pi's `afterToolCall` hook. That hook runs on *both* the success and the throw
 * path (`finalizeExecutedToolCall`), and `AfterToolCallResult.isError` replaces
 * the loop's flag — so the tool-result message, the `tool_execution_end` event
 * and the model all agree that the call failed, while `details` survives.
 *
 * Nothing here is `observe_screen`-specific: any Pilot tool can use it.
 */

/** Marker value on `details.outcome` for a failed tool result. */
export const TOOL_OUTCOME_FAILED = 'failed';

/**
 * The shape every failing Pilot tool result carries on `details`.
 *
 * `details` is persisted on the tool-result message, so it must never contain
 * image bytes, audio, credentials or verbatim screen text.
 */
export interface FailedToolDetails {
  readonly outcome: typeof TOOL_OUTCOME_FAILED;
  /** Stable, tool-specific failure kind. Narrower than the `PilotError` code. */
  readonly failure: string;
  readonly error: SerializedPilotError;
}

export function isFailedToolDetails(details: unknown): details is FailedToolDetails {
  if (typeof details !== 'object' || details === null) {
    return false;
  }
  const candidate = details as { outcome?: unknown; error?: unknown };
  return (
    candidate.outcome === TOOL_OUTCOME_FAILED &&
    typeof candidate.error === 'object' &&
    candidate.error !== null
  );
}

/** Reads the serialized error off a failed tool result's details, if any. */
export function readToolFailure(details: unknown): SerializedPilotError | undefined {
  return isFailedToolDetails(details) ? details.error : undefined;
}

/**
 * Pi `afterToolCall` hook: flips `isError` for results that declare failure in
 * `details`, and leaves everything else untouched.
 *
 * Returning `undefined` for successes matters — `finalizeExecutedToolCall`
 * merges field-by-field with `??`, so returning a partial object would be
 * harmless but noisy. Returning nothing is the documented no-op.
 */
export function markFailedToolResults(context: {
  readonly result: AgentToolResult<unknown>;
  readonly isError: boolean;
}): { readonly isError: true } | undefined {
  if (context.isError) {
    return undefined;
  }
  return isFailedToolDetails(context.result.details) ? { isError: true } : undefined;
}

/**
 * The exact text Pi's loop produces when the agent's abort signal is already
 * set at the moment a tool call is prepared (`prepareToolCall` in
 * `pi-agent-core/dist/agent-loop.js` — three separate `signal?.aborted` guards,
 * all returning `createErrorToolResult("Operation aborted")`).
 *
 * VERIFIED CONSEQUENCE, found by test, not by reading: when a run is aborted
 * between `tool_execution_start` and the tool actually running, **the tool never
 * executes**. `observe_screen` cannot report the cancellation itself, because it
 * was never called, and the result Pi synthesises carries `details: {}`. Without
 * this mapping the UI would show a screen-capture failure for what is plainly a
 * user cancellation.
 */
export const PI_ABORTED_TOOL_TEXT = 'Operation aborted';

/**
 * Rebuilds a `PilotError` from a tool result's details, falling back to the
 * loop's flattened text when a tool threw — or was never run at all.
 */
export function toolFailureError(details: unknown, fallbackText: string): PilotError {
  const serialized = readToolFailure(details);
  if (serialized === undefined) {
    if (fallbackText === PI_ABORTED_TOOL_TEXT) {
      return new PilotError('cancelled', fallbackText, {
        userMessage: 'The request was cancelled.',
        retryable: false,
      });
    }
    return new PilotError('capture-failed', fallbackText);
  }
  return new PilotError(serialized.code, serialized.message, {
    userMessage: serialized.userMessage,
    retryable: serialized.retryable,
    ...(serialized.details === undefined ? {} : { details: serialized.details }),
  });
}
