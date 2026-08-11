import { describe, expect, it } from 'vitest';
import {
  PilotError,
  asObservationId,
  asSceneId,
  asUtteranceId,
  asWindowId,
  type ObservedWindow,
  type PermissionSnapshot,
  type SceneState,
} from '@pilot/shared';
import { FIXTURE_PERMISSIONS_GRANTED, FIXTURE_WINDOW_RETINA } from '@pilot/platform/fakes';
import type {
  InteractionCommand,
  ObservationEvent,
  PilotViewState,
  SpeechInputAdapter,
  Unsubscribe,
} from '@pilot/platform';
import type { InteractionEvent, ObservationControlPort } from '@pilot/interaction';
import type { RetentionEvent } from '@pilot/observation';
import type { HelperCrashReport, HelperTransportState } from '@pilot/platform-mac';
import { readLifecycleGuidance } from '../../src/lifecycle/guidance.js';
import {
  createLifecycleRuntime,
  reprobeAttribution,
  type LifecycleRuntime,
} from '../../src/main/lifecycle-runtime.js';

/**
 * The lifecycle seam (PR-040).
 *
 * These drive `createLifecycleRuntime` over hand-written ports rather than over
 * the rig, because what is under test is the *decision* — which failures reach
 * the interaction machine, which reach only the panel's §16 notice, which
 * retention occasion is armed, and what a restarted helper causes Pilot to
 * re-read. `pnpm demo:failure` is the same decisions against the real adapters.
 *
 * The one rule they are all about: **a failure of the watching costs the
 * watching, never the answer** (runbook cross-lane issue 15, one level up).
 */

interface Harness {
  readonly lifecycle: LifecycleRuntime;
  readonly events: InteractionEvent[];
  readonly commands: InteractionCommand[];
  readonly retention: RetentionEvent[];
  readonly notices: { reason: string; wasObserving: boolean }[];
  readonly restored: { count: number };
  setState(state: PilotViewState['state']): void;
  setScene(scene: SceneState | null): void;
  capture(event: ObservationEvent): void;
  crash(report?: Partial<HelperCrashReport>): void;
  transport(state: HelperTransportState): void;
}

function viewState(state: PilotViewState['state'], window: ObservedWindow | null): PilotViewState {
  return {
    state,
    conversationId: null,
    permissions: null,
    selectedWindow: window,
    observationEnabled: window !== null,
    speaking: false,
    liveTranscript: null,
    transcript: [],
    lastError: null,
  };
}

function crashReport(overrides: Partial<HelperCrashReport> = {}): HelperCrashReport {
  return {
    at: 1_700_000_000_000,
    reason: 'exit',
    pid: 4321,
    exitCode: 9,
    signal: null,
    uptimeMs: 1_200,
    restartsInWindow: 1,
    willRestart: true,
    restartDelayMs: 250,
    abandonedRequests: 1,
    stderrTail: [],
    error: new PilotError('helper-unavailable', 'helper exited during capture.pull'),
    ...overrides,
  };
}

function harness(options: { readonly scene?: SceneState | null } = {}): Harness {
  const events: InteractionEvent[] = [];
  const commands: InteractionCommand[] = [];
  const retention: RetentionEvent[] = [];
  const notices: { reason: string; wasObserving: boolean }[] = [];
  const restored = { count: 0 };
  const listeners = new Set<(view: PilotViewState) => void>();
  let captureListener: ((event: ObservationEvent) => void) | null = null;
  let crashListener: ((report: HelperCrashReport) => void) | null = null;
  let stateListener: ((state: HelperTransportState) => void) | null = null;
  let view = viewState('observing', FIXTURE_WINDOW_RETINA);
  let scene: SceneState | null = options.scene ?? null;

  const lifecycle = createLifecycleRuntime({
    interaction: {
      snapshot: () => view,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      send: (event) => {
        events.push(event);
      },
      dispatch: (command) => {
        commands.push(command);
      },
    },
    observation: {
      noteRetentionEvent: (event) => {
        retention.push(event);
      },
      scene: () => scene,
    },
    capture: {
      start: async () => undefined,
      stop: async () => undefined,
      subscribe: () => (): void => undefined,
      subscribeEvents: (listener: (event: ObservationEvent) => void): Unsubscribe => {
        captureListener = listener;
        return () => {
          captureListener = null;
        };
      },
    } as never,
    transport: {
      on: ((event: string, listener: unknown): Unsubscribe => {
        if (event === 'crash') {
          crashListener = listener as (report: HelperCrashReport) => void;
        } else {
          stateListener = listener as (state: HelperTransportState) => void;
        }
        return () => undefined;
      }) as never,
    },
    notices: {
      noteObservationStopped: (reason, _window, wasObserving) => {
        notices.push({ reason, wasObserving });
      },
    },
    onHelperRestored: async () => {
      restored.count += 1;
    },
    delay: async () => undefined,
    clock: () => 1_700_000_000_000,
  });
  lifecycle.start();

  return {
    lifecycle,
    events,
    commands,
    retention,
    notices,
    restored,
    setState(state) {
      view = viewState(state, FIXTURE_WINDOW_RETINA);
      for (const listener of [...listeners]) {
        listener(view);
      }
    },
    setScene(next) {
      scene = next;
    },
    capture(event) {
      captureListener?.(event);
    },
    crash(overrides = {}) {
      crashListener?.(crashReport(overrides));
    },
    transport(state) {
      stateListener?.(state);
    },
  };
}

function scene(revision: number): SceneState {
  return {
    sceneId: asSceneId('scene-1'),
    revision,
    windowId: asWindowId('window-42'),
    windowTitle: 'Billing Settings',
    fingerprint: `fp-${String(revision)}`,
    updatedAt: 1_700_000_000_000,
    lastObservedRevision: revision,
  };
}

function revoked(kind: 'screen-recording' | 'accessibility'): PermissionSnapshot {
  return {
    ...FIXTURE_PERMISSIONS_GRANTED,
    [kind]: { kind, state: 'denied', canRequest: false },
  };
}

describe('a window that blocks capture', () => {
  it('tells the user, switches watching off and names the occasion', () => {
    const test = harness();

    test.capture({
      type: 'capture-stopped',
      reason: 'protected-content',
      error: new PilotError('protected-content', 'blocked', {
        userMessage: 'This application does not allow Pilot to see its window.',
      }),
    });

    expect(test.retention).toEqual(['observation-disabled']);
    expect(test.commands).toEqual([{ type: 'set-observation-enabled', enabled: false }]);
    const failure = test.events.at(-1);
    expect(failure?.type).toBe('failure');
    const guidance = readLifecycleGuidance(failure?.type === 'failure' ? failure.error : null);
    expect(guidance?.failure).toBe('capture-blocked');
    expect(guidance?.disposition).toBe('safe-terminal');
    expect(guidance?.userMessage).toContain('does not allow Pilot to see its window');
    expect(test.notices.at(-1)?.reason).toBe('capture-unavailable');
  });

  it('switches off before it explains, or the explanation is erased', () => {
    // `set-observation-enabled` patches `lastError: null`. The order is the
    // whole of the fix, so it is asserted rather than commented.
    const test = harness();

    test.capture({ type: 'capture-stopped', reason: 'failed' });

    expect(test.commands).toHaveLength(1);
    expect(test.events).toHaveLength(1);
  });

  it('says nothing twice for a stop the table already owns', () => {
    const test = harness();

    test.capture({ type: 'capture-stopped', reason: 'window-lost' });
    test.capture({ type: 'capture-stopped', reason: 'screen-locked' });
    test.capture({ type: 'capture-stopped', reason: 'requested' });

    expect(test.events).toEqual([]);
    expect(test.notices).toEqual([]);
  });
});

describe('a failure while a question is in flight', () => {
  it('does not tear the answer down, and does not post a rejected command', () => {
    const test = harness();
    test.setState('speaking');

    test.capture({ type: 'capture-stopped', reason: 'protected-content' });

    // Neither of these may happen while the machine is busy: `failure` runs
    // teardown, and `set-observation-enabled` is refused as
    // `illegal-transition` — which is itself a `lastError` reading "Pilot
    // cannot do that right now."
    expect(test.events).toEqual([]);
    expect(test.commands).toEqual([]);
    // The user is told at once, on the surface that does not interrupt.
    expect(test.notices.at(-1)?.reason).toBe('capture-unavailable');
    expect(test.lifecycle.records.at(-1)?.surfaced).toBe('notice');
  });

  it('delivers it the moment the answer is finished', () => {
    const test = harness();
    test.setState('thinking');
    test.capture({ type: 'capture-stopped', reason: 'protected-content' });
    expect(test.events).toEqual([]);

    test.setState('observing');

    expect(test.commands).toEqual([{ type: 'set-observation-enabled', enabled: false }]);
    expect(test.events.at(-1)?.type).toBe('failure');
  });
});

describe('the helper crashing', () => {
  it('says it is coming back when the supervisor will restart it', () => {
    const test = harness();

    test.crash({ willRestart: true });

    const record = test.lifecycle.records.at(-1);
    expect(record?.failure).toBe('helper-restarted');
    expect(record?.disposition).toBe('recovered');
    expect(test.notices.at(-1)?.reason).toBe('helper-unavailable');
  });

  it('says to quit and reopen once the restart budget is spent', () => {
    const test = harness();

    test.crash({ willRestart: false, restartsInWindow: 6 });

    const record = test.lifecycle.records.at(-1);
    expect(record?.failure).toBe('helper-unavailable');
    expect(record?.disposition).toBe('safe-terminal');
  });

  it('re-establishes what the dead process invalidated, once', () => {
    const test = harness();

    test.crash({ willRestart: true });
    test.transport('restarting');
    test.transport('ready');
    test.transport('ready');

    expect(test.restored.count).toBe(1);
    expect(test.lifecycle.stats().helperCrashes).toBe(1);
    expect(test.lifecycle.stats().helperRecoveries).toBe(1);
  });

  it('does not treat an ordinary first connection as a recovery', () => {
    const test = harness();

    test.transport('ready');

    expect(test.restored.count).toBe(0);
  });
});

describe('reprobeAttribution', () => {
  it('discards a cached verdict when the adapter caches one', async () => {
    let refreshed = 0;
    await reprobeAttribution({
      refreshAttribution: async () => {
        refreshed += 1;
        return undefined;
      },
    });
    // A platform with no cache — the fakes, or a future one — is a no-op rather
    // than a crash.
    await reprobeAttribution({});
    await reprobeAttribution(null);

    expect(refreshed).toBe(1);
  });
});

describe('permissions', () => {
  it('arms `permission-loss`, which had no caller in the product before', () => {
    const test = harness();

    test.lifecycle.notePermissions(FIXTURE_PERMISSIONS_GRANTED);
    test.lifecycle.notePermissions(revoked('screen-recording'));

    expect(test.retention).toEqual(['permission-loss']);
    expect(test.lifecycle.records.at(-1)?.failure).toBe('screen-permission-revoked');
  });

  it('names Accessibility separately from Screen Recording', () => {
    const test = harness();

    test.lifecycle.notePermissions(FIXTURE_PERMISSIONS_GRANTED);
    test.lifecycle.notePermissions(revoked('accessibility'));

    expect(test.lifecycle.records.at(-1)?.failure).toBe('accessibility-revoked');
  });

  /**
   * PR-044, system-design §16. Losing Accessibility is a *degradation*, and the
   * retention occasion is armed for the clear a hard stop is about to perform.
   * No clear follows a degradation, so arming one here would leave
   * `permission-loss` waiting to mislabel whatever clear came next — the exact
   * defect this arming was introduced to fix, one revocation later.
   */
  it('does not arm a retention occasion for a revocation that stops nothing', () => {
    const test = harness();

    test.lifecycle.notePermissions(FIXTURE_PERMISSIONS_GRANTED);
    test.lifecycle.notePermissions(revoked('accessibility'));

    expect(test.retention).toEqual([]);
    expect(test.lifecycle.records.at(-1)?.disposition).toBe('recovered');
  });

  it('still arms it for Screen Recording, which does stop everything', () => {
    const test = harness();

    test.lifecycle.notePermissions(FIXTURE_PERMISSIONS_GRANTED);
    test.lifecycle.notePermissions(revoked('screen-recording'));

    expect(test.retention).toEqual(['permission-loss']);
    expect(test.lifecycle.records.at(-1)?.disposition).toBe('safe-terminal');
  });

  it('says nothing about the first snapshot it ever sees', () => {
    const test = harness();

    test.lifecycle.notePermissions(revoked('screen-recording'));

    expect(test.retention).toEqual([]);
    expect(test.lifecycle.records).toEqual([]);
  });

  it('says nothing when a permission is granted rather than lost', () => {
    const test = harness();

    test.lifecycle.notePermissions(revoked('screen-recording'));
    test.lifecycle.notePermissions(FIXTURE_PERMISSIONS_GRANTED);

    expect(test.retention).toEqual([]);
  });
});

describe('the session ending', () => {
  it('arms `logout`, which is terminal, and stops the watching', () => {
    const test = harness();

    test.lifecycle.reportSessionEnd('logout');

    expect(test.retention).toEqual(['logout']);
    // No `logout` input exists in the interaction contract; the row whose
    // effects are "stop capturing and clear" is `screen-locked`.
    expect(test.events).toEqual([{ type: 'screen-locked' }]);
  });

  it('arms `screen-lock` for a lock, which keeps the scene lineage', () => {
    const test = harness();

    test.lifecycle.reportScreenLock(true);
    test.lifecycle.reportScreenLock(false);

    expect(test.retention).toEqual(['screen-lock']);
    expect(test.events).toEqual([{ type: 'screen-locked' }, { type: 'screen-unlocked' }]);
  });
});

describe('a provider that signs Pilot out (provider-neutral)', () => {
  it('keys off the shared taxonomy code and nothing else', () => {
    const test = harness();

    const reported = test.lifecycle.reportProviderFailure(
      new PilotError('authentication-required', 'some-provider: no credential is configured', {
        userMessage: 'Pilot needs to sign in to this model provider before it can answer.',
      }),
    );

    const guidance = readLifecycleGuidance(reported);
    expect(guidance?.failure).toBe('provider-authentication');
    expect(guidance?.remedy).toContain('your conversation is kept');
    expect(test.events.at(-1)?.type).toBe('failure');
  });

  it('treats anything else from a provider as unreachable, not as signed out', () => {
    const test = harness();

    const reported = test.lifecycle.reportProviderFailure(new Error('ECONNRESET'));

    expect(reported.code).toBe('provider-unavailable');
    expect(readLifecycleGuidance(reported)?.failure).toBe('provider-unreachable');
  });
});

describe('the recogniser', () => {
  function recogniser(fail: unknown): SpeechInputAdapter {
    return {
      availability: async () => ({ available: true, onDevice: true, locale: 'en-US' }),
      start: async () => {
        throw fail;
      },
      stop: async () => undefined,
      cancel: async () => undefined,
      subscribe: () => (): void => undefined,
    };
  }

  it('replaces a helper log line with the answer §16 asks for', async () => {
    const test = harness();
    const guarded = test.lifecycle.guardSpeechInput(
      recogniser(
        new PilotError('permission-denied', 'permission-denied: microphone not authorized', {
          userMessage: 'The macOS helper could not run that operation.',
        }),
      ),
    );

    const thrown = await guarded
      .start({ utteranceId: asUtteranceId('utt-1'), requireOnDevice: true })
      .then(() => null)
      .catch((cause: unknown) => cause);

    expect(thrown).toBeInstanceOf(PilotError);
    const guidance = readLifecycleGuidance((thrown as PilotError).toJSON());
    expect(guidance?.failure).toBe('speech-input-failed');
    expect(guidance?.remedy).toContain('Type your question');
    expect(test.lifecycle.records.at(-1)?.failure).toBe('speech-input-failed');
  });
});

describe('the observation retry', () => {
  function port(outcomes: readonly (Error | null)[]): ObservationControlPort & {
    readonly attempts: number;
  } {
    let attempts = 0;
    return {
      get attempts(): number {
        return attempts;
      },
      start: async () => undefined,
      stop: async () => undefined,
      clear: async () => undefined,
      observe: async () => {
        const outcome = outcomes[attempts] ?? null;
        attempts += 1;
        if (outcome !== null) {
          throw outcome;
        }
      },
    };
  }

  const retryable = new PilotError('capture-failed', 'no frame', { retryable: true });

  it('looks once more when the screen has not moved', async () => {
    const test = harness({ scene: scene(3) });
    const guarded = test.lifecycle.guardObservation(port([retryable, null]));

    await guarded.observe(asObservationId('obs-1'));

    expect(test.lifecycle.stats().retries).toBe(1);
    expect(test.lifecycle.stats().retriesRefused).toBe(0);
  });

  it('refuses to look again once the screen has moved on', async () => {
    const test = harness({ scene: scene(3) });
    let attempts = 0;
    const target: ObservationControlPort = {
      start: async () => undefined,
      stop: async () => undefined,
      clear: async () => undefined,
      observe: async () => {
        attempts += 1;
        // The screen changes underneath the request that is failing, which is
        // the case: a retry would have succeeded and answered about the past.
        test.setScene(scene(4));
        throw retryable;
      },
    };
    const guarded = test.lifecycle.guardObservation(target);

    const thrown = await guarded
      .observe(asObservationId('obs-1'))
      .then(() => null)
      .catch((cause: unknown) => {
        return cause;
      });

    expect(attempts).toBe(1);
    expect(thrown).toBeInstanceOf(PilotError);
    expect(test.lifecycle.stats().retries).toBe(0);
    expect(test.lifecycle.stats().retriesRefused).toBe(1);
  });

  it('never retries an abort — that is Pilot’s own doing', async () => {
    const test = harness({ scene: scene(3) });
    const controller = new AbortController();
    controller.abort();
    const target = port([new PilotError('cancelled', 'aborted')]);
    const guarded = test.lifecycle.guardObservation(target);

    await guarded
      .observe(asObservationId('obs-1'), controller.signal)
      .then(() => null)
      .catch(() => null);

    expect(target.attempts).toBe(1);
    expect(test.lifecycle.stats().retries).toBe(0);
    expect(test.lifecycle.stats().retriesRefused).toBe(0);
  });
});
