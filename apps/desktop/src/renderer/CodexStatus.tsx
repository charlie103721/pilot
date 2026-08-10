import type { CodexShell } from './use-codex.js';

/**
 * The model-provider section of the panel (PR-037).
 *
 * Renders nothing at all on a build that has not selected the Codex profile:
 * offering a "Sign in to ChatGPT" control that the main process would refuse is
 * exactly the silent failure the delivery rules forbid, and PR-009 already
 * established that the panel asks rather than decides.
 *
 * Every sentence here comes over the wire from `packages/agent`. The renderer
 * writes none of them, so the words a user reads about their sign-in are the
 * same words the log and the demo use.
 *
 * There is no field on {@link CodexShell.gate} that can hold a token — see
 * `apps/desktop/src/ipc/codex-schemas.ts`.
 */
export function CodexStatus({ codex }: { codex: CodexShell }) {
  const { gate } = codex;
  if (!gate.enabled) {
    return null;
  }

  const signingIn = gate.signIn.phase === 'starting' || gate.signIn.phase === 'awaiting-approval';

  return (
    <section className="section" data-testid="codex-status">
      <h2 className="section__title">Model</h2>

      <dl className="facts">
        <dt>ChatGPT</dt>
        <dd data-testid="codex-auth-label" data-state={gate.auth.state}>
          {gate.auth.label}
        </dd>
        <dt>Profile</dt>
        <dd data-testid="codex-description">{gate.description}</dd>
        <dt>Sign-in stored</dt>
        <dd data-testid="codex-credential-storage">
          {!gate.auth.configured
            ? 'Nothing stored'
            : gate.credentialsEncrypted
              ? 'Encrypted on this Mac'
              : 'On this Mac, NOT encrypted'}
        </dd>
      </dl>

      <p className="panel__note" data-testid="codex-detail">
        {gate.auth.detail}
      </p>

      {gate.capabilityError === null ? null : (
        <p className="banner banner--error" role="alert" data-testid="codex-capability-error">
          {gate.capabilityError.userMessage}
        </p>
      )}

      {gate.signIn.phase === 'awaiting-approval' && gate.signIn.deviceCode !== null ? (
        <div className="banner" data-testid="codex-device-code">
          <p className="banner__message">
            Open <strong>{gate.signIn.deviceCode.verificationUri}</strong> and enter the code{' '}
            <strong data-testid="codex-user-code">{gate.signIn.deviceCode.userCode}</strong>.
          </p>
        </div>
      ) : null}

      {gate.signIn.phase === 'starting' ? (
        <p className="panel__note" data-testid="codex-sign-in-starting">
          Asking OpenAI for a sign-in code…
        </p>
      ) : null}

      {gate.signIn.error === null ? null : (
        <p className="banner banner--error" role="alert" data-testid="codex-sign-in-error">
          {gate.signIn.error.userMessage}
        </p>
      )}

      <div className="controls">
        {signingIn ? (
          <button
            type="button"
            className="button button--quiet"
            data-testid="codex-cancel-sign-in"
            onClick={() => codex.cancelSignIn()}
          >
            Cancel sign-in
          </button>
        ) : (
          <button
            type="button"
            className="button"
            data-testid="codex-sign-in"
            onClick={() => codex.signIn()}
          >
            {gate.auth.configured ? 'Sign in again' : 'Sign in to ChatGPT'}
          </button>
        )}
        <button
          type="button"
          className="button button--quiet"
          data-testid="codex-sign-out"
          disabled={!gate.auth.configured || signingIn}
          onClick={() => codex.signOut()}
        >
          Sign out
        </button>
        <button
          type="button"
          className="button button--quiet"
          data-testid="codex-refresh"
          onClick={() => codex.refresh()}
        >
          Recheck
        </button>
      </div>

      {gate.credentialsPath === null ? null : (
        <p className="panel__note" data-testid="codex-credentials-path">
          Stored at {gate.credentialsPath}
        </p>
      )}
    </section>
  );
}
