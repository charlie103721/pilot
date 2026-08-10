import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import {
  MVP_SCREEN_CONTEXT_POLICY,
  asConversationId,
  asSceneId,
  asUtteranceId,
  type ScreenObservation,
} from '@pilot/shared';
import {
  OBSERVE_SCREEN_TOOL_NAME,
  PiAgentSession,
  buildSystemPrompt,
  containsImageBytes,
  createObservationNotebook,
  createObserveScreenTool,
  openConversationStore,
  stripImageBlocks,
  toDurablePayload,
  type ConversationBackend,
  type ConversationStore,
  type RestoredConversation,
} from '../src/index.js';
import {
  FAUX_PROFILE,
  createFauxHarness,
  envelope,
  fauxAssistantMessage,
  fauxToolCall,
  fixtureImageBase64,
  observation,
  scriptedScreenContext,
} from './support.js';

/**
 * PR-023 — restart mid-conversation, on real disk.
 *
 * The claim under test is the one `docs/runbook.md` follow-up 8 records:
 * restoring the transcript alone is not enough. Compaction is provider-facing
 * only (§11) — it never enters `agent.state.messages` — so a session restored
 * from the transcript is *complete* and therefore re-sends the entire history
 * to the provider at the first question after a relaunch. Transcript **plus**
 * summary **plus** boundary is what reproduces the context.
 */

const POLICY = MVP_SCREEN_CONTEXT_POLICY;
const FIXED_NOW = 1_700_000_000_000;
const now = (): number => FIXED_NOW;
const TURNS = 12;

const openStores: ConversationStore[] = [];
const openSessions: PiAgentSession[] = [];

afterEach(async () => {
  await Promise.all(openSessions.splice(0).map((session) => session.dispose()));
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

function turnObservation(turn: number): ScreenObservation {
  return observation({
    observationId: `obs-${String(turn)}` as ScreenObservation['observationId'],
    sceneId: asSceneId('scene-17'),
    sceneRevision: turn,
    capturedAt: FIXED_NOW + turn * 1_000,
    images: [
      {
        mimeType: 'image/png',
        base64: fixtureImageBase64(`frame-${String(turn)}`, 64),
        purpose: 'window',
      },
    ],
  });
}

async function tempDirectory(tag: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `pilot-restart-${tag}-`));
}

async function open(
  directory: string,
  backend: ConversationBackend = 'sqlite',
): Promise<ConversationStore> {
  const store = await openConversationStore({
    conversationId: asConversationId('conv-restart'),
    directory,
    backend,
  });
  openStores.push(store);
  return store;
}

interface SessionOptions {
  readonly store?: ConversationStore;
  readonly restore?: RestoredConversation;
}

function newSession(options: SessionOptions): {
  session: PiAgentSession;
  harness: ReturnType<typeof createFauxHarness>;
  observations: ScreenObservation[];
} {
  const harness = createFauxHarness();
  const notebook = createObservationNotebook();
  const observations = Array.from({ length: TURNS + 1 }, (_, index) => turnObservation(index + 1));
  const tool = createObserveScreenTool({
    screenContext: scriptedScreenContext(observations),
    onObservation: notebook.note,
  });

  harness.setResponses(
    Array.from({ length: TURNS + 1 }, () => [
      fauxAssistantMessage(
        [fauxToolCall(OBSERVE_SCREEN_TOOL_NAME, { view: 'window', moment: 'question' })],
        { stopReason: 'toolUse' as const },
      ),
      fauxAssistantMessage('That switch turns on automatic renewal.', {
        stopReason: 'stop' as const,
      }),
    ]).flat(),
  );

  const session = new PiAgentSession({
    conversationId: asConversationId('conv-restart'),
    profile: FAUX_PROFILE,
    models: harness.models,
    model: harness.model,
    systemPrompt: buildSystemPrompt(),
    tools: [tool as unknown as AgentTool<never>],
    visualContext: { policy: POLICY, summaryFor: notebook.summaryFor },
    compaction: { now },
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.restore === undefined ? {} : { restore: options.restore }),
  });
  openSessions.push(session);
  return { session, harness, observations };
}

async function ask(session: PiAgentSession, turn: number): Promise<void> {
  await (
    await session.submit(
      envelope({
        utteranceId: asUtteranceId(`utt-${String(turn)}`),
        transcript: `question ${String(turn)}`,
        scene: { id: 'scene-17', revision: turn, windowTitle: 'Billing settings' },
      }),
    )
  ).completed;
}

/** What the sanitising sink would have written for `message`. */
function asPersisted(message: AgentMessage): AgentMessage {
  return toDurablePayload(stripImageBlocks(message));
}

async function bytesOnDisk(directory: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        chunks.push(await readFile(path));
      }
    }
  };
  await walk(directory);
  return Buffer.concat(chunks);
}

describe.each<ConversationBackend>(['sqlite', 'jsonl'])(
  'restarting mid-conversation on the %s backend',
  (backend) => {
    it('restores the transcript, the summary and the boundary, and no pixels', async () => {
      const directory = await tempDirectory(backend);
      const store = await open(directory, backend);
      const { session } = newSession({ store });

      for (let turn = 1; turn <= TURNS; turn += 1) {
        await ask(session, turn);
      }
      const before = {
        messages: session.messages.map(asPersisted),
        compaction: session.compaction,
        activeContext: session.activeContext(),
      };
      // The premise: this conversation really was compacted, and its live
      // context really did carry pixels.
      expect(before.compaction?.generation).toBeGreaterThan(0);
      expect(before.compaction?.boundaryIndex).toBeGreaterThan(0);
      expect(before.activeContext.some(containsImageBytes)).toBe(true);

      // The crash: dispose flushes, close releases the writer lease.
      await session.dispose();
      await store.close();

      // …and the relaunch.
      const reopened = await open(directory, backend);
      const restored = await reopened.restore();
      const { session: restarted } = newSession({ store: reopened, restore: restored });

      // 1. The durable transcript came back byte-for-byte, minus the pixels.
      expect(restored.repairedMessages).toBe(0);
      expect(restarted.messages).toEqual(before.messages);

      // 2. So did the summary and the boundary it indexes.
      expect(restarted.compaction?.generation).toBe(before.compaction?.generation);
      expect(restarted.compaction?.boundaryIndex).toBe(before.compaction?.boundaryIndex);
      expect(restarted.compaction?.summary?.text).toBe(before.compaction?.summary?.text);

      // 3. Which is what makes the provider-facing context the same context:
      //    same length, same folded prefix, same summary message — including
      //    its timestamp, so it is the same message and not merely the same
      //    words.
      const after = restarted.activeContext();
      expect(after).toHaveLength(before.activeContext.length);
      expect(after[0]).toEqual(before.activeContext[0]);
      expect(after.length).toBeLessThan(restarted.messages.length);

      // 4. Nothing that came back off disk carries image bytes, and nothing
      //    on disk ever did.
      expect(after.some(containsImageBytes)).toBe(false);
      const bytes = await bytesOnDisk(directory);
      for (const image of [1, TURNS].map((turn) => fixtureImageBase64(`frame-${String(turn)}`, 24)))
        expect(bytes.includes(Buffer.from(image))).toBe(false);
      expect(bytes.includes(Buffer.from('[image withheld: image/png'))).toBe(true);
    });
  },
);

describe('a restored session', () => {
  it('does not re-send the folded history — the point of persisting the summary', async () => {
    const directory = await tempDirectory('followup8');
    const store = await open(directory);
    const { session } = newSession({ store });
    for (let turn = 1; turn <= TURNS; turn += 1) {
      await ask(session, turn);
    }
    const boundary = session.compaction?.boundaryIndex ?? 0;
    await session.dispose();
    await store.close();

    const reopened = await open(directory);
    const restored = await reopened.restore();

    // With the summary: the *first* provider request after the relaunch opens
    // with the summary and carries only the retained tail. The first request
    // is the one that matters — by the second, the restored-without-summary
    // session has compacted on its own and the gap has closed, having already
    // paid for it once.
    const withSummary = newSession({ store: reopened, restore: restored });
    await ask(withSummary.session, TURNS + 1);
    const foldedRequest = withSummary.harness.seenContexts[0]?.messages ?? [];
    expect(foldedRequest[0]).toMatchObject({ role: 'user' });
    expect(JSON.stringify(foldedRequest[0])).toContain('question 1');

    // Without it — the failure mode follow-up 8 exists to prevent — the same
    // transcript produces a strictly larger request, because every folded turn
    // is sent again.
    const transcriptOnly: RestoredConversation = {
      messages: restored.messages,
      persistedMessageCount: restored.persistedMessageCount,
      repairedMessages: restored.repairedMessages,
    };
    const withoutSummary = newSession({ restore: transcriptOnly });
    await ask(withoutSummary.session, TURNS + 1);
    const wholeHistoryRequest = withoutSummary.harness.seenContexts[0]?.messages ?? [];

    expect(wholeHistoryRequest.length).toBeGreaterThan(foldedRequest.length);
    expect(wholeHistoryRequest.length).toBeGreaterThanOrEqual(boundary);
  });

  it('appends new turns after the restored ones instead of duplicating them', async () => {
    const directory = await tempDirectory('append');
    const store = await open(directory);
    const { session } = newSession({ store });
    await ask(session, 1);
    await ask(session, 2);
    await session.dispose();
    await store.close();

    const reopened = await open(directory);
    const restored = await reopened.restore();
    const { session: restarted } = newSession({ store: reopened, restore: restored });
    await ask(restarted, 3);
    await restarted.flush();

    const reread = await reopened.restore();
    expect(reread.messages).toEqual(restarted.messages.map(asPersisted));
    // Three questions asked, three questions on disk — none written twice.
    const questions = JSON.stringify(reread.messages).match(/question \d+/g) ?? [];
    expect(new Set(questions)).toEqual(new Set(['question 1', 'question 2', 'question 3']));
  });

  it('starts empty and writes nothing when there is nothing to restore', async () => {
    const directory = await tempDirectory('empty');
    const store = await open(directory);
    const restored = await store.restore();
    const { session } = newSession({ store, restore: restored });

    expect(session.messages).toHaveLength(0);
    expect(session.compaction?.generation).toBe(0);
  });
});

describe('clear conversation', () => {
  it('drops the transcript, the summary and the durable data together', async () => {
    const directory = await tempDirectory('clear');
    const store = await open(directory);
    const { session } = newSession({ store });
    for (let turn = 1; turn <= TURNS; turn += 1) {
      await ask(session, turn);
    }
    await session.flush();
    expect(session.compaction?.generation).toBeGreaterThan(0);
    expect((await store.restore()).messages.length).toBeGreaterThan(0);

    await session.clearConversation();

    // In memory…
    expect(session.messages).toHaveLength(0);
    expect(session.compaction).toMatchObject({ generation: 0, boundaryIndex: 0 });
    expect(session.compaction?.summary).toBeUndefined();
    expect(session.activeContext()).toHaveLength(0);
    // …on disk…
    expect(await store.restore()).toMatchObject({ messages: [], persistedMessageCount: 0 });
    expect((await store.restore()).compaction).toBeUndefined();
    // …and in the bytes. Not just the questions: the observation records, the
    // summary and the withheld-image audit trail describe the conversation
    // too, and "clear" has to mean all of it.
    const bytes = await bytesOnDisk(directory);
    for (const needle of [
      'question 1',
      'Auto Renew',
      '[image withheld',
      'Conversation summary',
      'automatic renewal',
    ]) {
      expect({ needle, present: bytes.includes(Buffer.from(needle)) }).toEqual({
        needle,
        present: false,
      });
    }

    // The session is still usable, and starts persisting from zero again.
    await ask(session, 1);
    await session.flush();
    const reread = await store.restore();
    expect(reread.messages).toEqual(session.messages.map(asPersisted));
  });

  it('is available through the platform facade as an optional member', async () => {
    const directory = await tempDirectory('facade');
    const store = await open(directory);
    const { session } = newSession({ store });
    // PR-023's only shared-contract change: `AgentSession.clearConversation?`.
    // Optional, so PR-005's fakes still satisfy the interface untouched.
    const facade: { clearConversation?: () => Promise<void> } = session;
    await expect(facade.clearConversation?.()).resolves.toBeUndefined();
  });
});
