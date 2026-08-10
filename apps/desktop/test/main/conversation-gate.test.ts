import { describe, expect, it } from 'vitest';
import { asUtteranceId, PilotError } from '@pilot/shared';
import { FIXTURE_WINDOW_RETINA } from '@pilot/platform/fakes';
import type { TelemetryMetric, TelemetrySample } from '../../src/ipc/schemas.js';
import { conversationGateStateSchema } from '../../src/ipc/schemas.js';
import { conversationHarness } from './support.js';

/**
 * The conversation gate: derived §17 timings, abort and failure categories, and
 * the two voice facts the renderer cannot know.
 *
 * Every timing here is a difference between two readings of an injected clock,
 * so the expected millisecond value is the one the test advanced by. Nothing is
 * asserted as "some number was recorded".
 */

function samplesFor(samples: readonly TelemetrySample[], metric: TelemetryMetric) {
  return samples.filter((sample) => sample.metric === metric);
}

describe('conversation gate — derived timings', () => {
  it('measures speech to text from the key going down to the transcript landing', () => {
    const { gate, controller, clock } = conversationHarness();

    controller.set({ state: 'listening' });
    clock.advance(900);
    controller.set({ state: 'transcribing' });
    clock.advance(350);
    controller.set({ state: 'thinking' });

    expect(samplesFor(gate.snapshot().telemetry.samples, 'stt-duration')).toEqual([
      expect.objectContaining({ value: 1_250, turn: 1, category: null }),
    ]);
  });

  it('measures speech to text when recognition fails instead of succeeding', () => {
    const { gate, controller, clock } = conversationHarness();

    controller.set({ state: 'listening' });
    clock.advance(700);
    controller.fail(new PilotError('speech-input-failed', 'no').toJSON());

    const samples = gate.snapshot().telemetry.samples;
    // "How long did the recogniser take to fail" is the number that matters
    // when the answer is that it did.
    expect(samplesFor(samples, 'stt-duration')).toEqual([expect.objectContaining({ value: 700 })]);
    expect(samplesFor(samples, 'failure')).toEqual([
      expect.objectContaining({ category: 'speech-input-failed', value: 1 }),
    ]);
  });

  it('measures time to first token and time to first spoken sentence from one submission', () => {
    const { gate, controller, clock } = conversationHarness();

    controller.set({ state: 'thinking' });
    clock.advance(400);
    controller.appendTranscript({
      utteranceId: asUtteranceId('utt-a'),
      role: 'assistant',
      text: 'Auto Renew keeps',
      at: 1,
      pending: true,
    });
    clock.advance(150);
    controller.set({ state: 'speaking' });

    const samples = gate.snapshot().telemetry.samples;
    expect(samplesFor(samples, 'time-to-first-token')).toEqual([
      expect.objectContaining({ value: 400 }),
    ]);
    expect(samplesFor(samples, 'time-to-first-sentence')).toEqual([
      expect.objectContaining({ value: 550 }),
    ]);
  });

  it('measures the second question too, not only the first', () => {
    const { gate, controller, clock } = conversationHarness();

    for (let turn = 1; turn <= 2; turn += 1) {
      controller.set({ state: 'thinking' });
      clock.advance(100 * turn);
      controller.appendTranscript({
        utteranceId: asUtteranceId(`utt-a${String(turn)}`),
        role: 'assistant',
        text: 'answer',
        at: 1,
        pending: false,
      });
      controller.set({ state: 'observing' });
    }

    // The naive implementation of "an assistant turn exists" fires once and
    // never again, so the second question would be silently unmeasured.
    expect(
      samplesFor(gate.snapshot().telemetry.samples, 'time-to-first-token').map(
        (sample) => sample.value,
      ),
    ).toEqual([100, 200]);
  });

  it('counts observation calls per question, and starts again at the next one', () => {
    const { gate, controller } = conversationHarness();

    controller.set({ state: 'thinking' });
    controller.set({ state: 'observing-screen' });
    controller.set({ state: 'thinking' });
    controller.set({ state: 'observing-screen' });
    controller.set({ state: 'observing' });
    controller.set({ state: 'thinking' });
    controller.set({ state: 'observing-screen' });

    expect(
      samplesFor(gate.snapshot().telemetry.samples, 'observation-calls').map(
        (sample) => sample.value,
      ),
    ).toEqual([1, 2, 1]);
  });
});

describe('conversation gate — aborts and failures', () => {
  it('records an interruption of an answer in flight', () => {
    const { gate, controller } = conversationHarness();
    controller.set({ state: 'speaking' });

    gate.noteCommand({ type: 'interrupt' });

    expect(samplesFor(gate.snapshot().telemetry.samples, 'abort')).toEqual([
      expect.objectContaining({ category: 'user-interrupted' }),
    ]);
  });

  it('does not record an abort when nothing was running', () => {
    const { gate, controller } = conversationHarness();
    controller.set({ state: 'observing' });

    gate.noteCommand({ type: 'interrupt' });
    gate.noteCommand({ type: 'clear-conversation' });

    expect(samplesFor(gate.snapshot().telemetry.samples, 'abort')).toHaveLength(0);
  });

  it('treats a window change during an answer as an abort of that answer', () => {
    const { gate, controller } = conversationHarness();
    controller.set({ state: 'thinking' });

    gate.noteCommand({ type: 'select-window', windowId: FIXTURE_WINDOW_RETINA.windowId });

    expect(samplesFor(gate.snapshot().telemetry.samples, 'abort')).toEqual([
      expect.objectContaining({ category: 'window-changed' }),
    ]);
  });

  it('records an abort when Pilot is torn down mid-answer', () => {
    const { gate, controller } = conversationHarness();
    controller.set({ state: 'observing-screen' });

    gate.dispose();

    expect(samplesFor(gate.snapshot().telemetry.samples, 'abort')).toEqual([
      expect.objectContaining({ category: 'shutdown' }),
    ]);
  });

  it('records each distinct failure once, not once per publish', () => {
    const { gate, controller } = conversationHarness();
    const error = new PilotError('capture-failed', 'no frame').toJSON();

    controller.fail(error);
    controller.set({ speaking: false });
    controller.set({ speaking: true });

    expect(samplesFor(gate.snapshot().telemetry.samples, 'failure')).toHaveLength(1);
  });

  it('opens a turn for a typed question, which has no listening edge to count', () => {
    const { gate, controller } = conversationHarness();

    gate.noteCommand({ type: 'submit-text', text: 'what is this' });
    controller.set({ state: 'thinking' });
    controller.appendTranscript({
      utteranceId: asUtteranceId('utt-a'),
      role: 'assistant',
      text: 'that',
      at: 1,
      pending: false,
    });

    expect(gate.snapshot().telemetry.samples.every((sample) => sample.turn === 1)).toBe(true);
  });
});

describe('conversation gate — voice affordances', () => {
  it('resolves push-to-talk through the platform helpers, once, in the main process', async () => {
    const { gate, hotkeyAdapter } = conversationHarness({
      hotkey: {
        status: 'unavailable',
        reason: 'permission-missing',
        permission: 'accessibility',
        detail: 'not granted',
      },
    });

    await gate.refresh();
    const pushToTalk = gate.snapshot().pushToTalk;

    expect(pushToTalk?.usable).toBe(false);
    expect(pushToTalk?.status).toBe('unavailable');
    expect(pushToTalk?.blockingPermission).toBe('accessibility');
    // `hotkeyUnavailableMessage` lives beside the type so every shell says the
    // same thing; this is that sentence, unmodified.
    expect(pushToTalk?.message).toContain('type your question instead');
    expect(pushToTalk?.label).toBe('Right Option');
    expect(hotkeyAdapter).toBeDefined();
  });

  it('follows the shortcut becoming available without being asked again', async () => {
    const { gate, hotkeyAdapter } = conversationHarness({ hotkey: { status: 'stopped' } });
    await gate.refresh();
    expect(gate.snapshot().pushToTalk?.usable).toBe(false);

    await hotkeyAdapter.start();

    expect(gate.snapshot().pushToTalk).toMatchObject({ usable: true, status: 'active' });
  });

  it('reports no push-to-talk at all in a build with no hotkey adapter', async () => {
    const { gate } = conversationHarness({ withHotkey: false });
    await gate.refresh();

    // Null is "this build has no shortcut", which is not the same as "the
    // shortcut is not listening" and must not render as it.
    expect(gate.snapshot().pushToTalk).toBeNull();
  });

  it('routes the speech-recognition disclosure to the panel (runbook follow-up 13)', async () => {
    const { gate } = conversationHarness({
      disclosure: {
        destination: 'remote-service',
        leavesDevice: true,
        allowed: true,
        reason: 'remote-allowed',
        service: 'Apple Speech Recognition',
        locale: 'en-GB',
        headline: 'Audio would leave this Mac.',
        detail: 'Type instead if you would rather it did not.',
      },
    });

    await gate.refresh();

    expect(gate.snapshot().disclosure?.leavesDevice).toBe(true);
  });
});

describe('conversation gate — the wire', () => {
  it('publishes a state the schema accepts, including after a replay', () => {
    const { gate, replay } = conversationHarness();
    replay('spoken-question');
    replay('interrupted-answer');

    const parsed = conversationGateStateSchema.safeParse(gate.snapshot());
    expect(parsed.success).toBe(true);
  });

  it('notifies subscribers on every sample, so the panel never polls', () => {
    const { gate, controller } = conversationHarness();
    const seen: number[] = [];
    gate.subscribe((state) => seen.push(state.telemetry.recorded));

    controller.set({ state: 'speaking' });
    gate.noteCommand({ type: 'interrupt' });

    expect(seen.at(-1)).toBe(1);
  });

  it('clears the ring and toggles the diagnostics surface through validated actions', async () => {
    const { gate, controller } = conversationHarness();
    controller.set({ state: 'speaking' });
    gate.noteCommand({ type: 'interrupt' });

    expect(
      (await gate.act({ type: 'set-diagnostics-visible', visible: true })).diagnosticsVisible,
    ).toBe(true);
    expect((await gate.act({ type: 'clear-telemetry' })).telemetry.samples).toHaveLength(0);
  });

  it('refuses to serve anything once disposed', async () => {
    const { gate } = conversationHarness();
    gate.dispose();

    await expect(gate.act({ type: 'refresh' })).rejects.toThrow(/disposed/i);
  });

  // PR-038 (API-key provider profile). Appended, additive: nothing above
  // changed, and the new member is `modelDisclosure`.
  it('carries the model’s remote-data label, and republishes when it changes', () => {
    const { gate } = conversationHarness();
    expect(gate.snapshot().modelDisclosure).toBeNull();

    const seen: (string | null)[] = [];
    gate.subscribe((state) => seen.push(state.modelDisclosure?.verification ?? null));

    gate.setModelDisclosure({
      sendsScreenOffDevice: true,
      destination: 'api.recorded-vendor.example',
      authMode: 'api-key',
      verification: 'verified',
      headline: 'Screen images are sent to api.recorded-vendor.example',
      detail: 'Screen images leave this Mac.',
      credentialSummary: 'Your API key is stored in the macOS Keychain.',
      needsAttention: true,
    });
    expect(gate.snapshot().modelDisclosure?.verification).toBe('verified');
    // It has to survive the wire, which is the only reason it is a schema.
    expect(conversationGateStateSchema.parse(gate.snapshot()).modelDisclosure).not.toBeNull();

    // An invalid key mid-conversation takes the claim back; the panel must be
    // told rather than left showing "Pilot has confirmed this model".
    gate.setModelDisclosure({
      sendsScreenOffDevice: true,
      destination: 'api.recorded-vendor.example',
      authMode: 'api-key',
      verification: 'unverified',
      headline: 'Screen images are sent to api.recorded-vendor.example',
      detail: 'Pilot has not yet confirmed this model.',
      credentialSummary: null,
      needsAttention: true,
    });
    expect(seen).toEqual(['verified', 'unverified']);
  });
});
