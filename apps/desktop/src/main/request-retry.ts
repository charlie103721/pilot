import { isSameSceneLineage, type SceneState, type SerializedPilotError } from '@pilot/shared';
import {
  LIFECYCLE_FAILURE_FOR_CODE,
  LIFECYCLE_FAILURES,
  RECOVERY_DETAIL_KEY,
  type LifecycleFailure,
} from '../lifecycle/guidance.js';

/**
 * When Pilot may retry a request, and when it must not (PR-040).
 *
 * `docs/implementation.md`, PR-040 lists "request retry" beside the failure
 * cases, and the trap is stated in the same breath as the task: **a retry that
 * re-sends a screen image the user has moved past is worse than the failure it
 * was hiding.** PR-036 built its replacement records past-tense and
 * scene-stamped for exactly that reason; a retry is the one thing that can put
 * a *current-tense* stale image back in front of the model.
 *
 * So the policy has three questions, in this order, and all three must pass:
 *
 *  1. **Is the failure transient?** `PilotError.retryable` is the taxonomy's own
 *     answer (`@pilot/shared`), and it is the only thing consulted — not the
 *     message, and not the provider. A `protected-content` refusal is not
 *     transient however many times it is asked.
 *  2. **Is the screen still the screen the request was about?** The scene
 *     lineage *and* the revision must both be unchanged. A different lineage is
 *     a different window; a higher revision is the same window after something
 *     on it changed, and PR-016 raises it for geometry, accessibility root and
 *     visual content alike. Either one means the answer would be about the
 *     past.
 *  3. **Is there budget left?** One retry, by default. A second is a loop with
 *     extra steps, and §17 budgets a whole observation at 150 ms of
 *     preprocessing — a retry storm is visible to the user as latency.
 *
 * When any of them fails, the answer is **`ask-again`**: Pilot stops, says what
 * happened and why it did not resend, and leaves the next move to the person
 * who can see the screen. That is a deliberate product decision, not a missing
 * feature, and it is what {@link RetryPlan.reason} records.
 *
 * ## Where the delay comes from
 *
 * Not from a back-off constant invented here. A refusal that carries
 * `details.retryAfterMs` (the §10 rate limiter does) is honoured verbatim,
 * because retrying earlier than that is guaranteed to be refused again — which
 * would burn the attempt budget on an answer Pilot already knows.
 *
 * Pure and synchronous: no clock, no timer, no I/O. The caller waits.
 */

export interface RetryBudget {
  /** Retries allowed after the first failure. Default 1. */
  readonly maxAttempts?: number;
  /** Floor for the wait between attempts, in milliseconds. Default 0. */
  readonly minDelayMs?: number;
}

export interface RetryRequest {
  /** Retries already made for this request. `0` at the first failure. */
  readonly attempt: number;
  readonly error: SerializedPilotError;
  /** Scene in force when the request was issued. `null` when nothing was observed. */
  readonly sceneAtRequest: SceneState | null;
  /** Scene in force now. `null` when Pilot is no longer watching anything. */
  readonly sceneNow: SceneState | null;
  readonly budget?: RetryBudget;
}

export type RetryRefusal =
  /** The taxonomy says trying again cannot help. */
  | 'not-retryable'
  /** The screen has moved on: a retry would answer about the past. */
  | 'scene-changed'
  /** Pilot is no longer watching, so there is nothing to retry against. */
  | 'scene-lost'
  /** The budget is spent. */
  | 'attempts-exhausted';

export type RetryPlan =
  | {
      readonly kind: 'retry';
      /** How long the caller must wait first. Never negative. */
      readonly delayMs: number;
      /** Which attempt this will be, 1-based. */
      readonly attempt: number;
    }
  | {
      readonly kind: 'ask-again';
      readonly reason: RetryRefusal;
      /** What the user should be told, as a {@link LifecycleFailure} kind. */
      readonly guidance: LifecycleFailure;
    };

export const DEFAULT_RETRY_BUDGET: Required<RetryBudget> = { maxAttempts: 1, minDelayMs: 0 };

/** `details.retryAfterMs` when the refusal carried one. */
export function retryAfterMsOf(error: SerializedPilotError): number {
  const value = error.details?.['retryAfterMs'];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

/**
 * True when the screen the request was about is still the screen on show.
 *
 * Exported because it is the whole of the interesting half: the lineage check
 * catches a different window, the revision check catches the same window after
 * it changed, and a request made with no scene at all can never be replayed
 * safely because there is nothing to compare.
 */
export function sceneIsUnchanged(before: SceneState | null, now: SceneState | null): boolean {
  if (before === null || now === null) {
    return false;
  }
  return isSameSceneLineage(before, now) && before.revision === now.revision;
}

export function planRetry(request: RetryRequest): RetryPlan {
  const budget = { ...DEFAULT_RETRY_BUDGET, ...(request.budget ?? {}) };
  if (!request.error.retryable) {
    return { kind: 'ask-again', reason: 'not-retryable', guidance: guidanceFor(request.error) };
  }
  if (request.attempt >= budget.maxAttempts) {
    return {
      kind: 'ask-again',
      reason: 'attempts-exhausted',
      guidance: guidanceFor(request.error),
    };
  }
  if (request.sceneAtRequest === null || request.sceneNow === null) {
    return { kind: 'ask-again', reason: 'scene-lost', guidance: 'stale-request' };
  }
  if (!sceneIsUnchanged(request.sceneAtRequest, request.sceneNow)) {
    // The one refusal that is not about the failure at all. Retrying here would
    // succeed, and that is exactly the problem: the answer would be about a
    // screen the user has already left.
    return { kind: 'ask-again', reason: 'scene-changed', guidance: 'stale-request' };
  }
  return {
    kind: 'retry',
    attempt: request.attempt + 1,
    delayMs: Math.max(budget.minDelayMs, retryAfterMsOf(request.error)),
  };
}

/**
 * Which guidance kind a refusal-to-retry should be explained with.
 *
 * Deliberately *not* a second taxonomy: it defers to the error's own explicit
 * `details.recovery` when there is one and to `LIFECYCLE_FAILURE_FOR_CODE`
 * otherwise, which is the same total mapping `readLifecycleGuidance` uses. The
 * one thing decided here is the scene case above, which no error code can
 * express.
 */
function guidanceFor(error: SerializedPilotError): LifecycleFailure {
  const named = error.details?.[RECOVERY_DETAIL_KEY];
  if (typeof named === 'string' && (LIFECYCLE_FAILURES as readonly string[]).includes(named)) {
    return named as LifecycleFailure;
  }
  return LIFECYCLE_FAILURE_FOR_CODE[error.code] ?? 'request-refused';
}
