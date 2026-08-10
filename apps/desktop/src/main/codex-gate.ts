import { nullLogger, type Logger } from '@pilot/shared';
import {
  codexGateStateSchema,
  type CodexAction,
  type CodexGateState,
} from '../ipc/codex-schemas.js';
import { type CodexRuntime, type CodexRuntimeState } from './codex-runtime.js';

/**
 * The Codex profile's renderer-facing gate (PR-037).
 *
 * Shaped exactly like `PermissionGate`, `WindowGate` and `ConversationGate`,
 * and for the same reasons: one object owns the state the panel reads *and* the
 * actions it can take, so the panel can never be shown a "Sign out" control for
 * a build that has nothing to sign out of.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE. Everything that crosses to the
 * renderer goes through {@link toCodexGateState}, which re-parses through
 * `codexGateStateSchema` — a `strictObject`. A future field on
 * `CodexRuntimeState` that happened to carry credential material would fail
 * validation here rather than reach Chromium. system-design §12 says
 * credentials are never sent to the renderer; this is where that stops being a
 * convention.
 */

/** Projects the runtime's state onto the wire shape, and validates it. */
export function toCodexGateState(state: CodexRuntimeState): CodexGateState {
  return codexGateStateSchema.parse({
    enabled: state.enabled,
    auth: {
      providerId: state.auth.providerId,
      state: state.auth.state,
      configured: state.auth.configured,
      isSubscription: state.auth.isSubscription,
      source: state.auth.source,
      expiresAt: state.auth.expiresAt,
      expiresInMs: state.auth.expiresInMs,
      signInRequired: state.auth.signInRequired,
      label: state.auth.label,
      detail: state.auth.detail,
    },
    signIn: {
      phase: state.signIn.phase,
      deviceCode: state.signIn.deviceCode,
      error: state.signIn.error,
    },
    description: state.description,
    capabilityError: state.capabilityError,
    credentialsEncrypted: state.credentialsEncrypted,
    credentialsPath: state.credentialsPath,
  });
}

export interface CodexGateOptions {
  readonly runtime: CodexRuntime;
  readonly logger?: Logger;
}

export class CodexGate {
  readonly #runtime: CodexRuntime;
  readonly #logger: Logger;
  readonly #listeners = new Set<(state: CodexGateState) => void>();
  #unsubscribe: (() => void) | null = null;

  constructor(options: CodexGateOptions) {
    this.#runtime = options.runtime;
    this.#logger = options.logger ?? nullLogger;
    this.#unsubscribe = this.#runtime.subscribe((state) => {
      const wire = toCodexGateState(state);
      for (const listener of this.#listeners) {
        listener(wire);
      }
    });
  }

  get enabled(): boolean {
    return this.#runtime.enabled;
  }

  state(): CodexGateState {
    return toCodexGateState(this.#runtime.state());
  }

  subscribe(listener: (state: CodexGateState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Serves one panel action.
   *
   * `sign-in` deliberately does **not** await the login: the user has to type a
   * code into a browser, which takes minutes. It starts the flow and answers
   * with the state that has the device code in it as soon as Pi produces one;
   * everything after that arrives on `pilot:codex/changed`.
   */
  async act(action: CodexAction): Promise<CodexGateState> {
    // Action name only. No payload here can carry content, but the rule is the
    // same everywhere: the log says what happened, not what was in it.
    this.#logger.debug('codex action', { type: action.type });
    switch (action.type) {
      case 'refresh':
        return toCodexGateState(await this.#runtime.refresh());
      case 'sign-in':
        return toCodexGateState(this.#runtime.beginSignIn());
      case 'cancel-sign-in':
        return toCodexGateState(this.#runtime.cancelSignIn());
      case 'sign-out':
        return toCodexGateState(await this.#runtime.signOut());
    }
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#listeners.clear();
  }
}
