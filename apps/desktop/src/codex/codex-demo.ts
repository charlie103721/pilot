import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  CODEX_BROWSER_CALLBACK_PORT,
  createCodexAgentSession,
  CODEX_BROWSER_METHOD,
  CODEX_DEVICE_CODE_METHOD,
  CODEX_TEXT_ONLY_MODEL,
  codexCredentialsPath,
  createCodexCredentialStore,
  createCodexDeviceCodeInteraction,
  createFakeCodexModelSource,
  type CodexDeviceCode,
  type FakeCodexModelSource,
} from '@pilot/agent';
import type { AgentSession, AgentEvent, ScreenContextService } from '@pilot/platform';
import { FakeScreenContextService } from '@pilot/platform/fakes';
import {
  asConversationId,
  asUtteranceId,
  createLogger,
  createMemorySink,
  type LogRecord,
  type LogSink,
  type QuestionEnvelope,
  type SerializedPilotError,
} from '@pilot/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRuntime } from '../main/agent-runtime.js';
import { CodexGate } from '../main/codex-gate.js';
import { createCodexRuntime } from '../main/codex-runtime.js';
import {
  AX_ELEMENTS,
  OUTSIDE_THE_WINDOW,
  OVER_A_STACKED_WINDOW,
  OVER_THE_BUTTON,
  pushScreenshot,
  settleRun,
} from '../observation/ask-demo.js';
import { createObservationRig, DEMO_DESKTOP } from '../observation/observe-rig.js';
import {
  GRANTED,
  answerOf,
  nextPointerBucket,
  pressKey,
  recordPanel,
  releaseKey,
  spoken,
  waitFor,
} from '../voice/flow-demo.js';

/**
 * PR-037's walkthrough: **the Codex subscription profile.**
 *
 *     pnpm demo:codex
 *
 * `docs/implementation.md` PR-037: "sign in without an API key and run the
 * point-ask-hear flow". This runs that, plus the four things the line does not
 * mention and the Phase 4 gate does: the token's lifecycle, the vision/tool
 * capability validation, auth-expiry recovery, and the proof that no credential
 * reaches renderer state, an application log or a session transcript.
 *
 * ## What is real
 *
 * Every object below is the one `main/index.ts` builds. `createCodexRuntime`,
 * `CodexGate`, `createCodexModelSource`, `createCodexCredentialStore`,
 * `createCodexAgentSession`, `createAgentRuntime`, `PiAgentSession`, the
 * capability gate, and — in section 5 — the whole observation rig
 * (`WindowGate`, `PilotInteractionController`, the mac adapters over
 * `NativeHelperTransport`, `ObservationSession`, `PilotScreenContextService`,
 * the §10 policy and the image pipeline, `main/voice-runtime.ts`,
 * `main/speech-runtime.ts`). The Codex **provider id**, the Codex **model
 * catalogue** and every `Model.input` the capability gate reads are the real
 * ones, shipped in `@earendil-works/pi-ai@0.84.1`.
 *
 * Pi's own auth machinery is real too: `Models.login` persists through a real
 * `CredentialStore`, `Models.checkAuth` reads it back, and `Models.getAuth`
 * runs Pi's double-checked expiry test and calls `refresh` under the store lock.
 *
 * ## What is NOT real
 *
 * **NO CHATGPT ACCOUNT, NO SIGN-IN, NO TOKEN, NO NETWORK, NO MACOS.** The
 * OAuth endpoints are replaced by `createFakeCodexAuthSurface`, which
 * reproduces the recorded prompts and events of
 * `pi-ai/dist/auth/oauth/openai-codex.js` and issues fixture tokens. Nobody has
 * ever approved a device code, no `auth.openai.com` request has been made, and
 * no `chatgpt.com/backend-api` request has been made. Section 7 says what that
 * leaves unproven; `docs/handoff.md` §2 is where the user closes it.
 */

export interface CodexDemoResult {
  readonly lines: readonly string[];
}

const CONVERSATION = asConversationId('conv-codex-demo');

/** What the scripted recogniser "hears" while the key is held. */
const PARTIALS = ['what', 'what is', 'what is this'] as const;
const QUESTION = 'What is this?';
const ANSWER =
  'That is the Update payment method button. ' +
  'It opens the billing sheet for this account. ' +
  'The card on file is charged when the plan renews.';

const TOKENS_PER_SECOND = 20;

function envelope(transcript: string, utterance: string): QuestionEnvelope {
  return {
    utteranceId: asUtteranceId(utterance),
    transcript,
    conversationId: CONVERSATION,
    scene: { id: 'scene-1', revision: 1, windowTitle: 'Billing Settings', lastObservedRevision: 0 },
    pointer: { normalizedX: 0.5, normalizedY: 0.5, targetRole: 'button', targetLabel: 'Renew' },
  };
}

/** A screen-context service that counts. Zero is what "no screen was read" means. */
function countingScreenContext(): ScreenContextService & { observations(): number } {
  const inner = new FakeScreenContextService();
  let observations = 0;
  return {
    observations: () => observations,
    status: () => inner.status(),
    async observe(request, signal) {
      observations += 1;
      return inner.observe(request, signal);
    },
    clear: () => inner.clear(),
  };
}

interface RunOutcome {
  readonly events: readonly AgentEvent['type'][];
  readonly error: SerializedPilotError | null;
  readonly text: string;
  /** The refusal `submit()` itself threw, before a run ever started. */
  readonly rejected: SerializedPilotError | null;
}

/**
 * Asks one question through the shipping session and reports what came back.
 *
 * `submit()` rejecting and the run failing are recorded separately on purpose:
 * the first means nothing was ever started — no provider request, no capture —
 * and the second means a request went out and failed. Collapsing them would
 * lose the whole claim this PR makes about ordering.
 */
async function ask(
  session: {
    submit(envelope: QuestionEnvelope): Promise<{ completed: Promise<void> }>;
    subscribe(listener: (event: AgentEvent) => void): () => void;
  },
  question: string,
  utterance: string,
): Promise<RunOutcome> {
  const events: AgentEvent['type'][] = [];
  let error: SerializedPilotError | null = null;
  let text = '';
  const off = session.subscribe((event) => {
    events.push(event.type);
    if (event.type === 'run-failed') {
      error = event.error;
    }
    if (event.type === 'run-completed') {
      text = event.text;
    }
  });
  try {
    const handle = await session.submit(envelope(question, utterance));
    await handle.completed;
    return { events, error, text, rejected: null };
  } catch (cause) {
    const serialized = cause as { toJSON?: () => SerializedPilotError };
    return {
      events,
      error,
      text,
      rejected: serialized.toJSON?.() ?? ({ message: String(cause) } as SerializedPilotError),
    };
  } finally {
    off();
  }
}

export async function runCodexDemo(): Promise<CodexDemoResult> {
  const lines: string[] = [];
  const say = (line = ''): void => {
    lines.push(line);
  };
  const evidence = (label: string, value: string): void => {
    say(`     ${label.padEnd(46)} ${value}`);
  };

  say('PR-037 — Codex subscription profile');
  say('='.repeat(72));
  say();
  say('Sign in without an API key, keep the token alive, refuse a model that');
  say('cannot see, recover from an expired sign-in, and run the MVP point-ask-');
  say('hear flow on the result — through the objects main/index.ts builds.');
  say();
  say('Real: createCodexRuntime, CodexGate, createCodexModelSource, the real');
  say('      openai-codex provider id and model catalogue from pi-ai@0.84.1,');
  say('      createCodexCredentialStore, createCodexAgentSession, the capability');
  say('      gate, createAgentRuntime, PiAgentSession, and in §5 the whole');
  say('      observation rig over the Node helper stub.');
  say('NOT REAL: NO CHATGPT ACCOUNT, NO SIGN-IN, NO TOKEN, NO NETWORK, NO MACOS.');
  say('      The OAuth endpoints are a recorded fake. Section 7 lists what that');
  say('      leaves unproven.');
  say();

  const sink: LogSink & { readonly records: readonly LogRecord[] } = createMemorySink();
  const logger = createLogger({ scope: 'codex-demo', level: 'debug', sink });
  const workspace = await mkdtemp(join(tmpdir(), 'pilot-codex-'));
  const secrets: string[] = [];

  try {
    // -----------------------------------------------------------------------
    // 1 — sign in, device code only
    // -----------------------------------------------------------------------
    say('1. sign in, without an API key');
    say();

    const source = createFakeCodexModelSource({ tokensPerSecond: TOKENS_PER_SECOND, logger });
    evidence('provider:', source.providerId);
    evidence('model chosen:', `${source.profile.model} (of ${source.visionModels.join(', ')})`);
    evidence('auth mode:', source.profile.authMode);
    evidence('before sign-in:', source.description);
    evidence('provider requests so far:', String(source.requestCount()));
    say();

    const codes: CodexDeviceCode[] = [];
    const signIn = await source.auth.signIn({ deviceCode: (code) => codes.push(code) });
    const [code] = codes;
    evidence('prompts Pi asked:', signIn.log.prompts.join(', '));
    evidence('login method chosen:', String(signIn.log.chose));
    evidence('events Pi emitted:', signIn.log.events.join(', '));
    evidence('user code:', String(code?.userCode));
    evidence('verification URI:', String(code?.verificationUri));
    evidence(
      `port ${String(CODEX_BROWSER_CALLBACK_PORT)} bound:`,
      String(source.surface.browserServerBound()),
    );
    evidence('after sign-in:', source.description);
    evidence('status label:', source.auth.snapshot().label);
    say();
    say('   Runbook amendment 7 and docs/pi-notes.md §9.1: browser login binds');
    say(
      `   127.0.0.1:${String(CODEX_BROWSER_CALLBACK_PORT)} BEFORE it announces itself and does not open a`,
    );
    say('   browser. The only moment it can still be declined is the select');
    say('   prompt, so that is where Pilot declines it — and the fake surface');
    say('   records the port binding so "never chosen" is a measurement.');
    say();

    // The other branch, driven deliberately: what a driver that answered
    // `browser` would have caused.
    const wouldBind = createFakeCodexModelSource({ logger });
    await wouldBind.surface.provider.auth.oauth
      ?.login({
        signal: new AbortController().signal,
        async prompt(prompt) {
          return prompt.type === 'select' ? CODEX_BROWSER_METHOD : 'anything';
        },
        notify: () => undefined,
      })
      .catch(() => undefined);
    evidence(
      'a driver answering "browser" binds it:',
      String(wouldBind.surface.browserServerBound()),
    );
    evidence('Pilot’s driver would answer:', CODEX_DEVICE_CODE_METHOD);
    say();

    // And the refusal itself, at the prompt, with nothing else running.
    const refusal = createCodexDeviceCodeInteraction({ deviceCode: () => undefined });
    const refused = await refusal.interaction
      .prompt({ type: 'manual_code', message: 'paste the redirect URL' })
      .then(() => null)
      .catch((cause: unknown) => cause as { code?: string; userMessage?: string });
    evidence('a manual_code prompt is:', `refused — ${String(refused?.code)}`);
    say();

    // -----------------------------------------------------------------------
    // 2 — token lifecycle
    // -----------------------------------------------------------------------
    say('2. token lifecycle');
    say();
    const active = source.auth.snapshot();
    evidence('state:', active.state);
    evidence(
      'valid for:',
      `${String(Math.round((active.expiresInMs ?? 0) / 60_000))} minute(s) (source: ${String(active.source)})`,
    );
    evidence('subscription-backed:', String(active.isSubscription));

    // Slide the stored expiry inside Pi's own five-minute refresh window.
    await source.surface.expireIn(60_000);
    const due = await source.auth.refresh();
    evidence('after expiring in 60s, state:', due.state);
    evidence('sign-in required:', String(due.signInRequired));

    source.setScript([{ say: 'A one-line answer.' }]);
    const tokensBefore = source.surface.issuedTokens.length;
    await source.models.completeSimple(source.model, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() }],
    });
    evidence('refreshes Pi performed:', String(source.surface.refreshCount()));
    evidence(
      'access tokens issued:',
      `${String(tokensBefore)} → ${String(source.surface.issuedTokens.length)} (rotated under the store lock)`,
    );
    evidence('state after the request:', (await source.auth.refresh()).state);
    say();
    say('   Pilot refreshes nothing itself. Pi rotates a token with less than');
    say('   five minutes left inside credentials.modify(), so two concurrent');
    say('   requests cannot double-refresh. Pilot’s job is to report the same');
    say('   boundary, so the status a user reads and the behaviour they get');
    say('   agree — describeCodexAuth() is that one table.');
    say();

    // -----------------------------------------------------------------------
    // 3 — the capability gate, before any screen data
    // -----------------------------------------------------------------------
    say('3. vision/tool capability validation — refused before any screen data');
    say();
    const textOnly = createFakeCodexModelSource({ model: CODEX_TEXT_ONLY_MODEL, logger });
    await textOnly.auth.signIn({ deviceCode: () => undefined });
    const screen = countingScreenContext();
    const refusedRuntime = createAgentRuntime({
      conversationId: CONVERSATION,
      source: textOnly,
      screenContext: screen,
      logger,
    });
    const refusedSession = createCodexRuntimeSession(textOnly, refusedRuntime.session);
    const blocked = await ask(refusedSession, 'What is this?', 'utt-blocked');

    evidence('model:', `${textOnly.profile.model} — input: ${textOnly.model.input.join(', ')}`);
    evidence('Model.input includes "image":', String(textOnly.profile.supportsVision));
    evidence('supportsTools (configured):', String(textOnly.profile.supportsTools));
    evidence('gate decision:', textOnly.capability.ok ? 'accepted' : 'REFUSED');
    evidence('refusal:', textOnly.capability.ok ? '—' : `${textOnly.capability.refusal.reason}`);
    evidence(
      'what the user is told:',
      textOnly.capability.ok ? '—' : textOnly.capability.refusal.userMessage,
    );
    evidence('the question was:', blocked.rejected === null ? 'run-failed' : 'REFUSED AT SUBMIT');
    evidence('error code:', String((blocked.rejected ?? blocked.error)?.code));
    evidence('screen observations taken:', String(screen.observations()));
    evidence('provider requests made:', String(textOnly.requestCount()));
    evidence('description:', textOnly.description);
    say();
    say('   Both numbers are zero, and that is the Phase 4 gate line: "unsupported');
    say('   vision/tool combinations are blocked before screen data is sent". Pi');
    say('   silently IGNORES images for a non-vision model (docs/pi-notes.md §2.3),');
    say('   so a model that cannot see does not error — it answers confidently');
    say('   about a screen it never saw. That is why this is a refusal.');
    say();
    await refusedRuntime.dispose();

    // -----------------------------------------------------------------------
    // 4 — auth-expiry recovery
    // -----------------------------------------------------------------------
    say('4. auth-expiry recovery');
    say();
    const recovery = createFakeCodexModelSource({ tokensPerSecond: 200, logger });
    const recoveryScreen = countingScreenContext();
    const recoveryRuntime = createAgentRuntime({
      conversationId: CONVERSATION,
      source: recovery,
      screenContext: recoveryScreen,
      logger,
    });
    const recoverySession = createCodexRuntimeSession(recovery, recoveryRuntime.session);

    const signedOut = await ask(recoverySession, 'What is this?', 'utt-signed-out');
    evidence('signed out — submit():', signedOut.rejected === null ? 'accepted' : 'REFUSED');
    evidence('code:', String(signedOut.rejected?.code));
    evidence('sentence shown to the user:', String(signedOut.rejected?.userMessage));
    evidence('provider requests:', String(recovery.requestCount()));
    evidence('screen observations:', String(recoveryScreen.observations()));
    say();

    await recovery.auth.signIn({ deviceCode: () => undefined });
    recovery.setScript([{ say: 'The renewal date is the 14th.' }]);
    const answered = await ask(recoverySession, 'When does it renew?', 'utt-ok');
    evidence('after signing in, the answer:', answered.text);
    evidence('provider requests:', String(recovery.requestCount()));
    say();

    // Now the failure this section exists for: the stored token is inside Pi's
    // refresh window and the provider refuses to rotate it.
    await recovery.surface.expireIn(60_000);
    recovery.surface.failNextRefresh();
    await recovery.auth.refresh();
    recovery.setScript([{ say: 'never sent' }]);
    const stale = await ask(recoverySession, 'And after that?', 'utt-stale');
    evidence('refresh failed — outcome:', stale.error === null ? 'no failure' : 'run-failed');
    evidence('code:', String(stale.error?.code));
    evidence('sentence shown to the user:', String(stale.error?.userMessage));
    evidence('retryable:', String(stale.error?.retryable));
    evidence('screen observations during it:', String(recoveryScreen.observations()));
    say();
    say('   Without the translation in createCodexAgentSession the panel would');
    say('   have shown Pi’s own words — "OAuth refresh failed for openai-codex:');
    say('   OpenAI Codex token refresh failed (400)…" — which is accurate and');
    say('   tells the user nothing they can act on. system-design §16 keeps the');
    say('   text box live in `error`, so the recovery is: read the sentence,');
    say('   press Sign in again.');
    say();

    // Hard-expire it, so the pre-flight rather than the refresh is what refuses.
    await recovery.surface.expireIn(-60_000);
    await recovery.auth.refresh();
    const requestsBefore = recovery.requestCount();
    const expired = await ask(recoverySession, 'Still there?', 'utt-expired');
    evidence('hard-expired — submit():', expired.rejected === null ? 'accepted' : 'REFUSED');
    evidence('code:', String(expired.rejected?.code));
    evidence(
      'provider requests during it:',
      `${String(requestsBefore)} → ${String(recovery.requestCount())}`,
    );
    say();

    // …and the recovery itself.
    await recovery.auth.signIn({ deviceCode: () => undefined });
    recovery.setScript([{ say: 'Yes — still here.' }]);
    const recovered = await ask(recoverySession, 'Still there?', 'utt-recovered');
    evidence('after signing in again:', recovered.text);
    evidence('lastError:', recovered.error === null ? '(none)' : String(recovered.error.code));
    say();
    await recoveryRuntime.dispose();

    for (const token of [
      ...source.surface.issuedTokens,
      ...recovery.surface.issuedTokens,
      ...textOnly.surface.issuedTokens,
    ]) {
      secrets.push(token);
    }

    // -----------------------------------------------------------------------
    // 5 — the point-ask-hear flow, on the Codex profile
    // -----------------------------------------------------------------------
    say('5. point, ask, hear — on the Codex profile');
    say();
    const flowSource = createFakeCodexModelSource({
      tokensPerSecond: TOKENS_PER_SECOND,
      logger,
    });
    await flowSource.auth.signIn({ deviceCode: () => undefined });
    // Hazard 16: queue the model's replies BEFORE the event that starts the run.
    // The key release finalises the transcript and submits on the same turn of
    // the loop, so a script set afterwards races the run it is meant to drive.
    flowSource.setScript([{ observe: { view: 'both', moment: 'question' } }, { say: ANSWER }]);

    const rig = await createObservationRig({
      stub: {
        permissions: GRANTED,
        desktop: DEMO_DESKTOP,
        axElements: AX_ELEMENTS,
        captureFrameBytes: 3_072,
        captureScaleFactor: 2,
        hotkeyScripts: [[{ key: 'down' }], [{ key: 'up' }]],
        speechInput: {
          scripts: [
            {
              steps: [
                {
                  on: 'start',
                  emit: PARTIALS.map((transcript) => ({ type: 'partial', transcript })),
                },
                { on: 'stop', emit: [{ type: 'final', transcript: QUESTION }] },
              ],
            },
          ],
        },
        pointerScript: [OUTSIDE_THE_WINDOW, OVER_A_STACKED_WINDOW, OVER_THE_BUTTON],
      },
      modelSource: flowSource,
      recordRequests: true,
      logger,
      // This trace owns the ring: it pushes decodable screenshots, and a stub
      // frame landing between one of them and the question anchored on it would
      // turn `moment: 'question'` into a decode failure.
      capturePollIntervalMs: 3_600_000,
      speechPollIntervalMs: 60,
      conversationId: CONVERSATION,
    });
    const panel = recordPanel(rig);
    try {
      await rig.permissions.refresh();
      await rig.observation.refreshAttribution();
      const window = await rig.firstWindow();
      await rig.windows.act({ type: 'select', windowId: window.windowId });
      await rig.controller.settled();

      await pressKey(rig, false);
      await waitFor('the recogniser to hear something', () => {
        const live = rig.controller.snapshot().liveTranscript;
        return live !== null && live !== '';
      });
      // Outside the window, then over another application's window, then onto
      // the control the question is about — one coalescing bucket apart, as the
      // 30 Hz poller would produce them (runbook cross-lane issue 14).
      await rig.observation.samplePointer();
      await nextPointerBucket();
      await rig.observation.samplePointer();
      await nextPointerBucket();
      await rig.observation.samplePointer();
      // Pushed here rather than before the key, because the frame ring is
      // bounded to ringDurationMs = 3 000 ms and `moment: 'question'` selects
      // the frame from when the question was asked (runbook cross-lane issue 16).
      const admitted = await pushScreenshot(rig, window, {
        id: 'frame-question',
        capturedAt: Date.now(),
      });
      await releaseKey(rig);
      await settleRun(rig);

      const utterances = spoken(rig);
      evidence(
        'profile in force:',
        rig.agent.session.profile.provider + '/' + rig.agent.session.profile.model,
      );
      evidence('auth state:', flowSource.auth.snapshot().state);
      evidence('§11 budget:', String(rig.agent.contextWindow.contextWindow));
      evidence(
        'context-window rule:',
        `${rig.agent.contextWindow.source} (advertised ${String(rig.agent.contextWindow.advertised)}, ${rig.agent.contextWindow.remote ? 'remote' : 'local'})`,
      );
      evidence('states the panel showed:', panel.states.join(' → '));
      evidence('question:', QUESTION);
      evidence('frame of the selected window:', `admitted=${String(admitted)}`);
      evidence(
        'pointer target the model was told:',
        String(rig.anchoring.lastAnchor()?.targetRole),
      );
      evidence('observe_screen calls:', String(rig.agent.notebook.size));
      evidence('answer on screen:', answerOf(rig));
      evidence('utterances spoken:', String(utterances.length));
      evidence('provider requests:', String(flowSource.requestCount()));
      evidence('lastError:', rig.controller.snapshot().lastError?.code ?? '(none)');
      say();
      say('   This is docs/mvp-01-point-ask-hear.md §2, end to end, with a real');
      say('   ChatGPT-subscription ModelSource in place of the development one —');
      say('   runbook follow-up 22’s "a real provider is one call site", checked');
      say('   rather than asserted. Everything about the flow itself is exactly');
      say('   what pnpm demo:flow shows and no better: no macOS, no key, no');
      say('   microphone, no speaker, and no model.');
      say();

      for (const token of flowSource.surface.issuedTokens) {
        secrets.push(token);
      }

      // ---------------------------------------------------------------------
      // 6 — the credential never leaks
      // ---------------------------------------------------------------------
      say('6. the credential never leaks (Phase 4 gate)');
      say();

      // A real, on-disk credential store, and a real sign-in through it: the
      // token below is written by `Models.login` → `credentials.modify`, not
      // planted here.
      const credentialsPath = codexCredentialsPath(workspace);
      const fileStore = createCodexCredentialStore({ filePath: credentialsPath, logger });
      const onDiskSource = createFakeCodexModelSource({ credentials: fileStore, logger });
      await onDiskSource.auth.signIn({ deviceCode: () => undefined });
      for (const token of onDiskSource.surface.issuedTokens) {
        secrets.push(token);
      }

      const runtime = createCodexRuntime({
        env: { PILOT_MODEL_PROFILE: 'codex' },
        credentialsPath,
        source: onDiskSource,
        logger,
      });
      await runtime.refresh();
      const gate = new CodexGate({ runtime, logger });
      const gateState = JSON.stringify(gate.state());
      const viewState = JSON.stringify(rig.controller.snapshot());
      const logText = JSON.stringify(sink.records);
      const transcript = JSON.stringify(rig.agent.contextSummary());
      const providerRequests = flowSource.requests.join('\n');
      const onDisk = readFileSync(credentialsPath, 'utf8');

      const watched = [...new Set(secrets)].filter((secret) => secret !== '');
      const leaks = (haystack: string): string =>
        watched.some((secret) => haystack.includes(secret)) ? 'LEAKED' : 'clean';

      evidence('access/refresh tokens watched for:', String(watched.length));
      evidence('renderer state (CodexGateState):', leaks(gateState));
      evidence('renderer state (PilotViewState):', leaks(viewState));
      evidence('application log (every record):', leaks(logText));
      evidence('session transcript summary:', leaks(transcript));
      evidence('every provider request Pilot built:', leaks(providerRequests));
      evidence(
        'the credential file itself:',
        leaks(onDisk) === 'LEAKED' ? 'holds the token — the ONE place it is written' : 'MISSING IT',
      );
      evidence('file mode:', `0${(statSync(credentialsPath).mode & 0o777).toString(8)}`);
      evidence('encrypted at rest:', String(gate.state().credentialsEncrypted));
      evidence('gate fields the renderer sees:', Object.keys(gate.state()).join(', '));
      evidence('auth fields the renderer sees:', Object.keys(gate.state().auth).join(', '));

      await runtime.signOut();
      const gone = !existsSync(credentialsPath);
      evidence('after sign out — the file is:', gone ? 'deleted' : 'STILL THERE');
      evidence('after sign out — status:', gate.state().auth.label);
      say();
      gate.dispose();
      await runtime.dispose();
    } finally {
      panel.stop();
      await rig.dispose();
    }

    // -----------------------------------------------------------------------
    // 7 — what this cannot prove
    // -----------------------------------------------------------------------
    say('7. what none of the above proves');
    say();
    say('   NO CHATGPT ACCOUNT, NO SIGN-IN, NO TOKEN, NO NETWORK, NO MACOS.');
    say();
    say('   - No request has ever been made to auth.openai.com. Whether Pi’s');
    say('     client id is accepted by the device-code endpoint, whether a real');
    say('     access token carries the chatgpt_account_id claim login requires,');
    say('     and how long a real token lives are all unknown.');
    say('   - No request has ever been made to chatgpt.com/backend-api. Whether');
    say('     the Codex Responses API accepts Pilot’s images and tool definitions');
    say('     is the biggest open question in the repository, and supportsTools');
    say('     is Pilot’s own assertion — Pi reports nothing about tool support.');
    say('   - Electron safeStorage has never run. The encryption seam is');
    say('     exercised here only through its plaintext fallback.');
    say('   - Section 5 inherits every gap pnpm demo:flow has: no key was');
    say('     pressed, no audio recorded, no sound produced, no pixel captured');
    say('     by macOS, and *that* the model called observe_screen is scripted.');
    say();
    say('   docs/handoff.md §2 is the runnable list that closes the first two.');
    say();

    return { lines };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/**
 * The session `main/index.ts` hands the interaction controller.
 *
 * Written out here rather than reaching into `createCodexRuntime`, because the
 * sections above build their own `AgentRuntime`s and the point is that the
 * wrapping is the same one line either way — `codex.wrapSession(session)`.
 */
function createCodexRuntimeSession(
  source: FakeCodexModelSource,
  session: AgentSession,
): AgentSession {
  return createCodexAgentSession(session, source.auth);
}
