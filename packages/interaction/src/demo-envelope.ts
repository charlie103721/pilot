import {
  asConversationId,
  asUtteranceId,
  envelopePointerInsideWindow,
  envelopePointerKnown,
  type QuestionEnvelope,
} from '@pilot/shared';
import { PilotQuestionEnvelopeFactory, renderAnchoredQuestionEnvelope } from './envelope.js';
import { FakeQuestionAnchorSource } from './fakes.js';
import { RECORDED_UTTERANCES, type RecordedUtterance } from './recordings.js';

/**
 * The PR-024 demo: build a question envelope from each recorded pointer
 * timeline and print it.
 *
 * Deterministic by construction — the recordings are data and the factory has
 * no clock, no randomness and no I/O — so `pnpm demo:envelope` prints exactly
 * the same text on every machine. `test/demo-envelope.test.ts` pins it.
 */

export interface DemoEnvelopeCase {
  readonly name: string;
  readonly description: string;
  readonly envelope: QuestionEnvelope;
  /** Bytes of the serialized envelope — the "no image bytes" budget in practice. */
  readonly byteLength: number;
}

export interface DemoEnvelopeResult {
  readonly cases: readonly DemoEnvelopeCase[];
  readonly totalBytes: number;
  readonly lines: readonly string[];
}

const CONVERSATION_ID = asConversationId('conv-envelope-demo');

function buildCase(recorded: RecordedUtterance, index: number): DemoEnvelopeCase {
  const factory = new PilotQuestionEnvelopeFactory({
    anchors: new FakeQuestionAnchorSource({
      scene: recorded.scene,
      samples: recorded.samples,
    }),
  });
  const envelope = factory.build({
    utteranceId: asUtteranceId(`utt-${String(index + 1).padStart(6, '0')}`),
    conversationId: CONVERSATION_ID,
    transcript: recorded.transcript,
    selectedWindow: recorded.window,
    utteranceStartedAt: recorded.utteranceStartedAt,
    askedAt: recorded.askedAt,
  });
  return {
    name: recorded.name,
    description: recorded.description,
    envelope,
    byteLength: Buffer.byteLength(JSON.stringify(envelope), 'utf8'),
  };
}

function describe(demoCase: DemoEnvelopeCase): readonly string[] {
  const { envelope } = demoCase;
  const anchor = envelope.anchor;
  const lines = [
    `## ${demoCase.name}`,
    `   ${demoCase.description}`,
    `   transcript          "${envelope.transcript}"`,
    `   scene               ${envelope.scene.id} revision ${String(envelope.scene.revision)}` +
      (envelope.scene.lastObservedRevision === undefined
        ? ' (never observed)'
        : ` (last observed ${String(envelope.scene.lastObservedRevision)})`),
    `   window              ${envelope.scene.windowTitle === '' ? '(none)' : envelope.scene.windowTitle}`,
  ];
  if (anchor === undefined) {
    lines.push('   anchor              (absent)');
    return lines;
  }
  lines.push(
    `   grounding           ${anchor.grounding}`,
    `   pointer             ${
      envelopePointerKnown(envelope)
        ? `${envelope.pointer.normalizedX.toFixed(3)}, ${envelope.pointer.normalizedY.toFixed(3)}` +
          ` (${envelopePointerInsideWindow(envelope) ? 'inside' : 'OUTSIDE'} the window)`
        : 'unknown — no position is claimed'
    }`,
    `   ax target           ${
      anchor.targetAvailability === 'reported'
        ? `${anchor.target?.role ?? '(no role)'} — ${anchor.target?.label ?? '(no label)'}`
        : 'none reported'
    }`,
    `   utterance           ${String(anchor.utteranceStartedAt)} → ${String(anchor.utteranceEndedAt)}` +
      ` (${String(anchor.pointerSampleCount)} pointer samples)`,
    `   anchored at         ${
      anchor.pointerSampledAt === undefined
        ? 'n/a'
        : `${String(anchor.pointerSampledAt)} (skew ${String(anchor.pointerSkewMs ?? 0)}ms)`
    }`,
    `   scene revised       ${anchor.sceneRevisedDuringUtterance ? 'yes, during the utterance' : 'no'}` +
      (anchor.sceneRevisionAtUtteranceStart === undefined
        ? ''
        : ` (was ${String(anchor.sceneRevisionAtUtteranceStart)} at utterance start)`),
    `   observation stale   ${anchor.observationStale ? 'yes — the model has not seen this revision' : 'no'}`,
    `   crossed border      ${anchor.pointerCrossedWindowBorder ? 'yes' : 'no'}`,
  );
  if (anchor.note !== undefined) {
    lines.push(`   note                ${anchor.note}`);
  }
  lines.push(
    `   serialized          ${String(demoCase.byteLength)} bytes, no image payload`,
    '   what the model reads:',
    ...renderAnchoredQuestionEnvelope(envelope)
      .split('\n')
      .map((line) => (line === '' ? '     |' : `     | ${line}`)),
  );
  return lines;
}

export function runEnvelopeDemo(): DemoEnvelopeResult {
  const cases = RECORDED_UTTERANCES.map(buildCase);
  const totalBytes = cases.reduce((sum, item) => sum + item.byteLength, 0);

  const lines = [
    'Pilot — PR-024 question envelope demo',
    'Envelopes built from recorded pointer timelines; no adapter, no clock, no I/O.',
    '',
    ...cases.flatMap((item) => [...describe(item), '']),
    `${String(cases.length)} envelopes, ${String(totalBytes)} bytes of text and metadata in total.`,
    'Image bytes appear in none of them: images reach the model only through',
    'observe_screen (PR-021), after the screen policy has approved them.',
  ];

  return { cases, totalBytes, lines };
}
