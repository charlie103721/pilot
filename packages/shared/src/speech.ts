import { z } from 'zod';

/**
 * Speech recognition privacy disclosure (PR-014).
 *
 * `docs/system-design.md` §14 requires Pilot to "show whether the configured
 * provider is local or remote before observation begins". Voice input has the
 * same problem and a sharper edge: on macOS, `SFSpeechRecognizer` will happily
 * send the microphone audio to Apple's servers when the machine cannot
 * recognise the locale on device, and it does so **silently**. Nothing in the
 * API surfaces it to the user, and nothing in the transcript looks different.
 *
 * So the answer is modelled as data rather than left to a code path: every
 * recognition attempt produces one of these, the UI renders it, and refusing
 * to record is itself a disclosure with a reason attached. This mirrors what
 * PR-008 did for permissions — the renderer holds no prose and no policy, only
 * a table it draws.
 *
 * Deliberately platform-neutral (system-design §19: a Windows implementation
 * satisfies the same interfaces). `service` names whoever would receive the
 * audio; the Apple-specific text lives in `packages/platform-mac`.
 */

/** Where the audio is turned into text. */
export const SPEECH_RECOGNITION_DESTINATIONS = ['on-device', 'remote-service', 'unknown'] as const;

export type SpeechRecognitionDestination = (typeof SPEECH_RECOGNITION_DESTINATIONS)[number];

/**
 * Why the destination is what it is.
 *
 * - `on-device` — recognition is pinned to this machine and no audio leaves.
 * - `on-device-unsupported` — the recogniser cannot handle this locale (or
 *   this Mac) locally, and the caller required on-device, so Pilot refuses.
 * - `remote-allowed` — the caller explicitly permitted remote recognition and
 *   the audio will leave the machine.
 * - `recognizer-unavailable` — there is no recogniser at all; neither
 *   destination applies.
 * - `unknown` — the platform could not say. Never treated as "safe".
 */
export const SPEECH_DISCLOSURE_REASONS = [
  'on-device',
  'on-device-unsupported',
  'remote-allowed',
  'recognizer-unavailable',
  'unknown',
] as const;

export type SpeechDisclosureReason = (typeof SPEECH_DISCLOSURE_REASONS)[number];

export const speechRecognitionDisclosureSchema = z.strictObject({
  destination: z.enum(SPEECH_RECOGNITION_DESTINATIONS),
  /**
   * True when the microphone audio would leave this machine to be recognised.
   *
   * Kept separate from `destination` so a consumer can ask the privacy
   * question without knowing the destination vocabulary, and so `unknown`
   * cannot accidentally read as "stays here".
   */
  leavesDevice: z.boolean(),
  /** Whether Pilot will actually record under the preference that produced this. */
  allowed: z.boolean(),
  reason: z.enum(SPEECH_DISCLOSURE_REASONS),
  /** Who receives the audio when it leaves. `null` when nothing leaves. */
  service: z.string().max(120).nullable(),
  /** Locale the recogniser would use, when known. */
  locale: z.string().max(40).nullable(),
  /** One line, safe to show a user. */
  headline: z.string().min(1).max(200),
  /** The consequence in the user's terms, including what to do instead. */
  detail: z.string().min(1).max(400),
});

export type SpeechRecognitionDisclosure = z.infer<typeof speechRecognitionDisclosureSchema>;

/**
 * Whether this disclosure must be shown before recording, rather than merely
 * being available in a diagnostics pane.
 *
 * Two situations qualify and they are not the same situation: audio is about
 * to leave the machine, or Pilot is refusing to listen at all. Both are
 * surprises to a user who just held the push-to-talk key, and both have a
 * different next action.
 */
export function speechDisclosureNeedsAttention(disclosure: SpeechRecognitionDisclosure): boolean {
  return disclosure.leavesDevice || !disclosure.allowed;
}
