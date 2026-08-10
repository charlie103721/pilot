import { describe, expect, it } from 'vitest';
import { findEventChannel, findRequestChannel } from '../../src/ipc/channels.js';
import {
  CODEX_ACTIONS,
  DISABLED_CODEX_GATE_STATE,
  codexActionSchema,
  codexGateStateSchema,
  type CodexAction,
} from '../../src/ipc/codex-schemas.js';
import {
  codexActChannel,
  codexChangedEvent,
  codexGetChannel,
} from '../../src/ipc/codex-channels.js';

/**
 * The Codex channels (PR-037).
 *
 * The `Record` keyed by the union's own discriminant is the pattern
 * `docs/runbook.md` cross-lane issue 2 mandates: a new `CodexAction` member
 * that nobody adds a validator for fails the **build**, not a runtime message.
 * `z.ZodType<T>` alone does not catch it, because a narrower union stays
 * assignable.
 */

describe('the catalogue', () => {
  it('carries both request channels and the event, so the router will serve them', () => {
    expect(findRequestChannel(codexGetChannel.name)).toBe(codexGetChannel);
    expect(findRequestChannel(codexActChannel.name)).toBe(codexActChannel);
    expect(findEventChannel(codexChangedEvent.name)).toBe(codexChangedEvent);
  });
});

describe('the action union', () => {
  it('validates one sample per member — keyed so a new member breaks the build', () => {
    const samples: Record<CodexAction['type'], CodexAction> = {
      refresh: { type: 'refresh' },
      'sign-in': { type: 'sign-in' },
      'cancel-sign-in': { type: 'cancel-sign-in' },
      'sign-out': { type: 'sign-out' },
    };
    for (const [name, sample] of Object.entries(samples)) {
      expect(codexActionSchema.parse(sample), name).toEqual(sample);
    }
    expect(Object.keys(samples).sort()).toEqual([...CODEX_ACTIONS].sort());
  });

  it('rejects an action that is not in the union', () => {
    expect(codexActionSchema.safeParse({ type: 'reveal-token' }).success).toBe(false);
  });
});

describe('the gate state cannot carry a credential', () => {
  it('accepts the disabled state, which is what a build without the profile reports', () => {
    expect(codexGateStateSchema.parse(DISABLED_CODEX_GATE_STATE)).toEqual(
      DISABLED_CODEX_GATE_STATE,
    );
  });

  it('rejects a token smuggled in at the top level', () => {
    const smuggled = { ...DISABLED_CODEX_GATE_STATE, accessToken: 'sk-secret' };
    expect(codexGateStateSchema.safeParse(smuggled).success).toBe(false);
  });

  it('rejects a token smuggled into the auth status', () => {
    const smuggled = {
      ...DISABLED_CODEX_GATE_STATE,
      auth: { ...DISABLED_CODEX_GATE_STATE.auth, refresh: 'refresh-token' },
    };
    expect(codexGateStateSchema.safeParse(smuggled).success).toBe(false);
  });

  it('rejects a token smuggled into the device code', () => {
    const smuggled = {
      ...DISABLED_CODEX_GATE_STATE,
      signIn: {
        phase: 'awaiting-approval' as const,
        deviceCode: {
          userCode: 'ABCD',
          verificationUri: 'https://auth.openai.com/codex/device',
          intervalSeconds: 5,
          expiresInSeconds: 900,
          access: 'token',
        },
        error: null,
      },
    };
    expect(codexGateStateSchema.safeParse(smuggled).success).toBe(false);
  });

  it('has no field whose name suggests it could hold one', () => {
    const fields = [
      ...Object.keys(DISABLED_CODEX_GATE_STATE),
      ...Object.keys(DISABLED_CODEX_GATE_STATE.auth),
    ];
    for (const field of fields) {
      expect(field).not.toMatch(/token|secret|key|access|refresh|credential$/i);
    }
  });
});
