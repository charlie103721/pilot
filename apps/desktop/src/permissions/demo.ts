import { FakePermissionAdapter, FIXTURE_PERMISSIONS_GRANTED } from '@pilot/platform/fakes';
import { PERMISSION_FIXTURES, type PermissionFixtureName } from '../ipc/schemas.js';
import { PermissionGate } from '../main/permission-gate.js';
import {
  createPermissionFixtureSource,
  PERMISSION_FIXTURE_SNAPSHOTS,
} from '../main/permission-fixtures.js';
import { createSettingsShortcut } from '../main/settings-shortcut.js';
import { buildPermissionOnboardingView } from './view-model.js';

/**
 * Headless walkthrough of permission onboarding.
 *
 * `docs/implementation.md` requires PR-008 to demo "unknown, denied, restricted
 * and granted", and runbook §5 amendment 8 says nobody will be looking at a
 * real permission dialog for a while. So the demo is the same code the panel
 * runs — the real {@link PermissionGate}, the real settings seam, the real view
 * model — driven through every fixture and printed, so it can be checked on
 * Linux in a terminal and diffed when the copy changes.
 *
 * It also runs the one sequence that cannot be shown by a static fixture: a
 * permission refused, then granted outside Pilot, recovering in place.
 */

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function gate(options: { platform: string; fixture: PermissionFixtureName }): {
  gate: PermissionGate;
  adapter: FakePermissionAdapter;
} {
  const adapter = new FakePermissionAdapter();
  const fixtures = createPermissionFixtureSource(adapter, options.fixture);
  return {
    adapter,
    gate: new PermissionGate({
      adapter,
      settings: createSettingsShortcut({ platform: options.platform, adapter }),
      fixtures,
      now: () => 1_700_000_000_000,
    }),
  };
}

function renderRows(instance: PermissionGate, lines: string[]): void {
  const view = buildPermissionOnboardingView(instance.snapshot());
  lines.push(`  readiness : ${view.readiness}`);
  lines.push(`  headline  : ${view.headline}`);
  lines.push(`  summary   : ${view.summary}`);
  for (const row of view.rows) {
    const action =
      row.action.kind === 'open-settings'
        ? `${row.action.label}${row.action.enabled ? '' : ' (unavailable here)'}`
        : row.action.kind === 'request'
          ? row.action.label
          : row.action.kind === 'wait'
            ? 'waiting'
            : '—';
    lines.push(
      `  ${pad(row.title, 19)} ${pad(row.statusLabel, 26)} ${pad(row.consequence, 9)} ${action}`,
    );
    if (row.impact !== '') {
      lines.push(`      ↳ ${row.impact}`);
    }
    if (row.settingsNote !== null) {
      lines.push(`      ↳ ${row.settingsNote}`);
    }
  }
  if (view.groundingDisclosure !== null) {
    lines.push(`  disclosure: ${view.groundingDisclosure}`);
  }
}

export interface PermissionDemoResult {
  readonly lines: readonly string[];
  /** Every fixture the walkthrough visited, in order. */
  readonly fixtures: readonly PermissionFixtureName[];
}

export async function runPermissionDemo(
  platform: string = process.platform,
): Promise<PermissionDemoResult> {
  const lines: string[] = [];
  lines.push('Pilot — permission onboarding (PR-008)');
  lines.push(`platform: ${platform}`);
  lines.push('');

  for (const fixture of PERMISSION_FIXTURES) {
    const built = gate({ platform, fixture });
    await built.gate.refresh();
    lines.push(`── fixture: ${fixture} ${'─'.repeat(Math.max(0, 46 - fixture.length))}`);
    renderRows(built.gate, lines);
    lines.push('');
    built.gate.dispose();
  }

  lines.push('── recovery: denied → granted, no restart ─────────────────');
  const recovery = gate({ platform, fixture: 'denied' });
  await recovery.gate.refresh();
  lines.push('  before:');
  renderRows(recovery.gate, lines);
  // The user opens System Settings and allows everything. The adapter reports
  // it; nothing restarts, and no code re-creates the gate.
  recovery.adapter.setSnapshot(FIXTURE_PERMISSIONS_GRANTED);
  lines.push('  after the user allows them in System Settings:');
  renderRows(recovery.gate, lines);
  recovery.gate.dispose();
  lines.push('');

  lines.push('── System Settings shortcut on each platform ──────────────');
  for (const candidate of ['darwin', platform === 'darwin' ? 'linux' : platform]) {
    const availability = createSettingsShortcut({
      platform: candidate,
      adapter: new FakePermissionAdapter(),
    }).availability();
    lines.push(
      `  ${pad(candidate, 10)} available=${String(availability.available)}` +
        (availability.reason === null ? '' : ` — ${availability.reason}`),
    );
  }

  return {
    lines,
    fixtures: [...PERMISSION_FIXTURES],
  };
}

/** Every fixture name is in the snapshot table; the demo would throw otherwise. */
export const DEMO_FIXTURE_COUNT = Object.keys(PERMISSION_FIXTURE_SNAPSHOTS).length;
