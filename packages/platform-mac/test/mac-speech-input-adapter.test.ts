import { afterEach, describe, expect, it } from 'vitest';
import { PilotError, asUtteranceId, type UtteranceId } from '@pilot/shared';
import type { SpeechInputEvent } from '@pilot/platform';
import { MacSpeechInputAdapter, type NativeHelperTransport } from '@pilot/platform-mac';
import { createStubTransport } from './support/harness.js';
import type { StubConfig, StubSpeechScript } from './support/helper-stub.js';

/**
 * The macOS `SpeechInputAdapter`, driven end to end against the Node stub.
 *
 * The stub is a scripted *misbehaving* recogniser: it finalises before the key
 * is released, finalises twice, and calls back after `cancel()`, because Apple
 * Speech does all three. What is under test is that none of that reaches a
 * caller as a duplicate, a stale result, or a thrown error.
 *
 * What is **not** under test here, and cannot be on Linux: whether Apple Speech
 * behaves the way the stub imitates, and whether
 * `requiresOnDeviceRecognition` really keeps audio on the machine.
 */

const UTT_A = asUtteranceId('utt-a');
const UTT_B = asUtteranceId('utt-b');

const transports: NativeHelperTransport[] = [];
const adapters: MacSpeechInputAdapter[] = [];

interface Harness {
  readonly adapter: MacSpeechInputAdapter;
  readonly events: SpeechInputEvent[];
}

async function start(
  stub: StubConfig = {},
  options: Partial<ConstructorParameters<typeof MacSpeechInputAdapter>[0]> = {},
): Promise<Harness> {
  const transport = createStubTransport({
    permissions: { microphone: 'granted', 'speech-recognition': 'granted' },
    ...stub,
  });
  transports.push(transport);
  await transport.start();
  // A long interval so nothing happens on a timer: every drain in these tests
  // is one the test asked for.
  const adapter = new MacSpeechInputAdapter({ transport, pollIntervalMs: 60_000, ...options });
  adapters.push(adapter);
  const events: SpeechInputEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  return { adapter, events };
}

function script(...steps: StubSpeechScript['steps']): StubSpeechScript {
  return { steps };
}

function types(events: readonly SpeechInputEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

function transcripts(events: readonly SpeechInputEvent[]): readonly string[] {
  return events.flatMap((event) => (event.type === 'error' ? [] : [event.transcript]));
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    await adapter.dispose();
  }
  for (const transport of transports.splice(0)) {
    await transport.stop();
  }
});

describe('availability and disclosure', () => {
  it('reports an on-device recogniser as available with nothing leaving', async () => {
    const { adapter } = await start();
    const availability = await adapter.availability();

    expect(availability.available).toBe(true);
    expect(availability.onDevice).toBe(true);
    expect(availability.locale).toBe('en-US');
    expect(availability.destination).toBe('on-device');
    expect(availability.disclosure?.leavesDevice).toBe(false);
  });

  it('is unavailable when either permission is missing, and says which', async () => {
    const { adapter } = await start({
      permissions: { microphone: 'granted', 'speech-recognition': 'denied' },
    });
    const availability = await adapter.availability();
    expect(availability.available).toBe(false);
    // The recogniser itself is fine — only the grant is missing, and the
    // disclosure must not blame the wrong thing.
    expect(availability.disclosure?.reason).toBe('on-device');
  });

  it('discloses that audio would leave when the Mac cannot recognise locally', async () => {
    const { adapter } = await start({ speechInput: { supportsOnDevice: false } });
    const disclosure = await adapter.disclosure();

    expect(disclosure.leavesDevice).toBe(true);
    expect(disclosure.allowed).toBe(false);
    expect(disclosure.reason).toBe('on-device-unsupported');
  });

  it('lists the locales this Mac can recognise', async () => {
    const { adapter } = await start({
      speechInput: { supportedLocales: ['en-US', 'de-DE', 'ja-JP'] },
    });
    expect(await adapter.supportedLocales()).toEqual(['en-US', 'de-DE', 'ja-JP']);
  });

  it('starts from an unknown disclosure before anything has been probed', async () => {
    const { adapter } = await start();
    expect(adapter.lastDisclosure.destination).toBe('unknown');
    expect(adapter.lastDisclosure.allowed).toBe(false);
  });
});

describe('transcription', () => {
  it('streams partials while the key is held and one final when it is released', async () => {
    const { adapter, events } = await start({
      speechInput: {
        scripts: [
          script(
            {
              on: 'start',
              emit: [
                { type: 'partial', transcript: 'what' },
                { type: 'partial', transcript: 'what is' },
              ],
            },
            { on: 'stop', emit: [{ type: 'final', transcript: 'What is this?' }] },
          ),
        ],
      },
    });

    await adapter.start({ utteranceId: UTT_A, requireOnDevice: true });
    await adapter.refresh();
    expect(types(events)).toEqual(['partial', 'partial']);

    await adapter.stop(UTT_A);
    expect(types(events)).toEqual(['partial', 'partial', 'final']);
    expect(transcripts(events)).toEqual(['what', 'what is', 'What is this?']);
    expect(adapter.activeUtteranceId).toBeNull();
  });

  /**
   * Endpointing: the recogniser decides the sentence is over while the key is
   * still held. The `stop` that arrives afterwards must be a no-op — PR-025
   * found that throwing here dumps a successfully submitted question into the
   * `error` state.
   */
  it('accepts a recogniser that finalises before the key is released', async () => {
    const { adapter, events } = await start({
      speechInput: {
        scripts: [
          script({
            on: 'start',
            emit: [
              { type: 'partial', transcript: 'what is' },
              { type: 'final', transcript: 'What is this?' },
            ],
          }),
        ],
      },
    });

    await adapter.start({ utteranceId: UTT_A, requireOnDevice: true });
    await adapter.refresh();
    expect(types(events)).toEqual(['partial', 'final']);
    expect(adapter.activeUtteranceId).toBeNull();

    await expect(adapter.stop(UTT_A)).resolves.toBeUndefined();
    expect(types(events)).toEqual(['partial', 'final']);
    expect(adapter.ignoredCallCount).toBe(1);
  });

  it('accepts exactly one final when the recogniser sends two', async () => {
    const { adapter, events } = await start({
      speechInput: {
        scripts: [
          script({
            on: 'stop',
            emit: [
              { type: 'final', transcript: 'What is this?' },
              { type: 'final', transcript: 'What is this?' },
            ],
          }),
        ],
      },
    });

    await adapter.start({ utteranceId: UTT_A, requireOnDevice: true });
    await adapter.stop(UTT_A);

    expect(types(events)).toEqual(['final']);
    expect(adapter.droppedEventCount).toBe(1);
  });

  it('drops everything a cancelled utterance says afterwards', async () => {
    const { adapter, events } = await start({
      speechInput: {
        scripts: [
          script({
            on: 'cancel',
            emit: [
              { type: 'partial', transcript: 'still talking' },
              { type: 'final', transcript: 'the abandoned question' },
            ],
          }),
        ],
      },
    });

    await adapter.start({ utteranceId: UTT_A, requireOnDevice: true });
    await adapter.cancel(UTT_A);
    await adapter.refresh();

    expect(events).toEqual([]);
    expect(adapter.droppedEventCount).toBe(2);
    expect(adapter.activeUtteranceId).toBeNull();
  });

  it('drops a result belonging to a superseded utterance', async () => {
    const { adapter, events } = await start({
      speechInput: {
        scripts: [
          script({ on: 'stop', emit: [{ type: 'final', transcript: 'first' }] }),
          script({
            on: 'start',
            // The previous recogniser answering late, while a new one is live.
            emit: [{ type: 'final', transcript: 'too late', utteranceId: 'utt-a' }],
          }),
        ],
      },
    });

    await adapter.start({ utteranceId: UTT_A, requireOnDevice: true });
    await adapter.stop(UTT_A);
    await adapter.start({ utteranceId: UTT_B, requireOnDevice: true });
    await adapter.refresh();

    expect(transcripts(events)).toEqual(['first']);
    expect(adapter.droppedEventCount).toBe(1);
  });

  it('reports a mid-utterance failure as a typed error and closes the utterance', async () => {
    const { adapter, events } = await start({
      speechInput: {
        scripts: [
          script({
            on: 'start',
            emit: [
              { type: 'partial', transcript: 'what is' },
              { type: 'error', code: 'audio-engine', message: 'the microphone went away' },
            ],
          }),
        ],
      },
    });

    await adapter.start({ utteranceId: UTT_A, requireOnDevice: true });
    await adapter.refresh();

    expect(types(events)).toEqual(['partial', 'error']);
    const failure = events[1];
    expect(failure?.type).toBe('error');
    if (failure?.type === 'error') {
      const error = failure.error as PilotError;
      expect(error.code).toBe('speech-input-failed');
      // §16: the user must be able to type instead, so the message has to say so.
      expect(error.userMessage.toLowerCase()).toContain('type');
      expect(error.details?.speechFailure).toBe('audio-engine');
    }

    // A failed utterance is over: the machine answers with `cancel-listening`
    // and that must not throw either.
    await expect(adapter.cancel(UTT_A)).resolves.toBeUndefined();
    expect(adapter.ignoredCallCount).toBe(1);
  });

  it('starts a second utterance by releasing the first', async () => {
    const { adapter } = await start({
      speechInput: { scripts: [script({ on: 'stop', emit: [] })] },
    });

    await adapter.start({ utteranceId: UTT_A, requireOnDevice: true });
    await adapter.start({ utteranceId: UTT_B, requireOnDevice: true });

    expect(adapter.activeUtteranceId).toBe(UTT_B);
  });
});

describe('teardown', () => {
  it('is a no-op for an utterance that was never started', async () => {
    const { adapter, events } = await start();

    await expect(adapter.stop(UTT_A)).resolves.toBeUndefined();
    await expect(adapter.cancel(UTT_A)).resolves.toBeUndefined();
    expect(adapter.ignoredCallCount).toBe(2);
    expect(events).toEqual([]);
  });

  it('is idempotent: stop twice, cancel twice, and cancel after stop', async () => {
    const { adapter } = await start({
      speechInput: {
        scripts: [script({ on: 'stop', emit: [{ type: 'final', transcript: 'done' }] })],
      },
    });

    await adapter.start({ utteranceId: UTT_A, requireOnDevice: true });
    await adapter.stop(UTT_A);
    await adapter.stop(UTT_A);
    await adapter.cancel(UTT_A);
    await adapter.cancel(UTT_A);

    expect(adapter.ignoredCallCount).toBe(3);
  });

  it('releases the microphone on dispose and stays quiet afterwards', async () => {
    const { adapter, events } = await start({
      speechInput: {
        scripts: [script({ on: 'cancel', emit: [{ type: 'final', transcript: 'late' }] })],
      },
    });

    await adapter.start({ utteranceId: UTT_A, requireOnDevice: true });
    await adapter.dispose();
    await adapter.dispose();

    expect(events).toEqual([]);
    await expect(adapter.start({ utteranceId: UTT_B, requireOnDevice: true })).rejects.toThrow(
      PilotError,
    );
  });
});

describe('refusal and failure to start', () => {
  it('refuses to record when recognition would leave the Mac', async () => {
    const { adapter, events } = await start({ speechInput: { supportsOnDevice: false } });

    await expect(
      adapter.start({ utteranceId: UTT_A, requireOnDevice: true }),
    ).rejects.toMatchObject({ code: 'speech-unavailable' });

    expect(adapter.activeUtteranceId).toBeNull();
    expect(events).toEqual([]);
    expect(adapter.lastDisclosure.reason).toBe('on-device-unsupported');
    expect(adapter.lastDisclosure.leavesDevice).toBe(true);
  });

  it('records remotely, with the disclosure kept, when the caller allows it', async () => {
    const { adapter, events } = await start({
      speechInput: {
        supportsOnDevice: false,
        scripts: [script({ on: 'stop', emit: [{ type: 'final', transcript: 'Bonjour' }] })],
      },
    });

    await adapter.start({ utteranceId: UTT_A, requireOnDevice: false });
    expect(adapter.lastDisclosure.leavesDevice).toBe(true);
    expect(adapter.lastDisclosure.allowed).toBe(true);

    await adapter.stop(UTT_A);
    expect(transcripts(events)).toEqual(['Bonjour']);
  });

  it('refuses when there is no recogniser at all', async () => {
    const { adapter } = await start({ speechInput: { recognizerAvailable: false, locale: null } });

    await expect(
      adapter.start({ utteranceId: UTT_A, requireOnDevice: true }),
    ).rejects.toMatchObject({ code: 'speech-unavailable' });
    expect(adapter.lastDisclosure.reason).toBe('recognizer-unavailable');
  });

  /**
   * Microphone and Speech Recognition are separate grants with separate
   * prompts, so they are separate refusals with separate next steps.
   */
  it('refuses with the microphone permission when the microphone is denied', async () => {
    const { adapter } = await start({
      permissions: { microphone: 'denied', 'speech-recognition': 'granted' },
    });

    await expect(
      adapter.start({ utteranceId: UTT_A, requireOnDevice: true }),
    ).rejects.toMatchObject({
      code: 'permission-denied',
      details: { kind: 'microphone', state: 'denied' },
    });
  });

  it('refuses with the speech permission when speech recognition is denied', async () => {
    const { adapter } = await start({
      permissions: { microphone: 'granted', 'speech-recognition': 'restricted' },
    });

    await expect(
      adapter.start({ utteranceId: UTT_A, requireOnDevice: true }),
    ).rejects.toMatchObject({
      code: 'permission-restricted',
      details: { kind: 'speech-recognition', state: 'restricted' },
    });
  });

  it('leaves no utterance behind when the helper refuses to start', async () => {
    const { adapter } = await start({
      speechInput: {
        startFailsWith: {
          code: 'speech-input-failed',
          failureCode: 'audio-engine',
          message: 'No usable audio input device',
        },
      },
    });

    const error = await adapter
      .start({ utteranceId: UTT_A, requireOnDevice: true })
      .then(() => null)
      .catch((cause: unknown) => cause as PilotError);

    expect(error?.code).toBe('speech-input-failed');
    // Restated in Pilot's words: the helper's own message says nothing about
    // the fallback §16 requires.
    expect(error?.userMessage.toLowerCase()).toContain('type');
    expect(error?.details?.speechFailure).toBe('audio-engine');

    expect(adapter.activeUtteranceId).toBeNull();
    // And the teardown the caller will attempt anyway is harmless.
    await expect(adapter.stop(UTT_A)).resolves.toBeUndefined();
  });

  it('leaves a transport failure alone rather than dressing it as speech', async () => {
    const { adapter } = await start({ dropOps: ['speech.input.start'] });

    const error = await adapter
      .start({ utteranceId: UTT_A, requireOnDevice: true })
      .then(() => null)
      .catch((cause: unknown) => cause as PilotError);

    expect(error?.code).toBe('timeout');
    expect(adapter.activeUtteranceId).toBeNull();
  });
});

describe('helper restart', () => {
  /**
   * A helper that died took the microphone, the recogniser and the audio with
   * it. Waiting for a transcript that can never arrive would hang the whole
   * voice path, so the utterance fails immediately and §16's text fallback
   * applies.
   */
  it('fails an open utterance when the helper goes away', async () => {
    const { adapter, events } = await start(
      { crashOnOps: ['speech.input.poll'] },
      { pollIntervalMs: 60_000 },
    );

    await adapter.start({ utteranceId: UTT_A, requireOnDevice: true });
    await adapter.refresh();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(types(events)).toEqual(['error']);
    const failure = events[0];
    if (failure?.type === 'error') {
      expect((failure.error as PilotError).code).toBe('speech-input-failed');
    }
    expect(adapter.activeUtteranceId).toBeNull();
  });
});

describe('utterance identity', () => {
  it('never reports an event for an utterance it did not start', async () => {
    const { adapter, events } = await start({
      speechInput: {
        scripts: [
          script({
            on: 'start',
            emit: [{ type: 'partial', transcript: 'noise', utteranceId: 'utt-ghost' }],
          }),
        ],
      },
    });

    await adapter.start({ utteranceId: UTT_A, requireOnDevice: true });
    await adapter.refresh();

    expect(events).toEqual([]);
    expect(adapter.droppedEventCount).toBe(1);
  });

  it('keeps branded utterance ids intact end to end', async () => {
    const { adapter, events } = await start({
      speechInput: {
        scripts: [script({ on: 'stop', emit: [{ type: 'final', transcript: 'ok' }] })],
      },
    });

    const id: UtteranceId = asUtteranceId('utt-branded');
    await adapter.start({ utteranceId: id, requireOnDevice: true });
    await adapter.stop(id);

    expect(events[0]?.utteranceId).toBe(id);
  });
});
