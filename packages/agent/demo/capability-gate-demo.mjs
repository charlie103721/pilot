/* eslint-disable no-console */
/**
 * PR-020 demo (implementation.md: "validate supported and unsupported fake
 * profiles before a request is sent").
 *
 * Requires a build first, because it imports the compiled package:
 *
 *   pnpm build && node packages/agent/demo/capability-gate-demo.mjs
 *
 * Deterministic: no network, no credentials, no clock, no randomness. The
 * models are Pi's built-in faux provider and the credentials are the fake auth
 * facade.
 *
 * What it shows, in order:
 *   1. A provider-neutral profile store round trip, and what it refuses to
 *      persist.
 *   2. Endpoint locality for a local, a remote, and an inconsistent profile.
 *   3. The auth facade: renderer-safe status vs. request-time material, and
 *      the fact that the secret cannot be serialised out.
 *   4. THE POINT OF THE PR: three fake profiles run through the gate, with a
 *      counter proving that the refused ones caused zero provider calls and
 *      zero screen observations.
 */
import {
  PiAgentSession,
  buildSystemPrompt,
  checkVisualConversation,
  createFakeAuthFacade,
  createModelProfileStore,
  createObserveScreenTool,
  toModelProfileWithProvenance,
} from '../dist/index.js';
import { describeEndpoint } from '@pilot/shared';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const line = (title) => console.log(`\n--- ${title} ---`);
const yn = (value) => (value ? 'yes' : 'no');

/* -------------------------------------------------------------------------
 * Two faux models: one that reports image input, one that does not.
 * ------------------------------------------------------------------------- */
const seeing = fauxProvider({
  provider: 'faux-vision',
  models: [{ id: 'faux-vision-model', input: ['text', 'image'] }],
});
const blind = fauxProvider({
  provider: 'faux-text',
  models: [{ id: 'faux-text-model', input: ['text'] }],
});
const models = createModels();
models.setProvider(seeing.provider);
models.setProvider(blind.provider);

const visionProfile = toModelProfileWithProvenance(seeing.getModel(), {
  id: 'profile-local-vision',
  authMode: 'local',
  supportsTools: true,
});
const textOnlyProfile = toModelProfileWithProvenance(blind.getModel(), {
  id: 'profile-local-text',
  authMode: 'local',
  supportsTools: true,
});
const noToolsProfile = toModelProfileWithProvenance(seeing.getModel(), {
  id: 'profile-no-tools',
  authMode: 'local',
  supportsTools: false,
});

/* -------------------------------------------------------------------------
 * 1. Profile store
 * ------------------------------------------------------------------------- */
line('1. Provider-neutral profile store');
const store = createModelProfileStore({ clock: () => 1_700_000_000_000 });
for (const entry of [visionProfile, textOnlyProfile, noToolsProfile]) {
  const saved = await store.save({ profile: entry.profile, toolSupport: entry.toolSupport });
  console.log(
    `  saved ${saved.profile.id.padEnd(22)} credentialRef=${saved.credentialRef.padEnd(13)} toolSupport=${saved.toolSupport}`,
  );
}
await store.select(visionProfile.profile.id);
console.log(`  selected: ${(await store.selected()).profile.id}`);
console.log(`  stored bytes contain "sk-": ${yn((await store.serialize()).includes('sk-'))}`);

try {
  await store.save({
    profile: { ...visionProfile.profile, id: 'profile-leaky', baseUrl: 'https://u:p@host/v1' },
  });
  console.log('  UNEXPECTED: a profile with embedded credentials was persisted');
} catch (error) {
  console.log(`  refused a profile carrying a secret: ${error.code} — ${error.message}`);
}

/* -------------------------------------------------------------------------
 * 2. Endpoint locality
 * ------------------------------------------------------------------------- */
line('2. Endpoint locality (shown before observation begins)');
const localities = [
  visionProfile.profile,
  {
    ...visionProfile.profile,
    id: 'profile-remote',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    authMode: 'api-key',
    baseUrl: 'https://api.anthropic.com',
    isRemote: true,
  },
  {
    ...visionProfile.profile,
    id: 'profile-lying',
    baseUrl: 'https://api.example.com',
    isRemote: false,
  },
];
for (const profile of localities) {
  const endpoint = describeEndpoint(profile);
  console.log(
    `  ${profile.id.padEnd(22)} remote=${yn(endpoint.isRemote)} consistent=${yn(endpoint.consistent)}`,
  );
  console.log(`    ${endpoint.label}`);
}

/* -------------------------------------------------------------------------
 * 3. Auth facade
 * ------------------------------------------------------------------------- */
line('3. Auth facade (seam + fake; real flows are PR-037/038/039)');
const auth = createFakeAuthFacade({
  'faux-vision': {
    kind: 'api_key',
    material: { apiKey: 'sk-demo-SECRET-VALUE' },
    source: 'DEMO_KEY',
  },
});
console.log(`  status(faux-vision) → ${JSON.stringify(await auth.status('faux-vision'))}`);
console.log(`  status(faux-text)   → ${JSON.stringify(await auth.status('faux-text'))}`);
const credential = await auth.authorize(visionProfile.profile);
console.log(`  authorize()         → ${String(credential)}`);
console.log(`  JSON.stringify      → ${JSON.stringify(credential)}`);
console.log(`  reveal().apiKey set : ${yn(credential.reveal().apiKey !== undefined)}`);
try {
  await auth.authorize(textOnlyProfile.profile);
} catch (error) {
  console.log(`  unconfigured provider → ${error.code} (explicit failure, not a silent request)`);
}

/* -------------------------------------------------------------------------
 * 4. The gate
 * ------------------------------------------------------------------------- */
line('4. Capability gate — supported and unsupported profiles');

let observeCalls = 0;
const screenContext = {
  status: () => {
    throw new Error('not used by this demo');
  },
  clear: () => undefined,
  observe: async () => {
    observeCalls += 1;
    return {
      observationId: 'obs-1',
      sceneId: 'scene-17',
      sceneRevision: 4,
      capturedAt: 0,
      windowTitle: 'Billing settings',
      pointer: { x: 0.42, y: 0.61 },
      target: { role: 'switch', label: 'Auto Renew', isSecure: false },
      images: [{ mimeType: 'image/png', base64: PNG_1PX, purpose: 'pointer' }],
    };
  },
};

const question = {
  utteranceId: 'utt-1',
  transcript: 'What does this switch do?',
  conversationId: 'conv-demo',
  scene: { id: 'scene-17', revision: 4, windowTitle: 'Billing settings', lastObservedRevision: 3 },
  pointer: {
    normalizedX: 0.42,
    normalizedY: 0.61,
    targetRole: 'switch',
    targetLabel: 'Auto Renew',
  },
};

const cases = [
  { name: 'vision + tools  (supported)', entry: visionProfile, faux: seeing },
  { name: 'text-only model (unsupported)', entry: textOnlyProfile, faux: blind },
  { name: 'tools disabled  (unsupported)', entry: noToolsProfile, faux: seeing },
];

for (const { name, entry, faux } of cases) {
  const callsBefore = faux.state.callCount;
  const observesBefore = observeCalls;
  const decision = checkVisualConversation(entry.profile, { toolSupport: entry.toolSupport });

  console.log(`\n  ${name}`);
  console.log(
    `    vision=${yn(decision.report.vision)} (${decision.report.facts.vision.source}, ${decision.report.facts.vision.confidence})`,
  );
  console.log(
    `    tools =${yn(decision.report.tools)} (${decision.report.facts.tools.source}, ${decision.report.facts.tools.confidence})`,
  );

  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('observe_screen', { view: 'pointer', moment: 'question' })],
      {
        stopReason: 'toolUse',
      },
    ),
    fauxAssistantMessage('That switch turns on automatic renewal for your plan.', {
      stopReason: 'stop',
    }),
  ]);

  try {
    const session = new PiAgentSession({
      conversationId: 'conv-demo',
      profile: entry.profile,
      models,
      model: faux.getModel(),
      systemPrompt: buildSystemPrompt(),
      tools: [createObserveScreenTool({ screenContext })],
      toolSupport: entry.toolSupport,
    });
    const run = await session.submit(question);
    await run.completed;
    await session.dispose();
    console.log('    result: ALLOWED — run completed');
  } catch (error) {
    console.log(`    result: REFUSED — ${error.code}`);
    console.log(`      user sees: ${error.userMessage}`);
    console.log(`      details:   ${JSON.stringify(error.details)}`);
  }

  console.log(`    provider calls made : ${faux.state.callCount - callsBefore}`);
  console.log(`    screen observations : ${observeCalls - observesBefore}`);
}

line('Summary');
console.log(`  total screen observations across all three cases: ${observeCalls}`);
console.log('  a refused profile reached neither the provider nor the screen.');
