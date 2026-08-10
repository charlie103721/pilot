import type { EventEnvelope, SpeechRecognitionDisclosure } from '@pilot/shared';
import type { HotkeyAvailability } from '@pilot/platform';
import {
  FakeHotkeyAdapter,
  FakeInteractionController,
  FakePermissionAdapter,
  FakeWindowAdapter,
} from '@pilot/platform/fakes';
import { ConversationGate } from '../../src/main/conversation-gate.js';
import {
  createFakeConversationDriver,
  createFakeSpeechDisclosureSource,
  type ConversationFixtureDriver,
  type ReplayClock,
} from '../../src/main/conversation-fixtures.js';
import type { PanelWindowHandle, PanelWindowHost } from '../../src/main/panel-window.js';
import type { TrayHandle, TrayHost, TrayMenuItem } from '../../src/main/tray.js';
import type { SingleInstanceHost } from '../../src/main/single-instance.js';
import { PermissionGate } from '../../src/main/permission-gate.js';
import { createPermissionFixtureSource } from '../../src/main/permission-fixtures.js';
import { createSettingsShortcut } from '../../src/main/settings-shortcut.js';
import { WindowGate, type ObservationPermissionSource } from '../../src/main/window-gate.js';
import {
  createFakeObservationInteraction,
  createFakeWindowDemoDriver,
  type WindowDemoDriver,
} from '../../src/main/window-feed.js';
import type { PermissionFixtureName } from '../../src/ipc/schemas.js';

/**
 * In-memory implementations of the shell's ports.
 *
 * Every main-process behaviour under test — single instance, window lifecycle,
 * tray rendering, IPC validation — is expressed against these rather than
 * against Electron, so the suite runs headlessly and deterministically.
 */

export class FakePanelWindow implements PanelWindowHandle {
  visible = false;
  destroyed = false;
  focusCount = 0;
  readonly sent: EventEnvelope[] = [];
  readonly #closedListeners: (() => void)[] = [];
  /** When set, `send` throws it once — simulates a window dying mid-send. */
  sendError: Error | null = null;

  show(): void {
    this.visible = true;
  }

  hide(): void {
    this.visible = false;
  }

  focus(): void {
    this.focusCount += 1;
  }

  isVisible(): boolean {
    return !this.destroyed && this.visible;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.visible = false;
  }

  send(envelope: EventEnvelope): void {
    if (this.sendError !== null) {
      const error = this.sendError;
      this.sendError = null;
      throw error;
    }
    this.sent.push(envelope);
  }

  onClosed(listener: () => void): void {
    this.#closedListeners.push(listener);
  }

  /** Simulates the OS closing the window. */
  closeExternally(): void {
    this.destroyed = true;
    this.visible = false;
    for (const listener of this.#closedListeners) {
      listener();
    }
  }
}

export class FakePanelHost implements PanelWindowHost {
  readonly created: FakePanelWindow[] = [];

  create(): FakePanelWindow {
    const window = new FakePanelWindow();
    this.created.push(window);
    return window;
  }

  get latest(): FakePanelWindow | undefined {
    return this.created.at(-1);
  }
}

export class FakeTray implements TrayHandle {
  tooltip: string | null = null;
  menu: readonly TrayMenuItem[] = [];
  destroyed = false;
  #clickListener: (() => void) | null = null;

  setToolTip(tooltip: string): void {
    this.tooltip = tooltip;
  }

  setMenu(items: readonly TrayMenuItem[]): void {
    this.menu = items;
  }

  onClick(listener: () => void): void {
    this.#clickListener = listener;
  }

  destroy(): void {
    this.destroyed = true;
  }

  click(): void {
    this.#clickListener?.();
  }

  item(id: string): TrayMenuItem | undefined {
    return this.menu.find((entry) => entry.id === id);
  }
}

export class FakeTrayHost implements TrayHost {
  readonly created: FakeTray[] = [];
  /** When set, `create` throws it — the "no status area" case. */
  failure: Error | null = null;

  create(): FakeTray {
    if (this.failure !== null) {
      throw this.failure;
    }
    const tray = new FakeTray();
    this.created.push(tray);
    return tray;
  }

  get latest(): FakeTray | undefined {
    return this.created.at(-1);
  }
}

export interface PermissionHarnessOptions {
  /** Starting permission state. Defaults to nothing having been asked for. */
  readonly fixture?: PermissionFixtureName;
  /** Host platform the settings seam sees. Defaults to a machine without one. */
  readonly platform?: string;
  /** Omit the fixture source, as a build against a real platform would. */
  readonly withFixtures?: boolean;
  readonly now?: () => number;
}

export interface PermissionHarness {
  readonly gate: PermissionGate;
  readonly adapter: FakePermissionAdapter;
}

/**
 * A {@link PermissionGate} over the PR-001 fake adapter, wired exactly as
 * `main/index.ts` wires it. Tests drive the real gate rather than a stand-in,
 * so the behaviour they assert is the behaviour the app has.
 */
export function permissionHarness(options: PermissionHarnessOptions = {}): PermissionHarness {
  const adapter = new FakePermissionAdapter();
  const withFixtures = options.withFixtures ?? true;
  const fixtures = withFixtures
    ? createPermissionFixtureSource(adapter, options.fixture ?? 'unknown')
    : undefined;
  const gate = new PermissionGate({
    adapter,
    settings: createSettingsShortcut({ platform: options.platform ?? 'linux', adapter }),
    ...(fixtures === undefined ? {} : { fixtures }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { gate, adapter };
}

export interface WindowHarnessOptions {
  readonly permissions: ObservationPermissionSource;
  readonly controller?: FakeInteractionController;
  readonly adapter?: FakeWindowAdapter;
  readonly demoEvents?: boolean;
  readonly now?: () => number;
}

export interface WindowHarness {
  readonly gate: WindowGate;
  readonly adapter: FakeWindowAdapter;
  readonly controller: FakeInteractionController;
  /** The panel's fake window-event controls, as `main/index.ts` builds them. */
  readonly demo: WindowDemoDriver;
}

/**
 * A {@link WindowGate} over the PR-001 fake window adapter and fake interaction
 * controller, wired exactly as `main/index.ts` wires it — including the
 * `ObservationInteraction` bridge, so what the tests drive is the shipped path
 * rather than a stand-in for it.
 */
export function windowHarness(options: WindowHarnessOptions): WindowHarness {
  const controller = options.controller ?? new FakeInteractionController();
  const adapter = options.adapter ?? new FakeWindowAdapter();
  const gate = new WindowGate({
    windows: adapter,
    interaction: createFakeObservationInteraction(controller),
    permissions: options.permissions,
    demoEvents: options.demoEvents ?? true,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    gate,
    adapter,
    controller,
    demo: createFakeWindowDemoDriver({
      adapter,
      selected: () => controller.snapshot().selectedWindow,
    }),
  };
}

/**
 * A clock the test moves by hand.
 *
 * The §17 timings are differences between two readings of the gate's clock, so
 * a test that could not control it could only assert "some number was
 * recorded". With this, the expected millisecond value is the one the test
 * advanced by.
 */
export function testClock(start = 1_700_000_000_000): ReplayClock {
  let value = start;
  return {
    now: () => value,
    advance: (milliseconds: number) => {
      value += Math.max(0, milliseconds);
    },
  };
}

export interface ConversationHarnessOptions {
  readonly controller?: FakeInteractionController;
  readonly clock?: ReplayClock;
  readonly hotkey?: HotkeyAvailability;
  /** Omit for a build with no hotkey adapter at all. */
  readonly withHotkey?: boolean;
  readonly disclosure?: SpeechRecognitionDisclosure;
  readonly capacity?: number;
  readonly demoFixtures?: boolean;
}

export interface ConversationHarness {
  readonly gate: ConversationGate;
  readonly controller: FakeInteractionController;
  readonly clock: ReplayClock;
  readonly hotkeyAdapter: FakeHotkeyAdapter;
  /** The panel's fixture replay, as `main/index.ts` builds it. */
  readonly replay: ConversationFixtureDriver;
}

/**
 * A {@link ConversationGate} wired exactly as `main/index.ts` wires it, so what
 * the tests drive is the shipped path rather than a stand-in for it.
 */
export function conversationHarness(options: ConversationHarnessOptions = {}): ConversationHarness {
  const controller = options.controller ?? new FakeInteractionController();
  const clock = options.clock ?? testClock();
  const hotkeyAdapter = new FakeHotkeyAdapter({
    availability: options.hotkey ?? { status: 'active' },
  });
  const speech = createFakeSpeechDisclosureSource(options.disclosure ?? null);
  const gate = new ConversationGate({
    interaction: controller,
    ...(options.withHotkey === false ? {} : { hotkey: hotkeyAdapter }),
    ...(speech === undefined ? {} : { speech }),
    demoFixtures: options.demoFixtures ?? true,
    now: () => clock.now(),
    ...(options.capacity === undefined ? {} : { telemetry: { capacity: options.capacity } }),
  });
  return {
    gate,
    controller,
    clock,
    hotkeyAdapter,
    replay: createFakeConversationDriver({ controller, gate, clock }),
  };
}

export class FakeSingleInstanceHost implements SingleInstanceHost {
  quitCount = 0;
  #secondInstanceListener: ((argv: readonly string[]) => void) | null = null;

  constructor(private readonly lockGranted: boolean) {}

  requestSingleInstanceLock(): boolean {
    return this.lockGranted;
  }

  onSecondInstance(listener: (argv: readonly string[]) => void): void {
    this.#secondInstanceListener = listener;
  }

  quit(): void {
    this.quitCount += 1;
  }

  get hasSecondInstanceListener(): boolean {
    return this.#secondInstanceListener !== null;
  }

  launchSecondInstance(argv: readonly string[] = ['pilot']): void {
    this.#secondInstanceListener?.(argv);
  }
}
