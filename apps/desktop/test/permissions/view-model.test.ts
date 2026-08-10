import { describe, expect, it } from 'vitest';
import { PERMISSION_KINDS, type PermissionKind, type PermissionSnapshot } from '@pilot/shared';
import {
  FIXTURE_PERMISSIONS_ACCESSIBILITY_DENIED,
  FIXTURE_PERMISSIONS_DENIED,
  FIXTURE_PERMISSIONS_GRANTED,
  FIXTURE_PERMISSIONS_MIXED,
  FIXTURE_PERMISSIONS_RESTRICTED,
  FIXTURE_PERMISSIONS_SCREEN_DENIED,
  FIXTURE_PERMISSIONS_UNKNOWN,
} from '@pilot/platform/fakes';
import type { PermissionGateState } from '../../src/ipc/schemas.js';
import {
  buildPermissionOnboardingView,
  permissionsAllowObservation,
  type PermissionRowStatus,
} from '../../src/permissions/view-model.js';

/**
 * The onboarding rules, asserted where they live.
 *
 * Everything the panel decides is decided in the view model, so these tests are
 * the real coverage of "cover every status the contract models" and of
 * system-design §16's insistence that Screen Recording denied and Accessibility
 * denied are different failures.
 */

const SETTINGS_UNAVAILABLE = {
  available: false,
  platform: 'linux',
  reason:
    'Pilot can only open a permissions pane on macOS, and this copy of Pilot is running on linux.',
} as const;

const SETTINGS_AVAILABLE = { available: true, platform: 'darwin', reason: null } as const;

function gateState(overrides: Partial<PermissionGateState> = {}): PermissionGateState {
  return {
    snapshot: FIXTURE_PERMISSIONS_GRANTED,
    pending: [],
    checkedAt: 1_700_000_000_000,
    settings: SETTINGS_UNAVAILABLE,
    lastError: null,
    fixture: null,
    ...overrides,
  };
}

function row(
  snapshot: PermissionSnapshot | null,
  kind: PermissionKind,
  pending: PermissionKind[] = [],
) {
  const view = buildPermissionOnboardingView(gateState({ snapshot, pending }));
  const found = view.rows.find((candidate) => candidate.kind === kind);
  expect(found).toBeDefined();
  return found!;
}

describe('permission rows', () => {
  it('renders all four permissions in a fixed order', () => {
    const view = buildPermissionOnboardingView(gateState());
    expect(view.rows.map((entry) => entry.kind)).toEqual([
      'screen-recording',
      'accessibility',
      'microphone',
      'speech-recognition',
    ]);
    expect(view.rows).toHaveLength(PERMISSION_KINDS.length);
  });

  it('maps every state the contract models onto a distinct status', () => {
    const cases: ReadonlyArray<[PermissionSnapshot, PermissionRowStatus]> = [
      [FIXTURE_PERMISSIONS_UNKNOWN, 'unknown'],
      [FIXTURE_PERMISSIONS_GRANTED, 'granted'],
      [FIXTURE_PERMISSIONS_DENIED, 'denied'],
      [FIXTURE_PERMISSIONS_RESTRICTED, 'restricted'],
    ];

    for (const [snapshot, expected] of cases) {
      for (const kind of PERMISSION_KINDS) {
        expect(row(snapshot, kind).status).toBe(expected);
      }
    }
  });

  it('gives every status its own label, so none of them read alike', () => {
    const labels = new Set([
      row(null, 'microphone').statusLabel,
      row(FIXTURE_PERMISSIONS_UNKNOWN, 'microphone').statusLabel,
      row(FIXTURE_PERMISSIONS_GRANTED, 'microphone').statusLabel,
      row(FIXTURE_PERMISSIONS_DENIED, 'microphone').statusLabel,
      row(FIXTURE_PERMISSIONS_RESTRICTED, 'microphone').statusLabel,
    ]);
    expect(labels.size).toBe(5);
  });

  it('shows an unread permission as checking, never as a refusal', () => {
    const entry = row(null, 'screen-recording');
    expect(entry.status).toBe('checking');
    expect(entry.statusLabel).toBe('Checking…');
    expect(entry.action.kind).toBe('wait');
  });

  it('shows an in-flight check as checking even though a state is known', () => {
    const entry = row(FIXTURE_PERMISSIONS_DENIED, 'microphone', ['microphone']);
    expect(entry.status).toBe('checking');
    // Its neighbours are unaffected — only the row being checked changes.
    expect(row(FIXTURE_PERMISSIONS_DENIED, 'accessibility', ['microphone']).status).toBe('denied');
  });

  it('explains every permission in terms of what the user gets', () => {
    for (const kind of PERMISSION_KINDS) {
      const entry = row(FIXTURE_PERMISSIONS_UNKNOWN, kind);
      expect(entry.why.length).toBeGreaterThan(20);
      expect(entry.bound.length).toBeGreaterThan(20);
      expect(entry.impact).toBe(entry.impact.trim());
      expect(entry.impact.length).toBeGreaterThan(0);
    }
  });

  it('says nothing about impact once a permission is allowed', () => {
    for (const kind of PERMISSION_KINDS) {
      const entry = row(FIXTURE_PERMISSIONS_GRANTED, kind);
      expect(entry.satisfied).toBe(true);
      expect(entry.impact).toBe('');
      expect(entry.action.kind).toBe('none');
    }
  });

  it('offers a prompt only while the platform will still prompt', () => {
    expect(row(FIXTURE_PERMISSIONS_UNKNOWN, 'microphone').action).toEqual({
      kind: 'request',
      label: 'Allow…',
    });
    // Denied with canRequest false: macOS prompts once, so the only way
    // forward is System Settings.
    expect(row(FIXTURE_PERMISSIONS_DENIED, 'microphone').action.kind).toBe('open-settings');
  });

  it('offers no action at all for a restricted permission', () => {
    const entry = row(FIXTURE_PERMISSIONS_RESTRICTED, 'screen-recording');
    expect(entry.action.kind).toBe('none');
    expect(entry.impact).toContain('manages this Mac');
  });
});

describe('System Settings shortcut', () => {
  it('disables the control and explains itself where it cannot work', () => {
    const view = buildPermissionOnboardingView(
      gateState({ snapshot: FIXTURE_PERMISSIONS_DENIED, settings: SETTINGS_UNAVAILABLE }),
    );
    const entry = view.rows[0]!;

    expect(entry.action).toEqual({
      kind: 'open-settings',
      label: 'Open System Settings',
      enabled: false,
    });
    expect(entry.settingsNote).toContain('running on linux');
    // …and it still names the pane, so the user is not left without a route.
    expect(entry.settingsNote).toContain('System Settings › Privacy & Security › Screen Recording');
  });

  it('enables the control and drops the note where it does work', () => {
    const view = buildPermissionOnboardingView(
      gateState({ snapshot: FIXTURE_PERMISSIONS_DENIED, settings: SETTINGS_AVAILABLE }),
    );
    const entry = view.rows[0]!;

    expect(entry.action).toEqual({
      kind: 'open-settings',
      label: 'Open System Settings',
      enabled: true,
    });
    expect(entry.settingsNote).toBeNull();
  });
});

describe('readiness', () => {
  it('is checking while nothing has been read', () => {
    const view = buildPermissionOnboardingView(gateState({ snapshot: null, checkedAt: null }));
    expect(view.readiness).toBe('checking');
    expect(view.blocking).toEqual([]);
    expect(permissionsAllowObservation(view)).toBe(false);
  });

  it('is blocked when Screen Recording is missing', () => {
    const view = buildPermissionOnboardingView(
      gateState({ snapshot: FIXTURE_PERMISSIONS_SCREEN_DENIED }),
    );
    expect(view.readiness).toBe('blocked');
    expect(view.blocking).toEqual(['screen-recording']);
    expect(view.groundingDisclosure).toBeNull();
    expect(permissionsAllowObservation(view)).toBe(false);
  });

  it('is degraded — not blocked — when only Accessibility is missing', () => {
    const view = buildPermissionOnboardingView(
      gateState({ snapshot: FIXTURE_PERMISSIONS_ACCESSIBILITY_DENIED }),
    );
    expect(view.readiness).toBe('degraded');
    expect(view.blocking).toEqual([]);
    expect(view.degrading).toEqual(['accessibility']);
    // system-design §16: continue with visual pointer coordinates, and say so.
    expect(view.groundingDisclosure).toContain('pointer position');
    expect(permissionsAllowObservation(view)).toBe(true);
  });

  it('keeps the two §16 failures apart', () => {
    const screen = buildPermissionOnboardingView(
      gateState({ snapshot: FIXTURE_PERMISSIONS_SCREEN_DENIED }),
    );
    const accessibility = buildPermissionOnboardingView(
      gateState({ snapshot: FIXTURE_PERMISSIONS_ACCESSIBILITY_DENIED }),
    );

    expect(screen.readiness).not.toBe(accessibility.readiness);
    expect(screen.headline).not.toBe(accessibility.headline);
    expect(screen.summary).not.toBe(accessibility.summary);
    expect(permissionsAllowObservation(screen)).toBe(false);
    expect(permissionsAllowObservation(accessibility)).toBe(true);
  });

  it('is limited when only the voice pair is missing', () => {
    const snapshot: PermissionSnapshot = {
      ...FIXTURE_PERMISSIONS_GRANTED,
      microphone: { kind: 'microphone', state: 'denied', canRequest: false },
      'speech-recognition': { kind: 'speech-recognition', state: 'denied', canRequest: false },
    };
    const view = buildPermissionOnboardingView(gateState({ snapshot }));

    expect(view.readiness).toBe('limited');
    expect(view.limiting).toEqual(['microphone', 'speech-recognition']);
    expect(view.groundingDisclosure).toBeNull();
    expect(view.summary).toContain('typed questions');
    expect(permissionsAllowObservation(view)).toBe(true);
  });

  it('discloses reduced grounding on a refusal, not on a permission nobody asked for', () => {
    expect(
      buildPermissionOnboardingView(gateState({ snapshot: FIXTURE_PERMISSIONS_UNKNOWN }))
        .groundingDisclosure,
    ).toBeNull();
    expect(
      buildPermissionOnboardingView(gateState({ snapshot: FIXTURE_PERMISSIONS_RESTRICTED }))
        .groundingDisclosure,
    ).not.toBeNull();
  });

  it('is ready when everything is allowed', () => {
    const view = buildPermissionOnboardingView(gateState());
    expect(view.readiness).toBe('ready');
    expect(view.rows.every((entry) => entry.satisfied)).toBe(true);
    expect(view.groundingDisclosure).toBeNull();
  });

  it('reports blocked, not ready, when one refusal sits beside a pending check', () => {
    const view = buildPermissionOnboardingView(
      gateState({ snapshot: FIXTURE_PERMISSIONS_SCREEN_DENIED, pending: ['microphone'] }),
    );
    expect(view.readiness).toBe('blocked');
    expect(view.checking).toBe(true);
  });

  it('summarises a mixed state without hiding any of it', () => {
    const view = buildPermissionOnboardingView(gateState({ snapshot: FIXTURE_PERMISSIONS_MIXED }));

    expect(view.readiness).toBe('degraded');
    expect(view.degrading).toEqual(['accessibility']);
    expect(view.limiting).toEqual(['microphone', 'speech-recognition']);
    expect(view.rows.map((entry) => entry.status)).toEqual([
      'granted',
      'denied',
      'unknown',
      'restricted',
    ]);
  });
});
