import { describe, expect, it } from 'vitest';
import { PilotError, type PilotErrorCode, type SerializedPilotError } from '@pilot/shared';
import { FakeInteractionController, FIXTURE_WINDOW_RETINA } from '@pilot/platform/fakes';
import {
  OBSERVATION_FAILURE_HINTS,
  OBSERVATION_FAILURE_TOOL,
  readObservationFailure,
} from '../../src/observation/failure-view.js';
import {
  OBSERVATION_LOOKING_NOTE,
  buildObservationView,
} from '../../src/observation/view-model.js';
import { buildConversationView } from '../../src/conversation/view-model.js';
import { buildPermissionOnboardingView } from '../../src/permissions/view-model.js';
import type {
  ConversationGateState,
  PermissionGateState,
  WindowGateState,
} from '../../src/ipc/schemas.js';
import { PERMISSION_FIXTURE_SNAPSHOTS } from '../../src/main/permission-fixtures.js';

/**
 * PR-030 — what the user sees when Pilot looks, and when a look is refused.
 *
 * Pure view-model tests: no Electron, no helper, no model. They are the half of
 * PR-030's UI work that must hold whatever the platform does, and they are here
 * rather than in a renderer suite because the decisions are made in these two
 * files and the components only render them.
 *
 * The renderer-side counterpart (that the panel actually puts the sentence on
 * screen) is in `test/renderer/conversation.test.tsx`.
 */

const WINDOW_GATE: WindowGateState = {
  windows: [FIXTURE_WINDOW_RETINA],
  listedAt: 1_700_000_000_000,
  listing: false,
  notice: null,
  lastError: null,
  demoEvents: false,
};

const CONVERSATION_GATE: ConversationGateState = {
  pushToTalk: null,
  disclosure: null,
  diagnosticsVisible: false,
  demoFixtures: false,
  fixture: null,
  modelDisclosure: null,
  telemetry: { samples: [], dropped: 0, capacity: 128, recorded: 0 },
};

const PERMISSION_GATE: PermissionGateState = {
  snapshot: PERMISSION_FIXTURE_SNAPSHOTS.granted,
  pending: [],
  checkedAt: 1_700_000_000_000,
  settings: { available: false, platform: 'linux', reason: 'no System Settings here' },
  lastError: null,
  fixture: 'granted',
};

function views(controller: FakeInteractionController) {
  const view = controller.snapshot();
  const permissions = buildPermissionOnboardingView(PERMISSION_GATE);
  const observation = buildObservationView({ gate: WINDOW_GATE, view, permissions });
  return {
    observation,
    conversation: buildConversationView({ view, gate: CONVERSATION_GATE, observation }),
  };
}

function toolFailure(
  code: PilotErrorCode,
  failure: string,
  options: { readonly userMessage: string; readonly retryable: boolean; readonly rule?: string },
): SerializedPilotError {
  return new PilotError(code, 'technical detail nobody should be shown', {
    userMessage: options.userMessage,
    retryable: options.retryable,
    details: {
      tool: OBSERVATION_FAILURE_TOOL,
      failure,
      view: 'window',
      moment: 'current',
      ...(options.rule === undefined ? {} : { policyRule: options.rule }),
    },
  }).toJSON();
}

describe('reading an observation refusal off an error', () => {
  it('recognises one and carries the sentence, the kind and the rule', () => {
    const failure = readObservationFailure(
      toolFailure('permission-denied', 'permission-denied', {
        userMessage: 'Pilot needs Screen Recording permission to look at your screen.',
        retryable: false,
        rule: 'screen-recording-permission',
      }),
    );

    expect(failure).toEqual({
      failure: 'permission-denied',
      code: 'permission-denied',
      userMessage: 'Pilot needs Screen Recording permission to look at your screen.',
      retryable: false,
      hint: OBSERVATION_FAILURE_HINTS.final,
      policyRule: 'screen-recording-permission',
    });
  });

  it('says looking again may help when the failure is retryable', () => {
    const failure = readObservationFailure(
      toolFailure('rate-limited', 'policy-rejected', {
        userMessage: 'Pilot limited how much of your screen it sends at once.',
        retryable: true,
        rule: 'rate-limit',
      }),
    );

    expect(failure?.retryable).toBe(true);
    expect(failure?.hint).toBe(OBSERVATION_FAILURE_HINTS.retryable);
  });

  it('is null for every failure that is not a refused look', () => {
    expect(readObservationFailure(null)).toBeNull();
    // A failed run. `internal` is produced by everything in the app, so a code
    // test alone would misreport this as a screen problem.
    expect(
      readObservationFailure(new PilotError('internal', 'the run fell over').toJSON()),
    ).toBeNull();
    // Another tool's failure, and a malformed marker.
    expect(
      readObservationFailure(
        new PilotError('internal', 'x', { details: { tool: 'other_tool', failure: 'x' } }).toJSON(),
      ),
    ).toBeNull();
    expect(
      readObservationFailure(
        new PilotError('internal', 'x', {
          details: { tool: OBSERVATION_FAILURE_TOOL, failure: 7 },
        }).toJSON(),
      ),
    ).toBeNull();
  });
});

describe('the conversation view surfaces a refused look', () => {
  it('pairs the readable sentence with the technical error the banner already had', () => {
    const controller = new FakeInteractionController();
    const error = toolFailure('window-closed', 'window-lost', {
      userMessage: 'The window Pilot was watching is gone. Select a window again.',
      retryable: false,
    });
    controller.fail(error);

    const { conversation } = views(controller);
    expect(conversation.lastError).toEqual(error);
    expect(conversation.observationFailure?.failure).toBe('window-lost');
    expect(conversation.observationFailure?.userMessage).toBe(
      'The window Pilot was watching is gone. Select a window again.',
    );
    // The technical message is never the thing shown.
    expect(conversation.observationFailure?.userMessage).not.toContain('technical detail');
  });

  it('leaves it null when the failure had nothing to do with the screen', () => {
    const controller = new FakeInteractionController();
    controller.fail(new PilotError('provider-unavailable', 'no model').toJSON());
    expect(views(controller).conversation.observationFailure).toBeNull();
  });
});

describe('the observation indicator shows that Pilot is looking right now', () => {
  it('is true in `observing-screen` and false in every other state', () => {
    const controller = new FakeInteractionController();
    controller.set({
      selectedWindow: FIXTURE_WINDOW_RETINA,
      state: 'observing',
      observationEnabled: true,
    });

    const watching = views(controller).observation;
    expect(watching.capturing).toBe(true);
    expect(watching.looking).toBe(false);
    expect(watching.lookingNote).toBeNull();

    controller.set({ state: 'observing-screen' });
    const looking = views(controller).observation;
    expect(looking.looking).toBe(true);
    expect(looking.lookingNote).toBe(OBSERVATION_LOOKING_NOTE);
    // Not a re-derivation of `capturing`: both are true here, and they answer
    // different questions.
    expect(looking.capturing).toBe(true);
    expect(looking.indicator).toBe('observing');

    controller.set({ state: 'thinking' });
    expect(views(controller).observation.looking).toBe(false);
  });

  it('says so in the conversation panel too, in its own words', () => {
    const controller = new FakeInteractionController();
    controller.set({
      selectedWindow: FIXTURE_WINDOW_RETINA,
      state: 'observing-screen',
      observationEnabled: true,
    });
    const { conversation } = views(controller);
    expect(conversation.activity).toBe('looking');
    expect(conversation.stateLabel).toBe('Looking at the screen');
    expect(conversation.busy).toBe(true);
  });
});
