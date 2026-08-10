/* eslint-disable no-console */
/**
 * PR-023 demo — safe session persistence (system-design §11, §13).
 *
 * implementation.md, PR-023: "restore a text conversation and show that no
 * image payload was persisted." This does exactly that, against a real SQLite
 * session database in a real temporary directory, and it *greps the bytes* —
 * every claim below is checked by scanning the files on disk rather than by
 * inspecting an object in memory.
 *
 *   pnpm build && node packages/agent/demo/persistence-demo.mjs
 *   pnpm --filter @pilot/agent run demo:persistence
 *
 * Six acts:
 *   1. run a screen conversation until compaction folds it;
 *   2. quit — flush, then release the SQLite writer lease;
 *   3. scan every byte on disk for the pixels that were in the live context;
 *   4. relaunch: restore transcript + summary + boundary and compare;
 *   5. the writer lease: what a second instance and a crashed one see;
 *   6. clear conversation, and scan the bytes again.
 *
 * Deterministic: fixed fixtures, an injected clock, no network, no
 * credentials. The model is Pi's built-in faux provider. The only thing that
 * varies between runs is the temporary directory name.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import {
  DEFAULT_WRITER_LEASE,
  PiAgentSession,
  buildSystemPrompt,
  containsImageBytes,
  createObservationNotebook,
  createObserveScreenTool,
  isWriterLeaseHeld,
  openConversationStore,
} from '../dist/index.js';
import { MVP_SCREEN_CONTEXT_POLICY } from '@pilot/shared';

const POLICY = MVP_SCREEN_CONTEXT_POLICY;
const CAPTURED_AT = 1_700_000_000_000;
const CONVERSATION_ID = 'conv-persistence-demo';
const TURNS = 12;
/** Small on purpose, so twelve turns really do trip §11's usage trigger. */
const CONTEXT_WINDOW = 12_000;

const line = (title) => console.log(`\n${'─'.repeat(88)}\n${title}\n${'─'.repeat(88)}`);
const tick = (ok) => (ok ? 'YES' : 'no');

/** Deterministic base64 of a given decoded size, unique per tag. */
function payload(tag, kilobytes) {
  const body = `${tag}:`.repeat(Math.ceil((kilobytes * 1024) / (tag.length + 1)));
  return Buffer.from(body.slice(0, kilobytes * 1024)).toString('base64');
}

const QUESTIONS = [
  'What does this toggle do?',
  'Will it charge me again next month?',
  'Where do I see past invoices?',
  'Can I download the July one?',
  'Is that the total including tax?',
  'What plan am I on?',
  'How do I change it?',
  'Does downgrading refund anything?',
  'Who else is on this account?',
  'Can I remove them?',
  'What was that first toggle called?',
  'And is it still switched on?',
];

const TURN_DATA = Array.from({ length: TURNS }, (_, index) => {
  const turn = index + 1;
  return {
    turn,
    question: QUESTIONS[index] ?? `Question ${turn}?`,
    imageBase64: payload(`t${turn}-window`, 96),
  };
});

const observedWindow = {
  windowId: 'window-billing',
  displayId: 'display-primary',
  title: 'Billing settings',
  applicationName: 'Safari',
  bounds: { x: 100, y: 80, width: 1200, height: 800 },
  scaleFactor: 2,
  isOnScreen: true,
};

const statusFor = (revision) => ({
  enabled: true,
  paused: false,
  selectedWindow: observedWindow,
  scene: {
    sceneId: 'scene-17',
    revision,
    windowId: observedWindow.windowId,
    windowTitle: observedWindow.title,
    fingerprint: `fingerprint-17-${revision}`,
    updatedAt: CAPTURED_AT,
  },
  permissions: { screenRecording: 'granted', accessibility: 'granted' },
  buffer: { frameCount: 9, byteCount: 576, oldestFrameAt: CAPTURED_AT, newestFrameAt: CAPTURED_AT },
  lastError: null,
});

const PROFILE = {
  id: 'profile-demo',
  provider: 'pilot-faux',
  model: 'faux-vision',
  authMode: 'local',
  baseUrl: 'http://localhost:0',
  supportsVision: true,
  supportsTools: true,
  isRemote: false,
};

/** Every regular file under `directory`, with its bytes. */
async function filesOnDisk(directory) {
  const files = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files.push({ path: path.slice(directory.length + 1), bytes: await readFile(path) });
      }
    }
  };
  await walk(directory);
  return files;
}

async function scanDisk(directory, needles) {
  const files = await filesOnDisk(directory);
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  console.log(`  scanned ${String(files.length)} file(s), ${String(total)} bytes:`);
  for (const file of files) {
    console.log(`    ${file.path.padEnd(24)} ${String(file.bytes.length).padStart(9)} bytes`);
  }
  for (const [label, needle] of needles) {
    const hit = files.some((file) => file.bytes.includes(Buffer.from(needle)));
    console.log(`    ${label.padEnd(52)} ${tick(hit)}`);
  }
  return files;
}

/**
 * One complete Pilot agent session over a given store: faux provider, real
 * `observe_screen` tool, real image payloads, real compaction.
 */
function buildSession({ store, restore }) {
  const seenContexts = [];
  const faux = fauxProvider({
    provider: 'pilot-faux',
    models: [{ id: 'faux-vision', input: ['text', 'image'] }],
  });
  const models = createModels();
  models.setProvider(faux.provider);

  faux.setResponses(
    Array.from({ length: TURNS + 2 }, () => [
      (context) => {
        seenContexts.push(JSON.parse(JSON.stringify(context.messages)));
        return fauxAssistantMessage(
          [fauxToolCall('observe_screen', { view: 'window', moment: 'question' })],
          { stopReason: 'toolUse' },
        );
      },
      (context) => {
        seenContexts.push(JSON.parse(JSON.stringify(context.messages)));
        return fauxAssistantMessage(
          'That control renews the plan automatically, and nothing is charged until you confirm.',
          { stopReason: 'stop' },
        );
      },
    ]).flat(),
  );

  let currentTurn = 1;
  const dataFor = () => TURN_DATA[Math.min(currentTurn, TURN_DATA.length) - 1];
  const screenContext = {
    status: () => statusFor(dataFor().turn),
    clear: () => undefined,
    observe: async () => ({
      observationId: `obs-${dataFor().turn}`,
      sceneId: 'scene-17',
      sceneRevision: dataFor().turn,
      capturedAt: CAPTURED_AT + dataFor().turn,
      windowTitle: observedWindow.title,
      pointer: { x: 0.42, y: 0.61 },
      target: { role: 'switch', label: 'Auto Renew', isSecure: false },
      images: [{ mimeType: 'image/png', base64: dataFor().imageBase64, purpose: 'window' }],
    }),
  };

  const notebook = createObservationNotebook();
  const session = new PiAgentSession({
    conversationId: CONVERSATION_ID,
    profile: PROFILE,
    models,
    model: faux.getModel(),
    systemPrompt: buildSystemPrompt(),
    tools: [createObserveScreenTool({ screenContext, onObservation: notebook.note })],
    visualContext: { policy: POLICY, summaryFor: notebook.summaryFor },
    compaction: { contextWindow: CONTEXT_WINDOW, now: () => CAPTURED_AT },
    ...(store === undefined ? {} : { store }),
    ...(restore === undefined ? {} : { restore }),
  });

  const ask = async (turn) => {
    currentTurn = turn;
    const run = await session.submit({
      utteranceId: `utt-${turn}`,
      transcript: TURN_DATA[Math.min(turn, TURNS) - 1].question,
      conversationId: CONVERSATION_ID,
      scene: {
        id: 'scene-17',
        revision: turn,
        windowTitle: observedWindow.title,
        lastObservedRevision: turn - 1,
      },
      pointer: {
        normalizedX: 0.42,
        normalizedY: 0.61,
        targetRole: 'switch',
        targetLabel: 'Auto Renew',
      },
    });
    await run.completed;
  };

  return { session, ask, seenContexts };
}

// ---------------------------------------------------------------------------

const directory = await mkdtemp(join(tmpdir(), 'pilot-persistence-demo-'));

console.log('PR-023 — safe session persistence, on a real SQLite session database.');
console.log(`Durable directory: ${directory}`);

// --- 1. A conversation that gets compacted ---------------------------------

line('1. Twelve screen questions, on a real store');

const store = await openConversationStore({
  conversationId: CONVERSATION_ID,
  directory,
  backend: 'sqlite',
});
const first = buildSession({ store });
const folds = [];
first.session.subscribe((event) => {
  if (event.type === 'context-compacted') {
    folds.push({
      generation: first.session.compaction?.generation ?? 0,
      boundaryIndex: first.session.compaction?.boundaryIndex ?? 0,
      triggers: first.session.lastCompaction?.decision.triggers ?? [],
    });
  }
});

console.log('  turn  transcript  active context  images in context  compaction');
for (const data of TURN_DATA) {
  const before = folds.length;
  await first.ask(data.turn);
  const active = first.session.activeContext();
  const images = active.filter(containsImageBytes).length;
  const fold = folds.length > before ? folds.at(-1) : undefined;
  console.log(
    `  ${String(data.turn).padStart(4)}  ${String(first.session.messages.length).padStart(10)}  ` +
      `${String(active.length).padStart(14)}  ${String(images).padStart(17)}  ` +
      (fold === undefined
        ? ''
        : `folded ${String(fold.boundaryIndex)} messages into summary ${String(fold.generation)} (${fold.triggers.join(' ')})`),
  );
}

const beforeQuit = {
  transcript: first.session.messages.length,
  activeContext: first.session.activeContext().length,
  imagesLive: first.session.activeContext().filter(containsImageBytes).length,
  generation: first.session.compaction?.generation ?? 0,
  boundaryIndex: first.session.compaction?.boundaryIndex ?? 0,
  summaryText: first.session.compaction?.summary?.text ?? '',
  summaryMessage: JSON.stringify(first.session.activeContext()[0]),
};

console.log(
  `\n  transcript ${String(beforeQuit.transcript)} messages, active context ${String(beforeQuit.activeContext)} messages, ` +
    `${String(beforeQuit.imagesLive)} of which still carry raw pixels.`,
);

// --- 2. Quit ----------------------------------------------------------------

line('2. Quit — flush the writer queue, then release the SQLite writer lease');
await first.session.dispose();
await store.close();
console.log('  session.dispose()  → last turn flushed to disk');
console.log('  store.close()      → writer_leases row deleted, database handle closed');

// --- 3. The privacy proof ---------------------------------------------------

line('3. Every byte on disk, scanned for the pixels that were in the live context');
await scanDisk(directory, [
  ['turn 1 image bytes on disk', TURN_DATA[0].imageBase64],
  ['turn 12 image bytes on disk', TURN_DATA[TURNS - 1].imageBase64],
  ['"[image withheld: image/png" audit record on disk', '[image withheld: image/png'],
  ['the user’s question text on disk', QUESTIONS[0]],
  ['the model’s answer text on disk', 'renews the plan automatically'],
]);
console.log(
  '\n  Pi serializes whatever message it is handed, verbatim, on both backends\n' +
    '  (docs/pi-notes.md §3.1). The pixels are absent because Pilot is the only\n' +
    '  writer and every write goes through the sanitising sink — not because Pi\n' +
    '  has an option for it. It does not.',
);

// --- 4. Relaunch ------------------------------------------------------------

line('4. Relaunch — restore transcript + summary + boundary');

const reopened = await openConversationStore({
  conversationId: CONVERSATION_ID,
  directory,
  backend: 'sqlite',
});
const restored = await reopened.restore();
console.log(`  message entries read back        : ${String(restored.persistedMessageCount)}`);
console.log(`  structural repairs needed        : ${String(restored.repairedMessages)}`);
console.log(`  compaction generation restored   : ${String(restored.compaction?.generation ?? 0)}`);
console.log(
  `  boundary index restored          : ${String(restored.compaction?.boundaryIndex ?? 0)}`,
);

const second = buildSession({ store: reopened, restore: restored });
const afterRestart = {
  transcript: second.session.messages.length,
  activeContext: second.session.activeContext().length,
  imagesLive: second.session.activeContext().filter(containsImageBytes).length,
  generation: second.session.compaction?.generation ?? 0,
  boundaryIndex: second.session.compaction?.boundaryIndex ?? 0,
  summaryText: second.session.compaction?.summary?.text ?? '',
  summaryMessage: JSON.stringify(second.session.activeContext()[0]),
};

const row = (label, before, after) =>
  console.log(
    `  ${label.padEnd(34)} ${String(before).padStart(12)}   ${String(after).padStart(12)}   ${
      String(before) === String(after) ? 'same' : 'DIFFERENT'
    }`,
  );
console.log('\n  property                            before quit    after restart   ');
row('transcript messages', beforeQuit.transcript, afterRestart.transcript);
row('active context messages', beforeQuit.activeContext, afterRestart.activeContext);
row('compaction generation', beforeQuit.generation, afterRestart.generation);
row('boundary index', beforeQuit.boundaryIndex, afterRestart.boundaryIndex);
row(
  'summary text (sha-free compare)',
  beforeQuit.summaryText.length,
  afterRestart.summaryText.length,
);
console.log(
  `  ${'summary message identical'.padEnd(34)} ${(beforeQuit.summaryMessage === afterRestart.summaryMessage ? 'yes' : 'NO').padStart(12)}` +
    '                  (text and timestamp)',
);
console.log(
  `  ${'raw pixels in restored context'.padEnd(34)} ${String(afterRestart.imagesLive).padStart(12)}` +
    `                  (was ${String(beforeQuit.imagesLive)} before the quit)`,
);

console.log('\n  The restored durable summary, as the model will see it:\n');
for (const summaryLine of afterRestart.summaryText.split('\n')) {
  console.log(`    ${summaryLine}`);
}

// --- 4b. Why the summary has to be persisted -------------------------------

line('4b. What persisting the summary is worth (runbook follow-up 8)');
await second.ask(TURNS + 1);
const withSummaryRequest = second.seenContexts[0].length;

const transcriptOnly = buildSession({
  restore: {
    messages: restored.messages,
    persistedMessageCount: restored.persistedMessageCount,
    repairedMessages: restored.repairedMessages,
  },
});
await transcriptOnly.ask(TURNS + 1);
const withoutSummaryRequest = transcriptOnly.seenContexts[0].length;
await transcriptOnly.session.dispose();

console.log(
  `  first provider request after the relaunch, transcript + summary : ${String(withSummaryRequest)} messages`,
);
console.log(
  `  first provider request after the relaunch, transcript only      : ${String(withoutSummaryRequest)} messages`,
);
console.log(
  '\n  Compaction is provider-facing only: it never enters agent.state.messages,\n' +
    '  so the durable transcript is complete and a session restored from it alone\n' +
    '  re-sends the whole history at the first question after every relaunch.',
);

// --- 5. The writer lease ----------------------------------------------------

line(
  `5. The SQLite writer lease (${String(DEFAULT_WRITER_LEASE.ttlMs / 1000)} s TTL, ${String(DEFAULT_WRITER_LEASE.heartbeatIntervalMs / 1000)} s heartbeat)`,
);
try {
  await openConversationStore({ conversationId: CONVERSATION_ID, directory, backend: 'sqlite' });
  console.log('  a second writer opened the same conversation — UNEXPECTED');
} catch (error) {
  console.log(`  second instance, lease held : ${error.constructor.name}`);
  console.log(`    recognised by isWriterLeaseHeld : ${tick(isWriterLeaseHeld(error))}`);
  console.log(`    code                            : ${error.code}`);
  console.log(`    details.reason                  : ${error.details?.reason}`);
  console.log(`    retryable                       : ${tick(error.retryable)}`);
  console.log(`    user message                    : ${error.userMessage}`);
}
console.log(
  '\n  A crashed process leaves the row behind with a future expiry, so every open\n' +
    `  for the next ${String(DEFAULT_WRITER_LEASE.ttlMs / 1000)} s fails the same way; after that the next opener takes over\n` +
    '  and bumps the lease fence, and the zombie’s next write fails with\n' +
    '  "writer lease was lost". Nothing has to be deleted by hand.',
);

// --- 6. Clear conversation --------------------------------------------------

line('6. Clear conversation');
await second.session.clearConversation();
const afterClear = await reopened.restore();
console.log(`  transcript in memory : ${String(second.session.messages.length)} messages`);
console.log(`  transcript on disk   : ${String(afterClear.persistedMessageCount)} messages`);
console.log(
  `  summary on disk      : ${afterClear.compaction === undefined ? 'none' : 'STILL THERE'}`,
);
console.log('');
await scanDisk(directory, [
  ['the user’s question text still on disk', QUESTIONS[0]],
  ['the model’s answer text still on disk', 'renews the plan automatically'],
  ['the durable summary still on disk', beforeQuit.summaryText.slice(0, 40)],
  ['any observation record still on disk', 'Auto Renew'],
  ['any "[image withheld" audit record still on disk', '[image withheld'],
]);
console.log(
  '\n  Deleting rows is not removing bytes: SQLite reuses freed pages later, so\n' +
    '  clear() reclaims them before returning. The store is empty and usable.',
);

await second.session.dispose();
await reopened.close();
await rm(directory, { recursive: true, force: true });
console.log(`\nRemoved ${directory}\n`);
