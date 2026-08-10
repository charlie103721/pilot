// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { asUtteranceId, PilotError } from '@pilot/shared';
import { FakeInteractionController, FIXTURE_WINDOW_RETINA } from '@pilot/platform/fakes';
import type { PilotViewState } from '@pilot/platform';
import { App } from '../../src/renderer/App.js';
import type { BridgeResult, PilotBridge } from '../../src/ipc/bridge.js';
import {
  demoScenarioChannel,
  interactionDispatchChannel,
  viewStateChangedEvent,
  viewStateGetChannel,
} from '../../src/ipc/channels.js';
import { createFakeScenarioDriver } from '../../src/main/scenarios.js';
import type { ViewScenario } from '../../src/ipc/schemas.js';

/**
 * Renderer smoke tests.
 *
 * The panel is driven through the same bridge shape the preload exposes, backed
 * by the PR-001 fake interaction controller, so the states asserted here are the
 * states the real shell produces.
 */

interface Harness {
  readonly bridge: PilotBridge;
  readonly controller: FakeInteractionController;
  readonly invocations: string[];
  /** Forces the next `invoke` on any channel to fail with this error. */
  failNext(error: PilotError): void;
}

function harness(): Harness {
  const controller = new FakeInteractionController();
  const driver = createFakeScenarioDriver(controller);
  const listeners = new Set<(payload: unknown) => void>();
  const invocations: string[] = [];
  let pendingFailure: PilotError | null = null;

  controller.subscribe((view) => {
    for (const listener of listeners) {
      listener(view);
    }
  });

  const ok = <T,>(payload: T): BridgeResult<T> => ({ ok: true, payload });

  const bridge: PilotBridge = {
    protocolVersion: 1,
    invoke(channelName: string, payload: unknown): Promise<BridgeResult<unknown>> {
      invocations.push(channelName);
      if (pendingFailure !== null) {
        const error = pendingFailure;
        pendingFailure = null;
        return Promise.resolve({ ok: false, error: error.toJSON() });
      }
      switch (channelName) {
        case viewStateGetChannel.name:
          return Promise.resolve(ok(controller.snapshot()));
        case interactionDispatchChannel.name:
          controller.dispatch(payload as never);
          return Promise.resolve(ok(controller.snapshot()));
        case demoScenarioChannel.name:
          return Promise.resolve(ok(driver(payload as ViewScenario)));
        default:
          return Promise.resolve(ok({}));
      }
    },
    subscribe(channelName: string, listener: (payload: unknown) => void): () => void {
      if (channelName !== viewStateChangedEvent.name) {
        return () => undefined;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    bridge,
    controller,
    invocations,
    failNext(error: PilotError) {
      pendingFailure = error;
    },
  };
}

function connect(bridge: PilotBridge | undefined): void {
  Object.defineProperty(window, 'pilotBridge', {
    value: bridge,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  cleanup();
  connect(undefined);
});

describe('panel', () => {
  it('renders an explicit unavailable state when the preload bridge is missing', async () => {
    connect(undefined);

    render(<App />);

    expect(await screen.findByTestId('panel-unavailable')).toBeTruthy();
    expect(screen.getByTestId('error-code').textContent).toBe('platform-unavailable');
    // Never a blank window.
    expect(screen.getByRole('alert').textContent).toContain('Quit Pilot and open it again');
  });

  it('renders the idle state once connected', async () => {
    connect(harness().bridge);

    render(<App />);

    expect((await screen.findByTestId('state-pill')).textContent).toBe('Idle');
    expect(screen.getByTestId('selected-window').textContent).toBe('None selected');
    expect(screen.getByTestId('observation-state').textContent).toBe('Off');
    expect(screen.getByTestId('transcript-empty')).toBeTruthy();
  });

  it('follows main-process view state changes without being asked', async () => {
    const test = harness();
    connect(test.bridge);

    render(<App />);
    await screen.findByTestId('state-pill');

    test.controller.set({ state: 'listening', liveTranscript: 'what does this toggle do' });

    await waitFor(() => {
      expect(screen.getByTestId('state-pill').textContent).toBe('Listening');
    });
    expect(screen.getByTestId('live-transcript').textContent).toBe('what does this toggle do');
  });

  it('renders every fake scenario reachable from the demo bar', async () => {
    const test = harness();
    connect(test.bridge);

    render(<App />);
    await screen.findByTestId('state-pill');

    const expected: Readonly<Record<ViewScenario, string>> = {
      idle: 'Idle',
      listening: 'Listening',
      thinking: 'Thinking',
      speaking: 'Speaking',
      observing: 'Observing',
      error: 'Error',
    };

    for (const [scenario, label] of Object.entries(expected) as [ViewScenario, string][]) {
      screen.getByTestId(`scenario-${scenario}`).click();
      await waitFor(() => {
        expect(screen.getByTestId('state-pill').textContent).toBe(label);
      });
    }
  });

  it('shows the failure banner with a typed code in the error state', async () => {
    const test = harness();
    connect(test.bridge);

    render(<App />);
    await screen.findByTestId('state-pill');

    screen.getByTestId('scenario-error').click();

    await waitFor(() => {
      expect(screen.getByTestId('error-banner')).toBeTruthy();
    });
    expect(screen.getByTestId('error-code').textContent).toBe('helper-unavailable');
  });

  it('shows a rejected command instead of dropping it silently', async () => {
    const test = harness();
    connect(test.bridge);

    render(<App />);
    await screen.findByTestId('state-pill');

    test.failNext(
      new PilotError('invalid-request', 'schema rejected the payload', {
        userMessage: 'Pilot could not understand that action.',
      }),
    );
    screen.getByTestId('scenario-idle').click();

    await waitFor(() => {
      expect(screen.getByTestId('error-code').textContent).toBe('invalid-request');
    });
  });

  it('surfaces an unreachable main process rather than staying on "Connecting…"', async () => {
    const test = harness();
    connect(test.bridge);
    test.failNext(new PilotError('internal', 'main process is gone'));

    render(<App />);

    expect(await screen.findByTestId('panel-unavailable')).toBeTruthy();
  });

  it('renders the selected window and transcript entries', async () => {
    const test = harness();
    connect(test.bridge);

    render(<App />);
    await screen.findByTestId('state-pill');

    test.controller.set({ selectedWindow: FIXTURE_WINDOW_RETINA, observationEnabled: true });
    test.controller.appendTranscript({
      utteranceId: asUtteranceId('utt-0001'),
      role: 'user',
      text: 'what does this toggle do',
      at: 1_700_000_000_000,
      pending: false,
    });

    await waitFor(() => {
      expect(screen.getByTestId('selected-window').textContent).toBe('Safari — Billing Settings');
    });
    expect(screen.getByTestId('observation-state').textContent).toBe('On');
    expect(screen.getByText('what does this toggle do')).toBeTruthy();
  });

  it('sends interaction commands over the dispatch channel', async () => {
    const test = harness();
    connect(test.bridge);

    render(<App />);
    await screen.findByTestId('state-pill');

    screen.getByText('Look now').click();

    await waitFor(() => {
      expect(test.controller.commands).toEqual([{ type: 'look-now' }]);
    });
    expect(test.invocations).toContain(interactionDispatchChannel.name);

    const view: PilotViewState = test.controller.snapshot();
    expect(view.state).toBe('observing-screen');
  });
});
