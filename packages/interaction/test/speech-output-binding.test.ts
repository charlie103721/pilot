import { describe, expect, it } from 'vitest';
import { asSpeechId, asUtteranceId, type SpeechId } from '@pilot/shared';
import type { SpeechOutputEvent } from '@pilot/platform';
import { FakeSpeechOutputAdapter } from '@pilot/platform/fakes';
import { SpeechOutputBinding, speechChunkId, type VoiceDiagnostic } from '@pilot/interaction';

/**
 * The output binding, on its own, with no machine behind it.
 *
 * PR-025 proved the same properties for speech *input*: one live stream, a
 * teardown that is safe to repeat, and a diagnostic for everything that was
 * dropped. These tests are its mirror image, and they exist because a real
 * synthesiser reports completion late, twice, and for the wrong utterance.
 */

const STREAM_A = asSpeechId('speech-a');
const STREAM_B = asSpeechId('speech-b');
const UTTERANCE = asUtteranceId('utt-1');

interface Harness {
  readonly binding: SpeechOutputBinding;
  readonly adapter: FakeSpeechOutputAdapter;
  readonly events: SpeechOutputEvent[];
  readonly diagnostics: VoiceDiagnostic[];
}

function createHarness(adapter = new FakeSpeechOutputAdapter()): Harness {
  const events: SpeechOutputEvent[] = [];
  const diagnostics: VoiceDiagnostic[] = [];
  const binding = new SpeechOutputBinding({
    speechOutput: adapter,
    onEvent: (event) => events.push(event),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { binding, adapter, events, diagnostics };
}

function chunk(
  speechId: SpeechId,
  text: string,
  sequence: number,
  final = false,
): Parameters<SpeechOutputBinding['speak']>[0] {
  return { speechId, utteranceId: UTTERANCE, text, sequence, final };
}

function reasons(harness: Harness): readonly string[] {
  return harness.diagnostics.map((diagnostic) => `${diagnostic.kind}:${diagnostic.reason}`);
}

describe('SpeechOutputBinding', () => {
  it('speaks chunks in order, one at a time', async () => {
    const harness = createHarness();
    await harness.binding.speak(chunk(STREAM_A, 'One.', 0));
    await harness.binding.speak(chunk(STREAM_A, 'Two.', 1));
    await harness.binding.speak(chunk(STREAM_A, 'Three.', 2, true));

    // Only the first is with the synthesiser; the rest are queued.
    expect(harness.adapter.spoken.map((request) => request.text)).toEqual(['One.']);
    expect(harness.binding.pendingChunkCount).toBe(2);

    harness.adapter.finish();
    await harness.binding.settled();
    expect(harness.adapter.spoken.map((request) => request.text)).toEqual(['One.', 'Two.']);

    harness.adapter.finish();
    await harness.binding.settled();
    harness.adapter.finish();
    await harness.binding.settled();

    expect(harness.adapter.spoken.map((request) => request.text)).toEqual([
      'One.',
      'Two.',
      'Three.',
    ]);
    // One `started` for the whole answer, one `finished`, and only at the end.
    expect(harness.events.map((event) => event.type)).toEqual(['started', 'finished']);
    expect(harness.events.every((event) => event.speechId === STREAM_A)).toBe(true);
  });

  it('does not end the turn when a chunk finishes but the stream is still open', async () => {
    const harness = createHarness();
    await harness.binding.speak(chunk(STREAM_A, 'One.', 0));
    harness.adapter.finish();
    await harness.binding.settled();

    expect(harness.events.map((event) => event.type)).toEqual(['started']);
    expect(harness.binding.liveSpeechId).toBe(STREAM_A);

    // The machine closes the stream later, when the run completes.
    await harness.binding.speak(chunk(STREAM_A, 'Two.', 1, true));
    harness.adapter.finish();
    await harness.binding.settled();
    expect(harness.events.map((event) => event.type)).toEqual(['started', 'finished']);
  });

  it('closes a stream whose final chunk carries no text', async () => {
    const harness = createHarness();
    await harness.binding.speak(chunk(STREAM_A, 'All of it.', 0));
    harness.adapter.finish();
    await harness.binding.settled();
    expect(harness.events.map((event) => event.type)).toEqual(['started']);

    // `run-completed` with nothing left unspoken.
    await harness.binding.speak(chunk(STREAM_A, '', 1, true));
    await harness.binding.settled();
    expect(harness.events.map((event) => event.type)).toEqual(['started', 'finished']);
    expect(harness.adapter.spoken).toHaveLength(1);
  });

  it('discards a completion that arrives twice or out of order', async () => {
    const harness = createHarness();
    await harness.binding.speak(chunk(STREAM_A, 'One.', 0));
    await harness.binding.speak(chunk(STREAM_A, 'Two.', 1, true));

    // Chunk 1 reports completion while chunk 0 is still speaking.
    harness.adapter.emitFinished(speechChunkId(STREAM_A, 1));
    await harness.binding.settled();
    expect(harness.events.map((event) => event.type)).toEqual(['started']);

    harness.adapter.emitFinished(speechChunkId(STREAM_A, 0));
    await harness.binding.settled();
    // ...and again.
    harness.adapter.emitFinished(speechChunkId(STREAM_A, 0));
    await harness.binding.settled();
    expect(harness.events.map((event) => event.type)).toEqual(['started']);

    harness.adapter.emitFinished(speechChunkId(STREAM_A, 1));
    await harness.binding.settled();
    expect(harness.events.map((event) => event.type)).toEqual(['started', 'finished']);
    expect(reasons(harness)).toEqual([
      'discarded-speech-event:stale-chunk',
      'discarded-speech-event:stale-chunk',
    ]);
  });

  it('drops every queued chunk when the stream is stopped', async () => {
    const harness = createHarness();
    await harness.binding.speak(chunk(STREAM_A, 'One.', 0));
    await harness.binding.speak(chunk(STREAM_A, 'Two.', 1));
    await harness.binding.speak(chunk(STREAM_A, 'Three.', 2, true));

    await harness.binding.stop(STREAM_A);
    expect(harness.adapter.stopCalls).toEqual([speechChunkId(STREAM_A, 0)]);
    expect(harness.binding.pendingChunkCount).toBe(0);
    expect(harness.adapter.spoken.map((request) => request.text)).toEqual(['One.']);
    expect(reasons(harness)).toEqual([
      'discarded-chunk:stopped',
      'discarded-chunk:stopped',
      // The synthesiser's own `stopped` callback: we asked for it, so the
      // machine is not told twice.
      'discarded-speech-event:self-initiated',
    ]);
    // The stream started, and then simply stopped: no completion is reported
    // for an answer that was cut off.
    expect(harness.events.map((event) => event.type)).toEqual(['started']);
  });

  it('never speaks a chunk that arrives after its stream was stopped', async () => {
    const harness = createHarness();
    await harness.binding.speak(chunk(STREAM_A, 'One.', 0));
    await harness.binding.stop(STREAM_A);

    await harness.binding.speak(chunk(STREAM_A, 'and one more thing.', 1, true));
    await harness.binding.settled();

    expect(harness.adapter.spoken.map((request) => request.text)).toEqual(['One.']);
    expect(reasons(harness)).toContain('discarded-chunk:stopped');
  });

  it('makes stopping idempotent', async () => {
    const harness = createHarness();
    await harness.binding.speak(chunk(STREAM_A, 'One.', 0, true));
    harness.adapter.finish();
    await harness.binding.settled();

    // The stream already completed; the machine's teardown still asks.
    await harness.binding.stop(STREAM_A);
    await harness.binding.stop(null);
    expect(harness.adapter.stopCalls).toEqual([]);
    expect(reasons(harness)).toEqual([
      'ignored-speech-call:already-finished',
      'ignored-speech-call:no-live-stream',
    ]);
  });

  it('lets a new stream supersede one that was never torn down', async () => {
    const harness = createHarness();
    await harness.binding.speak(chunk(STREAM_A, 'Old answer.', 0));
    await harness.binding.speak(chunk(STREAM_A, 'Still the old answer.', 1));

    await harness.binding.speak(chunk(STREAM_B, 'New answer.', 0, true));
    await harness.binding.settled();

    expect(harness.binding.liveSpeechId).toBe(STREAM_B);
    expect(harness.adapter.spoken.map((request) => request.text)).toEqual([
      'Old answer.',
      'New answer.',
    ]);
    expect(reasons(harness)).toContain('discarded-chunk:superseded');
    // One `started` per stream, and nothing else yet.
    expect(harness.events.map((event) => event.type)).toEqual(['started', 'started']);

    // The old stream cannot come back, whatever the synthesiser says about it.
    harness.adapter.emitFinished(speechChunkId(STREAM_A, 0));
    await harness.binding.settled();
    expect(harness.events.map((event) => event.type)).toEqual(['started', 'started']);
  });

  it('reports a synthesiser failure as one stream-level error', async () => {
    const harness = createHarness();
    await harness.binding.speak(chunk(STREAM_A, 'One.', 0));
    await harness.binding.speak(chunk(STREAM_A, 'Two.', 1, true));

    harness.adapter.emitError(speechChunkId(STREAM_A, 0), 'the voice went away');
    await harness.binding.settled();

    expect(harness.events).toHaveLength(2);
    expect(harness.events[1]).toMatchObject({ type: 'error', speechId: STREAM_A });
    // Nothing queued behind the failure is spoken.
    await harness.binding.speak(chunk(STREAM_A, 'Three.', 2, true));
    expect(harness.adapter.spoken).toHaveLength(1);
    expect(reasons(harness)).toContain('discarded-chunk:already-failed');
  });

  it('turns an unavailable synthesiser into an error, not a throw', async () => {
    const harness = createHarness(new FakeSpeechOutputAdapter({ available: false }));
    await harness.binding.speak(chunk(STREAM_A, 'One.', 0, true));
    await harness.binding.settled();
    expect(harness.events[0]).toMatchObject({ type: 'error', speechId: STREAM_A });
  });

  it('forwards a stop it did not ask for', async () => {
    const harness = createHarness();
    await harness.binding.speak(chunk(STREAM_A, 'One.', 0, true));
    await harness.adapter.stop();
    await harness.binding.settled();

    expect(harness.events.map((event) => event.type)).toEqual(['started', 'stopped']);
    expect(harness.binding.liveSpeechId).toBeNull();
  });

  it('goes silent and releases the synthesiser on dispose', async () => {
    const harness = createHarness();
    await harness.binding.speak(chunk(STREAM_A, 'One.', 0));
    await harness.binding.dispose();

    expect(harness.adapter.stopCalls).toEqual([speechChunkId(STREAM_A, 0)]);
    // The chunk had already started; nothing the synthesiser says afterwards
    // reaches the machine, and disposing twice is a no-op.
    expect(harness.events.map((event) => event.type)).toEqual(['started']);
    harness.adapter.emitFinished(speechChunkId(STREAM_A, 0));
    expect(harness.events.map((event) => event.type)).toEqual(['started']);
    await harness.binding.dispose();
  });

  it('bounds its diagnostic log', async () => {
    const adapter = new FakeSpeechOutputAdapter();
    const binding = new SpeechOutputBinding({
      speechOutput: adapter,
      onEvent: () => undefined,
      diagnosticLimit: 3,
    });
    await binding.speak(chunk(STREAM_A, 'One.', 0, true));
    await binding.stop(STREAM_A);
    for (let index = 0; index < 10; index += 1) {
      await binding.speak(chunk(STREAM_A, `late ${String(index)}`, index + 1));
    }
    expect(binding.diagnostics).toHaveLength(3);
    expect(binding.discardedCount).toBeGreaterThanOrEqual(10);
  });
});
