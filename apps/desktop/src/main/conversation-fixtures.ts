import {
  asUtteranceId,
  PilotError,
  type SpeechRecognitionDisclosure,
  type UtteranceId,
} from '@pilot/shared';
import type { HotkeyAvailability, TranscriptEntry } from '@pilot/platform';
import type { FakeInteractionController } from '@pilot/platform/fakes';
import { FIXTURE_WINDOW_RETINA } from '@pilot/platform/fakes';
import type { ConversationFixtureName } from '../ipc/schemas.js';
import type { ConversationGate, SpeechDisclosureSource } from './conversation-gate.js';

/**
 * Fixture-driven conversation replay.
 *
 * `docs/implementation.md` requires PR-010 to demo "a fixture-driven
 * conversation and ring-buffer telemetry". Nothing in this build can *cause* a
 * conversation — there is no recogniser (PR-014), no agent (PR-029) and no
 * capture (PR-028) — so the replay drives the same fake controller the panel is
 * already reading and lets the real {@link ConversationGate} derive the §17
 * timings from the resulting view-state stream, exactly as it will from the
 * real controller. Only the measurements the view state cannot show
 * (capture-to-observation latency, image bytes, the active image count) are
 * written into the ring directly, which is the same call the observation lane
 * will make.
 *
 * The scripts below carry question and answer text, because a conversation
 * panel with no words in it demonstrates nothing. **None of that text reaches
 * the telemetry ring**: it goes into `PilotViewState.transcript`, which is what
 * the transcript renders, and the ring only ever receives numbers. The
 * diagnostics privacy test drives these exact fixtures and then asserts that
 * none of their words appear anywhere in the diagnostics surface.
 */

/**
 * A clock a replay can move forward.
 *
 * Wall time still passes underneath, so a real interaction in this build still
 * gets a real timing; a replay adds its scripted deltas on top so the numbers
 * on screen are the ones the script says rather than however long a click took.
 */
export interface ReplayClock {
  now(): number;
  advance(milliseconds: number): void;
}

export function createReplayClock(base: () => number = () => Date.now()): ReplayClock {
  let offset = 0;
  return {
    now: () => base() + offset,
    advance: (milliseconds: number) => {
      offset += Math.max(0, milliseconds);
    },
  };
}

// ---------------------------------------------------------------------------
// Voice fixtures
// ---------------------------------------------------------------------------

/**
 * Push-to-talk availability, chosen by the environment.
 *
 * `PILOT_HOTKEY_FIXTURE=permission-missing pnpm dev` is how a reviewer reaches
 * the state runbook follow-up 4 is about: no way to speak at all, so the text
 * box is the only way to ask. There is no real `CGEventTap` on Linux and none
 * of PR-015's Mac verification has run (runbook §5 amendment 8), so an
 * environment switch is the only way to see it without editing source.
 */
export function resolveHotkeyAvailability(raw: string | undefined): HotkeyAvailability {
  switch (raw) {
    case 'stopped':
      return { status: 'stopped' };
    case 'permission-missing':
      return {
        status: 'unavailable',
        reason: 'permission-missing',
        permission: 'accessibility',
        detail: 'Accessibility has not been granted to Pilot.',
      };
    case 'listener-rejected':
      return {
        status: 'unavailable',
        reason: 'listener-rejected',
        detail: 'The system refused to create the event tap.',
      };
    case 'unsupported':
      return {
        status: 'unavailable',
        reason: 'unsupported',
        detail: 'This platform has no global hotkey mechanism.',
      };
    default:
      return { status: 'active' };
  }
}

/**
 * What the recogniser would do with the audio, chosen by the environment.
 *
 * PR-014 added `SpeechInputAdapter.disclosure()` and the shape it returns, and
 * runbook follow-up 13 records that nothing surfaced it: a Mac that cannot
 * recognise the user's language locally otherwise refuses to listen with a
 * message nobody sees, which reads as a broken microphone. The panel now has a
 * route for it; this fixture is what proves the route works before PR-032 wires
 * the real adapter.
 *
 * `PILOT_SPEECH_DISCLOSURE=remote pnpm dev` shows the case that matters:
 * audio leaving the machine.
 */
export function resolveSpeechDisclosure(
  raw: string | undefined,
): SpeechRecognitionDisclosure | null {
  switch (raw) {
    case 'remote':
      return {
        destination: 'remote-service',
        leavesDevice: true,
        allowed: true,
        reason: 'remote-allowed',
        service: 'Apple Speech Recognition',
        locale: 'en-GB',
        headline: 'What you say would be sent to Apple to be transcribed.',
        detail:
          'This Mac cannot recognise this language on device, so the audio leaves the machine. ' +
          'Type your question instead if you would rather it did not.',
      };
    case 'refused':
      return {
        destination: 'unknown',
        leavesDevice: false,
        allowed: false,
        reason: 'on-device-unsupported',
        service: null,
        locale: 'cy-GB',
        headline: 'Pilot will not listen in this language.',
        detail:
          'On-device recognition is required and this Mac cannot do it for this language. ' +
          'Type your question instead.',
      };
    case 'on-device':
      return {
        destination: 'on-device',
        leavesDevice: false,
        allowed: true,
        reason: 'on-device',
        service: null,
        locale: 'en-GB',
        headline: 'Speech stays on this Mac.',
        detail: 'What you say is turned into text on this machine and no audio leaves it.',
      };
    default:
      return null;
  }
}

/** A {@link SpeechDisclosureSource} that answers with a fixed fixture. */
export function createFakeSpeechDisclosureSource(
  disclosure: SpeechRecognitionDisclosure | null,
): SpeechDisclosureSource | undefined {
  if (disclosure === null) {
    return undefined;
  }
  return { disclosure: async () => disclosure };
}

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

export type ConversationFixtureDriver = (fixture: ConversationFixtureName) => void;

export interface ConversationFixtureDriverOptions {
  readonly controller: FakeInteractionController;
  readonly gate: ConversationGate;
  readonly clock: ReplayClock;
}

/**
 * The words the fixtures put on screen.
 *
 * Exported so the privacy tests can assert against the exact text rather than
 * against a copy of it that could drift: if these words ever appear on the
 * diagnostics surface, the test that says they do not is looking at the right
 * strings.
 */
export const FIXTURE_QUESTION = 'What does this Auto Renew toggle actually do?';

/** The answer, as the model would stream it: clause by clause. */
export const FIXTURE_ANSWER_CHUNKS: readonly string[] = [
  'Auto Renew keeps this subscription going at the end of each billing period.',
  ' With it on, the card on file is charged again on the renewal date.',
  ' With it off, access continues until that date and then stops.',
];

const SPEECH_FAILURE = new PilotError('speech-input-failed', 'The recogniser stopped responding', {
  userMessage:
    'Pilot could not turn what you said into text. Type your question instead — it still works.',
  details: { simulated: true },
});

interface Turn {
  readonly question: UtteranceId;
  readonly answer: UtteranceId;
}

export function createFakeConversationDriver(
  options: ConversationFixtureDriverOptions,
): ConversationFixtureDriver {
  const { controller, gate, clock } = options;
  let turnNumber = 0;

  const nextTurn = (): Turn => {
    turnNumber += 1;
    const stamp = String(turnNumber).padStart(4, '0');
    return {
      question: asUtteranceId(`utt-fixture-${stamp}-q`),
      answer: asUtteranceId(`utt-fixture-${stamp}-a`),
    };
  };

  const entry = (
    utteranceId: UtteranceId,
    role: TranscriptEntry['role'],
    text: string,
    pending: boolean,
  ): TranscriptEntry => ({ utteranceId, role, text, at: clock.now(), pending });

  /** Replaces the newest assistant entry, which is how a streamed answer grows. */
  const growAnswer = (id: UtteranceId, text: string, pending: boolean): void => {
    const transcript = controller.snapshot().transcript.filter((row) => row.utteranceId !== id);
    controller.set({ transcript: [...transcript, entry(id, 'assistant', text, pending)] });
  };

  const watchRetina = (): void => {
    controller.set({
      selectedWindow: FIXTURE_WINDOW_RETINA,
      observationEnabled: true,
      state: 'observing',
      speaking: false,
      liveTranscript: null,
      lastError: null,
    });
  };

  /** Everything from "the question is submitted" to "the answer is complete". */
  const answer = (turn: Turn, options: { readonly interruptAfterChunk?: number }): void => {
    clock.advance(210);
    // The model asks to look at the screen. One observation call for this turn.
    controller.set({ state: 'observing-screen' });
    clock.advance(118);
    // Not visible in the view state: the observation lane measures these
    // (PR-028/PR-030) and hands the gate numbers, never pixels.
    gate.telemetry.timing('capture-to-observation', 118);
    gate.telemetry.count('image-bytes', 412_608);
    gate.telemetry.count('active-images', 1);

    clock.advance(240);
    controller.set({ state: 'thinking' });

    clock.advance(190);
    growAnswer(turn.answer, FIXTURE_ANSWER_CHUNKS[0] ?? '', true);

    clock.advance(95);
    controller.set({ state: 'speaking', speaking: true });

    for (let index = 1; index < FIXTURE_ANSWER_CHUNKS.length; index += 1) {
      if (options.interruptAfterChunk === index) {
        gate.noteCommand({ type: 'interrupt' });
        // system-design §15: new speech stops TTS and abandons the run. The
        // partial answer stays on screen, still `pending`, which is what the
        // view model renders as `interrupted`.
        controller.set({ state: 'observing', speaking: false });
        return;
      }
      clock.advance(140);
      growAnswer(turn.answer, FIXTURE_ANSWER_CHUNKS.slice(0, index + 1).join(''), true);
    }

    clock.advance(160);
    growAnswer(turn.answer, FIXTURE_ANSWER_CHUNKS.join(''), false);
    controller.set({ state: 'observing', speaking: false });
  };

  const spoken = (options: { readonly interruptAfterChunk?: number }): void => {
    watchRetina();
    const turn = nextTurn();

    controller.set({ state: 'listening', liveTranscript: '', lastError: null });
    clock.advance(760);
    controller.set({ liveTranscript: 'what does this auto renew' });
    clock.advance(420);
    controller.set({ state: 'transcribing', liveTranscript: FIXTURE_QUESTION.toLowerCase() });
    clock.advance(340);
    controller.set({
      state: 'thinking',
      liveTranscript: null,
      transcript: [
        ...controller.snapshot().transcript,
        entry(turn.question, 'user', FIXTURE_QUESTION, false),
      ],
    });
    answer(turn, options);
  };

  return (fixture: ConversationFixtureName): void => {
    switch (fixture) {
      case 'spoken-question':
        spoken({});
        return;

      case 'typed-question': {
        watchRetina();
        const turn = nextTurn();
        // The command the panel would have sent. Routed through the gate so the
        // turn counter and any abort are recorded exactly as they are in the app.
        gate.noteCommand({ type: 'submit-text', text: FIXTURE_QUESTION });
        controller.set({
          state: 'thinking',
          liveTranscript: null,
          lastError: null,
          transcript: [
            ...controller.snapshot().transcript,
            entry(turn.question, 'user', FIXTURE_QUESTION, false),
          ],
        });
        answer(turn, {});
        return;
      }

      case 'interrupted-answer':
        spoken({ interruptAfterChunk: 1 });
        return;

      case 'stt-failure': {
        watchRetina();
        controller.set({ state: 'listening', liveTranscript: '', lastError: null });
        clock.advance(880);
        controller.set({ liveTranscript: 'what does this' });
        clock.advance(430);
        // system-design §16: the recogniser fails, and the way out is typing.
        // The machine's `error` state accepts `submit-text` (PR-025), which is
        // why the panel's text box must stay live here.
        controller.set({
          state: 'error',
          liveTranscript: null,
          lastError: SPEECH_FAILURE.toJSON(),
        });
        return;
      }

      case 'reset':
        turnNumber = 0;
        gate.telemetry.clear();
        controller.set({
          state: 'idle',
          selectedWindow: null,
          observationEnabled: false,
          speaking: false,
          liveTranscript: null,
          transcript: [],
          lastError: null,
        });
        return;
    }
  };
}
