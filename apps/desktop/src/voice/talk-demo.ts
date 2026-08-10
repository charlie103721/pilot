import { createScriptedModelSource, type ScriptedModelSource } from '@pilot/agent';
import { isTextFallbackAvailable } from '@pilot/interaction';
import { hotkeyUnavailableMessage, type PilotViewState } from '@pilot/platform';
import { AX_ELEMENTS, OUTSIDE_THE_WINDOW, OVER_THE_BUTTON } from '../observation/ask-demo.js';
import {
  createObservationRig,
  DEMO_DESKTOP,
  type ObservationRig,
} from '../observation/observe-rig.js';

/**
 * PR-032's demo: **hold the key, speak, let go, and the question is asked.**
 *
 *     pnpm demo:talk
 *
 * This is where voice enters the conversation. Until now every question in this
 * repository has been typed.
 *
 * ## What is real here, and what is not
 *
 * Real, and the shipping code: `MacHotkeyAdapter` and its host-side coalescer
 * (PR-015) over the framed stdio protocol, `MacSpeechInputAdapter` and the
 * helper's sequence-numbered recogniser queue (PR-014), PR-025's
 * `SpeechInputBinding`, the 330-cell interaction transition table, the question
 * envelope and the question anchor (PR-024/PR-031), `PiAgentSession` and Pi's
 * agent loop, and `main/voice-runtime.ts` — the mapping this PR adds.
 *
 * **NO KEY HAS EVER BEEN PRESSED AND NO AUDIO HAS EVER BEEN RECORDED.** There
 * is no macOS here, no `CGEventTap`, no microphone and no Apple Speech (runbook
 * §5 amendment 8). Every key transition below comes from the Node helper stub's
 * scripted tap, and every word of every transcript is a string the stub was
 * told to emit. What that proves is that Pilot's half is correct given a tap
 * and a recogniser that behave as macOS's do — including badly. What it cannot
 * say anything about is whether macOS lets Pilot have either. Section 8 says so
 * again, where it cannot be skipped, and `docs/handoff.md` §1 step 12 is the
 * Mac run that settles it.
 *
 * The model is Pi's faux provider with a scripted reply (`docs/handoff.md` §2):
 * no sign-in has happened and no request has ever left this machine.
 */

export interface TalkDemoResult {
  readonly lines: readonly string[];
}

const GRANTED = {
  'screen-recording': 'granted',
  accessibility: 'granted',
  microphone: 'granted',
  'speech-recognition': 'granted',
} as const;

/** What the scripted recogniser "hears", partial by partial. */
const PARTIALS = ['what', 'what does this', 'what does this auto renew'] as const;
const FINAL = 'What does this Auto Renew toggle do?';

const RESTING = new Set<PilotViewState['state']>(['idle', 'observing', 'paused', 'error']);

/** Bounded wait on a predicate. A wedged demo fails loudly instead of hanging. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settleRun(rig: ObservationRig): Promise<void> {
  await rig.controller.settled();
  await waitFor('the run to settle', () => RESTING.has(rig.controller.snapshot().state), 20_000);
  await rig.controller.settled();
}

/**
 * Every distinct `liveTranscript` the panel would have rendered, in order.
 *
 * `PilotViewState.liveTranscript` is the single answer to "what has Pilot heard
 * so far" (PR-006), and `ConversationPanel.tsx` has rendered it since PR-010.
 * Recording the view stream is therefore exactly what the panel shows, not a
 * parallel description of it.
 */
function recordLiveTranscript(rig: ObservationRig): {
  readonly seen: readonly string[];
  stop(): void;
} {
  const seen: string[] = [];
  const note = (view: PilotViewState): void => {
    const live = view.liveTranscript;
    if (live !== null && live !== '' && live !== seen[seen.length - 1]) {
      seen.push(live);
    }
  };
  note(rig.controller.snapshot());
  const off = rig.controller.subscribe(note);
  return { seen, stop: off };
}

/** The stub's own hotkey script names, so the sections read as key presses. */
type Stub = Record<string, unknown>;

function speechScript(steps: readonly { on: string; emit: readonly unknown[] }[]): Stub {
  return { scripts: [{ steps }] };
}

async function watching(
  stub: Stub,
  model: ScriptedModelSource,
  options: { readonly record?: boolean; readonly select?: boolean } = {},
): Promise<ObservationRig> {
  const rig = await createObservationRig({
    stub: { permissions: GRANTED, desktop: DEMO_DESKTOP, axElements: AX_ELEMENTS, ...stub },
    modelSource: model,
    ...(options.record === true ? { recordRequests: true } : {}),
    // The stub's capture frames are not a decodable image (runbook cross-lane
    // issue 11) and nothing here decodes one — no section asks the model to
    // look. Joining voice to grounding is PR-034.
    capturePollIntervalMs: 3_600_000,
  });
  if (options.select !== false) {
    await rig.permissions.refresh();
    await rig.observation.refreshAttribution();
    const window = await rig.firstWindow();
    await rig.windows.act({ type: 'select', windowId: window.windowId });
    await rig.controller.settled();
  }
  return rig;
}

/**
 * Presses the key.
 *
 * On a Mac this is a finger on Right Option while another application is in
 * front. Here it is the stub playing the next entry of `hotkeyScripts`, which
 * it does once per `hotkey.start` — so re-issuing `hotkey.start` is how this
 * walkthrough asks for the *next* scripted transition. Nothing about the host
 * half changes: `MacHotkeyAdapter` cannot tell the difference between a scripted
 * key event and a real one, which is the whole point of the stub.
 */
async function pressKey(rig: ObservationRig): Promise<void> {
  await rig.voice.start();
  await waitFor('the key press to reach the machine', () => rig.voice.stats().downs > 0);
}

async function releaseKey(rig: ObservationRig): Promise<void> {
  await rig.hotkey.start();
  await waitFor('the key release to reach the machine', () => rig.voice.stats().ups > 0);
}

function answerOf(rig: ObservationRig): string {
  return String(
    rig.controller
      .snapshot()
      .transcript.filter((entry) => entry.role === 'assistant')
      .at(-1)?.text,
  );
}

function questionOf(rig: ObservationRig): string {
  return String(
    rig.controller
      .snapshot()
      .transcript.filter((entry) => entry.role === 'user')
      .at(-1)?.text,
  );
}

interface RecordedMessage {
  readonly role?: unknown;
  readonly content?: unknown;
}

/** The `<context>` block of the last user turn the provider actually received. */
function lastContext(source: ScriptedModelSource): string | null {
  const last = source.requests[source.requests.length - 1];
  if (last === undefined) {
    return null;
  }
  let context: string | null = null;
  for (const message of JSON.parse(last) as readonly RecordedMessage[]) {
    if (message.role !== 'user') {
      continue;
    }
    const blocks = Array.isArray(message.content)
      ? (message.content as readonly Record<string, unknown>[])
      : [];
    const text = blocks.find((block) => block['type'] === 'text');
    const body = String(
      text?.['text'] ?? (typeof message.content === 'string' ? message.content : ''),
    );
    const opened = body.indexOf('<context>');
    context = opened === -1 ? null : body.slice(opened).trimEnd();
  }
  return context;
}

export async function runTalkDemo(): Promise<TalkDemoResult> {
  const lines: string[] = [];
  const say = (line = ''): void => {
    lines.push(line);
  };

  say('PR-032 — real push-to-talk input');
  say('='.repeat(72));
  say();
  say('Real: MacHotkeyAdapter and its coalescer (PR-015), MacSpeechInputAdapter');
  say('      and the helper’s recogniser queue (PR-014), SpeechInputBinding');
  say('      (PR-025), the interaction transition table, the question envelope');
  say('      and anchor (PR-024/031), PiAgentSession and Pi’s agent loop, and');
  say('      main/voice-runtime.ts — the mapping this PR adds.');
  say('NOT REAL: no key has ever been pressed and no audio has ever been');
  say('      recorded. There is no macOS here: every key transition comes from');
  say('      the Node helper stub’s scripted tap and every transcript is a');
  say('      string it was told to emit. The model is Pi’s faux provider.');
  say('      Section 8 restates what that does and does not prove.');
  say();

  // -------------------------------------------------------------------------
  // 1 + 2 + 3 — the boundary, the press, the transcript, the anchor
  // -------------------------------------------------------------------------
  {
    const model = createScriptedModelSource({
      script: [{ say: 'Auto Renew charges the card on file when the plan expires.' }],
    });
    const rig = await watching(
      {
        // Two scripted presses: entry n plays on call n of `hotkey.start`. The
        // gap between them is where the pointer moves and the words arrive.
        hotkeyScripts: [[{ key: 'down' }], [{ key: 'up' }]],
        // A recogniser that emits partials while the key is held and its one
        // accepted transcript when capture ends — the shape Apple Speech has.
        speechInput: speechScript([
          { on: 'start', emit: PARTIALS.map((transcript) => ({ type: 'partial', transcript })) },
          { on: 'stop', emit: [{ type: 'final', transcript: FINAL }] },
        ]),
        pointerScript: [OUTSIDE_THE_WINDOW, OVER_THE_BUTTON],
      },
      model,
      { record: true },
    );
    const readLive = recordLiveTranscript(rig);
    try {
      say('1. the one fake boundary PR-032 replaces');
      say(`   platform:  kind=${rig.platform.kind} — ${rig.platform.reason}`);
      say('   before:    FakeHotkeyAdapter (availability only — nothing turned a');
      say('              key into a command) and FakeSpeechInputAdapter, whose');
      say('              "transcript" was a constant supplied by the test.');
      say('   after:     MacHotkeyAdapter → main/voice-runtime.ts → the machine’s');
      say('              push-to-talk-down/up, and MacSpeechInputAdapter behind');
      say('              PR-025’s SpeechInputBinding.');
      say();

      say('2. hold the key, speak, release — and the question is submitted');
      const before = rig.controller.snapshot().state;
      await pressKey(rig);
      say(`   before the press:      state=${before}`);
      say(
        `   attribution established before anything could listen: ` +
          `${String(rig.voice.attribution()?.verdict)} ` +
          `(${String(rig.voice.attribution()?.confidence)})`,
      );
      say(`   hotkey-down →          state=${rig.controller.snapshot().state}`);
      await waitFor(
        'the first partial transcript',
        () => (rig.controller.snapshot().liveTranscript ?? '') !== '',
      );
      // The pointer moves while the key is held: outside the window, then onto
      // the control the question is about. The wait between them is one 30 Hz
      // coalescing bucket (`DEFAULT_POINTER_MIN_INTERVAL_MS`) — two samples in
      // the same bucket are one sample by design, and the real poller is 33 ms
      // apart for exactly that reason.
      await rig.observation.samplePointer();
      await new Promise((resolve) => setTimeout(resolve, 40));
      await rig.observation.samplePointer();
      await waitFor('every partial', () => readLive.seen.length >= PARTIALS.length);
      say('   live transcript as the partials arrive (what the panel renders):');
      for (const partial of readLive.seen) {
        say(`     | ${partial}`);
      }
      await releaseKey(rig);
      say(`   hotkey-up →            state=${rig.controller.snapshot().state}`);
      const heldFrom = rig.controller.context.utteranceStartedAt;
      const heldTo = rig.controller.context.utteranceEndedAt;
      await settleRun(rig);
      say(`   the accepted transcript became the question: "${questionOf(rig)}"`);
      say(`   and Pilot answered:    "${answerOf(rig)}"`);
      say(
        `   presses=${String(rig.voice.stats().downs)} ` +
          `releases=${String(rig.voice.stats().ups)} ` +
          `synthetic=${String(rig.voice.stats().syntheticUps)}`,
      );
      say();

      say('3. the utterance interval is real, so the anchor stops being degenerate');
      say('   PR-031 built the anchor over `utteranceStartedAt`/`askedAt`. With a');
      say('   typed question both are "now", so the pointer path between them is');
      say('   empty by construction. Push-to-talk fills them with the key-down and');
      say('   key-up instants, and the same anchoring code suddenly has an interval');
      say('   to look at — no change was needed on that side.');
      const anchor = rig.anchoring.lastAnchor();
      const context = lastContext(model);
      say(
        `   utterance interval:    key-down → key-up, both stamped by the ` +
          `machine’s clock (${String((heldTo ?? 0) - (heldFrom ?? 0))} ms of held key)`,
      );
      // Exactly what `PilotQuestionEnvelopeFactory` counts for
      // `QuestionAnchor.pointerSampleCount`: the pointer path between the two
      // instants. For a typed question the two instants are the same, so this
      // is 0 or 1 by construction — which is what "degenerate" meant.
      const path = rig.anchoring.anchors.pointerBetween(heldFrom ?? 0, heldTo ?? 0);
      say(
        `   pointer samples inside it: ${String(path.length)} ` +
          `(inside the window: ${String(
            path.filter(
              (sample) =>
                sample.pointer.normalizedPoint.x >= 0 &&
                sample.pointer.normalizedPoint.x <= 1 &&
                sample.pointer.normalizedPoint.y >= 0 &&
                sample.pointer.normalizedPoint.y <= 1,
            ).length,
          )})`,
      );
      say(
        `   anchor:                insideWindow=${String(anchor?.insideWindow)} ` +
          `skewMs=${String(anchor?.skewMs)} targetRole=${String(anchor?.targetRole)}`,
      );
      say('   what the model was told about the question:');
      for (const line of (context ?? '(none)').split('\n')) {
        say(`     | ${line}`);
      }
      say('   (the pointer left the window and came back while the key was held —');
      say('    two samples inside one utterance, which a typed question cannot');
      say('    produce. `pointerCrossedWindowBorder` is what records it.)');
      say();
    } finally {
      readLive.stop();
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 4 — a synthetic release still lets go of the microphone
  // -------------------------------------------------------------------------
  {
    say('4. the event tap dies while the key is held');
    say('   macOS switches taps off (a slow callback, a security event) and the');
    say('   helper can crash. Either way the real key-up can never arrive, and a');
    say('   machine left in `listening` is an open microphone nobody closed.');
    say('   PR-015 synthesises the release; PR-032’s mapping must not filter it.');
    const model = createScriptedModelSource({
      script: [{ say: 'Auto Renew charges the card on file when the plan expires.' }],
    });
    const rig = await watching(
      {
        hotkeyScripts: [[{ key: 'down' }, { tap: 'disabled-by-user-input' }]],
        speechInput: speechScript([
          { on: 'start', emit: [{ type: 'partial', transcript: 'what does this' }] },
          { on: 'stop', emit: [{ type: 'final', transcript: FINAL }] },
        ]),
        pointer: OVER_THE_BUTTON,
      },
      model,
    );
    try {
      await pressKey(rig);
      await waitFor('the synthetic release', () => rig.voice.stats().syntheticUps > 0);
      await settleRun(rig);
      say(`   presses=${String(rig.voice.stats().downs)}`);
      say(
        `   releases=${String(rig.voice.stats().ups)} of which synthetic=` +
          `${String(rig.voice.stats().syntheticUps)}`,
      );
      say(
        `   the recogniser let go of the microphone: ` +
          `${String(rig.platform.speechInput?.activeUtteranceId === null)}`,
      );
      say(`   state now:             ${rig.controller.snapshot().state}`);
      say(`   the words it did hear became the question: "${questionOf(rig)}"`);
      const availability = rig.voice.availability();
      say(
        `   availability the panel is told: ${availability.status}` +
          `${availability.status === 'unavailable' ? `/${availability.reason}` : ''}`,
      );
      say(`   and the sentence beside the text box:`);
      say(`     "${String(hotkeyUnavailableMessage(availability))}"`);
      say(
        `   text fallback reachable from ${rig.controller.snapshot().state}: ` +
          `${String(isTextFallbackAvailable(rig.controller.snapshot().state))}`,
      );
      say();
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 5 — the microphone is denied
  // -------------------------------------------------------------------------
  {
    say('5. the microphone is denied at the moment of the press (§16)');
    say('   TCC can be revoked while Pilot is running, so the permission gate’s');
    say('   last poll is not a promise. `MacSpeechInputAdapter` probes the helper');
    say('   before it opens anything and refuses; the controller turns that into');
    say('   `failure`, the table answers with `error` — and `error` is the state');
    say('   PR-025’s isTextFallbackAvailable() exists for.');
    const model = createScriptedModelSource({
      script: [{ say: 'Auto Renew charges the card on file when the plan expires.' }],
    });
    const rig = await watching(
      {
        permissions: { ...GRANTED, microphone: 'denied' },
        hotkeyScripts: [[{ key: 'down' }]],
        pointer: OVER_THE_BUTTON,
      },
      model,
      // Deliberately not refreshed: the gate has not told the machine about the
      // revocation yet, which is exactly the window this path defends. Told, the
      // machine would rest in `needs-permission` and PR-008’s onboarding — not
      // the composer — would be the way out. That is a different, deliberate
      // answer and PR-032 does not change it.
      { select: false },
    );
    try {
      const window = await rig.firstWindow();
      await rig.windows.act({ type: 'select', windowId: window.windowId });
      await rig.controller.settled();
      await pressKey(rig);
      await waitFor('the refusal', () => rig.controller.snapshot().state === 'error');
      const failure = rig.controller.snapshot().lastError;
      say(`   state:                 ${rig.controller.snapshot().state}`);
      say(`   code:                  ${String(failure?.code)}`);
      say(`   what the user is told: "${String(failure?.userMessage)}"`);
      say(
        `   text fallback reachable from error: ` + `${String(isTextFallbackAvailable('error'))}`,
      );
      say('   …and it is not a claim. The same question, typed, from `error`:');
      rig.controller.dispatch({ type: 'submit-text', text: FINAL });
      await settleRun(rig);
      say(`     question: "${questionOf(rig)}"`);
      say(`     answer:   "${answerOf(rig)}"`);
      say();
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 6 — voice is gated on TCC attribution (runbook follow-up 12)
  // -------------------------------------------------------------------------
  {
    say('6. macOS credits Pilot’s permissions to something else');
    say('   PR-011’s verdict is the difference between "the OS says granted" and');
    say('   "the grant reaches this process". PR-028 wired it into the observation');
    say('   conditions. Voice had no such gate: the recogniser would have read');
    say('   `granted`, opened a microphone the grant does not reach, and heard');
    say('   nothing — the silent wrong answer PR-011 exists to prevent.');
    const model = createScriptedModelSource({
      script: [{ say: 'Auto Renew charges the card on file when the plan expires.' }],
    });
    const rig = await watching(
      {
        // macOS holds the *helper* responsible, not the application.
        attribution: { responsibleProcessPid: 4321 },
        hotkeyScripts: [[{ key: 'down' }, { key: 'up' }]],
        speechInput: speechScript([{ on: 'start', emit: [{ type: 'final', transcript: FINAL }] }]),
        pointer: OVER_THE_BUTTON,
      },
      model,
    );
    try {
      await rig.voice.start();
      // Give the stub every chance to play a key the tap should never have had.
      await new Promise((resolve) => setTimeout(resolve, 120));
      const verdict = rig.voice.attribution();
      const availability = rig.voice.availability();
      say(`   verdict:               ${String(verdict?.verdict)} (${String(verdict?.reason)})`);
      say(`   the tap was started:   ${String(rig.voice.enabled)}`);
      say(
        `   availability:          ${availability.status}` +
          `${availability.status === 'unavailable' ? `/${availability.reason}` : ''}`,
      );
      say(`   what the user is told:`);
      say(`     "${String(hotkeyUnavailableMessage(availability))}"`);
      say(`   presses that became commands: ${String(rig.voice.stats().downs)}`);
      say(
        `   the panel’s push-to-talk state: usable=` +
          `${String((await rig.conversation.refresh()).pushToTalk?.usable)}`,
      );
      say(`   state:                 ${rig.controller.snapshot().state}`);
      say(
        `   text fallback reachable: ` +
          `${String(isTextFallbackAvailable(rig.controller.snapshot().state))}`,
      );
      rig.controller.dispatch({ type: 'submit-text', text: FINAL });
      await settleRun(rig);
      say(`     typed anyway: "${answerOf(rig)}"`);
      say();
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 7 — the disclosure finally has a route to the panel
  // -------------------------------------------------------------------------
  {
    say('7. where the audio would go (runbook follow-up 13)');
    say('   PR-014 built `SpeechInputAdapter.disclosure()` as renderable data and');
    say('   PR-010 built the panel half; nothing joined them, so a Mac that cannot');
    say('   recognise the user’s language locally refused to listen with a message');
    say('   nobody would ever see. PR-032 passes the real adapter as the gate’s');
    say('   `speech` source, which is the whole of the fix.');
    const model = createScriptedModelSource({ script: [{ say: '…' }] });
    for (const [label, speechInput] of [
      ['on device        ', { supportsOnDevice: true, locale: 'en-US' }],
      ['would leave      ', { supportsOnDevice: false, locale: 'en-US' }],
    ] as const) {
      const rig = await watching({ speechInput, pointer: OVER_THE_BUTTON }, model, {
        select: false,
      });
      try {
        const state = await rig.conversation.refresh();
        const disclosure = state.disclosure;
        say(
          `   ${label} destination=${String(disclosure?.destination)} ` +
            `leavesDevice=${String(disclosure?.leavesDevice)} ` +
            `allowed=${String(disclosure?.allowed)} reason=${String(disclosure?.reason)}`,
        );
        say(`                      "${String(disclosure?.headline)}"`);
      } finally {
        await rig.dispose();
      }
    }
    say('   (system-design §11 is why the second row is `allowed=false`: Pilot');
    say('    refuses to record rather than sending audio off the machine, and');
    say('    §16’s text box is what the user is left with.)');
    say();
  }

  // -------------------------------------------------------------------------
  // 8 — what none of this proves
  // -------------------------------------------------------------------------
  say('8. what none of the above proves (docs/handoff.md §1 step 12, §2)');
  for (const [head, ...rest] of [
    [
      'NO KEY HAS EVER BEEN PRESSED. Nothing in this repository has ever created',
      'a CGEventTap, and the Swift that would has never been compiled. Whether',
      'Accessibility alone is enough for a keyboard tap — or macOS also demands',
      'Input Monitoring, which Pilot does not model — is still unknown.',
    ],
    [
      'NO AUDIO HAS EVER BEEN RECORDED. No microphone has been opened, no',
      'AVAudioEngine has run and no SFSpeechRecognizer has produced a word. The',
      'partials and the finals above are strings the stub was handed.',
    ],
    [
      'the attribution verdict in section 6 is scripted, so it says the wiring',
      'reacts to a failing verdict — never which verdict a real Mac returns.',
    ],
    [
      'no model chose any of these answers: Pi’s faux provider replied from a',
      'script, and no request has ever left this machine.',
    ],
  ]) {
    say(`   - ${String(head)}`);
    for (const line of rest) {
      say(`     ${line}`);
    }
  }

  return { lines };
}
