import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  IPC_PROTOCOL_VERSION,
  MAX_IPC_MESSAGE_BYTES,
  PilotError,
  asRequestId,
  createEventEnvelope,
  createFailureResponseEnvelope,
  createRequestEnvelope,
  createSuccessResponseEnvelope,
  decodeEnvelope,
  defineChannel,
  defineEventChannel,
  encodeEnvelope,
  observeScreenRequestSchema,
  parseEnvelope,
  parseEventEnvelope,
  parseRequestEnvelope,
  parseResponseEnvelope,
  questionEnvelopeSchema,
  screenObservationSchema,
  sceneStateSchema,
  type RequestEnvelope,
} from '@pilot/shared';

const observeChannel = defineChannel({
  name: 'screen:observe',
  direction: 'renderer-to-main',
  request: observeScreenRequestSchema,
  response: screenObservationSchema,
});

const submitChannel = defineChannel({
  name: 'conversation:submit',
  direction: 'renderer-to-main',
  request: questionEnvelopeSchema,
  response: z.strictObject({ accepted: z.boolean() }),
});

const sceneEventChannel = defineEventChannel({
  name: 'observation:scene',
  payload: sceneStateSchema,
});

const meta = { id: asRequestId('req-0001'), issuedAt: 1_760_000_000_000 };

const VALID_OBSERVATION = {
  observationId: 'obs-0001',
  sceneId: 'scene-0001',
  sceneRevision: 4,
  capturedAt: 1_760_000_000_000,
  windowTitle: 'Billing Settings',
  pointer: { x: 0.5, y: 0.5 },
  images: [{ mimeType: 'image/png' as const, base64: 'AAAA', purpose: 'window' as const }],
};

const VALID_QUESTION = {
  utteranceId: 'utt-0001',
  transcript: 'What is this?',
  conversationId: 'conv-0001',
  scene: { id: 'scene-0001', revision: 4, windowTitle: 'Billing Settings' },
  pointer: { normalizedX: 0.5, normalizedY: 0.5, targetRole: 'AXCheckBox' },
};

describe('IPC envelopes — round trips', () => {
  it('round-trips a request through encode/decode and channel parsing', () => {
    const request = createRequestEnvelope(
      observeChannel,
      { view: 'pointer', moment: 'question' },
      meta,
    );
    const decoded = decodeEnvelope(encodeEnvelope(request));
    const parsed = parseRequestEnvelope(observeChannel, decoded);

    expect(parsed.envelope.kind).toBe('request');
    expect(parsed.envelope.protocolVersion).toBe(IPC_PROTOCOL_VERSION);
    expect(parsed.envelope.channel).toBe('screen:observe');
    expect(parsed.payload).toEqual({ view: 'pointer', moment: 'question' });
  });

  it('round-trips a success response and preserves the request id', () => {
    const request = createRequestEnvelope(
      observeChannel,
      { view: 'window', moment: 'current' },
      meta,
    );
    const response = createSuccessResponseEnvelope(
      observeChannel,
      request,
      screenObservationSchema.parse(VALID_OBSERVATION),
      meta.issuedAt + 12,
    );

    const parsed = parseResponseEnvelope(observeChannel, decodeEnvelope(encodeEnvelope(response)));
    expect(parsed.envelope.id).toBe(request.id);
    expect(parsed.payload.observationId).toBe('obs-0001');
    expect(parsed.payload.images).toHaveLength(1);
  });

  it('round-trips a question envelope payload', () => {
    const request = createRequestEnvelope(
      submitChannel,
      questionEnvelopeSchema.parse(VALID_QUESTION),
      meta,
    );
    const parsed = parseRequestEnvelope(submitChannel, decodeEnvelope(encodeEnvelope(request)));
    expect(parsed.payload.transcript).toBe('What is this?');
    expect(parsed.payload.scene.revision).toBe(4);
    expect(parsed.payload.pointer.targetRole).toBe('AXCheckBox');
  });

  it('round-trips an event envelope', () => {
    const event = createEventEnvelope(
      sceneEventChannel,
      sceneStateSchema.parse({
        sceneId: 'scene-0001',
        revision: 4,
        windowId: 'window-retina',
        windowTitle: 'Billing Settings',
        fingerprint: 'fp-1',
        updatedAt: meta.issuedAt,
      }),
      meta,
    );
    const parsed = parseEventEnvelope(sceneEventChannel, decodeEnvelope(encodeEnvelope(event)));
    expect(parsed.payload.sceneId).toBe('scene-0001');
    expect(parsed.payload.revision).toBe(4);
  });

  it('carries a serialized PilotError on a failure response', () => {
    const request = createRequestEnvelope(
      observeChannel,
      { view: 'both', moment: 'question' },
      meta,
    );
    const failure = createFailureResponseEnvelope(
      request,
      new PilotError('observation-paused', 'Observation is paused', {
        userMessage: 'Pilot is paused.',
      }),
      meta.issuedAt + 3,
    );

    expect(failure.ok).toBe(false);
    expect(failure.error.code).toBe('observation-paused');
    expect(failure.error.domain).toBe('observation');

    // The client-side parse rethrows the error as a typed PilotError.
    let thrown: unknown;
    try {
      parseResponseEnvelope(observeChannel, decodeEnvelope(encodeEnvelope(failure)));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PilotError);
    expect((thrown as PilotError).code).toBe('observation-paused');
    expect((thrown as PilotError).userMessage).toBe('Pilot is paused.');
  });
});

describe('IPC envelopes — invalid message rejection', () => {
  const validRequest = (): RequestEnvelope =>
    createRequestEnvelope(observeChannel, { view: 'pointer', moment: 'question' }, meta);

  it('rejects a payload that does not match the channel schema', () => {
    expect(() =>
      parseRequestEnvelope(observeChannel, {
        ...validRequest(),
        payload: { view: 'everything', moment: 'question' },
      }),
    ).toThrowError(PilotError);
  });

  it('rejects an unknown protocol version with a dedicated code', () => {
    let thrown: unknown;
    try {
      parseEnvelope({ ...validRequest(), protocolVersion: IPC_PROTOCOL_VERSION + 1 });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as PilotError).code).toBe('protocol-version-mismatch');
  });

  it('rejects an envelope addressed to another channel', () => {
    let thrown: unknown;
    try {
      parseRequestEnvelope(submitChannel, validRequest());
    } catch (error) {
      thrown = error;
    }
    expect((thrown as PilotError).code).toBe('unknown-channel');
  });

  it('rejects unknown envelope fields rather than ignoring them', () => {
    expect(() => parseEnvelope({ ...validRequest(), injected: 'payload' })).toThrowError(
      PilotError,
    );
  });

  it('rejects a missing envelope kind', () => {
    const { kind: _kind, ...withoutKind } = validRequest();
    expect(() => parseEnvelope(withoutKind)).toThrowError(PilotError);
  });

  it('rejects a non-object envelope', () => {
    expect(() => parseEnvelope('not-an-envelope')).toThrowError(PilotError);
    expect(() => parseEnvelope(null)).toThrowError(PilotError);
  });

  it('rejects malformed JSON', () => {
    let thrown: unknown;
    try {
      decodeEnvelope('{"kind":');
    } catch (error) {
      thrown = error;
    }
    expect((thrown as PilotError).code).toBe('invalid-request');
  });

  it('rejects an oversized message on encode and on decode', () => {
    const huge = createRequestEnvelope(
      submitChannel,
      questionEnvelopeSchema.parse({
        ...VALID_QUESTION,
        transcript: 'x'.repeat(MAX_IPC_MESSAGE_BYTES),
      }),
      meta,
    );

    let encodeError: unknown;
    try {
      encodeEnvelope(huge);
    } catch (error) {
      encodeError = error;
    }
    expect((encodeError as PilotError).code).toBe('payload-too-large');

    let decodeError: unknown;
    try {
      decodeEnvelope(JSON.stringify(huge));
    } catch (error) {
      decodeError = error;
    }
    expect((decodeError as PilotError).code).toBe('payload-too-large');
  });

  it('rejects an invalid payload at construction time, not only on receipt', () => {
    expect(() =>
      // @ts-expect-error — the channel schema rejects this at runtime too.
      createRequestEnvelope(observeChannel, { view: 'pointer' }, meta),
    ).toThrowError(PilotError);
  });

  it('rejects an empty identifier', () => {
    expect(() => parseRequestEnvelope(observeChannel, { ...validRequest(), id: '' })).toThrowError(
      PilotError,
    );
  });
});
