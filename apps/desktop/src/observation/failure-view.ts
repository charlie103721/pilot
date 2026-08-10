import type { PilotErrorCode, SerializedPilotError } from '@pilot/shared';

/**
 * Reads an observation refusal off a `SerializedPilotError` (PR-030).
 *
 * Two different things can fail while Pilot is looking at the screen, and until
 * this file existed they reached the panel as two unrelated shapes:
 *
 *  - the **model** called `observe_screen` and the tool refused. PR-021 already
 *    builds that error, with a `userMessage` from
 *    `describeObserveScreenFailure` and `details.failure` naming the kind;
 *  - the **user** pressed "Look now" and `PilotScreenContextService` refused.
 *    That error came straight off the §10 policy — sometimes with a good
 *    sentence of its own, sometimes with nothing but an adapter's technical
 *    message as its `userMessage`, because `PilotError.userMessage` defaults to
 *    `message`.
 *
 * `main/observation-failure.ts` puts both into the same shape at the point the
 * refusal is produced, and this file is the reader. **It deliberately does not
 * import `@pilot/agent`**: this module is bundled into the Chromium renderer
 * (`src/observation/**` is checked under both the Node and the DOM lib), and
 * `@pilot/agent` pulls Pi in with it. `docs/handoff.md` §4: "no Pi type reaches
 * Chromium, and it must stay that way". So the *mapping* happens in the main
 * process and only its result crosses the IPC boundary, as data on
 * `details` that `serializedPilotErrorSchema` already validates — no contract
 * change was needed to carry it.
 */

/**
 * The tool name both halves agree on.
 *
 * Declared here, in the renderer-safe file, and checked against
 * `OBSERVE_SCREEN_TOOL_NAME` at compile time in `main/observation-failure.ts`,
 * so there is one definition and a build failure if it ever drifts.
 */
export const OBSERVATION_FAILURE_TOOL = 'observe_screen';

export interface ObservationFailureView {
  /** PR-021's coarse failure kind, e.g. `permission-denied`, `window-lost`. */
  readonly failure: string;
  readonly code: PilotErrorCode;
  /** The only string safe to render. Never the technical message. */
  readonly userMessage: string;
  readonly retryable: boolean;
  /** Whether looking again could help, in one sentence. */
  readonly hint: string;
  /** The §10 policy rule that refused, when a policy rule is what refused. */
  readonly policyRule: string | null;
}

export const OBSERVATION_FAILURE_HINTS = {
  retryable: 'Pilot can look again — ask, or press Look now.',
  final: 'Looking again will not help until this is fixed.',
} as const;

function readString(details: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = details[key];
  return typeof value === 'string' ? value : null;
}

/**
 * The observation refusal behind an error, or `null` when the error is not one.
 *
 * The test is `details.tool === 'observe_screen'` and nothing else. An error
 * code alone would not do: `internal` and `timeout` are produced by everything
 * in the app, and reading "Pilot could not look at your screen right now" onto a
 * failed model run would be a confident lie about which subsystem broke.
 */
export function readObservationFailure(
  error: SerializedPilotError | null,
): ObservationFailureView | null {
  if (error === null || error.details === undefined) {
    return null;
  }
  const details = error.details;
  if (readString(details, 'tool') !== OBSERVATION_FAILURE_TOOL) {
    return null;
  }
  const failure = readString(details, 'failure');
  if (failure === null) {
    return null;
  }
  return {
    failure,
    code: error.code,
    userMessage: error.userMessage,
    retryable: error.retryable,
    hint: error.retryable ? OBSERVATION_FAILURE_HINTS.retryable : OBSERVATION_FAILURE_HINTS.final,
    policyRule: readString(details, 'policyRule'),
  };
}
