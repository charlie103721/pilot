import { PERMISSION_STATES } from '@pilot/shared';
import { z } from 'zod';
import { defineHelperOperation, type HelperOperationResponse } from './operation-kit.js';

/**
 * Speech operations (PR-014): Apple Speech transcription and
 * `AVSpeechSynthesizer` playback, over the framed helper protocol.
 *
 * ## No audio crosses this boundary. Ever.
 *
 * `docs/system-design.md` §13 lists raw microphone buffers under *memory-only*
 * and raw audio under *never logged*. The strongest way to honour that is to
 * give the audio nowhere to go: microphone buffers are appended straight from
 * the `AVAudioEngine` tap into `SFSpeechAudioBufferRecognitionRequest` inside
 * the helper process and are never copied anywhere else. Every operation below
 * therefore declares `requestBinary: false` and `responseBinary: false`, and
 * PR-003's transport rejects a binary payload on an operation that does not
 * accept one — so "attach the audio" is not a mistake a later PR can make by
 * accident. It is a typed `invalid-request`.
 *
 * This is the one place in the helper protocol where that restriction is
 * load-bearing rather than incidental: `echo` (PR-003) and capture (PR-012)
 * both use the binary body.
 *
 * ## Why the host polls instead of the helper pushing
 *
 * Recognition is asynchronous — partial hypotheses arrive on the recogniser's
 * own schedule — but the helper's stdio loop is single-threaded and blocking
 * (`HelperRuntime.run`). Pushing events would mean a second thread writing
 * frames concurrently with the request loop: a write lock and a second failure
 * surface, in Swift that cannot be compiled on the development machine
 * (runbook amendment 8). PR-011 made the same call for window lifecycle and
 * said so in `window-ops.ts`; speech follows it.
 *
 * So callbacks append to a lock-protected queue inside the helper and the host
 * drains it with `speech.input.poll` / `speech.output.poll`. The cost is one
 * poll interval of latency on partial transcripts, which no user can perceive.
 * The two places where latency *is* the requirement do not poll at all:
 *
 * - **Stopping speech** (§17: below 300 ms) is a request, and the response
 *   names every utterance it discarded, so the host emits `stopped`
 *   immediately rather than waiting for a drain.
 * - **Starting recognition** returns the on-device decision in its response.
 *
 * ## Drains are idempotent
 *
 * A poll asks for everything after `sinceSequence` and does not consume
 * anything else, so a poll whose response was lost (a deadline, a helper
 * restart) can simply be repeated. The helper drops the oldest events when its
 * ring overflows and reports a cumulative `dropped` count rather than
 * silently losing them; the host turns any increase into a diagnostic.
 */

/** Longest transcript the helper will send in one event. */
export const SPEECH_TRANSCRIPT_MAX_LENGTH = 4_096;

/** Longest text the host will hand to the synthesiser in one utterance. */
export const SPEECH_TEXT_MAX_LENGTH = 4_096;

/** Most events one poll may return. */
export const SPEECH_EVENT_BATCH_MAX = 256;

const idString = z.string().min(1).max(200);
const localeString = z.string().min(2).max(40);
const sequenceNumber = z.number().int().nonnegative();

/**
 * Why recognition or synthesis failed, as a closed vocabulary.
 *
 * The helper classifies the platform's `NSError` into one of these and the
 * host maps it to a `PilotError` code (`src/speech/errors.ts`). Two layers
 * rather than one because Apple's speech error numbers are undocumented
 * folklore: keeping the classification in Swift means a wrong guess is a
 * one-line fix in the mapper, and keeping the *taxonomy* here means the host's
 * behaviour is decided by a value that is fully covered by tests on Linux.
 */
export const SPEECH_FAILURE_CODES = [
  /** The recogniser heard nothing usable. Not an error the user caused. */
  'no-speech',
  /** The microphone or audio engine could not be started or was lost. */
  'audio-engine',
  /** The recognition task itself failed. */
  'recognizer-failed',
  /** No recogniser for this locale, or the recogniser went offline. */
  'recognizer-unavailable',
  /** On-device recognition was required and is not available. */
  'on-device-unavailable',
  /** Microphone or Speech Recognition is not granted. */
  'permission-denied',
  /** Synthesis could not start or was lost mid-utterance. */
  'synthesis-failed',
  /** No voice is installed. */
  'voice-unavailable',
  /** The caller cancelled. */
  'cancelled',
  /** Anything the helper could not classify. */
  'internal',
] as const;

export type SpeechFailureCode = (typeof SPEECH_FAILURE_CODES)[number];

const failureMessage = z.string().max(500);

// ---------------------------------------------------------------------------
// Speech input
// ---------------------------------------------------------------------------

/**
 * What the recogniser *is*, with no judgement attached.
 *
 * Exactly like `permissions.attribution` (PR-011), the helper reports facts and
 * the host decides. `decideRecognition()` in `src/speech/disclosure.ts` turns
 * these into "record on device", "record and disclose that audio leaves", or
 * "refuse" — and that decision is testable on Linux, which the facts are not.
 */
export const speechRecognizerFactsSchema = z.strictObject({
  /** A recogniser exists for the locale and reports itself available. */
  recognizerAvailable: z.boolean(),
  /** `SFSpeechRecognizer.supportsOnDeviceRecognition` for that recogniser. */
  supportsOnDevice: z.boolean(),
  /** Locale the recogniser resolved to. Null when there is no recogniser. */
  locale: localeString.nullable(),
  /** Locales the platform can recognise at all. Diagnostics; may be empty. */
  supportedLocales: z.array(localeString).max(200),
  /** True when a recogniser object exists but reports `isAvailable == false`. */
  recognizerOffline: z.boolean(),
});

export type SpeechRecognizerFacts = z.infer<typeof speechRecognizerFactsSchema>;

/**
 * Recogniser facts plus the two permissions voice input needs.
 *
 * Microphone and Speech Recognition are **separate** grants with separate
 * prompts, and PR-011 found their authorization enums do not even agree on
 * their raw values (`1` is `restricted` for AVFoundation and `denied` for
 * Speech). They are reported as two independent states here for the same
 * reason `PermissionSnapshot` keeps them apart: "voice is unavailable" is not
 * an actionable message, and the two have different next steps.
 */
export const speechInputAvailabilityOperation = defineHelperOperation({
  name: 'speech.input.availability',
  request: z.strictObject({ locale: localeString.nullish() }),
  response: z.strictObject({
    facts: speechRecognizerFactsSchema,
    microphone: z.enum(PERMISSION_STATES),
    speechRecognition: z.enum(PERMISSION_STATES),
  }),
  requestBinary: false,
  responseBinary: false,
});

export type SpeechInputAvailabilityResponse = HelperOperationResponse<
  typeof speechInputAvailabilityOperation
>;

/**
 * Begins capture and recognition for one utterance.
 *
 * `onDevice` is the host's **decision**, not a preference: when it is true the
 * helper sets `requiresOnDeviceRecognition`, which makes Apple Speech fail
 * rather than fall back to its servers. That distinction is the whole point —
 * inferring "it probably stayed local" from `supportsOnDeviceRecognition`
 * would be a guess, and a guess is not a privacy guarantee.
 */
export const speechInputStartOperation = defineHelperOperation({
  name: 'speech.input.start',
  request: z.strictObject({
    utteranceId: idString,
    onDevice: z.boolean(),
    locale: localeString.nullish(),
  }),
  response: z.strictObject({
    started: z.boolean(),
    /** What the helper actually configured. Must match the request. */
    onDevice: z.boolean(),
    locale: localeString.nullable(),
  }),
  requestBinary: false,
  responseBinary: false,
});

/**
 * Ends capture and waits for the accepted transcript.
 *
 * `accepted: false` means this utterance was not the one recording — the
 * recogniser had already finalised it, or it failed, or it was cancelled. That
 * is a **normal** outcome, not an error: Apple Speech endpoints on its own and
 * routinely finishes before push-to-talk is released. Returning a boolean
 * rather than throwing is what lets the host's teardown be idempotent.
 */
export const speechInputStopOperation = defineHelperOperation({
  name: 'speech.input.stop',
  request: z.strictObject({ utteranceId: idString }),
  response: z.strictObject({ accepted: z.boolean() }),
  requestBinary: false,
  responseBinary: false,
});

/** Ends capture and discards the utterance. Same idempotence rule as `stop`. */
export const speechInputCancelOperation = defineHelperOperation({
  name: 'speech.input.cancel',
  request: z.strictObject({ utteranceId: idString }),
  response: z.strictObject({ accepted: z.boolean() }),
  requestBinary: false,
  responseBinary: false,
});

/**
 * One thing the recogniser said.
 *
 * The three kinds match `SpeechInputEvent` in `@pilot/platform` exactly, so the
 * adapter is a mapping and not a translation. `error` carries a code from the
 * closed vocabulary above rather than a platform error number.
 */
export const speechInputEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('partial'),
    sequence: sequenceNumber,
    utteranceId: idString,
    transcript: z.string().max(SPEECH_TRANSCRIPT_MAX_LENGTH),
  }),
  z.strictObject({
    type: z.literal('final'),
    sequence: sequenceNumber,
    utteranceId: idString,
    transcript: z.string().max(SPEECH_TRANSCRIPT_MAX_LENGTH),
  }),
  z.strictObject({
    type: z.literal('error'),
    sequence: sequenceNumber,
    utteranceId: idString,
    code: z.enum(SPEECH_FAILURE_CODES),
    message: failureMessage,
  }),
]);

export type SpeechInputWireEvent = z.infer<typeof speechInputEventSchema>;

export const speechInputPollOperation = defineHelperOperation({
  name: 'speech.input.poll',
  request: z.strictObject({ sinceSequence: sequenceNumber }),
  response: z.strictObject({
    events: z.array(speechInputEventSchema).max(SPEECH_EVENT_BATCH_MAX),
    /** Highest sequence the helper has produced. Pass it back next time. */
    sequence: sequenceNumber,
    /** Cumulative events discarded because the ring overflowed. */
    dropped: sequenceNumber,
    /** True while the helper still holds the microphone. */
    recording: z.boolean(),
    activeUtteranceId: idString.nullable(),
  }),
  requestBinary: false,
  responseBinary: false,
});

export type SpeechInputPollResponse = HelperOperationResponse<typeof speechInputPollOperation>;

// ---------------------------------------------------------------------------
// Speech output
// ---------------------------------------------------------------------------

export const speechVoiceSchema = z.strictObject({
  /** `AVSpeechSynthesisVoice.identifier`. Stable across launches. */
  identifier: z.string().min(1).max(200),
  name: z.string().max(200),
  language: z.string().max(40),
  /** `default`, `enhanced` or `premium`, as the platform reports it. */
  quality: z.string().max(40),
});

export type SpeechVoice = z.infer<typeof speechVoiceSchema>;

export const speechOutputAvailabilityOperation = defineHelperOperation({
  name: 'speech.output.availability',
  request: z.strictObject({}),
  response: z.strictObject({
    available: z.boolean(),
    voices: z.array(speechVoiceSchema).max(500),
  }),
  requestBinary: false,
  responseBinary: false,
});

/**
 * Speaks one chunk.
 *
 * PR-026 owns segmentation; this speaks whatever it is handed. `AVSpeechSynthesizer`
 * has its own queue, so a second `speak` while the first is playing joins the
 * queue rather than interrupting it — which is what makes gapless sentence-by-
 * sentence playback possible without the host timing anything.
 */
export const speechOutputSpeakOperation = defineHelperOperation({
  name: 'speech.output.speak',
  request: z.strictObject({
    speechId: idString,
    text: z.string().min(1).max(SPEECH_TEXT_MAX_LENGTH),
    /** Voice identifier, or a BCP-47 language tag the helper resolves. */
    voice: z.string().max(200).nullish(),
    /** 0…1, mapped onto the platform's rate range. */
    rate: z.number().min(0).max(1).nullish(),
  }),
  response: z.strictObject({
    accepted: z.boolean(),
    /** True when something was already speaking and this joined the queue. */
    queued: z.boolean(),
  }),
  requestBinary: false,
  responseBinary: false,
});

/**
 * Stops speech now.
 *
 * The response lists every utterance that was discarded, including ones that
 * had not started yet: `AVSpeechSynthesizer.stopSpeaking(at: .immediate)`
 * flushes the whole queue and there is no API to remove one entry. The host
 * emits `stopped` for each of them from this response, so interruption costs
 * exactly one round trip and never waits for a poll (§17: below 300 ms).
 */
export const speechOutputStopOperation = defineHelperOperation({
  name: 'speech.output.stop',
  request: z.strictObject({ speechId: idString.nullish() }),
  response: z.strictObject({
    stopped: z.array(idString).max(SPEECH_EVENT_BATCH_MAX),
  }),
  requestBinary: false,
  responseBinary: false,
});

export const speechOutputEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('started'),
    sequence: sequenceNumber,
    speechId: idString,
  }),
  z.strictObject({
    type: z.literal('finished'),
    sequence: sequenceNumber,
    speechId: idString,
  }),
  z.strictObject({
    type: z.literal('stopped'),
    sequence: sequenceNumber,
    speechId: idString,
  }),
  z.strictObject({
    type: z.literal('error'),
    sequence: sequenceNumber,
    speechId: idString,
    code: z.enum(SPEECH_FAILURE_CODES),
    message: failureMessage,
  }),
]);

export type SpeechOutputWireEvent = z.infer<typeof speechOutputEventSchema>;

export const speechOutputPollOperation = defineHelperOperation({
  name: 'speech.output.poll',
  request: z.strictObject({ sinceSequence: sequenceNumber }),
  response: z.strictObject({
    events: z.array(speechOutputEventSchema).max(SPEECH_EVENT_BATCH_MAX),
    sequence: sequenceNumber,
    dropped: sequenceNumber,
    /** `AVSpeechSynthesizer.isSpeaking`, including paused. */
    speaking: z.boolean(),
    activeSpeechId: idString.nullable(),
  }),
  requestBinary: false,
  responseBinary: false,
});

export type SpeechOutputPollResponse = HelperOperationResponse<typeof speechOutputPollOperation>;

/** Every speech operation, for the "no binary body" assertion in the tests. */
export const SPEECH_OPERATIONS = [
  speechInputAvailabilityOperation,
  speechInputStartOperation,
  speechInputStopOperation,
  speechInputCancelOperation,
  speechInputPollOperation,
  speechOutputAvailabilityOperation,
  speechOutputSpeakOperation,
  speechOutputStopOperation,
  speechOutputPollOperation,
] as const;
