import { nullLogger, toPilotError, type Logger } from '@pilot/shared';
import type {
  AccessibilityAdapter,
  ObservationAdapter,
  PermissionAdapter,
  WindowAdapter,
} from '@pilot/platform';
import { FakePermissionAdapter, FakeWindowAdapter } from '@pilot/platform/fakes';
import {
  MacAccessibilityAdapter,
  MacHotkeyAdapter,
  MacObservationAdapter,
  MacPermissionAdapter,
  MacSpeechInputAdapter,
  MacSpeechOutputAdapter,
  MacWindowAdapter,
  NativeHelperTransport,
  resolveHelperBinary,
  type AttributionPolicy,
  type CaptureEncoding,
} from '@pilot/platform-mac';

/**
 * Which platform implementation the shell runs on, decided once (PR-028).
 *
 * PR-029 left `FakePermissionAdapter` and `FakeWindowAdapter` wired into
 * `main/index.ts` with PR-028's name against them. This is that replacement,
 * and it is deliberately a *choice made in one place* rather than a `darwin`
 * check sprinkled through the composition root: every consumer downstream sees
 * the same four adapter references whichever branch was taken, and the branch
 * that was taken is reported (`kind`, `reason`) instead of inferred.
 *
 * Three kinds, in the order they are tried:
 *
 * | kind | when | what capture is |
 * | --- | --- | --- |
 * | `macos-stub` | `PILOT_HELPER_STUB_PATH` is set | the **real** macOS adapters over the Node helper stub |
 * | `macos` | `process.platform === 'darwin'` and a helper binary exists | the real adapters over the real Swift helper |
 * | `fakes` | anything else | `FakeWindowAdapter` + `FakePermissionAdapter`, **and no capture at all** |
 *
 * ## Why `macos-stub` exists
 *
 * There is no macOS and no Swift toolchain on the development machine (runbook
 * §5 amendment 8), so the real capture path could otherwise only ever be run by
 * the user. `packages/platform-mac/test/support/helper-stub.ts` is a second,
 * independent implementation of the helper's wire protocol, written for exactly
 * this: pointing the transport at it runs `MacObservationAdapter`,
 * `MacWindowAdapter`, `MacPermissionAdapter` and `MacAccessibilityAdapter` — the
 * shipping code, unmodified — against a scripted desktop. Everything below the
 * protocol (ScreenCaptureKit, TCC, the accessibility tree) is still unverified,
 * and `docs/handoff.md` §1 says so.
 *
 * ## Why `fakes` has no `ObservationAdapter`
 *
 * `FakeObservationAdapter` hands out fixture frames only when a test calls
 * `emitNext()`, so an app wired to it captures nothing while looking as though
 * it might — the failure shape runbook cross-lane issue 10 records against
 * `FakeSpeechOutputAdapter`. So this build reports `capture: null`, and
 * `ScreenContextService` refuses every observation with a typed error that
 * names the missing capture source rather than an empty ring that names
 * nothing.
 *
 * ## Voice (PR-032)
 *
 * `hotkey` and `speechInput` follow `capture`: real on both helper branches,
 * `null` on `fakes`. They differ from capture in what the composition root does
 * about it — `main/index.ts` substitutes `FakeHotkeyAdapter` and
 * `FakeSpeechInputAdapter` when they are `null`, because unlike
 * `FakeObservationAdapter` both of those *do* complete on their own (the fake
 * recogniser finalises on `stop()`, which is the release of the key) and
 * because PR-010's `PILOT_HOTKEY_FIXTURE` states have nowhere else to live.
 * The substitution is visible at the call site, and the boundary table in
 * `main/index.ts` says which build is which.
 *
 * ## Speech output (PR-033)
 *
 * `speechOutput` is the symmetric member to `speechInput`, and it follows the
 * same rule: real on both helper branches, `null` on `fakes`. What the
 * composition root does about `null` differs from voice input, and deliberately
 * — there is no fake synthesiser anywhere. `main/speech-runtime.ts` takes the
 * `null` as its degraded mode and completes every chunk silently, which is what
 * a Mac with no installed voice does too (system-design §16: the streamed text
 * is what the user keeps either way).
 */

/** Development switch: run the macOS stack against the Node helper stub. */
export const HELPER_STUB_PATH_ENV_VAR = 'PILOT_HELPER_STUB_PATH';

/** Forces the fake adapters even on a Mac with a helper. */
export const PLATFORM_ENV_VAR = 'PILOT_PLATFORM';

/**
 * Wire encoding asked of capture, closing runbook follow-up 18.
 *
 * PR-018 measured a **`jpeg` source frame** costing ~165 ms of pure-JS decode
 * per observation that needs a pointer crop — the only path over §17's 150 ms
 * preprocessing budget — and a second JPEG generation roughly doubling the
 * share of visibly damaged pixels on exactly the small text grounding depends
 * on. `png` costs neither, and unlike `bgra` it fits the 16 MiB ring ceiling
 * (§17): 1440×960 `bgra` is 5.2 MB a frame, so a three-second ring at 3 FPS
 * would need ~47 MB.
 *
 * No contract changed: `FrameEncoding` already admits all three and
 * `CaptureOptions` says nothing about encoding. `MacObservationAdapter`'s own
 * default is still `jpeg`, which is PR-012's to keep or change; this is the
 * composition root, and it is the only place in the product that starts a
 * capture stream.
 */
export const CAPTURE_ENCODING: CaptureEncoding = 'png';

export type PlatformKind = 'macos' | 'macos-stub' | 'fakes';

export interface PlatformRuntime {
  readonly kind: PlatformKind;
  /** Why this kind was chosen. Always present, including for the real thing. */
  readonly reason: string;
  readonly permissions: PermissionAdapter;
  readonly windows: WindowAdapter;
  /** `null` when this build cannot capture anything. See the note above. */
  readonly capture: ObservationAdapter | null;
  readonly accessibility: AccessibilityAdapter | null;
  /**
   * The global push-to-talk tap (PR-032), or `null` on the fake build.
   *
   * `null` rather than a fake for the same reason `capture` is: a
   * `FakeHotkeyAdapter` here would report `active` while no key on the machine
   * could ever reach it. `main/index.ts` supplies the fake explicitly when this
   * is `null`, so the fixture states PR-010 built (`PILOT_HOTKEY_FIXTURE`) stay
   * reachable on a Linux development run and the substitution is visible at the
   * composition root rather than hidden in here.
   */
  readonly hotkey: MacHotkeyAdapter | null;
  /**
   * Apple Speech (PR-014) behind the helper, or `null` on the fake build.
   *
   * Concrete rather than `SpeechInputAdapter` because two consumers need more
   * than the interface: `ConversationGate` takes `disclosure()` (runbook
   * follow-up 13) and disposal has to release the microphone.
   */
  readonly speechInput: MacSpeechInputAdapter | null;
  /**
   * `AVSpeechSynthesizer` behind the helper (PR-014/PR-033), or `null` on the
   * fake build.
   *
   * Concrete rather than `SpeechOutputAdapter` for the same reason
   * `speechInput` is: disposal has to silence anything still queued, and
   * `voiceCatalog()` is richer than the contract's identifier list.
   */
  readonly speechOutput: MacSpeechOutputAdapter | null;
  /**
   * Present only on the fake build. The panel's window-lifecycle controls act
   * on it, and `main/index.ts` offers them only when it is here — so a build on
   * the real enumeration cannot be asked to close a window it does not own.
   */
  readonly fakeWindows: FakeWindowAdapter | null;
  /** Present only on the fake build; drives the permission fixtures. */
  readonly fakePermissions: FakePermissionAdapter | null;
  readonly transport: NativeHelperTransport | null;
  /** Starts the helper, when there is one. Resolves immediately otherwise. */
  start(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PlatformRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** `process.resourcesPath` in a packaged app; absent in development. */
  readonly resourcesPath?: string | undefined;
  /**
   * `app.getAppPath()` (PR-042). Lets a `pnpm dev` run find a helper the user
   * built with `swift build`, which the bundled main process cannot locate from
   * its own module URL — see `workspaceNativeDirectory` in
   * `@pilot/platform-mac`.
   */
  readonly appPath?: string | undefined;
  readonly logger?: Logger;
  /** Injected by tests and by the demo, which own the helper's lifetime. */
  readonly transport?: NativeHelperTransport;
  /** Overrides {@link CAPTURE_ENCODING}. Present so a test can read it back. */
  readonly encoding?: CaptureEncoding;
  /**
   * Poll interval for the window list and the permission states. The macOS
   * adapters observe change by re-reading a snapshot and diffing it (PR-011);
   * a demo or a test sets this long and calls `refresh()` itself, so nothing
   * races wall time.
   */
  readonly pollIntervalMs?: number;
  /**
   * Drain interval for the capture stream. Defaults to the adapter's own
   * resolved sample interval, which is what the app wants.
   *
   * A test or a demo that pushes its own frames into the ring sets it long and
   * drains by hand: the stub's frames are not a decodable image (runbook
   * cross-lane issue 11), so a stub frame arriving between a synthetic
   * screenshot and the question anchored on it turns `moment: 'question'` into
   * a decode failure — a real race, and one that would make the anchor look
   * flaky rather than wrong.
   */
  readonly capturePollIntervalMs?: number;
  /**
   * The identity macOS must credit a grant to (PR-011). In the packaged app it
   * is Electron's own bundle; against the stub it is whatever the stub claims,
   * which is how the attribution wiring is exercised at all on Linux.
   */
  readonly permissionIdentity?: {
    readonly expectedBundleIdentifier?: string | null;
    readonly expectedBundlePath?: string | null;
    readonly hostPid?: number;
  };
  /**
   * Defaults to `enforce` against a real helper and `warn` against the stub.
   *
   * Under `warn` a failing verdict still lets permission states through, which
   * is exactly the case {@link observationPermissionConditions} has to catch:
   * "macOS says granted" and "the grant reaches this process" are different
   * claims, and only the second one entitles Pilot to look at a screen.
   */
  readonly attributionPolicy?: AttributionPolicy;
  /**
   * Stuck-key watchdog interval for the push-to-talk tap (PR-032). A demo or a
   * test sets it long and calls `MacHotkeyAdapter.sweep()` itself, so a
   * walkthrough never races a one-second timer.
   */
  readonly holdWatchdogIntervalMs?: number;
  /** Drain interval for the recogniser's event queue. See `MacSpeechInputAdapter`. */
  readonly speechPollIntervalMs?: number;
  /** system-design §11. Defaults to `true`; only a test turns it off. */
  readonly requireOnDeviceSpeech?: boolean;
}

/** Overrides the Node binary used to run the helper stub. */
export const HELPER_STUB_NODE_ENV_VAR = 'PILOT_HELPER_STUB_NODE';

/**
 * The bundle identity the helper stub claims (`DEFAULT_ATTRIBUTION` in
 * `packages/platform-mac/test/support/helper-stub.ts`).
 *
 * Used only on the `macos-stub` branch, and only as a default. Without it PR-011
 * compares the stub's invented `/Applications/Pilot.app` against this process's
 * real identity, returns `bundle-mismatch`, and the observation path correctly
 * refuses everything — which is a true answer to a question nobody asked, and it
 * would make the stub build useless for looking at anything. A caller that wants
 * the *failing* verdict scripts it on the stub side (`attribution.
 * responsibleProcessPid`), which is what the tests and the demo do.
 */
const STUB_IDENTITY = {
  expectedBundleIdentifier: 'com.pilot.app',
  expectedBundlePath: '/Applications/Pilot.app',
  hostPid: 1234,
} as const;

/** Which interpreter runs `helper-stub.ts`. See the note at the call site. */
export function helperStubInterpreter(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HELPER_STUB_NODE_ENV_VAR];
  if (override !== undefined && override !== '') {
    return override;
  }
  return process.versions.electron === undefined ? process.execPath : 'node';
}

interface HelperChoice {
  readonly kind: 'macos' | 'macos-stub';
  readonly reason: string;
  readonly transport: NativeHelperTransport;
  readonly owned: boolean;
}

/**
 * Decides which helper to talk to, or `null` for the fake build.
 *
 * Exported so a test can assert the decision without spawning anything.
 */
export function describePlatformChoice(options: PlatformRuntimeOptions = {}): {
  readonly kind: PlatformKind;
  readonly reason: string;
} {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const forced = env[PLATFORM_ENV_VAR];
  if (forced === 'fakes') {
    return { kind: 'fakes', reason: `${PLATFORM_ENV_VAR}=fakes` };
  }
  const stubPath = env[HELPER_STUB_PATH_ENV_VAR];
  if (stubPath !== undefined && stubPath !== '') {
    return { kind: 'macos-stub', reason: `${HELPER_STUB_PATH_ENV_VAR} is set` };
  }
  if (platform !== 'darwin') {
    return { kind: 'fakes', reason: `platform is ${platform}, not darwin` };
  }
  try {
    const binary = resolveHelperBinary({
      env,
      ...(options.resourcesPath === undefined ? {} : { resourcesPath: options.resourcesPath }),
      ...(options.appPath === undefined ? {} : { appPath: options.appPath }),
    });
    return { kind: 'macos', reason: `helper binary (${binary.source})` };
  } catch (cause) {
    // Loud, and it names every path searched: a Mac running on fakes because
    // the helper was never built must not look like a Mac whose capture is
    // broken.
    return {
      kind: 'fakes',
      reason: `no helper binary: ${toPilotError(cause).message}`,
    };
  }
}

function chooseHelper(options: PlatformRuntimeOptions, logger: Logger): HelperChoice | null {
  const env = options.env ?? process.env;
  const choice = describePlatformChoice(options);
  if (choice.kind === 'fakes') {
    return null;
  }
  const supplied = options.transport;
  if (supplied !== undefined) {
    return { kind: choice.kind, reason: choice.reason, transport: supplied, owned: false };
  }
  if (choice.kind === 'macos-stub') {
    const stubPath = env[HELPER_STUB_PATH_ENV_VAR] ?? '';
    return {
      kind: 'macos-stub',
      reason: choice.reason,
      transport: new NativeHelperTransport({
        // The stub is a TypeScript file run by Node's own type stripping. In
        // the Electron main process `process.execPath` is the Electron binary,
        // which is not Node and dies with SIGTRAP on it, so the interpreter is
        // named rather than assumed: `PILOT_HELPER_STUB_NODE` when set,
        // `process.execPath` when this really is Node (the demo and the tests),
        // and `node` from `PATH` otherwise.
        command: helperStubInterpreter(env),
        args: [stubPath],
        env: { ...env },
        logger,
      }),
      owned: true,
    };
  }
  const binary = resolveHelperBinary({
    env,
    ...(options.resourcesPath === undefined ? {} : { resourcesPath: options.resourcesPath }),
    ...(options.appPath === undefined ? {} : { appPath: options.appPath }),
  });
  return {
    kind: 'macos',
    reason: choice.reason,
    transport: new NativeHelperTransport({ command: binary.path, env: { ...env }, logger }),
    owned: true,
  };
}

export function createPlatformRuntime(options: PlatformRuntimeOptions = {}): PlatformRuntime {
  const logger = options.logger ?? nullLogger;
  const choice = chooseHelper(options, logger);

  if (choice === null) {
    const { reason } = describePlatformChoice(options);
    const permissions = new FakePermissionAdapter();
    const windows = new FakeWindowAdapter();
    logger.warn('running on fake platform adapters', { reason });
    return {
      kind: 'fakes',
      reason,
      permissions,
      windows,
      capture: null,
      accessibility: null,
      hotkey: null,
      speechInput: null,
      speechOutput: null,
      fakeWindows: windows,
      fakePermissions: permissions,
      transport: null,
      async start() {
        // Nothing to spawn.
      },
      async dispose() {
        // Neither fake holds a timer, a subscription outside this process or a
        // child process, so there is nothing to release.
      },
    };
  }

  const { transport } = choice;
  const poll = options.pollIntervalMs;
  const windows = new MacWindowAdapter({
    transport,
    logger,
    ...(poll === undefined ? {} : { pollIntervalMs: poll }),
  });
  const capture = new MacObservationAdapter({
    transport,
    windows,
    logger,
    // Runbook follow-up 18. See CAPTURE_ENCODING.
    encoding: options.encoding ?? CAPTURE_ENCODING,
    ...(options.capturePollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.capturePollIntervalMs }),
  });
  const identity =
    options.permissionIdentity ?? (choice.kind === 'macos-stub' ? STUB_IDENTITY : {});
  const permissions = new MacPermissionAdapter({
    transport,
    logger,
    // On a real Mac `enforce` is what turns a misattributed grant into a typed
    // error instead of a permission Pilot cannot use. Against the stub the
    // identity is invented, so a failing verdict must not take the whole
    // permission surface down — it is reported, and the observation path
    // refuses on it (see `observationPermissionConditions`).
    attributionPolicy:
      options.attributionPolicy ?? (choice.kind === 'macos-stub' ? 'warn' : 'enforce'),
    ...(poll === undefined ? {} : { pollIntervalMs: poll }),
    ...(identity.expectedBundleIdentifier === undefined
      ? {}
      : { expectedBundleIdentifier: identity.expectedBundleIdentifier }),
    ...(identity.expectedBundlePath === undefined
      ? {}
      : { expectedBundlePath: identity.expectedBundlePath }),
    ...(identity.hostPid === undefined ? {} : { hostPid: identity.hostPid }),
  });
  const accessibility = new MacAccessibilityAdapter({ transport, logger });
  // PR-032. Neither is started here: the tap opens only after
  // `main/voice-runtime.ts` has established PR-011's attribution verdict
  // (runbook follow-up 12), and the recogniser opens only when the interaction
  // machine asks for an utterance.
  const hotkey = new MacHotkeyAdapter({
    transport,
    logger,
    ...(options.holdWatchdogIntervalMs === undefined
      ? {}
      : { holdWatchdogIntervalMs: options.holdWatchdogIntervalMs }),
  });
  const speechInput = new MacSpeechInputAdapter({
    transport,
    logger,
    // system-design §11: Pilot does not record unless recognition stays on this
    // Mac. `SpeechInputBinding` passes the same default per utterance; this is
    // what `availability()` and `disclosure()` answer for.
    requireOnDevice: options.requireOnDeviceSpeech ?? true,
    ...(options.speechPollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.speechPollIntervalMs }),
  });
  // PR-033. Not started either: the synthesiser opens when the machine has a
  // sentence to speak, and `main/speech-runtime.ts` asks it once at startup
  // whether it has a voice at all.
  const speechOutput = new MacSpeechOutputAdapter({
    transport,
    logger,
    ...(options.speechPollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.speechPollIntervalMs }),
  });

  logger.info('running on the macOS platform adapters', {
    kind: choice.kind,
    reason: choice.reason,
    encoding: options.encoding ?? CAPTURE_ENCODING,
  });

  return {
    kind: choice.kind,
    reason: choice.reason,
    permissions,
    windows,
    capture,
    accessibility,
    hotkey,
    speechInput,
    speechOutput,
    fakeWindows: null,
    fakePermissions: null,
    transport,
    async start() {
      if (choice.owned) {
        await transport.start();
      }
    },
    async dispose() {
      capture.dispose();
      windows.dispose();
      permissions.dispose();
      hotkey.dispose();
      // Releases the microphone if an utterance was still open (§11: shutdown
      // clears audio). Awaited before the transport goes, because the release
      // is a round trip.
      await speechInput.dispose().catch(() => undefined);
      // Silences anything still queued in the synthesiser (PR-033). Awaited for
      // the same reason: the stop is a round trip, and a helper that goes away
      // first would leave the last sentence playing until the process exits.
      await speechOutput.dispose().catch(() => undefined);
      if (choice.owned) {
        await transport.stop();
      }
    },
  };
}
