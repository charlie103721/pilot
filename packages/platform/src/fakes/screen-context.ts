import {
  PilotError,
  type ObserveScreenRequest,
  type ObservedWindow,
  type SceneState,
  type ScreenObservation,
  type ScreenStatus,
} from '@pilot/shared';
import type { ScreenContextService } from '../screen-context.js';
import { FAKE_EPOCH_MS, throwIfAborted } from './support.js';
import { createFixtureObservation, FIXTURE_SCENE, FIXTURE_WINDOW_RETINA } from './fixtures.js';

export interface FakeScreenContextServiceOptions {
  /** Observations returned in order; the last one repeats once exhausted. */
  readonly observations?: readonly ScreenObservation[];
  readonly window?: ObservedWindow | null;
  readonly scene?: SceneState | null;
}

/**
 * Deterministic `ScreenContextService`.
 *
 * This is the fake PR-021 uses to build the `observe_screen` tool before
 * PR-019 exists. It enforces the same explicit failure states the real service
 * must expose: disabled, paused, and a scene-lineage mismatch.
 */
export class FakeScreenContextService implements ScreenContextService {
  readonly #observations: readonly ScreenObservation[];
  #cursor = 0;

  readonly requests: ObserveScreenRequest[] = [];
  clearCount = 0;

  enabled = true;
  paused = false;
  /** When set, `observe()` rejects with this error instead of returning. */
  failWith: PilotError | null = null;

  #window: ObservedWindow | null;
  #scene: SceneState | null;

  constructor(options: FakeScreenContextServiceOptions = {}) {
    this.#observations = options.observations ?? [createFixtureObservation()];
    this.#window = options.window === undefined ? FIXTURE_WINDOW_RETINA : options.window;
    this.#scene = options.scene === undefined ? FIXTURE_SCENE : options.scene;
  }

  status(): ScreenStatus {
    return {
      enabled: this.enabled,
      paused: this.paused,
      selectedWindow: this.#window,
      scene: this.#scene,
      permissions: { screenRecording: 'granted', accessibility: 'granted' },
      buffer: {
        frameCount: this.enabled && !this.paused ? 9 : 0,
        byteCount: this.enabled && !this.paused ? 9 * 64 : 0,
        oldestFrameAt: this.enabled && !this.paused ? FAKE_EPOCH_MS : null,
        newestFrameAt: this.enabled && !this.paused ? FAKE_EPOCH_MS + 8 * 333 : null,
      },
      lastError: null,
    };
  }

  async observe(request: ObserveScreenRequest, signal?: AbortSignal): Promise<ScreenObservation> {
    this.requests.push(request);
    throwIfAborted(signal, 'Observation');
    if (this.failWith !== null) {
      throw this.failWith;
    }
    if (!this.enabled) {
      throw new PilotError('observation-disabled', 'Observation is not enabled', {
        userMessage: 'Pilot is not observing a window. Select a window to continue.',
      });
    }
    if (this.paused) {
      throw new PilotError('observation-paused', 'Observation is paused', {
        userMessage: 'Pilot is paused, so it cannot look at your screen.',
      });
    }
    const index = Math.min(this.#cursor, this.#observations.length - 1);
    const observation = this.#observations[index];
    if (observation === undefined) {
      throw new PilotError('frame-unavailable', 'No fixture observations are configured', {
        userMessage: 'Pilot could not capture the window.',
      });
    }
    this.#cursor += 1;
    return observation;
  }

  clear(): void {
    this.clearCount += 1;
    this.#cursor = 0;
  }

  /** Test control: simulate the selected window being closed. */
  loseWindow(): void {
    this.#window = null;
    this.#scene = null;
    this.enabled = false;
  }
}
