import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nullLogger, toPilotError, type Logger } from '@pilot/shared';
import {
  RECORDED_PROVIDER_ID,
  createApiKeyModels,
  createApiKeyProfileManager,
  createRecordedApiKeyProvider,
  createUnavailableCipher,
  describeDisclosureLine,
  rankApiKeyModels,
  type ApiKeyModelSource,
  type ApiKeyProfileManager,
  type ApiKeyProfileStatus,
  type ApiKeyProvider,
  type ModelDataDisclosure,
  type ProfileStorage,
  type SecretCipher,
  type SecretStorage,
} from '@pilot/agent';

/**
 * The API-key profile, wired into the application (PR-038).
 *
 * ## Where this sits
 *
 * `main/index.ts` had exactly one line naming a model — PR-029's
 * `createDevelopmentModelSource()`, which is Pi's faux provider (runbook
 * follow-up 22: "everything downstream consumes that interface and nothing
 * else, so a real provider is one call site"). This module is what goes in
 * front of that call site: when an API-key profile is configured **and a
 * capability probe has verified it**, its `ModelSource` is used; in every other
 * case the development source stands and the reason is logged.
 *
 * The fallback is not politeness. `ApiKeyProfileManager.source()` returns
 * `null` for every state but `verified`, so there is no path on which Pilot
 * answers a screen question through a model it has not probed — which is the
 * "configured but not verified must not look like working" rule stated as
 * control flow rather than as a comment.
 *
 * ## Configuration, and why it is environment variables in this PR
 *
 * MVP 01 has no settings window; the panel is a conversation surface. So the
 * profile is configured the same way every other fixture in this app is
 * (`PILOT_MODEL_FIXTURE`, `PILOT_PERMISSION_FIXTURE`, `PILOT_HELPER_STUB`) —
 * through the environment, once — and then it **persists**: the key is sealed
 * into {@link CREDENTIAL_FILE} and the verified profile into
 * {@link PROFILE_FILE}, so the second launch needs no environment at all. A
 * settings UI later calls the same {@link ApiKeyProfileManager} methods.
 *
 * | variable | meaning |
 * | --- | --- |
 * | `PILOT_MODEL_PROFILE` | `api-key` opts this profile in. Anything else and this module does nothing. |
 * | `PILOT_API_PROVIDER`  | Pi provider id. Defaults to the recorded rehearsal vendor. |
 * | `PILOT_API_MODEL`     | Model id. Defaults to the best-ranked vision model of that provider. |
 * | `PILOT_API_KEY`       | The key. Read **once**, sealed, and then deleted from `process.env`. |
 *
 * ## `PILOT_API_KEY` is deleted from the environment, deliberately
 *
 * This module runs in `boot()` **before** `platform.start()` spawns the native
 * helper, and a child process inherits its parent's environment. Reading the
 * key and then removing it from `process.env` means the helper — and anything
 * else Pilot ever spawns — cannot see it, and it cannot reach a crash reporter
 * that dumps the environment. It costs one line and closes a real path.
 *
 * ## What is NOT here
 *
 * No vendor SDK is registered. `@earendil-works/pi-ai` ships 38 built-in
 * providers behind `loadBuiltinApiKeyProviders()`, and calling it from this
 * file was measured: `dist/main/index.js` went from **1.66 MB to 5.97 MB**,
 * because `electron.vite.config.ts` inlines everything the main process
 * reaches. Which vendors a shipped Pilot carries is a packaging decision with a
 * real cost, so it is left to PR-042 and to
 * {@link ApiKeyRuntimeOptions.providers}. `docs/handoff.md` §1 step 17 is the
 * check that needs a real one.
 */

/** Subdirectory under Electron's `userData`, beside `conversations/`. */
export const MODEL_PROFILE_DIRECTORY = 'model-profile';
/** Sealed credential. Ciphertext only; see `@pilot/agent`'s credential store. */
export const CREDENTIAL_FILE = 'credentials.json';
/** The selected profile. Plain JSON, and asserted to hold no secret (PR-020). */
export const PROFILE_FILE = 'profiles.json';

export const API_KEY_ENV = {
  profile: 'PILOT_MODEL_PROFILE',
  provider: 'PILOT_API_PROVIDER',
  model: 'PILOT_API_MODEL',
  key: 'PILOT_API_KEY',
} as const;

/** The value of `PILOT_MODEL_PROFILE` that turns this profile on. */
export const API_KEY_PROFILE_NAME = 'api-key';

export function modelProfileDirectory(userDataPath: string): string {
  return join(userDataPath, MODEL_PROFILE_DIRECTORY);
}

/* -------------------------------------------------------------------------- *
 * File-backed seams
 * -------------------------------------------------------------------------- */

/**
 * A text file, created with owner-only permissions.
 *
 * `mode: 0o600` matters for the sealed credential and costs nothing for the
 * profile: encryption protects the contents from another *user*, and the mode
 * protects it from another *process running as this user* reading it out of a
 * backup or a synced folder. Neither is sufficient alone.
 */
function createFileTextStorage(path: string): SecretStorage & ProfileStorage {
  return {
    async read(): Promise<string | undefined> {
      try {
        return await readFile(path, 'utf8');
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw cause;
      }
    },
    async write(text: string): Promise<void> {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, text, { encoding: 'utf8', mode: 0o600 });
    },
    async remove(): Promise<void> {
      await rm(path, { force: true });
    },
  };
}

/* -------------------------------------------------------------------------- *
 * The runtime
 * -------------------------------------------------------------------------- */

export interface ApiKeyRuntime {
  /**
   * The verified model, or `null`. `null` is the ordinary case: no profile
   * configured, no key, or a probe that refused.
   */
  readonly source: ApiKeyModelSource | null;
  /** `null` when the profile is not opted in at all. */
  readonly manager: ApiKeyProfileManager | null;
  readonly status: ApiKeyProfileStatus | null;
  /** What the panel shows before an observation (§14). `null` when nothing is chosen. */
  readonly disclosure: ModelDataDisclosure | null;
  /** One sentence saying why there is no source. Empty when there is one. */
  readonly reason: string;
  readonly directory: string;
}

export interface ApiKeyRuntimeOptions {
  /** Electron's `userData`. The profile directory is created under it. */
  readonly userDataPath: string;
  /**
   * Encrypts the credential. `main/index.ts` passes the `safeStorage`-backed
   * one; omitting it means nothing can be stored and the runtime says so
   * rather than writing plaintext.
   */
  readonly cipher?: SecretCipher;
  /** Providers to register. See the note about vendor SDKs above. */
  readonly providers?: readonly ApiKeyProvider[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Deletes `PILOT_API_KEY` after reading it. Defaults to `process.env`. */
  readonly mutableEnv?: Record<string, string | undefined>;
  readonly logger?: Logger;
}

function idle(directory: string, reason: string): ApiKeyRuntime {
  return { source: null, manager: null, status: null, disclosure: null, reason, directory };
}

/**
 * Opens the API-key profile.
 *
 * Total, like `openConversationStoreRuntime`: every failure becomes a runtime
 * with `source: null` and a reason, because a model profile that cannot be set
 * up must not stop Pilot from starting — the development source still answers,
 * and the panel still says what happened.
 */
export async function openApiKeyProfileRuntime(
  options: ApiKeyRuntimeOptions,
): Promise<ApiKeyRuntime> {
  const logger = (options.logger ?? nullLogger).child('api-key-profile');
  const env = options.env ?? process.env;
  const directory = modelProfileDirectory(options.userDataPath);

  if (env[API_KEY_ENV.profile] !== API_KEY_PROFILE_NAME) {
    return idle(
      directory,
      `not selected (${API_KEY_ENV.profile} is not "${API_KEY_PROFILE_NAME}")`,
    );
  }

  try {
    const providerId = env[API_KEY_ENV.provider] ?? RECORDED_PROVIDER_ID;
    const providers = resolveProviders(providerId, options, env);
    const cipher =
      options.cipher ??
      createUnavailableCipher('no secure-storage cipher was supplied to this build');

    const bundle = createApiKeyModels({
      cipher,
      secretStorage: createFileTextStorage(join(directory, CREDENTIAL_FILE)),
      providers,
    });
    const manager = createApiKeyProfileManager({
      bundle,
      profileStorage: createFileTextStorage(join(directory, PROFILE_FILE)),
      storageName: cipher.available ? cipher.name : 'nowhere (secure storage unavailable)',
      logger,
    });

    // 1. Whatever a previous launch persisted.
    await manager.refresh();

    // 2. The selection. Explicit model, or the best-ranked vision candidate —
    //    ranked, never hard-coded: the probe still decides (Phase 4 preamble).
    const modelId =
      env[API_KEY_ENV.model] ?? rankApiKeyModels(manager.modelsFor(providerId))[0]?.modelId;
    if (modelId === undefined) {
      return idle(
        directory,
        `provider "${providerId}" lists no model that accepts images; nothing to probe`,
      );
    }
    await manager.choose(providerId, modelId);

    // 3. The key, if this launch was given one. Read once, then removed from
    //    the environment so the native helper cannot inherit it.
    const key = env[API_KEY_ENV.key];
    if (key !== undefined && key !== '') {
      const mutable = options.mutableEnv ?? process.env;
      delete mutable[API_KEY_ENV.key];
      await manager.saveKey(key);
    }

    // 4. The probe. One text-only request at most; never an image.
    const status = await manager.verify();
    const source = manager.source();

    logger.info('api-key profile', {
      state: status.state,
      provider: status.providerId,
      model: status.modelId,
      cipher: cipher.name,
      secureStorage: cipher.available,
      // NOTE THE FIELD NAMES. `@pilot/shared`'s redactor replaces the value of
      // any key matching /credential/ or /image/, so `credential:` and
      // `probeImages:` both came out as markers and the line said nothing.
      // These two numbers are the evidence for the Phase 4 gate; they have to
      // survive. (Same trap as `main/conversation-store.ts`'s `restored`.)
      configured: status.credential.configured,
      probeRequests: status.probe?.providerRequests ?? 0,
      probeScreenDataSent: status.probe?.imageBlocksSent ?? 0,
      disclosure: status.disclosure === null ? null : describeDisclosureLine(status.disclosure),
    });

    return {
      source,
      manager,
      status,
      disclosure: status.disclosure,
      reason: source === null ? `${status.state}: ${status.remedy}` : '',
      directory,
    };
  } catch (cause) {
    const error = toPilotError(cause);
    logger.warn('the API-key profile could not be opened; falling back', {
      code: error.code,
      // `PilotError.message` from this lane is already scrubbed; anything else
      // here comes from the filesystem and cannot contain a credential.
      reason: error.message,
    });
    return idle(directory, `${error.code}: ${error.message}`);
  }
}

/**
 * Which providers this build can offer.
 *
 * The recorded vendor is always available and always says what it is — it is
 * the rehearsal surface every test and the demo run against, and it makes the
 * whole path exercisable on a machine with no key.
 *
 * **Real vendors come from {@link ApiKeyRuntimeOptions.providers}, and nothing
 * here calls `loadBuiltinApiKeyProviders()`. MEASURED, not assumed:** wiring
 * that call into this file took `dist/main/index.js` from **1.66 MB to
 * 5.97 MB**, because `electron.vite.config.ts` sets
 * `inlineDynamicImports: true` and `ssr.noExternal: true`, so Pi's 38 built-in
 * providers drag the Anthropic, OpenAI, Google, Mistral and Bedrock SDKs into
 * the bundle whether or not anyone uses them. Which vendors a shipped Pilot
 * carries is a packaging decision with a real cost, and it belongs to PR-042;
 * `loadBuiltinApiKeyProviders` stays exported from `@pilot/agent` so that PR
 * has one call to make. See `docs/runbook.md` §8 and `docs/handoff.md` §1
 * step 17.
 */
// Async although nothing here awaits: a caller supplying real vendors through
// `options.providers` will have loaded them with a dynamic import, and the seam
// should not have to change shape when it does.
function resolveProviders(
  providerId: string,
  options: ApiKeyRuntimeOptions,
  env: Readonly<Record<string, string | undefined>>,
): readonly ApiKeyProvider[] {
  const supplied = options.providers ?? [];
  const providers: ApiKeyProvider[] = [...supplied];

  if (
    providerId === RECORDED_PROVIDER_ID &&
    !providers.some((provider) => provider.id === RECORDED_PROVIDER_ID)
  ) {
    // A key nobody has: the recorded vendor accepts exactly what the user
    // supplies, so the rehearsal always "works" and never talks to anything.
    providers.push(
      createRecordedApiKeyProvider({ acceptedKey: env[API_KEY_ENV.key] ?? 'rehearsal-key' })
        .provider,
    );
  }

  return providers;
}
