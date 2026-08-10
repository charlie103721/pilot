import {
  PilotError,
  type PermissionKind,
  type PermissionState,
  type PilotErrorCode,
  type SpeechRecognitionDisclosure,
} from '@pilot/shared';
import { SPEECH_FAILURE_CODES, type SpeechFailureCode } from '../protocol/speech-ops.js';

/**
 * Typed errors for every speech failure mode (system-design §16).
 *
 * Two rows of that table drive everything here:
 *
 * > **STT fails** → preserve audio only until failure handling completes, then
 * > offer text input.
 * > **TTS fails** → continue showing streamed text.
 *
 * Both say the same thing in different words: a speech failure must never be
 * terminal for the conversation. That only works if the failure arrives as a
 * value the UI can branch on, so every path below produces a `PilotError` with
 * a stable `code` and a `userMessage` that names the fallback. None of them
 * carries audio, a transcript, or anything else that must not be logged —
 * `details` holds ids, permission kinds and the disclosure, all of which are
 * safe to serialise into a log line or across IPC.
 */

/** Map from the helper's closed failure vocabulary to Pilot's error codes. */
const INPUT_CODES: Readonly<Record<SpeechFailureCode, PilotErrorCode>> = {
  'no-speech': 'speech-input-failed',
  'audio-engine': 'speech-input-failed',
  'recognizer-failed': 'speech-input-failed',
  'recognizer-unavailable': 'speech-unavailable',
  'on-device-unavailable': 'speech-unavailable',
  'permission-denied': 'permission-denied',
  // A synthesis failure reported on the input stream is a helper bug, not a
  // recognition outcome. It is still mapped rather than dropped.
  'synthesis-failed': 'speech-input-failed',
  'voice-unavailable': 'speech-input-failed',
  cancelled: 'cancelled',
  internal: 'speech-input-failed',
};

const OUTPUT_CODES: Readonly<Record<SpeechFailureCode, PilotErrorCode>> = {
  'no-speech': 'speech-output-failed',
  'audio-engine': 'speech-output-failed',
  'recognizer-failed': 'speech-output-failed',
  'recognizer-unavailable': 'speech-output-failed',
  'on-device-unavailable': 'speech-output-failed',
  'permission-denied': 'speech-output-failed',
  'synthesis-failed': 'speech-output-failed',
  'voice-unavailable': 'speech-unavailable',
  cancelled: 'cancelled',
  internal: 'speech-output-failed',
};

/**
 * What the user should do instead, per failure.
 *
 * Written per code rather than per error because "Pilot could not hear you"
 * and "this Mac has no voice installed" have nothing in common except being
 * failures, and a shared message would tell the user nothing either time.
 */
const INPUT_MESSAGES: Readonly<Record<SpeechFailureCode, string>> = {
  'no-speech': 'Pilot did not catch that. Try again, or type your question instead.',
  'audio-engine':
    'Pilot lost the microphone. Check that no other app is using it, or type your question instead.',
  'recognizer-failed': 'Pilot could not turn that into text. Type your question instead.',
  'recognizer-unavailable':
    'Speech recognition is unavailable on this Mac. Type your question instead.',
  'on-device-unavailable':
    'Pilot only recognises speech on this Mac, and this Mac cannot do it for this language. Type your question instead.',
  'permission-denied': 'Pilot needs permission to listen. Type your question instead for now.',
  'synthesis-failed': 'Pilot could not turn that into text. Type your question instead.',
  'voice-unavailable': 'Pilot could not turn that into text. Type your question instead.',
  cancelled: 'That question was cancelled.',
  internal: 'Pilot could not turn that into text. Type your question instead.',
};

const OUTPUT_MESSAGE =
  'Pilot cannot speak on this Mac. The answer is still shown as text as it arrives.';

/** Failures the caller may reasonably retry with the same inputs. */
const RETRYABLE: ReadonlySet<SpeechFailureCode> = new Set<SpeechFailureCode>([
  'no-speech',
  'audio-engine',
  'recognizer-failed',
  'synthesis-failed',
]);

export interface SpeechFailureContext {
  /** Utterance or speech id. Never a transcript. */
  readonly id?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Builds the `PilotError` for a recognition failure reported by the helper. */
export function toSpeechInputError(
  code: SpeechFailureCode,
  message: string,
  context: SpeechFailureContext = {},
): PilotError {
  return new PilotError(INPUT_CODES[code], message, {
    userMessage: INPUT_MESSAGES[code],
    retryable: RETRYABLE.has(code),
    details: {
      speechFailure: code,
      ...(context.id === undefined ? {} : { utteranceId: context.id }),
      ...(context.details ?? {}),
    },
  });
}

/**
 * Builds the `PilotError` for a synthesis failure.
 *
 * Always `retryable` in the sense that matters: §16 says the streamed text
 * keeps showing, so the conversation continues whether or not anyone retries.
 */
export function toSpeechOutputError(
  code: SpeechFailureCode,
  message: string,
  context: SpeechFailureContext = {},
): PilotError {
  return new PilotError(OUTPUT_CODES[code], message, {
    userMessage: OUTPUT_MESSAGE,
    retryable: RETRYABLE.has(code),
    details: {
      speechFailure: code,
      ...(context.id === undefined ? {} : { speechId: context.id }),
      ...(context.details ?? {}),
    },
  });
}

/**
 * The error for a permission that is not granted.
 *
 * Microphone and Speech Recognition are separate grants and are reported
 * separately: `kind` says which one, so the UI can send the user to the right
 * System Settings row instead of to a generic privacy pane. The three
 * non-granted states map to three different codes because they need three
 * different next actions — prompt, System Settings, or "no action will help".
 */
export function toSpeechPermissionError(kind: PermissionKind, state: PermissionState): PilotError {
  const label = kind === 'microphone' ? 'Microphone' : 'Speech Recognition';
  const code: PilotErrorCode =
    state === 'denied'
      ? 'permission-denied'
      : state === 'restricted'
        ? 'permission-restricted'
        : 'permission-unknown';
  const userMessage =
    state === 'restricted'
      ? `${label} access is blocked by a policy on this Mac, so Pilot cannot listen. Type your question instead.`
      : state === 'denied'
        ? `Pilot needs ${label} access to listen. Turn it on in System Settings, or type your question instead.`
        : `Pilot has not been given ${label} access yet. Allow it when macOS asks, or type your question instead.`;

  return new PilotError(code, `${label} permission is ${state}`, {
    userMessage,
    retryable: false,
    details: { kind, state },
  });
}

/**
 * Re-states a failure the helper reported in Pilot's own words.
 *
 * The helper answers a failed `speech.input.start` or `speech.output.speak`
 * with a `SerializedPilotError` whose `userMessage` is the transport's generic
 * one — it has to be, because the helper does not know what the user was
 * doing. That message is useless in the two places §16 cares about: a user
 * whose microphone was refused needs to be told to type, and a user whose Mac
 * has no voice needs to be told the answer is still on screen.
 *
 * So the code is recovered — from the `"<failure-code>: …"` prefix the helper
 * writes, or failing that from the `PilotError` code itself — and the error is
 * rebuilt with the right message. A failure that is *not* about speech (a
 * timeout, a dead helper, a malformed request) is returned untouched: those
 * already carry accurate messages of their own, and dressing them up as speech
 * failures would hide a transport problem.
 */
export function remapSpeechFailure(error: unknown, side: 'input' | 'output'): unknown {
  if (!(error instanceof PilotError)) {
    return error;
  }
  const code = failureCodeOf(error, side);
  if (code === null) {
    return error;
  }
  const context: SpeechFailureContext = {
    ...(error.details === undefined ? {} : { details: error.details }),
  };
  return side === 'input'
    ? toSpeechInputError(code, error.message, context)
    : toSpeechOutputError(code, error.message, context);
}

/** Codes the helper answers with, and what they mean on each side. */
const CODE_FROM_ERROR: Readonly<
  Partial<Record<PilotErrorCode, { input: SpeechFailureCode; output: SpeechFailureCode }>>
> = {
  'speech-unavailable': { input: 'recognizer-unavailable', output: 'voice-unavailable' },
  'speech-input-failed': { input: 'recognizer-failed', output: 'synthesis-failed' },
  'speech-output-failed': { input: 'recognizer-failed', output: 'synthesis-failed' },
  'permission-denied': { input: 'permission-denied', output: 'synthesis-failed' },
};

function failureCodeOf(error: PilotError, side: 'input' | 'output'): SpeechFailureCode | null {
  const separator = error.message.indexOf(': ');
  if (separator > 0) {
    const candidate = error.message.slice(0, separator);
    if ((SPEECH_FAILURE_CODES as readonly string[]).includes(candidate)) {
      return candidate as SpeechFailureCode;
    }
  }
  return CODE_FROM_ERROR[error.code]?.[side] ?? null;
}

/**
 * The error for a recognition attempt Pilot refused on privacy grounds.
 *
 * The disclosure travels in `details` so whatever renders the failure can show
 * *why* rather than a bare "unavailable" — that refusal is a deliberate product
 * decision (PR-008's onboarding copy promises it), not a malfunction, and it
 * reads as a bug if the reason is missing.
 */
export function toDisclosureRefusalError(
  disclosure: SpeechRecognitionDisclosure,
  utteranceId?: string,
): PilotError {
  return new PilotError('speech-unavailable', `Recognition refused: ${disclosure.reason}`, {
    userMessage: disclosure.detail,
    retryable: false,
    details: {
      ...(utteranceId === undefined ? {} : { utteranceId }),
      disclosure,
    },
  });
}
