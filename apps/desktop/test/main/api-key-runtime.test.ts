import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, createMemorySink } from '@pilot/shared';
import {
  RECORDED_PROVIDER_ID,
  RECORDED_TEXT_MODEL,
  RECORDED_VISION_TOOL_MODEL,
  createAesGcmCipher,
  createRecordedApiKeyProvider,
  createUnavailableCipher,
  generateSecretKey,
  type ApiKeyProvider,
  type SecretCipher,
} from '@pilot/agent';
import {
  API_KEY_ENV,
  API_KEY_PROFILE_NAME,
  CREDENTIAL_FILE,
  PROFILE_FILE,
  modelProfileDirectory,
  openApiKeyProfileRuntime,
} from '../../src/main/api-key-runtime.js';
import { resolveContextWindow } from '../../src/main/context-window.js';

/**
 * The composition root's half of PR-038: `main/index.ts` calls exactly this
 * function, and branches on exactly `runtime.source`.
 *
 * Everything here writes real files into a temporary directory, because the two
 * properties worth testing at this layer are about files: the sealed credential
 * never contains the key, and it is written owner-only.
 */

const KEY = 'sk-recorded-RUNTIME-TEST-KEY-4d9a11c0';

const roots: string[] = [];

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-apikey-runtime-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function recorded(acceptedKey = KEY): ApiKeyProvider {
  return createRecordedApiKeyProvider({ acceptedKey }).provider;
}

function env(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    [API_KEY_ENV.profile]: API_KEY_PROFILE_NAME,
    [API_KEY_ENV.provider]: RECORDED_PROVIDER_ID,
    [API_KEY_ENV.model]: RECORDED_VISION_TOOL_MODEL,
    ...overrides,
  };
}

function cipher(): SecretCipher {
  return createAesGcmCipher(generateSecretKey(), 'the test cipher');
}

describe('openApiKeyProfileRuntime — opting in', () => {
  it('does nothing at all unless PILOT_MODEL_PROFILE says so', async () => {
    const root = await newRoot();
    const runtime = await openApiKeyProfileRuntime({
      userDataPath: root,
      cipher: cipher(),
      providers: [recorded()],
      env: { [API_KEY_ENV.provider]: RECORDED_PROVIDER_ID },
    });
    expect(runtime.source).toBeNull();
    expect(runtime.manager).toBeNull();
    expect(runtime.disclosure).toBeNull();
    expect(runtime.reason).toContain('not selected');
  });

  it('reports "no source" rather than throwing when nothing is configured', async () => {
    const root = await newRoot();
    const runtime = await openApiKeyProfileRuntime({
      userDataPath: root,
      cipher: cipher(),
      providers: [recorded()],
      env: env(),
    });
    expect(runtime.source).toBeNull();
    expect(runtime.status?.state).toBe('unconfigured');
    // The banner still exists: §14 wants the destination shown before an
    // observation, and "not confirmed yet" is part of that.
    expect(runtime.disclosure?.sendsScreenOffDevice).toBe(true);
    expect(runtime.disclosure?.verification).toBe('unverified');
  });

  it('verifies a model when given a key, and hands the app a ModelSource', async () => {
    const root = await newRoot();
    const runtime = await openApiKeyProfileRuntime({
      userDataPath: root,
      cipher: cipher(),
      providers: [recorded()],
      env: env({ [API_KEY_ENV.key]: KEY }),
      mutableEnv: {},
    });
    expect(runtime.status?.state).toBe('verified');
    expect(runtime.source).not.toBeNull();
    expect(runtime.source?.profile.authMode).toBe('api-key');
    expect(runtime.source?.profile.isRemote).toBe(true);
    expect(runtime.source?.toolSupport).toBe('verified');
    expect(runtime.reason).toBe('');
  });

  it('picks the best-ranked vision model when none is named', async () => {
    const root = await newRoot();
    const runtime = await openApiKeyProfileRuntime({
      userDataPath: root,
      cipher: cipher(),
      providers: [recorded()],
      env: env({ [API_KEY_ENV.model]: undefined, [API_KEY_ENV.key]: KEY }),
      mutableEnv: {},
    });
    expect(runtime.status?.modelId).toBe(RECORDED_VISION_TOOL_MODEL);
    expect(runtime.source).not.toBeNull();
  });

  it('refuses a text-only model before any provider request, and hands out nothing', async () => {
    const root = await newRoot();
    const provider = createRecordedApiKeyProvider({ acceptedKey: KEY });
    const runtime = await openApiKeyProfileRuntime({
      userDataPath: root,
      cipher: cipher(),
      providers: [provider.provider],
      env: env({ [API_KEY_ENV.model]: RECORDED_TEXT_MODEL, [API_KEY_ENV.key]: KEY }),
      mutableEnv: {},
    });
    expect(runtime.source).toBeNull();
    expect(runtime.status?.state).toBe('unsupported-model');
    expect(provider.state.requests).toBe(0);
    expect(provider.state.imageBlocks).toBe(0);
    expect(runtime.disclosure?.verification).toBe('rejected');
  });
});

describe('openApiKeyProfileRuntime — the credential on disk', () => {
  it('writes ciphertext, owner-only, and never the key', async () => {
    const root = await newRoot();
    await openApiKeyProfileRuntime({
      userDataPath: root,
      cipher: cipher(),
      providers: [recorded()],
      env: env({ [API_KEY_ENV.key]: KEY }),
      mutableEnv: {},
    });
    const directory = modelProfileDirectory(root);
    const sealed = await readFile(join(directory, CREDENTIAL_FILE), 'utf8');
    const profiles = await readFile(join(directory, PROFILE_FILE), 'utf8');

    expect(sealed).not.toContain(KEY);
    expect(sealed).not.toContain('sk-');
    expect(profiles).not.toContain(KEY);
    expect(profiles).toContain(RECORDED_PROVIDER_ID);
    expect((await stat(join(directory, CREDENTIAL_FILE))).mode & 0o777).toBe(0o600);
  });

  it('removes PILOT_API_KEY from the environment so a spawned helper cannot inherit it', async () => {
    const root = await newRoot();
    const mutable: Record<string, string | undefined> = { [API_KEY_ENV.key]: KEY };
    await openApiKeyProfileRuntime({
      userDataPath: root,
      cipher: cipher(),
      providers: [recorded()],
      env: env({ [API_KEY_ENV.key]: KEY }),
      mutableEnv: mutable,
    });
    expect(API_KEY_ENV.key in mutable).toBe(false);
  });

  it('comes back on a second launch with no environment at all', async () => {
    const root = await newRoot();
    const shared = cipher();
    await openApiKeyProfileRuntime({
      userDataPath: root,
      cipher: shared,
      providers: [recorded()],
      env: env({ [API_KEY_ENV.key]: KEY }),
      mutableEnv: {},
    });

    const relaunch = await openApiKeyProfileRuntime({
      userDataPath: root,
      cipher: shared,
      providers: [recorded()],
      env: env(),
    });
    expect(relaunch.status?.credential.configured).toBe(true);
    expect(relaunch.status?.state).toBe('verified');
    expect(relaunch.source).not.toBeNull();
  });

  it('writes nothing at all when secure storage is unavailable', async () => {
    const root = await newRoot();
    const sink = createMemorySink();
    const runtime = await openApiKeyProfileRuntime({
      userDataPath: root,
      cipher: createUnavailableCipher('no keychain in this test'),
      providers: [recorded()],
      env: env({ [API_KEY_ENV.key]: KEY }),
      mutableEnv: {},
      logger: createLogger({ scope: 'test', level: 'debug', sink }),
    });
    expect(runtime.source).toBeNull();
    await expect(
      readFile(join(modelProfileDirectory(root), CREDENTIAL_FILE), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    // And the refusal is visible rather than silent.
    expect(runtime.reason).not.toBe('');
    expect(JSON.stringify(sink.records)).not.toContain(KEY);
  });

  it('logs the two Phase 4 numbers in fields the redactor does not eat', async () => {
    const root = await newRoot();
    const sink = createMemorySink();
    await openApiKeyProfileRuntime({
      userDataPath: root,
      cipher: cipher(),
      providers: [recorded()],
      env: env({ [API_KEY_ENV.key]: KEY }),
      mutableEnv: {},
      logger: createLogger({ scope: 'test', level: 'debug', sink }),
    });
    const line = sink.records.find((record) => record.message === 'api-key profile');
    expect(line).toBeDefined();
    // `@pilot/shared` redacts any field whose KEY matches /credential/ or
    // /image/, so `credential:` and `probeImages:` came out as markers and the
    // line said nothing. These two numbers are the evidence for "blocked
    // before screen data is sent"; a rename that reintroduced the trap would
    // pass every other test in this file.
    expect(line?.fields['configured']).toBe(true);
    expect(line?.fields['probeRequests']).toBe(1);
    expect(line?.fields['probeScreenDataSent']).toBe(0);
    expect(line?.redactedPaths).toEqual([]);
  });

  it('never logs the key, on any path', async () => {
    const root = await newRoot();
    const sink = createMemorySink();
    const logger = createLogger({ scope: 'test', level: 'debug', sink });
    await openApiKeyProfileRuntime({
      userDataPath: root,
      cipher: cipher(),
      providers: [recorded('sk-recorded-A-DIFFERENT-KEY-ENTIRELY')],
      env: env({ [API_KEY_ENV.key]: KEY }),
      mutableEnv: {},
      logger,
    });
    const records = JSON.stringify(sink.records);
    expect(records).not.toContain(KEY);
    expect(records).not.toContain('sk-recorded');
  });
});

describe('the profile the runtime produces', () => {
  it('takes the hosted branch of PR-036’s context-window rule', async () => {
    const root = await newRoot();
    const runtime = await openApiKeyProfileRuntime({
      userDataPath: root,
      cipher: cipher(),
      providers: [recorded()],
      env: env({ [API_KEY_ENV.key]: KEY }),
      mutableEnv: {},
    });
    const source = runtime.source;
    expect(source).not.toBeNull();
    if (source === null) {
      return;
    }
    const decision = resolveContextWindow({ profile: source.profile, model: source.model });
    // The rule keys on the ENDPOINT, not on the profile type: this endpoint is
    // hosted, so the advertised window is believed.
    expect(decision).toMatchObject({ contextWindow: 200_000, source: 'model', remote: true });

    // …and the same profile type against a loopback endpoint is still capped,
    // which is the half that would be wrong if the rule keyed on `authMode`.
    const loopback = resolveContextWindow({
      profile: { ...source.profile, isRemote: false },
      model: source.model,
    });
    expect(loopback).toMatchObject({ contextWindow: 32_768, source: 'local-ceiling' });
  });
});
