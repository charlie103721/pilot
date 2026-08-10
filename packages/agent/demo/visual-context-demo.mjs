/* eslint-disable no-console */
/**
 * PR-022a demo — active-context image limits and obsolete-image replacement.
 *
 * implementation.md, PR-022: "run repeated observations while context stays
 * within configured limits". This runs seven turns through a real Pi session,
 * printing, for every provider request:
 *
 *   - how many images the model actually received, and how many bytes;
 *   - the same figures for the transcript, which keeps everything;
 *   - which purpose each surviving image serves.
 *
 * Turn 5 is a comparison, which is the one case where two full frames are
 * legitimate (system-design §10, §11); turn 6 shows the budget closing again.
 *
 *   pnpm build && node packages/agent/demo/visual-context-demo.mjs
 *
 * Deterministic: fixed fixtures, fixed byte sizes, no network, no credentials,
 * no clock in the output. The model is Pi's built-in faux provider.
 */
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import {
  PiAgentSession,
  buildSystemPrompt,
  createObservationNotebook,
  createObserveScreenTool,
  countImageBlocks,
  planVisualContext,
  summariseVisualContext,
} from '../dist/index.js';
import { MVP_SCREEN_CONTEXT_POLICY } from '@pilot/shared';

const POLICY = MVP_SCREEN_CONTEXT_POLICY;
const CAPTURED_AT = 1_700_000_000_000;

/** Deterministic base64 of a given decoded size, unique per tag. */
function payload(tag, kilobytes) {
  const body = `${tag}:`.repeat(Math.ceil((kilobytes * 1024) / (tag.length + 1)));
  return Buffer.from(body.slice(0, kilobytes * 1024)).toString('base64');
}

const FULL_FRAME_KB = 120;
const POINTER_CROP_KB = 18;

const SELECTED_WINDOW = {
  windowId: 'window-billing',
  displayId: 'display-primary',
  title: 'Billing settings',
  applicationName: 'Safari',
  bounds: { x: 100, y: 80, width: 1200, height: 800 },
  scaleFactor: 2,
  isOnScreen: true,
};

const STATUS = {
  enabled: true,
  paused: false,
  selectedWindow: SELECTED_WINDOW,
  scene: {
    sceneId: 'scene-17',
    revision: 4,
    windowId: SELECTED_WINDOW.windowId,
    windowTitle: SELECTED_WINDOW.title,
    fingerprint: 'fingerprint-17',
    updatedAt: CAPTURED_AT,
  },
  permissions: { screenRecording: 'granted', accessibility: 'granted' },
  buffer: { frameCount: 9, byteCount: 576, oldestFrameAt: CAPTURED_AT, newestFrameAt: CAPTURED_AT },
  lastError: null,
};

/** What the user was looking at on each turn. Drives the truthful records. */
const SCENES = [
  { title: 'Billing settings', role: 'switch', label: 'Auto Renew' },
  { title: 'Billing settings', role: 'switch', label: 'Auto Renew' },
  { title: 'Billing settings', role: 'button', label: 'Change plan' },
  { title: 'Billing settings — Invoices', role: 'link', label: 'Invoice 2026-07' },
  { title: 'Billing settings — Invoices', role: 'link', label: 'Invoice 2026-07' },
  { title: 'Billing settings — Invoices', role: 'table', label: 'Payment history' },
  { title: 'Billing settings — Invoices', role: 'table', label: 'Payment history' },
];

/** Turn 5 asks for a before/after comparison; every other turn is ordinary. */
const TURNS = SCENES.map((scene, index) => {
  const turn = index + 1;
  const comparison = turn === 5;
  const scenery = {
    observationId: `obs-${turn}`,
    sceneId: 'scene-17',
    sceneRevision: turn,
    capturedAt: CAPTURED_AT + turn,
    windowTitle: scene.title,
    pointer: { x: 0.42, y: 0.61 },
    target: { role: scene.role, label: scene.label, isSecure: false },
  };
  return {
    turn,
    comparison,
    question: comparison ? 'What changed after I clicked that?' : 'What does this do?',
    request: comparison
      ? { view: 'window', moment: 'before-and-after' }
      : { view: 'both', moment: 'question' },
    observation: {
      ...scenery,
      images: comparison
        ? [
            {
              mimeType: 'image/png',
              base64: payload(`t${turn}-before`, FULL_FRAME_KB),
              purpose: 'before',
            },
            {
              mimeType: 'image/png',
              base64: payload(`t${turn}-after`, FULL_FRAME_KB),
              purpose: 'after',
            },
          ]
        : [
            {
              mimeType: 'image/png',
              base64: payload(`t${turn}-window`, FULL_FRAME_KB),
              purpose: 'window',
            },
            {
              mimeType: 'image/png',
              base64: payload(`t${turn}-pointer`, POINTER_CROP_KB),
              purpose: 'pointer',
            },
          ],
    },
  };
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const seenContexts = [];
const faux = fauxProvider({
  provider: 'pilot-faux',
  models: [{ id: 'faux-vision', input: ['text', 'image'] }],
});
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses(
  TURNS.flatMap((turn) => [
    (context) => {
      seenContexts.push(snapshot(context));
      return fauxAssistantMessage([fauxToolCall('observe_screen', turn.request)], {
        stopReason: 'toolUse',
      });
    },
    (context) => {
      seenContexts.push(snapshot(context));
      return fauxAssistantMessage('Here is what that does.', { stopReason: 'stop' });
    },
  ]),
);

/** Tools carry functions, so only the messages can be cloned. */
function snapshot(context) {
  return JSON.parse(JSON.stringify(context.messages));
}

let cursor = 0;
const screenContext = {
  status: () => STATUS,
  clear: () => undefined,
  observe: async () => {
    const turn = TURNS[Math.min(cursor, TURNS.length - 1)];
    cursor += 1;
    return turn.observation;
  },
};

// The notebook is what makes a replacement record say something true: the tool
// writes one past-tense line per observation, and the pruner reads it back when
// that observation's frames leave active context.
const notebook = createObservationNotebook();

const session = new PiAgentSession({
  conversationId: 'conv-visual',
  profile: {
    id: 'profile-demo',
    provider: 'pilot-faux',
    model: 'faux-vision',
    authMode: 'local',
    baseUrl: 'http://localhost:0',
    supportsVision: true,
    supportsTools: true,
    isRemote: false,
  },
  models,
  model: faux.getModel(),
  systemPrompt: buildSystemPrompt(),
  tools: [createObserveScreenTool({ screenContext, onObservation: notebook.note })],
  visualContext: { policy: POLICY, summaryFor: notebook.summaryFor },
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const kb = (bytes) => `${(bytes / 1024).toFixed(0).padStart(4)} KB`;
const line = (title) => console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`);

line('Policy in force (system-design §10 activeContext)');
console.log(`  max full frames      : ${POLICY.activeContext.maxFullFrames}`);
console.log(`  max pointer crops    : ${POLICY.activeContext.maxPointerCrops}`);
console.log(`  max comparison frames: ${POLICY.activeContext.maxComparisonFrames}`);

line('Per turn: what the model carries vs what the transcript keeps');
console.log(
  '  turn  request                    imgs   bytes   purposes                          transcript',
);

for (const turn of TURNS) {
  const run = await session.submit({
    utteranceId: `utt-${turn.turn}`,
    transcript: turn.question,
    conversationId: 'conv-visual',
    scene: {
      id: 'scene-17',
      revision: turn.turn,
      windowTitle: turn.observation.windowTitle,
      lastObservedRevision: turn.turn - 1,
    },
    pointer: {
      normalizedX: 0.42,
      normalizedY: 0.61,
      targetRole: 'switch',
      targetLabel: 'Auto Renew',
    },
  });
  await run.completed;

  const active = summariseVisualContext(seenContexts.at(-1));
  const transcript = summariseVisualContext(session.messages);
  const plan = planVisualContext(session.messages, {
    policy: POLICY,
    summaryFor: notebook.summaryFor,
  });
  const purposes = Object.entries(active.byPurpose)
    .filter(([, count]) => count > 0)
    .map(([purpose, count]) => `${purpose}×${count}`)
    .join(' ');

  console.log(
    `  ${String(turn.turn).padEnd(5)} ${`${turn.request.view}/${turn.request.moment}`.padEnd(26)}` +
      `${String(active.images).padStart(4)}  ${kb(active.bytes)}   ${purposes.padEnd(34)}` +
      `${String(transcript.images).padStart(2)} imgs ${kb(transcript.bytes)}` +
      `${plan.comparisonActive ? '   <- comparison active' : ''}`,
  );
}

line('Limits held, every turn');
{
  const worst = seenContexts
    .map((messages) => summariseVisualContext(messages))
    .reduce(
      (peak, stats) => ({
        frames: Math.max(peak.frames, stats.frames),
        pointerCrops: Math.max(peak.pointerCrops, stats.pointerCrops),
        bytes: Math.max(peak.bytes, stats.bytes),
      }),
      { frames: 0, pointerCrops: 0, bytes: 0 },
    );
  console.log(`  provider requests made        : ${seenContexts.length}`);
  console.log(
    `  peak full frames in one request: ${worst.frames} (limit ${POLICY.activeContext.maxFullFrames}, ${POLICY.activeContext.maxComparisonFrames} while comparing)`,
  );
  console.log(
    `  peak pointer crops             : ${worst.pointerCrops} (limit ${POLICY.activeContext.maxPointerCrops})`,
  );
  console.log(`  peak image bytes in one request: ${kb(worst.bytes)}`);
}

line('What replaced the frames the model no longer carries (§11)');
{
  const records = planVisualContext(session.messages, {
    policy: POLICY,
    summaryFor: notebook.summaryFor,
  }).records;
  for (const record of records.slice(0, 4)) {
    console.log(`  ${record}`);
  }
  console.log(`  … ${records.length} records in total.`);
  console.log('');
  console.log('  Every record is past tense, stamped with the scene it describes, and says');
  console.log('  outright that it is not the screen now — §11: a record "must not claim that');
  console.log('  an old screen description remains current".');
}

line('The transcript was never modified');
{
  const transcript = JSON.stringify(session.messages);
  const everyPayloadKept = TURNS.every((turn) =>
    turn.observation.images.every((image) => transcript.includes(image.base64)),
  );
  const lastRequest = JSON.stringify(seenContexts.at(-1));
  const payloadsInLastRequest = TURNS.flatMap((turn) => turn.observation.images).filter((image) =>
    lastRequest.includes(image.base64),
  ).length;

  console.log(`  image blocks in the transcript      : ${countImageBlocks(session.messages)}`);
  console.log(`  image blocks in the last request    : ${countImageBlocks(seenContexts.at(-1))}`);
  console.log(`  every captured payload still present: ${everyPayloadKept}`);
  console.log(`  payloads reaching the last request  : ${payloadsInLastRequest}`);
  console.log(`  replacement records in the transcript: ${transcript.includes(' removed. ')}`);
}

await session.dispose();
console.log('');
