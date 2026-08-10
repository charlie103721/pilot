import {
  PERMISSION_KINDS,
  PilotError,
  isAttributionFailure,
  nullLogger,
  type Logger,
  type PermissionAttribution,
  type PermissionKind,
  type PermissionSnapshot,
  type PermissionStatus,
} from '@pilot/shared';
import type { PermissionAdapter, Unsubscribe } from '@pilot/platform';
import { Poller } from '../polling.js';
import {
  permissionAttributionOperation,
  permissionOpenSettingsOperation,
  permissionRequestOperation,
  permissionSnapshotOperation,
  permissionStatusOperation,
  type PermissionProbe,
} from '../protocol/permission-ops.js';
import { TypedEmitter } from '../transport/emitter.js';
import type { NativeHelperTransport } from '../transport/helper-transport.js';
import { assertAttributionUsable, evaluateAttribution } from './attribution.js';

/**
 * macOS `PermissionAdapter` (system-design §5), backed by the native helper.
 *
 * ## The four states are kept apart
 *
 * `unknown`, `denied`, `restricted` and `granted` mean four different things
 * and drive four different pieces of UI, so none of them is allowed to
 * collapse into another:
 *
 * - `unknown` — nobody has asked yet, or the API cannot say. Offer the prompt.
 * - `denied` — the user said no. The prompt will not appear again; send them
 *   to System Settings.
 * - `restricted` — policy (Screen Time, MDM) forbids it. Neither the prompt
 *   nor System Settings will help; say so instead of looping the user.
 * - `granted` — usable.
 *
 * Microphone and Speech Recognition report all four natively. Screen Recording
 * and Accessibility expose a single boolean, so a `false` from them is
 * `unknown` until a prompt has actually been raised and not honoured — see
 * `src/protocol/permission-ops.ts`. Never `denied` on the strength of a
 * boolean that also means "not asked yet".
 *
 * ## Attribution gates everything
 *
 * Before any status is reported, the adapter establishes which process macOS
 * credits grants to (`src/permissions/attribution.ts`). Under the default
 * `enforce` policy a failing verdict makes `status`, `snapshot` and `request`
 * throw `permission-attribution-mismatch` rather than return states that would
 * be false. A permission Pilot cannot use is not a permission Pilot has, and
 * reporting `granted` in that situation is the exact silent wrong answer this
 * PR exists to prevent.
 */

export type AttributionPolicy =
  /** A failing verdict makes every permission call throw. The default. */
  | 'enforce'
  /** A failing verdict is logged and exposed, but calls still answer. */
  | 'warn'
  /** Attribution is not checked at all. For tests that are not about it. */
  | 'off';

export interface MacPermissionAdapterOptions {
  readonly transport: NativeHelperTransport;
  /**
   * Identity the operating system must credit: the parent application bundle.
   * Supplied by the host — in the desktop app, from Electron's own bundle —
   * because the helper must be compared against a value it cannot invent.
   */
  readonly expectedBundleIdentifier?: string | null;
  readonly expectedBundlePath?: string | null;
  /** Defaults to `process.pid`, the process that spawned the helper. */
  readonly hostPid?: number;
  readonly attributionPolicy?: AttributionPolicy;
  /** Poll interval for change notifications. Only runs while subscribed. */
  readonly pollIntervalMs?: number;
  readonly logger?: Logger;
  readonly clock?: () => number;
}

interface PermissionEvents extends Record<string, unknown> {
  status: PermissionStatus;
}

function toStatus(probe: PermissionProbe): PermissionStatus {
  return { kind: probe.kind, state: probe.state, canRequest: probe.canRequest };
}

function sameStatus(a: PermissionStatus, b: PermissionStatus): boolean {
  return a.state === b.state && a.canRequest === b.canRequest;
}

/** Settings pane URLs, so the user is one click from the right row. */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

export class MacPermissionAdapter implements PermissionAdapter {
  readonly #transport: NativeHelperTransport;
  readonly #emitter = new TypedEmitter<PermissionEvents>();
  readonly #logger: Logger;
  readonly #clock: () => number;
  readonly #policy: AttributionPolicy;
  readonly #expected: {
    readonly bundleIdentifier: string | null;
    readonly bundlePath: string | null;
    readonly hostPid: number;
  };
  readonly #poller: Poller;
  readonly #last = new Map<PermissionKind, PermissionStatus>();

  #subscribers = 0;
  #attribution: PermissionAttribution | undefined;
  #attributionInFlight: Promise<PermissionAttribution> | undefined;

  constructor(options: MacPermissionAdapterOptions) {
    this.#transport = options.transport;
    this.#logger = (options.logger ?? nullLogger).child('mac-permissions');
    this.#clock = options.clock ?? (() => Date.now());
    this.#policy = options.attributionPolicy ?? 'enforce';
    this.#expected = {
      bundleIdentifier: options.expectedBundleIdentifier ?? null,
      bundlePath: options.expectedBundlePath ?? null,
      hostPid: options.hostPid ?? process.pid,
    };
    this.#poller = new Poller(() => this.#poll(), {
      intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      logger: this.#logger,
      name: 'permissions',
    });
  }

  /** The last attribution verdict, if one has been established. */
  get lastAttribution(): PermissionAttribution | undefined {
    return this.#attribution;
  }

  subscribe = (listener: (status: PermissionStatus) => void): Unsubscribe => {
    const off = this.#emitter.on('status', listener);
    this.#subscribers += 1;
    this.#poller.start();
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      off();
      this.#subscribers -= 1;
      if (this.#subscribers <= 0) {
        this.#subscribers = 0;
        this.#poller.stop();
      }
    };
  };

  async status(kind: PermissionKind): Promise<PermissionStatus> {
    await this.#gate();
    const response = await this.#transport.request(permissionStatusOperation, { kind });
    return this.#record(toStatus(response.payload.probe));
  }

  async snapshot(): Promise<PermissionSnapshot> {
    await this.#gate();
    const response = await this.#transport.request(permissionSnapshotOperation, {});
    return this.#toSnapshot(response.payload.probes);
  }

  async request(kind: PermissionKind): Promise<PermissionStatus> {
    await this.#gate();
    const response = await this.#transport.request(permissionRequestOperation, { kind });
    const status = this.#record(toStatus(response.payload.probe));
    if (!response.payload.prompted) {
      this.#logger.info('macOS refused to prompt; System Settings is the only route', { kind });
    }
    return status;
  }

  async openSettings(kind: PermissionKind): Promise<void> {
    const response = await this.#transport.request(permissionOpenSettingsOperation, { kind });
    if (!response.payload.opened) {
      throw new PilotError('platform-unavailable', `Could not open System Settings for ${kind}`, {
        userMessage:
          'Pilot could not open System Settings. Open it yourself and find Privacy & Security.',
        retryable: true,
        details: { kind, target: response.payload.target },
      });
    }
  }

  /**
   * Establishes which process macOS credits permission grants to.
   *
   * Cached: the answer cannot change while the helper is running, and the
   * probe costs a round trip. `refreshAttribution()` re-runs it after a helper
   * restart, when a new process may have a new responsible process.
   */
  async attribution(): Promise<PermissionAttribution> {
    const cached = this.#attribution;
    if (cached !== undefined) {
      return cached;
    }
    const inFlight = this.#attributionInFlight;
    if (inFlight !== undefined) {
      return inFlight;
    }
    const promise = this.#probeAttribution().finally(() => {
      this.#attributionInFlight = undefined;
    });
    this.#attributionInFlight = promise;
    return promise;
  }

  /** Discards the cached verdict and probes again. */
  async refreshAttribution(): Promise<PermissionAttribution> {
    this.#attribution = undefined;
    return this.attribution();
  }

  /** Runs one poll immediately; used after a helper restart and by tests. */
  async refresh(): Promise<void> {
    await this.#poller.refresh();
  }

  dispose(): void {
    this.#poller.stop();
    this.#subscribers = 0;
  }

  // -------------------------------------------------------------------------

  async #probeAttribution(): Promise<PermissionAttribution> {
    const response = await this.#transport.request(permissionAttributionOperation, {
      expected: {
        bundleIdentifier: this.#expected.bundleIdentifier,
        bundlePath: this.#expected.bundlePath,
        hostPid: this.#expected.hostPid,
      },
    });
    const attribution = evaluateAttribution({
      evidence: response.payload.evidence,
      expected: this.#expected,
      checkedAt: this.#clock(),
    });
    this.#attribution = attribution;

    if (isAttributionFailure(attribution)) {
      // Loud by design: this is the failure the whole permission model rests
      // on, and it is invisible from the outside.
      this.#logger.error('macOS attributes permissions to the wrong process', {
        verdict: attribution.verdict,
        confidence: attribution.confidence,
        reason: attribution.reason,
        expectedBundleIdentifier: attribution.expected.bundleIdentifier,
        attributedBundleIdentifier: attribution.attributed.bundleIdentifier,
      });
    } else if (attribution.verdict === 'unknown') {
      this.#logger.warn('permission attribution could not be determined', {
        reason: attribution.reason,
        confidence: attribution.confidence,
      });
    } else {
      this.#logger.info('permission attribution verified', {
        confidence: attribution.confidence,
        reason: attribution.reason,
      });
    }
    return attribution;
  }

  async #gate(): Promise<void> {
    if (this.#policy === 'off') {
      return;
    }
    const attribution = await this.attribution();
    if (this.#policy === 'enforce') {
      assertAttributionUsable(attribution);
    }
  }

  #toSnapshot(probes: readonly PermissionProbe[]): PermissionSnapshot {
    const byKind = new Map<PermissionKind, PermissionStatus>();
    for (const probe of probes) {
      byKind.set(probe.kind, this.#record(toStatus(probe)));
    }
    const missing = PERMISSION_KINDS.filter((kind) => !byKind.has(kind));
    if (missing.length > 0) {
      throw new PilotError('invalid-request', 'Helper omitted permissions from its snapshot', {
        userMessage: 'Pilot could not read its macOS permissions.',
        retryable: false,
        details: { missing },
      });
    }
    return {
      'screen-recording': byKind.get('screen-recording')!,
      accessibility: byKind.get('accessibility')!,
      microphone: byKind.get('microphone')!,
      'speech-recognition': byKind.get('speech-recognition')!,
    };
  }

  /** Stores a status and emits when it differs from the last one seen. */
  #record(status: PermissionStatus): PermissionStatus {
    const previous = this.#last.get(status.kind);
    this.#last.set(status.kind, status);
    if (previous !== undefined && !sameStatus(previous, status)) {
      this.#emitter.emit('status', status);
    }
    return status;
  }

  async #poll(): Promise<void> {
    if (this.#policy === 'enforce') {
      const attribution = await this.attribution();
      if (isAttributionFailure(attribution)) {
        // Polling stops mattering once attribution is broken; every status
        // would be untrustworthy. The error surfaced at the call sites.
        return;
      }
    }
    const response = await this.#transport.request(permissionSnapshotOperation, {});
    for (const probe of response.payload.probes) {
      this.#record(toStatus(probe));
    }
  }
}
