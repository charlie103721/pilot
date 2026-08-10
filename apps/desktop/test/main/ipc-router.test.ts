import { describe, expect, it } from 'vitest';
import {
  asRequestId,
  createRequestEnvelope,
  IPC_PROTOCOL_VERSION,
  MAX_IPC_MESSAGE_BYTES,
  PilotError,
  type FailureResponseEnvelope,
  type RequestEnvelope,
  type ResponseEnvelope,
} from '@pilot/shared';
import {
  appInfoChannel,
  interactionDispatchChannel,
  panelSetVisibleChannel,
} from '../../src/ipc/channels.js';
import { IpcRouter, type RequestContext } from '../../src/main/ipc-router.js';
import { MAX_SUBMITTED_TEXT_LENGTH } from '../../src/ipc/schemas.js';

/**
 * Main-process IPC validation.
 *
 * system-design §14 requires every renderer payload to be validated in main.
 * These tests are the proof: each one sends something a hostile or broken
 * renderer could send and asserts that main answers with a typed `PilotError`
 * rather than executing the handler.
 */

const CONTEXT: RequestContext = { senderId: 1 };

function router(): { router: IpcRouter; calls: unknown[] } {
  const calls: unknown[] = [];
  const instance = new IpcRouter({ now: () => 1_000 });

  instance.register(appInfoChannel, () => ({
    version: '0.0.0',
    protocolVersion: IPC_PROTOCOL_VERSION,
    platform: 'linux',
    usesRealPlatform: false,
  }));

  instance.register(panelSetVisibleChannel, (payload) => {
    calls.push(payload);
    return { visible: payload.visible ?? true };
  });

  return { router: instance, calls };
}

function envelope(
  channel: string,
  payload: unknown,
  overrides: Partial<Record<keyof RequestEnvelope, unknown>> = {},
) {
  return {
    kind: 'request',
    protocolVersion: IPC_PROTOCOL_VERSION,
    id: asRequestId('req-000001'),
    channel,
    issuedAt: 5,
    payload,
    ...overrides,
  };
}

function expectFailure(response: ResponseEnvelope): FailureResponseEnvelope {
  expect(response.ok).toBe(false);
  if (response.ok) {
    throw new Error('expected a failure response');
  }
  return response;
}

describe('IpcRouter', () => {
  it('accepts a valid request and answers with a success envelope', async () => {
    const { router: instance, calls } = router();

    const response = await instance.handle(
      envelope(panelSetVisibleChannel.name, { visible: true }),
      CONTEXT,
    );

    expect(response.ok).toBe(true);
    expect(response.channel).toBe(panelSetVisibleChannel.name);
    expect(response.id).toBe('req-000001');
    expect(calls).toEqual([{ visible: true }]);
  });

  it('rejects a payload that fails the channel schema without calling the handler', async () => {
    const { router: instance, calls } = router();

    const response = await instance.handle(
      envelope(panelSetVisibleChannel.name, { visible: 'yes please' }),
      CONTEXT,
    );

    const failure = expectFailure(response);
    expect(failure.error.name).toBe('PilotError');
    expect(failure.error.code).toBe('invalid-request');
    expect(failure.error.domain).toBe('ipc');
    // The renderer gets a reason it can show, never silence.
    expect(failure.error.userMessage.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it('rejects unknown properties, so a renderer cannot smuggle extra fields', async () => {
    const { router: instance, calls } = router();

    const response = await instance.handle(
      envelope(panelSetVisibleChannel.name, { visible: true, alsoCapture: 'display-1' }),
      CONTEXT,
    );

    expect(expectFailure(response).error.code).toBe('invalid-request');
    expect(calls).toEqual([]);
  });

  it('rejects a request for a channel with no handler', async () => {
    const { router: instance } = router();

    const response = await instance.handle(envelope('pilot:secrets/read', {}), CONTEXT);

    const failure = expectFailure(response);
    expect(failure.error.code).toBe('unknown-channel');
    expect(failure.channel).toBe('pilot:secrets/read');
  });

  it('rejects a request whose envelope names a different channel than its handler', async () => {
    const { router: instance, calls } = router();

    // A well-formed app-info envelope, but the payload is a panel command.
    const response = await instance.handle(
      envelope(appInfoChannel.name, { visible: true }),
      CONTEXT,
    );

    expect(expectFailure(response).error.code).toBe('invalid-request');
    expect(calls).toEqual([]);
  });

  it('rejects a mismatched protocol version', async () => {
    const { router: instance } = router();

    const response = await instance.handle(
      envelope(panelSetVisibleChannel.name, { visible: true }, { protocolVersion: 999 }),
      CONTEXT,
    );

    expect(expectFailure(response).error.code).toBe('protocol-version-mismatch');
  });

  it('rejects a message that is not an envelope at all', async () => {
    const { router: instance } = router();

    for (const raw of [null, 'hello', 42, [], { nope: true }]) {
      const response = await instance.handle(raw, CONTEXT);
      const failure = expectFailure(response);
      expect(['invalid-request', 'unknown-channel']).toContain(failure.error.code);
    }
  });

  it('rejects an oversized message before parsing it', async () => {
    const { router: instance, calls } = router();

    const huge = 'x'.repeat(MAX_IPC_MESSAGE_BYTES + 1);
    const response = await instance.handle(
      envelope(panelSetVisibleChannel.name, { visible: true, padding: huge }),
      CONTEXT,
    );

    expect(expectFailure(response).error.code).toBe('payload-too-large');
    expect(calls).toEqual([]);
  });

  it('rejects a message that cannot be serialised', async () => {
    const { router: instance } = router();
    const cyclic: Record<string, unknown> = { kind: 'request' };
    cyclic['self'] = cyclic;

    expect(expectFailure(await instance.handle(cyclic, CONTEXT)).error.code).toBe(
      'invalid-request',
    );
  });

  it('bounds free text arriving from the renderer', async () => {
    const instance = new IpcRouter({ now: () => 0 });
    let dispatched = 0;
    instance.register(interactionDispatchChannel, (command) => {
      dispatched += 1;
      return {
        state: 'thinking' as const,
        conversationId: null,
        permissions: null,
        selectedWindow: null,
        observationEnabled: false,
        speaking: false,
        liveTranscript: command.type === 'submit-text' ? command.text : null,
        transcript: [],
        lastError: null,
      };
    });

    const tooLong = await instance.handle(
      envelope(interactionDispatchChannel.name, {
        type: 'submit-text',
        text: 'a'.repeat(MAX_SUBMITTED_TEXT_LENGTH + 1),
      }),
      CONTEXT,
    );

    expect(expectFailure(tooLong).error.code).toBe('invalid-request');
    expect(dispatched).toBe(0);
  });

  it('rejects an interaction command with an unknown type', async () => {
    const instance = new IpcRouter({ now: () => 0 });
    instance.register(interactionDispatchChannel, () => {
      throw new Error('handler must not run');
    });

    const response = await instance.handle(
      envelope(interactionDispatchChannel.name, { type: 'exfiltrate-screen' }),
      CONTEXT,
    );

    expect(expectFailure(response).error.code).toBe('invalid-request');
  });

  it('converts a handler failure into a typed failure envelope', async () => {
    const instance = new IpcRouter({ now: () => 0 });
    instance.register(appInfoChannel, () => {
      throw new PilotError('provider-unavailable', 'no provider configured');
    });

    const failure = expectFailure(
      await instance.handle(envelope(appInfoChannel.name, {}), CONTEXT),
    );
    expect(failure.error.code).toBe('provider-unavailable');
    expect(failure.error.retryable).toBe(true);
  });

  it('converts an untyped handler throw into an internal PilotError', async () => {
    const instance = new IpcRouter({ now: () => 0 });
    instance.register(appInfoChannel, () => {
      throw new Error('boom');
    });

    expect(
      expectFailure(await instance.handle(envelope(appInfoChannel.name, {}), CONTEXT)).error.code,
    ).toBe('internal');
  });

  it('rejects a response the handler produced that violates the response schema', async () => {
    const instance = new IpcRouter({ now: () => 0 });
    instance.register(
      appInfoChannel,
      () =>
        // Deliberately wrong: main must not be able to send an invalid response
        // any more than the renderer can send an invalid request.
        ({ version: 1 }) as unknown as never,
    );

    expect(
      expectFailure(await instance.handle(envelope(appInfoChannel.name, {}), CONTEXT)).error.code,
    ).toBe('invalid-request');
  });

  it('correlates a failure with the request id when one is recoverable', async () => {
    const { router: instance } = router();

    const failure = expectFailure(
      await instance.handle(
        envelope(panelSetVisibleChannel.name, { visible: 'no' }, { id: asRequestId('req-abcdef') }),
        CONTEXT,
      ),
    );

    expect(failure.id).toBe('req-abcdef');
  });

  it('synthesises a request id when the message has none', async () => {
    const instance = new IpcRouter({
      now: () => 0,
      nextRequestId: () => asRequestId('req-synthetic'),
    });
    instance.register(appInfoChannel, () => {
      throw new Error('unreachable');
    });

    const failure = expectFailure(await instance.handle({ channel: 'pilot:app/info' }, CONTEXT));
    expect(failure.id).toBe('req-synthetic');
  });

  it('refuses to register a channel outside the catalogue', () => {
    const instance = new IpcRouter();
    expect(() =>
      instance.register(
        {
          name: 'pilot:rogue/channel',
          direction: 'renderer-to-main',
          request: {},
          response: {},
        } as never,
        () => undefined as never,
      ),
    ).toThrowError(PilotError);
  });

  it('refuses to register the same channel twice', () => {
    const { router: instance } = router();
    expect(() => instance.register(appInfoChannel, () => undefined as never)).toThrowError(
      PilotError,
    );
  });

  it('round-trips a request built by the renderer-side envelope factory', async () => {
    const { router: instance, calls } = router();

    const request = createRequestEnvelope(
      panelSetVisibleChannel,
      { toggle: true },
      { id: asRequestId('req-round-trip'), issuedAt: 7 },
    );

    const response = await instance.handle(request, CONTEXT);

    expect(response.ok).toBe(true);
    expect(calls).toEqual([{ toggle: true }]);
  });
});
