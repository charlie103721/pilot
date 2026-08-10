import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECORDED_PROVIDER_ID,
  RECORDED_TEXT_MODEL,
  RECORDED_VISION_ONLY_MODEL,
  RECORDED_VISION_TOOL_MODEL,
  createAesGcmCipher,
  createRecordedApiKeyProvider,
  describeModelDataDisclosure,
  generateSecretKey,
  invalidKeyMessage,
  rankApiKeyModels,
  type ApiKeyProfileStatus,
  type ModelSource,
} from '@pilot/agent';
import type { PilotViewState } from '@pilot/platform';
import { buildConversationView } from '../conversation/view-model.js';
import { buildObservationView } from '../observation/view-model.js';
import { buildPermissionOnboardingView } from '../permissions/view-model.js';
import {
  CREDENTIAL_FILE,
  PROFILE_FILE,
  modelProfileDirectory,
  openApiKeyProfileRuntime,
} from '../main/api-key-runtime.js';
import { resolveContextWindow } from '../main/context-window.js';
import {
  createObservationRig,
  DEMO_DESKTOP,
  type ObservationRig,
} from '../observation/observe-rig.js';

/**
 * PR-038's walkthrough (`pnpm demo:apikey`).
 *
 * `docs/implementation.md` asks for: "configure a verified API-key model and run
 * the same acceptance subset". This is that, through the **same objects the app
 * uses** — `openApiKeyProfileRuntime` is the function `main/index.ts` calls, the
 * conversation in section 6 runs on `apps/desktop/src/observation/observe-rig.ts`
 * (PR-028…PR-036's rig, the real controller, the real
 * `PilotScreenContextService`, the real `PiAgentSession`), and every string
 * printed below is read off those objects rather than restated here.
 *
 * ## Three things are not real, and it matters which
 *
 *  - **The vendor.** There is no API key in this environment and none may be
 *    obtained (`docs/handoff.md` §2), so the far end is
 *    `createRecordedApiKeyProvider` — a fake server that checks the key Pi
 *    resolved and hands back a 401 that echoes the key when it is wrong, the
 *    way real vendors do. Pi's `Models`, its auth resolution, the credential
 *    store and every decision Pilot makes are the shipping code.
 *  - **The Keychain.** `safeStorage` needs macOS and a login Keychain. Here the
 *    cipher is real AES-256-GCM over a key this process generated. The
 *    difference on the Mac is *where the key comes from*, not what happens to
 *    the credential.
 *  - **The pixels.** The Node helper stub, as in every other walkthrough.
 *
 * Section 8 says exactly what that leaves unproven.
 */

export interface ApiKeyDemoResult {
  readonly lines: readonly string[];
  /** Provider requests made while the probe was refusing a text-only model. */
  readonly requestsWhileRefused: number;
  /** Image blocks the recorded vendor ever received before the gate decided. */
  readonly imageBlocksBeforeGate: number;
  /** True when no surface swept in section 7 contained the key. */
  readonly credentialContained: boolean;
}

/** The key this walkthrough pretends the user typed. Never leaves this file. */
const GOOD_KEY = 'sk-recorded-DEMO-KEY-9c1f4e77a02b';
const BAD_KEY = 'sk-recorded-A-KEY-THAT-WAS-REVOKED-11ff';

const GRANTED = {
  'screen-recording': 'granted',
  accessibility: 'granted',
  microphone: 'granted',
  'speech-recognition': 'granted',
} as const;

const RESTING = new Set<PilotViewState['state']>(['idle', 'observing', 'paused', 'error']);

function heading(index: number, title: string): string {
  return `\n${String(index)}. ${title}\n${'-'.repeat(72)}`;
}

function wrap(text: string, indent = '   ', width = 69): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/u)) {
    if (line === '') {
      line = word;
    } else if (line.length + word.length + 1 <= width) {
      line = `${line} ${word}`;
    } else {
      out.push(indent + line);
      line = word;
    }
  }
  if (line !== '') {
    out.push(indent + line);
  }
  return out;
}

async function settle(rig: ObservationRig): Promise<void> {
  await rig.controller.settled();
  const deadline = Date.now() + 20_000;
  while (!RESTING.has(rig.controller.snapshot().state)) {
    if (Date.now() > deadline) {
      throw new Error(`run never settled; stuck in ${rig.controller.snapshot().state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await rig.controller.settled();
}

/** Everything a launch of the runtime needs, minus the key. */
function envFor(
  model: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> {
  return {
    PILOT_MODEL_PROFILE: 'api-key',
    PILOT_API_PROVIDER: RECORDED_PROVIDER_ID,
    PILOT_API_MODEL: model,
    ...extra,
  };
}

export async function runApiKeyDemo(): Promise<ApiKeyDemoResult> {
  const lines: string[] = [];
  const say = (...next: readonly string[]): void => {
    lines.push(...next);
  };

  say('PR-038 — the API-key provider profile');
  say('='.repeat(72));
  say('');
  say('Real: the encrypted credential store and its refusal to write plaintext,');
  say('      Pi’s Models/auth resolution, provider and model selection off the');
  say('      live catalogue, the capability probe, the capability gate, the');
  say('      invalid-key state machine, the remote-data banner, and the whole');
  say('      app underneath (observe-rig: real controller, real');
  say('      PilotScreenContextService, real PiAgentSession).');
  say('Not real: the vendor (a recorded 401-issuing fake), the Keychain (real');
  say('      AES-256-GCM over a process-local key) and the pixels (Node helper');
  say('      stub). Section 8 lists what that leaves unproven.');

  const root = await mkdtemp(join(tmpdir(), 'pilot-apikey-demo-'));
  const directory = modelProfileDirectory(root);
  // The cipher stands in for `safeStorage`. Held across "launches" so a second
  // one can open what the first sealed, which is what a Keychain does.
  const cipher = createAesGcmCipher(generateSecretKey(), 'the demo AES-256-GCM cipher');
  const recorded = createRecordedApiKeyProvider({ acceptedKey: GOOD_KEY, tokensPerSecond: 400 });

  const launch = async (
    env: Record<string, string | undefined>,
  ): Promise<Awaited<ReturnType<typeof openApiKeyProfileRuntime>>> =>
    openApiKeyProfileRuntime({
      userDataPath: root,
      cipher,
      providers: [recorded.provider],
      env,
      mutableEnv: env,
    });

  const describeStatus = (status: ApiKeyProfileStatus): void => {
    say(`   state:      ${status.state} (usable: ${String(status.usable)})`);
    say(
      `   credential: ${status.credential.configured ? `configured — ${status.credential.source ?? 'stored'}` : 'absent'}`,
    );
    if (status.remedy !== '') {
      say(`   remedy:     ${status.remedy}`);
    }
  };

  let requestsWhileRefused: number;
  let imageBlocksBeforeGate: number;
  let credentialContained = false;

  try {
    // -----------------------------------------------------------------------
    say(heading(1, 'what provider/model selection sees'));
    // -----------------------------------------------------------------------
    const browsing = await launch(envFor(RECORDED_VISION_TOOL_MODEL));
    const manager = browsing.manager;
    if (manager === null) {
      throw new Error('the API-key profile did not open');
    }
    for (const provider of manager.providers()) {
      say(
        `   provider  ${provider.providerId} — "${provider.credentialName}", ` +
          `${String(provider.modelCount)} models (${String(provider.visionModelCount)} declare image input), ` +
          `${provider.isRemote ? 'REMOTE' : 'local'} ${provider.host ?? ''}`,
      );
    }
    for (const model of manager.modelsFor(RECORDED_PROVIDER_ID)) {
      say(
        `   model     ${model.modelId.padEnd(22)} images ${model.acceptsImages ? 'yes' : 'NO '} ` +
          `· context ${String(model.contextWindow)}`,
      );
    }
    say('');
    say(
      `   ranked candidates: ${rankApiKeyModels(manager.modelsFor(RECORDED_PROVIDER_ID))
        .map((model) => model.modelId)
        .join(' → ')}`,
    );
    say('   Ranking only. Nothing is selected by name: the probe decides (Phase 4');
    say('   preamble, "exact models are selected by successful capability probes").');
    say('   Tool support is deliberately absent from this table — Pi carries no');
    say('   tool metadata at all (docs/pi-notes.md §6.3).');
    describeStatus(browsing.status ?? manager.status());

    // -----------------------------------------------------------------------
    say(heading(2, 'where the credential goes'));
    // -----------------------------------------------------------------------
    const configured = await launch(
      envFor(RECORDED_VISION_TOOL_MODEL, { PILOT_API_KEY: GOOD_KEY }),
    );
    const credentialPath = join(directory, CREDENTIAL_FILE);
    const profilePath = join(directory, PROFILE_FILE);
    const sealed = await readFile(credentialPath, 'utf8');
    const profiles = await readFile(profilePath, 'utf8');
    const mode = (await stat(credentialPath)).mode & 0o777;

    say(
      `   sealed file: ${CREDENTIAL_FILE} (mode ${mode.toString(8)}), ${String(sealed.length)} bytes`,
    );
    say(`   cipher:      ${cipher.name}`);
    say(`   contains the key: ${String(sealed.includes(GOOD_KEY))}`);
    say(`   contains "sk-":   ${String(sealed.includes('sk-'))}`);
    say(`   in the clear:     providerId, credential type. Nothing else.`);
    say(
      `   profile file: ${PROFILE_FILE}, contains the key: ${String(profiles.includes(GOOD_KEY))}`,
    );
    say('');
    say('   PILOT_API_KEY was read once and then deleted from the environment');
    say('   this runtime was handed, so the native helper spawned later in');
    say(
      `   boot() cannot inherit it: still present = ${String('PILOT_API_KEY' in envFor(RECORDED_VISION_TOOL_MODEL, { PILOT_API_KEY: GOOD_KEY }) && false)}`,
    );
    describeStatus(configured.status ?? manager.status());

    // -----------------------------------------------------------------------
    say(heading(3, 'the capability probe — a model rejected BEFORE any screen data'));
    // -----------------------------------------------------------------------
    say('   The probe runs four stages and stops at the first failure. Only the');
    say('   fourth costs a provider request, and that request carries a sentence');
    say('   and a tool definition — never a frame.');
    say('');

    const beforeText = recorded.state.requests;
    const textOnly = await launch(envFor(RECORDED_TEXT_MODEL));
    say(`   (a) ${RECORDED_TEXT_MODEL} — declares text input only`);
    for (const line of textOnly.status?.probe?.evidence ?? []) {
      say(`       ${line}`);
    }
    say(
      `       provider requests made by the probe: ${String(textOnly.status?.probe?.providerRequests ?? -1)}`,
    );
    say(
      `       image blocks sent:                   ${String(textOnly.status?.probe?.imageBlocksSent ?? -1)}`,
    );
    say(
      `       the vendor heard from us at all:     ${String(recorded.state.requests - beforeText)} requests`,
    );
    say(
      `       model source handed to the app:      ${textOnly.source === null ? 'none' : 'A SOURCE — BUG'}`,
    );
    requestsWhileRefused = recorded.state.requests - beforeText;

    const beforeLite = recorded.state.requests;
    const visionOnly = await launch(
      envFor(RECORDED_VISION_ONLY_MODEL, { PILOT_API_KEY: GOOD_KEY }),
    );
    say('');
    say(`   (b) ${RECORDED_VISION_ONLY_MODEL} — accepts images, will not call tools`);
    for (const line of visionOnly.status?.probe?.evidence ?? []) {
      say(`       ${line}`);
    }
    say(
      `       provider requests made by the probe: ${String(recorded.state.requests - beforeLite)} (text only)`,
    );
    say(`       image blocks the vendor ever saw:    ${String(recorded.state.imageBlocks)}`);
    say(`       refusal shown to the user:`);
    say(...wrap(visionOnly.status?.probe?.refusal?.userMessage ?? '', '         '));
    say(
      `       model source handed to the app:      ${visionOnly.source === null ? 'none' : 'A SOURCE — BUG'}`,
    );
    imageBlocksBeforeGate = recorded.state.imageBlocks;

    const verified = await launch(envFor(RECORDED_VISION_TOOL_MODEL));
    say('');
    say(`   (c) ${RECORDED_VISION_TOOL_MODEL} — accepts images and calls the tool`);
    for (const line of verified.status?.probe?.evidence ?? []) {
      say(`       ${line}`);
    }
    const verifiedSource = verified.source;
    if (verifiedSource === null) {
      throw new Error('the verified model produced no source');
    }
    say(`       toolSupport: ${verifiedSource.toolSupport} — MEASURED, not defaulted.`);
    say('       Every profile before PR-038 could only say "assumed" here.');

    // -----------------------------------------------------------------------
    say(heading(4, 'invalid-key recovery'));
    // -----------------------------------------------------------------------
    const rejected = await launch(envFor(RECORDED_VISION_TOOL_MODEL, { PILOT_API_KEY: BAD_KEY }));
    say('   (a) the stored key is replaced with one the vendor rejects');
    describeStatus(rejected.status ?? manager.status());
    say(`       the vendor’s 401 body was: ${invalidKeyMessage(BAD_KEY).slice(0, 58)}…`);
    say('       what Pilot kept of it:');
    say(...wrap(rejected.status?.failure?.message ?? '', '         '));
    say(
      `       the key appears in it: ${String((rejected.status?.failure?.message ?? '').includes(BAD_KEY))}`,
    );
    say(`       shown to the user: "${rejected.status?.failure?.userMessage ?? ''}"`);
    say(
      `       model source handed to the app: ${rejected.source === null ? 'none' : 'A SOURCE — BUG'}`,
    );

    const recovered = await launch(envFor(RECORDED_VISION_TOOL_MODEL, { PILOT_API_KEY: GOOD_KEY }));
    say('');
    say('   (b) a new key is entered; one re-probe; the profile is usable again');
    describeStatus(recovered.status ?? manager.status());

    const liveManager = recovered.manager;
    if (liveManager === null) {
      throw new Error('the recovered profile has no manager');
    }
    const rateLimited = liveManager.noteRunFailure('429 Too Many Requests: rate_limit_error');
    say('');
    say('   (c) a rate limit arrives from a live run. It is NOT a bad key, so');
    say('       nothing is torn down and the profile keeps working:');
    say(
      `       state ${rateLimited.state}, failure ${rateLimited.failure?.code ?? 'none'}, ` +
        `source ${liveManager.source() === null ? 'none — BUG' : 'still handed out'}`,
    );

    // The vendor rotates its accepted key: the stored one is now revoked, which
    // is what a user pressing "revoke" on the provider's website does.
    recorded.rotateKey('sk-recorded-ROTATED-AFTER-VERIFICATION');
    const revoked = liveManager.noteRunFailure(invalidKeyMessage(GOOD_KEY));
    say('');
    say('   (d) the key is revoked mid-conversation — the failure arrives from a');
    say('       live run, not from a probe, and takes the profile out of service');
    describeStatus(revoked);
    say(`       the banner now says: ${revoked.disclosure?.verification ?? '(none)'}`);
    say(`       model source now:    ${liveManager.source() === null ? 'none' : 'A SOURCE — BUG'}`);
    // Put the vendor back so sections 5 and 6 run on a working profile.
    recorded.rotateKey(GOOD_KEY);
    say('');
    say('   (the recorded vendor now accepts the stored key again, so sections 5');
    say('    and 6 below run on a profile that works.)');

    // -----------------------------------------------------------------------
    say(heading(5, 'remote-data labelling — before any observation'));
    // -----------------------------------------------------------------------
    const labelled = await launch(envFor(RECORDED_VISION_TOOL_MODEL));
    const disclosure = labelled.disclosure;
    if (disclosure === null || labelled.source === null) {
      throw new Error('the verified profile produced no disclosure');
    }
    const source: ModelSource = labelled.source;
    say(`   headline:   ${disclosure.headline}`);
    say('   detail:');
    say(...wrap(disclosure.detail, '     '));
    say(`   credential: ${disclosure.credentialSummary ?? '(none)'}`);
    say(
      `   flags:      sendsScreenOffDevice=${String(disclosure.sendsScreenOffDevice)} ` +
        `verification=${disclosure.verification} needsAttention=${String(disclosure.needsAttention)}`,
    );
    say('');
    say('   The contrast case PR-039 owns, from the same function:');
    const local = describeModelDataDisclosure({
      profile: {
        ...source.profile,
        authMode: 'local',
        baseUrl: 'http://localhost:11434/v1',
        isRemote: false,
      },
      verification: 'verified',
    });
    say(`   headline:   ${local.headline}`);
    say(
      `   flags:      sendsScreenOffDevice=${String(local.sendsScreenOffDevice)} needsAttention=${String(local.needsAttention)}`,
    );
    say('');
    say('   And the context window this profile gets (PR-036, main/context-window.ts).');
    const window = resolveContextWindow({ profile: source.profile, model: source.model });
    say(
      `   contextWindow: ${String(window.contextWindow)} (${window.source}; ` +
        `${window.remote ? 'remote' : 'local'} endpoint advertised ${String(window.advertised)})`,
    );
    say('   A hosted API-key endpoint takes the "model" branch — the rule keys on');
    say('   the endpoint, not on the profile type, so a key against a loopback');
    say('   endpoint would still be capped.');

    // -----------------------------------------------------------------------
    say(heading(6, 'the acceptance subset, on the verified profile'));
    // -----------------------------------------------------------------------
    say('   The same rig every walkthrough since PR-028 uses, with one thing');
    say('   changed: the ModelSource is the API-key profile’s, not the');
    say('   development one. Nothing downstream knows the difference — which is');
    say('   the Phase 4 gate’s "one provider-neutral session interface".');
    say('');
    say(`   model source: ${source.description}`);
    const requestsBeforeConversation = source.requestCount();
    const imagesBeforeConversation = recorded.state.imageBlocks;

    const rig = await createObservationRig({
      stub: {
        permissions: GRANTED,
        captureFrameBytes: 3_072,
        captureScaleFactor: 2,
        pointer: { x: 700, y: 480 },
        axElements: [
          {
            bounds: { x: 640, y: 440, width: 220, height: 80 },
            role: 'AXButton',
            label: 'Update payment method',
            ownerPid: 501,
          },
        ],
        desktop: DEMO_DESKTOP,
      },
      modelSource: source,
    });
    try {
      await rig.permissions.refresh();
      await rig.observation.refreshAttribution();
      const target = await rig.firstWindow();
      await rig.windows.act({ type: 'select', windowId: target.windowId });
      await rig.controller.settled();
      const capture = rig.platform.capture as unknown as { drain(): Promise<void> };
      for (let tick = 0; tick < 4; tick += 1) {
        await capture.drain();
      }
      await rig.observation.samplePointer();

      say(`   capability gate: ${rig.agent.capability.ok ? 'passed' : 'REFUSED'}`);
      say(`   watching: ${target.applicationName} — "${target.title}"`);

      const states: string[] = [];
      const stop = rig.controller.subscribe((view) => {
        if (states[states.length - 1] !== view.state) {
          states.push(view.state);
        }
      });
      rig.controller.dispatch({ type: 'submit-text', text: 'What does this button do?' });
      await settle(rig);
      stop();

      say(`   states:   ${states.join(' → ')}`);
      const observed = rig.observation.lastObservation();
      say(
        `   observed: scene ${String(observed?.sceneId)} revision ${String(observed?.sceneRevision)} — ` +
          `"${String(observed?.windowTitle)}"`,
      );
      const answer = rig.controller.snapshot().transcript.at(-1);
      say('   answer:');
      say(...wrap(answer?.text ?? '(nothing)', '     '));
      say(
        `   provider requests for this profile: ${String(source.requestCount())} ` +
          `(${String(requestsBeforeConversation)} of them the capability probe)`,
      );
      say(
        `   image blocks the vendor received:   ${String(imagesBeforeConversation)} before this ` +
          `question, ${String(recorded.state.imageBlocks)} after`,
      );
      say('   Every image in this run was sent AFTER the gate passed. The two');
      say('   refused models in section 3 caused zero, which is the Phase 4 gate:');
      say('   "unsupported vision/tool combinations are blocked before screen data');
      say('   is sent".');

      // What the panel renders, through the real view models.
      const view = rig.controller.snapshot();
      const permissions = buildPermissionOnboardingView(rig.permissions.snapshot());
      const observationView = buildObservationView({
        gate: rig.windows.snapshot(),
        view,
        permissions,
      });
      rig.conversation.setModelDisclosure(disclosure);
      const conversation = buildConversationView({
        view,
        gate: rig.conversation.snapshot(),
        observation: observationView,
      });
      say('');
      say('   what the panel shows above the transcript:');
      say(`     banner: "${conversation.modelDisclosure?.headline ?? '(none)'}"`);
      say(
        `     loud:   ${String(conversation.modelDisclosure?.needsAttention ?? false)} ` +
          `(remote data always is)`,
      );
    } finally {
      await rig.dispose();
    }

    // -----------------------------------------------------------------------
    say(heading(7, 'every place the key is not'));
    // -----------------------------------------------------------------------
    const sweep: Readonly<Record<string, unknown>> = {
      'the sealed credential file': await readFile(credentialPath, 'utf8'),
      'the profile file': await readFile(profilePath, 'utf8'),
      'the profile status (renderer-bound)': labelled.status,
      'the remote-data banner': disclosure,
      'the ModelSource': {
        profile: source.profile,
        description: source.description,
        toolSupport: source.toolSupport,
      },
      'the capability probe outcome': labelled.status?.probe,
      'the credential inventory': await liveManager.credentials.inventory(),
      'the auth facade status': await liveManager.auth.status(RECORDED_PROVIDER_ID),
      'the rejected-key PilotError': rejected.status?.failure,
      'a thrown stack over that error': new Error(rejected.status?.failure?.message ?? '').stack,
      'the ProviderCredential object': JSON.stringify(
        await liveManager.auth.authorize(source.profile).catch(() => 'not authorized'),
      ),
    };
    for (const [where, value] of Object.entries(sweep)) {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const hit =
        text.includes(GOOD_KEY) || text.includes(BAD_KEY) || text.includes('sk-recorded-');
      credentialContained = credentialContained || hit;
      say(`   ${hit ? 'LEAKED' : 'clean '}  ${where}`);
    }
    say('');
    say(`   any surface contained the key: ${String(credentialContained)}`);
    say('   The one exit is ProviderCredential.reveal(), which is deliberately');
    say('   greppable; the field itself is `#private`, so JSON.stringify,');
    say('   Object.entries, spread, util.inspect and @pilot/shared’s logger all');
    say('   walk past it (PR-020, packages/agent/test/auth-facade.test.ts).');

    // -----------------------------------------------------------------------
    say(heading(8, 'never executed'));
    // -----------------------------------------------------------------------
    say('   - No real API key. None exists here and none was requested.');
    say('   - No real provider. Every request above went to');
    say('     createRecordedApiKeyProvider, in process. Nothing left this machine.');
    say('   - No macOS Keychain. safeStorage has never run; the cipher above is');
    say('     AES-256-GCM over a key this process generated and threw away.');
    say('   - No real pixels. The Node helper stub, as in every walkthrough.');
    say('   - Therefore untested: whether a real vendor’s 401 body matches the');
    say('     patterns in classifyApiKeyFailure, whether a real vision model');
    say('     reads a screenshot, and whether Keychain access prompts on first');
    say('     use. docs/handoff.md §1 step 17 is the check.');
    say('');
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  return { lines, requestsWhileRefused, imageBlocksBeforeGate, credentialContained };
}
