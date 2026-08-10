import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, createMemorySink } from '@pilot/shared';
import {
  CODEX_CREDENTIALS_FILE,
  codexCredentialsPath,
  createCodexCredentialStore,
  createFakeCodexAuthSurface,
  signInToCodex,
  type CodexSecretProtector,
} from '../src/index.js';

/**
 * The credential file (PR-037).
 *
 * This is the one place in Pilot that writes secret material to disk, so what
 * is asserted here is exactly what `docs/system-design.md` §13 and the Phase 4
 * gate turn on: where the file is, who can read it, that the encryption seam is
 * really used, that a corrupt file degrades to "signed out" rather than to a
 * refusal to start, and that signing out removes the file rather than emptying
 * it.
 */

const SECRET = 'refresh-token-THIS-MUST-NEVER-ESCAPE';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'pilot-codex-store-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function storePath(): string {
  return codexCredentialsPath(workspace);
}

describe('where the file is', () => {
  it('is its own file in its own directory, not beside the conversation database', () => {
    const path = storePath();
    expect(path.endsWith(join('credentials', CODEX_CREDENTIALS_FILE))).toBe(true);
    // docs/handoff.md §1 step 16 (3) promises `conversations/` holds the
    // conversation history and nothing else. The mirror of that promise is
    // that signing out must not touch it.
    expect(path).not.toContain('conversations');
  });
});

describe('reading and writing', () => {
  it('resolves undefined for a provider with nothing stored, and for a missing file', async () => {
    const store = createCodexCredentialStore({ filePath: storePath() });
    expect(await store.read('openai-codex')).toBeUndefined();
    expect(await store.list()).toEqual([]);
    expect(await store.providerIds()).toEqual([]);
  });

  it('round-trips a credential and writes 0600 in a 0700 directory', async () => {
    const store = createCodexCredentialStore({ filePath: storePath() });
    await store.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'access',
      refresh: SECRET,
      expires: 123,
    }));
    expect(await store.read('openai-codex')).toMatchObject({ type: 'oauth', refresh: SECRET });
    expect(statSync(storePath()).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(storePath())).mode & 0o777).toBe(0o700);
  });

  it('leaves the entry unchanged when the modifier returns undefined (Pi’s contract)', async () => {
    const store = createCodexCredentialStore({ filePath: storePath() });
    await store.modify('openai-codex', async () => ({ type: 'api_key', key: 'k' }));
    const unchanged = await store.modify('openai-codex', async () => undefined);
    expect(unchanged).toMatchObject({ type: 'api_key' });
    expect(await store.read('openai-codex')).toMatchObject({ type: 'api_key' });
  });

  it('serializes concurrent modifications rather than losing one', async () => {
    const store = createCodexCredentialStore({ filePath: storePath() });
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((id) =>
        store.modify(id, async () => ({ type: 'api_key', key: `key-${id}` })),
      ),
    );
    expect(await store.providerIds()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('lists provider ids and credential types, never credentials', async () => {
    const store = createCodexCredentialStore({ filePath: storePath() });
    await store.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'a',
      refresh: SECRET,
      expires: 1,
    }));
    const listed = await store.list();
    expect(listed).toEqual([{ providerId: 'openai-codex', type: 'oauth' }]);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });
});

describe('deleting', () => {
  it('removes the file entirely when the last credential goes', async () => {
    const store = createCodexCredentialStore({ filePath: storePath() });
    await store.modify('openai-codex', async () => ({ type: 'api_key', key: 'k' }));
    expect(existsSync(storePath())).toBe(true);
    await store.delete('openai-codex');
    // Not an empty file: signing out must not leave a credentials file behind
    // for a forensic reader to wonder about.
    expect(existsSync(storePath())).toBe(false);
    expect(await store.read('openai-codex')).toBeUndefined();
  });

  it('keeps other providers when one is deleted', async () => {
    const store = createCodexCredentialStore({ filePath: storePath() });
    await store.modify('openai-codex', async () => ({ type: 'api_key', key: 'a' }));
    await store.modify('anthropic', async () => ({ type: 'api_key', key: 'b' }));
    await store.delete('openai-codex');
    expect(await store.providerIds()).toEqual(['anthropic']);
  });

  it('deleting something that is not there is a no-op', async () => {
    const store = createCodexCredentialStore({ filePath: storePath() });
    await store.delete('openai-codex');
    expect(existsSync(storePath())).toBe(false);
  });
});

describe('the encryption seam', () => {
  const rot13: CodexSecretProtector = {
    available: true,
    encrypt: (plaintext) => Buffer.from(plaintext, 'utf8').toString('base64'),
    decrypt: (protectedText) => Buffer.from(protectedText, 'base64').toString('utf8'),
  };

  it('is actually used: the plaintext token is not in the bytes', async () => {
    const store = createCodexCredentialStore({ filePath: storePath(), protector: rot13 });
    expect(store.encrypted).toBe(true);
    await store.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'a',
      refresh: SECRET,
      expires: 1,
    }));
    const bytes = readFileSync(storePath(), 'utf8');
    expect(bytes).not.toContain(SECRET);
    expect(bytes).toContain('"protected":true');
    expect(await store.read('openai-codex')).toMatchObject({ refresh: SECRET });
  });

  it('records `protected: false` without a protector, so nothing can pretend', async () => {
    const store = createCodexCredentialStore({ filePath: storePath() });
    expect(store.encrypted).toBe(false);
    await store.modify('openai-codex', async () => ({ type: 'api_key', key: 'k' }));
    expect(readFileSync(storePath(), 'utf8')).toContain('"protected":false');
  });

  it('treats a credential it cannot decrypt as absent, and says so once', async () => {
    const store = createCodexCredentialStore({ filePath: storePath(), protector: rot13 });
    await store.modify('openai-codex', async () => ({ type: 'api_key', key: 'k' }));
    const sink = createMemorySink();
    const rekeyed = createCodexCredentialStore({
      filePath: storePath(),
      protector: {
        available: true,
        encrypt: rot13.encrypt,
        decrypt: () => {
          throw new Error('the keychain entry has been replaced');
        },
      },
      logger: createLogger({ scope: 'test', level: 'debug', sink }),
    });
    expect(await rekeyed.read('openai-codex')).toBeUndefined();
    expect(JSON.stringify(sink.records)).toContain('could not be decoded');
  });
});

describe('a damaged file', () => {
  it('is treated as empty rather than as a reason not to start', async () => {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), '{ not json');
    const sink = createMemorySink();
    const store = createCodexCredentialStore({
      filePath: storePath(),
      logger: createLogger({ scope: 'test', level: 'debug', sink }),
    });
    expect(await store.read('openai-codex')).toBeUndefined();
    expect(JSON.stringify(sink.records)).toContain('not valid JSON');
  });

  it('is treated as empty when the shape is wrong', async () => {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), JSON.stringify({ version: 99, entries: 'nope' }));
    const store = createCodexCredentialStore({ filePath: storePath() });
    expect(await store.read('openai-codex')).toBeUndefined();
  });

  it('never puts the file’s contents in a log line', async () => {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), `{ broken ${SECRET}`);
    const sink = createMemorySink();
    const store = createCodexCredentialStore({
      filePath: storePath(),
      logger: createLogger({ scope: 'test', level: 'debug', sink }),
    });
    await store.read('openai-codex');
    expect(JSON.stringify(sink.records)).not.toContain(SECRET);
  });
});

describe('end to end, through Pi', () => {
  it('a sign-in writes the token and a sign-out removes the file', async () => {
    const store = createCodexCredentialStore({ filePath: storePath() });
    const surface = createFakeCodexAuthSurface({ credentials: store });
    await signInToCodex({ models: surface.models, observer: { deviceCode: () => undefined } });

    const bytes = readFileSync(storePath(), 'utf8');
    // Written by `Models.login` → `credentials.modify`, not planted here.
    expect(surface.issuedTokens.some((token) => bytes.includes(token))).toBe(true);

    await surface.models.logout('openai-codex');
    expect(existsSync(storePath())).toBe(false);
  });
});
