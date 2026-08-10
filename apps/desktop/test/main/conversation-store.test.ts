import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asConversationId } from '@pilot/shared';
import { createScriptedModelSource } from '@pilot/agent';
import { createAgentRuntime } from '../../src/main/agent-runtime.js';
import { createInteractionRuntime } from '../../src/main/interaction-runtime.js';
import {
  CONVERSATIONS_DIRECTORY,
  conversationDirectory,
  openConversationStoreRuntime,
} from '../../src/main/conversation-store.js';
import type { PilotViewState } from '@pilot/platform';

/**
 * PR-036 — runbook follow-up 20: the app owns the `ConversationStore`
 * lifecycle.
 *
 * Every test here writes to a **real SQLite database in a real temporary
 * directory**, because all three of the follow-up's non-optional details are
 * properties of a file rather than of an object:
 *
 *  (a) the writer lease is per process, and a second opener must be refused
 *      with a typed error rather than corrupting anything;
 *  (b) skipping `restore` leaves the history on disk and invisible to the
 *      model — nothing throws, which is what makes it worth a test;
 *  (c) skipping `close()` makes the next launch fail for 30 seconds.
 */

const CONVERSATION = asConversationId('conv-store-test');
const RESTING = new Set<PilotViewState['state']>(['idle', 'observing', 'paused', 'error']);

let directory = '';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pilot-store-test-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Every file under the directory, as bytes. */
async function bytesOnDisk(root: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        parts.push(await readFile(path));
      }
    }
  };
  await walk(root);
  return Buffer.concat(parts);
}

/**
 * One question, answered, through the shipping composition — the same
 * `createAgentRuntime` / `createInteractionRuntime` pair `main/index.ts` builds.
 */
async function converse(
  store: Parameters<typeof createAgentRuntime>[0]['store'],
  restore: Parameters<typeof createAgentRuntime>[0]['restore'],
  questions: readonly string[],
): Promise<{ readonly transcriptMessages: number; readonly requests: readonly string[] }> {
  const source = createScriptedModelSource({
    tokensPerSecond: 400,
    script: questions.map((question) => ({ say: `Answer to ${question}` })),
  });
  const runtime = createAgentRuntime({
    conversationId: CONVERSATION,
    source,
    ...(store === undefined ? {} : { store }),
    ...(restore === undefined ? {} : { restore }),
  });
  const { controller } = createInteractionRuntime({
    agent: runtime.session,
    conversationId: CONVERSATION,
  });
  for (const question of questions) {
    controller.dispatch({ type: 'submit-text', text: question });
    await controller.settled();
    const deadline = Date.now() + 10_000;
    while (!RESTING.has(controller.snapshot().state)) {
      if (Date.now() > deadline) {
        throw new Error(`run never settled; stuck in ${controller.snapshot().state}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await controller.settled();
  }
  const transcriptMessages = runtime.contextSummary()?.transcriptMessages ?? 0;
  await controller.dispose();
  await runtime.dispose();
  return { transcriptMessages, requests: source.requests };
}

describe('conversationDirectory', () => {
  it('is a named subdirectory of userData, not userData itself', () => {
    // §13 lists preferences, permission state and conversations as separate
    // persisted things; a user deleting one must not delete the others.
    expect(conversationDirectory('/Users/x/Library/Application Support/Pilot')).toBe(
      `/Users/x/Library/Application Support/Pilot/${CONVERSATIONS_DIRECTORY}`,
    );
  });
});

describe('the conversation store lifecycle the app owns', () => {
  it('opens, restores an empty conversation, and closes', async () => {
    const durable = await openConversationStoreRuntime({ conversationId: CONVERSATION, directory });

    expect(durable.error).toBeNull();
    expect(durable.store).not.toBeNull();
    expect(durable.restore.messages).toHaveLength(0);
    expect(durable.restore.persistedMessageCount).toBe(0);
    expect(durable.leaseHeld).toBe(false);

    await durable.close();
    // Idempotent: `before-quit` can fire more than once.
    await expect(durable.close()).resolves.toBeUndefined();
  });

  it('carries a conversation across a relaunch, and the model sees it', async () => {
    const first = await openConversationStoreRuntime({ conversationId: CONVERSATION, directory });
    const before = await converse(first.store ?? undefined, undefined, [
      'What is this toggle?',
      'And what does it cost?',
    ]);
    await first.close();

    expect(before.transcriptMessages).toBeGreaterThan(0);

    const second = await openConversationStoreRuntime({ conversationId: CONVERSATION, directory });
    expect(second.error).toBeNull();
    expect(second.restore.messages.length).toBe(before.transcriptMessages);
    expect(second.restore.repairedMessages).toBe(0);

    // The claim that matters is not "the file has rows" but "the provider was
    // sent the history", so it is read off the request the model received.
    const after = await converse(second.store ?? undefined, second.restore, ['What did I ask?']);
    await second.close();

    expect(after.requests[0]).toContain('What is this toggle?');
  }, 30_000);

  it('leaves the history invisible to the model when restore is skipped (follow-up 20 b)', async () => {
    const first = await openConversationStoreRuntime({ conversationId: CONVERSATION, directory });
    await converse(first.store ?? undefined, undefined, ['What is this toggle?']);
    await first.close();

    const second = await openConversationStoreRuntime({ conversationId: CONVERSATION, directory });
    // The store is passed; `restore` deliberately is not. Nothing throws, the
    // text is still on disk, and the model is simply never told about it —
    // which is the whole reason this row is a recorded follow-up and not an
    // implementation detail.
    const after = await converse(second.store ?? undefined, undefined, ['What did I ask?']);
    await second.close();

    expect(after.requests[0]).not.toContain('What is this toggle?');
    expect((await bytesOnDisk(directory)).includes(Buffer.from('What is this toggle?'))).toBe(true);
  }, 30_000);

  it('refuses a second opener with the lease error, and returns a usable in-memory runtime', async () => {
    const first = await openConversationStoreRuntime({ conversationId: CONVERSATION, directory });

    const second = await openConversationStoreRuntime({ conversationId: CONVERSATION, directory });

    expect(second.leaseHeld).toBe(true);
    expect(second.store).toBeNull();
    expect(second.error?.code).toBe('internal');
    expect(second.error?.details?.['reason']).toBe('writer-lease-held');
    expect(second.error?.retryable).toBe(true);
    // The sentence the panel shows. It is the only place in the product that
    // tells the user to wait, which is exactly the right advice.
    expect(second.error?.userMessage).toContain('30 seconds');
    // Total: the app must still run. An empty conversation is what a session
    // with no store starts from.
    expect(second.restore.messages).toHaveLength(0);

    await second.close();
    await first.close();
  });

  it('lets the next opener in once the lease is released', async () => {
    const first = await openConversationStoreRuntime({ conversationId: CONVERSATION, directory });
    await first.close();

    const second = await openConversationStoreRuntime({ conversationId: CONVERSATION, directory });
    expect(second.error).toBeNull();
    expect(second.store).not.toBeNull();
    await second.close();
  });

  it('never throws when the directory cannot be used', async () => {
    // A path whose parent is a regular file, so the backend cannot create it.
    // The app must come up anyway: persistence is best effort, the conversation
    // is the product.
    await writeFile(join(directory, 'blocker'), 'not a directory');
    const wedged = join(directory, 'blocker', 'nested');
    const durable = await openConversationStoreRuntime({
      conversationId: CONVERSATION,
      directory: wedged,
    });

    expect(durable.store).toBeNull();
    expect(durable.error).not.toBeNull();
    expect(durable.leaseHeld).toBe(false);
    expect(durable.restore.messages).toHaveLength(0);
    await expect(durable.close()).resolves.toBeUndefined();
  });
});
