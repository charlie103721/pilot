import { describe, expect, it } from 'vitest';
import { PilotError, speechDisclosureNeedsAttention, type PermissionState } from '@pilot/shared';
import {
  APPLE_SPEECH_SERVICE,
  SPEECH_FAILURE_CODES,
  decideRecognition,
  toDisclosureRefusalError,
  toSpeechInputError,
  toSpeechOutputError,
  toSpeechPermissionError,
  unknownRecognitionDisclosure,
  type SpeechRecognizerFacts,
} from '@pilot/platform-mac';

/**
 * The on-device decision and the typed errors, as pure functions.
 *
 * This is the part of PR-014 that can be proven correct on a machine with no
 * macOS: whether audio is allowed to leave, what the user is told when it
 * would, and which error code each failure becomes. What Apple Speech actually
 * does with `requiresOnDeviceRecognition` is the part that cannot be
 * (`docs/handoff.md` §1).
 */

function facts(overrides: Partial<SpeechRecognizerFacts> = {}): SpeechRecognizerFacts {
  return {
    recognizerAvailable: true,
    supportsOnDevice: true,
    locale: 'en-US',
    supportedLocales: ['en-US', 'en-GB'],
    recognizerOffline: false,
    ...overrides,
  };
}

describe('decideRecognition', () => {
  it('records on device and says nothing leaves when the Mac can do it', () => {
    const decision = decideRecognition(facts(), { requireOnDevice: true });

    expect(decision.allowed).toBe(true);
    expect(decision.useOnDevice).toBe(true);
    expect(decision.disclosure.destination).toBe('on-device');
    expect(decision.disclosure.leavesDevice).toBe(false);
    expect(decision.disclosure.reason).toBe('on-device');
    expect(decision.disclosure.service).toBeNull();
    expect(decision.disclosure.locale).toBe('en-US');
    expect(speechDisclosureNeedsAttention(decision.disclosure)).toBe(false);
  });

  /**
   * The preference is honoured by *requiring* on-device recognition, not by
   * inferring it. `useOnDevice` is what ends up in
   * `requiresOnDeviceRecognition`, which is the only setting that makes Apple
   * Speech fail rather than upload.
   */
  it('still requires on-device recognition when the caller did not insist', () => {
    const decision = decideRecognition(facts(), { requireOnDevice: false });

    expect(decision.allowed).toBe(true);
    expect(decision.useOnDevice).toBe(true);
    expect(decision.disclosure.leavesDevice).toBe(false);
  });

  it('refuses, with a reason, when on-device recognition is impossible', () => {
    const decision = decideRecognition(facts({ supportsOnDevice: false }), {
      requireOnDevice: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.useOnDevice).toBe(false);
    expect(decision.disclosure.reason).toBe('on-device-unsupported');
    expect(decision.disclosure.destination).toBe('remote-service');
    // The honest answer to "would audio leave?" is yes — which is why Pilot is
    // refusing. `allowed: false` records that it did not.
    expect(decision.disclosure.leavesDevice).toBe(true);
    expect(decision.disclosure.service).toBe(APPLE_SPEECH_SERVICE);
    expect(decision.disclosure.detail).toContain(APPLE_SPEECH_SERVICE);
    expect(speechDisclosureNeedsAttention(decision.disclosure)).toBe(true);
  });

  it('discloses rather than hides remote recognition when it is allowed', () => {
    const decision = decideRecognition(facts({ supportsOnDevice: false, locale: 'cy-GB' }), {
      requireOnDevice: false,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.useOnDevice).toBe(false);
    expect(decision.disclosure.reason).toBe('remote-allowed');
    expect(decision.disclosure.leavesDevice).toBe(true);
    expect(decision.disclosure.locale).toBe('cy-GB');
    expect(decision.disclosure.headline).toContain(APPLE_SPEECH_SERVICE);
    expect(speechDisclosureNeedsAttention(decision.disclosure)).toBe(true);
  });

  it('refuses when there is no recogniser at all, whatever the preference', () => {
    for (const requireOnDevice of [true, false]) {
      const decision = decideRecognition(facts({ recognizerAvailable: false, locale: null }), {
        requireOnDevice,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.disclosure.reason).toBe('recognizer-unavailable');
      expect(decision.disclosure.destination).toBe('unknown');
      expect(decision.disclosure.service).toBeNull();
    }
  });

  it('distinguishes a recogniser that is offline from one that does not exist', () => {
    const offline = decideRecognition(
      facts({ recognizerAvailable: false, recognizerOffline: true }),
      { requireOnDevice: true },
    );
    const missing = decideRecognition(
      facts({ recognizerAvailable: false, recognizerOffline: false }),
      { requireOnDevice: true },
    );

    expect(offline.disclosure.headline).not.toBe(missing.disclosure.headline);
    expect(offline.disclosure.headline).toContain('temporarily');
  });

  it('lets another platform name its own service', () => {
    const decision = decideRecognition(facts({ supportsOnDevice: false }), {
      requireOnDevice: false,
      service: 'Contoso Speech',
    });
    expect(decision.disclosure.service).toBe('Contoso Speech');
    expect(decision.disclosure.headline).toContain('Contoso Speech');
  });

  /** Not knowing where audio would go is never reported as "it stays here". */
  it('starts from an unknown disclosure that is not a pass', () => {
    const disclosure = unknownRecognitionDisclosure();
    expect(disclosure.destination).toBe('unknown');
    expect(disclosure.allowed).toBe(false);
    expect(disclosure.reason).toBe('unknown');
    expect(speechDisclosureNeedsAttention(disclosure)).toBe(true);
  });
});

describe('typed errors', () => {
  it('maps every failure code to a speech or permission error', () => {
    for (const code of SPEECH_FAILURE_CODES) {
      const input = toSpeechInputError(code, 'boom', { id: 'utt-1' });
      expect(input).toBeInstanceOf(PilotError);
      expect(input.userMessage.length).toBeGreaterThan(0);
      expect(input.details?.speechFailure).toBe(code);
      expect(input.details?.utteranceId).toBe('utt-1');
    }
  });

  /**
   * system-design §16: "STT fails → offer text input". Every recognition
   * failure therefore has to *say* so, or the fallback is invisible.
   */
  it('tells the user to type when recognition fails', () => {
    for (const code of ['no-speech', 'audio-engine', 'recognizer-failed', 'internal'] as const) {
      expect(toSpeechInputError(code, 'boom').userMessage.toLowerCase()).toContain('type');
    }
  });

  it('separates unavailable recognition from a failed attempt', () => {
    expect(toSpeechInputError('recognizer-unavailable', 'x').code).toBe('speech-unavailable');
    expect(toSpeechInputError('on-device-unavailable', 'x').code).toBe('speech-unavailable');
    expect(toSpeechInputError('recognizer-failed', 'x').code).toBe('speech-input-failed');
    expect(toSpeechInputError('permission-denied', 'x').code).toBe('permission-denied');
    expect(toSpeechInputError('cancelled', 'x').code).toBe('cancelled');
  });

  /** §16: "TTS fails → continue showing streamed text". */
  it('promises the text is still there when speech output fails', () => {
    for (const code of SPEECH_FAILURE_CODES) {
      const error = toSpeechOutputError(code, 'boom', { id: 'speech-1' });
      expect(error.userMessage).toContain('text');
      expect(error.details?.speechId).toBe('speech-1');
    }
    expect(toSpeechOutputError('synthesis-failed', 'x').code).toBe('speech-output-failed');
    expect(toSpeechOutputError('voice-unavailable', 'x').code).toBe('speech-unavailable');
  });

  it('gives each permission state its own code and its own next step', () => {
    const cases: readonly [PermissionState, string][] = [
      ['denied', 'permission-denied'],
      ['restricted', 'permission-restricted'],
      ['unknown', 'permission-unknown'],
    ];
    for (const [state, code] of cases) {
      const error = toSpeechPermissionError('microphone', state);
      expect(error.code).toBe(code);
      expect(error.details).toEqual({ kind: 'microphone', state });
    }
  });

  it('names the permission the user has to find, not "voice"', () => {
    expect(toSpeechPermissionError('microphone', 'denied').userMessage).toContain('Microphone');
    expect(toSpeechPermissionError('speech-recognition', 'denied').userMessage).toContain(
      'Speech Recognition',
    );
  });

  it('carries the disclosure into the refusal so the UI can explain it', () => {
    const decision = decideRecognition(facts({ supportsOnDevice: false }), {
      requireOnDevice: true,
    });
    const error = toDisclosureRefusalError(decision.disclosure, 'utt-1');

    expect(error.code).toBe('speech-unavailable');
    expect(error.userMessage).toBe(decision.disclosure.detail);
    expect(error.details?.disclosure).toEqual(decision.disclosure);
    expect(error.details?.utteranceId).toBe('utt-1');
  });
});
