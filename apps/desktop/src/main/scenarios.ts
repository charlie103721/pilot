import { PilotError } from '@pilot/shared';
import type { PilotViewState } from '@pilot/platform';
import type { FakeInteractionController } from '@pilot/platform/fakes';
import { FIXTURE_WINDOW_RETINA } from '@pilot/platform/fakes';
import type { ViewScenario } from '../ipc/schemas.js';

/**
 * Fake view-state driver.
 *
 * PR-002 ships no platform, agent or voice code, so nothing can *cause* a
 * listening or error state yet. This driver forces the fake interaction
 * controller into each visible state so the shell's rendering can be
 * demonstrated and tested end to end. The interaction lane replaces it when the
 * real controller lands (PR-010); the channel it serves goes away with it.
 */

export const DEMO_FAILURE = new PilotError(
  'helper-unavailable',
  'The Pilot helper process is not running',
  {
    userMessage: 'Pilot lost contact with its screen helper. Observation is unavailable.',
    details: { simulated: true },
  },
);

export type ScenarioDriver = (scenario: ViewScenario) => PilotViewState;

export function createFakeScenarioDriver(controller: FakeInteractionController): ScenarioDriver {
  return (scenario: ViewScenario): PilotViewState => {
    switch (scenario) {
      case 'idle':
        return controller.set({
          state: 'idle',
          speaking: false,
          liveTranscript: null,
          lastError: null,
        });
      case 'listening':
        return controller.set({
          state: 'listening',
          speaking: false,
          liveTranscript: 'what does this toggle do',
          lastError: null,
        });
      case 'thinking':
        return controller.set({
          state: 'thinking',
          speaking: false,
          liveTranscript: null,
          lastError: null,
        });
      case 'speaking':
        return controller.set({ state: 'speaking', speaking: true, lastError: null });
      case 'observing':
        return controller.set({
          state: 'observing',
          observationEnabled: true,
          selectedWindow: FIXTURE_WINDOW_RETINA,
          speaking: false,
          lastError: null,
        });
      case 'error':
        return controller.fail(DEMO_FAILURE.toJSON());
    }
  };
}
