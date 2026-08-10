import { INTERACTION_STATES, type InteractionState } from '@pilot/shared';
import {
  FakeHotkeyAdapter,
  FakeInteractionController,
  FakePermissionAdapter,
  FakeWindowAdapter,
} from '@pilot/platform/fakes';
import type { ConversationFixtureName } from '../ipc/schemas.js';
import { ConversationGate } from '../main/conversation-gate.js';
import {
  createFakeConversationDriver,
  createFakeSpeechDisclosureSource,
  resolveHotkeyAvailability,
  resolveSpeechDisclosure,
} from '../main/conversation-fixtures.js';
import { PermissionGate } from '../main/permission-gate.js';
import { createPermissionFixtureSource } from '../main/permission-fixtures.js';
import { createSettingsShortcut } from '../main/settings-shortcut.js';
import { WindowGate } from '../main/window-gate.js';
import { createFakeObservationInteraction } from '../main/window-feed.js';
import { buildDiagnosticsView, diagnosticsDataStrings } from '../diagnostics/view-model.js';
import { buildObservationView } from '../observation/view-model.js';
import { buildPermissionOnboardingView } from '../permissions/view-model.js';
import {
  buildConversationView,
  INTERACTION_STATE_PRESENTATION,
  type ConversationView,
} from './view-model.js';

/**
 * Headless walkthrough of the conversation panel and the diagnostics surface.
 *
 * `docs/implementation.md` requires PR-010 to demo "a fixture-driven
 * conversation and ring-buffer telemetry". This is that demo, run against the
 * same code the panel runs — the real {@link ConversationGate}, the real
 * fixture driver, the real view models — so what it prints is what the app
 * renders, and it can be checked on Linux in a terminal and diffed when the
 * copy changes.
 *
 * It covers, in order: every interaction state and how it is told apart; a
 * spoken question whose answer arrives in chunks; the same question typed; an
 * interruption mid-answer; the recogniser failing and the text box staying
 * live; and the ring buffer, which prints numbers and categories and nothing
 * else — the last section re-reads the whole diagnostics surface and asserts
 * that no word of the conversation appears anywhere in it.
 */

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function heading(title: string): string {
  return `── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`;
}

/** A fixed clock so the printed timings are stable enough to diff. */
function fixedClock(start: number): { now(): number; advance(ms: number): void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += Math.max(0, ms);
    },
  };
}

interface Rig {
  readonly controller: FakeInteractionController;
  readonly conversation: ConversationGate;
  readonly replay: (fixture: ConversationFixtureName) => void;
  view(): ConversationView;
  dispose(): void;
}

async function rig(options: {
  readonly hotkey: string | undefined;
  readonly disclosure: string | undefined;
}): Promise<Rig> {
  const permissionAdapter = new FakePermissionAdapter();
  const permissions = new PermissionGate({
    adapter: permissionAdapter,
    settings: createSettingsShortcut({ platform: 'linux', adapter: permissionAdapter }),
    fixtures: createPermissionFixtureSource(permissionAdapter, 'granted'),
    now: () => 1_700_000_000_000,
  });
  await permissions.refresh();

  const controller = new FakeInteractionController();
  const clock = fixedClock(1_700_000_000_000);
  const hotkeyAdapter = new FakeHotkeyAdapter({
    availability: resolveHotkeyAvailability(options.hotkey),
  });
  const speech = createFakeSpeechDisclosureSource(resolveSpeechDisclosure(options.disclosure));
  const conversation = new ConversationGate({
    interaction: controller,
    hotkey: hotkeyAdapter,
    ...(speech === undefined ? {} : { speech }),
    demoFixtures: true,
    now: () => clock.now(),
  });
  await hotkeyAdapter.start();
  await conversation.refresh();

  const windowAdapter = new FakeWindowAdapter();
  const windows = new WindowGate({
    windows: windowAdapter,
    interaction: createFakeObservationInteraction(controller),
    permissions,
    now: () => 1_700_000_000_000,
  });
  await windows.refresh();

  return {
    controller,
    conversation,
    replay: createFakeConversationDriver({ controller, gate: conversation, clock }),
    view: () =>
      buildConversationView({
        view: controller.snapshot(),
        gate: conversation.snapshot(),
        observation: buildObservationView({
          gate: windows.snapshot(),
          view: controller.snapshot(),
          permissions: buildPermissionOnboardingView(permissions.snapshot()),
        }),
      }),
    dispose: () => {
      conversation.dispose();
      windows.dispose();
      permissions.dispose();
    },
  };
}

function renderConversation(view: ConversationView, lines: string[]): void {
  lines.push(`  state     : ${view.state} — ${view.stateLabel}`);
  lines.push(`  says      : ${view.stateDetail}`);
  lines.push(`  tone      : ${view.tone} · activity ${view.activity} · busy ${String(view.busy)}`);
  lines.push(`  capturing : ${String(view.capturing)}`);
  if (view.liveTranscript !== null) {
    lines.push(`  hearing   : “${view.liveTranscript}”`);
  }
  for (const turn of view.turns) {
    lines.push(
      `  ${pad(turn.speaker, 6)} ${pad(turn.status, 12)} ${String(turn.characters)} chars`,
    );
  }
  if (view.stream !== null) {
    lines.push(
      `  stream    : ${view.stream.streaming ? 'arriving' : 'stopped'}${
        view.stream.interrupted ? ' (interrupted)' : ''
      }, ${String(view.stream.characters)} characters`,
    );
  }
  lines.push(
    `  text box  : ${view.composer.available ? 'available' : `unavailable — ${view.composer.unavailableReason ?? ''}`}${
      view.composer.onlyWayToAsk ? ' (the only way to ask right now)' : ''
    }`,
  );
  for (const note of view.composer.notes) {
    lines.push(`      ↳ ${note}`);
  }
  for (const control of view.controls) {
    lines.push(
      `  ${pad(control.label, 28)} ${control.available ? 'available' : `unavailable — ${control.unavailableReason ?? ''}`}`,
    );
  }
  if (view.disclosure !== null) {
    lines.push(
      `  speech    : ${view.disclosure.headline} (leaves device: ${String(view.disclosure.leavesDevice)})`,
    );
  }
  if (view.lastError !== null) {
    lines.push(`  error     : ${view.lastError.code} — ${view.lastError.userMessage}`);
  }
}

export interface ConversationDemoResult {
  readonly lines: readonly string[];
  /** Every interaction state the walkthrough rendered. */
  readonly states: readonly InteractionState[];
  /** Words from the conversation that must not appear in the diagnostics. */
  readonly conversationWords: readonly string[];
  /** Everything the diagnostics surface would render, flattened to text. */
  readonly diagnosticsText: string;
}

export async function runConversationDemo(): Promise<ConversationDemoResult> {
  const lines: string[] = ['Pilot — conversation and diagnostics panel (PR-010)', ''];
  const states: InteractionState[] = [];

  // 1. Every interaction state, rendered, and how it is told apart. The last
  //    column is the one runbook follow-up 4 is about: `error` must say "yes".
  const states1 = await rig({ hotkey: 'active', disclosure: undefined });
  lines.push(heading('every interaction state'));
  lines.push(
    `  ${pad('state', 18)} ${pad('label', 24)} ${pad('tone', 11)} ${pad('activity', 13)} ${pad('busy', 5)} text box`,
  );
  for (const state of INTERACTION_STATES) {
    const presentation = INTERACTION_STATE_PRESENTATION[state];
    states1.controller.set({ state });
    const rendered = states1.view();
    states.push(rendered.state);
    lines.push(
      `  ${pad(state, 18)} ${pad(presentation.label, 24)} ${pad(presentation.tone, 11)} ${pad(
        presentation.activity,
        13,
      )} ${pad(String(presentation.busy), 5)} ${rendered.composer.available ? 'available' : 'unavailable'}`,
    );
  }
  states1.dispose();
  lines.push('');

  // 2. A spoken question, answered in chunks. Stopped part-way so the streamed
  //    response is visible mid-flight rather than only once it is complete.
  const live = await rig({ hotkey: 'active', disclosure: 'on-device' });
  lines.push(heading('before anything is said'));
  states.push(live.view().state);
  renderConversation(live.view(), lines);
  lines.push('');

  live.replay('spoken-question');
  lines.push(heading('a spoken question, answered'));
  states.push(live.view().state);
  renderConversation(live.view(), lines);
  lines.push('');

  live.replay('typed-question');
  lines.push(heading('the same question, typed'));
  states.push(live.view().state);
  renderConversation(live.view(), lines);
  lines.push('');

  live.replay('interrupted-answer');
  lines.push(heading('interrupted mid-answer'));
  states.push(live.view().state);
  renderConversation(live.view(), lines);
  lines.push('');

  // 3. system-design §16: the recogniser fails and typing is the way out. The
  //    text box must still be available here; that is the whole point.
  live.replay('stt-failure');
  lines.push(heading('speech recognition fails — text input must still work'));
  states.push(live.view().state);
  renderConversation(live.view(), lines);
  lines.push('');

  // 4. The same panel with no usable shortcut at all.
  const noHotkey = await rig({ hotkey: 'permission-missing', disclosure: 'remote' });
  noHotkey.replay('spoken-question');
  lines.push(heading('no push-to-talk shortcut, and audio would leave the machine'));
  states.push(noHotkey.view().state);
  renderConversation(noHotkey.view(), lines);
  lines.push('');
  noHotkey.dispose();

  // 5. The ring buffer.
  const diagnostics = buildDiagnosticsView({
    ...live.conversation.snapshot(),
    diagnosticsVisible: true,
  });
  lines.push(heading('developer diagnostics — timings and counts'));
  lines.push(`  ${diagnostics.privacyNote}`);
  lines.push(
    `  recorded ${String(diagnostics.recorded)} · kept ${String(diagnostics.retained)} · dropped ${String(
      diagnostics.dropped,
    )} · ring of ${String(diagnostics.capacity)} · questions ${String(diagnostics.turns)}`,
  );
  for (const metric of diagnostics.metrics) {
    lines.push(
      `  ${pad(metric.label, 34)} ${pad(String(metric.samples), 3)} ${pad(metric.last ?? '—', 10)} ${pad(
        metric.min ?? '—',
        10,
      )} ${pad(metric.max ?? '—', 10)} ${metric.mean ?? '—'}`,
    );
  }
  for (const tally of [...diagnostics.aborts, ...diagnostics.failures]) {
    lines.push(`  ${pad(tally.metric, 8)} ${pad(tally.category, 24)} ${String(tally.count)}`);
  }
  lines.push('');

  lines.push(heading('most recent samples'));
  for (const sample of diagnostics.recent.slice(0, 12)) {
    lines.push(
      `  #${pad(String(sample.seq), 3)} turn ${sample.turn} ${pad(sample.label, 34)} ${pad(sample.formatted, 10)} ${
        sample.category ?? ''
      }`,
    );
  }
  lines.push('');

  // 6. The assertion the whole surface exists to survive.
  //
  // Compared against the *data* the surface renders, not against the whole
  // view: the labels and notes are English sentences written in
  // `src/diagnostics/view-model.ts`, so a substring search over them reports
  // ordinary words like "with" and "going" as leaks. What has to be provably
  // free of the conversation is every value that came from a measurement, and
  // `diagnosticsDataStrings` is all of it.
  const diagnosticsText = diagnosticsDataStrings(diagnostics).join(' ');
  const conversationWords = [
    ...new Set(
      live
        .view()
        .turns.flatMap((turn) => turn.text.split(/\s+/))
        .map((word) => word.replace(/[^A-Za-z]/g, ''))
        .filter((word) => word.length >= 3),
    ),
  ];
  const leaked = conversationWords.filter((word) =>
    new RegExp(`\\b${word}\\b`, 'i').test(diagnosticsText),
  );
  lines.push(heading('privacy check'));
  lines.push(
    `  ${String(conversationWords.length)} distinct words were said in this conversation.`,
  );
  lines.push(
    `  the diagnostics surface renders ${String(diagnosticsDataStrings(diagnostics).length)} measured values.`,
  );
  lines.push(
    leaked.length === 0
      ? '  none of the words appear in any of the values. PASS'
      : `  LEAKED: ${leaked.join(', ')}`,
  );
  live.dispose();

  return { lines, states, conversationWords, diagnosticsText };
}
