// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { CodexStatus } from '../../src/renderer/CodexStatus.js';
import {
  DISABLED_CODEX_GATE_STATE,
  type CodexAction,
  type CodexGateState,
} from '../../src/ipc/codex-schemas.js';
import type { CodexShell } from '../../src/renderer/use-codex.js';

/**
 * The panel's Model section (PR-037).
 *
 * Three claims, and each is one the delivery rules single out:
 *
 *  - a build that has not selected the profile renders **nothing**, rather than
 *    a control the main process would refuse (`docs/runbook.md` follow-up 4's
 *    rule, and PR-009's "the panel asks rather than decides");
 *  - the words the user reads are the ones `packages/agent` wrote, so the log,
 *    the demo and the panel cannot describe the same state differently;
 *  - the device code is shown, because a headless sign-in that never tells the
 *    user what to type is a dead end.
 */

afterEach(cleanup);

function shell(overrides: Partial<CodexGateState> = {}): CodexShell & {
  readonly actions: CodexAction['type'][];
} {
  const actions: CodexAction['type'][] = [];
  return {
    actions,
    gate: { ...DISABLED_CODEX_GATE_STATE, enabled: true, ...overrides },
    transportError: null,
    refresh: () => actions.push('refresh'),
    signIn: () => actions.push('sign-in'),
    cancelSignIn: () => actions.push('cancel-sign-in'),
    signOut: () => actions.push('sign-out'),
  };
}

describe('CodexStatus', () => {
  it('renders nothing on a build that has not selected the profile', () => {
    const codex = shell({ enabled: false });
    render(<CodexStatus codex={codex} />);
    expect(screen.queryByTestId('codex-status')).toBeNull();
  });

  it('shows the signed-out state, its remedy and a sign-in control', async () => {
    const codex = shell();
    render(<CodexStatus codex={codex} />);
    await waitFor(() => expect(screen.getByTestId('codex-status')).toBeTruthy());
    expect(screen.getByTestId('codex-auth-label').textContent).toBe('Not signed in to ChatGPT');
    expect(screen.getByTestId('codex-auth-label').getAttribute('data-state')).toBe('signed-out');
    expect(screen.getByTestId('codex-detail').textContent).toContain('ChatGPT Plus/Pro');
    expect(screen.getByTestId('codex-sign-in').textContent).toBe('Sign in to ChatGPT');
    // Nothing to sign out of yet.
    expect(screen.getByTestId('codex-sign-out').hasAttribute('disabled')).toBe(true);
  });

  it('shows the device code and the URL while a sign-in is waiting', () => {
    const codex = shell({
      signIn: {
        phase: 'awaiting-approval',
        deviceCode: {
          userCode: 'WXYZ-9876',
          verificationUri: 'https://auth.openai.com/codex/device',
          intervalSeconds: 5,
          expiresInSeconds: 900,
        },
        error: null,
      },
    });
    render(<CodexStatus codex={codex} />);
    expect(screen.getByTestId('codex-user-code').textContent).toBe('WXYZ-9876');
    expect(screen.getByTestId('codex-device-code').textContent).toContain(
      'https://auth.openai.com/codex/device',
    );
    // Sign-in is replaced by cancel while one is in flight.
    expect(screen.queryByTestId('codex-sign-in')).toBeNull();
    screen.getByTestId('codex-cancel-sign-in').click();
    expect(codex.actions).toEqual(['cancel-sign-in']);
  });

  it('offers sign-out once a credential is stored, and says where it is', () => {
    const codex = shell({
      auth: {
        ...DISABLED_CODEX_GATE_STATE.auth,
        state: 'active',
        configured: true,
        signInRequired: false,
        label: 'Signed in to ChatGPT',
        detail: 'Pilot is using your ChatGPT subscription. No API key is stored.',
      },
      credentialsEncrypted: true,
      credentialsPath: '/Users/x/Library/Application Support/Pilot/credentials/x.json',
    });
    render(<CodexStatus codex={codex} />);
    expect(screen.getByTestId('codex-credential-storage').textContent).toBe(
      'Encrypted on this Mac',
    );
    expect(screen.getByTestId('codex-credentials-path').textContent).toContain('credentials');
    screen.getByTestId('codex-sign-out').click();
    expect(codex.actions).toEqual(['sign-out']);
  });

  it('says plainly when the token is not encrypted rather than staying silent', () => {
    const codex = shell({
      auth: { ...DISABLED_CODEX_GATE_STATE.auth, configured: true },
      credentialsEncrypted: false,
    });
    render(<CodexStatus codex={codex} />);
    expect(screen.getByTestId('codex-credential-storage').textContent).toBe(
      'On this Mac, NOT encrypted',
    );
  });

  it('shows the capability refusal, because it is why nothing will be answered', () => {
    const codex = shell({
      capabilityError: {
        name: 'PilotError',
        code: 'unsupported-capability',
        domain: 'agent',
        message: 'Profile supportsVision=false',
        userMessage:
          'This model cannot see images, so it cannot answer questions about your screen.',
        retryable: false,
      },
    });
    render(<CodexStatus codex={codex} />);
    expect(screen.getByTestId('codex-capability-error').textContent).toContain('cannot see images');
  });

  it('shows a failed sign-in with its own sentence and offers another attempt', () => {
    const codex = shell({
      signIn: {
        phase: 'failed',
        deviceCode: null,
        error: {
          name: 'PilotError',
          code: 'authentication-required',
          domain: 'agent',
          message: 'openai-codex: login cancelled',
          userMessage: 'Pilot could not finish signing in to ChatGPT. Try again.',
          retryable: false,
        },
      },
    });
    render(<CodexStatus codex={codex} />);
    expect(screen.getByTestId('codex-sign-in-error').textContent).toContain('Try again');
    screen.getByTestId('codex-sign-in').click();
    expect(codex.actions).toEqual(['sign-in']);
  });
});
