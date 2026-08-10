import { describe, expect, it } from 'vitest';
import { asUtteranceId, type UtteranceId } from '@pilot/shared';
import type { SpeechInputEvent } from '@pilot/platform';
import { FakeSpeechInputAdapter } from '@pilot/platform/fakes';
import { SpeechInputBinding, type VoiceDiagnostic } from '@pilot/interaction';

/**
 * The binding, on its own, with no machine behind it.
 *
 * system-design §15 says results from stale utterance IDs are discarded. The
 * machine enforces that for everything that reaches it; these tests prove the
 * *adapter* layer enforces it too, so a recogniser that fires after `cancel`,
 * finalises twice, or answers a question three presses ago cannot get a word in.
 */

const UTT_A = asUtteranceId('utt-a');
const UTT_B = asUtteranceId('utt-b');

interface Harness {
  readonly binding: SpeechInputBinding;
  readonly adapter: FakeSpeechInputAdapter;
  readonly events: SpeechInputEvent[];
  readonly diagnostics: VoiceDiagnostic[];
}

function createHarness(adapter = new FakeSpeechInputAdapter()): Harness {
  const events: SpeechInputEvent[] = [];
  const diagnostics: VoiceDiagnostic[] = [];
  const binding = new SpeechInputBinding({
    speechInput: adapter,
    onEvent: (event) => events.push(event),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { binding, adapter, events, diagnostics };
}

function discardReasons(harness: Harness): readonly string[] {
  return harness.diagnostics
    .filter((diagnostic) => diagnostic.kind === 'discarded-event')
    .map((diagnostic) => diagnostic.reason);
}

describe('SpeechInputBinding', () => {
  it('forwards only what the live utterance says', async () => {
    const harness = createHarness(
      new FakeSpeechInputAdapter({ script: [{ partials: ['what'], final: 'What is this?' }] }),
    );
    await harness.binding.start(UTT_A);
    expect(harness.binding.liveUtteranceId).toBe(UTT_A);
    expect(harness.adapter.started.map((request) => request.utteranceId)).toEqual([UTT_A]);
    expect(harness.adapter.started[0]?.requireOnDevice).toBe(true);

    harness.adapter.emitPartial(UTT_A, 'what');
    harness.adapter.emitPartial(asUtteranceId('utt-ghost'), 'noise');
    await harness.binding.stop(UTT_A);

    expect(harness.events.map((event) => event.type)).toEqual(['partial', 'partial', 'final']);
    expect(discardReasons(harness)).toEqual(['unknown-utterance']);
  });

  it('drops everything a cancelled utterance says afterwards', async () => {
    const harness = createHarness();
    await harness.binding.start(UTT_A);
    await harness.binding.cancel(UTT_A);

    expect(harness.adapter.cancelled).toEqual([UTT_A]);
    expect(harness.binding.liveUtteranceId).toBeNull();

    harness.adapter.emitLateFinal(UTT_A, 'the abandoned question');
    harness.adapter.emitPartial(UTT_A, 'still talking');
    expect(harness.events).toEqual([]);
    expect(discardReasons(harness)).toEqual(['cancelled', 'cancelled']);
  });

  it('accepts one final per utterance and drops the second', async () => {
    const harness = createHarness();
    await harness.binding.start(UTT_A);
    harness.adapter.emitLateFinal(UTT_A, 'What is this?');
    harness.adapter.emitLateFinal(UTT_A, 'What is this?');

    expect(harness.events).toHaveLength(1);
    expect(discardReasons(harness)).toEqual(['already-finalized']);
  });

  it('makes teardown idempotent when the recogniser finalised on its own', async () => {
    const harness = createHarness();
    await harness.binding.start(UTT_A);
    // Endpointing: the recogniser finalises while push-to-talk is still held.
    harness.adapter.emitLateFinal(UTT_A, 'What is this?');

    // The machine still asks for `stop-listening`. Forwarding it would make the
    // adapter throw and destroy a question that was successfully submitted.
    await expect(harness.binding.stop(UTT_A)).resolves.toBeUndefined();
    expect(harness.adapter.stopped).toEqual([]);
    expect(harness.diagnostics).toContainEqual({
      kind: 'ignored-call',
      call: 'stop',
      utteranceId: UTT_A,
      reason: 'already-closed',
    });
  });

  it('never leaves two utterances open at the adapter', async () => {
    const harness = createHarness();
    await harness.binding.start(UTT_A);
    // A caller that skipped the machine's teardown still cannot double-book the
    // microphone: the previous utterance is cancelled first.
    await harness.binding.start(UTT_B);

    expect(harness.adapter.cancelled).toEqual([UTT_A]);
    expect(harness.adapter.started.map((request) => request.utteranceId)).toEqual([UTT_A, UTT_B]);
    expect(harness.binding.liveUtteranceId).toBe(UTT_B);

    harness.adapter.emitLateFinal(UTT_A, 'too late');
    expect(harness.events).toEqual([]);
    expect(discardReasons(harness)).toEqual(['cancelled']);
  });

  it('ignores a repeated start for the utterance already listening', async () => {
    const harness = createHarness();
    await harness.binding.start(UTT_A);
    await harness.binding.start(UTT_A);
    expect(harness.adapter.started).toHaveLength(1);
    expect(harness.diagnostics).toContainEqual({
      kind: 'ignored-call',
      call: 'start',
      utteranceId: UTT_A,
      reason: 'already-listening',
    });
  });

  it('retires an utterance whose start failed, and rethrows', async () => {
    const harness = createHarness(
      new FakeSpeechInputAdapter({ availability: { available: false, onDevice: false } }),
    );
    await expect(harness.binding.start(UTT_A)).rejects.toThrow(/unavailable/iu);
    expect(harness.binding.liveUtteranceId).toBeNull();

    harness.adapter.emitLateFinal(UTT_A, 'impossible');
    expect(harness.events).toEqual([]);
    expect(discardReasons(harness)).toEqual(['already-failed']);
  });

  it('keeps the audio session releasable after a failure (§16)', async () => {
    const harness = createHarness();
    await harness.binding.start(UTT_A);
    harness.adapter.emitError(UTT_A, 'the recogniser lost the audio session');
    expect(harness.events.map((event) => event.type)).toEqual(['error']);

    // The machine answers a failure with `cancel-listening`; it must reach the
    // adapter, because a failed recogniser may still hold the microphone.
    await harness.binding.cancel(UTT_A);
    expect(harness.adapter.cancelled).toEqual([UTT_A]);

    harness.adapter.emitLateFinal(UTT_A, 'recovered somehow');
    expect(harness.events).toHaveLength(1);
    expect(discardReasons(harness)).toEqual(['already-failed']);
  });

  it('releases the microphone and goes silent on dispose', async () => {
    const harness = createHarness();
    await harness.binding.start(UTT_A);
    await harness.binding.dispose();

    expect(harness.adapter.cancelled).toEqual([UTT_A]);
    harness.adapter.emitLateFinal(UTT_A, 'after disposal');
    expect(harness.events).toEqual([]);
    expect(harness.diagnostics.filter((d) => d.kind === 'discarded-event')).toEqual([]);
  });

  it('bounds its diagnostic log', async () => {
    const adapter = new FakeSpeechInputAdapter();
    const binding = new SpeechInputBinding({
      speechInput: adapter,
      onEvent: () => undefined,
      diagnosticLimit: 4,
    });
    await binding.start(UTT_A);
    await binding.cancel(UTT_A);
    for (let index = 0; index < 20; index += 1) {
      adapter.emitLateFinal(UTT_A, `late ${String(index)}`);
    }
    expect(binding.diagnostics).toHaveLength(4);
    expect(binding.discardedEventCount).toBe(20);
  });

  it('reports calls about utterances it never started', async () => {
    const harness = createHarness();
    const stranger: UtteranceId = asUtteranceId('utt-stranger');
    await harness.binding.stop(stranger);
    await harness.binding.cancel(stranger);
    expect(harness.adapter.stopped).toEqual([]);
    expect(harness.adapter.cancelled).toEqual([]);
    expect(
      harness.diagnostics.map((diagnostic) =>
        diagnostic.kind === 'ignored-call' ? diagnostic.reason : diagnostic.reason,
      ),
    ).toEqual(['unknown-utterance', 'unknown-utterance']);
  });
});
