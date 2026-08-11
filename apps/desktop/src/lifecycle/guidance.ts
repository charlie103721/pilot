import {
  PILOT_ERROR_CODES,
  PilotError,
  type PilotErrorCode,
  type SerializedPilotError,
} from '@pilot/shared';

/**
 * Typed user guidance for every failure Pilot can end a turn in (PR-040).
 *
 * `docs/implementation.md`, PR-040: "…and typed user guidance". The rule this
 * module exists to enforce is one sentence long: **every failure the user can
 * see ends in one of exactly two places, and says which.** Pilot either
 * recovered and kept working, or it stopped in a state that is safe, visible
 * and explained. A failure that silently degrades is a defect (runbook
 * cross-lane issue 19 is one), and a failure explained with an adapter's log
 * line is the defect PR-030 fixed for observation refusals — this is the same
 * fix for everything else.
 *
 * ## Three fields, and why each one is separate
 *
 *  - `userMessage` — **what happened**, in the words of whoever knew. It comes
 *    off the error, never from this table: `PilotError.userMessage` is the only
 *    field safe to render (`@pilot/shared`), and a producer that wrote a
 *    specific sentence knows more than a taxonomy can (PR-030's rule 3).
 *  - `remedy` — **what to do about it**, from this table. It is the half no
 *    error carries today, and the half a user actually needs.
 *  - `disposition` — **which of the two endings this is**, as data rather than
 *    prose, so a test and a demo can assert it and the panel can render "Pilot
 *    carried on" differently from "Pilot stopped".
 *
 * ## Total by construction
 *
 * {@link LIFECYCLE_FAILURE_FOR_CODE} maps **every** `PilotErrorCode` onto a
 * kind, so {@link readLifecycleGuidance} answers for any error that reaches the
 * panel, including one raised by code that has never heard of this module. An
 * explicit `details.recovery` (written by `main/lifecycle-runtime.ts`) overrides
 * the mapping when the producer knows better — for instance, `helper-unavailable`
 * means "restarted, carry on" while the supervisor still has restart budget and
 * "stopped, quit and reopen" once it does not, and only the supervisor knows
 * which.
 *
 * ## Renderer-safe, deliberately
 *
 * This module is bundled into Chromium (`src/conversation/view-model.ts` reads
 * it, `ConversationPanel.tsx` renders it), so it imports `@pilot/shared` and
 * nothing else — the same rule `src/observation/failure-view.ts` states for
 * itself. No Pi type, no platform adapter, no Electron.
 */

/** Which of the two endings a failure produced. There is no third. */
export type RecoveryDisposition =
  /** Pilot kept working, possibly with less: the user need do nothing. */
  | 'recovered'
  /** Pilot stopped, on purpose, in a state that is visible and explained. */
  | 'safe-terminal';

export const LIFECYCLE_FAILURES = [
  'screen-permission-revoked',
  'accessibility-revoked',
  'screen-locked',
  'session-ended',
  'window-closed',
  'capture-blocked',
  'capture-interrupted',
  'capture-unavailable',
  'stale-request',
  'helper-restarted',
  'helper-unavailable',
  'provider-authentication',
  'provider-unreachable',
  'request-refused',
  'speech-input-failed',
  'speech-output-failed',
  'conversation-not-saved',
  'unexpected',
] as const;

export type LifecycleFailure = (typeof LIFECYCLE_FAILURES)[number];

export interface LifecycleGuidance {
  readonly failure: LifecycleFailure;
  readonly disposition: RecoveryDisposition;
  /**
   * What to do about it. One sentence, addressed to the person using Pilot,
   * and never "try again" on its own — a remedy that does not say what changed
   * is the generic string this module exists to replace.
   */
  readonly remedy: string;
  /**
   * Fallback for {@link LifecycleGuidanceView.userMessage} when the error
   * carries none of its own — that is, when `userMessage` is still the
   * technical `message`, which is what `PilotError` defaults it to.
   */
  readonly userMessage: string;
}

/**
 * The whole taxonomy, in one table.
 *
 * Every row is a §16 row or a lifecycle condition from system-design §6, and
 * the `disposition` column is the answer to "recovery or safe terminal state
 * for every case".
 */
export const LIFECYCLE_GUIDANCE: Readonly<Record<LifecycleFailure, LifecycleGuidance>> = {
  'screen-permission-revoked': {
    failure: 'screen-permission-revoked',
    disposition: 'safe-terminal',
    userMessage: 'Screen Recording is no longer allowed, so Pilot stopped watching.',
    remedy:
      'Allow Screen Recording for Pilot in System Settings — Pilot starts watching again by itself once you do. Everything it had buffered was cleared.',
  },
  // §16's degraded row, and the only `recovered` in this table that costs the
  // user something (PR-044). Pilot keeps watching and keeps answering; what it
  // loses is the ability to name the control under the pointer, so the message
  // says what is now less reliable rather than announcing a stop that did not
  // happen. `recovered` is "Pilot kept working, possibly with less" — this is
  // the case that phrase was written for.
  'accessibility-revoked': {
    failure: 'accessibility-revoked',
    disposition: 'recovered',
    userMessage:
      'Accessibility is no longer allowed. Pilot is still watching and will still answer, but it now works out what you are pointing at from the picture alone.',
    remedy:
      'Allow Accessibility for Pilot in System Settings to get precise answers back — no restart needed. Your conversation is kept either way.',
  },
  'screen-locked': {
    failure: 'screen-locked',
    disposition: 'recovered',
    userMessage: 'The screen locked, so Pilot stopped watching and cleared what it had.',
    remedy: 'Nothing to do — Pilot starts watching the same window again when you unlock.',
  },
  'session-ended': {
    failure: 'session-ended',
    disposition: 'safe-terminal',
    userMessage: 'Pilot stopped watching because the session ended.',
    remedy: 'Nothing to do — every frame, pointer sample and scene was cleared as Pilot stopped.',
  },
  'window-closed': {
    failure: 'window-closed',
    disposition: 'safe-terminal',
    userMessage: 'The window Pilot was watching closed.',
    remedy: 'Choose another window in the panel. What Pilot had buffered of the old one is gone.',
  },
  'capture-blocked': {
    failure: 'capture-blocked',
    disposition: 'safe-terminal',
    userMessage: 'This application does not allow Pilot to see its window.',
    remedy:
      'Ask about a different window — Pilot will not show you a black rectangle and call it your screen.',
  },
  'capture-interrupted': {
    failure: 'capture-interrupted',
    disposition: 'safe-terminal',
    userMessage: 'Pilot could not get a picture of that window just then.',
    remedy:
      'Ask again, and Pilot will look again when you do. It answers about what is on screen when you ask, never about a picture you have moved past.',
  },
  'stale-request': {
    failure: 'stale-request',
    disposition: 'safe-terminal',
    userMessage: 'Pilot did not try that again, because the screen changed after you asked.',
    remedy:
      'Ask again. Retrying by itself would have answered about the screen you were on a moment ago, which is worse than saying nothing.',
  },
  'capture-unavailable': {
    failure: 'capture-unavailable',
    disposition: 'safe-terminal',
    userMessage: 'Pilot cannot capture that window.',
    remedy: 'Choose another window, or reopen the one you want and select it again.',
  },
  'helper-restarted': {
    failure: 'helper-restarted',
    disposition: 'recovered',
    userMessage: 'Pilot’s macOS helper stopped unexpectedly and was restarted.',
    remedy:
      'Nothing to do — Pilot reconnected and is watching again. Anything it was doing at that moment was abandoned, so ask again if you were mid-question.',
  },
  'helper-unavailable': {
    failure: 'helper-unavailable',
    disposition: 'safe-terminal',
    userMessage: 'Pilot cannot reach its macOS helper, so it cannot see the screen.',
    remedy: 'Quit Pilot and open it again. Typing still works; looking at the screen does not.',
  },
  'provider-authentication': {
    failure: 'provider-authentication',
    disposition: 'safe-terminal',
    userMessage: 'Pilot is signed out of the model provider.',
    remedy: 'Sign in again — your conversation is kept, and nothing was sent while signed out.',
  },
  'provider-unreachable': {
    failure: 'provider-unreachable',
    disposition: 'safe-terminal',
    userMessage: 'Pilot could not reach the model.',
    remedy:
      'Ask again when you are ready. Pilot deliberately does not resend by itself: it would be answering about a screen you may have moved on from.',
  },
  'request-refused': {
    failure: 'request-refused',
    disposition: 'safe-terminal',
    userMessage: 'Pilot refused that request.',
    remedy: 'Ask again in a moment, or ask about something else.',
  },
  'speech-input-failed': {
    failure: 'speech-input-failed',
    disposition: 'safe-terminal',
    userMessage: 'Pilot could not listen to that question.',
    remedy:
      'Type your question in the box instead. The microphone was released and nothing was kept.',
  },
  'speech-output-failed': {
    failure: 'speech-output-failed',
    disposition: 'recovered',
    userMessage: 'Pilot could not say that out loud.',
    remedy: 'Nothing to do — the answer is on screen in full; only the sound was lost.',
  },
  'conversation-not-saved': {
    failure: 'conversation-not-saved',
    disposition: 'recovered',
    userMessage: 'Pilot is answering but not remembering this conversation.',
    remedy: 'Pilot keeps working. Quit and reopen it later to save conversations again.',
  },
  unexpected: {
    failure: 'unexpected',
    disposition: 'safe-terminal',
    userMessage: 'Something in Pilot failed.',
    remedy: 'Dismiss this and carry on. If it happens again, quit Pilot and open it again.',
  },
};

/**
 * The kind every error code means when nothing more specific is known.
 *
 * Exhaustive over `PilotErrorCode` by type, not by convention: adding a code to
 * `@pilot/shared` without deciding what a user should do about it fails
 * `pnpm typecheck` here. That is the cross-lane issue 2 pattern applied to the
 * error taxonomy.
 */
export const LIFECYCLE_FAILURE_FOR_CODE: Readonly<Record<PilotErrorCode, LifecycleFailure>> = {
  'permission-denied': 'screen-permission-revoked',
  'permission-unknown': 'screen-permission-revoked',
  'permission-restricted': 'screen-permission-revoked',
  'permission-attribution-mismatch': 'screen-permission-revoked',
  'platform-unavailable': 'helper-unavailable',
  'helper-unavailable': 'helper-unavailable',
  'window-not-found': 'window-closed',
  'window-closed': 'window-closed',
  'screen-locked': 'screen-locked',
  'observation-disabled': 'capture-unavailable',
  'observation-paused': 'capture-unavailable',
  'capture-failed': 'capture-interrupted',
  'protected-content': 'capture-blocked',
  'frame-unavailable': 'capture-interrupted',
  'scene-mismatch': 'capture-interrupted',
  'rate-limited': 'request-refused',
  'image-limit-exceeded': 'request-refused',
  'payload-too-large': 'request-refused',
  'provider-unavailable': 'provider-unreachable',
  'authentication-required': 'provider-authentication',
  'unsupported-capability': 'provider-unreachable',
  'run-already-active': 'request-refused',
  'speech-input-failed': 'speech-input-failed',
  'speech-output-failed': 'speech-output-failed',
  'speech-unavailable': 'speech-output-failed',
  'invalid-request': 'unexpected',
  'unknown-channel': 'unexpected',
  'protocol-version-mismatch': 'unexpected',
  cancelled: 'unexpected',
  timeout: 'provider-unreachable',
  internal: 'unexpected',
};

/** Detail key carrying the explicit kind. Read by {@link readLifecycleGuidance}. */
export const RECOVERY_DETAIL_KEY = 'recovery';

export interface LifecycleGuidanceView {
  readonly failure: LifecycleFailure;
  readonly code: PilotErrorCode;
  /** The only string safe to render as "what happened". Never the message. */
  readonly userMessage: string;
  /** What to do about it. Always present — that is the point of the module. */
  readonly remedy: string;
  readonly disposition: RecoveryDisposition;
  /** True when the producer named the kind rather than the code implying it. */
  readonly explicit: boolean;
}

function isLifecycleFailure(value: unknown): value is LifecycleFailure {
  return typeof value === 'string' && (LIFECYCLE_FAILURES as readonly string[]).includes(value);
}

function isErrorCode(value: unknown): value is PilotErrorCode {
  return typeof value === 'string' && (PILOT_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Reads guidance off any error that reached the user.
 *
 * Never `null` for a non-null error: an error with no idea what it is still
 * gets `unexpected`, which says "dismiss this and carry on" — true, and better
 * than a code on its own. `null` in, `null` out, so the panel can render the
 * absence of an error without a special case.
 */
export function readLifecycleGuidance(
  error: SerializedPilotError | null,
): LifecycleGuidanceView | null {
  if (error === null) {
    return null;
  }
  const named = error.details?.[RECOVERY_DETAIL_KEY];
  const explicit = isLifecycleFailure(named);
  const failure = explicit
    ? named
    : (LIFECYCLE_FAILURE_FOR_CODE[error.code] ?? LIFECYCLE_GUIDANCE.unexpected.failure);
  const guidance = LIFECYCLE_GUIDANCE[failure];
  return {
    failure,
    code: error.code,
    // The producer's own sentence wins, exactly as in
    // `main/observation-failure.ts`: `PilotError.userMessage` defaults to the
    // technical message, and only then is the table's sentence better.
    userMessage: error.userMessage === error.message ? guidance.userMessage : error.userMessage,
    remedy: guidance.remedy,
    disposition: guidance.disposition,
    explicit,
  };
}

export interface LifecycleErrorOptions {
  /** Technical message, for the log. Defaults to the guidance's own sentence. */
  readonly message?: string;
  /** Overrides the taxonomy code implied by the kind. */
  readonly code?: PilotErrorCode;
  /** Content-free context. Merged under `recovery`; never screen text. */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** The code each kind carries when the producer does not name one. */
const CODE_FOR_FAILURE: Readonly<Record<LifecycleFailure, PilotErrorCode>> = {
  'screen-permission-revoked': 'permission-denied',
  'accessibility-revoked': 'permission-denied',
  'screen-locked': 'screen-locked',
  'session-ended': 'observation-disabled',
  'window-closed': 'window-closed',
  'capture-blocked': 'protected-content',
  'capture-interrupted': 'capture-failed',
  'capture-unavailable': 'capture-failed',
  'stale-request': 'scene-mismatch',
  'helper-restarted': 'helper-unavailable',
  'helper-unavailable': 'helper-unavailable',
  'provider-authentication': 'authentication-required',
  'provider-unreachable': 'provider-unavailable',
  'request-refused': 'rate-limited',
  'speech-input-failed': 'speech-input-failed',
  'speech-output-failed': 'speech-output-failed',
  'conversation-not-saved': 'internal',
  unexpected: 'internal',
};

/**
 * Builds a `PilotError` that carries its own guidance.
 *
 * The kind travels on `details.recovery`, which `serializedPilotErrorSchema`
 * already validates as an unknown record — so guidance crosses the IPC boundary
 * to the renderer with no contract change, exactly as PR-030's observation
 * failure does.
 */
export function lifecycleError(
  failure: LifecycleFailure,
  options: LifecycleErrorOptions = {},
): PilotError {
  const guidance = LIFECYCLE_GUIDANCE[failure];
  const code = options.code ?? CODE_FOR_FAILURE[failure];
  return new PilotError(code, options.message ?? guidance.userMessage, {
    userMessage: guidance.userMessage,
    // `recovered` means Pilot already carried on, so there is nothing for the
    // caller to retry; a safe terminal state is where retrying can make sense.
    retryable: guidance.disposition === 'safe-terminal',
    details: {
      ...(options.details ?? {}),
      [RECOVERY_DETAIL_KEY]: failure,
      disposition: guidance.disposition,
    },
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });
}

/**
 * Re-labels an error raised elsewhere with a known kind, keeping its own words.
 *
 * Used where the producer wrote a good sentence but could not know which of the
 * two endings it was — `MacObservationAdapter` says "This application does not
 * allow Pilot to see its window" without knowing whether the composition root
 * will stop watching or restart the stream.
 */
export function withLifecycleGuidance(
  error: SerializedPilotError,
  failure: LifecycleFailure,
): SerializedPilotError {
  const guidance = LIFECYCLE_GUIDANCE[failure];
  return {
    ...error,
    code: isErrorCode(error.code) ? error.code : CODE_FOR_FAILURE[failure],
    retryable: guidance.disposition === 'safe-terminal' && error.retryable,
    details: {
      ...(error.details ?? {}),
      [RECOVERY_DETAIL_KEY]: failure,
      disposition: guidance.disposition,
    },
  };
}
