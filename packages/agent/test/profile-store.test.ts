import { describe, expect, it } from 'vitest';
import { asModelProfileId, type ModelProfile } from '@pilot/shared';
import {
  assertNoPlaintextSecrets,
  createMemoryProfileStorage,
  createModelProfileStore,
  type ModelProfileRecord,
} from '../src/index.js';
import { FAUX_PROFILE } from './support.js';

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

function record(overrides: Partial<ModelProfileRecord> = {}): ModelProfileRecord {
  return {
    profile: REMOTE_PROFILE,
    displayName: 'Claude Sonnet',
    toolSupport: 'assumed',
    credentialRef: 'anthropic',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('model profile store', () => {
  it('round-trips a profile with its capability provenance', async () => {
    const store = createModelProfileStore({ clock: () => 1_700_000_000_000 });
    const saved = await store.save({
      profile: REMOTE_PROFILE,
      displayName: 'Claude Sonnet',
      toolSupport: 'verified',
    });
    expect(saved.credentialRef).toBe('anthropic');
    expect(saved.toolSupport).toBe('verified');

    const loaded = await store.get(REMOTE_PROFILE.id);
    expect(loaded).toEqual(saved);
    expect(await store.list()).toHaveLength(1);
  });

  it('persists through the storage seam as plain JSON that a later process can reload', async () => {
    const storage = createMemoryProfileStorage();
    const first = createModelProfileStore({ storage, clock: () => 5 });
    await first.save({ profile: REMOTE_PROFILE });
    await first.save({ profile: FAUX_PROFILE, displayName: 'Faux' });
    await first.select(FAUX_PROFILE.id);

    const second = createModelProfileStore({ storage, clock: () => 9 });
    expect(await second.list()).toHaveLength(2);
    expect((await second.selected())?.profile.id).toBe(FAUX_PROFILE.id);
  });

  it('replaces on save and keeps the original createdAt', async () => {
    let now = 100;
    const store = createModelProfileStore({ clock: () => now });
    const created = await store.save({ profile: REMOTE_PROFILE });
    now = 200;
    const updated = await store.save({ profile: REMOTE_PROFILE, displayName: 'Renamed' });
    expect(await store.list()).toHaveLength(1);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBe(200);
    expect(updated.displayName).toBe('Renamed');
  });

  it('defaults display name and credential reference from the profile', async () => {
    const store = createModelProfileStore();
    const saved = await store.save({ profile: REMOTE_PROFILE });
    expect(saved.displayName).toBe('anthropic / claude-sonnet-4-6');
    // The credential reference is the Pi provider id — Pi keys its
    // CredentialStore by provider, so there is no second identifier to drift.
    expect(saved.credentialRef).toBe(REMOTE_PROFILE.provider);
  });

  it('clears the selection when the selected profile is removed', async () => {
    const store = createModelProfileStore();
    await store.save({ profile: REMOTE_PROFILE });
    await store.select(REMOTE_PROFILE.id);
    await store.remove(REMOTE_PROFILE.id);
    expect(await store.selected()).toBeNull();
  });

  it('refuses to select a profile it does not have', async () => {
    const store = createModelProfileStore();
    await expect(store.select(asModelProfileId('nope'))).rejects.toMatchObject({
      code: 'invalid-request',
    });
  });

  it('rejects a corrupt store file loudly rather than silently starting empty', async () => {
    const store = createModelProfileStore({ storage: createMemoryProfileStorage('{ not json') });
    await expect(store.list()).rejects.toMatchObject({ code: 'invalid-request' });
  });
});

describe('model profile store — no plaintext secrets (system-design §13)', () => {
  it('rejects a base URL with embedded userinfo credentials', () => {
    expect(() =>
      assertNoPlaintextSecrets(
        record({ profile: { ...REMOTE_PROFILE, baseUrl: 'https://user:hunter2@api.example.com' } }),
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid-request' }));
  });

  it('rejects a base URL that carries a key in the query string', async () => {
    const store = createModelProfileStore();
    await expect(
      store.save({
        profile: { ...REMOTE_PROFILE, baseUrl: 'https://api.example.com/v1?api_key=abc123' },
      }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('rejects a key pasted into a display name', async () => {
    const store = createModelProfileStore();
    await expect(
      store.save({
        profile: REMOTE_PROFILE,
        displayName: 'work key sk-ant-api03-AAAAAAAAAAAAAAAA',
      }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it.each([
    ['openai key', 'sk-proj-AAAAAAAAAAAAAAAAAAAA'],
    ['github token', 'ghp_AAAAAAAAAAAAAAAAAAAA'],
    ['slack token', 'xoxb-1111111111-AAAAAAAA'],
    ['aws key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['bearer header', 'Bearer AAAAAAAAAAAAAAAAAAAA'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'],
  ])('rejects a %s smuggled into the credential reference', (_name, secret) => {
    expect(() => assertNoPlaintextSecrets(record({ credentialRef: secret }))).toThrow(
      expect.objectContaining({ code: 'invalid-request' }),
    );
  });

  it('never echoes the offending secret in the error it throws', () => {
    const secret = 'sk-ant-api03-SUPERSECRETVALUE00';
    try {
      assertNoPlaintextSecrets(record({ displayName: secret }));
      throw new Error('expected a rejection');
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('SUPERSECRETVALUE');
      expect(String((error as Error).message)).not.toContain('SUPERSECRETVALUE');
    }
  });

  it('does not false-positive on ordinary provider and model identifiers', () => {
    expect(() =>
      assertNoPlaintextSecrets(
        record({
          profile: {
            ...REMOTE_PROFILE,
            provider: 'openai-codex',
            model: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
          },
          displayName: 'Llama 3.1 70B Instruct (local, Q4_K_M)',
        }),
      ),
    ).not.toThrow();
  });

  it('never writes anything secret-shaped to storage', async () => {
    const storage = createMemoryProfileStorage();
    const store = createModelProfileStore({ storage });
    await store.save({ profile: REMOTE_PROFILE });
    await store.save({ profile: FAUX_PROFILE });
    const written = (await storage.read()) ?? '';
    expect(written).not.toMatch(/sk-|token|password|Bearer /i);
    expect(JSON.parse(written)).toMatchObject({ version: 1 });
  });
});
