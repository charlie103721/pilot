import {
  PilotError,
  isPointInRect,
  type AccessibilityNode,
  type CredentialRef,
  type ObservedWindow,
  type PermissionKind,
  type PermissionSnapshot,
  type PermissionStatus,
  type ScreenPoint,
  type ScreenRect,
  type WindowGeometry,
  type WindowId,
} from '@pilot/shared';
import type {
  AccessibilityAdapter,
  CredentialAdapter,
  ManagedPlatformAdapter,
  PermissionAdapter,
  WindowAdapter,
  WindowEvent,
} from '../adapters.js';
import { Emitter } from './support.js';
import {
  FIXTURE_ACCESSIBILITY_NODE,
  FIXTURE_GEOMETRY_BY_WINDOW,
  FIXTURE_PERMISSIONS_GRANTED,
  FIXTURE_WINDOWS,
  FIXTURE_WINDOW_RETINA,
} from './fixtures.js';
import { FakeObservationAdapter } from './observation.js';
import { FakeSpeechInputAdapter, FakeSpeechOutputAdapter } from './speech.js';

/** Deterministic `PermissionAdapter`. Grants only when a test says so. */
export class FakePermissionAdapter implements PermissionAdapter {
  readonly #emitter = new Emitter<PermissionStatus>();
  #snapshot: PermissionSnapshot;
  readonly openedSettings: PermissionKind[] = [];
  readonly requested: PermissionKind[] = [];
  /** Whether a `request()` call resolves to `granted` (default) or `denied`. */
  grantOnRequest = true;

  constructor(snapshot: PermissionSnapshot = FIXTURE_PERMISSIONS_GRANTED) {
    this.#snapshot = { ...snapshot };
  }

  subscribe = this.#emitter.subscribe;

  async status(kind: PermissionKind): Promise<PermissionStatus> {
    return this.#snapshot[kind];
  }

  async snapshot(): Promise<PermissionSnapshot> {
    return { ...this.#snapshot };
  }

  async request(kind: PermissionKind): Promise<PermissionStatus> {
    this.requested.push(kind);
    const current = this.#snapshot[kind];
    if (!current.canRequest) {
      return current;
    }
    const next: PermissionStatus = {
      kind,
      state: this.grantOnRequest ? 'granted' : 'denied',
      canRequest: false,
    };
    this.set(next);
    return next;
  }

  async openSettings(kind: PermissionKind): Promise<void> {
    this.openedSettings.push(kind);
  }

  /** Test control: force a permission into a state and notify subscribers. */
  set(status: PermissionStatus): void {
    const next: PermissionSnapshot = { ...this.#snapshot };
    next[status.kind] = status;
    this.#snapshot = next;
    this.#emitter.emit(status);
  }
}

/** Deterministic `WindowAdapter` over the fixture window list. */
export class FakeWindowAdapter implements WindowAdapter {
  readonly #emitter = new Emitter<WindowEvent>();
  #windows: ObservedWindow[];
  readonly #geometry: Map<string, WindowGeometry>;

  constructor(
    windows: readonly ObservedWindow[] = FIXTURE_WINDOWS,
    geometry: ReadonlyMap<string, WindowGeometry> = FIXTURE_GEOMETRY_BY_WINDOW,
  ) {
    this.#windows = [...windows];
    this.#geometry = new Map(geometry);
  }

  subscribe = this.#emitter.subscribe;

  async list(): Promise<readonly ObservedWindow[]> {
    return [...this.#windows];
  }

  async get(windowId: WindowId): Promise<ObservedWindow | null> {
    return this.#windows.find((window) => window.windowId === windowId) ?? null;
  }

  async geometry(windowId: WindowId): Promise<WindowGeometry | null> {
    return this.#geometry.get(windowId) ?? null;
  }

  /**
   * Test control: replace a window's title, bounds or scale and emit
   * `window-changed`. Adds the window when the list does not hold it yet.
   */
  changeWindow(window: ObservedWindow): void {
    const index = this.#windows.findIndex((entry) => entry.windowId === window.windowId);
    if (index >= 0) {
      this.#windows[index] = window;
    } else {
      this.#windows.push(window);
    }
    this.#emitter.emit({ type: 'window-changed', window });
  }

  /** Test control: emit `window-list-changed` without changing the list. */
  notifyWindowListChanged(): void {
    this.#emitter.emit({ type: 'window-list-changed' });
  }

  /** Test control: remove a window and emit `window-closed`. */
  closeWindow(windowId: WindowId): void {
    this.#windows = this.#windows.filter((window) => window.windowId !== windowId);
    this.#geometry.delete(windowId);
    this.#emitter.emit({ type: 'window-closed', windowId });
  }

  /** Test control: emit lock/unlock so buffer-clearing paths can be exercised. */
  lockScreen(): void {
    this.#emitter.emit({ type: 'screen-locked' });
  }

  unlockScreen(): void {
    this.#emitter.emit({ type: 'screen-unlocked' });
  }
}

export interface FakeAccessibilityElement {
  readonly bounds: ScreenRect;
  readonly node: AccessibilityNode;
}

/** Deterministic `AccessibilityAdapter` with a fixed pointer and hit-test map. */
export class FakeAccessibilityAdapter implements AccessibilityAdapter {
  #pointer: ScreenPoint;
  #elements: FakeAccessibilityElement[];

  constructor(
    pointer: ScreenPoint = { x: 730, y: 495 },
    elements: readonly FakeAccessibilityElement[] = [
      {
        bounds: FIXTURE_ACCESSIBILITY_NODE.bounds ?? { x: 700, y: 480, width: 60, height: 30 },
        node: FIXTURE_ACCESSIBILITY_NODE,
      },
    ],
  ) {
    this.#pointer = pointer;
    this.#elements = [...elements];
  }

  async getPointer(): Promise<ScreenPoint> {
    return { ...this.#pointer };
  }

  async elementAt(point: ScreenPoint): Promise<AccessibilityNode | null> {
    return this.#elements.find((element) => isPointInRect(point, element.bounds))?.node ?? null;
  }

  /** Test control: move the pointer. */
  setPointer(point: ScreenPoint): void {
    this.#pointer = { ...point };
  }

  setElements(elements: readonly FakeAccessibilityElement[]): void {
    this.#elements = [...elements];
  }
}

/** In-memory `CredentialAdapter`. Secrets never leave the instance. */
export class FakeCredentialAdapter implements CredentialAdapter {
  readonly #secrets = new Map<string, string>();
  #available = true;

  isAvailable(): boolean {
    return this.#available;
  }

  async get(ref: CredentialRef): Promise<string | null> {
    this.#assertAvailable();
    return this.#secrets.get(ref) ?? null;
  }

  async set(ref: CredentialRef, secret: string): Promise<void> {
    this.#assertAvailable();
    this.#secrets.set(ref, secret);
  }

  async delete(ref: CredentialRef): Promise<void> {
    this.#assertAvailable();
    this.#secrets.delete(ref);
  }

  async list(): Promise<readonly CredentialRef[]> {
    this.#assertAvailable();
    return [...this.#secrets.keys()] as CredentialRef[];
  }

  /** Test control: simulate a machine with no secure storage. */
  setAvailable(available: boolean): void {
    this.#available = available;
  }

  #assertAvailable(): void {
    if (!this.#available) {
      throw new PilotError('platform-unavailable', 'Secure credential storage is unavailable', {
        userMessage: 'Pilot cannot reach secure storage on this machine.',
      });
    }
  }
}

export interface FakePlatformAdapterOptions {
  readonly permissions?: FakePermissionAdapter;
  readonly windows?: FakeWindowAdapter;
  readonly observation?: FakeObservationAdapter;
  readonly accessibility?: FakeAccessibilityAdapter;
  readonly speechInput?: FakeSpeechInputAdapter;
  readonly speechOutput?: FakeSpeechOutputAdapter;
  readonly credentials?: FakeCredentialAdapter;
}

/**
 * Full fake `PlatformAdapter`, satisfying the same interface the macOS
 * implementation will satisfy in PR-011…PR-015. Each member is also usable on
 * its own.
 */
export class FakePlatformAdapter implements ManagedPlatformAdapter {
  readonly permissions: FakePermissionAdapter;
  readonly windows: FakeWindowAdapter;
  readonly observation: FakeObservationAdapter;
  readonly accessibility: FakeAccessibilityAdapter;
  readonly speechInput: FakeSpeechInputAdapter;
  readonly speechOutput: FakeSpeechOutputAdapter;
  readonly credentials: FakeCredentialAdapter;

  started = false;
  disposed = false;
  clearBufferCount = 0;

  constructor(options: FakePlatformAdapterOptions = {}) {
    this.permissions = options.permissions ?? new FakePermissionAdapter();
    this.windows = options.windows ?? new FakeWindowAdapter();
    this.observation = options.observation ?? new FakeObservationAdapter();
    this.accessibility = options.accessibility ?? new FakeAccessibilityAdapter();
    this.speechInput = options.speechInput ?? new FakeSpeechInputAdapter();
    this.speechOutput = options.speechOutput ?? new FakeSpeechOutputAdapter();
    this.credentials = options.credentials ?? new FakeCredentialAdapter();
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async dispose(): Promise<void> {
    await this.clearBuffers();
    this.disposed = true;
    this.started = false;
  }

  async clearBuffers(): Promise<void> {
    this.clearBufferCount += 1;
    await this.observation.stop();
    await this.speechOutput.stop();
  }
}

export function createFakePlatformAdapter(
  options: FakePlatformAdapterOptions = {},
): FakePlatformAdapter {
  return new FakePlatformAdapter(options);
}

/** The window fixtures select by default across the fakes. */
export const DEFAULT_FAKE_WINDOW: ObservedWindow = FIXTURE_WINDOW_RETINA;
