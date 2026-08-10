import type { SpeechDisclosureReason, SpeechRecognitionDisclosure } from '@pilot/shared';
import type { SpeechRecognizerFacts } from '../protocol/speech-ops.js';

/**
 * On-device preference, and the disclosure when it cannot be honoured.
 *
 * ## The problem this exists to prevent
 *
 * `SFSpeechRecognizer` recognises speech remotely by default. When the Mac
 * cannot handle a locale on device, the microphone audio is uploaded to Apple
 * and the API says nothing about it: the transcript looks identical, there is
 * no flag on the result, and the only observable difference is that it stops
 * working without a network. A user who held a push-to-talk key believing
 * their voice stayed on their machine would have no way to find out otherwise.
 *
 * So Pilot does two things, and this module is both of them:
 *
 * 1. **Prefer on device, by requiring it.** `requiresOnDeviceRecognition` is
 *    the only guarantee available — it makes recognition *fail* rather than
 *    fall back. Reading `supportsOnDeviceRecognition` and hoping is not a
 *    guarantee, it is an inference, and this module never makes it.
 * 2. **Disclose the alternative rather than taking it silently.** Every
 *    outcome, including the refusal, produces a `SpeechRecognitionDisclosure`
 *    the UI can render (system-design §14, and the same "data not prose"
 *    shape PR-008 used for permissions).
 *
 * The helper reports facts (`SpeechRecognizerFacts`); the decision is made
 * here, on the host, in a pure function — exactly the split PR-011 used for
 * attribution, and for the same reason: this is the part that can be proven
 * correct on a machine with no macOS.
 */

/** Who receives the audio on macOS when it leaves the machine. */
export const APPLE_SPEECH_SERVICE = 'Apple’s speech recognition servers';

export interface RecognitionPreference {
  /**
   * Refuse to record unless recognition is pinned to this machine.
   *
   * Comes from `SpeechInputRequest.requireOnDevice`, which PR-025's binding
   * defaults to `true`. `false` is a deliberate opt-in to remote recognition
   * and still produces a disclosure — a user who allowed it once should still
   * be able to see that it is happening.
   */
  readonly requireOnDevice: boolean;
  /** Overrides the service name in the disclosure. Tests and other platforms. */
  readonly service?: string;
}

export interface RecognitionDecision {
  /** Whether Pilot will start recording at all. */
  readonly allowed: boolean;
  /**
   * What to put in `requiresOnDeviceRecognition`. Only meaningful when
   * `allowed`; always `false` when recognition is not pinned locally.
   */
  readonly useOnDevice: boolean;
  readonly disclosure: SpeechRecognitionDisclosure;
}

interface DisclosureDraft {
  readonly destination: SpeechRecognitionDisclosure['destination'];
  readonly leavesDevice: boolean;
  readonly allowed: boolean;
  readonly reason: SpeechDisclosureReason;
  readonly service: string | null;
  readonly headline: string;
  readonly detail: string;
}

function build(locale: string | null, draft: DisclosureDraft): SpeechRecognitionDisclosure {
  return {
    destination: draft.destination,
    leavesDevice: draft.leavesDevice,
    allowed: draft.allowed,
    reason: draft.reason,
    service: draft.service,
    locale,
    headline: draft.headline,
    detail: draft.detail,
  };
}

/**
 * Turns recogniser facts plus the caller's preference into a decision.
 *
 * Total over its inputs — every combination lands on exactly one of four
 * outcomes, and none of them is "start recording and work out the privacy
 * question afterwards":
 *
 * | Facts | `requireOnDevice` | Outcome |
 * | --- | --- | --- |
 * | no recogniser | either | refuse, `recognizer-unavailable` |
 * | on-device supported | either | record locally, `on-device` |
 * | on-device unsupported | `true` | refuse, `on-device-unsupported` |
 * | on-device unsupported | `false` | record remotely, `remote-allowed` |
 */
export function decideRecognition(
  facts: SpeechRecognizerFacts,
  preference: RecognitionPreference,
): RecognitionDecision {
  const service = preference.service ?? APPLE_SPEECH_SERVICE;
  const locale = facts.locale;

  if (!facts.recognizerAvailable) {
    return {
      allowed: false,
      useOnDevice: false,
      disclosure: build(locale, {
        destination: 'unknown',
        // Nothing leaves, because nothing happens. Reported as `false` and
        // paired with `allowed: false` so no caller reads it as reassurance.
        leavesDevice: false,
        allowed: false,
        reason: 'recognizer-unavailable',
        service: null,
        headline: facts.recognizerOffline
          ? 'Speech recognition is temporarily unavailable on this Mac.'
          : 'This Mac cannot recognise speech for this language.',
        detail:
          'Pilot cannot turn speech into text right now. Type your question instead — the answer is exactly the same.',
      }),
    };
  }

  if (facts.supportsOnDevice) {
    return {
      allowed: true,
      useOnDevice: true,
      disclosure: build(locale, {
        destination: 'on-device',
        leavesDevice: false,
        allowed: true,
        reason: 'on-device',
        service: null,
        headline: 'Your voice stays on this Mac.',
        detail:
          'Pilot recognises speech on this Mac and requires it: if that ever became impossible, recognition would fail rather than send your audio anywhere.',
      }),
    };
  }

  if (preference.requireOnDevice) {
    return {
      allowed: false,
      useOnDevice: false,
      disclosure: build(locale, {
        destination: 'remote-service',
        // The honest answer to "would audio leave?" is yes — which is exactly
        // why Pilot is refusing. `allowed: false` says it did not happen.
        leavesDevice: true,
        allowed: false,
        reason: 'on-device-unsupported',
        service,
        headline: 'Pilot will not listen, because your voice would have to leave this Mac.',
        detail: `This Mac cannot recognise this language without sending the recording to ${service}. Pilot refuses rather than doing that quietly. Type your question instead, or allow remote recognition in settings.`,
      }),
    };
  }

  return {
    allowed: true,
    useOnDevice: false,
    disclosure: build(locale, {
      destination: 'remote-service',
      leavesDevice: true,
      allowed: true,
      reason: 'remote-allowed',
      service,
      headline: `Your voice is sent to ${service} to be turned into text.`,
      detail: `This Mac cannot recognise this language on its own, and remote recognition is allowed. The recording leaves this Mac. Turn remote recognition off to keep everything local and type instead.`,
    }),
  };
}

/**
 * The disclosure for a machine that has not been probed yet.
 *
 * Used before the first successful availability round trip, and after a helper
 * crash. Deliberately `unknown` rather than optimistic: not knowing where
 * audio would go is not the same as knowing it stays here.
 */
export function unknownRecognitionDisclosure(): SpeechRecognitionDisclosure {
  return build(null, {
    destination: 'unknown',
    leavesDevice: false,
    allowed: false,
    reason: 'unknown',
    service: null,
    headline: 'Pilot has not checked how speech would be recognised on this Mac.',
    detail:
      'Pilot asks macOS where recognition would run before it records anything. Until it has an answer, voice input stays off.',
  });
}
