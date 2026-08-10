/**
 * PR-014 demo: Apple Speech transcription, the on-device disclosure, and
 * `AVSpeechSynthesizer` playback with interruption.
 *
 * ```sh
 * pnpm build                                            # runs against dist/
 * pnpm --filter @pilot/platform-mac demo:speech         # Node stub (Linux and macOS)
 * PILOT_HELPER_BINARY=… pnpm --filter @pilot/platform-mac demo:speech   # Swift helper (macOS)
 * ```
 *
 * **What implementation.md asks for and what this is.** The stated demo is
 * "transcribe a held recording and speak/interrupt a supplied sentence". Both
 * halves need a microphone, a speaker and macOS, and there is none of that on
 * the development machine (runbook amendment 8). So against the Node stub this
 * demonstrates the *host* half end to end — the framed protocol, the on-device
 * decision and its disclosure, the event stream, the teardown rules and the
 * typed failures — with a scripted recogniser and a scripted synthesiser
 * standing in for the real ones. **Nothing is recorded and nothing is
 * audible.** It prints which target it selected on its first line, matching
 * the other two demos, so there is never any doubt which of the two just ran.
 *
 * On a Mac with the Swift helper built, the same command drives the real
 * `SFSpeechRecognizer` and the real `AVSpeechSynthesizer`, and the demo becomes
 * the one implementation.md describes — held key and audible sentence included.
 */

import { fileURLToPath } from 'node:url';
import {
  MacSpeechInputAdapter,
  MacSpeechOutputAdapter,
  NativeHelperTransport,
  decideRecognition,
  helperBinaryCandidates,
  resolveHelperBinary,
  type HelperTransportOptions,
} from '@pilot/platform-mac';
import { asSpeechId, asUtteranceId, type PilotError } from '@pilot/shared';
import type { SpeechInputEvent, SpeechOutputEvent } from '@pilot/platform';

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const STUB_PATH = fileURLToPath(new URL('./support/helper-stub.ts', import.meta.url));

interface Target {
  readonly label: string;
  readonly usingStub: boolean;
  readonly options: HelperTransportOptions;
}

function selectTarget(stub: Record<string, unknown>): Target {
  try {
    const candidate = resolveHelperBinary();
    return {
      label: `Swift helper (${candidate.source}: ${candidate.path})`,
      usingStub: false,
      options: { command: candidate.path, requestTimeoutMs: 5_000 },
    };
  } catch {
    return {
      label: 'Node stub (no Swift helper found)',
      usingStub: true,
      options: {
        command: process.execPath,
        args: [STUB_PATH],
        env: { ...process.env, PILOT_HELPER_STUB: JSON.stringify(stub) },
        requestTimeoutMs: 5_000,
        restart: { enabled: false },
      },
    };
  }
}

/**
 * The scripted recogniser.
 *
 * Every entry is something Apple Speech is known to do and the fake never did:
 * stream hypotheses, endpoint before the key is released, finalise twice,
 * answer after `cancel()`, and fail halfway through.
 */
const SPEECH_SCRIPTS = [
  // 1. A held recording: partials while the key is down, one final on release.
  {
    steps: [
      {
        on: 'start',
        emit: [
          { type: 'partial', transcript: 'what' },
          { type: 'partial', transcript: 'what is' },
          { type: 'partial', transcript: 'what is this' },
        ],
      },
      { on: 'stop', emit: [{ type: 'final', transcript: 'What is this?' }] },
    ],
  },
  // 2. A recogniser that endpoints on its own, before the key comes up.
  {
    steps: [
      {
        on: 'start',
        emit: [
          { type: 'partial', transcript: 'and what happens' },
          { type: 'final', transcript: 'And what happens if I turn it off?' },
        ],
      },
    ],
  },
  // 3. Two finals for one utterance.
  {
    steps: [
      {
        on: 'stop',
        emit: [
          { type: 'final', transcript: 'Is this the same setting?' },
          { type: 'final', transcript: 'Is this the same setting?' },
        ],
      },
    ],
  },
  // 4. A callback that arrives after cancel.
  {
    steps: [
      {
        on: 'cancel',
        emit: [{ type: 'final', transcript: 'the question the user abandoned' }],
      },
    ],
  },
  // 5. Failure halfway through.
  {
    steps: [
      {
        on: 'start',
        emit: [
          { type: 'partial', transcript: 'why does this' },
          { type: 'error', code: 'audio-engine', message: 'the input device went away' },
        ],
      },
    ],
  },
];

const STUB_CONFIG = {
  permissions: { microphone: 'granted', 'speech-recognition': 'granted' },
  speechInput: { scripts: SPEECH_SCRIPTS },
  speechOutput: { scripts: [[{ type: 'started' }]] },
};

/**
 * The two grants, refused in the two ways that need different advice: `denied`
 * sends the user to System Settings, `restricted` means no action will help.
 */
const PERMISSION_DENIALS = [
  {
    label: 'Microphone denied',
    utteranceId: 'utt-8',
    stub: {
      ...STUB_CONFIG,
      permissions: { microphone: 'denied', 'speech-recognition': 'granted' },
    },
  },
  {
    label: 'Speech Recognition restricted by policy',
    utteranceId: 'utt-9',
    stub: {
      ...STUB_CONFIG,
      permissions: { microphone: 'granted', 'speech-recognition': 'restricted' },
    },
  },
];

function describe(event: SpeechInputEvent): string {
  if (event.type === 'error') {
    const error = event.error as PilotError;
    return `error   ${event.utteranceId}  ${error.code}  “${error.userMessage}”`;
  }
  return `${event.type.padEnd(7)} ${event.utteranceId}  “${event.transcript}”`;
}

async function withTransport(
  target: Target,
  body: (transport: NativeHelperTransport) => Promise<void>,
): Promise<void> {
  const transport = new NativeHelperTransport(target.options);
  await transport.start();
  try {
    await body(transport);
  } finally {
    await transport.stop();
  }
}

async function main(): Promise<void> {
  const target = selectTarget(STUB_CONFIG);
  say(`Target: ${target.label}`);
  if (target.usingStub) {
    say(
      `        (searched ${helperBinaryCandidates()
        .map((candidate) => candidate.source)
        .join(', ')})`,
    );
    say('        Nothing is recorded and nothing is audible: this is the host half only.');
  }
  say('');

  await withTransport(target, async (transport) => {
    // -----------------------------------------------------------------------
    say('1. Availability and the on-device disclosure');
    say('');

    const input = new MacSpeechInputAdapter({ transport, pollIntervalMs: 30 });
    const events: SpeechInputEvent[] = [];
    input.subscribe((event) => events.push(event));

    const availability = await input.availability();
    say(`   available=${String(availability.available)} onDevice=${String(availability.onDevice)}`);
    say(`   locale=${availability.locale ?? '(default)'}`);
    say(`   destination=${availability.destination ?? '(not reported)'}`);
    say(`   “${availability.disclosure?.headline ?? ''}”`);
    say('');

    say('   The same facts under each preference, decided host-side:');
    for (const supportsOnDevice of [true, false]) {
      for (const requireOnDevice of [true, false]) {
        const decision = decideRecognition(
          {
            recognizerAvailable: true,
            supportsOnDevice,
            locale: 'en-US',
            supportedLocales: ['en-US'],
            recognizerOffline: false,
          },
          { requireOnDevice },
        );
        say(
          `   supportsOnDevice=${String(supportsOnDevice).padEnd(5)} ` +
            `requireOnDevice=${String(requireOnDevice).padEnd(5)} → ` +
            `${decision.allowed ? 'record' : 'refuse'.padEnd(6)} ` +
            `destination=${decision.disclosure.destination.padEnd(14)} ` +
            `leavesDevice=${String(decision.disclosure.leavesDevice)}`,
        );
      }
    }
    say('');

    // -----------------------------------------------------------------------
    say('2. A held recording: partials while the key is down, one final on release');
    say('');
    const first = asUtteranceId('utt-1');
    await input.start({ utteranceId: first, requireOnDevice: true });
    await input.refresh();
    await input.stop(first);
    for (const event of events.splice(0)) {
      say(`   ${describe(event)}`);
    }
    say('');

    // -----------------------------------------------------------------------
    say('3. A recogniser that finalises before the key is released');
    say('   (the stop that follows must be a no-op, not a failure)');
    say('');
    const second = asUtteranceId('utt-2');
    await input.start({ utteranceId: second, requireOnDevice: true });
    await input.refresh();
    for (const event of events.splice(0)) {
      say(`   ${describe(event)}`);
    }
    await input.stop(second);
    await input.stop(second);
    say(`   stop() after the final: ignored ${String(input.ignoredCallCount)} call(s), no error`);
    say('');

    // -----------------------------------------------------------------------
    say('4. A recogniser that finalises twice');
    say('');
    const third = asUtteranceId('utt-3');
    await input.start({ utteranceId: third, requireOnDevice: true });
    await input.stop(third);
    for (const event of events.splice(0)) {
      say(`   ${describe(event)}`);
    }
    say(`   dropped so far: ${String(input.droppedEventCount)}`);
    say('');

    // -----------------------------------------------------------------------
    say('5. A callback that arrives after cancel');
    say('');
    const fourth = asUtteranceId('utt-4');
    await input.start({ utteranceId: fourth, requireOnDevice: true });
    await input.cancel(fourth);
    await input.refresh();
    say(`   events delivered: ${String(events.length)}`);
    say(`   dropped so far:   ${String(input.droppedEventCount)}`);
    say('');

    // -----------------------------------------------------------------------
    say('6. Recognition fails mid-utterance (system-design §16: the user types instead)');
    say('');
    const fifth = asUtteranceId('utt-5');
    await input.start({ utteranceId: fifth, requireOnDevice: true });
    await input.refresh();
    for (const event of events.splice(0)) {
      say(`   ${describe(event)}`);
    }
    say('   cancel() after the failure:');
    await input.cancel(fifth);
    say('   no error — teardown is idempotent');
    await input.dispose();
    say('');
  });

  // -------------------------------------------------------------------------
  await withTransport({ ...target, options: refuseOnDevice(target) }, async (transport) => {
    say('7. This Mac cannot recognise locally, and Pilot refuses rather than uploading');
    say('');
    const input = new MacSpeechInputAdapter({ transport, pollIntervalMs: 30 });
    try {
      await input.start({ utteranceId: asUtteranceId('utt-6'), requireOnDevice: true });
      say('   (unexpected: recording started)');
    } catch (error) {
      const failure = error as PilotError;
      say(`   ${failure.code}`);
      say(`   “${failure.userMessage}”`);
      say(`   disclosure.leavesDevice = ${String(input.lastDisclosure.leavesDevice)}`);
    }
    say('');
    say('   With remote recognition explicitly allowed, it records and discloses:');
    await input.start({ utteranceId: asUtteranceId('utt-7'), requireOnDevice: false });
    say(`   destination=${input.lastDisclosure.destination}`);
    say(`   “${input.lastDisclosure.headline}”`);
    await input.dispose();
    say('');
  });

  // -------------------------------------------------------------------------
  say('8. Both permission-denied paths, separately');
  say('   (Microphone and Speech Recognition are different grants with different fixes)');
  say('');
  for (const denial of PERMISSION_DENIALS) {
    await withTransport(
      { ...target, options: withStub(target, denial.stub) },
      async (transport) => {
        const input = new MacSpeechInputAdapter({ transport, pollIntervalMs: 30 });
        try {
          await input.start({
            utteranceId: asUtteranceId(denial.utteranceId),
            requireOnDevice: true,
          });
          say(`   ${denial.label}: (unexpected: recording started)`);
        } catch (error) {
          const failure = error as PilotError;
          say(`   ${denial.label}`);
          say(`     ${failure.code}  kind=${String(failure.details?.kind)}`);
          say(`     “${failure.userMessage}”`);
        }
        await input.dispose();
      },
    );
  }
  say('');

  // -------------------------------------------------------------------------
  await withTransport(target, async (transport) => {
    say('9. Speaking two chunks, then interrupting mid-sentence');
    say('');
    const output = new MacSpeechOutputAdapter({ transport, pollIntervalMs: 30 });
    const spoken: SpeechOutputEvent[] = [];
    output.subscribe((event) => spoken.push(event));

    const voices = await output.voiceCatalog();
    say(`   voices: ${voices.map((voice) => `${voice.name} (${voice.language})`).join(', ')}`);

    const chunkOne = asSpeechId('speech-1');
    const chunkTwo = asSpeechId('speech-2');
    await output.speak({ speechId: chunkOne, text: 'This toggle renews your plan automatically.' });
    await output.speak({ speechId: chunkTwo, text: 'Turning it off stops the next charge.' });
    await output.refresh();
    for (const event of spoken.splice(0)) {
      say(`   ${event.type.padEnd(8)} ${event.speechId}`);
    }

    const startedAt = process.hrtime.bigint();
    await output.stop(chunkOne);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    for (const event of spoken.splice(0)) {
      say(`   ${event.type.padEnd(8)} ${event.speechId}`);
    }
    say(`   stop() round trip: ${elapsedMs.toFixed(1)} ms (system-design §17 budget: 300 ms)`);
    say('   both chunks reported — one queue, one stop, nothing left waiting');
    await output.dispose();
    say('');
  });

  // -------------------------------------------------------------------------
  await withTransport({ ...target, options: noVoices(target) }, async (transport) => {
    say('10. A Mac with no voice (system-design §16: the streamed text keeps showing)');
    say('');
    const output = new MacSpeechOutputAdapter({ transport, pollIntervalMs: 30 });
    const availability = await output.availability();
    say(
      `   available=${String(availability.available)} voices=${String(availability.voices.length)}`,
    );
    try {
      await output.speak({ speechId: asSpeechId('speech-3'), text: 'This will not be heard.' });
      say('   (unexpected: speech accepted)');
    } catch (error) {
      const failure = error as PilotError;
      say(`   ${failure.code}`);
      say(`   “${failure.userMessage}”`);
    }
    await output.dispose();
    say('');
  });

  say('Done.');
  if (target.usingStub) {
    say('');
    say('Not demonstrated here, and unverifiable on this machine:');
    say('  · that Apple Speech behaves the way the scripted recogniser imitates');
    say('  · that requiresOnDeviceRecognition really keeps the audio on the Mac');
    say('  · that anything was audible, or that stopping it was audibly immediate');
    say('  See docs/handoff.md §1 for the commands that settle these on a Mac.');
  }
}

/** Same target, but the stub reports a Mac that cannot recognise locally. */
function refuseOnDevice(target: Target): HelperTransportOptions {
  return withStub(target, {
    ...STUB_CONFIG,
    speechInput: { supportsOnDevice: false, locale: 'cy-GB', scripts: [] },
  });
}

/** Same target, but the Mac has no synthesis voice installed. */
function noVoices(target: Target): HelperTransportOptions {
  return withStub(target, {
    ...STUB_CONFIG,
    speechOutput: {
      available: false,
      startFailsWith: {
        code: 'speech-unavailable',
        failureCode: 'voice-unavailable',
        message: 'No speech synthesis voice is installed',
      },
    },
  });
}

function withStub(target: Target, stub: Record<string, unknown>): HelperTransportOptions {
  if (!target.usingStub) {
    return target.options;
  }
  return {
    ...target.options,
    env: { ...process.env, PILOT_HELPER_STUB: JSON.stringify(stub) },
  };
}

main().catch((error: unknown) => {
  process.exitCode = 1;
  process.stderr.write(`${String(error)}\n`);
});
