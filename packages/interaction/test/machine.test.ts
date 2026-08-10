import { describe, expect, it } from 'vitest';
import type { InteractionState } from '@pilot/shared';
import type {
  InteractionEffectType,
  InteractionInput,
  TransitionOutcome,
} from '@pilot/interaction';
import { STEER_INTERRUPTION_MESSAGE } from '@pilot/interaction';
import {
  GRANTED,
  SAMPLE_ERROR,
  TEST_RUN_ID,
  TEST_TOOL_CALL_ID,
  UNKNOWN,
  WINDOW,
  createHarness,
  driveTo,
} from './support.js';

function accepted(outcome: TransitionOutcome): Extract<TransitionOutcome, { kind: 'accepted' }> {
  if (outcome.kind !== 'accepted') {
    throw new Error(`expected an accepted transition, got ${outcome.rejection.reason}`);
  }
  return outcome;
}

function effectTypes(outcome: TransitionOutcome): readonly InteractionEffectType[] {
  return accepted(outcome).effects.map((effect) => effect.type);
}

/**
 * `docs/mvp-01-point-ask-hear.md` §7, "Required transitions", one row per case.
 */
const REQUIRED_TRANSITIONS: readonly {
  readonly name: string;
  readonly from: InteractionState;
  readonly input: (harness: ReturnType<typeof driveTo>) => InteractionInput;
  readonly to: InteractionState;
}[] = [
  {
    name: 'idle -- valid window selected --> observing',
    from: 'idle',
    input: () => ({ type: 'select-window', windowId: WINDOW.windowId }),
    to: 'observing',
  },
  {
    name: 'observing -- push-to-talk down --> listening',
    from: 'observing',
    input: () => ({ type: 'push-to-talk-down' }),
    to: 'listening',
  },
  {
    name: 'listening -- push-to-talk up --> transcribing',
    from: 'listening',
    input: () => ({ type: 'push-to-talk-up' }),
    to: 'transcribing',
  },
  {
    name: 'transcribing -- transcript accepted --> thinking',
    from: 'transcribing',
    input: (harness) => ({
      type: 'transcript-final',
      utteranceId: harness.machine.context.activeUtteranceId!,
      text: 'What is this?',
    }),
    to: 'thinking',
  },
  {
    name: 'thinking -- screen tool starts --> observing-screen',
    from: 'thinking',
    input: () => ({
      type: 'tool-started',
      runId: TEST_RUN_ID,
      toolCallId: TEST_TOOL_CALL_ID,
      toolName: 'observe_screen',
    }),
    to: 'observing-screen',
  },
  {
    name: 'observing-screen -- tool result returned --> thinking',
    from: 'observing-screen',
    input: () => ({
      type: 'tool-finished',
      runId: TEST_RUN_ID,
      toolCallId: TEST_TOOL_CALL_ID,
      toolName: 'observe_screen',
    }),
    to: 'thinking',
  },
  {
    name: 'thinking -- first speakable text --> speaking',
    from: 'thinking',
    input: () => ({ type: 'run-completed', runId: TEST_RUN_ID, text: 'It is off.' }),
    to: 'speaking',
  },
  {
    name: 'speaking -- new push-to-talk --> listening',
    from: 'speaking',
    input: () => ({ type: 'push-to-talk-down' }),
    to: 'listening',
  },
  {
    name: 'active state -- pause --> paused',
    from: 'thinking',
    input: () => ({ type: 'pause' }),
    to: 'paused',
  },
  {
    name: 'any state -- recoverable failure --> error',
    from: 'speaking',
    input: () => ({ type: 'failure', error: SAMPLE_ERROR }),
    to: 'error',
  },
];

describe('required transitions (mvp-01 §7)', () => {
  for (const row of REQUIRED_TRANSITIONS) {
    it(row.name, () => {
      const harness = driveTo(row.from);
      const outcome = harness.machine.send(row.input(harness));
      expect(accepted(outcome).to).toBe(row.to);
    });
  }
});

/**
 * Illegal transitions. Each one must produce a typed rejection — never a
 * silent no-op (`docs/implementation.md`, delivery rules).
 */
const ILLEGAL_TRANSITIONS: readonly {
  readonly from: InteractionState;
  readonly input: InteractionInput;
  readonly reason: string;
}[] = [
  { from: 'idle', input: { type: 'push-to-talk-up' }, reason: 'illegal-transition' },
  { from: 'idle', input: { type: 'look-now' }, reason: 'illegal-transition' },
  { from: 'idle', input: { type: 'interrupt' }, reason: 'nothing-to-interrupt' },
  { from: 'idle', input: { type: 'stop-speaking' }, reason: 'nothing-to-interrupt' },
  { from: 'idle', input: { type: 'resume' }, reason: 'not-paused' },
  { from: 'idle', input: { type: 'dismiss-error' }, reason: 'nothing-to-dismiss' },
  { from: 'idle', input: { type: 'submit-text', text: '   ' }, reason: 'empty-input' },
  { from: 'idle', input: { type: 'screen-unlocked' }, reason: 'illegal-transition' },
  { from: 'observing', input: { type: 'push-to-talk-up' }, reason: 'illegal-transition' },
  { from: 'listening', input: { type: 'push-to-talk-down' }, reason: 'illegal-transition' },
  { from: 'listening', input: { type: 'look-now' }, reason: 'illegal-transition' },
  {
    from: 'listening',
    input: { type: 'select-window', windowId: WINDOW.windowId },
    reason: 'illegal-transition',
  },
  { from: 'transcribing', input: { type: 'push-to-talk-up' }, reason: 'illegal-transition' },
  { from: 'thinking', input: { type: 'stop-speaking' }, reason: 'nothing-to-interrupt' },
  { from: 'thinking', input: { type: 'look-now' }, reason: 'illegal-transition' },
  { from: 'speaking', input: { type: 'push-to-talk-up' }, reason: 'illegal-transition' },
  { from: 'paused', input: { type: 'pause' }, reason: 'already-paused' },
  { from: 'paused', input: { type: 'push-to-talk-down' }, reason: 'paused' },
  { from: 'paused', input: { type: 'select-window', windowId: WINDOW.windowId }, reason: 'paused' },
  { from: 'needs-permission', input: { type: 'push-to-talk-down' }, reason: 'not-permitted' },
  {
    from: 'needs-permission',
    input: { type: 'select-window', windowId: WINDOW.windowId },
    reason: 'not-permitted',
  },
  { from: 'error', input: { type: 'push-to-talk-down' }, reason: 'illegal-transition' },
  // `error + submit-text` is *accepted* (system-design §16, the STT fallback);
  // only an empty one is refused. The accepted path is covered in
  // `voice-orchestration.test.ts`.
  { from: 'error', input: { type: 'submit-text', text: '   ' }, reason: 'empty-input' },
];

describe('illegal transitions', () => {
  for (const row of ILLEGAL_TRANSITIONS) {
    it(`${row.from} + ${row.input.type} -> ${row.reason}`, () => {
      const harness = driveTo(row.from);
      const before = harness.machine.state;
      const outcome = harness.machine.send(row.input);
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind !== 'rejected') {
        return;
      }
      expect(outcome.rejection.reason).toBe(row.reason);
      expect(outcome.rejection.from).toBe(before);
      expect(harness.machine.state).toBe(before);
      // Refusals are visible, never silent.
      expect(harness.machine.viewState.lastError?.details).toMatchObject({
        reason: row.reason,
        from: before,
        input: row.input.type,
      });
    });
  }

  it('rejects an unknown window by name', () => {
    const { machine } = createHarness();
    const outcome = machine.send({ type: 'select-window', windowId: 'window-gone' as never });
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.rejection.reason).toBe('window-not-found');
  });
});

describe('cancellation and suspension', () => {
  it('pause tears down speech, audio and the run, then resume restores capture', () => {
    const harness = driveTo('speaking');
    const paused = harness.machine.send({ type: 'pause' });
    expect(accepted(paused).to).toBe('paused');
    expect(effectTypes(paused)).toEqual([
      'stop-speech',
      'interrupt-run',
      'stop-capture',
      'clear-buffers',
    ]);
    expect(harness.machine.context.activeSpeechId).toBeNull();
    expect(harness.machine.context.activeRunId).toBeNull();

    const resumed = harness.machine.send({ type: 'resume' });
    expect(accepted(resumed).to).toBe('observing');
    expect(effectTypes(resumed)).toEqual(['start-capture']);
  });

  it('pause while listening discards the in-flight recording', () => {
    const harness = driveTo('listening');
    const outcome = harness.machine.send({ type: 'pause' });
    expect(effectTypes(outcome)).toEqual(['cancel-listening', 'stop-capture', 'clear-buffers']);
  });

  it('interrupt aborts a thinking run and returns to observing', () => {
    const harness = driveTo('thinking');
    const outcome = harness.machine.send({ type: 'interrupt' });
    expect(accepted(outcome).to).toBe('observing');
    expect(accepted(outcome).effects).toEqual([
      {
        type: 'interrupt-run',
        runId: TEST_RUN_ID,
        mode: 'abort',
        reason: 'interrupted by the user',
      },
    ]);
  });

  it('steers rather than aborts while a screen observation is in flight', () => {
    const harness = driveTo('observing-screen');
    const outcome = harness.machine.send({ type: 'interrupt' });
    expect(accepted(outcome).effects).toEqual([
      {
        type: 'interrupt-run',
        runId: TEST_RUN_ID,
        mode: 'steer',
        // PR-027: a steer's detail is injected into the model's transcript as a
        // user message, so it is written for the model. The internal reason
        // ("interrupted by the user") would otherwise be spoken to it as if the
        // user had said it. An abort's detail is unchanged — it never leaves
        // Pilot.
        reason: STEER_INTERRUPTION_MESSAGE,
      },
    ]);
  });

  it('screen lock suspends and unlock restores', () => {
    const harness = driveTo('speaking');
    expect(accepted(harness.machine.send({ type: 'screen-locked' })).to).toBe('paused');
    expect(accepted(harness.machine.send({ type: 'screen-unlocked' })).to).toBe('observing');
  });

  it('losing the selected window is a recoverable failure, not a crash', () => {
    const harness = driveTo('speaking');
    const outcome = harness.machine.send({ type: 'window-closed', windowId: WINDOW.windowId });
    expect(accepted(outcome).to).toBe('error');
    expect(effectTypes(outcome)).toEqual([
      'stop-speech',
      'interrupt-run',
      'stop-capture',
      'clear-buffers',
    ]);
    expect(harness.machine.viewState.lastError?.code).toBe('window-closed');
    expect(accepted(harness.machine.send({ type: 'dismiss-error' })).to).toBe('idle');
  });

  it('revoking a permission tears everything down and blocks new work', () => {
    const harness = driveTo('thinking');
    const revoked = harness.machine.send({ type: 'permissions-changed', permissions: UNKNOWN });
    expect(accepted(revoked).to).toBe('needs-permission');
    expect(effectTypes(revoked)).toEqual(['interrupt-run', 'stop-capture', 'clear-buffers']);
    expect(harness.machine.send({ type: 'push-to-talk-down' }).kind).toBe('rejected');

    const restored = harness.machine.send({ type: 'permissions-changed', permissions: GRANTED });
    expect(accepted(restored).to).toBe('idle');
  });

  it('clearing the conversation starts a new conversation id and empties the transcript', () => {
    const harness = driveTo('speaking');
    const before = harness.machine.context.conversationId;
    const outcome = harness.machine.send({ type: 'clear-conversation' });
    expect(accepted(outcome).to).toBe('observing');
    expect(harness.machine.context.conversationId).not.toBe(before);
    expect(harness.machine.viewState.transcript).toEqual([]);
  });
});

describe('answer accumulation', () => {
  it('streams the answer into the transcript and speaks it once complete', () => {
    const harness = driveTo('thinking');
    harness.machine.send({ type: 'run-text-delta', runId: TEST_RUN_ID, text: 'That is the ' });
    harness.machine.send({
      type: 'run-text-delta',
      runId: TEST_RUN_ID,
      text: 'Auto Renew toggle.',
    });

    const view = harness.machine.viewState;
    expect(view.transcript.map((entry) => [entry.role, entry.text, entry.pending])).toEqual([
      ['user', 'What is this?', false],
      ['assistant', 'That is the Auto Renew toggle.', true],
    ]);

    const completed = harness.machine.send({ type: 'run-completed', runId: TEST_RUN_ID, text: '' });
    expect(accepted(completed).to).toBe('speaking');
    expect(accepted(completed).effects).toEqual([
      {
        type: 'speak',
        speechId: harness.machine.context.activeSpeechId,
        utteranceId: harness.machine.context.activeUtteranceId,
        text: 'That is the Auto Renew toggle.',
        // PR-026: one chunk, and the last one, so the binding may report the
        // stream complete as soon as it drains.
        sequence: 0,
        final: true,
      },
    ]);
    expect(harness.machine.viewState.transcript.at(-1)?.pending).toBe(false);
    expect(harness.machine.viewState.speaking).toBe(true);
  });

  it('goes back to resting when the model produced nothing to say', () => {
    const harness = driveTo('thinking');
    const outcome = harness.machine.send({ type: 'run-completed', runId: TEST_RUN_ID, text: '' });
    expect(accepted(outcome).to).toBe('observing');
    expect(accepted(outcome).effects).toEqual([]);
  });

  it('finishes speaking back into observing', () => {
    const harness = driveTo('speaking');
    const speechId = harness.machine.context.activeSpeechId!;
    expect(accepted(harness.machine.send({ type: 'speech-started', speechId })).to).toBe(
      'speaking',
    );
    expect(accepted(harness.machine.send({ type: 'speech-finished', speechId })).to).toBe(
      'observing',
    );
    expect(harness.machine.viewState.speaking).toBe(false);
  });
});
