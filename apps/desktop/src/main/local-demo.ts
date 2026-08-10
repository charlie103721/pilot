import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { asConversationId, describeEndpoint, type ModelProfile } from '@pilot/shared';
import type { PilotViewState } from '@pilot/platform';
import type { FakeScreenContextService } from '@pilot/platform/fakes';
import {
  AUTO_SELECT_MODEL,
  createLocalModelSource,
  describeCapabilities,
  localityStatement,
  normalizeLocalBaseUrl,
  probeLocalEndpoint,
  readLocalEndpointSettings,
  startStubOpenAiEndpoint,
  type LocalEndpointReport,
  type LocalModelSource,
  type StubEndpointBehaviour,
  type StubOpenAiEndpoint,
} from '@pilot/agent';
import type { PilotInteractionController } from '@pilot/interaction';
import { createAgentRuntime } from './agent-runtime.js';
import { createInteractionRuntime } from './interaction-runtime.js';
import { resolveLocalModelSource } from './local-model.js';
import {
  contextWindowInputOf,
  describeContextWindow,
  resolveContextWindow,
} from './context-window.js';

/**
 * PR-039's demo: Pilot against a locally running OpenAI-compatible endpoint.
 *
 * ## What the endpoint is
 *
 * **A stub written for this PR** (`packages/agent/src/stub-openai-endpoint.ts`),
 * not an inference server and not a language model. There is no llama.cpp,
 * Ollama, LM Studio, GPU or model weights on this machine. The stub answers the
 * four HTTP requests Pilot makes, in the shapes the OpenAI API documents, and
 * its "answers" come from a script in this file.
 *
 * It is **not a second Pilot service** — `docs/implementation.md` PR-039 forbids
 * one, and nothing in production constructs it. It stands in for the *user's*
 * server exactly as `FakeScreenContextService` stands in for a screen.
 * `docs/handoff.md` §1 step 17 is the list of questions only a real endpoint can
 * answer.
 *
 * ## What is real
 *
 * Everything above the socket: the settings parser, the probe ladder, every
 * diagnosis, `createLocalModelSource`, Pi's own `openai-completions` provider,
 * `Models`, `Agent`, `PiAgentSession`, the capability gate, `createAgentRuntime`
 * and `createInteractionRuntime` — the same two functions `main/index.ts` calls,
 * with the same arguments.
 *
 * ## What a reviewer should look for
 *
 * Section 4 prints **every unsupported-model failure mode with the sentence the
 * user would actually see**. Section 5 prints the capability gate refusing a
 * model that claims vision it does not have, together with the endpoint's own
 * record of what it received: three probe requests, zero streamed requests, and
 * image bytes equal to the probe's own 8×8 swatch. That is what "blocked before
 * screen data" means as a number rather than as a claim.
 */

export interface LocalDemoResult {
  readonly lines: readonly string[];
  /** Distinct diagnosis codes demonstrated in section 4. */
  readonly diagnosed: readonly string[];
  /** Image bytes the endpoint received while the gate was refusing. */
  readonly refusedScreenBytes: number;
  /** Image bytes the endpoint received during the healthy run. */
  readonly answeredScreenBytes: number;
  /** Turns that completed with an answer in section 6. */
  readonly turns: number;
}

function heading(title: string): string {
  return `\n── ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}`;
}

function wrap(text: string, width = 74, indent = '      '): string[] {
  const words = text.split(/\s+/u);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (current.length + word.length + 1 <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(indent + current);
      current = word;
    }
  }
  if (current !== '') {
    lines.push(indent + current);
  }
  return lines;
}

const RESTING = new Set<PilotViewState['state']>(['idle', 'observing', 'paused', 'error']);

async function settle(controller: PilotInteractionController, timeoutMs = 20_000): Promise<void> {
  await controller.settled();
  const deadline = Date.now() + timeoutMs;
  while (!RESTING.has(controller.snapshot().state)) {
    if (Date.now() > deadline) {
      throw new Error(`the run never settled; stuck in ${controller.snapshot().state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await controller.settled();
}

/** A loopback URL whose port was bound and released: connecting is refused. */
async function closedLoopbackUrl(): Promise<string> {
  const server = createNetServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return `http://127.0.0.1:${String(port)}/v1`;
}

/**
 * The probe, with its swatch colour fixed.
 *
 * The colour is normally chosen at random so a model cannot memorise one
 * answer. That makes a walkthrough flaky in a way that matters: a model which
 * cannot see guesses from the six names in the prompt and is right one time in
 * six, so section 4(h) would silently pass every sixth run. Fixing the seed
 * here makes the demo deterministic and leaves the real rate stated out loud
 * rather than averaged away.
 */
const probe: typeof probeLocalEndpoint = (settings, deps = {}) =>
  probeLocalEndpoint(settings, { random: () => 0.5, ...deps });

function imageBytesReceived(endpoint: StubOpenAiEndpoint): number {
  return endpoint.requests.reduce((sum, entry) => sum + entry.imageBytes, 0);
}

/** A hosted profile, for the locality contrast. PR-038 owns the real one. */
const HOSTED_PROFILE_FOR_CONTRAST = {
  id: 'profile-hosted-contrast',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  authMode: 'api-key',
  baseUrl: 'https://api.anthropic.com',
  supportsVision: true,
  supportsTools: true,
  isRemote: true,
} as ModelProfile;

export async function runLocalDemo(): Promise<LocalDemoResult> {
  const lines: string[] = [];
  const open: StubOpenAiEndpoint[] = [];
  const stub = async (
    options: Parameters<typeof startStubOpenAiEndpoint>[0] = {},
  ): Promise<StubOpenAiEndpoint> => {
    const endpoint = await startStubOpenAiEndpoint(options);
    open.push(endpoint);
    return endpoint;
  };

  lines.push('Pilot — local OpenAI-compatible model profile (PR-039)');
  lines.push('');
  lines.push('  THE ENDPOINT BELOW IS A STUB WRITTEN FOR THIS PR, NOT AN INFERENCE SERVER.');
  lines.push('  There is no local model on this machine. Everything above the socket is the');
  lines.push('  code that ships; the answers are scripted and say so. It is not a second');
  lines.push('  Pilot service — it stands in for the user’s own llama.cpp/Ollama/LM Studio.');

  try {
    // ---------------------------------------------------------------------
    // 1. Base URL and model settings.
    // ---------------------------------------------------------------------
    lines.push(heading('1. base URL and model settings'));
    const healthy = await stub({ modelId: 'qwen2.5-vl-7b', contextWindow: 32_768 });
    const configured = readLocalEndpointSettings({
      PILOT_LOCAL_BASE_URL: `  ${healthy.baseUrl}/  `,
      PILOT_LOCAL_MODEL: 'qwen2.5-vl-7b',
    });
    lines.push(`  PILOT_LOCAL_BASE_URL="  ${healthy.baseUrl}/  "`);
    lines.push(`  PILOT_LOCAL_MODEL="qwen2.5-vl-7b"`);
    lines.push(`  → baseUrl ${String(configured?.baseUrl)} · model ${String(configured?.model)}`);
    const autoSelected = readLocalEndpointSettings({ PILOT_LOCAL_BASE_URL: healthy.baseUrl });
    lines.push(
      `  With no model named: model "${String(autoSelected?.model)}" — Pilot asks the endpoint what`,
    );
    lines.push('  it is serving rather than making the user guess an id first.');
    lines.push(
      `  Nothing configured at all → ${String(readLocalEndpointSettings({}))}, and the app`,
    );
    lines.push('  keeps the development source. An unset variable never means "broken".');
    const badUrl = normalizeLocalBaseUrl('localhost:11434');
    lines.push(`  A URL with no scheme is refused before any request is made:`);
    lines.push(...wrap(`${badUrl.diagnosis?.userMessage ?? ''} ${badUrl.diagnosis?.remedy ?? ''}`));
    lines.push('  Note what Pilot does NOT do: silently append /v1. It names the missing');
    lines.push('  prefix only when the model list actually 404s — see section 4.');

    // ---------------------------------------------------------------------
    // 2. Endpoint health, through the composition root's own resolver.
    // ---------------------------------------------------------------------
    lines.push(heading('2. endpoint health'));
    const resolution = await resolveLocalModelSource({
      env: { PILOT_LOCAL_BASE_URL: healthy.baseUrl, PILOT_LOCAL_MODEL: healthy.modelId },
      probe,
    });
    const source = resolution.source as LocalModelSource;
    lines.push(`  resolveLocalModelSource() — the same call main/index.ts makes at startup`);
    for (const line of resolution.lines) {
      lines.push(...wrap(line, 74, '    '));
    }
    lines.push(
      `  reachable ${String(source.report.health.reachable)} · models served [${source.report.health.modelIds.join(', ')}]` +
        ` · ${String(source.report.health.latencyMs)} ms · ${String(source.report.probeRequests)} probe requests`,
    );
    lines.push(
      `  blockedBy: ${resolution.blockedBy === null ? 'nothing' : resolution.blockedBy.code}`,
    );

    // ---------------------------------------------------------------------
    // 3. The capability probe, and where each answer came from.
    // ---------------------------------------------------------------------
    lines.push(heading('3. vision and tool capability probe'));
    const capabilities = describeCapabilities(source.profile, { toolSupport: source.toolSupport });
    lines.push(`  vision : ${String(capabilities.vision)} — ${capabilities.facts.vision.evidence}`);
    lines.push(
      `  tools  : ${String(capabilities.tools)} — ${capabilities.facts.tools.confidence}, ${capabilities.facts.tools.evidence}`,
    );
    lines.push(`  vision evidence at the endpoint: ${source.report.vision.evidence}`);
    lines.push(`  tools  evidence at the endpoint: ${source.report.tools.evidence}`);
    lines.push('');
    lines.push('  docs/pi-notes.md §6.3 says supportsTools "cannot be derived" — true of Pi');
    lines.push('  METADATA, which carries nothing about tools. A local endpoint can simply');
    lines.push('  be asked, so this is the first Pilot profile whose tool support is a');
    lines.push('  measurement rather than a default. The probe sent an 8×8 swatch it drew');
    lines.push(
      `  itself (${String(source.report.probeImageBytes)} bytes) and one sentence. No screen was read.`,
    );

    // ---------------------------------------------------------------------
    // 4. Every way a local endpoint can be unusable, with its message.
    // ---------------------------------------------------------------------
    lines.push(heading('4. diagnostics for unsupported models and bad endpoints'));
    lines.push('  Each block is a different endpoint and the exact sentence a user sees.');
    const diagnosed: string[] = [];

    const show = (title: string, report: LocalEndpointReport): void => {
      lines.push('');
      lines.push(`  ${title}`);
      const shown = report.diagnoses.filter((entry) => entry.code !== 'endpoint-not-local');
      if (shown.length === 0) {
        lines.push('    (no diagnosis — this endpoint is fine)');
        return;
      }
      for (const diagnosis of shown) {
        diagnosed.push(diagnosis.code);
        const effect = diagnosis.fatal
          ? 'blocks Pilot'
          : diagnosis.code === 'context-window-below-reserve'
            ? 'a warning; Pilot still works'
            : 'refused by the capability gate, before any screen data is sent';
        lines.push(`    [${diagnosis.code}] ${effect}`);
        lines.push(...wrap(`user sees: ${diagnosis.userMessage}`));
        lines.push(...wrap(`remedy   : ${diagnosis.remedy}`));
      }
    };

    show(
      'a) nothing is listening on that port',
      await probe({ baseUrl: await closedLoopbackUrl(), model: AUTO_SELECT_MODEL }),
    );
    show(
      'b) the base URL is an HTTP server, but not an OpenAI-compatible API',
      await probe({
        baseUrl: (await stub({ behaviour: 'not-openai' })).baseUrl,
        model: AUTO_SELECT_MODEL,
      }),
    );
    show(
      'c) the base URL is missing its /v1 prefix',
      await probe({
        baseUrl: (await stub()).rootUrl,
        model: AUTO_SELECT_MODEL,
      }),
    );
    show(
      'd) the server is up and has no model loaded',
      await probe({
        baseUrl: (await stub({ behaviour: 'no-model-loaded' })).baseUrl,
        model: AUTO_SELECT_MODEL,
      }),
    );
    const otherModel = await stub({ modelId: 'llava-v1.6' });
    show(
      'e) the configured model is not the one being served',
      await probe({ baseUrl: otherModel.baseUrl, model: 'qwen2.5-vl-7b' }),
    );
    show(
      'f) the server wants a key and none was given',
      await probe({
        baseUrl: (await stub({ behaviour: 'unauthorized' })).baseUrl,
        model: AUTO_SELECT_MODEL,
      }),
    );

    const unsupported: readonly (readonly [string, StubEndpointBehaviour])[] = [
      ['g) the model cannot accept images at all', 'vision-rejected'],
      ['h) the model CLAIMS vision and cannot read an image', 'vision-blind'],
      ['i) the server rejects tool definitions', 'tools-rejected'],
      ['j) the model accepts tools and ignores them', 'tools-ignored'],
    ];
    for (const [title, behaviour] of unsupported) {
      const endpoint = await stub({ behaviour });
      show(title, await probe({ baseUrl: endpoint.baseUrl, model: endpoint.modelId }));
    }

    const small = await stub({ contextWindow: 4_096 });
    show(
      'k) the server loaded a context smaller than Pi’s compaction reserve (a warning, not a refusal)',
      await probe({ baseUrl: small.baseUrl, model: small.modelId }),
    );

    // ---------------------------------------------------------------------
    // 5. The gate refusing BEFORE screen data.
    // ---------------------------------------------------------------------
    lines.push(heading('5. the capability gate refuses before any screen data is sent'));
    const blind = await stub({ behaviour: 'vision-blind', modelId: 'gemma-3-4b' });
    const blindResolution = await resolveLocalModelSource({
      env: { PILOT_LOCAL_BASE_URL: blind.baseUrl, PILOT_LOCAL_MODEL: blind.modelId },
      probe,
    });
    const blindSource = blindResolution.source as LocalModelSource;
    const blindConversation = asConversationId('conv-local-refused');
    const blindRuntime = createAgentRuntime({
      conversationId: blindConversation,
      source: blindSource,
      ...(blindResolution.blockedBy === null ? {} : { blockedBy: blindResolution.blockedBy }),
    });
    const blindScreen = blindRuntime.screenContext as FakeScreenContextService;
    const blindApp = createInteractionRuntime({
      agent: blindRuntime.session,
      conversationId: blindConversation,
    });
    lines.push(`  profile: ${blindSource.profile.provider}/${blindSource.profile.model}`);
    lines.push(
      `  supportsVision ${String(blindSource.profile.supportsVision)} · supportsTools ${String(blindSource.profile.supportsTools)}` +
        ` · Model.input [${blindSource.model.input.join(', ')}]`,
    );
    lines.push(`  capability gate: ${blindRuntime.capability.ok ? 'passed' : 'REFUSED'}`);
    blindApp.controller.dispatch({
      type: 'submit-text',
      text: 'What does this Auto Renew toggle do?',
    });
    await settle(blindApp.controller);
    const blindView = blindApp.controller.snapshot();
    lines.push(`  the user asks anyway → state ${blindView.state}`);
    lines.push(...wrap(`panel shows: ${blindView.lastError?.userMessage ?? '(no error)'}`));
    const refusedScreenBytes = imageBytesReceived(blind);
    lines.push('');
    lines.push('  What the endpoint recorded, from its own request log:');
    for (const entry of blind.requests) {
      lines.push(
        `    ${entry.method} ${entry.path} streamed=${String(entry.streamed)} imageBytes=${String(entry.imageBytes)}`,
      );
    }
    lines.push(
      `  screen captures requested: ${String(blindScreen.requests.length)} · streamed provider requests: ` +
        `${String(blind.requests.filter((entry) => entry.streamed).length)} · provider requests counted by the source: ${String(blindSource.requestCount())}`,
    );
    lines.push(
      `  total image bytes the endpoint ever received: ${String(refusedScreenBytes)} — all of it the probe’s own swatch (${String(blindSource.report.probeImageBytes)} bytes).`,
    );
    await blindApp.controller.dispose();
    await blindRuntime.dispose();

    // ---------------------------------------------------------------------
    // 6. A real answer, through the composition the app uses.
    // ---------------------------------------------------------------------
    lines.push(heading('6. the same app, answering against the local endpoint'));
    healthy.setScript([
      { tool: { name: 'observe_screen', arguments: { view: 'pointer', moment: 'question' } } },
      {
        say:
          'That switch turns on automatic renewal for your plan. This answer was streamed ' +
          'from a stub HTTP endpoint over Pi’s real openai-completions provider — no ' +
          'language model was involved, and nothing left this machine.',
      },
      { say: 'It renews on the first of each month, and you can turn it off at any time.' },
    ]);
    const conversationId = asConversationId('conv-local-demo');
    const runtime = createAgentRuntime({ conversationId, source });
    const screen = runtime.screenContext as FakeScreenContextService;
    const app = createInteractionRuntime({ agent: runtime.session, conversationId });
    lines.push(`  context window in force: ${describeContextWindow(runtime.contextWindow)}`);
    let turns = 0;
    for (const question of ['What does this Auto Renew toggle do?', 'And when does it renew?']) {
      app.controller.dispatch({ type: 'submit-text', text: question });
      await settle(app.controller);
      const answer = app.controller.snapshot().transcript.at(-1);
      lines.push(`  you  : ${question}`);
      if (answer?.role === 'assistant') {
        lines.push('  pilot:');
        lines.push(...wrap(answer.text, 74, '    '));
        if (!answer.pending) {
          turns += 1;
        }
      }
    }
    const streamedRequests = healthy.requests.filter((entry) => entry.streamed);
    lines.push('');
    lines.push(`  screen captures requested by the model: ${String(screen.requests.length)}`);
    lines.push('  streamed provider requests, and whether each carried screen pixels:');
    for (const [index, entry] of streamedRequests.entries()) {
      lines.push(
        `    #${String(index + 1)} imageBytes=${String(entry.imageBytes)}${entry.imageBytes > 0 ? '  ← the observation the model asked for' : ''}`,
      );
    }
    const answeredScreenBytes = streamedRequests.reduce((sum, entry) => sum + entry.imageBytes, 0);
    lines.push('  The first request carried none: screen data follows the tool call, it never');
    lines.push('  precedes it. The third is the FOLLOW-UP turn re-sending the one observation');
    lines.push('  the §10 image budget still keeps in active context — one capture, not two.');
    await app.controller.dispose();
    await runtime.dispose();

    // ---------------------------------------------------------------------
    // 7. Locality labelling.
    // ---------------------------------------------------------------------
    lines.push(heading('7. locality — where does the screen go?'));
    lines.push('  this profile:');
    lines.push(...wrap(localityStatement(source)));
    lines.push(...wrap(source.endpoint.detail));
    const lanReport: LocalEndpointReport = {
      ...source.report,
      health: {
        ...source.report.health,
        baseUrl: 'http://192.168.1.40:8000/v1',
        host: '192.168.1.40',
        loopback: false,
      },
    };
    const lan = createLocalModelSource(lanReport, { profileId: 'local-lan-contrast' });
    lines.push('  the same model served from the LAN — a local profile that is not private:');
    lines.push(...wrap(localityStatement(lan)));
    lines.push('  a hosted API-key profile, for contrast (PR-038 owns the real one):');
    lines.push(...wrap(describeEndpoint(HOSTED_PROFILE_FOR_CONTRAST).detail));
    lines.push('');
    lines.push('  The claim fails closed: `describeEndpoint` reports remote whenever the');
    lines.push('  stored flag and the base URL disagree. A privacy statement may only ever');
    lines.push('  err towards "your screen leaves this machine".');

    // ---------------------------------------------------------------------
    // 8. The context window.
    // ---------------------------------------------------------------------
    lines.push(heading('8. the context window, and what is actually known about it'));
    const measured = await stub({ contextWindow: 8_192 });
    const measuredReport = await probe({
      baseUrl: measured.baseUrl,
      model: measured.modelId,
    });
    const measuredSource = createLocalModelSource(measuredReport, { profileId: 'local-measured' });
    const oversize = await stub({ contextWindow: 131_072 });
    const oversizeReport = await probe({
      baseUrl: oversize.baseUrl,
      model: oversize.modelId,
    });
    const oversizeSource = createLocalModelSource(oversizeReport, { profileId: 'local-oversize' });
    const silent = await stub();
    const silentReport = await probe({
      baseUrl: silent.baseUrl,
      model: silent.modelId,
    });
    const silentSource = createLocalModelSource(silentReport, { profileId: 'local-silent' });
    for (const [label, candidate] of [
      ['server reported 8192 loaded', measuredSource],
      ['server reported 131072 loaded', oversizeSource],
      ['server reported nothing', silentSource],
    ] as const) {
      lines.push(
        `  ${label.padEnd(30)} → ${describeContextWindow(resolveContextWindow(contextWindowInputOf(candidate)))}`,
      );
    }
    lines.push('');
    lines.push('  PR-036 wrote that rule and the runbook records that it "declines to trust');
    lines.push('  a number rather than measuring anything". PR-039 can do a little better on');
    lines.push('  one axis and no better on the other:');
    lines.push('   · BETTER: `meta.n_ctx` is what the server PROCESS allocated, not what the');
    lines.push('     model claims, so it is a fact. It tightens the budget — llama.cpp’s');
    lines.push('     default of 4096 is far below the ceiling — and Pilot now says so.');
    lines.push('   · NO BETTER: it does not loosen it. A server that allocated 131072 has not');
    lines.push('     made a 7B model good at 131072, and the ceiling exists for the second');
    lines.push('     question, not the first. Nothing here measures where quality degrades,');
    lines.push('     and PILOT_CONTEXT_WINDOW is still how a user who knows better says so.');

    return {
      lines,
      diagnosed: [...new Set(diagnosed)],
      refusedScreenBytes,
      answeredScreenBytes,
      turns,
    };
  } finally {
    await Promise.all(open.map((endpoint) => endpoint.close()));
  }
}
