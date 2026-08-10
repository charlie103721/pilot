import { asSpeechId, type SpeechId } from '@pilot/shared';
import { createScriptedModelSource, type ScriptedModelSource } from '@pilot/agent';
import {
  isTextFallbackAvailable,
  NULL_SCHEDULER,
  speechChunkId,
  type VoiceDiagnostic,
} from '@pilot/interaction';
import type { PilotViewState, TranscriptEntry } from '@pilot/platform';
import { OVER_THE_BUTTON } from '../observation/ask-demo.js';
import {
  createObservationRig,
  DEMO_DESKTOP,
  type ObservationRig,
  type ObservationRigOptions,
} from '../observation/observe-rig.js';

/**
 * PR-033's demo: **hear the answer, while it also streams in the panel.**
 *
 *     pnpm demo:speak
 *
 * PR-032 made Pilot hear. This closes the loop: the answer is spoken.
 *
 * ## What is real here, and what is not
 *
 * Real, and the shipping code: `MacSpeechOutputAdapter` and the helper's
 * sequence-numbered synthesiser queue (PR-014), PR-026's `SpeechOutputBinding`
 * and its `<speechId>#<n>` chunk identifiers, the 330-cell interaction
 * transition table, PR-027's injected phrase-timeout scheduler, `PiAgentSession`
 * and Pi's agent loop, and `main/speech-runtime.ts` — the seam this PR adds.
 *
 * **NOTHING HAS EVER BEEN SPOKEN ALOUD.** There is no macOS here, no
 * `AVSpeechSynthesizer`, no voice and no audio device (runbook §5 amendment 8).
 * Every `started`, `finished`, `stopped` and `error` below comes from the Node
 * helper stub's scripted synthesiser. What that proves is that Pilot's half is
 * correct given a synthesiser that behaves as macOS's does — including badly.
 * What it cannot say is whether a single word was audible. Section 8 says so
 * again, and `docs/handoff.md` §1 step 13 is the Mac run that settles it.
 *
 * The model is Pi's faux provider with a scripted reply (`docs/handoff.md` §2).
 */

export interface SpeakDemoResult {
  readonly lines: readonly string[];
}

const GRANTED = {
  'screen-recording': 'granted',
  accessibility: 'granted',
  microphone: 'granted',
  'speech-recognition': 'granted',
} as const;

const QUESTION = 'What does this Auto Renew toggle do?';

/** Three sentences, so the answer is spoken as more than one utterance. */
const ANSWER =
  'Auto Renew charges the card on file when the plan expires. ' +
  'Turning it off stops the next charge. ' +
  'You can switch it back on at any time.';

const RESTING = new Set<PilotViewState['state']>(['idle', 'observing', 'paused', 'error']);

/** Bounded wait on a predicate. A wedged demo fails loudly instead of hanging. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
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
  await waitFor('the run to settle', () => RESTING.has(rig.controller.snapshot().state), 25_000);
  await rig.controller.settled();
}

async function watching(
  stub: Record<string, unknown>,
  model: ScriptedModelSource,
  options: Partial<ObservationRigOptions> = {},
): Promise<ObservationRig> {
  const rig = await createObservationRig({
    stub: { permissions: GRANTED, desktop: DEMO_DESKTOP, pointer: OVER_THE_BUTTON, ...stub },
    modelSource: model,
    recordRequests: true,
    // No section asks the model to look, and the stub's capture frames are not a
    // decodable image (runbook cross-lane issue 11). Joining voice to grounding
    // is PR-034.
    capturePollIntervalMs: 3_600_000,
    ...options,
  });
  await rig.permissions.refresh();
  await rig.observation.refreshAttribution();
  const window = await rig.firstWindow();
  await rig.windows.act({ type: 'select', windowId: window.windowId });
  await rig.controller.settled();
  return rig;
}

/** Every `speech.output.speak` that crossed the framed stdio protocol, in order. */
function spokenChunkIds(rig: ObservationRig): readonly string[] {
  return rig.wire
    .filter((request) => request.op === 'speech.output.speak')
    .map((request) => String(request.payload['speechId']));
}

function spokenTexts(rig: ObservationRig): readonly string[] {
  return rig.wire
    .filter((request) => request.op === 'speech.output.speak')
    .map((request) => String(request.payload['text']));
}

function assistantEntry(rig: ObservationRig): TranscriptEntry | undefined {
  return rig.controller
    .snapshot()
    .transcript.filter((entry) => entry.role === 'assistant')
    .at(-1);
}

function answerOf(rig: ObservationRig): string {
  return String(assistantEntry(rig)?.text);
}

/**
 * Records the machine's own speech lifecycle, as the panel sees it.
 *
 * `PilotViewState.speaking` is one bit; what matters for a multi-chunk answer is
 * that it goes up **once** for the whole answer and down **once**, which is the
 * property `SpeechOutputBinding` exists to provide.
 */
function recordSpeaking(rig: ObservationRig): { readonly edges: readonly string[] } {
  const edges: string[] = [];
  let last = rig.controller.snapshot().speaking;
  rig.controller.subscribe((view) => {
    if (view.speaking !== last) {
      last = view.speaking;
      edges.push(view.speaking ? 'speaking' : 'silent');
    }
  });
  return { edges };
}

function collectDiagnostics(rig: ObservationRig): { readonly seen: VoiceDiagnostic[] } {
  const seen: VoiceDiagnostic[] = [];
  rig.controller.subscribeVoiceDiagnostics((diagnostic) => seen.push(diagnostic));
  return { seen };
}

/** Diagnostics that mean the chunk identifiers did not line up. */
function unknownChunkCount(diagnostics: readonly VoiceDiagnostic[]): number {
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.kind === 'discarded-speech-event' && diagnostic.reason === 'unknown-chunk',
  ).length;
}

export async function runSpeakDemo(): Promise<SpeakDemoResult> {
  const lines: string[] = [];
  const say = (line = ''): void => {
    lines.push(line);
  };

  say('PR-033 — spoken response');
  say('='.repeat(72));
  say();
  say('Real: MacSpeechOutputAdapter and the helper’s synthesiser queue (PR-014),');
  say('      SpeechOutputBinding and its <speechId>#<n> chunks (PR-026), the');
  say('      interaction transition table, PR-027’s injected phrase-timeout');
  say('      scheduler, PiAgentSession and Pi’s agent loop, and');
  say('      main/speech-runtime.ts — the seam this PR adds.');
  say('NOT REAL: NOTHING HAS EVER BEEN SPOKEN ALOUD. There is no macOS here, no');
  say('      AVSpeechSynthesizer, no voice and no audio device. Every speech');
  say('      callback below comes from the Node helper stub. The model is Pi’s');
  say('      faux provider. Section 8 restates what that does and does not prove.');
  say();

  // -------------------------------------------------------------------------
  // 1 + 2 + 3 — the boundary, the spoken answer, the chunk identifiers
  // -------------------------------------------------------------------------
  {
    const model = createScriptedModelSource({ script: [{ say: ANSWER }] });
    const rig = await watching({}, model);
    const speaking = recordSpeaking(rig);
    const diagnostics = collectDiagnostics(rig);
    try {
      say('1. the one fake boundary PR-033 replaces');
      say(`   platform:  kind=${rig.platform.kind} — ${rig.platform.reason}`);
      say('   before:    createSilentSpeechOutputAdapter in main/interaction-');
      say('              runtime.ts — started, then finished on the next');
      say('              microtask, and no sound claimed or produced.');
      say('   after:     MacSpeechOutputAdapter → main/speech-runtime.ts → the');
      say('              machine’s speak / stop-speech, with the silent adapter');
      say('              deleted (runbook follow-up 24).');
      say(
        `   voices the platform reports: ` +
          `${rig.speech.voices().join(', ') || '(none)'} (available=${String(
            rig.speech.available(),
          )})`,
      );
      say();

      say('2. ask, and hear the answer while it also streams into the panel');
      rig.controller.dispatch({ type: 'submit-text', text: QUESTION });
      await settleRun(rig);
      say(`   question:  "${QUESTION}"`);
      say(`   answer:    "${answerOf(rig)}"`);
      say('   what the synthesiser was actually handed, in order:');
      for (const [index, text] of spokenTexts(rig).entries()) {
        say(`     ${String(index)}. ${text}`);
      }
      say(
        `   chunks the synthesiser accepted=${String(rig.speech.stats().accepted)} ` +
          `silenced=${String(rig.speech.stats().silenced)}`,
      );
      say(`   the panel’s speaking indicator went: ${speaking.edges.join(' → ')}`);
      say('   (once up and once down for the whole answer — the machine never');
      say('    learns its answer was cut into pieces, which is what stops a');
      say('    synthesiser finishing chunk 1 from ending the turn mid-sentence.)');
      say(`   state now: ${rig.controller.snapshot().state}`);
      say();

      say('3. the per-chunk identifiers, echoed (runbook follow-up 5)');
      say('   PR-026 names each utterance <speechId>#<n> and SpeechOutputBinding');
      say('   matches every callback against the chunk in flight. An adapter that');
      say('   reported the stream id, or one of its own, would have every');
      say('   callback discarded as `unknown-chunk` and the answer would never');
      say('   report completion. Read off the wire, not off a comment:');
      const ids = spokenChunkIds(rig);
      const stream = ids[0]?.split('#')[0] ?? '(none)';
      for (const [index, id] of ids.entries()) {
        const expected = speechChunkId(asSpeechId(stream), index);
        say(`     ${id}   matches speechChunkId(stream, ${String(index)}) = ${expected}`);
      }
      say(`   one stream id behind all of them: ${stream}`);
      say(
        `   callbacks discarded as unknown-chunk: ` +
          `${String(unknownChunkCount(diagnostics.seen))}`,
      );
      say(
        `   the answer reported completion: ` +
          `${String(assistantEntry(rig)?.pending === false)} ` +
          `(a mismatched id here would leave it pending for ever)`,
      );
      say();
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 4 — the synthesiser fails, and the answer survives it
  // -------------------------------------------------------------------------
  {
    say('4. the synthesiser fails mid-answer (system-design §16)');
    say('   §16 says "TTS fails → continue showing streamed text". The table takes');
    say('   `speech-failed` to `error`, and that row’s teardown emits');
    say('   `interrupt-run` — so a failure on chunk 2 of an answer that is still');
    say('   streaming would abort the model run and lose the rest of the reply.');
    say('   main/speech-runtime.ts is where that stops: no `error` ever leaves the');
    say('   seam. A failed chunk becomes silence and the stream carries on.');
    const model = createScriptedModelSource({ script: [{ say: ANSWER }] });
    const rig = await watching(
      { speechOutput: { scripts: [[{ type: 'started' }, { type: 'error' }]] } },
      model,
    );
    try {
      rig.controller.dispatch({ type: 'submit-text', text: QUESTION });
      await settleRun(rig);
      say(`   state:                 ${rig.controller.snapshot().state} (not "error")`);
      say(`   lastError:             ${String(rig.controller.snapshot().lastError?.code ?? null)}`);
      say(
        `   chunks accepted=${String(rig.speech.stats().accepted)} ` +
          `silenced=${String(rig.speech.stats().silenced)} ` +
          `(each was taken and then failed)`,
      );
      say(`   the answer is still on screen, in full:`);
      say(`     "${answerOf(rig)}"`);
      say(`   and it is complete: pending=${String(assistantEntry(rig)?.pending)}`);
      say(
        `   text fallback reachable: ` +
          `${String(isTextFallbackAvailable(rig.controller.snapshot().state))}`,
      );
      say();
    } finally {
      await rig.dispose();
    }
  }

  {
    say('   …and a Mac with no voice installed at all:');
    const model = createScriptedModelSource({ script: [{ say: ANSWER }] });
    const rig = await watching({ speechOutput: { available: false, voices: [] } }, model);
    try {
      say(
        `   availability: available=${String(rig.speech.available())} ` +
          `voices=${String(rig.speech.voices().length)}`,
      );
      rig.controller.dispatch({ type: 'submit-text', text: QUESTION });
      await settleRun(rig);
      say(
        `   round trips to the synthesiser: ${String(spokenChunkIds(rig).length)} ` +
          `(nothing is asked of a platform that has said it cannot speak)`,
      );
      say(
        `   chunks silenced=${String(rig.speech.stats().silenced)}, ` +
          `state=${rig.controller.snapshot().state}`,
      );
      say(`   the answer, read rather than heard: "${answerOf(rig)}"`);
      say();
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 5 — stopping something that was never started (runbook follow-up 15)
  // -------------------------------------------------------------------------
  {
    say('5. stop() for a stream the synthesiser never started (follow-up 15)');
    say('   PR-027 stops speech the instant an interruption lands, which can be');
    say('   before the first chunk of that stream ever reached the synthesiser.');
    say('   That must be a no-op, not an error: an exception here would arrive as');
    say('   `failure` and then as `error`, turning an interruption into a broken');
    say('   turn.');
    const model = createScriptedModelSource({ script: [{ say: ANSWER }] });
    const rig = await watching({}, model);
    try {
      const events: string[] = [];
      const off = rig.speech.speechOutput.subscribe((event) => events.push(event.type));
      const never: SpeechId = speechChunkId(asSpeechId('speech-never-opened'), 0);
      await rig.speech.speechOutput.stop(never);
      off();
      say(`   stop("${never}") threw: false`);
      say(`   events it produced:    ${events.length === 0 ? '(none)' : events.join(', ')}`);
      say(
        `   utterances the helper reported discarding: ` +
          `${String(rig.wire.filter((call) => call.op === 'speech.output.stop').length)} ` +
          `round trip(s), nothing stopped`,
      );
      say('   (the binding usually shields the adapter from this — it remembers');
      say('    the identifier and discards the chunk when it arrives — but an');
      say('    adapter that cannot take the call directly is one dispose away');
      say('    from an error nobody can act on.)');
      say();
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 6 — interruption, re-measured at this seam (§17)
  // -------------------------------------------------------------------------
  {
    say('6. interrupting speech (system-design §17 budgets 300 ms)');
    say('   PR-014 measured the adapter’s own stop() round trip at ~1 ms against');
    say('   the stub. The number that matters in the app is bigger: from the');
    say('   command reaching the machine to the synthesiser having been told.');
    say('   PR-027 performs `stop-speech` on its own queue so it never waits');
    say('   behind ordinary effects — this is that claim, measured.');
    const model = createScriptedModelSource({ script: [{ say: ANSWER }] });
    // A synthesiser that starts and does not finish: the utterance is still
    // playing when the interruption lands, which is the only case worth timing.
    const rig = await watching({ speechOutput: { scripts: [[{ type: 'started' }]] } }, model);
    try {
      rig.controller.dispatch({ type: 'submit-text', text: QUESTION });
      await waitFor(
        'the machine to reach `speaking`',
        () => rig.controller.snapshot().state === 'speaking',
      );
      const before = rig.controller.snapshot().state;
      const startedAt = process.hrtime.bigint();
      rig.controller.dispatch({ type: 'interrupt' });
      await waitFor('the synthesiser to be told', () => rig.speech.stats().stops > 0);
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      say(`   state when the interruption landed: ${before}`);
      say(`   command → synthesiser told:         ${elapsedMs.toFixed(1)} ms (budget: 300 ms)`);
      say(`   the stop() round trip inside it:    ${String(rig.speech.stats().lastStopMs)} ms`);
      say(`   still speaking:                     ${String(rig.controller.snapshot().speaking)}`);
      say(`   the answer so far is still on screen: "${answerOf(rig)}"`);
      say();
    } finally {
      await rig.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 7 — the phrase timeout finally has something to release (follow-up 25)
  // -------------------------------------------------------------------------
  {
    say('7. a model that goes quiet mid-sentence (runbook follow-ups 6 and 25)');
    say('   PR-027 built the wake-up as an injected Scheduler so the machine keeps');
    say('   no timers, and PR-029 deliberately did not pass it: with speech silent');
    say('   there was nothing to release and no way to see whether it worked.');
    say('   PR-033 passes `createTimeoutScheduler()` in main/index.ts. The same');
    say('   answer, streamed two tokens a second and with no terminator anywhere');
    say('   in it, so nothing is speakable until something releases the fragment:');
    for (const [label, scheduler] of [
      ['without a scheduler (PR-029)', NULL_SCHEDULER],
      ['with one (PR-033)          ', undefined],
    ] as const) {
      const model = createScriptedModelSource({
        tokensPerSecond: 2,
        script: [{ say: 'Auto Renew charges this card' }],
      });
      const rig = await watching({}, model, scheduler === undefined ? {} : { scheduler });
      try {
        const askedAt = process.hrtime.bigint();
        const since = (): number => Number(process.hrtime.bigint() - askedAt) / 1_000_000;
        let firstWordMs: number | null = null;
        rig.controller.subscribe((view) => {
          const entry = view.transcript.filter((item) => item.role === 'assistant').at(-1);
          if (firstWordMs === null && (entry?.text ?? '') !== '') {
            firstWordMs = since();
          }
        });
        rig.controller.dispatch({ type: 'submit-text', text: QUESTION });
        await waitFor(
          'the first chunk to reach the synthesiser',
          () => rig.speech.stats().accepted > 0,
        );
        const firstChunkMs = since();
        await settleRun(rig);
        say(
          `   ${label}  first word on screen ${String(Math.round(firstWordMs ?? -1))} ms, ` +
            `first word spoken ${firstChunkMs.toFixed(0)} ms, ` +
            `run ended ${since().toFixed(0)} ms`,
        );
      } finally {
        await rig.dispose();
      }
    }
    say('   Without a scheduler the fragment waits for the model’s *next* event,');
    say('   whenever that is; with one it is released on time. Nothing is ever');
    say('   lost either way — `run-completed` always flushes the tail — so what');
    say('   the scheduler buys is that the user is not left listening to silence');
    say('   while the answer sits finished on the screen in front of them.');
    say();
  }

  // -------------------------------------------------------------------------
  // 8 — what none of this proves
  // -------------------------------------------------------------------------
  say('8. what none of the above proves (docs/handoff.md §1 step 13, §2)');
  for (const [head, ...rest] of [
    [
      'NOTHING HAS EVER BEEN SPOKEN ALOUD. No AVSpeechSynthesizer has run, no',
      'voice has been resolved and no audio device has been opened. Every',
      'started/finished/stopped/error above is the Node helper stub answering a',
      'script, and the Swift that would speak has never been compiled.',
    ],
    [
      'the 300 ms budget in section 6 is measured against a stub whose stop() is',
      'a JSON round trip over a pipe. What §17 actually budgets is when the sound',
      'stops, and only a person in the room can judge that.',
    ],
    [
      'gapless playback is untested. Handing consecutive chunks to',
      'AVSpeechSynthesizer’s own queue is what should make sentence-to-sentence',
      'playback seamless; whether it does is audible, not printable.',
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
