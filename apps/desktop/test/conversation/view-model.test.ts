import { describe, expect, it } from 'vitest';
import {
  asUtteranceId,
  INTERACTION_STATES,
  PilotError,
  type InteractionState,
} from '@pilot/shared';
import { isTextFallbackAvailable, lookupRule } from '@pilot/interaction';
import {
  FakeInteractionController,
  FIXTURE_PERMISSIONS_GRANTED,
  FIXTURE_WINDOW_RETINA,
} from '@pilot/platform/fakes';
import type { PilotViewState } from '@pilot/platform';
import { DEFAULT_TELEMETRY_CAPACITY, type ConversationGateState } from '../../src/ipc/schemas.js';
import {
  buildConversationView,
  commandIsAccepted,
  conversationControl,
  COMPOSER_NOTES,
  INTERACTION_STATE_PRESENTATION,
} from '../../src/conversation/view-model.js';
import { buildObservationView } from '../../src/observation/view-model.js';
import { buildPermissionOnboardingView } from '../../src/permissions/view-model.js';

/**
 * The conversation view model.
 *
 * The single most important assertion in this file is the one about the text
 * box in `error`. Everything else describes how the panel reads; that one is
 * the difference between the documented STT fallback existing in the app and
 * existing only in the transition table (runbook follow-up 4).
 */

const NOW = 1_700_000_000_000;

const BASE_GATE: ConversationGateState = {
  telemetry: { samples: [], capacity: DEFAULT_TELEMETRY_CAPACITY, recorded: 0, dropped: 0 },
  diagnosticsVisible: false,
  pushToTalk: {
    usable: true,
    status: 'active',
    message: null,
    blockingPermission: null,
    label: 'Right Option',
  },
  disclosure: null,
  fixture: null,
  demoFixtures: true,
  modelDisclosure: null,
  modelStatus: null,
};

function view(patch: Partial<PilotViewState> = {}, gate: Partial<ConversationGateState> = {}) {
  const controller = new FakeInteractionController();
  controller.set({ permissions: FIXTURE_PERMISSIONS_GRANTED, ...patch });
  const pilotView = controller.snapshot();
  return buildConversationView({
    view: pilotView,
    gate: { ...BASE_GATE, ...gate },
    observation: buildObservationView({
      gate: {
        windows: [FIXTURE_WINDOW_RETINA],
        listedAt: NOW,
        listing: false,
        notice: null,
        lastError: null,
        demoEvents: true,
      },
      view: pilotView,
      permissions: buildPermissionOnboardingView({
        snapshot: FIXTURE_PERMISSIONS_GRANTED,
        pending: [],
        checkedAt: NOW,
        settings: { available: false, platform: 'linux', reason: 'no pane here' },
        lastError: null,
        fixture: 'granted',
      }),
    }),
  });
}

describe('interaction states', () => {
  it('gives every state its own words', () => {
    const labels = INTERACTION_STATES.map((state) => INTERACTION_STATE_PRESENTATION[state].label);
    const details = INTERACTION_STATES.map((state) => INTERACTION_STATE_PRESENTATION[state].detail);

    expect(new Set(labels).size).toBe(INTERACTION_STATES.length);
    expect(new Set(details).size).toBe(INTERACTION_STATES.length);
    for (const detail of details) {
      expect(detail.length).toBeGreaterThan(20);
    }
  });

  it('makes the five named states tellable apart without reading', () => {
    // The PR names these five: listening, thinking, observing, speaking, error.
    // Distinct tone *and* activity means a distinct colour, a distinct pulse
    // and a distinct data attribute, not merely a different sentence.
    const named: readonly InteractionState[] = [
      'listening',
      'thinking',
      'observing',
      'speaking',
      'error',
    ];
    const signatures = named.map((state) => {
      const presentation = INTERACTION_STATE_PRESENTATION[state];
      return `${presentation.tone}/${presentation.activity}`;
    });

    expect(new Set(signatures).size).toBe(named.length);
  });

  it('renders each state through the view, with its own tone and activity', () => {
    for (const state of INTERACTION_STATES) {
      const rendered = view({ state });
      expect(rendered.state).toBe(state);
      expect(rendered.stateLabel).toBe(INTERACTION_STATE_PRESENTATION[state].label);
      expect(rendered.tone).toBe(INTERACTION_STATE_PRESENTATION[state].tone);
      expect(rendered.activity).toBe(INTERACTION_STATE_PRESENTATION[state].activity);
    }
  });

  it('reads "is Pilot capturing" from the observation view and never re-derives it', () => {
    const off = view({ selectedWindow: FIXTURE_WINDOW_RETINA, observationEnabled: false });
    const on = view({
      state: 'observing',
      selectedWindow: FIXTURE_WINDOW_RETINA,
      observationEnabled: true,
    });

    expect(off.capturing).toBe(false);
    expect(on.capturing).toBe(true);
  });
});

describe('typed user guidance (PR-040)', () => {
  it('gives every failure a remedy and an ending, beside the message', () => {
    const rendered = view({
      state: 'error',
      lastError: new PilotError('protected-content', 'stream state = protected', {
        userMessage: 'This application does not allow Pilot to see its window.',
      }).toJSON(),
    });

    // The message is the producer's; the remedy and the ending are the
    // taxonomy's. The panel renders both and decides neither.
    expect(rendered.recovery?.userMessage).toContain('does not allow Pilot to see its window');
    expect(rendered.recovery?.remedy).toContain('different window');
    expect(rendered.recovery?.disposition).toBe('safe-terminal');
  });

  it('answers for a failure raised by code that never heard of it', () => {
    const rendered = view({
      state: 'error',
      lastError: new PilotError('internal', 'something in a dependency threw').toJSON(),
    });

    expect(rendered.recovery).not.toBeNull();
    expect(rendered.recovery?.remedy.length).toBeGreaterThan(20);
  });

  it('has nothing to say when there is no failure', () => {
    expect(view({ state: 'observing' }).recovery).toBeNull();
  });
});

describe('the text box', () => {
  it('is available in `error`, which is where a failed recogniser leaves Pilot', () => {
    const rendered = view({
      state: 'error',
      lastError: new PilotError('speech-input-failed', 'no').toJSON(),
    });

    // system-design §16: "STT fails → … then offer text input". PR-025 made
    // `error + submit-text` legal for exactly this. Disabling the box here
    // makes the documented fallback unreachable in the shipped app.
    expect(rendered.composer.available).toBe(true);
    expect(rendered.composer.unavailableReason).toBeNull();
    expect(rendered.composer.notes).toContain(COMPOSER_NOTES.afterFailure);
  });

  it('agrees with the transition table in every state, without a table of its own', () => {
    for (const state of INTERACTION_STATES) {
      expect(view({ state }).composer.available).toBe(isTextFallbackAvailable(state));
    }
  });

  it('says why it is the only way to ask when the shortcut cannot be used', () => {
    const rendered = view(
      { state: 'observing' },
      {
        pushToTalk: {
          usable: false,
          status: 'unavailable',
          message: 'Pilot needs Accessibility permission. Until then, type your question instead.',
          blockingPermission: 'accessibility',
          label: 'Right Option',
        },
      },
    );

    expect(rendered.composer.available).toBe(true);
    expect(rendered.composer.onlyWayToAsk).toBe(true);
    expect(rendered.composer.notes.join(' ')).toContain('Accessibility');
    expect(conversationControl(rendered, 'push-to-talk').available).toBe(false);
  });

  it('gives a reason whenever it is unavailable, never a silently dead box', () => {
    for (const state of INTERACTION_STATES) {
      const composer = view({ state }).composer;
      expect(composer.unavailableReason === null).toBe(composer.available);
    }
  });
});

describe('controls', () => {
  it('derives availability from the transition table rather than a hand-written switch', () => {
    for (const state of INTERACTION_STATES) {
      const rendered = view({ state, transcript: [] });
      expect(conversationControl(rendered, 'look-now').available).toBe(
        commandIsAccepted(state, 'look-now'),
      );
      expect(conversationControl(rendered, 'interrupt').available).toBe(
        lookupRule(state, 'interrupt').kind === 'accept',
      );
    }
  });

  it('will not offer to clear an empty conversation', () => {
    expect(conversationControl(view({ state: 'observing' }), 'clear-conversation')).toMatchObject({
      available: false,
      unavailableReason: 'There is nothing to clear.',
    });
  });

  it('names the shortcut on the push-to-talk button', () => {
    expect(conversationControl(view({ state: 'observing' }), 'push-to-talk').label).toBe(
      'Hold to talk (Right Option)',
    );
  });
});

describe('transcript and streamed response', () => {
  const streaming = (pending: boolean, state: InteractionState) =>
    view({
      state,
      transcript: [
        {
          utteranceId: asUtteranceId('utt-q'),
          role: 'user',
          text: 'what does this do',
          at: NOW,
          pending: false,
        },
        {
          utteranceId: asUtteranceId('utt-a'),
          role: 'assistant',
          text: 'It keeps the subscription going.',
          at: NOW,
          pending,
        },
      ],
    });

  it('shows an answer still arriving as a stream, with its length', () => {
    const rendered = streaming(true, 'speaking');

    expect(rendered.stream).toMatchObject({ streaming: true, interrupted: false });
    expect(rendered.stream?.characters).toBe('It keeps the subscription going.'.length);
    expect(rendered.turns.at(-1)?.status).toBe('streaming');
  });

  it('shows a completed answer as no stream at all', () => {
    const rendered = streaming(false, 'observing');

    expect(rendered.stream).toBeNull();
    expect(rendered.turns.at(-1)?.status).toBe('complete');
  });

  it('reports an answer that stopped arriving as interrupted, not as finished', () => {
    // What an interruption leaves behind: a pending entry with a machine that
    // has stopped working. Rendering it as complete would misreport it.
    const rendered = streaming(true, 'observing');

    expect(rendered.turns.at(-1)?.status).toBe('interrupted');
    expect(rendered.stream).toMatchObject({ streaming: false, interrupted: true });
  });

  it('distinguishes an empty conversation from one still being recognised', () => {
    expect(view({ transcript: [] }).empty).toBe(true);
    expect(view({ transcript: [], liveTranscript: 'what does' }).empty).toBe(false);
  });
});

describe('the speech disclosure', () => {
  it('flags audio leaving the machine as needing attention', () => {
    const rendered = view(
      {},
      {
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
      },
    );

    expect(rendered.disclosure).toMatchObject({
      needsAttention: true,
      leavesDevice: true,
      destination: 'on a remote service',
    });
  });

  it('flags a refusal to listen as needing attention too', () => {
    const rendered = view(
      {},
      {
        disclosure: {
          destination: 'unknown',
          leavesDevice: false,
          allowed: false,
          reason: 'on-device-unsupported',
          service: null,
          locale: 'cy-GB',
          headline: 'Pilot will not listen in this language.',
          detail: 'Type your question instead.',
        },
      },
    );

    // Two different surprises, both worth interrupting for: audio leaving, and
    // Pilot silently not listening at all.
    expect(rendered.disclosure?.needsAttention).toBe(true);
  });

  it('shows nothing when no adapter has said anything', () => {
    expect(view().disclosure).toBeNull();
  });
});
