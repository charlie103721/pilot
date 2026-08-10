import { afterEach, describe, expect, it } from 'vitest';
import { PilotError, asSpeechId } from '@pilot/shared';
import type { SpeechOutputEvent } from '@pilot/platform';
import { MacSpeechOutputAdapter, type NativeHelperTransport } from '@pilot/platform-mac';
import { createStubTransport } from './support/harness.js';
import type { StubConfig } from './support/helper-stub.js';

/**
 * The macOS `SpeechOutputAdapter`, driven end to end against the Node stub.
 *
 * The two properties under test are the ones §16 and §17 name: stopping is
 * immediate and complete, and every failure leaves the streamed text alone.
 * What cannot be tested here is whether anything is audible.
 */

const SPEECH_A = asSpeechId('speech-a');
const SPEECH_B = asSpeechId('speech-b');

const transports: NativeHelperTransport[] = [];
const adapters: MacSpeechOutputAdapter[] = [];

interface Harness {
  readonly adapter: MacSpeechOutputAdapter;
  readonly events: SpeechOutputEvent[];
}

async function start(
  stub: StubConfig = {},
  options: Partial<ConstructorParameters<typeof MacSpeechOutputAdapter>[0]> = {},
): Promise<Harness> {
  const transport = createStubTransport(stub);
  transports.push(transport);
  await transport.start();
  const adapter = new MacSpeechOutputAdapter({ transport, pollIntervalMs: 60_000, ...options });
  adapters.push(adapter);
  const events: SpeechOutputEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  return { adapter, events };
}

function types(events: readonly SpeechOutputEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    await adapter.dispose();
  }
  for (const transport of transports.splice(0)) {
    await transport.stop();
  }
});

describe('availability', () => {
  it('lists installed voices by identifier', async () => {
    const { adapter } = await start();
    const availability = await adapter.availability();

    expect(availability.available).toBe(true);
    expect(availability.voices).toEqual(['com.apple.voice.compact.en-US.Samantha']);
  });

  it('reports a Mac with no voices as unavailable', async () => {
    const { adapter } = await start({ speechOutput: { available: false } });
    const availability = await adapter.availability();

    expect(availability.available).toBe(false);
    expect(availability.voices).toEqual([]);
  });

  it('exposes the full catalogue for a voice picker', async () => {
    const { adapter } = await start({
      speechOutput: {
        voices: [
          { identifier: 'v1', name: 'Daniel', language: 'en-GB', quality: 'enhanced' },
          { identifier: 'v2', name: 'Kyoko', language: 'ja-JP', quality: 'default' },
        ],
      },
    });
    const catalogue = await adapter.voiceCatalog();

    expect(catalogue.map((voice) => voice.name)).toEqual(['Daniel', 'Kyoko']);
    expect(catalogue[0]?.quality).toBe('enhanced');
  });
});

describe('speaking', () => {
  it('emits started when the synthesiser begins an utterance', async () => {
    const { adapter, events } = await start();

    await adapter.speak({ speechId: SPEECH_A, text: 'This is the answer.' });
    await adapter.refresh();

    expect(types(events)).toEqual(['started']);
    expect(adapter.pendingSpeechIds).toEqual([SPEECH_A]);
  });

  /**
   * PR-026 hands over one chunk at a time. They join the synthesiser's own
   * queue, which is what keeps sentence-to-sentence playback gapless — the
   * host is never in the loop between two chunks.
   */
  it('queues consecutive chunks and finishes them in order', async () => {
    const { adapter, events } = await start({
      speechOutput: { scripts: [[{ type: 'started' }, { type: 'finished' }]] },
    });

    await adapter.speak({ speechId: SPEECH_A, text: 'First sentence.' });
    await adapter.speak({ speechId: SPEECH_B, text: 'Second sentence.' });
    await adapter.refresh();

    expect(types(events)).toEqual(['started', 'finished', 'started', 'finished']);
    expect(events.map((event) => event.speechId)).toEqual([SPEECH_A, SPEECH_A, SPEECH_B, SPEECH_B]);
    expect(adapter.pendingSpeechIds).toEqual([]);
  });

  it('accepts a voice and a rate per utterance', async () => {
    const { adapter } = await start({}, { voice: 'en-GB', rate: 0.4 });
    await expect(
      adapter.speak({ speechId: SPEECH_A, text: 'Hello.', voice: 'v1', rate: 0.9 }),
    ).resolves.toBeUndefined();
  });
});

describe('stopping', () => {
  /**
   * §17 budgets interruption below 300 ms. The design point being asserted is
   * that `stopped` comes from the *stop response*, not from the next poll — so
   * the cost is one round trip and no interval.
   */
  it('reports stopped from the stop response without waiting for a poll', async () => {
    const { adapter, events } = await start();

    await adapter.speak({ speechId: SPEECH_A, text: 'A long sentence being read out loud.' });
    events.length = 0;

    await adapter.stop(SPEECH_A);

    expect(types(events)).toEqual(['stopped']);
    expect(adapter.pendingSpeechIds).toEqual([]);
  });

  /**
   * `AVSpeechSynthesizer` has one queue and one stop, so stopping any
   * utterance flushes the rest. Reported honestly, per utterance, so nothing
   * upstream waits on a chunk that will never be spoken.
   */
  it('reports every queued utterance it had to discard', async () => {
    const { adapter, events } = await start();

    await adapter.speak({ speechId: SPEECH_A, text: 'First.' });
    await adapter.speak({ speechId: SPEECH_B, text: 'Second.' });
    events.length = 0;

    await adapter.stop(SPEECH_A);

    expect(types(events)).toEqual(['stopped', 'stopped']);
    expect(events.map((event) => event.speechId)).toEqual([SPEECH_A, SPEECH_B]);
  });

  it('stops everything when no id is given', async () => {
    const { adapter, events } = await start();

    await adapter.speak({ speechId: SPEECH_A, text: 'First.' });
    await adapter.speak({ speechId: SPEECH_B, text: 'Second.' });
    events.length = 0;

    await adapter.stop();

    expect(events.map((event) => event.speechId)).toEqual([SPEECH_A, SPEECH_B]);
  });

  it('is a no-op for an utterance that already finished', async () => {
    const { adapter, events } = await start({
      speechOutput: { scripts: [[{ type: 'started' }, { type: 'finished' }]] },
    });

    await adapter.speak({ speechId: SPEECH_A, text: 'Done already.' });
    await adapter.refresh();
    events.length = 0;

    await expect(adapter.stop(SPEECH_A)).resolves.toBeUndefined();
    await expect(adapter.stop(SPEECH_A)).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it('never reports an utterance as ending twice', async () => {
    const { adapter, events } = await start({
      speechOutput: { scripts: [[{ type: 'started' }, { type: 'stopped' }]] },
    });

    await adapter.speak({ speechId: SPEECH_A, text: 'Interrupted.' });
    await adapter.stop(SPEECH_A);
    await adapter.refresh();

    expect(types(events).filter((type) => type === 'stopped')).toHaveLength(1);
  });
});

describe('failure', () => {
  /** §16: "TTS fails → continue showing streamed text". */
  it('reports a synthesis failure as a typed error that keeps the text', async () => {
    const { adapter, events } = await start({
      speechOutput: {
        scripts: [[{ type: 'error', code: 'synthesis-failed', message: 'the voice went away' }]],
      },
    });

    await adapter.speak({ speechId: SPEECH_A, text: 'This will not be heard.' });
    await adapter.refresh();

    expect(types(events)).toEqual(['error']);
    const failure = events[0];
    if (failure?.type === 'error') {
      const error = failure.error as PilotError;
      expect(error.code).toBe('speech-output-failed');
      expect(error.userMessage).toContain('text');
    }
    expect(adapter.pendingSpeechIds).toEqual([]);
  });

  /**
   * The helper's own `userMessage` is the transport's generic one — it has to
   * be, because the helper does not know what the user was doing. The adapter
   * restates it in Pilot's words, or §16's promise never reaches the screen.
   */
  it('reports a Mac with no voice as speech-unavailable, in Pilot’s words', async () => {
    const { adapter } = await start({
      speechOutput: {
        startFailsWith: {
          code: 'speech-unavailable',
          failureCode: 'voice-unavailable',
          message: 'No speech synthesis voice is installed',
        },
      },
    });

    const error = await adapter
      .speak({ speechId: SPEECH_A, text: 'Hello.' })
      .then(() => null)
      .catch((cause: unknown) => cause as PilotError);

    expect(error?.code).toBe('speech-unavailable');
    expect(error?.userMessage).toContain('text');
    expect(error?.userMessage).not.toContain('macOS helper');
    expect(adapter.pendingSpeechIds).toEqual([]);
  });

  it('leaves a transport failure alone rather than dressing it as speech', async () => {
    const { adapter } = await start({ dropOps: ['speech.output.speak'] });

    const error = await adapter
      .speak({ speechId: SPEECH_A, text: 'Hello.' })
      .then(() => null)
      .catch((cause: unknown) => cause as PilotError);

    expect(error?.code).toBe('timeout');
    expect(adapter.pendingSpeechIds).toEqual([]);
  });

  it('refuses to speak after dispose rather than hanging', async () => {
    const { adapter } = await start();
    await adapter.dispose();
    await adapter.dispose();

    await expect(adapter.speak({ speechId: SPEECH_A, text: 'Hello.' })).rejects.toThrow(PilotError);
  });

  /**
   * A helper that died stopped speaking, whether or not anyone asked. Reported
   * as `stopped` because nothing failed about the answer — and a caller
   * waiting to queue the next chunk is released instead of hanging.
   */
  it('ends speech when the helper goes away', async () => {
    const { adapter, events } = await start({ crashOnOps: ['speech.output.poll'] });

    await adapter.speak({ speechId: SPEECH_A, text: 'Interrupted by a crash.' });
    await adapter.refresh();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(types(events)).toEqual(['stopped']);
    expect(adapter.pendingSpeechIds).toEqual([]);
  });
});
