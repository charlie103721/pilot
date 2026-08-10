import { app, ipcMain, powerMonitor, safeStorage, type IpcMainInvokeEvent } from 'electron';
import {
  asConversationId,
  createIdFactory,
  createJsonSink,
  createLogger,
  type SerializedPilotError,
} from '@pilot/shared';
import type { HotkeyAdapter, InteractionCommand, SpeechInputAdapter } from '@pilot/platform';
import { FakeHotkeyAdapter, FakeSpeechInputAdapter } from '@pilot/platform/fakes';
import { createTimeoutScheduler, type PilotInteractionController } from '@pilot/interaction';
import { createDevelopmentModelSource, resolveDevelopmentModelFixture } from '@pilot/agent';
import { IPC_TRANSPORT } from '../ipc/channels.js';
import { createAgentRuntime } from './agent-runtime.js';
// PR-039 (additive import).
import { resolveLocalModelSource } from './local-model.js';
import { CodexGate } from './codex-gate.js';
import { createCodexRuntime, createSafeStorageProtector } from './codex-runtime.js';
// PR-038 (API-key provider profile).
import { openApiKeyProfileRuntime } from './api-key-runtime.js';
import { createSafeStorageCipher } from './safe-storage.js';
import { ConversationGate } from './conversation-gate.js';
import { createLiveConversationDriver } from './conversation-driver.js';
import {
  createFakeSpeechDisclosureSource,
  createReplayClock,
  resolveHotkeyAvailability,
  resolveSpeechDisclosure,
} from './conversation-fixtures.js';
import {
  createElectronPanelHost,
  createElectronSingleInstanceHost,
  createElectronTrayHost,
  resolveFromMain,
} from './electron-hosts.js';
import { conversationDirectory, openConversationStoreRuntime } from './conversation-store.js';
import { createInteractionRuntime, createObservationInteraction } from './interaction-runtime.js';
import { createLifecycleRuntime, reprobeAttribution } from './lifecycle-runtime.js';
import {
  createObservationRuntime,
  retentionEventForCommand,
  retentionEventForFeed,
} from './observation-runtime.js';
import { createPlatformRuntime } from './platform-runtime.js';
import { createQuestionAnchorRuntime } from './question-anchor.js';
import { PermissionGate } from './permission-gate.js';
import { createPermissionFixtureSource, resolvePermissionFixture } from './permission-fixtures.js';
import { createSettingsShortcut } from './settings-shortcut.js';
import { createSpeechOutputRuntime } from './speech-runtime.js';
import { DesktopShell } from './shell.js';
import { enforceSingleInstance } from './single-instance.js';
import type { TrayMenuItem } from './tray.js';
import { createVoiceRuntime } from './voice-runtime.js';
import { WindowGate } from './window-gate.js';
import { createFakeWindowDemoDriver } from './window-demo.js';

/**
 * Electron entry point.
 *
 * Startup order matters: the single-instance lock is taken before anything is
 * created, so a losing instance never registers a tray item, an IPC handler or
 * a window. Everything after that is composition — the behaviour lives in
 * `shell.ts` and its collaborators.
 *
 * PR-029 replaced one fake boundary here: **the agent**. PR-028 replaced the
 * next one: **observation**. The window picker, the permission states and the
 * capture lifecycle now run on `main/platform-runtime.ts`'s chosen adapters, and
 * the frames land in a real `ObservationCore` ring behind PR-019's real
 * `PilotScreenContextService` (`main/observation-runtime.ts`).
 *
 * PR-030 replaced one more: **the screen-context service behind
 * `observe_screen`**. `FakeScreenContextService` is gone from the real path, so
 * a model that calls the tool reaches the same facade "Look now" does.
 *
 * PR-031 replaced the last one on the observation side: **the question
 * anchor**. `FakeQuestionAnchorSource` is gone from the real path, and
 * `ScreenContextInputs.anchor` is set at submission, so a typed question is
 * grounded on where the pointer was when it was asked.
 *
 * PR-032 replaced one more, and it is where voice enters the conversation:
 * **speech input**. The real `CGEventTap` (PR-015) and the real Apple Speech
 * recogniser (PR-014) drive the controller — `main/voice-runtime.ts` maps
 * `hotkey-down`/`hotkey-up` onto `push-to-talk-down`/`push-to-talk-up` and
 * gates the whole path on PR-011's attribution verdict, and
 * `createInteractionRuntime` is handed `MacSpeechInputAdapter` instead of
 * `FakeSpeechInputAdapter`. **No key has ever been pressed and no audio has
 * ever been recorded** — everything below runs against the Node helper stub.
 *
 * PR-033 replaced the last one in the voice loop: **speech output**. The silent
 * adapter is gone; `main/speech-runtime.ts` holds `MacSpeechOutputAdapter` over
 * `AVSpeechSynthesizer` and guarantees the one thing system-design §16 asks
 * for: a synthesiser failure becomes silence, never a lost answer. **No sound
 * has ever been produced**, for the same reason as above.
 *
 * PR-037 replaced the last one of all, and it is opt-in: **the model**.
 * `PILOT_MODEL_PROFILE=codex` builds the real `openai-codex` provider — the real
 * catalogue, the real OAuth flow, a real credential file — through
 * `main/codex-runtime.ts`. **Nobody has ever signed in** (docs/handoff.md §2),
 * so on this machine that profile reports `NOT SIGNED IN` and refuses every
 * question with a remedy; the default remains the faux provider.
 *
 * PR-036 replaced the last one that was not the model: **persistence**. The
 * conversation is opened from disk before the session is built
 * (`main/conversation-store.ts`), restored into it, and its writer lease
 * released on `before-quit`. That is why the composition below is inside an
 * async `boot()`: opening a SQLite session is asynchronous, and everything from
 * the agent onwards depends on it. The lifecycle handlers that must not be late
 * are registered *before* it, synchronously, over a mutable reference.
 *
 * PR-040 replaced no boundary — there was none left but the model — and added
 * the one thing every boundary above needed and none of them owned: **what
 * happens when it fails.** `main/lifecycle-runtime.ts` is built below, ahead of
 * the controller, because the observation port and the recogniser both pass
 * through it. Its rule is one sentence — *a failure of the watching costs the
 * watching, never the answer* — and it is why a dead capture stream reaches the
 * §16 notice at once and the panel banner only when the turn ends.
 *
 * What is still fake, and who takes each one:
 *
 * | boundary        | today                                      | owner   |
 * | --------------- | ------------------------------------------ | ------- |
 * | permissions     | real adapter; fake only when `kind: fakes`  | —       |
 * | window list     | real adapter; fake only when `kind: fakes`  | —       |
 * | screen capture  | real; **no capture at all** on `kind: fakes`| —       |
 * | `observe_screen`| real `PilotScreenContextService`            | —       |
 * | question anchor | real `ObservationCore` pointer timeline     | —       |
 * | push-to-talk    | real `CGEventTap`; fake on `kind: fakes`    | —       |
 * | speech in       | real Apple Speech; fake on `kind: fakes`    | —       |
 * | speech out      | real `AVSpeechSynthesizer`; silent on `kind: fakes` | — |
 * | persistence     | real SQLite `ConversationStore`             | —       |
 * | model           | faux by default; **real Codex** when selected | —    |
 *
 * `kind: fakes` is what a machine that is not a Mac gets, and it is reported
 * with its reason rather than inferred. **The whole real observation path is
 * still reachable on Linux**, against the Node helper stub that
 * `packages/platform-mac` tests itself with:
 *
 *   PILOT_HELPER_STUB_PATH="$PWD/packages/platform-mac/test/support/helper-stub.ts" \
 *     PILOT_HELPER_STUB='{"permissions":{"screen-recording":"granted","accessibility":"granted","microphone":"granted","speech-recognition":"granted"}}' \
 *     pnpm dev
 *
 * (absolute: the main process does not run from the repository root, and the
 * stub needs a desktop in `PILOT_HELPER_STUB` to enumerate — see the README)
 *
 * Every fixture state is reachable without editing source:
 *
 *   PILOT_MODEL_PROFILE=codex pnpm dev            # the ChatGPT subscription profile
 *   PILOT_CODEX_MODEL=gpt-5.3-codex-spark pnpm dev # …refused: that model is text-only
 *   PILOT_MODEL_FIXTURE=faux-text-only pnpm dev   # the capability gate refuses
 *   PILOT_PERMISSION_FIXTURE=denied pnpm dev      # onboarding states (fakes only)
 *   PILOT_HOTKEY_FIXTURE=permission-missing pnpm dev
 *   PILOT_SPEECH_DISCLOSURE=remote pnpm dev
 *   PILOT_PLATFORM=fakes pnpm dev                 # force the fakes on a Mac
 */

const logger = createLogger({
  scope: 'desktop.main',
  level: process.env['PILOT_LOG_LEVEL'] === 'debug' ? 'debug' : 'info',
  sink: createJsonSink((line) => process.stderr.write(`${line}\n`)),
});

let shell: DesktopShell | null = null;

const singleInstance = enforceSingleInstance({
  host: createElectronSingleInstanceHost(),
  logger,
  onSecondInstance: () => shell?.reveal(),
});

/**
 * The one conversation (PR-036).
 *
 * Stable, and that is the point: the durable store is keyed by this id, so a
 * timestamped one — which is what this was until PR-036 — would open a fresh,
 * empty conversation on every launch and the transcript on disk would never be
 * read again. MVP 01 has exactly one conversation; when there are several, this
 * becomes "the conversation the user last had open", read from preferences.
 *
 * Note that it is **not** the id the panel shows: the interaction table mints a
 * new `conversationId` on `clear-conversation`, while the session and its store
 * keep this one and are emptied in place. The two have always differed after a
 * clear; PR-036 is the first thing that persists either of them, and it
 * deliberately persists the session's.
 */
const PRIMARY_CONVERSATION_ID = asConversationId('conv-primary');

if (!singleInstance.isPrimary) {
  // Another instance owns the menu bar item. Stop here; app.quit() is already
  // in flight and continuing would briefly create a second tray icon.
  logger.info('exiting as secondary instance');
} else {
  // Registered before anything is awaited. `boot()` below is asynchronous —
  // opening a SQLite session is — and a quit that arrived while it was still
  // running would otherwise find no `before-quit` handler at all, leaving the
  // writer lease behind and making the next launch fail for 30 seconds.
  let teardown: (() => void) | null = null;
  app.on('before-quit', () => {
    const run = teardown;
    teardown = null;
    run?.();
  });

  // Pilot is a menu bar app: closing the panel must not quit it.
  app.on('window-all-closed', () => undefined);

  app.on('activate', () => shell?.reveal());

  const boot = async (): Promise<void> => {
    const conversationId = PRIMARY_CONVERSATION_ID;

    // Persistence (PR-036, runbook follow-up 20). First, because
    // `PiAgentSession` takes the store *and* the restored conversation at
    // construction — there is no way to attach either afterwards — and the
    // agent is what everything below is built over.
    //
    // Total: a store that cannot be opened (a held writer lease, a full disk)
    // leaves `store: null` and a typed `error`, and Pilot runs in memory
    // exactly as it did before this PR. `app.getPath('userData')` is safe
    // before `ready`.
    const durable = await openConversationStoreRuntime({
      conversationId,
      directory: conversationDirectory(app.getPath('userData')),
      logger,
    });

    // The model. Four sources, tried in order, all satisfying `ModelSource` and
    // nothing else — which is why this is a `??` chain and not a branch through
    // the rest of the composition (runbook follow-up 22).
    //
    //  1. PR-037: `PILOT_MODEL_PROFILE=codex` selects the ChatGPT subscription
    //     profile. Explicit, so it wins.
    //  2. PR-038: a verified API-key profile. `source` is null unless a
    //     capability probe has passed, so a merely *configured* profile never
    //     reaches the agent.
    //  3. PR-039: `PILOT_LOCAL_BASE_URL` points Pilot at the user's own
    //     OpenAI-compatible endpoint, health- and capability-probed before a
    //     session exists (`main/local-model.ts`).
    //  4. Otherwise Pi's own faux provider behind a real `Models` collection
    //     (runbook amendments 2 and 7).
    //
    // The default is still the faux one, because **no sign-in has happened**
    // (docs/handoff.md §2) and a build that silently switched to a provider it
    // has no credential for would answer nothing at all. No real profile ever
    // falls back silently: a configured-but-unusable one refuses with its
    // reason rather than quietly becoming the development model.
    //
    // ADDING A PROFILE: open your runtime here and add one `??` term below, in
    // the same shape. Nothing else in this file has to change.
    //
    // The API-key runtime opens FIRST, before anything that could spawn a child
    // process: it reads `PILOT_API_KEY` once and then *removes it from
    // `process.env`*, so the native helper started later in `start()` cannot
    // inherit a credential.
    const apiKeyProfile = await openApiKeyProfileRuntime({
      userDataPath: app.getPath('userData'),
      cipher: createSafeStorageCipher(),
      logger,
    });
    const codex = createCodexRuntime({
      env: process.env,
      userDataDirectory: app.getPath('userData'),
      // Keychain-backed on macOS. `available` is read at call time, because
      // this runs before `app.whenReady()` — the agent below it needs the
      // source at construction.
      protector: createSafeStorageProtector(safeStorage),
      logger,
    });
    await codex.refresh();
    const local = await resolveLocalModelSource({ env: process.env, logger });
    const modelSource =
      codex.source ??
      apiKeyProfile.source ??
      local.source ??
      createDevelopmentModelSource({
        fixture: resolveDevelopmentModelFixture(process.env['PILOT_MODEL_FIXTURE']),
      });
    // Logged rather than assumed: a build that is not talking to a real model —
    // or that is configured for one it has not signed in to — must say so where
    // anyone can see it.
    //
    // NOTE THE FIELD NAMES. `@pilot/shared`'s redactor matches any key
    // containing `api[-_]?key` and replaces its value with
    // `[redacted:credential]` — correct, and it made this line unreadable when
    // it was called `apiKeyProfile`. Same trap as `main/conversation-store.ts`'s
    // `restored` (not `restoredMessages`).
    logger.info('model source', {
      description: modelSource.description,
      profile: codex.source
        ? 'codex'
        : apiKeyProfile.source
          ? 'api-key'
          : local.source
            ? 'local'
            : 'development',
      // Why the user-configured API-key profile is not in use, when it is not.
      profileReason: apiKeyProfile.reason === '' ? 'in use' : apiKeyProfile.reason,
    });

    // The platform (PR-028). One decision, in one place: the real macOS adapters
    // when there is a helper to talk to, the fakes otherwise, and the reason
    // either way. `start()` is awaited inside `app.whenReady()` below, because it
    // spawns a child process.
    const platform = createPlatformRuntime({
      logger,
      resourcesPath: process.resourcesPath,
    });

    // The observation boundary (PR-028). Built before the controller because the
    // controller takes its `ObservationControlPort` — runbook follow-up 23: "PR-028
    // passes the real capture lifecycle there" — and now also before the agent,
    // which takes its `ScreenContextService` (PR-030, the other half of the same
    // follow-up).
    const observation = createObservationRuntime({
      capture: platform.capture,
      windows: platform.windows,
      accessibility: platform.accessibility,
      ...(platform.permissions.attribution === undefined
        ? {}
        : { attribution: platform.permissions.attribution.bind(platform.permissions) }),
      logger,
    });

    // The agent (PR-029). The capability gate (PR-020) runs inside this call,
    // before Pi's `Agent` exists and before any tool is registered, so a refusal
    // costs zero provider requests.
    //
    // `screenContext` is PR-030's whole change on this side, and it is one
    // argument: `observe_screen` now reaches PR-019's real
    // `PilotScreenContextService` — the *same instance* the interaction table's
    // "Look now" drives — instead of `FakeScreenContextService`. One instance
    // matters: the §10 rate limiter, the scene lineage, the retention guard and
    // the one decoded frame are shared, so a model look and a user look cannot
    // disagree about what is on screen or evade each other's limits.
    //
    // `store` and `restore` are PR-036's whole change on this side, and they go
    // together for the reason runbook follow-up 20 (b) gives: a store with no
    // restore is a conversation that is on disk and invisible to the model.
    // `compaction.contextWindow` is chosen inside `createAgentRuntime` — see
    // `main/context-window.ts`, follow-ups 7 and 9.
    const agentRuntime = createAgentRuntime({
      conversationId,
      source: modelSource,
      screenContext: observation.screenContext,
      ...(durable.store === null ? {} : { store: durable.store, restore: durable.restore }),
      // PR-039: a local endpoint that is configured and unusable refuses every
      // question with the reason, instead of looking like a working model.
      ...(local.blockedBy === null ? {} : { blockedBy: local.blockedBy }),
      logger,
    });

    // The question anchor (PR-031). The last unwired input on the observation
    // side: `ScreenContextInputs.anchor`. Setting it is what makes point-and-ask
    // work — `moment: 'question'` selects the frame the user was looking at when
    // they asked instead of the newest one, `view: 'pointer'` crops around where
    // they were pointing, and the element under that pointer reaches the model as
    // `targetRole`. It is built over the *same* `ObservationCore` the pointer
    // poller feeds and the same `MutableScreenContextInputs` the facade reads.
    const anchoring = createQuestionAnchorRuntime({
      core: observation.core,
      inputs: observation.inputs,
      targets: observation.targets,
      logger,
    });

    // Voice input (PR-032). The tap and the recogniser come from the same branch
    // of `createPlatformRuntime`, so they are chosen together: either this build
    // has a helper and both are real, or it has neither and both are fakes. The
    // fakes are kept — unlike capture, which PR-028 left absent rather than fake —
    // because both of them complete on their own (the fake recogniser finalises
    // on `stop()`, which is the release of the key) and because PR-010's
    // `PILOT_HOTKEY_FIXTURE` states have nowhere else to live.
    //
    // Nothing about the controller changes with the real recogniser: PR-025's
    // `SpeechInputBinding` already absorbs one that finalises early, finalises
    // twice or calls back after cancel, and Apple Speech does all three.
    //
    //   PILOT_HOTKEY_FIXTURE=permission-missing pnpm dev   # no way to speak
    //   PILOT_SPEECH_DISCLOSURE=remote pnpm dev            # audio would leave
    const voiceAdapters = ((): {
      readonly hotkey: HotkeyAdapter;
      readonly speechInput: SpeechInputAdapter;
      /** Present only on the fake build; the one route to a *failed* recogniser. */
      readonly fakeSpeech: FakeSpeechInputAdapter | null;
      readonly real: boolean;
    } => {
      const hotkey = platform.hotkey;
      const speech = platform.speechInput;
      if (hotkey !== null && speech !== null) {
        return { hotkey, speechInput: speech, fakeSpeech: null, real: true };
      }
      const fakeSpeech = new FakeSpeechInputAdapter();
      return {
        hotkey: new FakeHotkeyAdapter({
          availability: resolveHotkeyAvailability(process.env['PILOT_HOTKEY_FIXTURE']),
        }),
        speechInput: fakeSpeech,
        fakeSpeech,
        real: false,
      };
    })();
    const speechInput = voiceAdapters.speechInput;

    // Speech output (PR-033), and it is the whole of this PR's boundary change.
    // `platform.speechOutput` is `AVSpeechSynthesizer` behind the helper on both
    // helper branches and `null` on the fake build; the runtime turns `null` — and
    // every synthesiser failure — into silence rather than into a lost answer
    // (system-design §16). `createSilentSpeechOutputAdapter` is gone with it
    // (runbook follow-up 24).
    const synthesiser = platform.speechOutput;
    const speech = createSpeechOutputRuntime({
      adapter: synthesiser,
      // Disposing the runtime silences the synthesiser at once, ahead of the
      // controller and of `platform.dispose()` (which does it again; the adapter's
      // own dispose is idempotent).
      ...(synthesiser === null ? {} : { dispose: () => synthesiser.dispose() }),
      logger,
    });

    // Lifecycle and failure recovery (PR-040).
    //
    // Built here, ahead of the controller, because two of the ports the
    // controller takes pass through it: the observation port gains the
    // scene-checked retry of `main/request-retry.ts`, and the recogniser gains
    // the §16 sentence that names the text box. It reads the controller back
    // through {@link liveController}, which is safe because nothing on this
    // object is *called* until `lifecycle.start()` runs inside `start()` below.
    //
    // What it owns is stated once, in its own file: **a failure of the watching
    // costs the watching, never the answer.** So a window that turns out to
    // block capture, a capture stream that dies and a helper that crashes are
    // all reported — as a panel banner when nothing is in flight, as the §16
    // notice when something is — and none of them tears down a run that is
    // still writing an answer (runbook cross-lane issue 15).
    let live: PilotInteractionController | null = null;
    const liveController = (): PilotInteractionController => {
      if (live === null) {
        throw new Error('the interaction controller is not built yet');
      }
      return live;
    };
    const lifecycle = createLifecycleRuntime({
      interaction: {
        snapshot: () => liveController().snapshot(),
        subscribe: (listener) => liveController().subscribe(listener),
        send: (event) => {
          liveController().send(event);
        },
        // The same entry point the panel uses, so a switch Pilot turns off on
        // the user's behalf is counted exactly like one they turned off.
        dispatch: (command) => {
          dispatchCommand(command);
        },
      },
      observation: {
        noteRetentionEvent: (event) => {
          observation.noteRetentionEvent(event);
        },
        scene: () => observation.status().scene,
      },
      capture: platform.capture,
      transport: platform.transport,
      notices: {
        noteObservationStopped: (reason, window, wasObserving) => {
          windows.noteObservationStopped(reason, window, wasObserving);
        },
      },
      // The recovery nothing performed before this PR. A restarted helper is a
      // new process, so PR-011's cached attribution verdict belongs to a dead
      // one; the window list and the permission states were read through a pipe
      // that no longer exists. `MacObservationAdapter` re-establishes its own
      // stream on the same edge — that part was already right.
      onHelperRestored: async () => {
        // The cached verdict first, then the read: see `reprobeAttribution`.
        await reprobeAttribution(platform.permissions);
        await observation.refreshAttribution();
        await permissions.refresh();
        await windows.refresh();
      },
      logger,
    });

    // The interaction controller (PR-006/024/025/026/027), real at last.
    // PR-037. Identity when Codex is not selected. When it is, this is the
    // pre-flight that refuses a question *before* the run starts — so before
    // any provider request and before the model can call `observe_screen` — and
    // the translation that turns Pi's `OAuth refresh failed for openai-codex`
    // into the sentence that says to sign in again.
    const agentSession = codex.wrapSession(agentRuntime.session);
    const { controller } = createInteractionRuntime({
      agent: agentSession,
      conversationId,
      // PR-040: the recogniser, wrapped. A `speech.input.start` that is refused
      // reached the panel as "The macOS helper could not run that operation" —
      // a sentence written for a log. It now reaches it as §16's answer: type
      // your question instead, the microphone was released, nothing was kept.
      // The *gate* still holds the unwrapped adapter, because what it reads
      // (`disclosure()`) is a fact about the recogniser and not a failure.
      speechInput: lifecycle.guardSpeechInput(speechInput),
      speechOutput: speech.speechOutput,
      // Runbook follow-up 25, the remaining wiring of follow-up 6. PR-027 built
      // the phrase-timeout wake-up as an injected port so the machine keeps no
      // timers; PR-029 deliberately did not pass it, because with speech silent
      // there was nothing to release and no way to see whether it had worked.
      // There is now: a model that emits a clause and then goes quiet speaks what
      // it already had, instead of waiting for the run to end.
      scheduler: createTimeoutScheduler(),
      // PR-040: one scene-checked retry around "Look now" and the model's own
      // observation. `main/request-retry.ts` says when — and, more importantly,
      // when not: a retry that re-sends a picture of a screen the user has
      // moved past is worse than the failure it was hiding.
      observation: lifecycle.guardObservation(observation.port),
      // PR-031: this is `PilotQuestionEnvelopeFactory` over the real pointer
      // timeline, plus the one side effect that has to happen at the same instant
      // — handing the resolved anchor to the screen-context facade.
      envelopes: anchoring.envelopes,
      logger,
    });

    // PR-040. The late binding the lifecycle runtime above was built around.
    live = controller;

    // §10 step 1 takes the pause switch and the observation switch from the
    // machine, which is the only thing that knows them.
    //
    // The anchor is dropped on the same edge: once the machine is no longer
    // waiting for a question, a "Look now" or a model observation must not be
    // grounded on the pointer of the question that has already been answered.
    controller.subscribe((view) => {
      observation.noteViewState(view);
      anchoring.noteActiveUtterance(controller.context.activeUtteranceId);
    });
    observation.noteViewState(controller.snapshot());

    if (!agentRuntime.capability.ok) {
      // Say it now rather than when the user asks their first question. The
      // machine's `error` state keeps the text box live (system-design §16), and
      // the refusal carries its own `userMessage` and remedy.
      controller.send({ type: 'failure', error: agentRuntime.capability.error });
    } else if (codex.startupError() !== null) {
      // PR-037, and it is runbook follow-up 22's "must not silently look like a
      // working model" made visible. A Codex profile with no stored sign-in can
      // answer nothing, so the panel says so at startup with the remedy
      // attached, beside a live text box (system-design §16) — rather than
      // letting the user find out by asking a question.
      controller.send({ type: 'failure', error: codex.startupError() as SerializedPilotError });
    } else if (durable.error !== null) {
      // PR-036, runbook follow-up 20 (a). A writer lease Pilot could not take is
      // the one persistence failure the user can act on, and its `userMessage`
      // is the only sentence in the product that says to wait 30 seconds. It is
      // reported *after* the capability refusal, never over it: a model that
      // cannot answer at all outranks a conversation that will not be
      // remembered. Reported as `failure`, so the panel shows it beside a live
      // text box and `dismiss-error` is the way past it — this build answers
      // questions perfectly well, it just forgets them.
      controller.send({ type: 'failure', error: durable.error });
    }

    // Permission onboarding (PR-008), now on the platform's own adapter. The
    // named fixtures survive only on the fake build — a real TCC state cannot be
    // forced from a panel, and offering a control that would be refused is the
    // thing PR-009 exists not to do.
    //   PILOT_PERMISSION_FIXTURE=denied pnpm dev
    const permissionAdapter = platform.permissions;
    const fixtures =
      platform.fakePermissions === null
        ? undefined
        : createPermissionFixtureSource(
            platform.fakePermissions,
            resolvePermissionFixture(process.env['PILOT_PERMISSION_FIXTURE']),
          );
    const permissions = new PermissionGate({
      adapter: permissionAdapter,
      // On anything but macOS this seam reports itself unavailable, and the panel
      // renders an explained, disabled control rather than a dead button.
      settings: createSettingsShortcut({
        platform: process.platform,
        adapter: permissionAdapter,
      }),
      ...(fixtures === undefined ? {} : { fixtures }),
      logger,
    });

    // The real machine gates on permissions (`needs-permission` outranks every
    // other resting state), so the gate's snapshot has to reach it. Until one
    // arrives the controller holds `null`, which means "nothing reported yet" and
    // deliberately does not block — never "granted".
    //
    // The same snapshot is what §10 step 1 validates (runbook follow-up 16): with
    // it unwired every observation is refused as `permission-denied`, so this line
    // is the difference between an observation path that works and one that looks
    // broken for the wrong reason.
    permissions.subscribe((state) => {
      // PR-040, and the order is the whole of it: the retention occasion for a
      // revocation has to be armed *before* the machine's own
      // `permissions-changed` row asks for the clear it names. Until this line
      // `permission-loss` — one of the five occasions system-design §13 lists —
      // had no caller anywhere in the product.
      lifecycle.notePermissions(state.snapshot);
      observation.notePermissions(state.snapshot);
      if (state.snapshot !== null) {
        controller.send({ type: 'permissions-changed', permissions: state.snapshot });
      }
    });

    /**
     * The one way a command reaches the machine, whatever dispatched it.
     *
     * A function declaration so push-to-talk can be wired before the conversation
     * gate exists: the gate needs `voice.pushToTalk`, and the voice runtime needs
     * a dispatch that has already told the gate about the command (§17 counts an
     * abandoned question once, wherever it was abandoned from).
     */
    function dispatchCommand(command: InteractionCommand): void {
      conversation.noteCommand(command);
      // system-design §13, and PR-041's finding: the occasion for the clear the
      // table is about to ask for is named *here*, on the one route every
      // command takes, rather than inside the wrapper `WindowGate` was given.
      // The menu bar item's Pause and the renderer's `pilot:interaction/dispatch`
      // never went through that wrapper, so their clears were logged under
      // whichever occasion happened to be armed last.
      const occasion = retentionEventForCommand(command);
      if (occasion !== null) {
        observation.noteRetentionEvent(occasion);
      }
      controller.dispatch(command);
    }

    // Push-to-talk, wired (PR-032, runbook follow-ups 12 and 19). Built before
    // the conversation gate because the gate takes `voice.pushToTalk` as its
    // availability source: the mapping and the availability come from one object,
    // so the panel can never be told the shortcut works while nothing is
    // listening to it.
    const voice = createVoiceRuntime({
      hotkey: voiceAdapters.hotkey,
      dispatch: dispatchCommand,
      // Follow-up 12. `MacPermissionAdapter.attribution()` caches, so this is the
      // same verdict `observation.refreshAttribution()` established and not a
      // second round trip. Absent on the fake build, which has no seam to read.
      ...(platform.permissions.attribution === undefined
        ? {}
        : { attribution: platform.permissions.attribution.bind(platform.permissions) }),
      logger,
    });

    // Conversation and developer diagnostics (PR-010). Built before the window
    // gate so every command the window gate dispatches passes through
    // `noteCommand` too — a question abandoned by changing the observed window is
    // the same abort as one abandoned with the Interrupt button.
    const replayClock = createReplayClock();
    const conversation = new ConversationGate({
      interaction: controller,
      hotkey: voice.pushToTalk,
      // PR-032 closes runbook follow-up 13: `MacSpeechInputAdapter.disclosure()`
      // finally has a route to the renderer. On the fake build the environment
      // fixture still stands in, because a fake recogniser has no honest answer.
      ...(() => {
        if (voiceAdapters.real) {
          return { speech: voiceAdapters.speechInput };
        }
        const speech = createFakeSpeechDisclosureSource(
          resolveSpeechDisclosure(process.env['PILOT_SPEECH_DISCLOSURE']),
        );
        return speech === undefined ? {} : { speech };
      })(),
      demoFixtures: true,
      // PR-038, system-design §14: the user is shown where their screen goes
      // *before* an observation. Null on a build with no configured profile —
      // the development source is not a third party and claiming a destination
      // for it would be a lie in the other direction.
      modelDisclosure: apiKeyProfile.disclosure,
      now: () => replayClock.now(),
      logger,
    });

    // PR-038: invalid-key recovery from a live conversation, not only from the
    // probe. A key revoked between the probe and the third question fails in
    // the middle of an answer; feeding that failure back is what stops the app
    // continuing to present a model it can no longer reach, and what changes
    // the banner from "Pilot has confirmed this model" to a remedy.
    const apiKeyManager = apiKeyProfile.manager;
    if (apiKeyManager !== null) {
      agentRuntime.session.subscribe((event) => {
        if (event.type !== 'run-failed') {
          return;
        }
        const status = apiKeyManager.noteRunFailure(event.error.message);
        conversation.setModelDisclosure(status.disclosure);
      });
    }
    // §17's three capture-side numbers — capture-to-observation latency, image
    // bytes and the active image count — are the ones PR-010 deliberately left to
    // this PR, because none of them can be seen from the view-state stream.
    observation.attachTelemetry(conversation.telemetry);
    // …and the two compaction counters (PR-036, follow-up 9). Same shape, same
    // reason: `context-tokens-before`/`-after` are transitions of the *session*,
    // not of the view state. The summary text the `context-compacted` event
    // carries is not passed here and could not be — the sink takes numbers.
    agentRuntime.attachTelemetry(conversation.telemetry);

    // Window picker and observation controls (PR-009), on the platform's own
    // enumeration (PR-028). `report` is `controller.send`, so `windows-changed`,
    // `window-closed`, `screen-locked` and `screen-unlocked` are answered by the
    // transition table rather than by a copy of it (runbook follow-ups 10, 11) —
    // and each of them now also names the retention occasion for the clear the
    // table is about to ask for, so the log says "screen-lock" rather than
    // guessing (follow-up 17).
    const observationInteraction = createObservationInteraction(controller);
    const windows = new WindowGate({
      windows: platform.windows,
      interaction: {
        ...observationInteraction,
        // One route, one arming point: `dispatchCommand` above. Before PR-041
        // this wrapper was the only place the occasion was named, which made
        // the menu bar item a second entry point that never named it.
        dispatch: dispatchCommand,
        report: (event) => {
          const retentionEvent = retentionEventForFeed(event);
          if (retentionEvent !== null) {
            observation.noteRetentionEvent(retentionEvent);
          }
          observationInteraction.report(event);
        },
      },
      permissions,
      // The fake window-lifecycle controls are offered only by a build that has a
      // fake window adapter behind them (PR-028's half of runbook follow-up 10).
      // On the real enumeration the panel must not offer to close a window Pilot
      // does not own, and the shell would refuse it.
      demoEvents: platform.fakeWindows !== null,
      logger,
    });
    const fakeWindows = platform.fakeWindows;
    const windowDemoDriver =
      fakeWindows === null
        ? undefined
        : createFakeWindowDemoDriver({
            adapter: fakeWindows,
            selected: () => controller.snapshot().selectedWindow,
          });
    // The panel's "Replay" bar. Since PR-029 it holds real conversations against
    // the real controller instead of replaying scripted view states — and since
    // PR-032 its `spoken-question` fixture really does open the tap's utterance
    // through the real recogniser.
    //
    // `speech` is the one thing a command cannot express: making recognition
    // *fail*. It exists only on the fake build; against a helper the same state is
    // reached by scripting the helper, which for the stub is
    // `PILOT_HELPER_STUB='{"speechInput":{"startFailsWith":{"code":"permission-denied"}}}'`.
    const conversationFixtureDriver = createLiveConversationDriver({
      controller,
      gate: conversation,
      ...(voiceAdapters.fakeSpeech === null ? {} : { speech: voiceAdapters.fakeSpeech }),
      logger,
    });

    // PR-037. Built only when the profile is selected, so the panel's Model
    // section is absent rather than empty on a development build.
    const codexGate = codex.enabled ? new CodexGate({ runtime: codex, logger }) : null;

    // Set by `electron-vite dev`, absent in every built app. When it is present
    // the panel loads from the dev server so edits hot-reload; otherwise it loads
    // the file emitted next to this one.
    const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'];
    const rendererSource =
      rendererDevUrl === undefined
        ? { file: resolveFromMain('../renderer/index.html') }
        : { url: rendererDevUrl };

    const start = async (): Promise<void> => {
      // Spawns the helper, when there is one. Before the shell, so the first
      // window list and the first permission read have something to talk to.
      //
      // A helper that will not start must not take the application with it: the
      // panel is where the user is told what happened, and the window and
      // permission gates already surface `helper-unavailable` as a typed
      // `lastError`. Quitting instead would leave them with a menu bar item that
      // vanished and no explanation anywhere.
      try {
        await platform.start();
      } catch (cause) {
        logger.error('the platform helper did not start; observation is unavailable', {
          cause: String(cause),
          platform: platform.kind,
        });
      }
      await observation.refreshAttribution();

      // PR-040. Subscribes to the two sources of a failure nothing in the app
      // was listening to before: the capture stream's own `capture-stopped`
      // (protected content, a stream that failed past its own restarts) and the
      // helper supervisor's `crash`. Started here rather than at construction
      // because both are only interesting once there is a helper to crash.
      lifecycle.start();

      // Lock, unlock and logout, from the operating system rather than from a
      // window-list poll. This is the only signal Pilot gets for a *logout*, and
      // system-design §13 lists logout among the five occasions the buffers must
      // be cleared — with the scene lineage, because unlike a lock it is
      // terminal. The window feed keeps reporting locks too; the table rejects
      // the duplicate rather than clearing twice.
      powerMonitor.on('lock-screen', () => {
        lifecycle.reportScreenLock(true);
      });
      powerMonitor.on('unlock-screen', () => {
        lifecycle.reportScreenLock(false);
      });
      powerMonitor.on('shutdown', () => {
        lifecycle.reportSessionEnd('logout');
      });

      // PR-032, and the order is the whole of runbook follow-up 12: attribution
      // is established *before* anything can open the microphone. `voice.start()`
      // reads the verdict, refuses the voice path outright when macOS credits
      // Pilot's grants elsewhere, and only otherwise installs the tap. It does
      // not throw for anything the user could act on — a missing Accessibility
      // grant is an availability state the panel renders, beside a text box that
      // stays live (§16).
      try {
        const status = await voice.start();
        logger.info('push-to-talk', {
          availability: status.availability.status,
          real: voiceAdapters.real,
          binding: status.binding.label,
        });
      } catch (cause) {
        logger.error('the push-to-talk tap could not be installed; typing is the way to ask', {
          cause: String(cause),
        });
      }

      // PR-033. One question, asked once: has this platform a voice at all? A
      // "no" is not a failure — the answers are read instead of heard, which is
      // what §16 already requires the app to survive — but it must be visible in
      // the log, because "Pilot went quiet" and "Pilot has no voice installed"
      // look identical from the outside.
      const voices = await speech.start();
      logger.info('speech output', {
        real: speech.real,
        available: voices.available,
        voices: voices.voices.length,
      });

      const trayHost = createElectronTrayHost({
        onSelect: (id: TrayMenuItem['id']) => shell?.tray.select(id),
      });

      shell = new DesktopShell({
        panelHost: createElectronPanelHost({
          preloadPath: resolveFromMain('../preload/index.cjs'),
          renderer: rendererSource,
        }),
        trayHost,
        controller,
        // PR-041. The menu bar item's Pause and the renderer's
        // `pilot:interaction/dispatch` now reach the same function the panel's
        // window actions do, so the §13 retention occasion is named whichever
        // surface the command came from.
        dispatch: dispatchCommand,
        permissions,
        windows,
        conversation,
        ...(codexGate === null ? {} : { codex: codexGate }),
        ...(windowDemoDriver === undefined ? {} : { windowDemoDriver }),
        conversationFixtureDriver,
        appInfo: {
          version: app.getVersion(),
          platform: process.platform,
          // No longer a constant: this build may be on the real macOS adapters.
          usesRealPlatform: platform.kind !== 'fakes',
        },
        quit: () => app.quit(),
        ids: createIdFactory(),
        logger,
      });

      ipcMain.handle(IPC_TRANSPORT.request, async (event: IpcMainInvokeEvent, raw: unknown) =>
        // Every renderer payload passes through the router's validation; there is
        // no second `ipcMain.handle` and therefore no unvalidated path (§14).
        shell === null ? undefined : shell.router.handle(raw, { senderId: event.sender.id }),
      );

      const { trayAvailability } = shell.start();
      if (!trayAvailability.available) {
        // Without a menu bar item the panel is the only way in, so open it.
        logger.warn('no menu bar item; opening the panel directly', {
          reason: trayAvailability.reason,
        });
        shell.reveal();
      }
      if (process.env['PILOT_OPEN_PANEL_ON_START'] === '1') {
        shell.reveal();
      }

      // Read by `scripts/smoke.js` to decide the headless launch check passed.
      logger.info('shell ready', {
        trayAvailable: trayAvailability.available,
        panelVisible: shell.panel.isVisible(),
        agent: agentRuntime.capability.ok ? 'ready' : 'refused',
        // PR-036. `restored` and `durable` are counts and a boolean; the
        // transcript and the summary are never logged (§13's "never logged").
        durable: durable.store !== null,
        restored: durable.restore.messages.length,
        contextWindow: agentRuntime.contextWindow.contextWindow,
        platform: platform.kind,
        platformReason: platform.reason,
        capture: observation.captureAvailable ? 'available' : 'unavailable',
        pushToTalk: voice.availability().status,
        voice: voiceAdapters.real ? 'real' : 'fake',
        speechOut: speech.real ? (voices.available ? 'audible' : 'no-voice') : 'silent',
        // PR-040. Zero at startup, and a number a smoke run can read: every
        // lifecycle failure since boot, whichever subsystem raised it.
        lifecycleFailures: lifecycle.stats().records,
        // PR-037. The auth *state*, never the credential: `signed-out` on a
        // build that selected Codex is the whole of docs/handoff.md §2.
        modelProfile: codex.enabled ? 'codex' : local.source ? 'local' : 'development',
        modelAuth: codex.state().auth.state,
      });
    };

    teardown = (): void => {
      // The shell disposes the controller, which aborts anything in flight; the
      // session itself is disposed here because the shell does not own it.
      //
      // Observation goes before the platform, and it goes through the retention
      // guard: system-design §13 lists process shutdown among the occasions the
      // buffers must be cleared, and `shutdown` is terminal, so the scene lineage
      // goes with them.
      //
      // Voice goes first: stopping the tap releases a key that is still held, and
      // the controller's own dispose then cancels the utterance and closes the
      // microphone. The other order would let a press arrive at a disposed
      // controller.
      //
      // Speech output goes next, and still ahead of the controller (PR-033): a
      // quit in the middle of a sentence must stop the sound at once rather than
      // after the interaction teardown has drained. Every call after that is a
      // no-op, so the controller's own `stop-speech` on dispose is safe.
      //
      // And **the store closes last** (PR-036, runbook follow-up 20): it is
      // chained behind `agentRuntime.dispose()`, which flushes the writer queue
      // — `agent_end` starts the final write and does not await it, so closing
      // first would drop the last turn of every conversation, which is the one a
      // relaunch most wants. Closing at all is what releases the SQLite writer
      // lease; skip it and every relaunch inside 30 s fails to open the store.
      lifecycle.dispose();
      const quitting = voice
        .dispose()
        .then(() => speech.dispose())
        .then(() => shell?.dispose() ?? Promise.resolve());
      void quitting
        .then(() => observation.dispose())
        .then(() => platform.dispose())
        .then(() => agentRuntime.dispose())
        .then(() => codex.dispose())
        .then(() => durable.close());
      shell = null;
    };

    await app.whenReady();
    await start();
  };

  // `whenReady()` is awaited inside `boot()` and resolves immediately if the
  // event has already fired, so nothing is lost by starting the store first.
  void boot().catch((cause: unknown) => {
    logger.error('failed to start', { cause: String(cause) });
    app.exit(1);
  });
}
