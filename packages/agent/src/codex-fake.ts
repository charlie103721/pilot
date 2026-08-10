import {
  InMemoryCredentialStore,
  createFauxCore,
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type Api,
  type Context,
  type CredentialStore,
  type Model,
  type MutableModels,
  type OAuthAuth,
  type OAuthCredential,
  type Provider,
  type ProviderAuthInteraction,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import type { Logger } from '@pilot/shared';
import {
  CODEX_BROWSER_CALLBACK_PORT,
  CODEX_BROWSER_METHOD,
  CODEX_DEVICE_CODE_METHOD,
  CODEX_DEVICE_VERIFICATION_URI,
  CODEX_OAUTH_DISPLAY_NAME,
  CODEX_PROVIDER_ID,
} from './codex-auth.js';
import { createCodexModelSource, type CodexModelSource } from './codex-profile.js';
import type { ScriptedStep } from './development-model.js';

/**
 * The recorded Codex auth surface (PR-037).
 *
 * **There is no ChatGPT account in this environment and no sign-in has ever
 * happened** (`docs/handoff.md` §2). Everything Pilot does with a Codex
 * credential is therefore verified against this: a Pi `Provider` registered
 * under the **real provider id**, carrying the **real model catalogue** from
 * the pinned package, whose OAuth implementation reproduces — step for step,
 * from `pi-ai/dist/auth/oauth/openai-codex.js` — what the real one asks and
 * emits, and whose streaming is Pi's own faux core.
 *
 * ## What that makes real
 *
 * Everything above the network. `Models.login` runs, the credential is written
 * through a real `CredentialStore`, `Models.checkAuth` reads it back,
 * `Models.getAuth` performs Pi's own double-checked expiry test and calls
 * `refresh` under the store lock, `toAuth` turns the credential into the
 * request's api key, and `PiAgentSession` streams through all of it. The
 * capability gate reads the **real** `Model.input` from the **real** catalogue,
 * so `gpt-5.3-codex-spark` really is text-only here.
 *
 * ## What it cannot make real
 *
 * The network. No `https://auth.openai.com` request is made, no user code is
 * ever approved by a person, no `chatgpt.com/backend-api` request is made, and
 * the access token below is a fixture string. What a real sign-in does that
 * this cannot: prove that the device-code endpoint accepts Pi's client id, that
 * a real access token carries the `chatgpt_account_id` claim login requires,
 * and that the Responses API accepts Pilot's images and tool definitions.
 *
 * ## Recorded, not invented
 *
 * The prompts and events below are copied from the pinned implementation:
 *
 *  - a `select` prompt, message "Select OpenAI Codex login method:", options
 *    `browser` ("Browser login (default)") and `device_code`
 *    ("Device code login (headless)");
 *  - for `device_code`: one `device_code` event with a user code,
 *    {@link CODEX_DEVICE_VERIFICATION_URI}, an interval and a 15-minute expiry;
 *  - for `browser`: the local callback server is started on port
 *    {@link CODEX_BROWSER_CALLBACK_PORT} **before** the `auth_url` event and
 *    before the `manual_code` prompt — which is why {@link browserServerBound}
 *    exists, and why a driver that never chooses `browser` is the only defence
 *    that runs early enough.
 */

/** A fixture access token. Long, distinctive, and greppable. */
export const FAKE_CODEX_ACCESS_TOKEN_PREFIX = 'fake-codex-access-token';
/** A fixture refresh token. Must never appear in a log, a view state or a database. */
export const FAKE_CODEX_REFRESH_TOKEN_PREFIX = 'fake-codex-refresh-token';

/** One hour, which is roughly what the real endpoint issues. */
export const FAKE_CODEX_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export interface FakeCodexLogin {
  /** The option id the driver chose. */
  readonly method: string;
  /** True when the browser flow's local callback server was started. */
  readonly boundCallbackPort: boolean;
}

export interface FakeCodexAuthSurface {
  readonly provider: Provider;
  readonly models: MutableModels;
  readonly credentials: CredentialStore;
  /** Every login attempt, oldest first. */
  readonly logins: readonly FakeCodexLogin[];
  /**
   * Every access **and** refresh token this surface has ever issued, oldest
   * first. Both, because the leak scan has to watch both — a refresh token is
   * the more valuable of the two.
   */
  readonly issuedTokens: readonly string[];
  /** True once anything has caused port {@link CODEX_BROWSER_CALLBACK_PORT} to be bound. */
  browserServerBound(): boolean;
  /** How many times Pi has asked for a token rotation. */
  refreshCount(): number;
  /** Rewrites the stored credential's expiry. Negative values put it in the past. */
  expireIn(milliseconds: number): Promise<void>;
  /** The next `refresh` rejects the way the real endpoint does for a revoked grant. */
  failNextRefresh(reason?: string): void;
  /** Approves the device code after this many notifications. Default 0 (immediately). */
  approveAfter(pending: number): void;
}

interface FakeCodexOptions {
  readonly now?: () => number;
  readonly tokenLifetimeMs?: number;
  readonly logger?: Logger;
}

/**
 * Distinguishes surfaces built in the same process.
 *
 * Without it two surfaces issue the *same* fixture strings, and a leak scan
 * that watches a set of tokens silently collapses to watching one — which is
 * the shape of hole a privacy check must not have.
 */
let surfaces = 0;

function issueCredential(
  surface: number,
  serial: number,
  now: number,
  lifetimeMs: number,
): OAuthCredential & { readonly accountId: string } {
  return {
    type: 'oauth',
    access: `${FAKE_CODEX_ACCESS_TOKEN_PREFIX}-s${String(surface)}-${String(serial)}`,
    refresh: `${FAKE_CODEX_REFRESH_TOKEN_PREFIX}-s${String(surface)}-${String(serial)}`,
    expires: now + lifetimeMs,
    // Pi's real flow decodes this from the access token's JWT claim and fails
    // login without it, so the fixture carries one too. Nothing in Pilot reads
    // it — see the note in `codex-auth.ts` about why.
    accountId: 'acct_fake_codex',
  };
}

/** Builds the recorded auth surface. No network, no credential, no timers. */
export function createFakeCodexAuthSurface(
  options: FakeCodexOptions & {
    readonly credentials?: CredentialStore;
    readonly tokensPerSecond?: number;
  } = {},
): FakeCodexAuthSurface & { readonly core: ReturnType<typeof createFauxCore> } {
  const now = options.now ?? Date.now;
  const lifetimeMs = options.tokenLifetimeMs ?? FAKE_CODEX_TOKEN_LIFETIME_MS;
  const credentials = options.credentials ?? new InMemoryCredentialStore();
  const logins: FakeCodexLogin[] = [];
  const issuedTokens: string[] = [];
  let bound = false;
  let refreshes = 0;
  let serial = 0;
  const surface = (surfaces += 1);
  let failNext: string | null = null;
  let pendingApprovals = 0;

  // The real catalogue, from the pinned package. Not a hand-written copy: the
  // capability gate reads `Model.input` off these objects.
  const catalogue = openaiCodexProvider().getModels() as readonly Model<Api>[];

  const core = createFauxCore({
    api: 'openai-codex-responses',
    provider: CODEX_PROVIDER_ID,
    models: catalogue.map((model) => ({
      id: model.id,
      name: model.name,
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
  });

  const oauth: OAuthAuth = {
    name: CODEX_OAUTH_DISPLAY_NAME,
    isSubscription: true,
    async login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
      const method = await interaction.prompt({
        type: 'select',
        message: 'Select OpenAI Codex login method:',
        options: [
          { id: CODEX_BROWSER_METHOD, label: 'Browser login (default)' },
          { id: CODEX_DEVICE_CODE_METHOD, label: 'Device code login (headless)' },
        ],
      });
      if (method === CODEX_BROWSER_METHOD) {
        // Recorded order: the server binds first, then the url is announced,
        // then the manual prompt races the callback. A refusal that arrives at
        // `auth_url` is already too late, and this is where that is true.
        bound = true;
        logins.push({ method, boundCallbackPort: true });
        interaction.notify({
          type: 'auth_url',
          url: 'https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann',
          instructions: 'A browser window should open. Complete login to finish.',
        });
        await interaction.prompt({
          type: 'manual_code',
          message:
            'Complete login in your browser, or paste the authorization code / redirect URL here:',
          placeholder: `http://localhost:${String(CODEX_BROWSER_CALLBACK_PORT)}/auth/callback`,
        });
        throw new Error('fake surface: the browser flow was not completed');
      }
      if (method !== CODEX_DEVICE_CODE_METHOD) {
        throw new Error(`Unknown OpenAI Codex login method: ${method}`);
      }
      logins.push({ method, boundCallbackPort: false });
      interaction.notify({
        type: 'device_code',
        userCode: 'PILOT-TEST',
        verificationUri: CODEX_DEVICE_VERIFICATION_URI,
        intervalSeconds: 5,
        expiresInSeconds: 15 * 60,
      });
      for (let attempt = 0; attempt < pendingApprovals; attempt += 1) {
        interaction.notify({ type: 'progress', message: 'Waiting for approval…' });
      }
      serial += 1;
      const credential = issueCredential(surface, serial, now(), lifetimeMs);
      issuedTokens.push(credential.access, credential.refresh);
      return credential;
    },
    async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
      refreshes += 1;
      if (failNext !== null) {
        const reason = failNext;
        failNext = null;
        // Shape copied from the real implementation, which surfaces the token
        // endpoint's body: `OpenAI Codex token refresh failed (400): {...}`.
        throw new Error(`OpenAI Codex token refresh failed (400): ${reason}`);
      }
      if (typeof credential.refresh !== 'string' || credential.refresh === '') {
        throw new Error('OpenAI Codex token refresh failed (400): missing refresh token');
      }
      serial += 1;
      const rotated = issueCredential(surface, serial, now(), lifetimeMs);
      issuedTokens.push(rotated.access, rotated.refresh);
      return rotated;
    },
    async toAuth(credential: OAuthCredential) {
      // Exactly the real implementation: the access token is sent as the key.
      return { apiKey: credential.access };
    },
  };

  const provider = createProvider({
    id: CODEX_PROVIDER_ID,
    name: 'OpenAI Codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    auth: { oauth },
    models: catalogue,
    api: { stream: core.stream, streamSimple: core.streamSimple },
  });

  const models = createModels({ credentials });
  models.setProvider(provider);

  return {
    provider,
    models,
    credentials,
    logins,
    issuedTokens,
    core,
    browserServerBound: () => bound,
    refreshCount: () => refreshes,
    async expireIn(milliseconds: number): Promise<void> {
      await credentials.modify(CODEX_PROVIDER_ID, async (current) => {
        if (current?.type !== 'oauth') {
          return undefined;
        }
        return { ...current, expires: now() + milliseconds };
      });
    },
    failNextRefresh(reason = '{"error":"invalid_grant"}'): void {
      failNext = reason;
    },
    approveAfter(pending: number): void {
      pendingApprovals = Math.max(0, pending);
    },
  };
}

/* -------------------------------------------------------------------------- *
 * A Codex `ModelSource` over the recorded surface
 * -------------------------------------------------------------------------- */

export interface FakeCodexModelSource extends CodexModelSource {
  readonly surface: FakeCodexAuthSurface;
  /** JSON of the messages each provider request carried, oldest first. */
  readonly requests: readonly string[];
  /** Queue the model's replies. Same contract as `createScriptedModelSource`. */
  setScript(steps: readonly ScriptedStep[]): void;
}

/**
 * The whole Codex profile, over the recorded surface.
 *
 * This is the object the demo and the desktop tests drive, and it is the *same
 * construction* the app performs: `createCodexModelSource` is called with a
 * `Models` that already carries an `openai-codex` provider, so the profile, the
 * capability decision, the auth controller and the guarded/counting `Models` are
 * the shipping ones. Only the provider behind them is recorded.
 */
export function createFakeCodexModelSource(
  options: FakeCodexOptions & {
    readonly credentials?: CredentialStore;
    readonly tokensPerSecond?: number;
    readonly model?: string;
    readonly script?: readonly ScriptedStep[];
  } = {},
): FakeCodexModelSource {
  const surface = createFakeCodexAuthSurface(options);
  const requests: string[] = [];

  const setScript = (steps: readonly ScriptedStep[]): void => {
    surface.core.setResponses(
      steps.map((step) => (context: Context) => {
        // Tools carry functions, so only the messages can be serialized.
        requests.push(JSON.stringify(context.messages));
        return 'say' in step
          ? fauxAssistantMessage(step.say, { stopReason: 'stop' })
          : fauxAssistantMessage([fauxToolCall('observe_screen', step.observe)], {
              stopReason: 'toolUse',
            });
      }),
    );
  };
  setScript(options.script ?? []);

  const source = createCodexModelSource({
    models: surface.models,
    credentials: surface.credentials,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  return {
    ...source,
    // `description` is a getter on the source; spreading would freeze it at the
    // auth state it had at construction, which is the one thing this profile
    // must never do.
    get description(): string {
      return source.description;
    },
    surface,
    requests,
    setScript,
  };
}
