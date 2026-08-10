import { asRequestId, isPilotError, type PilotError } from '@pilot/shared';
import {
  HELPER_PROTOCOL_VERSION,
  MAX_FRAME_MESSAGE_BYTES,
  createHelperEventMessage,
  createHelperFailureMessage,
  createHelperRequestMessage,
  createHelperSuccessMessage,
  decodeHelperMessage,
  echoOperation,
  encodeHelperMessage,
  healthOperation,
} from '@pilot/platform-mac';
import { describe, expect, it } from 'vitest';

const meta = { id: asRequestId('req-000001'), issuedAt: 1_700_000_000_000 };

function caught(run: () => unknown): PilotError {
  try {
    run();
  } catch (error) {
    if (isPilotError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a PilotError');
}

describe('helper messages', () => {
  it('round-trips every message kind', () => {
    const messages = [
      createHelperRequestMessage('echo', { text: 'hi' }, meta),
      createHelperSuccessMessage('echo', { text: 'hi', binaryLength: 0 }, meta),
      createHelperFailureMessage(
        'echo',
        {
          name: 'PilotError',
          code: 'invalid-request',
          domain: 'ipc',
          message: 'nope',
          userMessage: 'nope',
          retryable: false,
        },
        meta,
      ),
      createHelperEventMessage('helper.ready', { pid: 1 }, meta),
    ];

    for (const message of messages) {
      expect(decodeHelperMessage(encodeHelperMessage(message))).toEqual(message);
    }
  });

  it('rejects a body that is not JSON', () => {
    expect(caught(() => decodeHelperMessage('not json')).code).toBe('invalid-request');
  });

  it('rejects a body that is not a JSON object', () => {
    expect(caught(() => decodeHelperMessage('[1,2,3]')).code).toBe('invalid-request');
  });

  it('reports a version mismatch before any schema issue', () => {
    const error = caught(() =>
      decodeHelperMessage(JSON.stringify({ protocolVersion: HELPER_PROTOCOL_VERSION + 1 })),
    );
    expect(error.code).toBe('protocol-version-mismatch');
    expect(error.details).toMatchObject({ expected: HELPER_PROTOCOL_VERSION });
  });

  it('rejects unknown fields and bad shapes', () => {
    const message = {
      ...createHelperRequestMessage('echo', { text: 'hi' }, meta),
      extra: true,
    };
    expect(caught(() => decodeHelperMessage(JSON.stringify(message))).code).toBe('invalid-request');
  });

  it('rejects operation names outside the documented grammar', () => {
    const message = { ...createHelperRequestMessage('echo', {}, meta), op: 'Not An Op' };
    expect(caught(() => decodeHelperMessage(JSON.stringify(message))).code).toBe('invalid-request');
  });

  it('refuses to encode an oversized message', () => {
    const message = createHelperRequestMessage(
      'echo',
      { text: 'x'.repeat(MAX_FRAME_MESSAGE_BYTES) },
      meta,
    );
    expect(caught(() => encodeHelperMessage(message)).code).toBe('payload-too-large');
  });
});

describe('operations', () => {
  it('declares the transport-level operations only', () => {
    expect(healthOperation.name).toBe('health');
    expect(healthOperation.requestBinary).toBe(false);
    expect(healthOperation.responseBinary).toBe(false);
    expect(echoOperation.name).toBe('echo');
    expect(echoOperation.requestBinary).toBe(true);
    expect(echoOperation.responseBinary).toBe(true);
  });

  it('validates payloads against the operation schemas', () => {
    expect(healthOperation.request.safeParse({}).success).toBe(true);
    expect(healthOperation.request.safeParse({ nope: 1 }).success).toBe(false);
    expect(echoOperation.request.safeParse({ text: 'hi' }).success).toBe(true);
    expect(echoOperation.request.safeParse({ text: 1 }).success).toBe(false);
    expect(echoOperation.response.safeParse({ text: 'hi', binaryLength: -1 }).success).toBe(false);
  });
});
