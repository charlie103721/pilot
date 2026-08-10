import { asConversationId } from '@pilot/shared';
import {
  FakeAgentSession,
  FakePermissionAdapter,
  FakeWindowAdapter,
  FIXTURE_WINDOW_RETINA,
  FIXTURE_WINDOW_SECONDARY,
} from '@pilot/platform/fakes';
import type { PilotInteractionController } from '@pilot/interaction';
import type { PermissionFixtureName } from '../ipc/schemas.js';
import { PermissionGate } from '../main/permission-gate.js';
import { createPermissionFixtureSource } from '../main/permission-fixtures.js';
import { createSettingsShortcut } from '../main/settings-shortcut.js';
import { WindowGate } from '../main/window-gate.js';
import {
  createInteractionRuntime,
  createObservationInteraction,
} from '../main/interaction-runtime.js';
import { createFakeWindowDemoDriver } from '../main/window-demo.js';
import { buildPermissionOnboardingView } from '../permissions/view-model.js';
import {
  buildObservationView,
  OBSERVATION_INDICATORS,
  type ObservationIndicator,
} from './view-model.js';

/**
 * Headless walkthrough of the window picker and the observation controls.
 *
 * `docs/implementation.md` requires PR-009 to demo "select fake windows and
 * verify control state changes", and runbook §5 amendment 8 says no real window
 * list will be enumerated for a while. So the demo runs the same code the panel
 * runs — the real {@link WindowGate}, the real {@link PermissionGate}, the real
 * view model — through every indicator state and prints it, so the result can
 * be checked on Linux in a terminal and diffed when the copy changes.
 *
 * It also runs the two sequences a static fixture cannot show: the selected
 * window closing mid-observation (system-design §16) and the selected window
 * being retitled while Pilot is watching it.
 *
 * Since PR-029 the interaction side is the **real** controller, so what answers
 * `window-closed` here is `@pilot/interaction`'s transition table rather than
 * PR-009's hand-written copy of two of its rows. The agent behind it is
 * `FakeAgentSession`: this walkthrough asks no questions, and a faux provider
 * would only add noise to a picture about capture.
 */

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

interface Rig {
  readonly permissions: PermissionGate;
  readonly permissionAdapter: FakePermissionAdapter;
  readonly windows: WindowGate;
  readonly adapter: FakeWindowAdapter;
  readonly controller: PilotInteractionController;
  readonly demo: ReturnType<typeof createFakeWindowDemoDriver>;
  render(lines: string[]): void;
}

function rig(fixture: PermissionFixtureName): Rig {
  const permissionAdapter = new FakePermissionAdapter();
  const permissions = new PermissionGate({
    adapter: permissionAdapter,
    settings: createSettingsShortcut({ platform: 'linux', adapter: permissionAdapter }),
    fixtures: createPermissionFixtureSource(permissionAdapter, fixture),
    now: () => 1_700_000_000_000,
  });
  const conversationId = asConversationId('conv-observation-demo');
  const { controller } = createInteractionRuntime({
    agent: new FakeAgentSession({ conversationId }),
    conversationId,
    clock: { now: () => 1_700_000_000_000 },
  });
  const adapter = new FakeWindowAdapter();
  const windows = new WindowGate({
    windows: adapter,
    interaction: createObservationInteraction(controller),
    permissions,
    demoEvents: true,
    now: () => 1_700_000_000_000,
  });

  return {
    permissions,
    permissionAdapter,
    windows,
    adapter,
    controller,
    demo: createFakeWindowDemoDriver({
      adapter,
      selected: () => controller.snapshot().selectedWindow,
    }),
    render(lines: string[]): void {
      const view = buildObservationView({
        gate: windows.snapshot(),
        view: controller.snapshot(),
        permissions: buildPermissionOnboardingView(permissions.snapshot()),
      });
      lines.push(`  indicator : ${view.indicator}`);
      lines.push(`  capturing : ${String(view.capturing)}`);
      lines.push(`  says      : ${view.indicatorLabel} — ${view.indicatorDetail}`);
      lines.push(
        `  selected  : ${
          view.selection === null
            ? 'nothing'
            : `${view.selection.applicationName} — ${view.selection.title} (${view.selection.sizeLabel})`
        }`,
      );
      if (view.selection?.warning != null) {
        lines.push(`      ↳ ${view.selection.warning}`);
      }
      for (const control of view.controls) {
        lines.push(
          `  ${pad(control.label, 15)} ${control.available ? 'available' : `unavailable — ${control.unavailableReason ?? ''}`}`,
        );
      }
      lines.push(`  windows   : ${view.listNote ?? `${String(view.rows.length)} listed`}`);
      for (const row of view.rows) {
        lines.push(
          `    ${pad(`${row.applicationName} — ${row.title}`, 34)} ${pad(row.actionLabel, 22)} ${
            row.selectable ? 'selectable' : `blocked — ${row.unavailableReason ?? ''}`
          }`,
        );
      }
      if (view.notice !== null) {
        lines.push(`  prompt    : ${view.notice.headline} — ${view.notice.message}`);
      }
      if (view.grounding === 'reduced') {
        lines.push(`  grounding : reduced — ${view.groundingNote ?? ''}`);
      }
    },
  };
}

function heading(title: string): string {
  return `── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`;
}

export interface ObservationDemoResult {
  readonly lines: readonly string[];
  /** Every indicator state the walkthrough actually reached, in order. */
  readonly indicators: readonly ObservationIndicator[];
}

export async function runObservationDemo(): Promise<ObservationDemoResult> {
  const lines: string[] = [];
  const indicators: ObservationIndicator[] = [];
  lines.push('Pilot — window picker and observation controls (PR-009)');
  lines.push('');

  const note = (rigged: Rig): void => {
    const view = buildObservationView({
      gate: rigged.windows.snapshot(),
      view: rigged.controller.snapshot(),
      permissions: buildPermissionOnboardingView(rigged.permissions.snapshot()),
    });
    indicators.push(view.indicator);
    rigged.render(lines);
    lines.push('');
  };

  // 1. Before anything is known. Not a refusal, and it must not look like one.
  const starting = rig('granted');
  lines.push(heading('nothing decided yet'));
  note(starting);
  starting.windows.dispose();
  starting.permissions.dispose();

  // 2. Screen Recording refused: observation is not offered at all.
  const blocked = rig('screen-denied');
  await blocked.permissions.refresh();
  await blocked.windows.refresh();
  lines.push(heading('Screen Recording refused'));
  note(blocked);
  blocked.windows.dispose();
  blocked.permissions.dispose();

  // 3…6. The happy path, one control at a time.
  const live = rig('granted');
  await live.permissions.refresh();
  await live.windows.refresh();
  lines.push(heading('allowed, no window chosen'));
  note(live);

  // Choosing a window is consent to watch it: `@pilot/interaction`'s
  // `select-window` row switches observation on and starts capture. PR-009's
  // fake controller claimed otherwise; PR-029 replaced it with the table.
  await live.windows.act({ type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId });
  lines.push(heading('window chosen — Pilot starts watching it'));
  note(live);

  await live.windows.act({ type: 'stop' });
  lines.push(heading('observation switched off, window still chosen'));
  note(live);

  await live.windows.act({ type: 'start' });
  lines.push(heading('watching'));
  note(live);

  await live.demo('retitle-selected');
  await live.windows.refresh();
  lines.push(heading('the window is retitled while Pilot watches it'));
  note(live);

  await live.windows.act({ type: 'pause' });
  lines.push(heading('paused'));
  note(live);

  await live.windows.act({ type: 'resume' });
  lines.push(heading('resumed'));
  note(live);

  // 7. system-design §16: the selected window closes mid-observation.
  await live.demo('close-selected');
  await live.windows.refresh();
  lines.push(heading('the selected window closes while Pilot watches it'));
  note(live);

  await live.windows.act({ type: 'select', windowId: FIXTURE_WINDOW_SECONDARY.windowId });
  lines.push(heading('the user answers the prompt with another window'));
  note(live);
  live.windows.dispose();
  live.permissions.dispose();

  // 8. Accessibility refused: degraded, not blocked. Observation is allowed.
  const degraded = rig('accessibility-denied');
  await degraded.permissions.refresh();
  await degraded.windows.refresh();
  await degraded.windows.act({ type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId });
  await degraded.windows.act({ type: 'start' });
  lines.push(heading('Accessibility refused — degraded, still watching'));
  note(degraded);
  degraded.windows.dispose();
  degraded.permissions.dispose();

  // 9. Screen Recording withdrawn while Pilot is watching.
  const withdrawn = rig('granted');
  await withdrawn.permissions.refresh();
  await withdrawn.windows.refresh();
  await withdrawn.windows.act({ type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId });
  await withdrawn.windows.act({ type: 'start' });
  withdrawn.permissionAdapter.set({
    kind: 'screen-recording',
    state: 'denied',
    canRequest: false,
  });
  lines.push(heading('Screen Recording withdrawn mid-observation'));
  note(withdrawn);
  withdrawn.windows.dispose();
  withdrawn.permissions.dispose();

  lines.push(heading('indicator states reached'));
  for (const indicator of OBSERVATION_INDICATORS) {
    lines.push(
      `  ${pad(indicator, 12)} ${indicators.includes(indicator) ? 'reached' : 'NOT REACHED'}`,
    );
  }

  return { lines, indicators };
}
