import {
  deserializePilotError,
  isGranted,
  nullLogger,
  toPilotError,
  type Logger,
  type ObservationId,
  type ObservedWindow,
  type PermissionKind,
  type PermissionSnapshot,
  type PilotErrorCode,
  type SceneState,
  type SerializedPilotError,
} from '@pilot/shared';
import type {
  CaptureStopReason,
  InteractionCommand,
  ObservationAdapter,
  ObservationEvent,
  PilotViewState,
  SpeechInputAdapter,
  SpeechInputRequest,
  Unsubscribe,
} from '@pilot/platform';
import type { InteractionEvent, ObservationControlPort } from '@pilot/interaction';
import type { RetentionEvent } from '@pilot/observation';
import type {
  HelperCrashReport,
  HelperTransportEvents,
  HelperTransportState,
} from '@pilot/platform-mac';
import {
  lifecycleError,
  LIFECYCLE_GUIDANCE,
  readLifecycleGuidance,
  withLifecycleGuidance,
  type LifecycleFailure,
  type RecoveryDisposition,
} from '../lifecycle/guidance.js';
import type { ObservationNoticeReason } from '../ipc/schemas.js';
import { planRetry, type RetryBudget, type RetryPlan } from './request-retry.js';

/**
 * Lifecycle and failure recovery, assembled (PR-040).
 *
 * This is the seam `main/speech-runtime.ts` is for speech, one level up: the
 * place where the composition root decides **which failures are the machine's
 * business**, and what the user is told about the rest. Runbook cross-lane
 * issue 15 is the reason it exists as a seam rather than as rows in the
 * transition table — "a failure the table calls terminal can cost more than the
 * failure did", and the table's `failure` row runs `teardown()`, which aborts
 * whatever run is in flight.
 *
 * ## The one rule
 *
 * **A failure of the watching costs the watching, never the answer.**
 *
 * A window that turns out to block capture, a capture stream that dies, a
 * helper that crashes: each of those ends Pilot's view of the screen, and each
 * is reported. None of them aborts a run that is still writing an answer the
 * user asked for — the answer was already grounded in an image the model
 * received, and throwing it away because the *next* frame cannot be captured
 * would be losing the reply because the camera broke. So a capture failure
 * reaches the interaction machine as a `failure` only when nothing is in
 * flight; otherwise it reaches the panel as a notice and the observation
 * surface as a refusal, and the run finishes.
 *
 * The symmetric half is PR-033's and is unchanged: a synthesiser failure never
 * leaves `main/speech-runtime.ts` as an `error` at all.
 *
 * ## What is wired here
 *
 * | condition | how it arrives | what happens |
 * | --- | --- | --- |
 * | Screen Recording revoked | `PermissionGate` snapshot | retention occasion `permission-loss` armed, then the table's own `permissions-changed` row tears down, stops capture and clears |
 * | Accessibility revoked | `PermissionGate` snapshot | **nothing stops** (system-design §16, PR-044): typed guidance whose disposition is `recovered`, the retained accessibility labels dropped by `ObservationRuntime.notePermissions`, the frame ring kept |
 * | screen locked / unlocked | window feed, or Electron `powerMonitor` | the table's `screen-locked` row; occasion `screen-lock` |
 * | logout | Electron `powerMonitor` `shutdown` | occasion `logout` — **terminal**, so the scene lineage goes too — then the same stop-and-clear |
 * | selected window closed | window feed | the table's `window-closed` row (typed error already) |
 * | protected capture | `capture-stopped` (`protected-content`) | observation switched off, typed guidance, buffers cleared |
 * | capture failed | `capture-stopped` (`failed`) | same, after `MacObservationAdapter` has spent its own stream restarts |
 * | helper crash | `NativeHelperTransport` `crash` | typed guidance; on reconnect the cached attribution verdict is re-probed and the permissions re-read |
 * | provider auth | {@link LifecycleRuntime.reportProviderFailure} | typed guidance, transcript kept, nothing resent |
 * | recogniser failure | {@link LifecycleRuntime.guardSpeechInput} | typed guidance naming the text box, microphone released |
 * | retryable request | {@link LifecycleRuntime.guardObservation} | one scene-checked retry — see `main/request-retry.ts` |
 *
 * ## Provider neutrality
 *
 * PR-037, PR-038 and PR-039 own the provider profiles. Nothing here knows any
 * provider's error shape: {@link LifecycleRuntime.reportProviderFailure} keys
 * off `PilotErrorCode` alone, which is the shared taxonomy every profile
 * already has to map onto (`@pilot/shared`, `authentication-required` since
 * PR-001, raised today by `packages/agent`'s own auth facade). A profile that
 * discovers its credentials have expired calls that method and gets the §16
 * behaviour — "pause the request, reauthenticate without losing the transcript"
 * — without this file learning what a Codex token looks like.
 */

/** What the runtime needs from the interaction controller. */
export interface LifecycleInteraction {
  snapshot(): PilotViewState;
  subscribe(listener: (view: PilotViewState) => void): Unsubscribe;
  send(event: InteractionEvent): void;
  /**
   * The app's own `dispatchCommand` — the one that tells the diagnostics ring
   * before it tells the machine. A command Pilot issues on the user's behalf is
   * still a command, and counting it is how §17 counts an abandoned question
   * "wherever it was abandoned from".
   */
  dispatch(command: InteractionCommand): void;
}

/** What it needs from the observation runtime. */
export interface LifecycleObservation {
  /** Names the occasion for the next clear (system-design §13). */
  noteRetentionEvent(event: RetentionEvent): void;
  /** The scene the retry policy compares against. */
  scene(): SceneState | null;
}

/** What it needs from the window gate: somewhere to put a §16 prompt. */
export interface LifecycleNotices {
  noteObservationStopped(
    reason: ObservationNoticeReason,
    window: ObservedWindow | null,
    wasObserving: boolean,
  ): void;
}

/** What it needs from the helper supervisor. `NativeHelperTransport` satisfies it. */
export interface LifecycleTransport {
  /**
   * Exactly `TypedEmitter.on`'s shape rather than two overloads, because
   * `NativeHelperTransport` has to satisfy this structurally and a pair of
   * overloads is not assignable from one generic method.
   */
  on<E extends keyof HelperTransportEvents>(
    event: E,
    listener: (payload: HelperTransportEvents[E]) => void,
  ): Unsubscribe;
}

/** One thing that went wrong, and how it ended. Content-free by construction. */
export interface LifecycleRecord {
  readonly at: number;
  readonly failure: LifecycleFailure;
  readonly disposition: RecoveryDisposition;
  readonly code: PilotErrorCode;
  /** Where the user can see it. `log` means nobody but a developer can. */
  readonly surfaced: 'panel' | 'notice' | 'log';
  /** Machine-readable cause, never a message and never screen content. */
  readonly cause: string;
}

export interface LifecycleStats {
  readonly records: number;
  readonly recovered: number;
  readonly safeTerminal: number;
  readonly helperCrashes: number;
  readonly helperRecoveries: number;
  readonly retries: number;
  readonly retriesRefused: number;
}

export interface LifecycleRuntimeOptions {
  readonly interaction: LifecycleInteraction;
  readonly observation?: LifecycleObservation | null;
  /** The capture stream, for `capture-stopped`. `null` on a build with none. */
  readonly capture?: ObservationAdapter | null;
  readonly transport?: LifecycleTransport | null;
  readonly notices?: LifecycleNotices | null;
  /**
   * Re-establishes what a restarted helper invalidated.
   *
   * `MacPermissionAdapter` caches PR-011's attribution verdict — correctly, it
   * cannot change while one helper process lives — so after a crash the cached
   * verdict belongs to a process that no longer exists. Nothing re-probed it
   * before this PR. The composition root passes a function that calls
   * `refreshAttribution()` and re-reads the permission snapshot and window list.
   */
  readonly onHelperRestored?: () => Promise<void>;
  /** Retry budget for {@link LifecycleRuntime.guardObservation}. */
  readonly retry?: RetryBudget;
  /** Injected so a test never waits on wall time. */
  readonly delay?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
  readonly logger?: Logger;
}

export interface LifecycleRuntime {
  /** Everything that went wrong since startup, oldest first. */
  readonly records: readonly LifecycleRecord[];
  stats(): LifecycleStats;
  /** Subscribes to the capture stream and the helper supervisor. Idempotent. */
  start(): void;
  /**
   * Compares a permission snapshot with the last one and arms the retention
   * occasion (system-design §13 lists logout and permission loss among the five
   * clears; `permission-loss` had **no caller at all** before this PR).
   *
   * Called *before* the snapshot reaches the interaction machine, because the
   * machine's own `permissions-changed` row is what emits `clear-buffers`, and
   * the occasion has to be armed before the clear it names.
   */
  notePermissions(snapshot: PermissionSnapshot | null): void;
  /**
   * The session is ending: a logout, or a shutdown that is not Pilot's own quit.
   *
   * Arms `logout`, which is **terminal** — the scene lineage is dropped with the
   * buffers — and then reuses the table's `screen-locked` row, which is the row
   * whose effects are exactly "stop capturing and clear what you have". There
   * is no `logout` input in the interaction contract and this PR does not add
   * one: the difference between a lock and a logout is what is *retained*, and
   * that is the retention guard's business, not the machine's.
   */
  reportSessionEnd(kind: 'logout' | 'shutdown'): void;
  /** Forwards a lock or unlock from a source other than the window feed. */
  reportScreenLock(locked: boolean): void;
  /**
   * The provider-neutral failure hook (PR-037/038/039).
   *
   * Give it anything thrown by a provider profile — a sign-in that expired, an
   * endpoint that will not answer — and it produces the typed guidance, records
   * it, and puts it in front of the user without touching the transcript.
   */
  reportProviderFailure(cause: unknown): SerializedPilotError;
  /** Wraps the capture lifecycle with the scene-checked retry of PR-040. */
  guardObservation(port: ObservationControlPort): ObservationControlPort;
  /** Wraps the recogniser so a failure names the text box (§16). */
  guardSpeechInput(adapter: SpeechInputAdapter): SpeechInputAdapter;
  dispose(): void;
}

/** States in which losing the screen must not cost the answer. See the rule above. */
const IN_FLIGHT: ReadonlySet<PilotViewState['state']> = new Set([
  'listening',
  'transcribing',
  'thinking',
  'observing-screen',
  'speaking',
]);

/** Permissions whose loss stops observation, and the guidance each produces. */
const PERMISSION_GUIDANCE: Readonly<Partial<Record<PermissionKind, LifecycleFailure>>> = {
  'screen-recording': 'screen-permission-revoked',
  accessibility: 'accessibility-revoked',
};

/** What a capture stop means, and whether the user has to be told. */
function captureStopGuidance(reason: CaptureStopReason): LifecycleFailure | null {
  switch (reason) {
    case 'protected-content':
      return 'capture-blocked';
    case 'failed':
      return 'capture-unavailable';
    // The window feed and the transport own these three: the interaction table
    // already has a row for the first two, and the crash handler below reports
    // the third with the restart budget the stream cannot see. Reporting them
    // here as well would put two banners in front of one event.
    case 'window-lost':
    case 'screen-locked':
    case 'helper-unavailable':
    case 'requested':
      return null;
  }
}

export function createLifecycleRuntime(options: LifecycleRuntimeOptions): LifecycleRuntime {
  const logger = (options.logger ?? nullLogger).child('lifecycle');
  const now = options.clock ?? ((): number => Date.now());
  const wait = options.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const records: LifecycleRecord[] = [];
  const unsubscribes: Unsubscribe[] = [];

  let started = false;
  let disposed = false;
  let permissions: PermissionSnapshot | null = null;
  let helperCrashes = 0;
  let helperRecoveries = 0;
  let awaitingHelper = false;
  let retries = 0;
  let retriesRefused = 0;

  const record = (
    failure: LifecycleFailure,
    code: PilotErrorCode,
    surfaced: LifecycleRecord['surfaced'],
    cause: string,
    disposition: RecoveryDisposition,
  ): LifecycleRecord => {
    const entry: LifecycleRecord = { at: now(), failure, disposition, code, surfaced, cause };
    records.push(entry);
    logger.warn('lifecycle failure', { failure, disposition, code, surfaced, cause });
    return entry;
  };

  /**
   * What is waiting for the machine to stop being busy. At most one: a second
   * failure while one is queued replaces it, because the newer one is the one
   * the user is now looking at the consequences of.
   */
  let deferred: { readonly error: SerializedPilotError; readonly switchOff: boolean } | null = null;

  const deliver = (error: SerializedPilotError, switchOff: boolean): void => {
    // Order matters and is easy to get backwards: the `set-observation-enabled`
    // row patches `lastError: null`, so switching off *after* posting the
    // failure would erase the sentence that explains why.
    if (switchOff && options.interaction.snapshot().observationEnabled) {
      options.interaction.dispatch({ type: 'set-observation-enabled', enabled: false });
    }
    options.interaction.send({ type: 'failure', error });
  };

  /**
   * Puts a typed failure in front of the user.
   *
   * `panel` when the machine can afford to be interrupted, `notice` when it
   * cannot — see the rule at the top. Either way the guidance is the same
   * object, so the two surfaces never disagree about what happened.
   *
   * A failure raised while a question is in flight is **queued, not dropped**:
   * the §16 notice goes up at once, and the banner plus the observation
   * switch-off are delivered as soon as the machine leaves an active state. Two
   * things made that necessary rather than tidy. `set-observation-enabled` is
   * rejected as `illegal-transition` in every active state, and a rejected
   * command *is* a `lastError` — so the seam's own tidying-up would have put
   * "Pilot cannot do that right now." in front of a user whose answer was
   * arriving perfectly well. And a `failure` sent there would tear the run down,
   * which is the rule at the top of this file.
   */
  const surface = (
    failure: LifecycleFailure,
    cause: string,
    options_: {
      readonly window?: ObservedWindow | null;
      readonly notice?: ObservationNoticeReason;
      readonly details?: Readonly<Record<string, unknown>>;
      readonly error?: SerializedPilotError;
      /** Turn the observation switch off with the banner. */
      readonly switchOff?: boolean;
    } = {},
  ): LifecycleRecord => {
    const error =
      options_.error === undefined
        ? lifecycleError(failure, { details: { cause, ...(options_.details ?? {}) } }).toJSON()
        : withLifecycleGuidance(options_.error, failure);
    const view = options.interaction.snapshot();
    const busy = IN_FLIGHT.has(view.state);
    if (options_.notice !== undefined && options.notices != null) {
      options.notices.noteObservationStopped(
        options_.notice,
        options_.window ?? view.selectedWindow,
        view.observationEnabled,
      );
    }
    if (busy) {
      deferred = { error, switchOff: options_.switchOff === true };
    } else {
      deliver(error, options_.switchOff === true);
    }
    const guidance = readLifecycleGuidance(error);
    return record(
      failure,
      error.code,
      busy ? (options_.notice === undefined ? 'log' : 'notice') : 'panel',
      cause,
      guidance?.disposition ?? 'safe-terminal',
    );
  };

  const onCaptureEvent = (event: ObservationEvent): void => {
    if (disposed || event.type !== 'capture-stopped') {
      return;
    }
    const failure = captureStopGuidance(event.reason);
    if (failure === null) {
      return;
    }
    // The buffers are cleared under the right name, and the switch the user can
    // see is turned off — a Pilot that says "watching" while the stream is dead
    // is the silent degradation this PR exists to remove. Both wait for the
    // answer in flight to finish; see `surface`.
    options.observation?.noteRetentionEvent('observation-disabled');
    surface(failure, `capture-stopped:${event.reason}`, {
      notice: 'capture-unavailable',
      switchOff: true,
      ...(event.error === undefined ? {} : { error: event.error.toJSON() }),
    });
  };

  const onCrash = (report: HelperCrashReport): void => {
    if (disposed) {
      return;
    }
    helperCrashes += 1;
    awaitingHelper = report.willRestart;
    const failure: LifecycleFailure = report.willRestart
      ? 'helper-restarted'
      : 'helper-unavailable';
    surface(failure, `helper-${report.reason}`, {
      notice: 'helper-unavailable',
      details: {
        abandonedRequests: report.abandonedRequests,
        restartsInWindow: report.restartsInWindow,
        willRestart: report.willRestart,
      },
    });
  };

  const onTransportState = (state: HelperTransportState): void => {
    if (disposed || state !== 'ready' || !awaitingHelper) {
      return;
    }
    awaitingHelper = false;
    helperRecoveries += 1;
    // The recovery nothing performed before this PR. `MacObservationAdapter`
    // re-establishes its own stream on this same edge; the attribution verdict
    // and the permission snapshot belong to the dead process and nothing
    // re-read them.
    void Promise.resolve(options.onHelperRestored?.())
      .then(() => {
        logger.info('the helper was restarted and Pilot reconnected', {
          crashes: helperCrashes,
        });
      })
      .catch((cause: unknown) => {
        logger.warn('could not re-establish state after a helper restart', {
          code: toPilotError(cause).code,
        });
      });
  };

  return {
    records,

    stats: (): LifecycleStats => ({
      records: records.length,
      recovered: records.filter((entry) => entry.disposition === 'recovered').length,
      safeTerminal: records.filter((entry) => entry.disposition === 'safe-terminal').length,
      helperCrashes,
      helperRecoveries,
      retries,
      retriesRefused,
    }),

    start(): void {
      if (started || disposed) {
        return;
      }
      started = true;
      const capture = options.capture;
      const subscribeEvents = capture?.subscribeEvents;
      if (capture != null && subscribeEvents !== undefined) {
        unsubscribes.push(subscribeEvents.call(capture, onCaptureEvent));
      }
      const transport = options.transport;
      if (transport != null) {
        unsubscribes.push(transport.on('crash', onCrash));
        unsubscribes.push(transport.on('state', onTransportState));
      }
      // The queue drain. Subscribing rather than polling because the moment a
      // turn ends is a view-state edge and nothing else observes it.
      unsubscribes.push(
        options.interaction.subscribe((view) => {
          const pending = deferred;
          if (pending === null || disposed || IN_FLIGHT.has(view.state)) {
            return;
          }
          deferred = null;
          deliver(pending.error, pending.switchOff);
        }),
      );
    },

    notePermissions(snapshot: PermissionSnapshot | null): void {
      const previous = permissions;
      permissions = snapshot;
      if (previous === null || snapshot === null) {
        return;
      }
      for (const [kind, failure] of Object.entries(PERMISSION_GUIDANCE) as [
        PermissionKind,
        LifecycleFailure,
      ][]) {
        if (!isGranted(previous[kind]) || isGranted(snapshot[kind])) {
          continue;
        }
        // Not every revocation is a stop, since PR-044. Screen Recording still
        // tears the session down, so the retention occasion is armed *before*
        // the machine's own row runs and the clear it is about to ask for is
        // logged as what it is — `permission-loss` had no caller in the product
        // until this line, and every revocation used to clear its buffers under
        // whichever occasion happened to be armed last.
        //
        // Accessibility does not stop anything (system-design §16), so no
        // whole-buffer clear follows and arming one here would leave
        // `permission-loss` waiting to mislabel the *next* clear, whatever
        // caused it. The elements that genuinely must not survive the
        // revocation — the accessibility labels already in the pointer-target
        // log — are dropped by `ObservationRuntime.notePermissions`, which owns
        // that log and drops it *without* taking the frame ring with it.
        const stops = LIFECYCLE_GUIDANCE[failure].disposition === 'safe-terminal';
        if (stops) {
          options.observation?.noteRetentionEvent('permission-loss');
        }
        record(
          failure,
          'permission-denied',
          'notice',
          `permission-revoked:${kind}`,
          LIFECYCLE_GUIDANCE[failure].disposition,
        );
      }
    },

    reportSessionEnd(kind: 'logout' | 'shutdown'): void {
      options.observation?.noteRetentionEvent(kind === 'logout' ? 'logout' : 'shutdown');
      record('session-ended', 'observation-disabled', 'log', `session-${kind}`, 'safe-terminal');
      // The row whose effects are "stop capturing and clear what you have". A
      // duplicate is rejected by the table as `illegal-transition`, so a lock
      // that arrived first costs nothing.
      options.interaction.send({ type: 'screen-locked' });
    },

    reportScreenLock(locked: boolean): void {
      if (locked) {
        options.observation?.noteRetentionEvent('screen-lock');
        record('screen-locked', 'screen-locked', 'log', 'power-monitor', 'recovered');
      }
      options.interaction.send({ type: locked ? 'screen-locked' : 'screen-unlocked' });
    },

    reportProviderFailure(cause: unknown): SerializedPilotError {
      const error = toPilotError(cause, 'provider-unavailable');
      // Keyed off the taxonomy code and nothing else — see the provider
      // neutrality note above.
      const failure: LifecycleFailure =
        error.code === 'authentication-required'
          ? 'provider-authentication'
          : 'provider-unreachable';
      const entry = surface(failure, `provider:${error.code}`, { error: error.toJSON() });
      logger.warn('the model provider failed', { code: error.code, failure: entry.failure });
      return withLifecycleGuidance(error.toJSON(), failure);
    },

    guardObservation(port: ObservationControlPort): ObservationControlPort {
      return {
        start: (window: ObservedWindow) => port.start(window),
        stop: () => port.stop(),
        clear: () => port.clear(),
        async observe(observationId: ObservationId, signal?: AbortSignal): Promise<void> {
          const sceneAtRequest = options.observation?.scene() ?? null;
          try {
            await port.observe(observationId, signal);
            return;
          } catch (cause) {
            const error = toPilotError(cause).toJSON();
            // An abort is Pilot's own doing, never a failure to recover from.
            if (signal?.aborted === true || error.code === 'cancelled') {
              throw cause;
            }
            const plan: RetryPlan = planRetry({
              attempt: 0,
              error,
              sceneAtRequest,
              sceneNow: options.observation?.scene() ?? null,
              ...(options.retry === undefined ? {} : { budget: options.retry }),
            });
            if (plan.kind === 'ask-again') {
              retriesRefused += 1;
              logger.info('not retrying the observation', {
                reason: plan.reason,
                code: error.code,
              });
              // The refusal keeps the producer's own sentence and gains a
              // remedy that says why Pilot did not simply try again.
              // `deserializePilotError`, never `toPilotError`: the latter turns
              // a plain object into `internal` and loses both.
              throw deserializePilotError(withLifecycleGuidance(error, plan.guidance));
            }
            retries += 1;
            logger.info('retrying the observation once', {
              delayMs: plan.delayMs,
              code: error.code,
            });
            await wait(plan.delayMs);
            signal?.throwIfAborted();
            await port.observe(observationId, signal);
          }
        },
      };
    },

    guardSpeechInput(adapter: SpeechInputAdapter): SpeechInputAdapter {
      const guarded: SpeechInputAdapter = {
        availability: () => adapter.availability(),
        async start(request: SpeechInputRequest): Promise<void> {
          try {
            await adapter.start(request);
          } catch (cause) {
            const error = toPilotError(cause, 'speech-input-failed');
            record(
              'speech-input-failed',
              error.code,
              'panel',
              `speech-input:${error.code}`,
              'safe-terminal',
            );
            // The machine turns this into `failure`, which keeps the text box
            // live (§16, and `isTextFallbackAvailable` in the panel's view
            // model). What it did not carry before was a sentence saying so.
            throw deserializePilotError(
              withLifecycleGuidance(error.toJSON(), 'speech-input-failed'),
            );
          }
        },
        stop: (utteranceId) => adapter.stop(utteranceId),
        cancel: (utteranceId) => adapter.cancel(utteranceId),
        subscribe: adapter.subscribe,
        ...(adapter.disclosure === undefined
          ? {}
          : { disclosure: adapter.disclosure.bind(adapter) }),
      };
      return guarded;
    },

    dispose(): void {
      disposed = true;
      for (const off of unsubscribes) {
        off();
      }
      unsubscribes.length = 0;
    },
  };
}

/**
 * Anything that caches PR-011's attribution verdict per helper process.
 *
 * `MacPermissionAdapter` satisfies it structurally; `PermissionAdapter` — the
 * system-design §5 interface — does not declare `refreshAttribution`, which is
 * why this is read optionally rather than required (the additive shape runbook
 * cross-lane issue 8 recommends).
 */
export interface AttributionCache {
  refreshAttribution?(): Promise<unknown>;
}

/**
 * Discards a cached attribution verdict that belongs to a dead helper.
 *
 * The verdict is cached deliberately: it cannot change while one helper process
 * lives, and the probe costs a round trip. It *can* change when that process is
 * replaced — a new pid, and on a Mac possibly a new responsible process — so a
 * restart is exactly when it must be thrown away. Calling
 * `ObservationRuntime.refreshAttribution()` alone does **not** do it: that reads
 * `attribution()`, which answers from the cache.
 */
export async function reprobeAttribution(cache: object | null | undefined): Promise<void> {
  // Read structurally rather than by type: the parameter is a
  // `PermissionAdapter` at every call site, and every member of
  // {@link AttributionCache} is optional, so a typed parameter would be a weak
  // type that nothing is assignable to.
  const refresh = (cache as AttributionCache | null)?.refreshAttribution;
  if (typeof refresh === 'function') {
    await refresh.call(cache);
  }
}

/** Serialised `PilotError` for a failure that ends the watching, for a test. */
export function lifecycleFailureError(
  failure: LifecycleFailure,
  cause: string,
): SerializedPilotError {
  return lifecycleError(failure, { details: { cause } }).toJSON();
}
