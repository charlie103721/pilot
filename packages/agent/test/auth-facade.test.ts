import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { InMemoryCredentialStore, createModels } from '@earendil-works/pi-ai';
import { asModelProfileId, createLogger, createMemorySink, type ModelProfile } from '@pilot/shared';
import {
  ProviderCredential,
  createFakeAuthFacade,
  createPiAuthFacade,
  REDACTED_SECRET,
} from '../src/index.js';
import { createFauxHarness, FAUX_PROFILE } from './support.js';

const SECRET = 'sk-ant-api03-THIS-MUST-NEVER-ESCAPE';

const REMOTE_PROFILE: ModelProfile = {
  id: asModelProfileId('profile-anthropic'),
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  authMode: 'api-key',
  baseUrl: 'https://api.anthropic.com',
  supportsVision: true,
  supportsTools: true,
  isRemote: true,
};

describe('ProviderCredential — secrets cannot leak by accident', () => {
  const credential = new ProviderCredential({
    providerId: 'anthropic',
    authMode: 'api-key',
    kind: 'api_key',
    source: 'ANTHROPIC_API_KEY',
    material: { apiKey: SECRET, headers: { 'x-api-key': SECRET } },
  });

  it('exposes the secret only through reveal()', () => {
    expect(credential.reveal().apiKey).toBe(SECRET);
  });

  it('keeps the secret out of JSON.stringify — the IPC boundary', () => {
    const wire = JSON.stringify(credential);
    expect(wire).not.toContain(SECRET);
    expect(wire).toContain(REDACTED_SECRET);
  });

  it('keeps the secret out of Object.entries and spread — how loggers walk objects', () => {
    expect(JSON.stringify(Object.entries(credential))).not.toContain(SECRET);
    expect(JSON.stringify({ ...credential })).not.toContain(SECRET);
  });

  it('keeps the secret out of util.inspect and String()', () => {
    expect(inspect(credential)).not.toContain(SECRET);
    expect(String(credential)).not.toContain(SECRET);
    expect(`${String(credential)}`).toContain(REDACTED_SECRET);
  });

  it('keeps the secret out of the privacy-safe logger', () => {
    const sink = createMemorySink();
    const logger = createLogger({ scope: 'test', level: 'debug', sink });
    logger.info('authorized', { credential, status: credential.describe() });
    expect(JSON.stringify(sink.records)).not.toContain(SECRET);
  });

  it('describe() is renderer-safe: no field can hold a token', () => {
    const status = credential.describe();
    expect(status).toEqual({
      providerId: 'anthropic',
      configured: true,
      kind: 'api_key',
      source: 'ANTHROPIC_API_KEY',
      expiresAt: null,
      isSubscription: false,
    });
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });
});

describe('fake auth facade', () => {
  it('reports an unconfigured provider without pretending', async () => {
    const auth = createFakeAuthFacade();
    expect(await auth.status('anthropic')).toMatchObject({ configured: false, kind: null });
  });

  it('fails explicitly rather than issuing an unauthenticated request', async () => {
    const auth = createFakeAuthFacade();
    await expect(auth.authorize(REMOTE_PROFILE)).rejects.toMatchObject({
      code: 'authentication-required',
    });
  });

  it('authorizes a configured api-key provider at request time', async () => {
    const auth = createFakeAuthFacade({
      anthropic: { kind: 'api_key', material: { apiKey: SECRET }, source: 'ANTHROPIC_API_KEY' },
    });
    const credential = await auth.authorize(REMOTE_PROFILE);
    expect(credential.authMode).toBe('api-key');
    expect(credential.reveal().apiKey).toBe(SECRET);
    expect(auth.authorized).toEqual(['anthropic']);
  });

  it('models a subscription credential the way Codex will (PR-037)', async () => {
    const codex: ModelProfile = {
      ...REMOTE_PROFILE,
      id: asModelProfileId('profile-codex'),
      provider: 'openai-codex',
      model: 'gpt-5.5',
      authMode: 'subscription',
    };
    const auth = createFakeAuthFacade({
      'openai-codex': {
        kind: 'oauth',
        material: { apiKey: SECRET },
        source: 'OAuth',
        expiresAt: 1_700_000_000_000,
        isSubscription: true,
      },
    });
    const status = await auth.status('openai-codex');
    expect(status).toMatchObject({
      kind: 'oauth',
      isSubscription: true,
      expiresAt: 1_700_000_000_000,
    });
    const credential = await auth.authorize(codex);
    expect(credential.authMode).toBe('subscription');
    expect(JSON.stringify(credential)).not.toContain(SECRET);
  });

  it('forgets a credential (logout)', async () => {
    const auth = createFakeAuthFacade({
      anthropic: { kind: 'api_key', material: { apiKey: SECRET } },
    });
    await auth.forget('anthropic');
    expect(await auth.status('anthropic')).toMatchObject({ configured: false });
  });
});

describe('Pi-backed auth facade', () => {
  it('reports status for a registered provider without credentials', async () => {
    const harness = createFauxHarness();
    const auth = createPiAuthFacade({ models: harness.models });
    const status = await auth.status(FAUX_PROFILE.provider);
    // The faux provider declares api-key auth that resolves to {} — Pi's way of
    // saying "configured, keyless". No network, no environment variables.
    expect(status).toMatchObject({ providerId: 'pilot-faux', configured: true, kind: 'api_key' });
  });

  it('reports an unknown provider as unconfigured instead of throwing', async () => {
    const auth = createPiAuthFacade({ models: createModels() });
    expect(await auth.status('not-registered')).toMatchObject({ configured: false });
  });

  it('lists every provider it knows about', async () => {
    const harness = createFauxHarness();
    const auth = createPiAuthFacade({ models: harness.models });
    const statuses = await auth.statuses();
    expect(statuses.map((entry) => entry.providerId)).toContain('pilot-faux');
  });

  it('authorizes through Pi and wraps the result in a non-serialisable credential', async () => {
    const harness = createFauxHarness();
    const auth = createPiAuthFacade({
      models: harness.models,
      credentials: new InMemoryCredentialStore(),
    });
    const credential = await auth.authorize(FAUX_PROFILE);
    expect(credential.providerId).toBe('pilot-faux');
    expect(credential.kind).toBe('api_key');
    expect(JSON.stringify(credential)).toContain(REDACTED_SECRET);
  });

  it('refuses to authorize a profile whose provider is not registered', async () => {
    const harness = createFauxHarness();
    const auth = createPiAuthFacade({ models: harness.models });
    await expect(auth.authorize(REMOTE_PROFILE)).rejects.toMatchObject({
      code: 'authentication-required',
    });
  });

  it('reads OAuth expiry from the credential store without exposing the tokens', async () => {
    const harness = createFauxHarness();
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(FAUX_PROFILE.provider, async () => ({
      type: 'oauth',
      access: SECRET,
      refresh: `${SECRET}-refresh`,
      expires: 1_800_000_000_000,
    }));
    const auth = createPiAuthFacade({ models: harness.models, credentials });
    const status = await auth.status(FAUX_PROFILE.provider);
    expect(status.expiresAt).toBe(1_800_000_000_000);
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(JSON.stringify(await auth.statuses())).not.toContain(SECRET);
  });
});
