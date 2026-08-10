import { describe, expect, it } from 'vitest';
import {
  FIXTURE_PERMISSIONS_DENIED,
  FIXTURE_PERMISSIONS_GRANTED,
  FIXTURE_PERMISSIONS_SCREEN_DENIED,
} from '@pilot/platform/fakes';
import type { PermissionGateState } from '../../src/ipc/schemas.js';
import { permissionGateStateSchema } from '../../src/ipc/schemas.js';
import { buildPermissionOnboardingView } from '../../src/permissions/view-model.js';
import { createSettingsShortcut, unavailableReason } from '../../src/main/settings-shortcut.js';
import { permissionHarness } from './support.js';

/**
 * The main-process permission gate.
 *
 * The behaviour that matters here is not "does it call the adapter" but the
 * three things onboarding is judged on: an in-flight check is visible, an
 * external change is picked up without a restart, and a refused action is
 * reported as a typed error instead of vanishing.
 */

function readiness(state: PermissionGateState): string {
  return buildPermissionOnboardingView(state).readiness;
}

describe('PermissionGate', () => {
  it('starts with nothing read, which is not the same as nothing granted', () => {
    const { gate } = permissionHarness();

    const state = gate.snapshot();

    expect(state.snapshot).toBeNull();
    expect(state.checkedAt).toBeNull();
    expect(readiness(state)).toBe('checking');
    gate.dispose();
  });

  it('reads every permission on refresh and validates on the wire', async () => {
    const { gate } = permissionHarness({ fixture: 'mixed', now: () => 1_700_000_000_000 });

    const state = await gate.refresh();

    expect(permissionGateStateSchema.parse(state)).toBeDefined();
    expect(state.snapshot?.['screen-recording'].state).toBe('granted');
    expect(state.snapshot?.accessibility.state).toBe('denied');
    expect(state.snapshot?.microphone.state).toBe('unknown');
    expect(state.snapshot?.['speech-recognition'].state).toBe('restricted');
    expect(state.checkedAt).toBe(1_700_000_000_000);
    gate.dispose();
  });

  it('publishes the pending set while a check is in flight', async () => {
    const { gate } = permissionHarness();
    const seen: PermissionGateState[] = [];
    gate.subscribe((state) => seen.push(state));

    await gate.refresh();

    // The first publication has every kind pending, the last has none: the
    // panel can therefore draw "checking" and then the result, and never has
    // to show an empty list that looks like a refusal.
    expect(seen[0]!.pending).toHaveLength(4);
    expect(readiness(seen[0]!)).toBe('checking');
    expect(seen.at(-1)!.pending).toEqual([]);
    gate.dispose();
  });

  it('marks only the permission being prompted as pending', async () => {
    const { gate } = permissionHarness();
    await gate.refresh();
    const seen: PermissionGateState[] = [];
    gate.subscribe((state) => seen.push(state));

    await gate.request('microphone');

    expect(seen[0]!.pending).toEqual(['microphone']);
    expect(buildPermissionOnboardingView(seen[0]!).rows[2]!.status).toBe('checking');
    expect(seen.at(-1)!.snapshot?.microphone.state).toBe('granted');
    gate.dispose();
  });

  it('records a refusal from the prompt rather than assuming success', async () => {
    const { gate, adapter } = permissionHarness();
    adapter.grantOnRequest = false;
    await gate.refresh();

    const state = await gate.request('screen-recording');

    expect(state.snapshot?.['screen-recording'].state).toBe('denied');
    expect(readiness(state)).toBe('blocked');
    gate.dispose();
  });

  it('handles a prompt that comes back restricted', async () => {
    const { gate, adapter } = permissionHarness();
    adapter.requestOutcomes.set('accessibility', 'restricted');
    await gate.refresh();

    const state = await gate.request('accessibility');

    expect(state.snapshot?.accessibility.state).toBe('restricted');
    gate.dispose();
  });

  it('recovers from denied to granted without a restart', async () => {
    const { gate, adapter } = permissionHarness({ fixture: 'denied' });
    const seen: PermissionGateState[] = [];
    await gate.refresh();
    gate.subscribe((state) => seen.push(state));
    expect(readiness(gate.snapshot())).toBe('blocked');

    // The user goes to System Settings and allows everything. Nothing in Pilot
    // is re-created: the same gate instance hears about it through the adapter
    // subscription and publishes the new state.
    adapter.setSnapshot(FIXTURE_PERMISSIONS_GRANTED);

    expect(seen).not.toHaveLength(0);
    expect(readiness(gate.snapshot())).toBe('ready');
    expect(gate.snapshot().snapshot).toEqual(FIXTURE_PERMISSIONS_GRANTED);
    expect(seen.at(-1)!.snapshot).toEqual(FIXTURE_PERMISSIONS_GRANTED);
    gate.dispose();
  });

  it('recovers one permission at a time, keeping the §16 distinction', async () => {
    const { gate, adapter } = permissionHarness({ fixture: 'denied' });
    await gate.refresh();

    // Screen Recording alone comes back: Pilot stops being blocked, but it is
    // still degraded because Accessibility is refused.
    adapter.setSnapshot(FIXTURE_PERMISSIONS_SCREEN_DENIED);
    expect(readiness(gate.snapshot())).toBe('blocked');

    adapter.set({ kind: 'screen-recording', state: 'granted', canRequest: false });
    expect(readiness(gate.snapshot())).toBe('ready');

    adapter.set({ kind: 'accessibility', state: 'denied', canRequest: false });
    const degraded = gate.snapshot();
    expect(readiness(degraded)).toBe('degraded');
    expect(buildPermissionOnboardingView(degraded).groundingDisclosure).not.toBeNull();
    gate.dispose();
  });

  it('also recovers through an explicit re-check, for platforms that never notify', async () => {
    const { gate, adapter } = permissionHarness({ fixture: 'denied' });
    await gate.refresh();

    // A silent external change: the state the adapter would report has changed,
    // but nothing was emitted. This is macOS TCC, which never notifies — and it
    // is why `DesktopShell.reveal()` re-reads whenever the panel comes back.
    adapter.snapshot = async () => FIXTURE_PERMISSIONS_GRANTED;
    expect(readiness(gate.snapshot())).toBe('blocked');

    const state = await gate.refresh();

    expect(readiness(state)).toBe('ready');
    gate.dispose();
  });

  it('ignores an adapter event that changes nothing', async () => {
    const { gate, adapter } = permissionHarness({ fixture: 'denied' });
    await gate.refresh();
    const seen: PermissionGateState[] = [];
    gate.subscribe((state) => seen.push(state));

    adapter.set(FIXTURE_PERMISSIONS_DENIED['microphone']);

    expect(seen).toHaveLength(0);
    gate.dispose();
  });

  it('reports an unusable System Settings shortcut as a typed error', async () => {
    const { gate } = permissionHarness({ platform: 'linux' });
    await gate.refresh();

    const state = await gate.openSettings('screen-recording');

    expect(state.lastError?.code).toBe('unsupported-capability');
    expect(state.lastError?.userMessage).toContain(unavailableReason('linux'));
    expect(state.lastError?.userMessage).toContain('Privacy & Security › Screen Recording');
    gate.dispose();
  });

  it('opens the pane where the shortcut is supported', async () => {
    const { gate, adapter } = permissionHarness({ platform: 'darwin' });
    await gate.refresh();

    const state = await gate.openSettings('accessibility');

    expect(adapter.openedSettings).toEqual(['accessibility']);
    expect(state.lastError).toBeNull();
    gate.dispose();
  });

  it('surfaces a settings call that fails on macOS instead of pretending it worked', async () => {
    const { gate, adapter } = permissionHarness({ platform: 'darwin' });
    await gate.refresh();
    adapter.openSettingsError = new Error('no such pane');

    const state = await gate.openSettings('microphone');

    expect(state.lastError?.code).toBe('internal');
    gate.dispose();
  });

  it('clears the last error when asked', async () => {
    const { gate } = permissionHarness();
    await gate.openSettings('microphone');
    expect(gate.snapshot().lastError).not.toBeNull();

    expect(gate.dismissError().lastError).toBeNull();
    gate.dispose();
  });

  it('keeps working when the platform cannot answer at all', async () => {
    const { gate, adapter } = permissionHarness();
    adapter.snapshot = async () => {
      throw new Error('helper is not running');
    };

    const state = await gate.refresh();

    expect(state.snapshot).toBeNull();
    expect(state.lastError?.code).toBe('internal');
    expect(state.pending).toEqual([]);
    // Still "checking" rather than a fabricated denial.
    expect(readiness(state)).toBe('checking');
    gate.dispose();
  });

  it('switches fixtures and re-reads', async () => {
    const { gate } = permissionHarness({ fixture: 'unknown' });
    await gate.refresh();

    const restricted = await gate.applyFixture('restricted');
    expect(restricted.fixture).toBe('restricted');
    expect(restricted.snapshot?.microphone.state).toBe('restricted');

    const granted = await gate.applyFixture('granted');
    expect(readiness(granted)).toBe('ready');
    gate.dispose();
  });

  it('refuses fixtures in a build that has none', async () => {
    const { gate } = permissionHarness({ withFixtures: false });

    await expect(gate.applyFixture('granted')).rejects.toMatchObject({
      code: 'unsupported-capability',
    });
    expect(gate.snapshot().fixture).toBeNull();
    gate.dispose();
  });

  it('stops publishing after dispose', async () => {
    const { gate, adapter } = permissionHarness({ fixture: 'denied' });
    await gate.refresh();
    const seen: PermissionGateState[] = [];
    gate.subscribe((state) => seen.push(state));

    gate.dispose();
    adapter.setSnapshot(FIXTURE_PERMISSIONS_GRANTED);

    expect(seen).toHaveLength(0);
  });
});

describe('settings shortcut seam', () => {
  it('is available only on macOS', () => {
    const { adapter } = permissionHarness();
    expect(createSettingsShortcut({ platform: 'darwin', adapter }).availability()).toEqual({
      available: true,
      platform: 'darwin',
      reason: null,
    });
    expect(createSettingsShortcut({ platform: 'win32', adapter }).availability()).toEqual({
      available: false,
      platform: 'win32',
      reason: unavailableReason('win32'),
    });
  });

  it('names the pane the user should open by hand when it cannot help', async () => {
    const { adapter } = permissionHarness();
    const shortcut = createSettingsShortcut({ platform: 'linux', adapter });

    await expect(shortcut.open('speech-recognition')).rejects.toMatchObject({
      code: 'unsupported-capability',
    });
    await shortcut.open('speech-recognition').catch((error: unknown) => {
      expect((error as { userMessage: string }).userMessage).toContain(
        'Privacy & Security › Speech Recognition',
      );
    });
    expect(adapter.openedSettings).toEqual([]);
  });
});
