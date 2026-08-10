/* eslint-disable no-console */
/**
 * PR-022b demo — compaction orchestration (system-design §11).
 *
 * implementation.md, PR-022: "bounded context across many turns". This runs
 * eighteen turns through a real Pi session and prints, for every turn:
 *
 *   - the transcript length, which only ever grows;
 *   - the active context Pilot would send, which does not;
 *   - the estimated token usage as a percentage of the context window;
 *   - which of §11's triggers fired, and what compaction did about it.
 *
 * Turn 11 switches the selected window, so the third trigger fires on real
 * data rather than on a flag.
 *
 *   pnpm build && node packages/agent/demo/compaction-demo.mjs
 *
 * Deterministic: fixed fixtures, fixed byte sizes, an injected clock, no
 * network and no credentials. The model is Pi's built-in faux provider.
 */
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import {
  DEFAULT_COMPACTION_POLICY,
  PiAgentSession,
  buildSystemPrompt,
  countImageBlocks,
  createObservationNotebook,
  createObserveScreenTool,
  estimateActiveContext,
} from '../dist/index.js';
import { MVP_SCREEN_CONTEXT_POLICY } from '@pilot/shared';

const POLICY = MVP_SCREEN_CONTEXT_POLICY;
const CAPTURED_AT = 1_700_000_000_000;
const TURNS = 18;
const WINDOW_CHANGES_AT = 11;

/**
 * A deliberately small context window.
 *
 * A 128k-token model never reaches 60% in eighteen turns, so the demo would
 * only ever show one of §11's three triggers. 12k is the scale of a local
 * OpenAI-compatible model (`docs/pi-notes.md` §9.3), which is a real Pilot
 * target and the case where all three triggers matter.
 */
const CONTEXT_WINDOW = 12_000;

/** Deterministic base64 of a given decoded size, unique per tag. */
function payload(tag, kilobytes) {
  const body = `${tag}:`.repeat(Math.ceil((kilobytes * 1024) / (tag.length + 1)));
  return Buffer.from(body.slice(0, kilobytes * 1024)).toString('base64');
}

const WINDOWS = {
  'scene-17': { title: 'Billing settings', app: 'Safari', label: 'Auto Renew', role: 'switch' },
  'scene-22': { title: 'Mail — Inbox', app: 'Mail', label: 'Archive', role: 'button' },
};

const sceneFor = (turn) => (turn < WINDOW_CHANGES_AT ? 'scene-17' : 'scene-22');

const observedWindow = (sceneId) => ({
  windowId: `window-${sceneId}`,
  displayId: 'display-primary',
  title: WINDOWS[sceneId].title,
  applicationName: WINDOWS[sceneId].app,
  bounds: { x: 100, y: 80, width: 1200, height: 800 },
  scaleFactor: 2,
  isOnScreen: true,
});

const statusFor = (sceneId, revision) => ({
  enabled: true,
  paused: false,
  selectedWindow: observedWindow(sceneId),
  scene: {
    sceneId,
    revision,
    windowId: `window-${sceneId}`,
    windowTitle: WINDOWS[sceneId].title,
    fingerprint: `fingerprint-${sceneId}-${revision}`,
    updatedAt: CAPTURED_AT,
  },
  permissions: { screenRecording: 'granted', accessibility: 'granted' },
  buffer: { frameCount: 9, byteCount: 576, oldestFrameAt: CAPTURED_AT, newestFrameAt: CAPTURED_AT },
  lastError: null,
});

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
  'What does this button do?',
  'Will it delete the message?',
  'Where does it go afterwards?',
  'Can I get it back?',
  'How do I search in here?',
  'Is there a filter for attachments?',
  'Can I sort by size?',
  'What was that billing toggle called again?',
];

const TURN_DATA = Array.from({ length: TURNS }, (_, index) => {
  const turn = index + 1;
  const sceneId = sceneFor(turn);
  const meta = WINDOWS[sceneId];
  return {
    turn,
    sceneId,
    question: QUESTIONS[index] ?? `Question ${turn}?`,
    observation: {
      observationId: `obs-${turn}`,
      sceneId,
      sceneRevision: turn,
      capturedAt: CAPTURED_AT + turn,
      windowTitle: meta.title,
      pointer: { x: 0.42, y: 0.61 },
      target: { role: meta.role, label: meta.label, isSecure: false },
      images: [
        { mimeType: 'image/png', base64: payload(`t${turn}-window`, 96), purpose: 'window' },
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

const snapshot = (context) => JSON.parse(JSON.stringify(context.messages));

/**
 * From turn 13 the model starts reading long lists back to the user — a search
 * result, a mailbox listing. Nothing unusual, and it is what actually drives
 * §11's second trigger: pruning already bounds the images, so the only thing
 * that can grow a bounded context past 60% is text.
 */
const VERBOSE_FROM = 13;
const answerFor = (turn) =>
  turn < VERBOSE_FROM
    ? 'That control does what its label says, and nothing is charged until you confirm.'
    : `Here is everything in that list, read out in full: ${Array.from(
        { length: 40 },
        (_, index) =>
          `item ${String(index + 1)} — “Statement ${String(2020 + index)}”, 2 attachments, 148 KB, from the billing team`,
      ).join('; ')}.`;

faux.setResponses(
  TURN_DATA.flatMap((data) => [
    (context) => {
      seenContexts.push(snapshot(context));
      return fauxAssistantMessage(
        [fauxToolCall('observe_screen', { view: 'window', moment: 'question' })],
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      seenContexts.push(snapshot(context));
      return fauxAssistantMessage(answerFor(data.turn), { stopReason: 'stop' });
    },
  ]),
);

/**
 * Which turn the screen is on. Driven by the loop rather than by a call
 * counter: `observe_screen` reads `status()` *and* `observe()` for one
 * observation and checks that they agree, so a counter that advances on
 * `observe` alone reports the next turn's window to the scene check and the
 * turn before a window change fails with `scene-changed`.
 */
let currentTurn = 1;
const dataForTurn = () => TURN_DATA[Math.min(currentTurn, TURN_DATA.length) - 1];
const screenContext = {
  status: () => statusFor(dataForTurn().sceneId, dataForTurn().turn),
  clear: () => undefined,
  observe: async () => dataForTurn().observation,
};

const notebook = createObservationNotebook();

const session = new PiAgentSession({
  conversationId: 'conv-compaction',
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
  compaction: { contextWindow: CONTEXT_WINDOW, now: () => CAPTURED_AT },
});

const compactions = [];
let turnCompactions = [];
session.subscribe((event) => {
  if (event.type === 'context-compacted') {
    // `context-compacted` carries only the summary; the triggers that caused it
    // are on the session, and this is the instant they describe this fold.
    const record = {
      summary: event.summary,
      triggers: session.lastCompaction?.decision.triggers ?? [],
      generation: session.compaction?.generation ?? 0,
      boundaryIndex: session.compaction?.boundaryIndex ?? 0,
    };
    compactions.push(record);
    turnCompactions.push(record);
  }
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const line = (title) => console.log(`\n${'─'.repeat(88)}\n${title}\n${'─'.repeat(88)}`);

line('Policy in force');
console.log(`  context window                : ${CONTEXT_WINDOW} tokens (small, on purpose)`);
console.log(
  `  compact at                    : ${DEFAULT_COMPACTION_POLICY.newObservations} new observations`,
);
console.log(
  `                                  ${DEFAULT_COMPACTION_POLICY.contextUsageFraction * 100}% estimated context usage`,
);
console.log('                                  a change of selected window');
console.log(`  never cut into the last       : ${DEFAULT_COMPACTION_POLICY.keepRecentTurns} turns`);
console.log(
  `  active images                 : ${POLICY.activeContext.maxFullFrames} frame, ${POLICY.activeContext.maxPointerCrops} pointer crop`,
);

line('Per turn: the transcript grows, the context does not');
console.log(
  '  turn  window          transcript   context   tokens   used   triggers                       compaction',
);

for (const data of TURN_DATA) {
  currentTurn = data.turn;
  turnCompactions = [];
  const run = await session.submit({
    utteranceId: `utt-${data.turn}`,
    transcript: data.question,
    conversationId: 'conv-compaction',
    scene: {
      id: data.sceneId,
      revision: data.turn,
      windowTitle: WINDOWS[data.sceneId].title,
      lastObservedRevision: data.turn - 1,
    },
    pointer: {
      normalizedX: 0.42,
      normalizedY: 0.61,
      targetRole: WINDOWS[data.sceneId].role,
      targetLabel: WINDOWS[data.sceneId].label,
    },
  });
  await run.completed;

  const active = session.activeContext();
  const usage = estimateActiveContext(active, {
    contextWindow: CONTEXT_WINDOW,
    policy: POLICY,
    summaryFor: notebook.summaryFor,
  });
  const outcome = session.lastCompaction;
  const folded = turnCompactions.at(-1);
  const triggers = (folded?.triggers ?? outcome?.decision.triggers ?? []).join(' ');
  const action =
    folded !== undefined
      ? `folded ${String(folded.boundaryIndex)} messages into summary ${String(folded.generation)}`
      : outcome?.kind === 'nothing-to-compact'
        ? 'nothing older than the retained tail'
        : '';

  console.log(
    `  ${String(data.turn).padStart(4)}  ${WINDOWS[data.sceneId].title.padEnd(17)}` +
      `${String(session.messages.length).padStart(9)} ${String(active.length).padStart(9)}` +
      `${String(usage.tokens).padStart(9)}  ${`${(usage.fraction * 100).toFixed(0)}%`.padStart(4)}   ` +
      `${triggers.padEnd(30)} ${action}`,
  );
}

line('What compaction did');
console.log(`  compactions run               : ${compactions.length}`);
console.log(`  transcript messages           : ${session.messages.length}`);
console.log(`  active-context messages       : ${session.activeContext().length}`);
console.log(`  folded up to transcript index : ${session.compaction?.boundaryIndex ?? 0}`);
console.log(`  image blocks in the transcript: ${countImageBlocks(session.messages)}`);
console.log(`  image blocks the model sees   : ${countImageBlocks(session.activeContext())}`);

line('The summary the model reads instead of the folded history (§11)');
console.log(compactions.at(-1)?.summary ?? '(none)');

line('Why it cannot be read as a description of the screen now');
{
  const summary = compactions.at(-1)?.summary ?? '';
  const authored = summary
    .split('\n')
    .filter(
      (l) =>
        !l.startsWith('- The user asked, earlier in this conversation: ') &&
        !l.startsWith('- Pilot answered, earlier in this conversation: '),
    )
    .join('\n');
  const staleness = summary.split('not a description of the screen now').length - 1;
  const presentTense =
    /\b(?:is|are|currently)\s+(?:viewing|showing|displaying|pointing|open|visible)\b/i.test(
      authored,
    ) || /\b(?:now shows|currently shows|the screen shows)\b/i.test(authored);
  console.log(`  says "not a description of the screen now"   : ${staleness} times`);
  console.log(`  present-tense screen claim in Pilot's voice  : ${presentTense}`);
  const invalidating = compactions.find((record) => record.summary.includes('has since moved to'));
  console.log(
    `  a fold caused by the window change names where the screen went: ${
      invalidating === undefined ? 'no' : `yes — summary ${String(invalidating.generation)}`
    }`,
  );
  console.log(`  carries image bytes forward                  : ${summary.includes('image/png')}`);
  console.log(
    `  tells the model to look again                : ${summary.includes('Call observe_screen before answering')}`,
  );
}

line('The transcript survived compaction unmodified');
{
  const transcript = JSON.stringify(session.messages);
  const missing = TURN_DATA.filter((data) =>
    data.observation.images.some((image) => !transcript.includes(image.base64)),
  ).map((d) => d.turn);
  const everyPayloadKept = missing.length === 0;
  if (!everyPayloadKept) {
    console.log(`  !! payloads missing from the transcript for turns: ${missing.join(', ')}`);
  }
  console.log(`  every captured payload still present         : ${everyPayloadKept}`);
  console.log(`  transcript messages                          : ${session.messages.length}`);
  console.log(
    `  summary text anywhere in the transcript      : ${transcript.includes('Conversation summary')}`,
  );
  console.log(
    `  replacement records anywhere in the transcript: ${transcript.includes(' removed. ')}`,
  );
}

await session.dispose();
console.log('');
