import { describe, expect, it } from 'vitest';
import { createLogger, createMemorySink } from '@pilot/shared';
import {
  RECORDED_BASE_URL,
  RECORDED_PROVIDER_ID,
  RECORDED_TEXT_MODEL,
  RECORDED_VISION_ONLY_MODEL,
  RECORDED_VISION_TOOL_MODEL,
  classifyApiKeyFailure,
  createAesGcmCipher,
  createApiKeyModels,
  createApiKeyProfileManager,
  createMemoryProfileStorage,
  createMemorySecretStorage,
  createRecordedApiKeyProvider,
  createSecretScrubber,
  describeModelDataDisclosure,
  generateSecretKey,
  invalidKeyMessage,
  listApiKeyModels,
  listApiKeyProviders,
  probeApiKeyModel,
  rankApiKeyModels,
  type ApiKeyProfileManager,
  type RecordedApiKeyProvider,
} from '../src/index.js';

/**
 * PR-038's behaviour, against the recorded provider surface.
 *
 * There is no API key in this environment and none may be obtained
 * (`docs/handoff.md` §2), so "the vendor" is `createRecordedApiKeyProvider` —
 * Pi's real `Models` path, real auth resolution from the real encrypted store,
 * and a fake server at the far end that rejects a wrong key with a 401 whose
 * body echoes the key back, the way real vendors do.
 */

const GOOD_KEY = 'sk-recorded-GOOD-KEY-0123456789abcdef';
const BAD_KEY = 'sk-recorded-WRONG-KEY-fedcba9876543210';

interface Harness {
  readonly manager: ApiKeyProfileManager;
  readonly recorded: RecordedApiKeyProvider;
  readonly secretStorage: ReturnType<typeof createMemorySecretStorage>;
  readonly profileStorage: ReturnType<typeof createMemoryProfileStorage>;
  readonly sink: ReturnType<typeof createMemorySink>;
}

function harness(
  options: {
    readonly acceptedKey?: string;
    readonly rateLimited?: boolean;
    readonly unreachable?: boolean;
  } = {},
): Harness {
  const recorded = createRecordedApiKeyProvider({
    acceptedKey: options.acceptedKey ?? GOOD_KEY,
    ...(options.rateLimited === undefined ? {} : { rateLimited: options.rateLimited }),
    ...(options.unreachable === undefined ? {} : { unreachable: options.unreachable }),
  });
  const secretStorage = createMemorySecretStorage();
  const profileStorage = createMemoryProfileStorage();
  const sink = createMemorySink();
  const bundle = createApiKeyModels({
    cipher: createAesGcmCipher(generateSecretKey(), 'aes-256-gcm (test)'),
    secretStorage,
    providers: [recorded.provider],
  });
  const manager = createApiKeyProfileManager({
    bundle,
    profileStorage,
    storageName: 'the macOS Keychain',
    logger: createLogger({ scope: 'test', level: 'debug', sink }),
  });
  return { manager, recorded, secretStorage, profileStorage, sink };
}

async function configured(model = RECORDED_VISION_TOOL_MODEL, key = GOOD_KEY): Promise<Harness> {
  const rig = harness();
  await rig.manager.choose(RECORDED_PROVIDER_ID, model);
  await rig.manager.saveKey(key);
  return rig;
}

/* -------------------------------------------------------------------------- *
 * Provider and model selection
 * -------------------------------------------------------------------------- */

describe('provider and model selection', () => {
  it('lists every provider that authenticates with an API key', async () => {
    const rig = harness();
    const listed = rig.manager.providers();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      providerId: RECORDED_PROVIDER_ID,
      credentialName: 'Recorded Vendor API key',
      supportsInteractiveLogin: true,
      isRemote: true,
      host: 'api.recorded-vendor.example',
      modelCount: 3,
      visionModelCount: 2,
    });
  });

  it('lists the provider’s models with the one fact metadata can give', () => {
    const rig = harness();
    const models = rig.manager.modelsFor(RECORDED_PROVIDER_ID);
    expect(models.map((model) => [model.modelId, model.acceptsImages])).toEqual([
      [RECORDED_VISION_TOOL_MODEL, true],
      [RECORDED_VISION_ONLY_MODEL, true],
      [RECORDED_TEXT_MODEL, false],
    ]);
    expect(models.every((model) => model.isRemote)).toBe(true);
  });

  it('ranks candidates without deciding: images required, biggest window first', () => {
    const rig = harness();
    const ranked = rankApiKeyModels(rig.manager.modelsFor(RECORDED_PROVIDER_ID));
    expect(ranked.map((model) => model.modelId)).toEqual([
      RECORDED_VISION_TOOL_MODEL,
      RECORDED_VISION_ONLY_MODEL,
    ]);
  });
});

/* -------------------------------------------------------------------------- *
 * The capability probe
 * -------------------------------------------------------------------------- */

describe('capability probe — nothing is sent before the gate decides', () => {
  it('refuses a text-only model with ZERO provider requests and ZERO image blocks', async () => {
    const rig = await configured(RECORDED_TEXT_MODEL);
    const status = await rig.manager.verify();

    expect(status.state).toBe('unsupported-model');
    expect(status.usable).toBe(false);
    expect(status.probe?.stage).toBe('vision');
    expect(status.probe?.providerRequests).toBe(0);
    expect(status.probe?.imageBlocksSent).toBe(0);
    expect(status.probe?.refusal?.reason).toBe('no-vision');
    // The number that says "before anything was sent": the recorded vendor
    // never heard from us at all.
    expect(rig.recorded.state.requests).toBe(0);
    expect(rig.recorded.state.imageBlocks).toBe(0);
    expect(rig.manager.source()).toBeNull();
  });

  it('refuses a model that will not call tools, after exactly one text-only request', async () => {
    const rig = await configured(RECORDED_VISION_ONLY_MODEL);
    const status = await rig.manager.verify();

    expect(status.state).toBe('unsupported-model');
    expect(status.probe?.stage).toBe('tools');
    expect(status.probe?.providerRequests).toBe(1);
    expect(status.probe?.imageBlocksSent).toBe(0);
    expect(status.probe?.refusal?.reason).toBe('no-tools');
    expect(rig.recorded.state.requests).toBe(1);
    // The one request the probe is allowed to make carried no image.
    expect(rig.recorded.state.imageBlocks).toBe(0);
    expect(rig.manager.source()).toBeNull();
  });

  it('verifies a model that accepts images and calls tools', async () => {
    const rig = await configured();
    const status = await rig.manager.verify();

    expect(status.state).toBe('verified');
    expect(status.usable).toBe(true);
    expect(status.probe).toMatchObject({
      ok: true,
      stage: 'gate',
      vision: true,
      tools: true,
      providerRequests: 1,
      imageBlocksSent: 0,
    });
    expect(rig.recorded.state.imageBlocks).toBe(0);

    const source = rig.manager.source();
    expect(source).not.toBeNull();
    expect(source?.profile).toMatchObject({
      provider: RECORDED_PROVIDER_ID,
      model: RECORDED_VISION_TOOL_MODEL,
      authMode: 'api-key',
      supportsVision: true,
      supportsTools: true,
      isRemote: true,
      baseUrl: RECORDED_BASE_URL,
    });
    // `supportsTools` is MEASURED here, not defaulted — the thing every
    // profile before PR-038 could only assume (`docs/pi-notes.md` §6.3).
    expect(source?.toolSupport).toBe('verified');
    expect(source?.probe.report?.facts.tools.confidence).toBe('verified');
  });

  it('refuses before any request when there is no credential at all', async () => {
    const rig = harness();
    await rig.manager.choose(RECORDED_PROVIDER_ID, RECORDED_VISION_TOOL_MODEL);
    const status = await rig.manager.verify();

    expect(status.probe?.stage).toBe('auth');
    expect(status.probe?.providerRequests).toBe(0);
    expect(rig.recorded.state.requests).toBe(0);
    expect(status.state).toBe('unconfigured');
    expect(rig.manager.source()).toBeNull();
  });

  it('refuses a model the provider does not list, before anything else', async () => {
    const rig = await configured();
    const outcome = await probeApiKeyModel({
      models: createApiKeyModels({
        cipher: createAesGcmCipher(generateSecretKey()),
        providers: [rig.recorded.provider],
      }).models,
      providerId: RECORDED_PROVIDER_ID,
      modelId: 'a-model-that-was-retired',
      profileId: 'probe-retired',
    });
    expect(outcome.stage).toBe('model');
    expect(outcome.providerRequests).toBe(0);
    expect(outcome.refusal?.reason).toBe('profile-model-mismatch');
  });

  it('names the probe prompt honestly: it carries no user or screen content', async () => {
    const rig = await configured();
    await rig.manager.verify();
    expect(rig.recorded.state.lastToolNames).toEqual(['pilot_capability_probe']);
  });
});

/* -------------------------------------------------------------------------- *
 * Invalid-key detection and recovery
 * -------------------------------------------------------------------------- */

describe('invalid-key recovery', () => {
  it('detects a rejected key at probe time and never quotes it', async () => {
    const rig = await configured(RECORDED_VISION_TOOL_MODEL, BAD_KEY);
    const status = await rig.manager.verify();

    expect(status.state).toBe('invalid-key');
    expect(status.usable).toBe(false);
    expect(status.failure?.code).toBe('authentication-required');
    expect(status.remedy).toContain('Enter a new API key');
    expect(rig.recorded.state.rejections).toBe(1);
    // The 401 body echoed the key. Nothing that came out of it does.
    expect(JSON.stringify(status)).not.toContain(BAD_KEY);
    expect(JSON.stringify(status.failure)).toContain('[redacted:credential]');
    expect(rig.manager.source()).toBeNull();
  });

  it('recovers: a new key, one re-probe, and the profile is usable again', async () => {
    const rig = await configured(RECORDED_VISION_TOOL_MODEL, BAD_KEY);
    expect((await rig.manager.verify()).state).toBe('invalid-key');

    const afterSave = await rig.manager.saveKey(GOOD_KEY);
    // Saving a key does NOT make the profile usable. Verification does.
    expect(afterSave.state).toBe('configured-unverified');
    expect(rig.manager.source()).toBeNull();

    const verified = await rig.manager.verify();
    expect(verified.state).toBe('verified');
    expect(rig.manager.source()).not.toBeNull();
    expect(verified.failure).toBeNull();
  });

  it('a key revoked mid-conversation takes the profile out of service', async () => {
    const rig = await configured();
    expect((await rig.manager.verify()).state).toBe('verified');
    expect(rig.manager.source()).not.toBeNull();

    // The provider rotates its accepted key: the stored one is now revoked.
    rig.recorded.rotateKey('sk-recorded-ROTATED-KEY-1111111111111111');
    const status = rig.manager.noteRunFailure(invalidKeyMessage(GOOD_KEY));

    expect(status.state).toBe('invalid-key');
    expect(rig.manager.source()).toBeNull();
    expect(status.disclosure?.verification).toBe('unverified');
    expect(JSON.stringify(status)).not.toContain(GOOD_KEY);
  });

  it('a rate limit is NOT treated as a bad key: the profile stays verified', async () => {
    const rig = await configured();
    await rig.manager.verify();
    const status = rig.manager.noteRunFailure(
      '429 Too Many Requests: {"error":{"type":"rate_limit_error"}}',
    );
    expect(status.state).toBe('verified');
    expect(status.failure?.code).toBe('rate-limited');
    expect(rig.manager.source()).not.toBeNull();
  });

  it('an unreachable provider is reported as unreachable, not as a bad key', async () => {
    const rig = await configured();
    await rig.manager.verify();
    const status = rig.manager.noteRunFailure('fetch failed: getaddrinfo ENOTFOUND api.example');
    expect(status.state).toBe('provider-unavailable');
    expect(status.failure?.code).toBe('provider-unavailable');
    expect(status.remedy).toContain('network');
    expect(rig.manager.source()).toBeNull();
  });

  it('classifies the four provider failures apart, and scrubs every one', () => {
    const scrubber = createSecretScrubber([GOOD_KEY]);
    const at = { providerId: RECORDED_PROVIDER_ID, modelId: RECORDED_VISION_TOOL_MODEL, scrubber };

    expect(classifyApiKeyFailure(invalidKeyMessage(GOOD_KEY), at).kind).toBe('invalid-key');
    expect(classifyApiKeyFailure('429 rate_limit_error', at).kind).toBe('rate-limited');
    expect(classifyApiKeyFailure('fetch failed ECONNREFUSED', at).kind).toBe('unreachable');
    expect(classifyApiKeyFailure('Provider is not configured: x', at).kind).toBe('not-configured');
    expect(classifyApiKeyFailure('the model exploded', at).kind).toBe('unknown');

    const failure = classifyApiKeyFailure(invalidKeyMessage(GOOD_KEY), at);
    expect(failure.error.message).not.toContain(GOOD_KEY);
    expect(failure.error.message).toContain('[redacted:credential]');
    // No `cause` chain: a crash reporter walks it, and it holds the raw body.
    expect(failure.error.cause).toBeUndefined();
  });

  it('reports a rate-limited provider at probe time without losing the key', async () => {
    const rig = harness({ rateLimited: true });
    await rig.manager.choose(RECORDED_PROVIDER_ID, RECORDED_VISION_TOOL_MODEL);
    await rig.manager.saveKey(GOOD_KEY);
    const status = await rig.manager.verify();
    expect(status.state).toBe('provider-unavailable');
    expect(status.credential.configured).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * Honesty: configured is not verified
 * -------------------------------------------------------------------------- */

describe('a configured profile does not look like a working one', () => {
  it('hands out no source in any state but `verified`', async () => {
    const rig = harness();
    expect(rig.manager.status().state).toBe('unconfigured');
    expect(rig.manager.source()).toBeNull();

    await rig.manager.choose(RECORDED_PROVIDER_ID, RECORDED_VISION_TOOL_MODEL);
    expect(rig.manager.source()).toBeNull();

    await rig.manager.saveKey(GOOD_KEY);
    expect(rig.manager.status().state).toBe('configured-unverified');
    expect(rig.manager.source()).toBeNull();

    await rig.manager.verify();
    expect(rig.manager.source()).not.toBeNull();

    await rig.manager.forgetKey();
    expect(rig.manager.status().state).toBe('unconfigured');
    expect(rig.manager.source()).toBeNull();
  });

  it('a relaunch restores the selection but not the verification', async () => {
    const rig = await configured();
    await rig.manager.verify();
    const stored = await rig.profileStorage.read();
    expect(stored).toBeDefined();

    // A second process over the same two files: the profile and the sealed key
    // are both on disk, and neither is a probe.
    const recorded = createRecordedApiKeyProvider({ acceptedKey: GOOD_KEY });
    const relaunched = createApiKeyProfileManager({
      bundle: createApiKeyModels({
        cipher: createAesGcmCipher(generateSecretKey()),
        secretStorage: createMemorySecretStorage(),
        providers: [recorded.provider],
      }),
      profileStorage: createMemoryProfileStorage(stored),
    });
    const status = await relaunched.refresh();
    expect(status.providerId).toBe(RECORDED_PROVIDER_ID);
    expect(status.modelId).toBe(RECORDED_VISION_TOOL_MODEL);
    // No credential in the fresh (empty) secret storage, so: unconfigured.
    expect(status.state).toBe('unconfigured');
    expect(relaunched.source()).toBeNull();
    expect(recorded.state.requests).toBe(0);
  });

  it('a stored profile with a stored key comes back unverified, not verified', async () => {
    const secretStorage = createMemorySecretStorage();
    const profileStorage = createMemoryProfileStorage();
    const key = generateSecretKey();
    const first = createApiKeyProfileManager({
      bundle: createApiKeyModels({
        cipher: createAesGcmCipher(key),
        secretStorage,
        providers: [createRecordedApiKeyProvider({ acceptedKey: GOOD_KEY }).provider],
      }),
      profileStorage,
    });
    await first.choose(RECORDED_PROVIDER_ID, RECORDED_VISION_TOOL_MODEL);
    await first.saveKey(GOOD_KEY);
    expect((await first.verify()).state).toBe('verified');

    const recorded = createRecordedApiKeyProvider({ acceptedKey: GOOD_KEY });
    const second = createApiKeyProfileManager({
      bundle: createApiKeyModels({
        cipher: createAesGcmCipher(key),
        secretStorage,
        providers: [recorded.provider],
      }),
      profileStorage,
    });
    const status = await second.refresh();
    expect(status.credential.configured).toBe(true);
    expect(status.state).toBe('configured-unverified');
    expect(second.source()).toBeNull();
    expect(recorded.state.requests).toBe(0);

    expect((await second.verify()).state).toBe('verified');
    expect(second.source()).not.toBeNull();
  });

  it('never writes a secret into the profile store', async () => {
    const rig = await configured();
    await rig.manager.verify();
    const serialized = (await rig.profileStorage.read()) ?? '';
    expect(serialized).not.toContain(GOOD_KEY);
    expect(serialized).toContain('"credentialRef": "recorded-vendor"');
    expect(serialized).toContain('"toolSupport": "verified"');
  });
});

/* -------------------------------------------------------------------------- *
 * Remote-data labelling
 * -------------------------------------------------------------------------- */

describe('remote-data labelling', () => {
  it('says where the screen goes, before any observation', async () => {
    const rig = await configured();
    const status = await rig.manager.verify();
    const disclosure = status.disclosure;

    expect(disclosure).toMatchObject({
      sendsScreenOffDevice: true,
      destination: 'api.recorded-vendor.example',
      authMode: 'api-key',
      verification: 'verified',
      needsAttention: true,
    });
    expect(disclosure?.headline).toBe('Screen images are sent to api.recorded-vendor.example');
    expect(disclosure?.detail).toContain('leave this Mac');
    expect(disclosure?.detail).toContain('your API key');
    expect(disclosure?.credentialSummary).toContain('the macOS Keychain');
    expect(JSON.stringify(disclosure)).not.toContain(GOOD_KEY);
  });

  it('is the contrast case PR-039 needs: a loopback endpoint reads the other way', () => {
    const disclosure = describeModelDataDisclosure({
      profile: {
        id: 'profile-local' as never,
        provider: 'local',
        model: 'qwen2.5-vl-7b',
        authMode: 'local',
        baseUrl: 'http://localhost:11434/v1',
        supportsVision: true,
        supportsTools: true,
        isRemote: false,
      },
      verification: 'verified',
    });
    expect(disclosure.sendsScreenOffDevice).toBe(false);
    expect(disclosure.headline).toContain('stay on this Mac');
    expect(disclosure.needsAttention).toBe(false);
    expect(disclosure.credentialSummary).toBeNull();
  });

  it('an unverified profile is labelled unverified, and says so loudly', async () => {
    const rig = await configured();
    const status = rig.manager.status();
    expect(status.disclosure?.verification).toBe('unverified');
    expect(status.disclosure?.detail).toContain('has not yet confirmed');
    expect(status.disclosure?.needsAttention).toBe(true);
  });

  it('a rejected model is labelled rejected, and says nothing was sent', async () => {
    const rig = await configured(RECORDED_TEXT_MODEL);
    const status = await rig.manager.verify();
    expect(status.disclosure?.verification).toBe('rejected');
    expect(status.disclosure?.detail).toContain('nothing has been sent');
  });
});

/* -------------------------------------------------------------------------- *
 * The provider-neutral source, and the leak surfaces
 * -------------------------------------------------------------------------- */

describe('the source everything downstream consumes', () => {
  it('is a `ModelSource`: profile, models, model, toolSupport, requestCount, description', async () => {
    const rig = await configured();
    await rig.manager.verify();
    const source = rig.manager.source();
    expect(source).not.toBeNull();
    expect(Object.keys(source ?? {}).sort()).toEqual([
      'credential',
      'description',
      'disclosure',
      'model',
      'models',
      'probe',
      'profile',
      'requestCount',
      'toolSupport',
    ]);
    // The probe's one request is counted: this is a running total for the
    // profile, not a per-call counter.
    expect(source?.requestCount()).toBe(1);
    expect(source?.model.contextWindow).toBe(200_000);
  });

  it('describes itself without a secret and without screen text', async () => {
    const rig = await configured();
    await rig.manager.verify();
    const source = rig.manager.source();
    expect(source?.description).toContain('REMOTE');
    expect(source?.description).toContain('api.recorded-vendor.example');
    expect(source?.description).toContain('the macOS Keychain');
    expect(source?.description).not.toContain(GOOD_KEY);
  });

  it('keeps the key out of every renderer-bound and log-bound surface', async () => {
    const rig = await configured(RECORDED_VISION_TOOL_MODEL, BAD_KEY);
    await rig.manager.verify();
    await rig.manager.saveKey(GOOD_KEY);
    await rig.manager.verify();
    rig.manager.noteRunFailure(invalidKeyMessage(GOOD_KEY));

    const everything = JSON.stringify({
      status: rig.manager.status(),
      source: rig.manager.source(),
      providers: rig.manager.providers(),
      models: rig.manager.modelsFor(RECORDED_PROVIDER_ID),
      logs: rig.sink.records,
      medium: rig.secretStorage.text,
      profiles: await rig.profileStorage.read(),
      inventory: await rig.manager.credentials.inventory(),
      credentialStatus: await rig.manager.auth.status(RECORDED_PROVIDER_ID),
      statuses: await rig.manager.auth.statuses(),
    });
    expect(everything).not.toContain(GOOD_KEY);
    expect(everything).not.toContain(BAD_KEY);
    // …and not a fragment of either.
    expect(everything).not.toContain('sk-recorded-GOOD');
    expect(everything).not.toContain('sk-recorded-WRONG');
  });

  it('keeps the key out of a thrown stack and a crash-log-shaped dump', async () => {
    const rig = await configured(RECORDED_VISION_TOOL_MODEL, BAD_KEY);
    const status = await rig.manager.verify();
    const failure = status.failure;
    expect(failure).not.toBeNull();

    // What a crash reporter serialises: the error, its stack, its cause chain.
    const thrown = new Error(failure?.message ?? '');
    const dump = JSON.stringify({
      message: thrown.message,
      stack: thrown.stack,
      serialized: failure,
      inspected: String(thrown),
    });
    expect(dump).not.toContain(BAD_KEY);
  });

  it('the probe’s own evidence lines are safe to print', async () => {
    const rig = await configured(RECORDED_VISION_TOOL_MODEL, BAD_KEY);
    const status = await rig.manager.verify();
    const evidence = (status.probe?.evidence ?? []).join('\n');
    expect(evidence).not.toContain(BAD_KEY);
    expect(evidence).toContain('vision: yes');
    expect(evidence).toContain('auth: configured');
  });
});

describe('listApiKeyProviders / listApiKeyModels as free functions', () => {
  it('read Pi’s live catalogue rather than a hard-coded table', () => {
    const recorded = createRecordedApiKeyProvider({ acceptedKey: GOOD_KEY });
    const { models } = createApiKeyModels({
      cipher: createAesGcmCipher(generateSecretKey()),
      providers: [recorded.provider],
    });
    expect(listApiKeyProviders(models).map((entry) => entry.providerId)).toEqual([
      RECORDED_PROVIDER_ID,
    ]);
    expect(listApiKeyModels(models, RECORDED_PROVIDER_ID)).toHaveLength(3);
    expect(listApiKeyModels(models, 'not-registered')).toEqual([]);
  });
});
