import { join } from 'node:path';
import {
  codexCredentialsPath,
  createCodexAgentSession,
  createCodexCredentialStore,
  createCodexModelSource,
  signedOutCodexStatus,
  toCapabilityError,
  type CodexAuthStatus,
  type CodexCredentialStore,
  type CodexDeviceCode,
  type CodexModelSource,
  type CodexSecretProtector,
} from '@pilot/agent';
import type { AgentSession } from '@pilot/platform';
import { nullLogger, toPilotError, type Logger, type SerializedPilotError } from '@pilot/shared';

/**
 * The Codex subscription profile, wired into the shipping composition (PR-037).
 *
 * WHAT `main/index.ts` GETS FROM THIS FILE, and nothing else:
 *
 *  - a {@link CodexModelSource} to pass as `createAgentRuntime({ source })` —
 *    the provider-neutral `ModelSource` runbook follow-up 22 names, so the app
 *    below it is unchanged;
 *  - {@link CodexRuntime.wrapSession}, which is the identity function when
 *    Codex is not selected;
 *  - a startup failure to report when Codex *is* selected and cannot answer;
 *  - a status object for the panel, and the two actions behind it.
 *
 * WHY IT IS OPT-IN. `PILOT_MODEL_PROFILE=codex`. The default is still
 * `createDevelopmentModelSource()`, because **no sign-in has happened**
 * (`docs/handoff.md` §2) and a build that silently switched to a provider it
 * has no credential for would answer nothing at all. Selecting it is therefore
 * a deliberate act, and the moment it is selected the app stops pretending: the
 * description says `NOT SIGNED IN`, the startup failure carries the sentence
 * that says so, and every question is refused with a remedy rather than with a
 * provider error. That is runbook follow-up 22's "must not silently look like a
 * working model", read the strict way.
 *
 * WHY THE CREDENTIAL FILE IS NOT IN `userData` DIRECTLY. `docs/handoff.md` §1
 * step 16 (3) promises that deleting `conversations/` deletes the user's
 * conversation history and nothing else. The mirror of that promise is that
 * signing out must not delete a conversation, so the token lives in its own
 * `credentials/` directory (`packages/agent/src/codex-credentials.ts`).
 */

/** What `PILOT_MODEL_PROFILE` must be set to for this runtime to take over. */
export const CODEX_PROFILE_SELECTOR = 'codex';

export type CodexSignInPhase =
  /** No sign-in in flight. */
  | 'idle'
  /** `Models.login` has been called; Pi has not produced a code yet. */
  | 'starting'
  /** The user has a code and a URL, and Pi is polling. */
  | 'awaiting-approval'
  /** The last attempt failed or was cancelled. {@link CodexSignInState.error} says why. */
  | 'failed';

export interface CodexSignInState {
  readonly phase: CodexSignInPhase;
  /** What the user types, and where. Never credential material. */
  readonly deviceCode: CodexDeviceCode | null;
  readonly error: SerializedPilotError | null;
}

export const IDLE_SIGN_IN: CodexSignInState = { phase: 'idle', deviceCode: null, error: null };

export interface CodexRuntimeState {
  /** True when `PILOT_MODEL_PROFILE=codex`. */
  readonly enabled: boolean;
  readonly auth: CodexAuthStatus;
  readonly signIn: CodexSignInState;
  /** Provider/model, the capability verdict and the auth state, in one line. */
  readonly description: string;
  /** Null when Codex is not selected, or when the gate accepted the model. */
  readonly capabilityError: SerializedPilotError | null;
  /** True when the refresh token is encrypted at rest. False is a real, shown state. */
  readonly credentialsEncrypted: boolean;
  /** Where the refresh token is stored, so the user can delete it by hand. */
  readonly credentialsPath: string | null;
}

export interface CodexRuntime {
  readonly enabled: boolean;
  /** Null unless {@link CodexRuntimeState.enabled}. */
  readonly source: CodexModelSource | null;
  readonly credentials: CodexCredentialStore | null;
  state(): CodexRuntimeState;
  refresh(): Promise<CodexRuntimeState>;
  /** Starts a device-code sign-in and returns at once. Progress arrives through {@link subscribe}. */
  beginSignIn(): CodexRuntimeState;
  cancelSignIn(): CodexRuntimeState;
  signOut(): Promise<CodexRuntimeState>;
  subscribe(listener: (state: CodexRuntimeState) => void): () => void;
  /** Identity when Codex is not selected. */
  wrapSession(session: AgentSession): AgentSession;
  /**
   * The failure to hand the interaction machine at startup, or `null`.
   *
   * Reported the same way the capability refusal and the persistence refusal
   * are (`main/index.ts`): as a `failure`, so the panel shows `userMessage`
   * beside a live text box (system-design §16) rather than a dead window.
   */
  startupError(): SerializedPilotError | null;
  dispose(): Promise<void>;
}

/**
 * Wraps Electron's `safeStorage` as a {@link CodexSecretProtector}.
 *
 * `available` is a getter rather than a snapshot on purpose: on Linux
 * `isEncryptionAvailable()` is only meaningful after the app is ready, and this
 * runtime is built before `app.whenReady()` because the agent below it is. A
 * throw is treated as "not available", which is the honest answer and the one
 * that makes the panel say so.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export function createSafeStorageProtector(safeStorage: SafeStorageLike): CodexSecretProtector {
  const available = (): boolean => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  return {
    get available(): boolean {
      return available();
    },
    encrypt: (plaintext: string): string =>
      available()
        ? safeStorage.encryptString(plaintext).toString('base64')
        : /* istanbul ignore next -- the store only calls this through `available` */ plaintext,
    decrypt: (protectedText: string): string => {
      if (!available()) {
        return protectedText;
      }
      return safeStorage.decryptString(Buffer.from(protectedText, 'base64'));
    },
  };
}

export interface CodexRuntimeOptions {
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** `app.getPath('userData')`. Required whenever Codex may be selected. */
  readonly userDataDirectory?: string;
  /** Overrides the credential file entirely. Tests pass a temporary directory. */
  readonly credentialsPath?: string;
  /** Electron's `safeStorage`, wrapped. Omit to store the token in plaintext. */
  readonly protector?: CodexSecretProtector;
  /** Injected for tests; the real source is built over the real Codex provider. */
  readonly source?: CodexModelSource;
  readonly now?: () => number;
  readonly logger?: Logger;
}

/** Reads `PILOT_MODEL_PROFILE`. Anything but `codex` leaves the app unchanged. */
export function isCodexSelected(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env['PILOT_MODEL_PROFILE'] ?? '').trim().toLowerCase() === CODEX_PROFILE_SELECTOR;
}

const DISABLED_STATE: CodexRuntimeState = {
  enabled: false,
  auth: signedOutCodexStatus(),
  signIn: IDLE_SIGN_IN,
  description: 'Codex subscription profile is not selected (PILOT_MODEL_PROFILE=codex enables it)',
  capabilityError: null,
  credentialsEncrypted: false,
  credentialsPath: null,
};

/** The runtime a build that has not selected Codex gets. Every method is inert. */
export function createDisabledCodexRuntime(): CodexRuntime {
  return {
    enabled: false,
    source: null,
    credentials: null,
    state: () => DISABLED_STATE,
    refresh: async () => DISABLED_STATE,
    beginSignIn: () => DISABLED_STATE,
    cancelSignIn: () => DISABLED_STATE,
    signOut: async () => DISABLED_STATE,
    subscribe: () => () => undefined,
    wrapSession: (session) => session,
    startupError: () => null,
    dispose: async () => undefined,
  };
}

/**
 * Builds the Codex runtime, or the inert one.
 *
 * Constructing it performs no network request, needs no credential and cannot
 * fail on a machine that has never signed in — the catalogue is static data in
 * the pinned package and the credential store treats an absent file as empty.
 * The first credential read is `refresh()`, which `main/index.ts` awaits before
 * it reports the startup line.
 */
export function createCodexRuntime(options: CodexRuntimeOptions = {}): CodexRuntime {
  const env = options.env ?? process.env;
  const logger = options.logger ?? nullLogger;
  if (options.source === undefined && !isCodexSelected(env)) {
    return createDisabledCodexRuntime();
  }

  const credentialsPath =
    options.credentialsPath ??
    (options.userDataDirectory === undefined
      ? join(process.cwd(), 'credentials', 'model-credentials.json')
      : codexCredentialsPath(options.userDataDirectory));

  const credentials =
    options.source === undefined
      ? createCodexCredentialStore({
          filePath: credentialsPath,
          ...(options.protector === undefined ? {} : { protector: options.protector }),
          logger,
        })
      : null;

  const source =
    options.source ??
    createCodexModelSource({
      ...(credentials === null ? {} : { credentials }),
      ...(env['PILOT_CODEX_MODEL'] === undefined ? {} : { model: env['PILOT_CODEX_MODEL'] }),
      ...(options.now === undefined ? {} : { now: options.now }),
      logger,
    });

  const listeners = new Set<(state: CodexRuntimeState) => void>();
  let signIn: CodexSignInState = IDLE_SIGN_IN;
  let signInAbort: AbortController | null = null;

  // Taken once, at construction, with zero provider requests made — which is
  // the whole point of the gate running before Pi's `Agent` exists.
  const capabilityRefusal: SerializedPilotError | null = source.capability.ok
    ? null
    : toCapabilityError(source.capability.refusal, source.capability.report).toJSON();

  const state = (): CodexRuntimeState => ({
    enabled: true,
    auth: source.auth.snapshot(),
    signIn,
    description: source.description,
    capabilityError: capabilityRefusal,
    credentialsEncrypted: credentials?.encrypted ?? false,
    credentialsPath: credentials?.filePath ?? null,
  });

  const publish = (): CodexRuntimeState => {
    const next = state();
    for (const listener of listeners) {
      listener(next);
    }
    return next;
  };

  const setSignIn = (next: CodexSignInState): CodexRuntimeState => {
    signIn = next;
    return publish();
  };

  return {
    enabled: true,
    source,
    credentials,
    state,

    async refresh(): Promise<CodexRuntimeState> {
      try {
        await source.auth.refresh();
      } catch (cause) {
        // A credential store that will not read is not a reason to refuse to
        // start: the state it produces is "signed out", which is exactly the
        // state the user can act on.
        logger.warn('could not read the stored ChatGPT sign-in', { cause: String(cause) });
      }
      return publish();
    },

    beginSignIn(): CodexRuntimeState {
      if (signIn.phase === 'starting' || signIn.phase === 'awaiting-approval') {
        return state();
      }
      const controller = new AbortController();
      signInAbort = controller;
      const started = setSignIn({ phase: 'starting', deviceCode: null, error: null });
      void source.auth
        .signIn(
          {
            deviceCode: (code: CodexDeviceCode) => {
              setSignIn({ phase: 'awaiting-approval', deviceCode: code, error: null });
            },
            progress: (message: string) => {
              // Counted, never quoted: Pi's progress lines are its own, and the
              // panel already says what the user has to do.
              logger.debug('codex sign-in progress', { length: message.length });
            },
          },
          controller.signal,
        )
        .then(() => {
          signInAbort = null;
          setSignIn(IDLE_SIGN_IN);
        })
        .catch((cause: unknown) => {
          signInAbort = null;
          setSignIn({
            phase: 'failed',
            deviceCode: null,
            error: toPilotError(cause, 'authentication-required').toJSON(),
          });
        });
      return started;
    },

    cancelSignIn(): CodexRuntimeState {
      signInAbort?.abort();
      signInAbort = null;
      return setSignIn(IDLE_SIGN_IN);
    },

    async signOut(): Promise<CodexRuntimeState> {
      signInAbort?.abort();
      signInAbort = null;
      await source.auth.signOut();
      signIn = IDLE_SIGN_IN;
      return publish();
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    wrapSession: (session) => createCodexAgentSession(session, source.auth, { logger }),

    startupError(): SerializedPilotError | null {
      if (capabilityRefusal !== null) {
        // The capability gate already refused inside `createAgentRuntime`, and
        // `main/index.ts` reports that one. Returning it twice would show the
        // user the same banner twice.
        return null;
      }
      const status = source.auth.snapshot();
      if (!status.signInRequired) {
        return null;
      }
      try {
        source.auth.assertUsable();
        return null;
      } catch (cause) {
        return toPilotError(cause, 'authentication-required').toJSON();
      }
    },

    async dispose(): Promise<void> {
      signInAbort?.abort();
      signInAbort = null;
      listeners.clear();
    },
  };
}
