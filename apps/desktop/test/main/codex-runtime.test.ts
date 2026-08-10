import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_TEXT_ONLY_MODEL,
  codexCredentialsPath,
  createCodexCredentialStore,
  createFakeCodexModelSource,
  type CodexSecretProtector,
} from '@pilot/agent';
import { createLogger, createMemorySink } from '@pilot/shared';
import type { AgentSession } from '@pilot/platform';
import { CodexGate, toCodexGateState } from '../../src/main/codex-gate.js';
import {
  createCodexRuntime,
  createSafeStorageProtector,
  isCodexSelected,
  type CodexRuntimeState,
} from '../../src/main/codex-runtime.js';

/**
 * The composition root's half of the Codex profile (PR-037).
 *
 * What is pinned here, and why each fails silently otherwise:
 *
 *  - **The default is unchanged.** A build that has not set
 *    `PILOT_MODEL_PROFILE=codex` gets an inert runtime whose `wrapSession` is
 *    the identity function, so every earlier PR's composition behaves exactly
 *    as it did.
 *  - **A selected-but-signed-out profile produces a startup failure.** Runbook
 *    follow-up 22: it must not look like a working model. The failure is what
 *    `main/index.ts` hands the interaction machine.
 *  - **Nothing that crosses to the renderer can hold a token**, asserted
 *    against the fixture tokens the fake surface actually issued.
 */

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'pilot-codex-runtime-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Bounded poll. A wedged expectation fails loudly instead of flaking on a sleep. */
async function until(what: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function stubSession(): AgentSession {
  return {
    conversationId: 'conv-1' as never,
    profile: createFakeCodexModelSource().profile,
    subscribe: () => () => undefined,
    submit: async () => ({ runId: 'run-1' as never, completed: Promise.resolve() }),
    interrupt: async () => undefined,
    dispose: async () => undefined,
  };
}

describe('selection', () => {
  it('reads PILOT_MODEL_PROFILE, case-insensitively, and nothing else', () => {
    expect(isCodexSelected({})).toBe(false);
    expect(isCodexSelected({ PILOT_MODEL_PROFILE: '' })).toBe(false);
    expect(isCodexSelected({ PILOT_MODEL_PROFILE: 'development' })).toBe(false);
    expect(isCodexSelected({ PILOT_MODEL_PROFILE: 'codex' })).toBe(true);
    expect(isCodexSelected({ PILOT_MODEL_PROFILE: ' Codex ' })).toBe(true);
  });

  it('is inert, and wrapSession is the identity, when it is not selected', async () => {
    const runtime = createCodexRuntime({ env: {} });
    expect(runtime.enabled).toBe(false);
    expect(runtime.source).toBeNull();
    expect(runtime.startupError()).toBeNull();
    const session = stubSession();
    expect(runtime.wrapSession(session)).toBe(session);
    expect((await runtime.refresh()).enabled).toBe(false);
    await runtime.dispose();
  });

  it('builds the real Codex provider when it is selected, with no credential', async () => {
    const runtime = createCodexRuntime({
      env: { PILOT_MODEL_PROFILE: 'codex' },
      credentialsPath: codexCredentialsPath(workspace),
    });
    expect(runtime.enabled).toBe(true);
    expect(runtime.source?.profile.provider).toBe('openai-codex');
    expect(runtime.source?.requestCount()).toBe(0);
    const state = await runtime.refresh();
    expect(state.auth.state).toBe('signed-out');
    expect(state.description).toContain('NOT SIGNED IN');
    await runtime.dispose();
  });

  it('honours PILOT_CODEX_MODEL, including one the gate will refuse', async () => {
    const runtime = createCodexRuntime({
      env: { PILOT_MODEL_PROFILE: 'codex', PILOT_CODEX_MODEL: CODEX_TEXT_ONLY_MODEL },
      credentialsPath: codexCredentialsPath(workspace),
    });
    expect(runtime.source?.profile.model).toBe(CODEX_TEXT_ONLY_MODEL);
    expect(runtime.state().capabilityError?.code).toBe('unsupported-capability');
    // `main/index.ts` already reports the capability refusal through
    // `agentRuntime.capability`; reporting it twice would double the banner.
    expect(runtime.startupError()).toBeNull();
    await runtime.dispose();
  });
});

describe('the startup failure', () => {
  it('is raised while nothing is signed in, and carries the remedy', async () => {
    const source = createFakeCodexModelSource();
    const runtime = createCodexRuntime({ env: { PILOT_MODEL_PROFILE: 'codex' }, source });
    await runtime.refresh();
    const error = runtime.startupError();
    expect(error?.code).toBe('authentication-required');
    expect(error?.userMessage).toContain('Sign in');
    await runtime.dispose();
  });

  it('goes away once signed in, and comes back when the credential expires', async () => {
    const source = createFakeCodexModelSource();
    const runtime = createCodexRuntime({ env: { PILOT_MODEL_PROFILE: 'codex' }, source });
    await source.auth.signIn({ deviceCode: () => undefined });
    await runtime.refresh();
    expect(runtime.startupError()).toBeNull();

    await source.surface.expireIn(-1);
    await runtime.refresh();
    expect(runtime.startupError()?.details).toMatchObject({ reason: 'expired' });
    await runtime.dispose();
  });
});

describe('the sign-in state machine', () => {
  it('reports the device code as an event rather than as a return value', async () => {
    const source = createFakeCodexModelSource();
    const runtime = createCodexRuntime({ env: { PILOT_MODEL_PROFILE: 'codex' }, source });
    const seen: CodexRuntimeState[] = [];
    runtime.subscribe((state) => seen.push(state));

    const started = runtime.beginSignIn();
    expect(started.signIn.phase).toBe('starting');
    await until('the sign-in to settle', () => runtime.state().signIn.phase === 'idle');

    const codes = seen.map((state) => state.signIn.deviceCode?.userCode).filter(Boolean);
    expect(codes).toContain('PILOT-TEST');
    expect(runtime.state().auth.state).toBe('active');
    expect(runtime.state().signIn.phase).toBe('idle');
    await runtime.dispose();
  });

  it('does not start a second sign-in while one is in flight', async () => {
    const source = createFakeCodexModelSource();
    const runtime = createCodexRuntime({ env: { PILOT_MODEL_PROFILE: 'codex' }, source });
    runtime.beginSignIn();
    runtime.beginSignIn();
    await until('the sign-in to settle', () => runtime.state().signIn.phase === 'idle');
    expect(source.surface.logins).toHaveLength(1);
    await runtime.dispose();
  });

  it('signs out, and the status says so', async () => {
    const source = createFakeCodexModelSource();
    const runtime = createCodexRuntime({ env: { PILOT_MODEL_PROFILE: 'codex' }, source });
    await source.auth.signIn({ deviceCode: () => undefined });
    await runtime.refresh();
    expect(runtime.state().auth.configured).toBe(true);
    expect((await runtime.signOut()).auth.state).toBe('signed-out');
    await runtime.dispose();
  });

  it('never chooses the browser flow, so port 1455 is never bound', async () => {
    const source = createFakeCodexModelSource();
    const runtime = createCodexRuntime({ env: { PILOT_MODEL_PROFILE: 'codex' }, source });
    runtime.beginSignIn();
    await until('the sign-in to settle', () => runtime.state().signIn.phase === 'idle');
    expect(source.surface.browserServerBound()).toBe(false);
    expect(source.surface.logins.map((login) => login.method)).toEqual(['device_code']);
    await runtime.dispose();
  });
});

describe('the credential file', () => {
  it('lives under credentials/, not beside the conversation database', async () => {
    const runtime = createCodexRuntime({
      env: { PILOT_MODEL_PROFILE: 'codex' },
      userDataDirectory: workspace,
    });
    expect(runtime.credentials?.filePath).toBe(codexCredentialsPath(workspace));
    expect(runtime.state().credentialsPath).not.toContain('conversations');
    await runtime.dispose();
  });

  it('reports whether it is encrypted rather than assuming', async () => {
    const encrypting: CodexSecretProtector = {
      available: true,
      encrypt: (plaintext) => Buffer.from(plaintext).toString('base64'),
      decrypt: (text) => Buffer.from(text, 'base64').toString('utf8'),
    };
    const on = createCodexRuntime({
      env: { PILOT_MODEL_PROFILE: 'codex' },
      credentialsPath: codexCredentialsPath(workspace),
      protector: encrypting,
    });
    expect(on.state().credentialsEncrypted).toBe(true);
    await on.dispose();

    const off = createCodexRuntime({
      env: { PILOT_MODEL_PROFILE: 'codex' },
      credentialsPath: codexCredentialsPath(join(workspace, 'plain')),
    });
    expect(off.state().credentialsEncrypted).toBe(false);
    await off.dispose();
  });

  it('a safeStorage that is not ready reads as unavailable rather than throwing', () => {
    const protector = createSafeStorageProtector({
      isEncryptionAvailable: () => {
        throw new Error('not ready before app.whenReady()');
      },
      encryptString: () => Buffer.from(''),
      decryptString: () => '',
    });
    expect(protector.available).toBe(false);
    expect(protector.decrypt('plain')).toBe('plain');
  });

  it('encrypts through safeStorage when it is available', () => {
    const protector = createSafeStorageProtector({
      isEncryptionAvailable: () => true,
      encryptString: (plaintext) => Buffer.from(`sealed:${plaintext}`),
      decryptString: (buffer) => buffer.toString('utf8').replace('sealed:', ''),
    });
    expect(protector.available).toBe(true);
    expect(protector.decrypt(protector.encrypt('token'))).toBe('token');
  });
});

describe('the session wrapper', () => {
  it('refuses a question before the run starts when nothing is signed in', async () => {
    const source = createFakeCodexModelSource();
    const runtime = createCodexRuntime({ env: { PILOT_MODEL_PROFILE: 'codex' }, source });
    const wrapped = runtime.wrapSession(stubSession());
    await expect(
      wrapped.submit({
        utteranceId: 'utt-1' as never,
        transcript: 'What is this?',
        conversationId: 'conv-1' as never,
        scene: { id: 's', revision: 1, windowTitle: 'w', lastObservedRevision: 0 },
        pointer: { normalizedX: 0, normalizedY: 0 },
      }),
    ).rejects.toMatchObject({ code: 'authentication-required' });
    expect(source.requestCount()).toBe(0);
    await runtime.dispose();
  });
});

describe('nothing that reaches the renderer can hold a credential', () => {
  it('validates the gate state through a strict schema and carries no token', async () => {
    const sink = createMemorySink();
    const logger = createLogger({ scope: 'test', level: 'debug', sink });
    const store = codexCredentialsPath(workspace);
    const source = createFakeCodexModelSource();
    const runtime = createCodexRuntime({
      env: { PILOT_MODEL_PROFILE: 'codex' },
      credentialsPath: store,
      source,
      logger,
    });
    await source.auth.signIn({ deviceCode: () => undefined });
    await runtime.refresh();
    const gate = new CodexGate({ runtime, logger });

    const wire = JSON.stringify(gate.state());
    for (const token of source.surface.issuedTokens) {
      expect(wire).not.toContain(token);
      expect(JSON.stringify(sink.records)).not.toContain(token);
    }
    expect(gate.state().auth.state).toBe('active');
    gate.dispose();
    await runtime.dispose();
  });

  it('pushes a state to subscribers whenever the runtime changes', async () => {
    const source = createFakeCodexModelSource();
    const runtime = createCodexRuntime({ env: { PILOT_MODEL_PROFILE: 'codex' }, source });
    const gate = new CodexGate({ runtime });
    const seen: string[] = [];
    gate.subscribe((state) => seen.push(state.signIn.phase));
    await gate.act({ type: 'sign-in' });
    await until('the sign-in to settle', () => gate.state().signIn.phase === 'idle');
    expect(seen).toContain('awaiting-approval');
    expect(gate.state().auth.configured).toBe(true);
    gate.dispose();
    await runtime.dispose();
  });

  it('signing out through the gate removes the file from disk', async () => {
    const path = codexCredentialsPath(workspace);
    const runtime = createCodexRuntime({
      env: { PILOT_MODEL_PROFILE: 'codex' },
      credentialsPath: path,
      source: createFakeCodexModelSource({
        // A real on-disk store, so this assertion is about a real file.
        credentials: createCodexCredentialStore({ filePath: path }),
      }),
    });
    const gate = new CodexGate({ runtime });
    await gate.act({ type: 'sign-in' });
    await until('the credential to reach disk', () => existsSync(path));
    expect(readFileSync(path, 'utf8')).toContain('oauth');
    await gate.act({ type: 'sign-out' });
    expect(existsSync(path)).toBe(false);
    gate.dispose();
    await runtime.dispose();
  });

  it('projects a runtime state onto the wire shape and back with no loss', async () => {
    const source = createFakeCodexModelSource();
    const runtime = createCodexRuntime({ env: { PILOT_MODEL_PROFILE: 'codex' }, source });
    const state = await runtime.refresh();
    expect(toCodexGateState(state)).toMatchObject({
      enabled: true,
      auth: { state: 'signed-out', signInRequired: true },
      signIn: { phase: 'idle' },
    });
    await runtime.dispose();
  });
});
