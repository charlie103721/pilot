import { PilotError, type Logger, nullLogger, type SerializedPilotError } from '@pilot/shared';
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialStore,
  Models,
} from '@earendil-works/pi-ai';
import type { CredentialStatus } from './auth-facade.js';

/**
 * Codex subscription auth (PR-037).
 *
 * Everything in this file is Codex-specific by design: `docs/runbook.md`
 * amendment 7 records that Pilot's model access is a ChatGPT subscription, and
 * `docs/pi-notes.md` §9.1 records exactly how Pi 0.84.1 implements it. The
 * provider-neutral seams — `ModelSource`, `AuthFacade`, `CredentialStatus` —
 * are PR-020's and PR-029's and are used unchanged; nothing here widens them.
 *
 * THE ONE CONSTRAINT THAT SHAPES THIS WHOLE MODULE
 * ------------------------------------------------
 * **Device code, never browser.** Pi offers both, through a `select` prompt
 * with the option ids `browser` and `device_code`
 * (`pi-ai/dist/auth/oauth/openai-codex.js`). The browser flow:
 *
 *  - binds `127.0.0.1:{@link CODEX_BROWSER_CALLBACK_PORT}` *before* it emits its
 *    `auth_url` event, so by the time an application could notice the flow it
 *    has already taken the port;
 *  - does **not** open a browser — it expects the application to; and
 *  - races a `manual_code` prompt against the callback server, so a driver that
 *    cannot answer prompts wedges until the login is aborted.
 *
 * The device-code flow is headless: it emits one `device_code` event carrying a
 * user code and {@link CODEX_DEVICE_VERIFICATION_URI}, then polls. That is the
 * only flow that works for a user signing in on their own Mac from inside a
 * packaged app, and it is the only one {@link createCodexDeviceCodeInteraction}
 * will consent to. Refusing at the `select` prompt is load-bearing rather than
 * decorative: it is the *only* moment at which the browser flow can still be
 * declined without the port already being bound.
 *
 * NO CREDENTIAL MATERIAL LEAVES THIS MODULE
 * -----------------------------------------
 * {@link CodexAuthStatus} is booleans, enums, timestamps and curated sentences.
 * There is no field on it that can hold a token, and — deliberately — no field
 * that can hold the `accountId` either. Pi decodes `accountId` from the access
 * token's JWT claim and login fails without it, so it is derived from secret
 * material; it identifies the user's ChatGPT account and it buys the UI
 * nothing, so it is never read here. Secret material lives only inside Pi's
 * `CredentialStore` and inside `ProviderCredential`'s `#private` field
 * (`auth-facade.ts`).
 */

/** Pi's provider id for the ChatGPT subscription endpoint. */
export const CODEX_PROVIDER_ID = 'openai-codex';

/** Pi's display name for the OAuth method. Asserted against the real provider. */
export const CODEX_OAUTH_DISPLAY_NAME = 'OpenAI (ChatGPT Plus/Pro)';

/** The `select` option id for the headless flow. The only one Pilot answers. */
export const CODEX_DEVICE_CODE_METHOD = 'device_code';

/** The `select` option id for the flow Pilot refuses. */
export const CODEX_BROWSER_METHOD = 'browser';

/**
 * The port Pi's browser login binds on `127.0.0.1`. Named here so the refusal
 * has a number in it and so a test can assert nothing ever listened on it.
 */
export const CODEX_BROWSER_CALLBACK_PORT = 1455;

/** Where the user types the code. Pi emits this in its `device_code` event. */
export const CODEX_DEVICE_VERIFICATION_URI = 'https://auth.openai.com/codex/device';

/**
 * Pi refreshes an OAuth credential that has less than this left, under the
 * credential-store lock (`pi-ai/dist/auth/resolve.js`,
 * `DEFAULT_OAUTH_MINIMUM_VALIDITY_MS`). Pilot does not refresh anything itself;
 * it only has to *report* the same boundary, so the status a user reads and the
 * behaviour they get agree.
 */
export const CODEX_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * How Pilot describes the credential's position in its lifecycle.
 *
 * `refresh-due` is not a problem and is not shown as one: Pi rotates the token
 * on the next request. It exists because "signed in, valid for another four
 * minutes" and "signed in, valid for another eleven hours" are different facts
 * and a diagnostics surface that cannot tell them apart cannot explain a
 * refresh failure when one happens.
 */
export type CodexAuthState = 'signed-out' | 'active' | 'refresh-due' | 'expired';

/**
 * Renderer-safe Codex auth status.
 *
 * Structurally a superset of {@link CredentialStatus}, so anything that already
 * consumes the provider-neutral shape keeps working. Every added field is a
 * boolean, a number or a sentence this module wrote.
 */
export interface CodexAuthStatus extends CredentialStatus {
  readonly state: CodexAuthState;
  /** Milliseconds until `expiresAt`, or `null` when nothing is stored. Negative once expired. */
  readonly expiresInMs: number | null;
  /** True when Pilot cannot answer a question until the user signs in again. */
  readonly signInRequired: boolean;
  /** One short line for the panel. Never contains credential material. */
  readonly label: string;
  /** What the user can do about it. Empty when there is nothing to do. */
  readonly detail: string;
}

const SIGNED_OUT_LABEL = 'Not signed in to ChatGPT';
const SIGNED_OUT_DETAIL =
  'Pilot uses your ChatGPT Plus/Pro subscription instead of an API key. Sign in to start answering questions.';

/** The status of a provider with nothing stored. */
export function signedOutCodexStatus(providerId: string = CODEX_PROVIDER_ID): CodexAuthStatus {
  return {
    providerId,
    configured: false,
    kind: null,
    source: null,
    expiresAt: null,
    isSubscription: false,
    state: 'signed-out',
    expiresInMs: null,
    signInRequired: true,
    label: SIGNED_OUT_LABEL,
    detail: SIGNED_OUT_DETAIL,
  };
}

/**
 * Projects a provider-neutral {@link CredentialStatus} onto the Codex lifecycle.
 *
 * Pure, and exported, for the same reason `resolveContextWindow` is: it is a
 * four-row table that is invisible once it is wrong.
 *
 * | stored | expiry | state | sign-in required |
 * | --- | --- | --- | --- |
 * | none | — | `signed-out` | yes |
 * | oauth | none reported | `active` | no |
 * | oauth | more than {@link CODEX_REFRESH_WINDOW_MS} away | `active` | no |
 * | oauth | inside the refresh window | `refresh-due` | no |
 * | oauth | in the past | `expired` | yes |
 */
export function describeCodexAuth(
  status: CredentialStatus,
  now: number = Date.now(),
): CodexAuthStatus {
  if (!status.configured) {
    return { ...signedOutCodexStatus(status.providerId), isSubscription: status.isSubscription };
  }
  const expiresAt = status.expiresAt;
  if (expiresAt === null) {
    return {
      ...status,
      state: 'active',
      expiresInMs: null,
      signInRequired: false,
      label: 'Signed in to ChatGPT',
      detail: 'Pilot is using your ChatGPT subscription. No API key is stored.',
    };
  }
  const expiresInMs = expiresAt - now;
  if (expiresInMs <= 0) {
    return {
      ...status,
      state: 'expired',
      expiresInMs,
      signInRequired: true,
      label: 'ChatGPT sign-in has expired',
      detail:
        'The stored sign-in can no longer be renewed automatically. Sign in again to keep asking questions.',
    };
  }
  if (expiresInMs <= CODEX_REFRESH_WINDOW_MS) {
    return {
      ...status,
      state: 'refresh-due',
      expiresInMs,
      signInRequired: false,
      label: 'Signed in to ChatGPT (renewing)',
      detail: 'The sign-in is renewed automatically on the next question. Nothing to do.',
    };
  }
  return {
    ...status,
    state: 'active',
    expiresInMs,
    signInRequired: false,
    label: 'Signed in to ChatGPT',
    detail: 'Pilot is using your ChatGPT subscription. No API key is stored.',
  };
}

/* -------------------------------------------------------------------------- *
 * Sign-in — device code only
 * -------------------------------------------------------------------------- */

/** What the user has to type, and where. Nothing here is secret material. */
export interface CodexDeviceCode {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSeconds: number | null;
  readonly expiresInSeconds: number | null;
}

/**
 * How a sign-in reports progress. Deliberately not an `AuthInteraction`: the
 * caller never gets to answer a prompt, because the only prompt Pilot answers
 * is the login-method selection and answering it any other way would be the
 * browser flow.
 */
export interface CodexSignInObserver {
  /** Called once, with the code to type at {@link CodexDeviceCode.verificationUri}. */
  deviceCode(code: CodexDeviceCode): void;
  /** Pi's own progress lines ("waiting for approval"). Optional. */
  progress?(message: string): void;
  /** Informational notices, e.g. links. Optional. */
  info?(message: string): void;
}

export function codexAuthError(
  message: string,
  options: {
    readonly userMessage: string;
    readonly reason: CodexAuthFailureReason;
    readonly retryable?: boolean;
    readonly cause?: unknown;
  },
): PilotError {
  return new PilotError('authentication-required', message, {
    userMessage: options.userMessage,
    retryable: options.retryable ?? false,
    details: { providerId: CODEX_PROVIDER_ID, reason: options.reason },
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });
}

/** Every prompt the driver saw, for the demo and for the refusal tests. */
export interface CodexInteractionLog {
  /** `select`, `manual_code`, … in the order Pi asked. */
  readonly prompts: readonly string[];
  /** Pi's own event types, in order. */
  readonly events: readonly string[];
  /** True once the driver has answered the login-method selection. */
  readonly chose: string | null;
}

export interface CodexDeviceCodeInteraction {
  readonly interaction: AuthInteraction;
  readonly log: CodexInteractionLog;
}

/**
 * Builds the `AuthInteraction` Pi's Codex login is driven with.
 *
 * Three rules, and each is a refusal rather than a preference:
 *
 *  1. The login-method `select` is answered {@link CODEX_DEVICE_CODE_METHOD},
 *     and only if Pi actually offers it. If the option disappears in a future
 *     Pi release the login fails loudly instead of silently falling back to the
 *     browser flow and binding port {@link CODEX_BROWSER_CALLBACK_PORT}.
 *  2. Every other prompt is refused. The only other prompt in the Codex flow is
 *     the browser flow's `manual_code`, and reaching it means rule 1 did not
 *     hold.
 *  3. An `auth_url` event is refused for the same reason. It is a *late*
 *     defence — Pi has already bound the port by the time it fires — so it is
 *     recorded as a defect rather than relied on.
 */
export function createCodexDeviceCodeInteraction(
  observer: CodexSignInObserver,
  options: { readonly signal?: AbortSignal } = {},
): CodexDeviceCodeInteraction {
  const prompts: string[] = [];
  const events: string[] = [];
  const log = {
    prompts,
    events,
    chose: null as string | null,
  };

  const interaction: AuthInteraction = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    async prompt(prompt: AuthPrompt): Promise<string> {
      prompts.push(prompt.type);
      if (prompt.type !== 'select') {
        throw codexAuthError(
          `Refusing Codex login prompt "${prompt.type}": Pilot only drives the device-code flow`,
          {
            reason: 'browser-flow-refused',
            userMessage:
              'Pilot could not complete the ChatGPT sign-in. Try again, and report this if it keeps happening.',
          },
        );
      }
      const offered = prompt.options.map((option) => option.id);
      if (!offered.includes(CODEX_DEVICE_CODE_METHOD)) {
        throw codexAuthError(
          `Codex login no longer offers "${CODEX_DEVICE_CODE_METHOD}" (offered: ${offered.join(', ')})`,
          {
            reason: 'device-code-unavailable',
            userMessage:
              'Pilot cannot sign in to ChatGPT with this version of its model library. Report this.',
          },
        );
      }
      log.chose = CODEX_DEVICE_CODE_METHOD;
      return CODEX_DEVICE_CODE_METHOD;
    },
    notify(event: AuthEvent): void {
      events.push(event.type);
      switch (event.type) {
        case 'device_code':
          observer.deviceCode({
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            intervalSeconds: event.intervalSeconds ?? null,
            expiresInSeconds: event.expiresInSeconds ?? null,
          });
          return;
        case 'progress':
          observer.progress?.(event.message);
          return;
        case 'info':
          observer.info?.(event.message);
          return;
        case 'auth_url':
          // Late by construction: Pi binds the callback port before it emits
          // this. Throwing still aborts the login rather than leaving a server
          // listening for a redirect nobody will make.
          throw codexAuthError(
            `Codex login started the browser flow and bound port ${String(CODEX_BROWSER_CALLBACK_PORT)}`,
            {
              reason: 'browser-flow-refused',
              userMessage:
                'Pilot could not complete the ChatGPT sign-in. Try again, and report this if it keeps happening.',
            },
          );
        default:
          return;
      }
    },
  };

  return { interaction, log: log as CodexInteractionLog };
}

export interface CodexSignInOptions {
  readonly models: Models;
  readonly observer: CodexSignInObserver;
  readonly signal?: AbortSignal;
  readonly providerId?: string;
  readonly logger?: Logger;
}

export interface CodexSignInResult {
  readonly status: CodexAuthStatus;
  readonly log: CodexInteractionLog;
}

/**
 * Runs the device-code sign-in and returns the resulting *status*.
 *
 * Never the credential: `Models.login` persists it into the `CredentialStore`
 * and returns it, and this function drops it on the floor on purpose. The one
 * thing a caller may know afterwards is what {@link describeCodexAuth} says.
 */
export async function signInToCodex(options: CodexSignInOptions): Promise<CodexSignInResult> {
  const providerId = options.providerId ?? CODEX_PROVIDER_ID;
  const logger = options.logger ?? nullLogger;
  const { interaction, log } = createCodexDeviceCodeInteraction(options.observer, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try {
    // The return value is a `Credential`. It is deliberately not bound to a
    // name: an unused variable here is one `logger.info({ credential })` away
    // from a token in a log file.
    await options.models.login(providerId, 'oauth', interaction);
  } catch (cause) {
    throw asCodexAuthError(cause, 'sign-in-failed');
  }
  const status = await readCodexAuthStatus({ models: options.models, providerId });
  logger.info('codex sign-in completed', {
    providerId,
    state: status.state,
    method: log.chose,
    // Never `expiresAt` as a date and never the account: a count of prompts and
    // events is what says the device-code flow was the one that ran.
    prompts: log.prompts.length,
    events: log.events.length,
  });
  return { status, log };
}

/* -------------------------------------------------------------------------- *
 * Status and sign-out
 * -------------------------------------------------------------------------- */

export interface ReadCodexAuthStatusOptions {
  readonly models: Models;
  readonly credentials?: CredentialStore;
  readonly providerId?: string;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

/**
 * Reads the current status without resolving, refreshing or revealing anything.
 *
 * `Models.checkAuth` is side-effect free for a stored OAuth credential — it
 * answers `{ source: "OAuth", type: "oauth" }` from the store and never calls
 * `refresh` (`pi-ai/dist/models.js`, `checkProviderAuth`). The expiry comes
 * from the stored credential directly, which is the only place it exists.
 */
export async function readCodexAuthStatus(
  options: ReadCodexAuthStatusOptions,
): Promise<CodexAuthStatus> {
  const providerId = options.providerId ?? CODEX_PROVIDER_ID;
  const now = options.now ?? Date.now;
  const operation = options.signal === undefined ? undefined : { signal: options.signal };
  const check = await options.models.checkAuth(providerId, operation);
  if (check === undefined) {
    return signedOutCodexStatus(providerId);
  }
  const stored: Credential | undefined =
    options.credentials === undefined
      ? undefined
      : await options.credentials.read(providerId, operation);
  const expiresAt =
    stored !== undefined && stored.type === 'oauth' && typeof stored.expires === 'number'
      ? stored.expires
      : null;
  const isSubscription =
    check.type === 'oauth' &&
    options.models.getProvider(providerId)?.auth.oauth?.isSubscription === true;
  return describeCodexAuth(
    {
      providerId,
      configured: true,
      kind: check.type,
      source: check.source ?? null,
      expiresAt,
      isSubscription,
    },
    now(),
  );
}

/** Forgets the stored credential. Idempotent; a signed-out provider is a no-op. */
export async function signOutOfCodex(options: {
  readonly models: Models;
  readonly providerId?: string;
  readonly signal?: AbortSignal;
}): Promise<CodexAuthStatus> {
  const providerId = options.providerId ?? CODEX_PROVIDER_ID;
  await options.models.logout(
    providerId,
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  return signedOutCodexStatus(providerId);
}

/* -------------------------------------------------------------------------- *
 * Auth-expiry recovery
 * -------------------------------------------------------------------------- */

export type CodexAuthFailureReason =
  /** Nothing is stored. The user has never signed in, or signed out. */
  | 'signed-out'
  /** A stored credential whose expiry has passed. */
  | 'expired'
  /** Pi tried to rotate the token and the provider refused (`invalid_grant`). */
  | 'refresh-failed'
  /** The credential store itself failed. Not the user's fault and not fixed by signing in. */
  | 'credential-store-failed'
  /** The login flow itself failed or was cancelled. */
  | 'sign-in-failed'
  /** Pilot declined to run the browser flow (see the module comment). */
  | 'browser-flow-refused'
  /** Pi no longer offers the device-code option. */
  | 'device-code-unavailable';

export interface CodexAuthFailure {
  readonly reason: CodexAuthFailureReason;
  /** True when signing in again is the fix. */
  readonly signInFixesIt: boolean;
  readonly error: PilotError;
}

const REFRESH_FAILED_MESSAGE =
  'Pilot’s ChatGPT sign-in could not be renewed. Sign in again to keep asking questions.';
const SIGNED_OUT_MESSAGE =
  'Pilot is not signed in to ChatGPT. Sign in to ask questions about your screen.';
const EXPIRED_MESSAGE =
  'Pilot’s ChatGPT sign-in has expired. Sign in again to keep asking questions.';
const STORE_FAILED_MESSAGE =
  'Pilot could not read its saved ChatGPT sign-in. Sign in again, and report this if it keeps happening.';

/** The user-facing sentence for each reason. Exported so the UI cannot invent its own. */
export const CODEX_AUTH_MESSAGES: Readonly<Record<CodexAuthFailureReason, string>> = {
  'signed-out': SIGNED_OUT_MESSAGE,
  expired: EXPIRED_MESSAGE,
  'refresh-failed': REFRESH_FAILED_MESSAGE,
  'credential-store-failed': STORE_FAILED_MESSAGE,
  'sign-in-failed': 'Pilot could not finish signing in to ChatGPT. Try again.',
  'browser-flow-refused':
    'Pilot could not complete the ChatGPT sign-in. Try again, and report this if it keeps happening.',
  'device-code-unavailable':
    'Pilot cannot sign in to ChatGPT with this version of its model library. Report this.',
};

const SIGN_IN_FIXES: ReadonlySet<CodexAuthFailureReason> = new Set<CodexAuthFailureReason>([
  'signed-out',
  'expired',
  'refresh-failed',
  'sign-in-failed',
]);

export function codexAuthFailure(
  reason: CodexAuthFailureReason,
  message: string,
): CodexAuthFailure {
  return {
    reason,
    signInFixesIt: SIGN_IN_FIXES.has(reason),
    error: codexAuthError(message, { reason, userMessage: CODEX_AUTH_MESSAGES[reason] }),
  };
}

function asCodexAuthError(cause: unknown, fallback: CodexAuthFailureReason): PilotError {
  const classified = classifyCodexAuthFailure(cause);
  if (classified !== null) {
    return classified.error;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return codexAuthError(message, {
    reason: fallback,
    userMessage: CODEX_AUTH_MESSAGES[fallback],
    cause,
  });
}

/**
 * Names of Pi's own OAuth failures, read off `pi-ai/dist/auth/resolve.js`.
 *
 * Pi wraps every refresh failure as `ModelsError` with `code: "oauth"` and a
 * message beginning `OAuth refresh failed for <provider>`; a credential-store
 * failure becomes `code: "auth"` with `Credential store modify failed`. Pilot
 * cannot `instanceof ModelsError` here without importing a runtime class into
 * every consumer, and — more importantly — by the time this runs the error has
 * usually been through `PiAgentSession`'s terminal-event mapping, which keeps
 * only the *message*. So the classification is by shape, on the message, and
 * every pattern is anchored to a string Pi itself produces.
 */
const REFRESH_FAILED_PATTERN = /OAuth (refresh|auth derivation) failed for/i;
const STORE_FAILED_PATTERN = /Credential store modify failed/i;
const UNAUTHORIZED_PATTERN = /\b(401|403)\b|\bunauthorized\b|\binvalid_grant\b|\btoken expired\b/i;
const NOT_CONFIGURED_PATTERN = /no credential is configured|not configured|unconfigured/i;

/**
 * Turns whatever the provider, Pi or `PiAgentSession` produced into the typed
 * recovery Pilot offers, or `null` when it is not an auth failure at all.
 *
 * Accepts a `PilotError`, a `SerializedPilotError` (which is what a `run-failed`
 * event carries), an `Error`, or a string, because those are the four shapes
 * this failure arrives in.
 */
export function classifyCodexAuthFailure(value: unknown): CodexAuthFailure | null {
  const message = messageOf(value);
  if (message === null) {
    return null;
  }
  if (codeOf(value) === 'authentication-required') {
    const reason = reasonOf(value) ?? 'signed-out';
    return codexAuthFailure(reason, message);
  }
  if (STORE_FAILED_PATTERN.test(message)) {
    return codexAuthFailure('credential-store-failed', message);
  }
  if (REFRESH_FAILED_PATTERN.test(message) || UNAUTHORIZED_PATTERN.test(message)) {
    return codexAuthFailure('refresh-failed', message);
  }
  if (NOT_CONFIGURED_PATTERN.test(message)) {
    return codexAuthFailure('signed-out', message);
  }
  return null;
}

function messageOf(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    return typeof message === 'string' ? message : null;
  }
  return null;
}

function codeOf(value: unknown): string | null {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code = (value as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function reasonOf(value: unknown): CodexAuthFailureReason | null {
  if (typeof value !== 'object' || value === null || !('details' in value)) {
    return null;
  }
  const details = (value as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null || !('reason' in details)) {
    return null;
  }
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason in CODEX_AUTH_MESSAGES
    ? (reason as CodexAuthFailureReason)
    : null;
}

/** True when a serialized error the panel is about to show is a Codex auth failure. */
export function isCodexAuthError(error: SerializedPilotError): boolean {
  return classifyCodexAuthFailure(error) !== null;
}
