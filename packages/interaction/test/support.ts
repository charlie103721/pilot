import {
  PilotError,
  asObservationId,
  asRunId,
  asSpeechId,
  asToolCallId,
  asUtteranceId,
  createCounterIdSource,
  createIdFactory,
  type IdFactory,
  type InteractionState,
  type ObservedWindow,
  type PermissionSnapshot,
} from '@pilot/shared';
import {
  FIXTURE_PERMISSIONS_GRANTED,
  FIXTURE_PERMISSIONS_UNKNOWN,
  FIXTURE_WINDOWS,
  FIXTURE_WINDOW_RETINA,
  createFakeClock,
  type FakeClock,
} from '@pilot/platform/fakes';
import { InteractionMachine } from '@pilot/interaction';
import type { InteractionInput, InteractionInputType } from '@pilot/interaction';

/** Shared, fully deterministic scaffolding for the machine tests. */

export const WINDOW: ObservedWindow = FIXTURE_WINDOW_RETINA;
export const GRANTED: PermissionSnapshot = FIXTURE_PERMISSIONS_GRANTED;
export const UNKNOWN: PermissionSnapshot = FIXTURE_PERMISSIONS_UNKNOWN;

export interface Harness {
  readonly machine: InteractionMachine;
  readonly clock: FakeClock;
  readonly ids: IdFactory;
}

export function createHarness(
  options: { readonly permissions?: PermissionSnapshot } = {},
): Harness {
  const clock = createFakeClock();
  const ids = createIdFactory(createCounterIdSource());
  const machine = new InteractionMachine({
    clock,
    ids,
    permissions: options.permissions ?? GRANTED,
    windows: FIXTURE_WINDOWS,
  });
  return { machine, clock, ids };
}

export const SAMPLE_ERROR = new PilotError('provider-unavailable', 'sample failure').toJSON();

export const TEST_RUN_ID = asRunId('run-under-test');
export const TEST_TOOL_CALL_ID = asToolCallId('tool-under-test');

/**
 * Drives a fresh machine into `state` using only legal transitions, so every
 * test starts from a state the machine can actually reach.
 */
export function driveTo(state: InteractionState): Harness {
  const harness = createHarness(state === 'needs-permission' ? { permissions: UNKNOWN } : {});
  const { machine } = harness;

  if (state === 'needs-permission') {
    return harness;
  }
  if (state === 'idle') {
    return harness;
  }
  if (state === 'paused') {
    expectAccepted(machine.send({ type: 'pause' }));
    return harness;
  }

  expectAccepted(machine.send({ type: 'select-window', windowId: WINDOW.windowId }));
  if (state === 'observing') {
    return harness;
  }

  expectAccepted(machine.send({ type: 'push-to-talk-down' }));
  if (state === 'listening') {
    return harness;
  }

  expectAccepted(machine.send({ type: 'push-to-talk-up' }));
  if (state === 'transcribing') {
    return harness;
  }

  const utteranceId = machine.context.activeUtteranceId;
  if (utteranceId === null) {
    throw new Error('expected an active utterance');
  }
  expectAccepted(machine.send({ type: 'transcript-final', utteranceId, text: 'What is this?' }));
  expectAccepted(machine.send({ type: 'run-started', utteranceId, runId: TEST_RUN_ID }));
  if (state === 'thinking') {
    return harness;
  }

  if (state === 'observing-screen') {
    expectAccepted(
      machine.send({
        type: 'tool-started',
        runId: TEST_RUN_ID,
        toolCallId: TEST_TOOL_CALL_ID,
        toolName: 'observe_screen',
      }),
    );
    return harness;
  }

  if (state === 'speaking') {
    expectAccepted(
      machine.send({
        type: 'run-completed',
        runId: TEST_RUN_ID,
        text: 'It is the Auto Renew toggle.',
      }),
    );
    return harness;
  }

  if (state === 'error') {
    expectAccepted(machine.send({ type: 'failure', error: SAMPLE_ERROR }));
    return harness;
  }

  throw new Error(`no drive script for state "${state}"`);
}

function expectAccepted(outcome: { kind: string }): void {
  if (outcome.kind !== 'accepted') {
    throw new Error(`drive script produced an unexpected rejection: ${JSON.stringify(outcome)}`);
  }
}

/**
 * A representative input of every type, built against the machine's *current*
 * identity fields so that identity guards pass wherever they legitimately can.
 */
export function representativeInput(
  harness: Harness,
  type: InteractionInputType,
): InteractionInput {
  const context = harness.machine.context;
  const utteranceId = context.activeUtteranceId ?? asUtteranceId('utt-not-active');
  const runId = context.activeRunId ?? asRunId('run-not-active');
  const speechId = context.activeSpeechId ?? asSpeechId('speech-not-active');
  const observationId = context.activeObservationId ?? asObservationId('obs-not-active');
  const windowId = context.selectedWindow?.windowId ?? WINDOW.windowId;

  switch (type) {
    case 'select-window':
      return { type, windowId: WINDOW.windowId };
    case 'set-observation-enabled':
      return { type, enabled: true };
    case 'submit-text':
      return { type, text: 'what is this?' };
    case 'push-to-talk-down':
    case 'push-to-talk-up':
    case 'look-now':
    case 'interrupt':
    case 'stop-speaking':
    case 'clear-conversation':
    case 'pause':
    case 'resume':
    case 'dismiss-error':
    case 'screen-locked':
    case 'screen-unlocked':
      return { type };
    case 'permissions-changed':
      return { type, permissions: GRANTED };
    case 'windows-changed':
      return { type, windows: FIXTURE_WINDOWS };
    case 'window-closed':
      return { type, windowId };
    case 'transcript-partial':
      return { type, utteranceId, text: 'what is' };
    case 'transcript-final':
      return { type, utteranceId, text: 'what is this?' };
    case 'transcript-failed':
      return { type, utteranceId, error: SAMPLE_ERROR };
    case 'run-started':
      return { type, utteranceId, runId: TEST_RUN_ID };
    case 'run-text-delta':
      return { type, runId, text: 'a fragment' };
    case 'tool-started':
      return { type, runId, toolCallId: TEST_TOOL_CALL_ID, toolName: 'observe_screen' };
    case 'tool-finished':
      return { type, runId, toolCallId: TEST_TOOL_CALL_ID, toolName: 'observe_screen' };
    case 'run-completed':
      return { type, runId, text: 'the answer' };
    case 'run-aborted':
      return { type, runId, reason: 'test' };
    case 'run-failed':
      return { type, runId, error: SAMPLE_ERROR };
    case 'observation-finished':
      return { type, observationId };
    case 'phrase-timeout':
      // The identity of a waiting fragment. `0` when nothing is waiting, which
      // is every state this drives to — so the guard discards it, which is the
      // behaviour the table test should see.
      return { type, pendingSince: context.pendingAnswerSince ?? 0 };
    case 'speech-started':
    case 'speech-finished':
    case 'speech-stopped':
      return { type, speechId };
    case 'speech-failed':
      return { type, speechId, error: SAMPLE_ERROR };
    case 'failure':
      return { type, error: SAMPLE_ERROR };
  }
}
