import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScriptedModelSource, type ScriptedModelSource } from '@pilot/agent';
import {
  asConversationId,
  createLogger,
  createMemorySink,
  MVP_SCREEN_CONTEXT_POLICY,
  MVP_SCREEN_POLICY,
  type ConversationId,
  type LogRecord,
  type Logger,
  type LogSink,
  type ObservedWindow,
} from '@pilot/shared';
import {
  openConversationStoreRuntime,
  type ConversationStoreRuntime,
} from '../main/conversation-store.js';
import {
  CONSERVATIVE_CONTEXT_WINDOW,
  describeContextWindow,
  resolveContextWindow,
} from '../main/context-window.js';
import {
  AX_ELEMENTS,
  OVER_THE_BUTTON,
  pushScreenshot,
  settleRun,
} from '../observation/ask-demo.js';
import {
  createObservationRig,
  DEMO_DESKTOP,
  DEMO_WINDOWS,
  type ObservationRig,
} from '../observation/observe-rig.js';
import { BASE64_RUN, GRANTED, recordPanel, waitFor, type PanelTrace } from '../voice/flow-demo.js';

/**
 * PR-036's demo: **bounded multi-turn conversations.**
 *
 *     pnpm demo:memory
 *
 * `docs/implementation.md`, PR-036: "repeat screen questions across scene
 * changes without unbounded images or stale-screen claims." Nine screen
 * questions are asked of the shipping composition, the screen changes underneath
 * them twice — once in content, once by selecting a different window — and five
 * claims are then read off the objects the app itself uses:
 *
 *  1. **images stay bounded** — counted as image blocks in the requests the
 *     provider actually received, not as an intention;
 *  2. **text context survives** — the first question's own words are still in
 *     the ninth request, verbatim or quoted inside the summary that replaced it;
 *  3. **no stale screen reaches the model** — every replacement record is
 *     past-tense, scene-stamped, and names where the screen has since gone;
 *  4. **compaction fires and is visible in telemetry** — as
 *     `context-tokens-before`/`-after` in the ring PR-010's diagnostics surface
 *     renders, with the summary text deliberately absent (§17);
 *  5. **the conversation can be forgotten** — `clear-conversation` from the
 *     panel's own command, checked in memory *and* by scanning the bytes on
 *     disk.
 *
 * Plus the two halves of the lifecycle those depend on: the durable store is
 * opened, restored and closed exactly as `main/index.ts` does it (runbook
 * follow-up 20), and a second opener meets the SQLite writer lease.
 *
 * ## What is real, and what is not
 *
 * Real, and the shipping code: `PilotInteractionController` and its table,
 * `main/conversation-store.ts`, `main/context-window.ts`, `main/agent-runtime.ts`,
 * `PiAgentSession` with Pi's agent loop, PR-022a's pruner, PR-022b's compaction,
 * PR-023's `ConversationStore` over a **real SQLite database in a real temporary
 * directory**, `observe_screen`, `PilotScreenContextService` and the §10 policy,
 * `ObservationSession`, `MacObservationAdapter`, `MacAccessibilityAdapter`,
 * `MacWindowAdapter` and `NativeHelperTransport`.
 *
 * **NO MAC, NO MODEL.** The frames are synthetic PNGs pushed through the same
 * `ObservationSession.ingestFrame` the capture stream feeds; the far end of the
 * pipe is the Node helper stub; the model is Pi's faux provider with its replies
 * scripted. Section 8 says what that leaves unproven, and one line of it matters
 * more than the rest: **a scripted model cannot make a stale-screen claim, so
 * what section 4 checks is Pilot's *input* to the model, never the model's
 * output.**
 */

export interface MemoryDemoResult {
  readonly lines: readonly string[];
}

const CONVERSATION_ID: ConversationId = asConversationId('conv-memory-demo');

/** Nine questions, all about the screen, none of which restates the last. */
const QUESTIONS = [
  'What is this button?',
  'Does it charge the card on file?',
  'What plan is this account on?',
  'Where do past invoices live?',
  'Has anything on this screen changed?',
  'What is this list for?',
  'Which item is still open?',
  'Who added the last one?',
  'What was the first thing I asked you about?',
] as const;

/** One answer per question. Short: this walkthrough is about context, not prose. */
const ANSWERS = [
  'That is the Update payment method button.',
  'Yes — the card on file is charged when the plan renews.',
  'The account is on the team plan.',
  'Past invoices are under the billing history section.',
  'The toggle beside it is now switched the other way.',
  'It is the release checklist for the next build.',
  'The last item is still unchecked.',
  'The checklist does not record who added an item.',
  'You asked about the Update payment method button on the billing screen.',
] as const;

/** The turn at which the *content* of the watched window changes. */
const CONTENT_CHANGE_TURN = 5;
/** The turn at which a *different window* is selected: a new scene id. */
const WINDOW_CHANGE_TURN = 6;

/** Fast: nothing here is about streaming timing. */
const TOKENS_PER_SECOND = 400;

interface Turn {
  readonly number: number;
  readonly question: string;
  readonly window: ObservedWindow;
  readonly sceneRevisionHint: string;
  readonly transcriptMessages: number;
  readonly contextMessages: number;
  readonly contextImages: number;
  /** Image blocks in the provider request this turn produced. */
  readonly imagesSent: number;
  readonly compaction: string;
}

/** Every provider request this source received, parsed once. */
interface RecordedRequest {
  readonly index: number;
  readonly messages: number;
  readonly images: number;
  /** Every `[Observation … removed. …]` record the request carried. */
  readonly records: readonly string[];
  readonly json: string;
}

interface RecordedBlock {
  readonly type?: unknown;
  readonly text?: unknown;
}

interface RecordedMessage {
  readonly content?: unknown;
}

const RECORD_PATTERN = /\[Observation [^\]]*removed\.[^\]]*\]/g;

function parseRequests(source: ScriptedModelSource): readonly RecordedRequest[] {
  return source.requests.map((json, index) => {
    const messages = JSON.parse(json) as readonly RecordedMessage[];
    let images = 0;
    const records: string[] = [];
    for (const message of messages) {
      const blocks = Array.isArray(message.content)
        ? (message.content as readonly RecordedBlock[])
        : [];
      for (const block of blocks) {
        if (block.type === 'image') {
          images += 1;
          continue;
        }
        if (block.type === 'text' && typeof block.text === 'string') {
          records.push(...(block.text.match(RECORD_PATTERN) ?? []));
        }
      }
      if (typeof message.content === 'string') {
        records.push(...(message.content.match(RECORD_PATTERN) ?? []));
      }
    }
    return { index: index + 1, messages: messages.length, images, records, json };
  });
}

/** Files under `directory`, with their bytes. Used for the on-disk scans. */
async function filesOnDisk(
  directory: string,
): Promise<readonly { readonly path: string; readonly bytes: Buffer }[]> {
  const files: { path: string; bytes: Buffer }[] = [];
  const walk = async (current: string): Promise<void> => {
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

/**
 * Scans every byte under `directory` for each needle.
 *
 * The same technique `packages/agent`'s persistence demo uses, and for the same
 * reason: "no image bytes were persisted" is a claim about a file, and the only
 * way to check a claim about a file is to read the file.
 */
async function scanDisk(
  directory: string,
  needles: readonly (readonly [string, string])[],
): Promise<readonly string[]> {
  const files = await filesOnDisk(directory);
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  const lines = [
    `${String(files.length)} file(s), ${String(total)} bytes:`,
    ...files.map((file) => `  ${file.path.padEnd(24)} ${String(file.bytes.length).padStart(9)} B`),
  ];
  for (const [label, needle] of needles) {
    const hit = files.some((file) => file.bytes.includes(Buffer.from(needle)));
    lines.push(`  ${label.padEnd(52)} ${hit ? 'YES' : 'no'}`);
  }
  // A base64 run long enough to be a payload rather than an identifier, looked
  // for across the raw bytes of every file rather than inside a parsed record.
  const base64 = files.some((file) => BASE64_RUN.test(file.bytes.toString('latin1')));
  lines.push(`  ${'any base64-shaped payload in any file'.padEnd(52)} ${base64 ? 'YES' : 'no'}`);
  return lines;
}

interface Opened {
  readonly rig: ObservationRig;
  readonly window: ObservedWindow;
  readonly panel: PanelTrace;
}

/** Builds the rig over a durable store, exactly as `main/index.ts` composes it. */
async function open(
  model: ScriptedModelSource,
  durable: ConversationStoreRuntime,
  logger: Logger,
): Promise<Opened> {
  const rig = await createObservationRig({
    stub: {
      permissions: GRANTED,
      desktop: DEMO_DESKTOP,
      axElements: AX_ELEMENTS,
      pointer: OVER_THE_BUTTON,
      captureFrameBytes: 3_072,
      captureScaleFactor: 2,
    },
    modelSource: model,
    conversationId: CONVERSATION_ID,
    // Follow-up 20, and both halves together: a store with no restore is a
    // conversation that is on disk and invisible to the model.
    ...(durable.store === null ? {} : { store: durable.store, restore: durable.restore }),
    recordRequests: true,
    logger,
    // This walkthrough owns the ring: it pushes decodable screenshots, and a
    // stub frame — which is not a decodable image — landing between one of them
    // and the question anchored on it would turn `moment: 'question'` into a
    // decode failure that has nothing to do with memory.
    capturePollIntervalMs: 3_600_000,
  });
  const panel = recordPanel(rig);
  await rig.permissions.refresh();
  await rig.observation.refreshAttribution();
  const window = await rig.firstWindow();
  await rig.windows.act({ type: 'select', windowId: window.windowId });
  await rig.controller.settled();
  return { rig, window, panel };
}

/**
 * Waits out §10's observation rate window rather than reconfiguring the policy,
 * so the numbers under test stay the shipped ones (PR-030's and PR-031's demos
 * make the same choice).
 */
async function cool(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_100));
}

/** One screen question, start to finish, through the panel's own command. */
async function ask(
  rig: ObservationRig,
  window: ObservedWindow,
  text: string,
  frameId: string,
  toggleOn: boolean,
): Promise<void> {
  await pushScreenshot(rig, window, { id: frameId, capturedAt: Date.now(), toggleOn });
  await rig.observation.samplePointer();
  // The same entry point the renderer's composer reaches: `noteCommand` then
  // `dispatch`, which is what `main/index.ts` wires as `dispatchCommand`.
  rig.conversation.noteCommand({ type: 'submit-text', text });
  rig.controller.dispatch({ type: 'submit-text', text });
  await settleRun(rig);
}

export async function runMemoryDemo(): Promise<MemoryDemoResult> {
  const lines: string[] = [];
  const say = (line = ''): void => {
    lines.push(line);
  };
  const evidence = (label: string, value: string): void => {
    say(`     ${label.padEnd(46)} ${value}`);
  };

  say('PR-036 — bounded multi-turn conversations');
  say('='.repeat(72));
  say();
  say('Nine screen questions, on one conversation, while the screen changes');
  say('underneath them — first its content, then the window itself. Images stay');
  say('bounded, the text survives, no stale screen is ever offered as current,');
  say('compaction fires and is visible in the diagnostics, the conversation');
  say('survives a relaunch, and clearing it removes the bytes.');
  say();
  say('Real: PilotInteractionController and its table, main/conversation-store.ts,');
  say('      main/context-window.ts, PiAgentSession over Pi’s agent loop, the');
  say('      §11 compaction and §10 pruning, a REAL SQLite database in a real');
  say('      temporary directory, observe_screen, PilotScreenContextService, the');
  say('      mac adapters over NativeHelperTransport.');
  say('NOT REAL: no macOS, no model. The frames are synthetic PNGs and the');
  say('      replies are scripted — so section 4 checks what Pilot HANDS the');
  say('      model, never what the model says back. See section 8.');
  say();

  const sink: LogSink & { readonly records: readonly LogRecord[] } = createMemorySink();
  const logger = createLogger({ scope: 'memory-demo', level: 'debug', sink });
  const directory = await mkdtemp(join(tmpdir(), 'pilot-memory-demo-'));
  const turns: Turn[] = [];
  let compactionTriggers: readonly string[] = [];
  let secondWindowTitle = '';

  // -------------------------------------------------------------------------
  // 1 — the context budget
  // -------------------------------------------------------------------------
  say('1. THE §11 CONTEXT BUDGET, AND WHERE IT COMES FROM (follow-ups 7 and 9)');
  say('-'.repeat(72));
  say('   `PiAgentSession` defaults it to `model.contextWindow`. That is the');
  say('   provider’s own claim, which is right for a hosted model and too');
  say('   generous for a local one: §11’s 60% trigger is measured against it, so');
  say('   an inflated number means compaction never fires and the endpoint');
  say('   truncates the conversation instead — silently, in the middle.');
  say();
  {
    const hosted = resolveContextWindow({
      profile: { isRemote: true },
      model: { contextWindow: 200_000 },
    });
    const local = resolveContextWindow({
      profile: { isRemote: false },
      model: { contextWindow: 128_000 },
    });
    const quiet = resolveContextWindow({ profile: { isRemote: false }, model: {} });
    evidence('a hosted model advertising 200k:', describeContextWindow(hosted));
    evidence('a local endpoint advertising 128k:', describeContextWindow(local));
    evidence('an endpoint advertising nothing:', describeContextWindow(quiet));
    evidence(
      'the ceiling, and why that number:',
      `${String(CONSERVATIVE_CONTEXT_WINDOW)} — pi-notes §9.3 sizes a local ` +
        'deployment there, and it is above Pi’s fixed 16 384-token reserve',
    );
    say('     (below that reserve Pi’s own `shouldCompact` degenerates to “always');
    say('      compact”, which is noise rather than a signal — see');
    say('      packages/agent/src/compaction.ts.)');
  }
  say();

  // -------------------------------------------------------------------------
  // 2 — the conversation
  // -------------------------------------------------------------------------
  say('2. NINE SCREEN QUESTIONS, ACROSS TWO SCENE CHANGES');
  say('-'.repeat(72));
  say('   Every question is typed into the panel’s own composer and every answer');
  say('   is preceded by a real `observe_screen` call for `view: "both"` at');
  say('   `moment: "question"` — a full frame and a pointer crop per turn, which');
  say('   is the worst case §10’s two budgets have to hold.');
  say();

  const model = createScriptedModelSource({
    tokensPerSecond: TOKENS_PER_SECOND,
    script: QUESTIONS.flatMap((_question, index) => [
      { observe: { view: 'both', moment: 'question' } } as const,
      { say: ANSWERS[index] ?? 'Answered.' } as const,
    ]),
  });

  const durable = await openConversationStoreRuntime({
    conversationId: CONVERSATION_ID,
    directory,
    logger,
  });
  evidence('durable store:', durable.store === null ? `REFUSED (${directory})` : directory);
  evidence(
    'restored on this launch:',
    `${String(durable.restore.messages.length)} message(s), summary: ` +
      `${durable.restore.compaction === undefined ? 'none' : 'yes'}`,
  );
  say();

  const { rig, window, panel } = await open(model, durable, logger);
  /**
   * Every fold, captured at the moment it happened.
   *
   * `lastCompaction()` cannot be read after a run: `#maybeCompact` runs at every
   * turn boundary *and* again at `agent_end`, so a fold that happened mid-run is
   * overwritten by the `nothing-to-compact` that follows it. The
   * `context-compacted` event is the only place the fold itself is observable —
   * which is exactly why `main/agent-runtime.ts` records the telemetry from
   * there and not from a poll.
   */
  const folds: string[] = [];
  rig.agent.session.subscribe((event) => {
    if (event.type !== 'context-compacted') {
      return;
    }
    const outcome = rig.agent.lastCompaction();
    if (outcome?.kind !== 'compacted') {
      return;
    }
    compactionTriggers = outcome.decision.triggers;
    folds.push(
      `FOLDED ${String(outcome.tokensBefore)}→${String(outcome.tokensAfter)} tokens ` +
        `(${outcome.decision.triggers.join(' ')})`,
    );
  });
  try {
    evidence(
      'the §11 budget this session runs on:',
      describeContextWindow(rig.agent.contextWindow),
    );
    say();
    say('     turn  window            transcript  context  img msgs  sent  compaction');
    for (const [index, question] of QUESTIONS.entries()) {
      const number = index + 1;
      if (number === WINDOW_CHANGE_TURN) {
        // A different window: `SceneTracker` gives it a new *scene id*, which is
        // §11's third compaction trigger and the strongest form of "the screen
        // the earlier images described no longer exists".
        const other = (await rig.windows.refresh()).windows.find(
          (candidate) => candidate.windowId !== window.windowId,
        );
        if (other === undefined) {
          throw new Error('the stub desktop reported only one window');
        }
        secondWindowTitle = other.title;
        rig.conversation.noteCommand({ type: 'select-window', windowId: other.windowId });
        rig.observation.noteRetentionEvent('window-change');
        rig.controller.dispatch({ type: 'select-window', windowId: other.windowId });
        await rig.controller.settled();
        await waitFor(
          'capture to restart on the other window',
          () => rig.controller.snapshot().selectedWindow?.windowId === other.windowId,
        );
      }
      const current = rig.controller.snapshot().selectedWindow ?? window;
      const requestsBefore = model.requests.length;
      const foldsBefore = folds.length;
      await ask(
        rig,
        current,
        question,
        `frame-${String(number)}`,
        // The content of the watched window changes here: same window, same
        // scene id, a new revision. Every image taken before it is now a
        // picture of a screen that has moved on.
        number >= CONTENT_CHANGE_TURN,
      );
      const summary = rig.agent.contextSummary();
      const parsed = parseRequests(model).slice(requestsBefore);
      const imagesSent = parsed.reduce((total, request) => Math.max(total, request.images), 0);
      const outcome = rig.agent.lastCompaction();
      const compaction =
        folds.length > foldsBefore
          ? folds.slice(foldsBefore).join('; ')
          : outcome === undefined
            ? ''
            : `${outcome.kind} (${outcome.decision.triggers.join(' ') || 'no trigger'})`;
      turns.push({
        number,
        question,
        window: current,
        sceneRevisionHint: current.title,
        transcriptMessages: summary?.transcriptMessages ?? 0,
        contextMessages: summary?.contextMessages ?? 0,
        contextImages: summary?.contextImages ?? 0,
        imagesSent,
        compaction,
      });
      say(
        `     ${String(number).padStart(4)}  ${current.title.padEnd(17)}` +
          `${String(summary?.transcriptMessages ?? 0).padStart(10)}` +
          `${String(summary?.contextMessages ?? 0).padStart(9)}` +
          `${String(summary?.contextImages ?? 0).padStart(10)}` +
          `${String(imagesSent).padStart(6)}  ${compaction}`,
      );
      await cool();
    }
    say();
    evidence('answers on screen:', String(rig.controller.snapshot().transcript.length / 2));
    evidence('the panel’s state path:', panel.states.join(' → '));
    evidence('lastError:', String(rig.controller.snapshot().lastError?.code ?? '(none)'));
    // Runbook follow-up 31: this read 0 on the shipping path however many
    // samples had been taken, because only the fallback path incremented the
    // counter the metric reported.
    evidence(
      'pointer samples (follow-up 31):',
      `${String(rig.observation.metrics().pointerSamples)} admitted, of which ` +
        `${String(rig.observation.metrics().groundedPointerSamples)} through groundFast`,
    );
    say();

    const firstRun = parseRequests(model);

    // -----------------------------------------------------------------------
    // 3 — bounded images
    // -----------------------------------------------------------------------
    say('3. THE IMAGES EACH PROVIDER REQUEST ACTUALLY CARRIED');
    say('-'.repeat(72));
    say('   Counted by reading the request the faux provider received and');
    say('   counting `"type":"image"` blocks in it — not by trusting the pruner');
    say('   to have run. Nine observations were taken; two images each.');
    say();
    say('     request  messages  image blocks  replacement records');
    for (const request of firstRun) {
      say(
        `     ${String(request.index).padStart(7)}${String(request.messages).padStart(10)}` +
          `${String(request.images).padStart(14)}${String(request.records.length).padStart(21)}`,
      );
    }
    const worst = firstRun.reduce((most, request) => Math.max(most, request.images), 0);
    const observations = firstRun.filter((request) => request.images > 0).length;
    evidence(
      'the most images any one request carried:',
      `${String(worst)} (§10 allows maxActiveFullFrames=` +
        `${String(MVP_SCREEN_POLICY.maxActiveFullFrames)} + maxActivePointerCrops=` +
        `${String(MVP_SCREEN_POLICY.maxActivePointerCrops)})`,
    );
    evidence('requests carrying any image at all:', String(observations));
    evidence(
      'observations taken over the whole run:',
      `${String(rig.observation.metrics().observations)} — each one produced two ` +
        'image blocks, and at most two were ever in flight',
    );
    say('     (the bound is per request, which is the only bound that matters:');
    say('      it is what the provider is charged for and what it has to read.)');
    say();

    // -----------------------------------------------------------------------
    // 4 — no stale screen
    // -----------------------------------------------------------------------
    say('4. WHAT THE MODEL WAS TOLD ABOUT THE IMAGES IT NO LONGER HAS');
    say('-'.repeat(72));
    say('   §11: a replacement record “must not claim that an old screen');
    say('   description remains current”. Every record in the last request:');
    say();
    const last = firstRun[firstRun.length - 1];
    for (const record of last?.records ?? []) {
      say(`     ${record}`);
    }
    say();
    const allRecords = firstRun.flatMap((request) => request.records);
    const pastTense = allRecords.filter((record) =>
      record.includes('not a description of the screen now'),
    ).length;
    const superseded = allRecords.filter((record) => record.includes('has since moved to')).length;
    evidence(
      'records that state the negation outright:',
      `${String(pastTense)} of ${String(allRecords.length)}`,
    );
    evidence(
      'records naming where the screen has gone:',
      `${String(superseded)} (only possible once the scene has moved on)`,
    );
    evidence(
      'records with no scene stamp at all:',
      String(allRecords.filter((record) => !record.includes('/revision-')).length),
    );
    evidence(
      'the other window’s title in any prompt:',
      String(firstRun.some((request) => request.json.includes(DEMO_WINDOWS[1].title))),
    );
    say(`     (that last row reads "true" from turn ${String(WINDOW_CHANGE_TURN)} on and should:`);
    say('      the user selected that window, so it is the observed one. The');
    say('      selected-window-only invariant is checked at the wire by');
    say('      pnpm demo:observe and pnpm demo:flow; what is checked here is that');
    say('      the record for the OLD scene says the screen has left it.)');
    say();

    // -----------------------------------------------------------------------
    // 5 — compaction, in the telemetry the panel renders
    // -----------------------------------------------------------------------
    say('5. COMPACTION, IN THE RING THE DIAGNOSTICS SURFACE READS (follow-up 9)');
    say('-'.repeat(72));
    const telemetrySamples = rig.conversation.telemetry
      .snapshot()
      .samples.filter((sample) => sample.metric.startsWith('context-tokens'))
      .map((sample) => ({ metric: sample.metric, value: sample.value }));
    for (const sample of telemetrySamples) {
      say(`     ${sample.metric.padEnd(24)} ${String(sample.value)}`);
    }
    if (telemetrySamples.length === 0) {
      say('     NOTHING COMPACTED — the walkthrough proves nothing about §11 here.');
    }
    evidence('folds over the whole conversation:', String(folds.length));
    for (const fold of folds) {
      say(`     ${fold}`);
    }
    evidence('the triggers that fired last:', compactionTriggers.join(' ') || '(none)');
    say();
    say('   what survived the folds — the text half of "bounded", read off the');
    say('   last request of the run:');
    const lastJson = last?.json ?? '';
    const survived = QUESTIONS.filter((question) => lastJson.includes(question)).length;
    evidence(
      'questions still reachable, of nine:',
      `${String(survived)} — each one is either in one of §11’s six retained ` +
        'turns or quoted inside the summary that replaced its turn',
    );
    evidence('turn 1’s subject still reachable:', String(lastJson.includes('Update payment')));
    const shape = rig.agent.contextSummary();
    evidence(
      'the shape that buys it:',
      `${String(folds.length)} fold(s); ${String(shape?.contextMessages ?? 0)} messages of ` +
        `context against ${String(shape?.transcriptMessages ?? 0)} in the durable transcript`,
    );
    say('     (the transcript grows by four messages a turn and the context does');
    say('      not — that gap IS the bound, and it is the whole of §11: the');
    say('      durable record stays complete while the provider-facing context');
    say('      stops growing.)');
    const ringJson = JSON.stringify(rig.conversation.telemetry.snapshot());
    evidence(
      'any question or answer text in the ring:',
      String(
        QUESTIONS.some((question) => ringJson.includes(question)) ||
          ANSWERS.some((answer) => ringJson.includes(answer)),
      ),
    );
    say('     (the `context-compacted` event carries the summary TEXT. It is not');
    say('      read here and could not be: `AgentTelemetrySink` has one method');
    say('      and it takes a number. §17 records timings and counts.)');
    say();
  } finally {
    panel.stop();
    await rig.dispose();
  }

  // -------------------------------------------------------------------------
  // 6 — quit, relaunch, and the writer lease
  // -------------------------------------------------------------------------
  say('6. QUIT AND RELAUNCH (follow-up 20)');
  say('-'.repeat(72));
  {
    // The lease is still held here — the rig's dispose flushed and disposed the
    // session, but `store.close()` is the app's own `before-quit` step and has
    // not run yet. So this is exactly what a second instance sees.
    const second = await openConversationStoreRuntime({
      conversationId: CONVERSATION_ID,
      directory,
      logger,
    });
    evidence('a second opener, while the first holds it:', second.leaseHeld ? 'REFUSED' : 'opened');
    evidence('  code:', String(second.error?.code));
    evidence('  details.reason:', String(second.error?.details?.['reason']));
    evidence('  retryable:', String(second.error?.retryable));
    evidence('  the sentence the panel shows:', String(second.error?.userMessage));
    evidence(
      '  and the store it returned:',
      second.store === null ? 'null — in memory' : 'A STORE',
    );
    say('     (the app pairs this with app.requestSingleInstanceLock(). They');
    say('      answer different questions: the lock is per application, the lease');
    say('      is per conversation file, and a CRASHED process can still be');
    say('      holding the second when a single legitimate instance starts. It');
    say('      expires on its own after 30 s — nothing is ever deleted to “fix”');
    say('      a launch.)');
    await second.close();
    await durable.close();
    say();
  }

  const relaunchModel = createScriptedModelSource({
    tokensPerSecond: TOKENS_PER_SECOND,
    script: [{ observe: { view: 'both', moment: 'question' } }, { say: ANSWERS[8] ?? 'Answered.' }],
  });
  const relaunched = await openConversationStoreRuntime({
    conversationId: CONVERSATION_ID,
    directory,
    logger,
  });
  const second = await open(relaunchModel, relaunched, logger);
  try {
    const evidenceLines: string[] = [];
    evidenceLines.push(
      `message entries read back        : ${String(relaunched.restore.persistedMessageCount)}`,
      `structural repairs needed        : ${String(relaunched.restore.repairedMessages)}`,
      `compaction generation restored   : ${String(relaunched.restore.compaction?.generation ?? 0)}`,
      `boundary index restored          : ${String(
        relaunched.restore.compaction?.boundaryIndex ?? 0,
      )}`,
    );
    const before = second.rig.agent.contextSummary();
    evidenceLines.push(
      `transcript restored into the model: ${String(before?.transcriptMessages ?? 0)} messages`,
      `raw pixels in the restored context: ${String(before?.contextImages ?? 0)}`,
    );
    await ask(second.rig, second.window, QUESTIONS[8] ?? '?', 'frame-relaunch', true);
    const requests = parseRequests(relaunchModel);
    const first = requests[0];
    evidenceLines.push(
      `first request after the relaunch  : ${String(first?.messages ?? 0)} messages, ` +
        `${String(first?.images ?? 0)} image block(s)`,
      `it still contains turn 1’s question: ${String(first?.json.includes(QUESTIONS[0]) ?? false)}`,
      `…or turn 1’s words inside the summary: ${String(
        first?.json.includes('Update payment method') ?? false,
      )}`,
      `the answer to “what did I first ask”: "${String(
        second.rig.controller
          .snapshot()
          .transcript.filter((entry) => entry.role === 'assistant')
          .at(-1)?.text,
      )}"`,
    );
    for (const line of evidenceLines) {
      say(`     ${line}`);
    }
    say();
    say('   every byte on disk, scanned:');
    for (const line of await scanDisk(directory, [
      ['the user’s first question on disk', QUESTIONS[0]],
      ['the model’s first answer on disk', ANSWERS[0]],
      ['an "[image withheld:" audit record on disk', '[image withheld:'],
    ])) {
      say(`     ${line}`);
    }
    say('     (the images are gone because every durable write goes through the');
    say('      sanitising sink — Pi serializes whatever it is handed, verbatim,');
    say('      and has no option to do otherwise. docs/pi-notes.md §3.1.)');
    say();

    // -----------------------------------------------------------------------
    // 7 — clear conversation
    // -----------------------------------------------------------------------
    say('7. CLEAR CONVERSATION, FROM THE PANEL’S OWN COMMAND (follow-up 21)');
    say('-'.repeat(72));
    say('   `{ type: "clear-conversation" }` is the command the panel’s Clear');
    say('   button dispatches, validated by the same zod schema as every other');
    say('   one. Until PR-036 its effect in `PilotInteractionController` was a');
    say('   comment: the panel forgot, and the model did not.');
    say();
    const cleared: string[] = [];
    const beforeClear = second.rig.agent.contextSummary();
    cleared.push(
      `transcript before  : ${String(beforeClear?.transcriptMessages ?? 0)} messages, ` +
        `${String(second.rig.controller.snapshot().transcript.length)} panel entries`,
    );
    second.rig.conversation.noteCommand({ type: 'clear-conversation' });
    second.rig.controller.dispatch({ type: 'clear-conversation' });
    await second.rig.controller.settled();
    await waitFor(
      'the conversation to be cleared',
      () => (second.rig.agent.contextSummary()?.transcriptMessages ?? -1) === 0,
    );
    const afterClear = second.rig.agent.contextSummary();
    const onDisk = await relaunched.store?.restore();
    cleared.push(
      `transcript after   : ${String(afterClear?.transcriptMessages ?? 0)} messages, ` +
        `${String(second.rig.controller.snapshot().transcript.length)} panel entries`,
      `provider context   : ${String(afterClear?.contextMessages ?? 0)} messages, ` +
        `${String(afterClear?.contextImages ?? 0)} images`,
      `on disk            : ${String(onDisk?.persistedMessageCount ?? 0)} messages, summary: ` +
        `${onDisk?.compaction === undefined ? 'none' : 'STILL THERE'}`,
      `machine state      : ${second.rig.controller.snapshot().state}`,
      `lastError          : ${String(second.rig.controller.snapshot().lastError?.code ?? '(none)')}`,
    );
    for (const line of cleared) {
      say(`     ${line}`);
    }
    say();
    say('   the same bytes, scanned again:');
    for (const line of await scanDisk(directory, [
      ['the user’s first question still on disk', QUESTIONS[0]],
      ['the model’s first answer still on disk', ANSWERS[0]],
      ['any observation record still on disk', 'Update payment method'],
    ])) {
      say(`     ${line}`);
    }
    say('     (deleting rows is not removing bytes: SQLite marks pages free and');
    say('      reuses them later, so `clear()` reclaims them before returning.');
    say('      That is why this is a scan and not a row count.)');
    say();
  } finally {
    second.panel.stop();
    await second.rig.dispose();
    await relaunched.close();
    await rm(directory, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // 8 — what none of this proves
  // -------------------------------------------------------------------------
  say('8. WHAT NONE OF THE ABOVE PROVES (docs/handoff.md §1, §2)');
  say('-'.repeat(72));
  for (const [head, ...rest] of [
    [
      'NO MODEL WAS EVER TOLD ANYTHING. A scripted faux provider cannot make a',
      'stale-screen claim, so sections 3 and 4 check Pilot’s INPUT to the model:',
      'the images each request carried, and what the replacement records said.',
      'Whether a real model reads a past-tense, scene-stamped record as history',
      'is unknown until a sign-in happens (handoff §2), and it is the half that',
      'decides whether the product is trustworthy.',
    ],
    [
      'THE SUMMARY IS EXTRACTIVE, NOT WRITTEN. §11’s compaction quotes the',
      'transcript; it does not ask a model to summarise it. Whether the quotes',
      'preserve “user goals, decisions, named UI elements, unresolved questions”',
      'well enough for a real model to carry on is a judgement nobody has made.',
    ],
    [
      'THE CONTEXT WINDOW IS A GUESS. `local-ceiling` declines to trust a number',
      'it cannot check; it does not measure anything. What a real local endpoint',
      'handles before it degrades is unmeasured, and PR-039 owns finding out.',
    ],
    [
      'NO PIXEL WAS CAPTURED. The frames are synthetic PNGs pushed through the',
      'real ingest path. ScreenCaptureKit has never run here.',
    ],
    [
      'THE TOKEN COUNTS ARE ESTIMATES. Pi’s character heuristic for text and',
      'Pilot’s own linear rule for images. No provider has ever reported a real',
      'usage figure for any of this.',
    ],
    [
      'RELAUNCH HERE IS A SECOND PROCESS-LOCAL STORE, not a second launch of a',
      'packaged app. The 30-second lease behaviour, the single-instance lock and',
      'the real path of `sessions.db` are `docs/handoff.md` §1 step 16.',
    ],
  ]) {
    say(`   - ${String(head)}`);
    for (const line of rest) {
      say(`     ${line}`);
    }
  }
  say();
  evidence('log records emitted at debug level:', String(sink.records.length));
  evidence(
    'any base64-shaped run in any log line:',
    String(BASE64_RUN.test(JSON.stringify(sink.records))),
  );
  evidence('turns asked:', String(turns.length));
  evidence(
    'scene changes:',
    `content at turn ${String(CONTENT_CHANGE_TURN)}, window "${secondWindowTitle}" at ` +
      `turn ${String(WINDOW_CHANGE_TURN)}`,
  );
  evidence(
    '§10 policy in force throughout:',
    `maxFullFrames=${String(MVP_SCREEN_CONTEXT_POLICY.activeContext.maxFullFrames)} ` +
      `maxPointerCrops=${String(MVP_SCREEN_CONTEXT_POLICY.activeContext.maxPointerCrops)}`,
  );

  return { lines };
}
