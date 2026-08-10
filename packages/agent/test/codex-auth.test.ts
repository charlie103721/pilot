import { describe, expect, it } from 'vitest';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { createLogger, createMemorySink } from '@pilot/shared';
import {
  CODEX_AUTH_MESSAGES,
  CODEX_BROWSER_CALLBACK_PORT,
  CODEX_BROWSER_METHOD,
  CODEX_DEVICE_CODE_METHOD,
  CODEX_DEVICE_VERIFICATION_URI,
  CODEX_OAUTH_DISPLAY_NAME,
  CODEX_PROVIDER_ID,
  CODEX_REFRESH_WINDOW_MS,
  classifyCodexAuthFailure,
  createCodexDeviceCodeInteraction,
  createFakeCodexAuthSurface,
  describeCodexAuth,
  readCodexAuthStatus,
  signInToCodex,
  signOutOfCodex,
  signedOutCodexStatus,
  type CodexAuthStatus,
  type CredentialStatus,
} from '../src/index.js';

/**
 * Codex auth (PR-037).
 *
 * Three groups, and each exists because the thing it pins fails *silently*:
 *
 *  1. **The real Pi surface.** Everything in `docs/pi-notes.md` §9.1 that this
 *     PR is built on is read back off the pinned package here. If a future Pi
 *     release renames the provider, drops `isSubscription`, or makes
 *     `gpt-5.3-codex-spark` claim vision, these fail instead of Pilot quietly
 *     sending a screenshot to a model that cannot see it.
 *  2. **Device code, never browser.** The refusal has to happen at the `select`
 *     prompt, because that is the last moment before Pi binds port
 *     {@link CODEX_BROWSER_CALLBACK_PORT}.
 *  3. **No credential material anywhere.** Asserted against the actual fixture
 *     tokens the fake surface issued, not against a pattern.
 */

const NOW = 1_800_000_000_000;

function status(overrides: Partial<CredentialStatus> = {}): CredentialStatus {
  return {
    providerId: CODEX_PROVIDER_ID,
    configured: true,
    kind: 'oauth',
    source: 'OAuth',
    expiresAt: NOW + 3_600_000,
    isSubscription: true,
    ...overrides,
  };
}

describe('the real Codex provider surface (pinned)', () => {
  const provider = openaiCodexProvider();

  it('is the provider id, name and base URL docs/pi-notes.md §9.1 recorded', () => {
    expect(provider.id).toBe(CODEX_PROVIDER_ID);
    expect(provider.baseUrl).toBe('https://chatgpt.com/backend-api');
  });

  it('offers subscription-backed OAuth under the recorded display name', () => {
    expect(provider.auth.oauth?.isSubscription).toBe(true);
    expect(provider.auth.oauth?.name).toBe(CODEX_OAUTH_DISPLAY_NAME);
    // No api-key auth at all: this provider cannot be configured with a key,
    // which is why PR-038 is a separate profile rather than a flag on this one.
    expect(provider.auth.apiKey).toBeUndefined();
  });

  it('still ships gpt-5.3-codex-spark as text-only, and vision models beside it', () => {
    const models = provider.getModels();
    const spark = models.find((model) => model.id === 'gpt-5.3-codex-spark');
    expect(spark?.input).toEqual(['text']);
    const vision = models.filter((model) => model.input.includes('image')).map((m) => m.id);
    // The four docs/pi-notes.md §9.1 recorded. The catalogue has grown since;
    // asserting containment rather than equality is what lets it.
    expect(vision).toEqual(
      expect.arrayContaining(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-luna']),
    );
  });
});

describe('describeCodexAuth', () => {
  it('reports an absent credential as signed out and needing a sign-in', () => {
    const described = describeCodexAuth(status({ configured: false }), NOW);
    expect(described.state).toBe('signed-out');
    expect(described.signInRequired).toBe(true);
    expect(described.expiresInMs).toBeNull();
  });

  it('reports a credential with hours left as active', () => {
    const described = describeCodexAuth(status(), NOW);
    expect(described.state).toBe('active');
    expect(described.signInRequired).toBe(false);
    expect(described.expiresInMs).toBe(3_600_000);
  });

  it('reports a credential inside Pi’s refresh window as renewing, not broken', () => {
    const described = describeCodexAuth(status({ expiresAt: NOW + 60_000 }), NOW);
    expect(described.state).toBe('refresh-due');
    // The whole point of the state: Pi rotates it on the next request, so the
    // user is not asked to do anything.
    expect(described.signInRequired).toBe(false);
  });

  it('uses exactly Pi’s own five-minute boundary', () => {
    const inside = describeCodexAuth(status({ expiresAt: NOW + CODEX_REFRESH_WINDOW_MS }), NOW);
    const outside = describeCodexAuth(
      status({ expiresAt: NOW + CODEX_REFRESH_WINDOW_MS + 1 }),
      NOW,
    );
    expect(inside.state).toBe('refresh-due');
    expect(outside.state).toBe('active');
  });

  it('reports a past expiry as expired and needing a sign-in', () => {
    const described = describeCodexAuth(status({ expiresAt: NOW - 1 }), NOW);
    expect(described.state).toBe('expired');
    expect(described.signInRequired).toBe(true);
  });

  it('reports a credential with no expiry as active rather than guessing', () => {
    expect(describeCodexAuth(status({ expiresAt: null }), NOW).state).toBe('active');
  });

  it('has no field that could hold a token', () => {
    const described: CodexAuthStatus = describeCodexAuth(status(), NOW);
    expect(Object.keys(described).sort()).toEqual([
      'configured',
      'detail',
      'expiresAt',
      'expiresInMs',
      'isSubscription',
      'kind',
      'label',
      'providerId',
      'signInRequired',
      'source',
      'state',
    ]);
  });
});

describe('the sign-in driver refuses the browser flow', () => {
  it('answers the login-method select with device_code', async () => {
    const { interaction, log } = createCodexDeviceCodeInteraction({ deviceCode: () => undefined });
    const chosen = await interaction.prompt({
      type: 'select',
      message: 'Select OpenAI Codex login method:',
      options: [
        { id: CODEX_BROWSER_METHOD, label: 'Browser login (default)' },
        { id: CODEX_DEVICE_CODE_METHOD, label: 'Device code login (headless)' },
      ],
    });
    expect(chosen).toBe(CODEX_DEVICE_CODE_METHOD);
    expect(log.chose).toBe(CODEX_DEVICE_CODE_METHOD);
  });

  it('fails loudly if Pi stops offering device_code, rather than falling back', async () => {
    const { interaction } = createCodexDeviceCodeInteraction({ deviceCode: () => undefined });
    await expect(
      interaction.prompt({
        type: 'select',
        message: 'Select OpenAI Codex login method:',
        options: [{ id: CODEX_BROWSER_METHOD, label: 'Browser login (default)' }],
      }),
    ).rejects.toMatchObject({
      code: 'authentication-required',
      details: { reason: 'device-code-unavailable' },
    });
  });

  it('refuses the browser flow’s manual_code prompt', async () => {
    const { interaction } = createCodexDeviceCodeInteraction({ deviceCode: () => undefined });
    await expect(
      interaction.prompt({ type: 'manual_code', message: 'paste the redirect URL' }),
    ).rejects.toMatchObject({ details: { reason: 'browser-flow-refused' } });
  });

  it('refuses an auth_url event too, and says which port it means', () => {
    const { interaction } = createCodexDeviceCodeInteraction({ deviceCode: () => undefined });
    expect(() =>
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize' }),
    ).toThrow(new RegExp(String(CODEX_BROWSER_CALLBACK_PORT)));
  });

  it('forwards the device code and nothing else', () => {
    const codes: unknown[] = [];
    const { interaction, log } = createCodexDeviceCodeInteraction({
      deviceCode: (code) => codes.push(code),
    });
    interaction.notify({
      type: 'device_code',
      userCode: 'ABCD-1234',
      verificationUri: CODEX_DEVICE_VERIFICATION_URI,
      intervalSeconds: 5,
      expiresInSeconds: 900,
    });
    expect(codes).toEqual([
      {
        userCode: 'ABCD-1234',
        verificationUri: CODEX_DEVICE_VERIFICATION_URI,
        intervalSeconds: 5,
        expiresInSeconds: 900,
      },
    ]);
    expect(log.events).toEqual(['device_code']);
  });
});

describe('sign in and out, against the recorded surface', () => {
  it('signs in through the device-code flow and never binds port 1455', async () => {
    const surface = createFakeCodexAuthSurface();
    const codes: string[] = [];
    const result = await signInToCodex({
      models: surface.models,
      observer: { deviceCode: (code) => codes.push(code.userCode) },
    });
    expect(result.log.chose).toBe(CODEX_DEVICE_CODE_METHOD);
    expect(codes).toEqual(['PILOT-TEST']);
    expect(surface.browserServerBound()).toBe(false);
    expect(surface.logins).toEqual([
      { method: CODEX_DEVICE_CODE_METHOD, boundCallbackPort: false },
    ]);
    expect(result.status.configured).toBe(true);
  });

  it('reads the expiry back from the credential store without revealing the token', async () => {
    const surface = createFakeCodexAuthSurface();
    await signInToCodex({ models: surface.models, observer: { deviceCode: () => undefined } });
    const read = await readCodexAuthStatus({
      models: surface.models,
      credentials: surface.credentials,
    });
    expect(read.state).toBe('active');
    expect(read.isSubscription).toBe(true);
    expect(read.source).toBe('OAuth');
    const serialized = JSON.stringify(read);
    for (const token of surface.issuedTokens) {
      expect(serialized).not.toContain(token);
    }
  });

  it('keeps every issued token out of the privacy-safe logger', async () => {
    const sink = createMemorySink();
    const logger = createLogger({ scope: 'test', level: 'debug', sink });
    const surface = createFakeCodexAuthSurface();
    await signInToCodex({
      models: surface.models,
      observer: { deviceCode: () => undefined },
      logger,
    });
    const records = JSON.stringify(sink.records);
    expect(records).toContain('codex sign-in completed');
    for (const token of surface.issuedTokens) {
      expect(records).not.toContain(token);
    }
  });

  it('signs out, and a signed-out provider signs out again without complaining', async () => {
    const surface = createFakeCodexAuthSurface();
    await signInToCodex({ models: surface.models, observer: { deviceCode: () => undefined } });
    expect((await signOutOfCodex({ models: surface.models })).state).toBe('signed-out');
    expect((await signOutOfCodex({ models: surface.models })).state).toBe('signed-out');
    expect(await readCodexAuthStatus({ models: surface.models })).toMatchObject({
      configured: false,
    });
  });

  it('reports an unregistered provider as signed out rather than throwing', async () => {
    const surface = createFakeCodexAuthSurface();
    expect(
      await readCodexAuthStatus({ models: surface.models, providerId: 'not-registered' }),
    ).toEqual(signedOutCodexStatus('not-registered'));
  });
});

describe('classifyCodexAuthFailure', () => {
  it('recognises Pi’s own refresh failure by the words Pi writes', () => {
    const failure = classifyCodexAuthFailure(
      new Error('OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (400)'),
    );
    expect(failure?.reason).toBe('refresh-failed');
    expect(failure?.signInFixesIt).toBe(true);
    expect(failure?.error.userMessage).toBe(CODEX_AUTH_MESSAGES['refresh-failed']);
  });

  it('recognises Pi’s unconfigured-provider message as signed out', () => {
    expect(classifyCodexAuthFailure('Provider is not configured: openai-codex')?.reason).toBe(
      'signed-out',
    );
  });

  it('recognises a credential-store failure as one the user cannot fix by signing in', () => {
    const failure = classifyCodexAuthFailure(
      new Error('Credential store modify failed for openai-codex'),
    );
    expect(failure?.reason).toBe('credential-store-failed');
    expect(failure?.signInFixesIt).toBe(false);
  });

  it('reads the reason back off a serialized PilotError, which is what run-failed carries', () => {
    const original = classifyCodexAuthFailure(new Error('invalid_grant'));
    const roundTripped = classifyCodexAuthFailure(original?.error.toJSON());
    expect(roundTripped?.reason).toBe('refresh-failed');
  });

  it('says nothing about a failure that is not an auth failure', () => {
    expect(classifyCodexAuthFailure(new Error('capture failed: the window closed'))).toBeNull();
    expect(classifyCodexAuthFailure(undefined)).toBeNull();
    expect(classifyCodexAuthFailure(42)).toBeNull();
  });
});
