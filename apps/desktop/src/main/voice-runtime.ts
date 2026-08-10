import {
  isAttributionFailure,
  nullLogger,
  toPilotError,
  type Logger,
  type PermissionAttribution,
} from '@pilot/shared';
import {
  DEFAULT_PUSH_TO_TALK_BINDING,
  type HotkeyAdapter,
  type HotkeyAvailability,
  type HotkeyBinding,
  type HotkeyEvent,
  type HotkeyStatus,
  type InteractionCommand,
  type Unsubscribe,
} from '@pilot/platform';
import type { PushToTalkSource } from './conversation-gate.js';

/**
 * Push-to-talk, wired (PR-032) — runbook follow-ups 12 and 19.
 *
 * This is the one fake boundary PR-032 replaces: **speech input**. The real
 * `CGEventTap` (PR-015) and the real Apple Speech recogniser (PR-014) now drive
 * the interaction controller, in place of `FakeHotkeyAdapter` and
 * `FakeSpeechInputAdapter`. The recogniser side needs no code here at all —
 * PR-025's `SpeechInputBinding` already owns it inside
 * `PilotInteractionController`, and the whole of PR-032's change there is
 * *which adapter instance is handed in*. This file owns the other half: turning
 * key transitions into machine commands, and deciding whether the microphone
 * may be opened at all.
 *
 * ## The mapping (follow-up 19), and its two non-optional details
 *
 * `MacHotkeyAdapter` emits `hotkey-down` / `hotkey-up`; the machine takes
 * `push-to-talk-down` / `push-to-talk-up`. That is one `subscribe` and a
 * `switch`. Two things about it are load-bearing:
 *
 * 1. **A `hotkey-up` with `synthetic: true` still dispatches
 *    `push-to-talk-up`.** It is how a dead event tap, a crashed helper or a
 *    key-up macOS lost across a Space switch releases the microphone. PR-015
 *    guarantees exactly one `hotkey-up` per `hotkey-down` precisely so this
 *    mapping can be unconditional; a mapping that filtered synthetic releases
 *    would leave the machine in `listening` with the recogniser open and no way
 *    out but the user noticing.
 * 2. **`hotkey-availability-changed` reaches the UI.** It travels on
 *    {@link VoiceRuntime.pushToTalk}, which `ConversationGate` subscribes to,
 *    so an unavailable shortcut renders as an explained state with the text box
 *    marked as the only way to ask — never as a shortcut that silently does
 *    nothing. The gate does the rendering; this file only makes sure the events
 *    it renders are the real adapter's.
 *
 * ## Voice *is* gated on TCC attribution (follow-up 12)
 *
 * `MacSpeechInputAdapter` refuses unless the helper's own probes report
 * Microphone and Speech Recognition `granted`. PR-011's point is that "the OS
 * says granted" and "the grant reaches this process" are different claims: if
 * macOS credits the grant to something that is not Pilot, voice input reports
 * `granted` and then hears nothing — the silent wrong answer PR-011 exists to
 * prevent. PR-028 wired the verdict into the observation conditions
 * (`observationPermissionConditions`); this is the same wiring for voice, and
 * it is deliberately *not* inside `MacSpeechInputAdapter`: coupling the two
 * adapters would mean a dependency and an extra round trip on every press.
 *
 * So the verdict is established **once**, here, before the tap is ever started:
 *
 * | verdict | what happens |
 * | --- | --- |
 * | none read (no `attribution` supplied) | the tap starts; the platform's own answer stands |
 * | `matched` / `unknown` | the tap starts |
 * | `helper-attributed` / `bundle-mismatch` | **the tap is never started**, and the panel says why |
 *
 * `unknown` is left alone for the same reason PR-028 leaves it alone: PR-011
 * calls it a non-answer (a loose executable is inside no `.app`), not a
 * failure. The refusal is reported as a `HotkeyAvailability` rather than as an
 * exception, because that is the surface the panel already renders and the one
 * `isTextFallbackAvailable(state)` is paired with — system-design §16 never
 * permits a state in which the user cannot ask.
 *
 * ## No clock, no timers
 *
 * Nothing here reads a clock. The adapter stamps every event from its own
 * injected one.
 */

/** Why the voice path is or is not enabled. Counts and reasons only. */
export interface VoiceRuntimeStats {
  /** Presses that became `push-to-talk-down`. */
  readonly downs: number;
  /** Releases that became `push-to-talk-up`, synthetic ones included. */
  readonly ups: number;
  /** How many of those releases Pilot generated rather than the user. */
  readonly syntheticUps: number;
  /** Key events dropped because the voice path is not enabled. */
  readonly droppedWhileDisabled: number;
  readonly availabilityChanges: number;
}

export interface VoiceRuntimeOptions {
  readonly hotkey: HotkeyAdapter;
  /**
   * Where a press goes. The shell passes its own dispatch — the one that also
   * calls `ConversationGate.noteCommand` — so a question abandoned by a new
   * press is counted exactly once, wherever it came from.
   */
  readonly dispatch: (command: InteractionCommand) => void;
  /**
   * PR-011's verdict, read once at {@link VoiceRuntime.start}. Omit it and the
   * tap starts on the platform's own answer, which is what a build with no
   * attribution seam (the fakes) has to do.
   */
  readonly attribution?: () => Promise<PermissionAttribution | undefined>;
  readonly binding?: HotkeyBinding;
  /**
   * Stamps the one event this file invents — the availability change a failed
   * verdict produces. Every other timestamp comes from the adapter's own
   * injected clock. Defaulted at the composition root, exactly as
   * `createInteractionRuntime` defaults the machine's.
   */
  readonly clock?: () => number;
  readonly logger?: Logger;
}

export interface VoiceRuntime {
  /**
   * What `ConversationGate` takes as its `hotkey` source.
   *
   * The adapter itself would nearly do, and deliberately does not: when
   * attribution fails the tap is never started, so the adapter would report the
   * honest but useless `stopped` ("nobody asked it to listen"). This wrapper
   * reports the reason instead, and forwards everything else untouched.
   */
  readonly pushToTalk: PushToTalkSource;
  /** True once the tap has been started and no verdict refused it. */
  readonly enabled: boolean;
  /** Availability as the panel sees it, including the attribution override. */
  availability(): HotkeyAvailability;
  /** PR-011's verdict, once read. `undefined` until then, or when unavailable. */
  attribution(): PermissionAttribution | undefined;
  stats(): VoiceRuntimeStats;
  /**
   * Establishes attribution, then starts the tap unless the verdict refuses.
   *
   * Never throws for a reason the user could act on: a missing Accessibility
   * grant, a refused tap and a failed verdict are all availability states. It
   * rejects only if the helper cannot be reached at all, which the caller
   * already handles for every other adapter.
   */
  start(): Promise<HotkeyStatus>;
  dispose(): Promise<void>;
}

/** The availability a failed verdict produces. Exported so a test can read it. */
export function unattributedAvailability(attribution: PermissionAttribution): HotkeyAvailability {
  return {
    status: 'unavailable',
    reason: 'permission-unattributed',
    // The grant that would be unusable. Accessibility is what the tap needs and
    // Microphone is what the recogniser needs; the microphone is named because
    // it is the one the user is being denied the *use* of.
    permission: 'microphone',
    detail:
      `macOS attributes Pilot’s permissions to ${attribution.verdict} ` +
      `(${attribution.reason}, ${attribution.confidence})`,
  };
}

export function createVoiceRuntime(options: VoiceRuntimeOptions): VoiceRuntime {
  const logger = (options.logger ?? nullLogger).child('voice');
  const binding = options.binding ?? DEFAULT_PUSH_TO_TALK_BINDING;
  const now = options.clock ?? ((): number => Date.now());

  const listeners = new Set<(event: HotkeyEvent) => void>();
  let override: HotkeyAvailability | null = null;
  let latest: HotkeyAvailability = { status: 'stopped' };
  let verdict: PermissionAttribution | undefined;
  let enabled = false;
  let disposed = false;

  const stats = {
    downs: 0,
    ups: 0,
    syntheticUps: 0,
    droppedWhileDisabled: 0,
    availabilityChanges: 0,
  };

  const publish = (event: HotkeyEvent): void => {
    for (const listener of [...listeners]) {
      listener(event);
    }
  };

  const publishAvailability = (availability: HotkeyAvailability): void => {
    latest = availability;
    stats.availabilityChanges += 1;
    publish({ type: 'hotkey-availability-changed', availability, binding, at: now() });
  };

  const offAdapter: Unsubscribe = options.hotkey.subscribe((event) => {
    switch (event.type) {
      case 'hotkey-down':
        if (!enabled) {
          // A tap that is running while the voice path is off has no business
          // opening a microphone. Counted rather than silently ignored.
          stats.droppedWhileDisabled += 1;
          logger.debug('dropped a key press: the voice path is not enabled', {});
          return;
        }
        stats.downs += 1;
        options.dispatch({ type: 'push-to-talk-down' });
        return;
      case 'hotkey-up':
        // **Unconditional on `synthetic`.** See the class comment: a release
        // Pilot invented is how a dead tap lets go of the microphone, and it is
        // the one release that must never be filtered.
        if (event.synthetic) {
          stats.syntheticUps += 1;
          logger.info('releasing push-to-talk on Pilot’s behalf', {
            reason: event.reason ?? 'unknown',
            heldMs: event.heldMs,
          });
        }
        if (!enabled) {
          stats.droppedWhileDisabled += 1;
          return;
        }
        stats.ups += 1;
        options.dispatch({ type: 'push-to-talk-up' });
        return;
      case 'hotkey-availability-changed':
        if (override !== null) {
          // The verdict outranks the tap's own opinion: a build macOS credits
          // elsewhere must not start reporting `active` because the helper came
          // back. Nothing is republished, so the panel keeps the reason it has.
          return;
        }
        latest = event.availability;
        stats.availabilityChanges += 1;
        publish(event);
        return;
    }
  });

  const pushToTalk: PushToTalkSource = {
    async status(): Promise<HotkeyStatus> {
      const status = await options.hotkey.status();
      if (override === null) {
        latest = status.availability;
        return status;
      }
      return { ...status, availability: override };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    pushToTalk,
    get enabled(): boolean {
      return enabled;
    },
    availability: () => override ?? latest,
    attribution: () => verdict,
    stats: () => ({ ...stats }),

    async start(): Promise<HotkeyStatus> {
      // 1. Attribution first, and only once. Reading it after the tap was
      //    already listening would leave a window in which a press opened a
      //    microphone the grant does not reach.
      const read = options.attribution;
      if (read !== undefined) {
        try {
          verdict = await read();
        } catch (cause) {
          // A verdict that could not be read is not a verdict that passed, but
          // it is also not a refusal: PR-011 treats "no answer" as `unknown`,
          // and so does this. Logged where it can be seen.
          logger.warn('could not read the permission attribution verdict', {
            code: toPilotError(cause).code,
          });
          verdict = undefined;
        }
      }
      if (verdict !== undefined && isAttributionFailure(verdict)) {
        override = unattributedAvailability(verdict);
        enabled = false;
        logger.warn('voice input is disabled: macOS credits Pilot’s permissions elsewhere', {
          verdict: verdict.verdict,
          reason: verdict.reason,
          confidence: verdict.confidence,
        });
        // The tap is never started, so the honest status to report is the
        // adapter's own (`stopped`) with the availability replaced.
        const status = await options.hotkey.status();
        publishAvailability(override);
        return { ...status, availability: override };
      }

      // 2. Only now does anything listen for a key.
      //
      // `enabled` is set *before* the call, not after it, and that is not a
      // tidy-up: a `hotkey.start` response and a `hotkey.key` event can reach
      // the host in the same read, and the transport dispatches the event
      // before the awaited continuation runs — the same ordering hazard
      // `MacHotkeyAdapter.#eventGeneration` exists for. Enabling afterwards
      // dropped the first press of a fast tap, intermittently. Nothing is
      // opened early by doing it here: the verdict above has already decided
      // whether a press may reach the microphone at all.
      enabled = true;
      let status: HotkeyStatus;
      try {
        status = await options.hotkey.start(binding);
      } catch (cause) {
        enabled = false;
        throw cause;
      }
      latest = status.availability;
      logger.info('push-to-talk is wired to the interaction controller', {
        availability: status.availability.status,
        attribution: verdict?.verdict ?? 'not-read',
      });
      return status;
    },

    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      // The tap is stopped **before** anything is unsubscribed or disabled.
      // `stop()` releases a key that is still held (PR-015), and that release
      // has to reach the machine like every other one — the app disposes voice
      // ahead of the controller for exactly this reason. Unsubscribing first
      // would drop the last release and leave a shutdown mid-utterance looking
      // like a microphone nobody closed.
      await options.hotkey.stop().catch((cause: unknown) => {
        logger.debug('could not stop the push-to-talk tap', { code: toPilotError(cause).code });
        return undefined;
      });
      enabled = false;
      offAdapter();
      listeners.clear();
    },
  };
}
