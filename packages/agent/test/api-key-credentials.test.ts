import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createLogger, createMemorySink, REDACTED_CREDENTIAL } from '@pilot/shared';
import {
  apiKeyCredential,
  createAesGcmCipher,
  createEncryptedCredentialStore,
  createMemorySecretStorage,
  createSecretScrubber,
  createUnavailableCipher,
  generateSecretKey,
  MIN_SCRUBBABLE_SECRET_LENGTH,
  secretsMatch,
} from '../src/index.js';

/**
 * The credential-never-leaks property, tested the way PR-020 tested
 * `ProviderCredential` (`auth-facade.test.ts`): one secret string, and every
 * surface it could possibly escape through asserted not to contain it.
 *
 * PR-020 covered the *in-memory* object. This file covers the two surfaces it
 * did not have: **the medium** (what is actually written down) and **provider
 * error text** (what comes back when the key is refused).
 */

const SECRET = 'sk-recorded-THIS-MUST-NEVER-BE-WRITTEN-DOWN-8f3a2b';
const OTHER_SECRET = 'sk-recorded-A-SECOND-KEY-THAT-MUST-NOT-LEAK-EITHER';

function newStore(key = generateSecretKey()): {
  storage: ReturnType<typeof createMemorySecretStorage>;
  store: ReturnType<typeof createEncryptedCredentialStore>;
  key: Uint8Array;
} {
  const storage = createMemorySecretStorage();
  const store = createEncryptedCredentialStore({ cipher: createAesGcmCipher(key), storage });
  return { storage, store, key };
}

describe('encrypted credential store — what reaches the medium', () => {
  it('writes ciphertext: the medium never contains the key', async () => {
    const { storage, store } = newStore();
    await store.modify('recorded-vendor', async () => apiKeyCredential(SECRET));

    const written = storage.text;
    expect(written).toBeDefined();
    expect(written).not.toContain(SECRET);
    // Not even a fragment. A 12-character prefix of a key is a real leak.
    expect(written).not.toContain(SECRET.slice(0, 12));
    expect(written).not.toContain('sk-');
  });

  it('keeps provider id and credential type in the clear, and nothing else', async () => {
    const { storage, store } = newStore();
    await store.modify('recorded-vendor', async () => apiKeyCredential(SECRET));

    const parsed = JSON.parse(storage.text ?? '{}') as {
      version: number;
      cipher: string;
      entries: { providerId: string; type: string; sealed: string }[];
    };
    expect(parsed.version).toBe(1);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.providerId).toBe('recorded-vendor');
    expect(parsed.entries[0]?.type).toBe('api_key');
    // `sealed` is the only field derived from the credential, and it is opaque.
    expect(Object.keys(parsed.entries[0] ?? {}).sort()).toEqual(['providerId', 'sealed', 'type']);
  });

  it('reads the key back — the storage is useful, not merely safe', async () => {
    const { store } = newStore();
    await store.modify('recorded-vendor', async () => apiKeyCredential(SECRET));
    const read = await store.read('recorded-vendor');
    expect(read).toEqual({ type: 'api_key', key: SECRET });
  });

  it('survives a restart: a second store over the same key opens the same file', async () => {
    const key = generateSecretKey();
    const { storage, store } = newStore(key);
    await store.modify('recorded-vendor', async () => apiKeyCredential(SECRET));

    const reopened = createEncryptedCredentialStore({
      cipher: createAesGcmCipher(key),
      storage: createMemorySecretStorage(storage.text),
    });
    expect(await reopened.read('recorded-vendor')).toEqual({ type: 'api_key', key: SECRET });
  });

  it('reports — rather than throws or deletes — when the system key has changed', async () => {
    const { storage, store } = newStore();
    await store.modify('recorded-vendor', async () => apiKeyCredential(SECRET));
    const bytesBefore = storage.text;

    const wrongKey = createEncryptedCredentialStore({
      cipher: createAesGcmCipher(generateSecretKey()),
      storage,
    });
    expect(await wrongKey.read('recorded-vendor')).toBeUndefined();
    expect(wrongKey.lastOpenFailure()).toContain('could not be decrypted');
    expect(wrongKey.lastOpenFailure()).not.toContain(SECRET);
    // The bytes are left alone: destroying them would remove the one thing a
    // user might still recover with the original Keychain.
    expect(storage.text).toBe(bytesBefore);
    // …and `list` still answers, because it never opens anything.
    expect(await wrongKey.list()).toEqual([{ providerId: 'recorded-vendor', type: 'api_key' }]);
  });

  it('refuses to write at all when secure storage is unavailable', async () => {
    const storage = createMemorySecretStorage();
    const store = createEncryptedCredentialStore({
      cipher: createUnavailableCipher('safeStorage.isEncryptionAvailable() is false'),
      storage,
    });
    expect(store.secureStorageAvailable).toBe(false);
    await expect(
      store.modify('recorded-vendor', async () => apiKeyCredential(SECRET)),
    ).rejects.toMatchObject({
      code: 'platform-unavailable',
    });
    // The whole point: no plaintext fallback, so nothing was written.
    expect(storage.text).toBeUndefined();
    expect(storage.writes).toBe(0);
  });

  it('deletes a credential and removes the medium entirely when it was the last one', async () => {
    const { storage, store } = newStore();
    await store.modify('recorded-vendor', async () => apiKeyCredential(SECRET));
    await store.delete('recorded-vendor');
    expect(storage.text).toBeUndefined();
    expect(await store.read('recorded-vendor')).toBeUndefined();
  });

  it('serializes concurrent writes rather than losing one', async () => {
    const { store } = newStore();
    await Promise.all([
      store.modify('provider-a', async () => apiKeyCredential(SECRET)),
      store.modify('provider-b', async () => apiKeyCredential(OTHER_SECRET)),
      store.modify('provider-c', async () => apiKeyCredential(`${SECRET}-c`)),
    ]);
    const listed = (await store.list()).map((entry) => entry.providerId).sort();
    expect(listed).toEqual(['provider-a', 'provider-b', 'provider-c']);
  });

  it('never leaks through the store object itself', async () => {
    const { store } = newStore();
    await store.modify('recorded-vendor', async () => apiKeyCredential(SECRET));
    expect(inspect(store)).not.toContain(SECRET);
    expect(inspect(store)).toContain(REDACTED_CREDENTIAL);
    expect(JSON.stringify(store)).not.toContain(SECRET);
    expect(JSON.stringify({ ...store })).not.toContain(SECRET);
  });

  it('never leaks through the privacy-safe logger', async () => {
    const { storage, store } = newStore();
    await store.modify('recorded-vendor', async () => apiKeyCredential(SECRET));
    const sink = createMemorySink();
    const logger = createLogger({ scope: 'test', level: 'debug', sink });
    logger.info('credential store', {
      store,
      inventory: await store.inventory(),
      serialized: await store.serialize(),
      cipher: store.cipherName,
    });
    expect(JSON.stringify(sink.records)).not.toContain(SECRET);
    void storage;
  });

  it('list() never opens anything, so it works with no cipher at all', async () => {
    const key = generateSecretKey();
    const { storage, store } = newStore(key);
    await store.modify('recorded-vendor', async () => apiKeyCredential(SECRET));
    const blind = createEncryptedCredentialStore({
      cipher: createUnavailableCipher('no keychain'),
      storage: createMemorySecretStorage(storage.text),
    });
    expect(await blind.list()).toEqual([{ providerId: 'recorded-vendor', type: 'api_key' }]);
  });
});

describe('secret scrubber', () => {
  it('removes a key from provider error text, wherever it appears', () => {
    const scrubber = createSecretScrubber([SECRET]);
    const body = `401 Unauthorized: Invalid API key provided: ${SECRET}. Check ${SECRET} at /keys`;
    const scrubbed = scrubber.scrub(body);
    expect(scrubbed).not.toContain(SECRET);
    expect(scrubbed.split(REDACTED_CREDENTIAL)).toHaveLength(3);
    expect(scrubber.taints(body)).toBe(true);
    expect(scrubber.taints(scrubbed)).toBe(false);
  });

  it('scrubs the longest match first, so a prefix key leaves no readable tail', () => {
    const short = 'sk-abcdefghij';
    const long = `${short}-klmnopqrstuv`;
    const scrubber = createSecretScrubber([short, long]);
    expect(scrubber.scrub(`key=${long}`)).toBe(`key=${REDACTED_CREDENTIAL}`);
  });

  it('ignores strings too short to be a credential', () => {
    const scrubber = createSecretScrubber(['abc']);
    expect('abc'.length).toBeLessThan(MIN_SCRUBBABLE_SECRET_LENGTH);
    expect(scrubber.scrub('abc def')).toBe('abc def');
  });

  it('forgets on logout', () => {
    const scrubber = createSecretScrubber([SECRET]);
    scrubber.forget();
    expect(scrubber.taints(SECRET)).toBe(false);
  });

  it('learns every key the store handles, without being told separately', async () => {
    const scrubber = createSecretScrubber();
    const store = createEncryptedCredentialStore({
      cipher: createAesGcmCipher(generateSecretKey()),
      storage: createMemorySecretStorage(),
      scrubber,
    });
    await store.modify('recorded-vendor', async () => apiKeyCredential(SECRET));
    expect(scrubber.taints(`error: ${SECRET}`)).toBe(true);
  });
});

describe('secretsMatch', () => {
  it('compares without leaking length through an early return', () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
    expect(secretsMatch(SECRET, OTHER_SECRET)).toBe(false);
    expect(secretsMatch(SECRET, `${SECRET}x`)).toBe(false);
    expect(secretsMatch('', '')).toBe(true);
  });
});
