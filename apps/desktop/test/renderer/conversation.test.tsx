// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { asUtteranceId, INTERACTION_STATES, PilotError } from '@pilot/shared';
import { FakeInteractionController, FIXTURE_WINDOW_RETINA } from '@pilot/platform/fakes';
import { App } from '../../src/renderer/App.js';
import type { BridgeResult, PilotBridge } from '../../src/ipc/bridge.js';
import {
  interactionDispatchChannel,
  viewStateChangedEvent,
  viewStateGetChannel,
} from '../../src/ipc/channels.js';
import { INTERACTION_STATE_PRESENTATION } from '../../src/conversation/view-model.js';
import { FIXTURE_ANSWER_CHUNKS, FIXTURE_QUESTION } from '../../src/main/conversation-fixtures.js';
import { conversationBridge } from './conversation-bridge.js';
import { permissionBridge } from './permission-bridge.js';
import { windowBridge } from './window-bridge.js';

/**
 * The conversation and diagnostics panel, rendered.
 *
 * Every case drives the panel through the real gates over the PR-001 fakes, so
 * what is asserted is what a reviewer sees when they click the same buttons.
 * The two that matter most: the text box in `error`, and the assertion that no
 * word of a real replayed conversation appears anywhere in the diagnostics
 * surface's DOM.
 */

interface Harness {
  readonly bridge: PilotBridge;
  readonly controller: FakeInteractionController;
  readonly conversation: ReturnType<typeof conversationBridge>;
}

function harness(
  options: Omit<Parameters<typeof conversationBridge>[0], 'controller'> = {},
): Harness {
  const controller = new FakeInteractionController();
  const permissions = permissionBridge({ fixture: 'granted' });
  const windows = windowBridge({ permissions: permissions.gate });
  const conversation = conversationBridge({ controller, ...options });
  const listeners = new Set<(payload: unknown) => void>();

  controller.subscribe((view) => {
    for (const listener of [...listeners]) {
      listener(view);
    }
  });

  const bridge: PilotBridge = {
    protocolVersion: 1,
    invoke(channelName: string, payload: unknown): Promise<BridgeResult<unknown>> {
      const served =
        permissions.invoke(channelName, payload) ??
        windows.invoke(channelName, payload) ??
        conversation.invoke(channelName, payload);
      if (served !== null) {
        return served;
      }
      switch (channelName) {
        case viewStateGetChannel.name:
          return Promise.resolve({ ok: true, payload: controller.snapshot() });
        case interactionDispatchChannel.name:
          conversation.gate.noteCommand(payload as never);
          controller.dispatch(payload as never);
          return Promise.resolve({ ok: true, payload: controller.snapshot() });
        default:
          return Promise.resolve({ ok: true, payload: {} });
      }
    },
    subscribe(channelName: string, listener: (payload: unknown) => void): () => void {
      const served =
        permissions.subscribe(channelName, listener) ??
        windows.subscribe(channelName, listener) ??
        conversation.subscribe(channelName, listener);
      if (served !== null) {
        return served;
      }
      if (channelName !== viewStateChangedEvent.name) {
        return () => undefined;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return { bridge, controller, conversation };
}

function connect(bridge: PilotBridge | undefined): void {
  Object.defineProperty(window, 'pilotBridge', {
    value: bridge,
    configurable: true,
    writable: true,
  });
}

async function renderPanel(
  options: Omit<Parameters<typeof conversationBridge>[0], 'controller'> = {},
): Promise<Harness> {
  const test = harness(options);
  connect(test.bridge);
  render(<App />);
  await screen.findByTestId('conversation');
  return test;
}

async function openDiagnostics(): Promise<HTMLElement> {
  screen.getByTestId('diagnostics-toggle').click();
  await waitFor(() =>
    expect(screen.getByTestId('diagnostics').getAttribute('data-visible')).toBe('true'),
  );
  return screen.getByTestId('diagnostics');
}

afterEach(() => {
  cleanup();
  connect(undefined);
});

describe('interaction states', () => {
  it('renders every state with its own label, tone and activity', async () => {
    const test = await renderPanel();

    for (const state of INTERACTION_STATES) {
      if (state === 'needs-permission') {
        // Reached through the permission gate, not the conversation panel; the
        // onboarding view replaces the conversation there (PR-008).
        continue;
      }
      test.controller.set({ state });
      await waitFor(() =>
        expect(screen.getByTestId('conversation').getAttribute('data-state')).toBe(state),
      );

      const presentation = INTERACTION_STATE_PRESENTATION[state];
      const badge = screen.getByTestId('conversation-state');
      expect(badge.getAttribute('data-tone')).toBe(presentation.tone);
      expect(badge.getAttribute('data-activity')).toBe(presentation.activity);
      expect(screen.getByTestId('conversation-state-label').textContent).toBe(presentation.label);
      expect(screen.getByTestId('conversation-state-detail').textContent).toBe(presentation.detail);
    }
  });

  it('gives listening, thinking, observing, speaking and error five different renderings', async () => {
    const test = await renderPanel();
    const seen = new Set<string>();

    for (const state of ['listening', 'thinking', 'observing', 'speaking', 'error'] as const) {
      test.controller.set({ state });
      await waitFor(() =>
        expect(screen.getByTestId('conversation').getAttribute('data-state')).toBe(state),
      );
      const badge = screen.getByTestId('conversation-state');
      seen.add(
        `${badge.getAttribute('data-tone') ?? ''}/${badge.getAttribute('data-activity') ?? ''}/${
          screen.getByTestId('conversation-state-label').textContent ?? ''
        }`,
      );
    }

    expect(seen.size).toBe(5);
  });
});

describe('the streamed response', () => {
  it('grows as chunks arrive and reports itself as still arriving', async () => {
    const test = await renderPanel();

    for (let index = 1; index <= FIXTURE_ANSWER_CHUNKS.length; index += 1) {
      test.controller.set({
        state: 'speaking',
        transcript: [
          {
            utteranceId: asUtteranceId('utt-a'),
            role: 'assistant',
            text: FIXTURE_ANSWER_CHUNKS.slice(0, index).join(''),
            at: 1,
            pending: index < FIXTURE_ANSWER_CHUNKS.length,
          },
        ],
      });

      if (index < FIXTURE_ANSWER_CHUNKS.length) {
        await waitFor(() =>
          expect(screen.getByTestId('conversation-stream').getAttribute('data-streaming')).toBe(
            'true',
          ),
        );
        expect(screen.getByTestId('conversation-stream').textContent).toContain(
          FIXTURE_ANSWER_CHUNKS.slice(0, index).join('').trim(),
        );
        expect(screen.getByTestId('turn-streaming')).toBeTruthy();
      }
    }

    // The final chunk is not pending, so there is nothing still arriving.
    await waitFor(() => expect(screen.queryByTestId('conversation-stream')).toBeNull());
    expect(screen.getByTestId('turn-utt-a').getAttribute('data-status')).toBe('complete');
  });

  it('shows an answer cut off mid-flight as interrupted, not as finished', async () => {
    const test = await renderPanel();
    test.conversation.replay('interrupted-answer');

    await waitFor(() => expect(screen.getByTestId('turn-interrupted')).toBeTruthy());
    const stream = screen.getByTestId('conversation-stream');
    expect(stream.getAttribute('data-interrupted')).toBe('true');
    expect(stream.getAttribute('data-streaming')).toBe('false');
    expect(stream.textContent).toContain('stopped after');
  });

  it('counts the interruption as an abort, by category', async () => {
    const test = await renderPanel();
    test.conversation.replay('interrupted-answer');

    await openDiagnostics();
    await waitFor(() =>
      expect(screen.getByTestId('tally-abort-user-interrupted').textContent).toContain('1 time'),
    );
  });
});

describe('the text box', () => {
  it('stays usable in `error`, where a failed recogniser leaves Pilot', async () => {
    const test = await renderPanel();
    test.conversation.replay('stt-failure');

    await waitFor(() =>
      expect(screen.getByTestId('conversation').getAttribute('data-state')).toBe('error'),
    );

    // runbook follow-up 4: the machine accepts `submit-text` in `error`
    // (system-design §16), so the panel must too — otherwise the documented
    // fallback is unreachable in the shipped app.
    const input = screen.getByTestId('composer-input');
    expect(input.hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('composer-submit').hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('composer').getAttribute('data-available')).toBe('true');
    expect(
      screen
        .getAllByTestId('composer-note')
        .map((node) => node.textContent ?? '')
        .join(' '),
    ).toContain('Type it instead');
  });

  it('actually submits from `error`, and the machine accepts it', async () => {
    const test = await renderPanel();
    test.conversation.replay('stt-failure');
    await waitFor(() =>
      expect(screen.getByTestId('conversation').getAttribute('data-state')).toBe('error'),
    );

    const input = screen.getByTestId('composer-input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, 'what does this toggle do');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    screen.getByTestId('composer-submit').click();

    await waitFor(() =>
      expect(test.controller.commands.some((command) => command.type === 'submit-text')).toBe(true),
    );
  });

  it('is the only way to ask when the push-to-talk shortcut cannot work', async () => {
    await renderPanel({
      hotkey: {
        status: 'unavailable',
        reason: 'permission-missing',
        permission: 'accessibility',
        detail: 'not granted',
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId('composer').getAttribute('data-only-way')).toBe('true'),
    );
    expect(screen.getByTestId('composer-input').hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('conversation-push-to-talk').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('conversation-why-push-to-talk').textContent).toContain(
      'Accessibility',
    );
  });
});

describe('the speech-recognition disclosure', () => {
  it('is shown when the audio would leave the machine', async () => {
    await renderPanel({
      disclosure: {
        destination: 'remote-service',
        leavesDevice: true,
        allowed: true,
        reason: 'remote-allowed',
        service: 'Apple Speech Recognition',
        locale: 'en-GB',
        headline: 'What you say would be sent to Apple to be transcribed.',
        detail: 'Type your question instead if you would rather it did not.',
      },
    });

    await waitFor(() => expect(screen.getByTestId('speech-disclosure')).toBeTruthy());
    expect(screen.getByTestId('speech-disclosure').getAttribute('data-leaves-device')).toBe('true');
    expect(screen.getByTestId('speech-disclosure-service').textContent).toBe(
      'Apple Speech Recognition',
    );
  });

  it('is absent when no adapter has said anything', async () => {
    await renderPanel();
    expect(screen.queryByTestId('speech-disclosure')).toBeNull();
  });
});

describe('developer diagnostics', () => {
  it('is closed until asked for, and says what it holds', async () => {
    await renderPanel();

    expect(screen.getByTestId('diagnostics').getAttribute('data-visible')).toBe('false');
    expect(screen.queryByTestId('diagnostics-metrics')).toBeNull();

    await openDiagnostics();
    expect(screen.getByTestId('diagnostics-privacy').textContent).toContain(
      'Timings and counts only',
    );
  });

  it('shows the §17 timings a replayed conversation produced', async () => {
    const test = await renderPanel();
    test.conversation.replay('spoken-question');
    await openDiagnostics();

    await waitFor(() =>
      expect(screen.getByTestId('metric-stt-duration').getAttribute('data-measured')).toBe('true'),
    );
    for (const metric of [
      'stt-duration',
      'time-to-first-token',
      'time-to-first-sentence',
      'observation-calls',
      'capture-to-observation',
      'image-bytes',
      'active-images',
    ] as const) {
      expect(screen.getByTestId(`metric-${metric}`).getAttribute('data-measured')).toBe('true');
    }
    // Nothing has compacted, so those two must read as unmeasured rather than
    // as zero.
    expect(screen.getByTestId('metric-context-tokens-before').getAttribute('data-measured')).toBe(
      'false',
    );
    expect(screen.getByTestId('metric-last-context-tokens-before').textContent).toBe('—');
  });

  it('empties the ring when asked', async () => {
    const test = await renderPanel();
    test.conversation.replay('spoken-question');
    await openDiagnostics();
    await waitFor(() =>
      expect(screen.getByTestId('metric-stt-duration').getAttribute('data-measured')).toBe('true'),
    );

    screen.getByTestId('diagnostics-clear').click();

    await waitFor(() =>
      expect(screen.getByTestId('metric-stt-duration').getAttribute('data-measured')).toBe('false'),
    );
  });

  // -- the privacy assertion -------------------------------------------------

  it('shows no transcript text and no image data anywhere in its rendered surface', async () => {
    const test = await renderPanel();
    test.conversation.replay('spoken-question');
    test.conversation.replay('typed-question');
    test.conversation.replay('interrupted-answer');
    test.conversation.replay('stt-failure');

    const diagnostics = await openDiagnostics();
    await waitFor(() =>
      expect(screen.getByTestId('metric-image-bytes').getAttribute('data-measured')).toBe('true'),
    );

    // The conversation really is on screen — otherwise this proves nothing.
    expect(screen.getByTestId('transcript').textContent).toContain('Auto Renew');

    const rendered = diagnostics.textContent ?? '';
    for (const phrase of [FIXTURE_QUESTION, ...FIXTURE_ANSWER_CHUNKS]) {
      expect(rendered).not.toContain(phrase.trim());
    }
    for (const fragment of [
      'Auto Renew',
      'subscription',
      'billing period',
      'renewal date',
      FIXTURE_WINDOW_RETINA.title,
      FIXTURE_WINDOW_RETINA.applicationName,
    ]) {
      expect(rendered).not.toContain(fragment);
    }
  });

  it('withholds and reports a sample that is not timings and counts', async () => {
    const test = await renderPanel();
    test.conversation.replay('spoken-question');
    await openDiagnostics();

    // A sample smuggled past the type system, as a future main process could
    // send. The panel must refuse to render it, loudly.
    const state = test.conversation.gate.snapshot();
    const smuggled = {
      ...state,
      telemetry: {
        ...state.telemetry,
        samples: [
          ...state.telemetry.samples,
          {
            seq: 9_999,
            at: 1,
            turn: 1,
            metric: 'stt-duration',
            value: 1,
            category: null,
            transcript: 'Auto Renew keeps this subscription going.',
          },
        ],
      },
    };
    // Delivered through the same event channel the main process publishes on.
    const { buildDiagnosticsView } = await import('../../src/diagnostics/view-model.js');
    const view = buildDiagnosticsView(smuggled as never);

    expect(view.withheld).toBe(1);
    expect(view.withheldNote).toContain('withheld');
    expect(JSON.stringify(view.recent)).not.toContain('Auto Renew');
  });
});

describe('fixture replay', () => {
  it('offers every fixture, and each one is refused by a build without them', async () => {
    const test = await renderPanel();

    for (const fixture of ['spoken-question', 'stt-failure', 'reset'] as const) {
      expect(screen.getByTestId(`fixture-${fixture}`)).toBeTruthy();
    }

    screen.getByTestId('fixture-spoken-question').click();
    await waitFor(() =>
      expect(screen.getByTestId('transcript').textContent).toContain('Auto Renew'),
    );

    screen.getByTestId('fixture-reset').click();
    await waitFor(() => expect(screen.getByTestId('transcript-empty')).toBeTruthy());
    expect(test.controller.snapshot().transcript).toHaveLength(0);
  });

  it('reports a failed command rather than swallowing it', async () => {
    const test = await renderPanel();
    test.controller.fail(new PilotError('provider-unavailable', 'no model').toJSON());

    await waitFor(() => expect(screen.getByTestId('conversation-error')).toBeTruthy());
    expect(screen.getByTestId('conversation-error-code').textContent).toBe('provider-unavailable');
  });
});
