import {
  asConversationId,
  type InteractionState,
  type ObservedWindow,
  type PermissionSnapshot,
  type SerializedPilotError,
} from '@pilot/shared';
import type {
  InteractionCommand,
  InteractionController,
  PilotViewState,
  TranscriptEntry,
} from '../interaction.js';
import { Emitter } from './support.js';
import { FIXTURE_PERMISSIONS_GRANTED, FIXTURE_WINDOWS } from './fixtures.js';

export const FAKE_INITIAL_VIEW_STATE: PilotViewState = {
  state: 'idle',
  conversationId: asConversationId('conv-fake-0001'),
  permissions: FIXTURE_PERMISSIONS_GRANTED,
  selectedWindow: null,
  observationEnabled: false,
  speaking: false,
  liveTranscript: null,
  transcript: [],
  lastError: null,
};

/**
 * Default command → state mapping.
 *
 * This is *not* the mvp-01 §7 transition table: PR-006 owns that, including
 * illegal transitions and stale-result rejection. This mapping exists only so
 * the desktop lane can drive a panel through the visible states without the
 * real controller.
 */
const DEFAULT_STATE_BY_COMMAND: Partial<Record<InteractionCommand['type'], InteractionState>> = {
  'push-to-talk-down': 'listening',
  'push-to-talk-up': 'transcribing',
  'submit-text': 'thinking',
  'look-now': 'observing-screen',
  interrupt: 'observing',
  pause: 'paused',
  resume: 'observing',
};

export interface FakeInteractionControllerOptions {
  readonly initial?: PilotViewState;
  readonly windows?: readonly ObservedWindow[];
  readonly permissions?: PermissionSnapshot;
}

/**
 * Deterministic `InteractionController`.
 *
 * Every state change is caused by a `dispatch()` call or by an explicit
 * `set()` from the test. Nothing is time-driven.
 */
export class FakeInteractionController implements InteractionController {
  readonly #emitter = new Emitter<PilotViewState>();
  readonly #windows: readonly ObservedWindow[];
  #state: PilotViewState;

  readonly commands: InteractionCommand[] = [];
  disposed = false;

  constructor(options: FakeInteractionControllerOptions = {}) {
    this.#windows = options.windows ?? FIXTURE_WINDOWS;
    this.#state = {
      ...(options.initial ?? FAKE_INITIAL_VIEW_STATE),
      ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
    };
  }

  subscribe = this.#emitter.subscribe;

  snapshot(): PilotViewState {
    return this.#state;
  }

  dispatch(command: InteractionCommand): void {
    this.commands.push(command);
    switch (command.type) {
      case 'select-window': {
        const selectedWindow =
          this.#windows.find((window) => window.windowId === command.windowId) ?? null;
        this.set({ selectedWindow, state: selectedWindow === null ? 'idle' : 'observing' });
        return;
      }
      case 'set-observation-enabled': {
        this.set({
          observationEnabled: command.enabled,
          state: command.enabled ? 'observing' : 'idle',
        });
        return;
      }
      case 'stop-speaking': {
        this.set({ speaking: false, state: 'observing' });
        return;
      }
      case 'clear-conversation': {
        this.set({ transcript: [], liveTranscript: null, lastError: null });
        return;
      }
      default: {
        const next = DEFAULT_STATE_BY_COMMAND[command.type];
        if (next !== undefined) {
          this.set({ state: next });
        }
        return;
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  /** Test control: patch the view state and notify subscribers. */
  set(patch: Partial<PilotViewState>): PilotViewState {
    this.#state = { ...this.#state, ...patch };
    this.#emitter.emit(this.#state);
    return this.#state;
  }

  /** Test control: append a transcript entry, as the real controller would. */
  appendTranscript(entry: TranscriptEntry): PilotViewState {
    return this.set({ transcript: [...this.#state.transcript, entry] });
  }

  /** Test control: put the controller into its explicit error state. */
  fail(error: SerializedPilotError): PilotViewState {
    return this.set({ state: 'error', lastError: error });
  }
}
