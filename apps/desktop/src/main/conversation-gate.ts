import {
  nullLogger,
  PilotError,
  toPilotError,
  type Logger,
  type SerializedPilotError,
} from '@pilot/shared';
import {
  hotkeyBlockingPermission,
  hotkeyUnavailableMessage,
  isHotkeyUsable,
  type HotkeyAdapter,
  type HotkeyAvailability,
  type HotkeyBinding,
  type InteractionCommand,
  type PilotViewState,
  type SpeechInputAdapter,
  type Subscribe,
} from '@pilot/platform';
import type {
  AbortCategory,
  ConversationAction,
  ConversationFixtureName,
  ConversationGateState,
  ModelDataDisclosureView,
  ModelStatusView,
  PushToTalk,
} from '../ipc/schemas.js';
import { TelemetryRing, type TelemetryRingOptions } from './telemetry.js';

/**
 * Main-process owner of the conversation panel's own state.
 *
 * Three things happen here and nowhere else.
 *
 *  1. **The §17 metrics that can be derived are derived, once.** The shell
 *     already subscribes to the view-state stream; the durations §17 asks for —
 *     STT duration, time to first token, time to first spoken sentence, and the
 *     observation-call count per question — are transitions of that stream, so
 *     they are measured here rather than being asked of five later PRs that
 *     would each measure them slightly differently. What genuinely cannot be
 *     seen from the view state (capture-to-observation latency, image bytes,
 *     the active image count, compaction counters) is left to
 *     {@link ConversationGate.telemetry}, whose call sites are named in the
 *     comment on {@link ConversationGate.record}.
 *
 *  2. **Nothing about the conversation's *content* is recorded.** The gate sees
 *     every view state, transcript included, and writes only numbers and
 *     closed-vocabulary categories into the ring. See `main/telemetry.ts` for
 *     why the recording API makes the other outcome impossible rather than
 *     merely discouraged.
 *
 *  3. **The two voice facts the renderer cannot know are resolved here.**
 *     Whether the push-to-talk shortcut is actually listening, and what the
 *     recogniser would do with the audio. `isHotkeyUsable`,
 *     `hotkeyUnavailableMessage` and `hotkeyBlockingPermission` are evaluated in
 *     this process so every surface says the same thing.
 *
 * What it does **not** own: the transcript, the streamed answer and the
 * interaction state. `PilotViewState` is the single answer to those, exactly as
 * `PilotViewState.selectedWindow` is the single answer to what Pilot is
 * watching. Nothing here re-derives them.
 */

/** What the gate needs from the interaction side. Read-only by construction. */
export interface ConversationInteraction {
  snapshot(): PilotViewState;
  subscribe: Subscribe<PilotViewState>;
}

/** The push-to-talk half. `HotkeyAdapter` satisfies it as it stands. */
export type PushToTalkSource = Pick<HotkeyAdapter, 'status' | 'subscribe'>;

/** The disclosure half. `SpeechInputAdapter` satisfies it as it stands. */
export type SpeechDisclosureSource = Pick<SpeechInputAdapter, 'disclosure'>;

export type ConversationGateListener = (state: ConversationGateState) => void;

export interface ConversationGateOptions {
  readonly interaction: ConversationInteraction;
  /** Omit in a build with no global shortcut; the panel then says so. */
  readonly hotkey?: PushToTalkSource;
  /** Omit in a build with no recogniser; the panel then shows no disclosure. */
  readonly speech?: SpeechDisclosureSource;
  /** True when the shell can replay fixture conversations from the panel. */
  readonly demoFixtures?: boolean;
  /**
   * Where screen images go for the configured model (PR-038, system-design
   * §14). Omit in a build that has not resolved a model profile; the panel then
   * shows no model banner. Update it with
   * {@link ConversationGate.setModelDisclosure} when the profile changes.
   */
  readonly modelDisclosure?: ModelDataDisclosureView | null;
  /**
   * Which model profile is in force (runbook follow-ups 46 and 33). Set by the
   * shipping composition for **every** profile, including the development
   * stand-in — the panel's only provider surface used to be `CodexStatus`,
   * which renders nothing unless the Codex profile is selected. Update it with
   * {@link ConversationGate.setModelStatus} when a sign-in, a sign-out or a
   * failed key changes the answer.
   */
  readonly modelStatus?: ModelStatusView | null;
  readonly telemetry?: TelemetryRingOptions;
  readonly logger?: Logger;
  readonly now?: () => number;
}

/** States in which Pilot is working on an answer the user could abandon. */
const IN_FLIGHT: ReadonlySet<PilotViewState['state']> = new Set([
  'transcribing',
  'thinking',
  'observing-screen',
  'speaking',
]);

/** The abort a command implies, when one is in flight. `null` means "not an abort". */
function abortCategoryFor(command: InteractionCommand): AbortCategory | null {
  switch (command.type) {
    case 'interrupt':
      return 'user-interrupted';
    case 'stop-speaking':
      return 'stopped-speaking';
    case 'clear-conversation':
      return 'conversation-cleared';
    case 'select-window':
      return 'window-changed';
    case 'pause':
      return 'observation-stopped';
    case 'submit-text':
    case 'push-to-talk-down':
      return 'new-question';
    case 'set-observation-enabled':
    case 'push-to-talk-up':
    case 'look-now':
    case 'resume':
    case 'dismiss-error':
      return null;
  }
}

/**
 * How many assistant turns the transcript holds.
 *
 * A count, deliberately: "has the answer started" must be answerable without
 * looking at what the answer says.
 */
function countAssistantTurns(view: PilotViewState): number {
  return view.transcript.reduce(
    (total, entry) => (entry.role === 'assistant' ? total + 1 : total),
    0,
  );
}

export class ConversationGate {
  /**
   * The ring itself, for the measurements the view state cannot show.
   *
   * Its remaining call sites are known and named: `capture-to-observation` and
   * `image-bytes`/`active-images` belong to PR-028's capture and PR-030's
   * `observe_screen`; `context-tokens-before`/`-after` belong to PR-036, which
   * reads them from `PiAgentSession.lastCompaction` (the `context-compacted`
   * event carries the summary *text*, which is content and is not recorded).
   * Each of those hands this gate a number; none of them hands it text, and
   * `TelemetryRing` has no method that would accept one.
   */
  readonly telemetry: TelemetryRing;

  readonly #interaction: ConversationInteraction;
  readonly #hotkey: PushToTalkSource | undefined;
  readonly #speech: SpeechDisclosureSource | undefined;
  readonly #demoFixtures: boolean;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #listeners = new Set<ConversationGateListener>();
  readonly #unsubscribes: (() => void)[] = [];

  #diagnosticsVisible = false;
  #pushToTalk: PushToTalk | null = null;
  #disclosure: ConversationGateState['disclosure'] = null;
  #fixture: ConversationFixtureName | null = null;
  /** PR-038. Set at construction and whenever the model profile changes. */
  #modelDisclosure: ModelDataDisclosureView | null = null;
  /** Follow-up 46. Same lifetime, same publication, one field further. */
  #modelStatus: ModelStatusView | null = null;
  #disposed = false;

  /** Transition bookkeeping for the derived timings. Numbers only. */
  #previous: PilotViewState;
  #listeningSince: number | null = null;
  #thinkingSince: number | null = null;
  #firstTokenSeen = false;
  #firstSentenceSeen = false;
  #observationCalls = 0;
  #assistantTurnsAtSubmit = 0;
  #lastErrorCode: SerializedPilotError['code'] | null = null;

  constructor(options: ConversationGateOptions) {
    this.#interaction = options.interaction;
    this.#hotkey = options.hotkey;
    this.#speech = options.speech;
    this.#demoFixtures = options.demoFixtures ?? false;
    this.#modelDisclosure = options.modelDisclosure ?? null;
    this.#modelStatus = options.modelStatus ?? null;
    this.#logger = options.logger ?? nullLogger;
    this.#now = options.now ?? (() => Date.now());
    this.telemetry = new TelemetryRing({
      ...options.telemetry,
      ...(options.now === undefined ? {} : { now: options.now }),
      onSample: () => {
        this.#publish();
      },
    });

    this.#previous = this.#interaction.snapshot();
    this.#lastErrorCode = this.#previous.lastError?.code ?? null;

    this.#unsubscribes.push(
      this.#interaction.subscribe((view) => {
        if (!this.#disposed) {
          this.#onViewState(view);
        }
      }),
    );

    if (this.#hotkey !== undefined) {
      this.#unsubscribes.push(
        this.#hotkey.subscribe((event) => {
          if (this.#disposed || event.type !== 'hotkey-availability-changed') {
            // Key presses belong to the interaction controller, not to this
            // gate; wiring them is follow-up 6 against PR-032. What the panel
            // needs from here is only whether the shortcut works at all.
            return;
          }
          this.#setPushToTalk(event.availability, event.binding);
        }),
      );
    }
  }

  snapshot(): ConversationGateState {
    return {
      telemetry: this.telemetry.snapshot(),
      diagnosticsVisible: this.#diagnosticsVisible,
      pushToTalk: this.#pushToTalk,
      disclosure: this.#disclosure,
      fixture: this.#fixture,
      demoFixtures: this.#demoFixtures,
      modelDisclosure: this.#modelDisclosure,
      modelStatus: this.#modelStatus,
    };
  }

  /**
   * Replaces the model banner (PR-038).
   *
   * Called when a profile is verified, rejected, or taken out of service by an
   * invalid key mid-conversation — the banner must never keep saying "Pilot has
   * confirmed this model" about a model that has since started refusing.
   */
  setModelDisclosure(disclosure: ModelDataDisclosureView | null): void {
    this.#modelDisclosure = disclosure;
    this.#publish();
  }

  /**
   * Replaces the model-profile row (runbook follow-up 46).
   *
   * The liveness half of the fix: signing in to ChatGPT, signing out again, or
   * a key that stops working mid-conversation must all change what the panel
   * says **without a relaunch**. Every caller is a subscription that already
   * existed — `CodexRuntime.subscribe` and the API-key manager's `run-failed`
   * handler — so there is one publication path to the renderer, not a second.
   */
  setModelStatus(status: ModelStatusView | null): void {
    this.#modelStatus = status;
    this.#publish();
  }

  subscribe(listener: ConversationGateListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Re-reads the voice facts from their adapters.
   *
   * Both are asynchronous and both can be absent, and neither failure is worth
   * a visible error: a shortcut whose status cannot be read is reported as
   * unavailable with the adapter's own words, which is what the panel would
   * have shown anyway.
   */
  async refresh(): Promise<ConversationGateState> {
    this.#assertUsable();
    if (this.#hotkey !== undefined) {
      try {
        const status = await this.#hotkey.status();
        this.#setPushToTalk(status.availability, status.binding);
      } catch (cause) {
        this.#logger.warn('could not read push-to-talk status', {
          code: toPilotError(cause).code,
        });
      }
    }
    if (this.#speech?.disclosure !== undefined) {
      try {
        this.#disclosure = await this.#speech.disclosure();
      } catch (cause) {
        this.#logger.warn('could not read the speech disclosure', {
          code: toPilotError(cause).code,
        });
      }
    }
    this.#publish();
    return this.snapshot();
  }

  /** Serves one validated renderer action. */
  async act(action: ConversationAction): Promise<ConversationGateState> {
    this.#assertUsable();
    switch (action.type) {
      case 'refresh':
        return this.refresh();
      case 'clear-telemetry':
        this.telemetry.clear();
        this.#publish();
        return this.snapshot();
      case 'set-diagnostics-visible':
        this.#diagnosticsVisible = action.visible;
        this.#publish();
        return this.snapshot();
    }
  }

  /**
   * Records a command the shell is about to dispatch.
   *
   * Called from the one place commands enter the controller, so an abort is
   * counted once whether it came from the panel, the menu bar or a shortcut.
   */
  noteCommand(command: InteractionCommand): void {
    if (this.#disposed) {
      return;
    }
    const state = this.#interaction.snapshot().state;
    const category = abortCategoryFor(command);
    if (category !== null && IN_FLIGHT.has(state)) {
      this.telemetry.abort(category);
    }
    if (command.type === 'submit-text') {
      // A typed question opens a turn the view-state stream cannot see the
      // start of: `submit-text` goes straight to `thinking`, with no
      // `listening` edge to count.
      this.telemetry.beginTurn();
    }
  }

  /** Records the fixture a demo driver has just replayed. */
  noteFixture(fixture: ConversationFixtureName): ConversationGateState {
    this.#fixture = fixture;
    this.#publish();
    return this.snapshot();
  }

  dispose(): void {
    if (!this.#disposed && IN_FLIGHT.has(this.#interaction.snapshot().state)) {
      this.telemetry.abort('shutdown');
    }
    this.#disposed = true;
    for (const unsubscribe of this.#unsubscribes) {
      unsubscribe();
    }
    this.#unsubscribes.length = 0;
    this.#listeners.clear();
  }

  // -- derived timings ------------------------------------------------------

  /**
   * The §17 durations, as edges of the view-state stream.
   *
   * Everything read here is a state name, a boolean or the `pending` flag of a
   * transcript entry. The entries' `text` is never touched — only whether the
   * newest assistant entry exists, which is what "the first token arrived"
   * means for a streamed answer.
   */
  #onViewState(view: PilotViewState): void {
    const previous = this.#previous;
    this.#previous = view;
    const at = this.#now();

    if (view.state !== previous.state) {
      this.#onStateChange(previous.state, view.state, at);
    }

    // First token: the first moment an assistant turn exists that did not exist
    // when this question started. Counted, never read — the answer's text is
    // not touched here or anywhere else in this file.
    if (
      this.#thinkingSince !== null &&
      !this.#firstTokenSeen &&
      countAssistantTurns(view) > this.#assistantTurnsAtSubmit
    ) {
      this.#firstTokenSeen = true;
      this.telemetry.timing('time-to-first-token', at - this.#thinkingSince);
    }

    const code = view.lastError?.code ?? null;
    if (code !== null && code !== this.#lastErrorCode) {
      // §17's "failure categories". The code is the category; `userMessage` and
      // `details` stay where they are.
      this.telemetry.failure(code);
    }
    this.#lastErrorCode = code;
  }

  #onStateChange(from: PilotViewState['state'], to: PilotViewState['state'], at: number): void {
    if (to === 'listening') {
      this.telemetry.beginTurn();
      this.#listeningSince = at;
      this.#resetAnswerTimings();
    }

    // STT duration spans holding the key and the recognition that follows it:
    // `listening` → `transcribing` → wherever the transcript lands. Measured on
    // the way out of `transcribing`, and also when recognition fails, because
    // "how long did the recogniser take to fail" is the number that matters
    // when the answer is that it did.
    const leavingRecognition =
      (from === 'transcribing' && to !== 'transcribing') ||
      (from === 'listening' && to === 'error');
    if (leavingRecognition && this.#listeningSince !== null) {
      this.telemetry.timing('stt-duration', at - this.#listeningSince);
      this.#listeningSince = null;
    }

    if (to === 'thinking' && from !== 'observing-screen' && from !== 'speaking') {
      this.#thinkingSince = at;
      this.#firstTokenSeen = false;
      this.#firstSentenceSeen = false;
      this.#observationCalls = 0;
      this.#assistantTurnsAtSubmit = countAssistantTurns(this.#previous);
    }

    if (to === 'observing-screen') {
      this.#observationCalls += 1;
      this.telemetry.count('observation-calls', this.#observationCalls);
    }

    if (to === 'speaking' && !this.#firstSentenceSeen && this.#thinkingSince !== null) {
      this.#firstSentenceSeen = true;
      this.telemetry.timing('time-to-first-sentence', at - this.#thinkingSince);
    }

    if (to === 'idle' || to === 'observing' || to === 'error' || to === 'paused') {
      this.#thinkingSince = null;
    }
  }

  #resetAnswerTimings(): void {
    this.#thinkingSince = null;
    this.#firstTokenSeen = false;
    this.#firstSentenceSeen = false;
    this.#observationCalls = 0;
    this.#assistantTurnsAtSubmit = countAssistantTurns(this.#previous);
  }

  // -- plumbing -------------------------------------------------------------

  #setPushToTalk(availability: HotkeyAvailability, binding: HotkeyBinding): void {
    this.#pushToTalk = {
      usable: isHotkeyUsable(availability),
      status: availability.status,
      message: hotkeyUnavailableMessage(availability),
      blockingPermission: hotkeyBlockingPermission(availability),
      label: binding.label,
    };
    this.#publish();
  }

  #publish(): void {
    if (this.#disposed) {
      return;
    }
    const state = this.snapshot();
    for (const listener of this.#listeners) {
      listener(state);
    }
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new PilotError('internal', 'Conversation gate has been disposed', {
        userMessage: 'Pilot is shutting down.',
      });
    }
  }
}
