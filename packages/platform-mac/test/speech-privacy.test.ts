import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  asSpeechId,
  asUtteranceId,
  createLogger,
  createMemorySink,
  type LogRecord,
} from '@pilot/shared';
import {
  MacSpeechInputAdapter,
  MacSpeechOutputAdapter,
  SPEECH_OPERATIONS,
  speechInputStartOperation,
  type NativeHelperTransport,
} from '@pilot/platform-mac';
import { createStubTransport } from './support/harness.js';

/**
 * "Raw audio is memory-only and never logged" (system-design §13, §14), turned
 * into assertions rather than left as an intention.
 *
 * Four independent mechanisms, because any one of them alone could be defeated
 * by a change that looks harmless:
 *
 * 1. **No speech operation may carry a binary body.** The transport rejects a
 *    binary payload on an operation that does not accept one, so "attach the
 *    audio" is a typed `invalid-request` rather than something a later PR can
 *    do by accident.
 * 2. **The logger is set to throw on redaction.** `@pilot/shared`'s logger
 *    replaces anything transcript-, audio- or image-shaped; with
 *    `onViolation: 'throw'` it fails instead. A full transcription and playback
 *    run under that logger therefore proves the adapters never hand it one.
 * 3. **No transcript text appears in any log record**, checked directly against
 *    the serialised records as well.
 * 4. **The speech sources contain no persistence API at all** — no file writes
 *    on either side of the boundary, and no `SFSpeechURLRecognitionRequest`,
 *    which is the one recognition API that reads audio from disk.
 */

const SECRET = 'my bank password is hunter2';
const transports: NativeHelperTransport[] = [];

function sourcePath(relative: string): string {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}

function read(relative: string): string {
  return readFileSync(sourcePath(relative), 'utf8');
}

afterEach(async () => {
  for (const transport of transports.splice(0)) {
    await transport.stop();
  }
});

describe('the wire cannot carry audio', () => {
  it('declares no binary body on any speech operation', () => {
    expect(SPEECH_OPERATIONS).toHaveLength(9);
    for (const operation of SPEECH_OPERATIONS) {
      expect(operation.requestBinary, `${operation.name} accepts request binary`).toBe(false);
      expect(operation.responseBinary, `${operation.name} accepts response binary`).toBe(false);
    }
  });

  it('rejects an attempt to attach bytes to a speech request', async () => {
    const transport = createStubTransport();
    transports.push(transport);
    await transport.start();

    await expect(
      transport.request(
        speechInputStartOperation,
        { utteranceId: 'utt-1', onDevice: true, locale: null },
        { binary: new Uint8Array([1, 2, 3]) },
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' });
  });
});

describe('nothing reaches the log', () => {
  /**
   * The strongest form of the check: the logger is told to *throw* rather than
   * redact, so any attempt to log a transcript, an audio buffer or an
   * image-shaped field fails the test at the call site.
   */
  it('runs a whole utterance and a whole spoken answer without a redaction', async () => {
    const sink = createMemorySink();
    const logger = createLogger({
      scope: 'privacy-test',
      level: 'debug',
      sink,
      onViolation: 'throw',
      clock: () => 0,
    });

    const transport = createStubTransport({
      permissions: { microphone: 'granted', 'speech-recognition': 'granted' },
      speechInput: {
        scripts: [
          {
            steps: [
              { on: 'start', emit: [{ type: 'partial', transcript: SECRET }] },
              { on: 'stop', emit: [{ type: 'final', transcript: SECRET }] },
            ],
          },
          // A second utterance whose events are all dropped, because the
          // dropping path logs too and is exactly where a transcript would be
          // most tempting to include.
          {
            steps: [{ on: 'cancel', emit: [{ type: 'final', transcript: SECRET }] }],
          },
        ],
      },
      speechOutput: { scripts: [[{ type: 'started' }, { type: 'finished' }]] },
    });
    transports.push(transport);
    await transport.start();

    const input = new MacSpeechInputAdapter({ transport, pollIntervalMs: 60_000, logger });
    const output = new MacSpeechOutputAdapter({ transport, pollIntervalMs: 60_000, logger });

    const utterance = asUtteranceId('utt-secret');
    await input.start({ utteranceId: utterance, requireOnDevice: true });
    await input.refresh();
    await input.stop(utterance);

    const second = asUtteranceId('utt-dropped');
    await input.start({ utteranceId: second, requireOnDevice: true });
    await input.cancel(second);
    await input.refresh();

    await output.speak({ speechId: asSpeechId('speech-1'), text: SECRET });
    await output.refresh();
    await output.stop();

    await input.dispose();
    await output.dispose();

    // Nothing threw, so nothing redactable was logged. Belt and braces: the
    // records themselves contain neither the transcript nor a redaction marker.
    const serialised = JSON.stringify(sink.records);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain('hunter2');
    for (const record of sink.records as readonly LogRecord[]) {
      expect(record.redactedPaths).toEqual([]);
    }
  });

  it('keeps the disclosure loggable — it holds a destination, never a recording', async () => {
    const sink = createMemorySink();
    const logger = createLogger({
      scope: 'privacy-test',
      level: 'debug',
      sink,
      onViolation: 'throw',
      clock: () => 0,
    });
    const transport = createStubTransport({
      permissions: { microphone: 'granted', 'speech-recognition': 'granted' },
      speechInput: { supportsOnDevice: false },
    });
    transports.push(transport);
    await transport.start();

    const input = new MacSpeechInputAdapter({
      transport,
      pollIntervalMs: 60_000,
      logger,
      requireOnDevice: false,
    });
    await input.start({ utteranceId: asUtteranceId('utt-remote'), requireOnDevice: false });
    await input.dispose();

    const warning = sink.records.find((record) => record.level === 'warn');
    expect(warning?.message).toContain('leaves this Mac');
    expect(warning?.fields.destination).toBe('remote-service');
  });
});

describe('nothing reaches disk', () => {
  /**
   * A source scan, because the thing being ruled out is a *capability* rather
   * than a behaviour: there is no test that can observe the absence of a file
   * write that nobody wrote. Checking that the API is not present is checking
   * the property directly.
   */
  const FORBIDDEN_SWIFT = [
    'AVAudioFile',
    'SFSpeechURLRecognitionRequest',
    'FileManager',
    'FileHandle',
    'URLSession',
    'NSTemporaryDirectory',
    'write(to',
    'contentsOf',
    'UserDefaults',
  ];

  const SWIFT_SOURCES = [
    'native/Sources/PilotHelperCore/SpeechModel.swift',
    'native/Sources/PilotHelperCore/SpeechServices.swift',
  ];

  it.each(SWIFT_SOURCES)('%s persists nothing', (relative) => {
    const source = read(relative);
    for (const api of FORBIDDEN_SWIFT) {
      expect(source, `${relative} mentions ${api}`).not.toContain(api);
    }
  });

  /**
   * The one place audio is allowed to go: straight from the tap into the
   * recognition request. If this stops being the only `append` of a buffer,
   * the guarantee needs rewriting rather than the test relaxing.
   */
  it('appends microphone buffers to the recognition request and nowhere else', () => {
    const source = read('native/Sources/PilotHelperCore/SpeechServices.swift');
    const appends = source.match(/\.append\(buffer\)/g) ?? [];
    expect(appends).toHaveLength(1);
    expect(source).toContain('recognitionRequest.append(buffer)');
  });

  const TS_SOURCES = [
    'src/speech/mac-speech-input-adapter.ts',
    'src/speech/mac-speech-output-adapter.ts',
    'src/speech/disclosure.ts',
    'src/speech/errors.ts',
    'src/protocol/speech-ops.ts',
  ];

  it.each(TS_SOURCES)('%s touches no filesystem API', (relative) => {
    const source = read(relative);
    expect(source).not.toContain('node:fs');
    expect(source).not.toContain('writeFile');
    expect(source).not.toContain('createWriteStream');
  });
});
