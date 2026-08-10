import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createNodeSqliteFactory } from '@earendil-works/pi-session-backend-sqlite-node';
import { asConversationId } from '@pilot/shared';
import {
  DEFAULT_WRITER_LEASE,
  PILOT_COMPACTION_ENTRY_TYPE,
  isWriterLeaseHeld,
  openConversationStore,
  repairTranscript,
  type CompactionState,
  type CompactionSummary,
  type ConversationBackend,
  type ConversationStore,
} from '../src/index.js';
import { PNG_1PX_BASE64 } from './support.js';

/**
 * PR-023 — the durable half of the `Agent ↔ Session` bridge.
 *
 * Everything here runs against a real backend writing to a real temporary
 * directory, and the privacy assertions read the resulting bytes back off the
 * filesystem. Asserting on a mock would prove only that the mock was called.
 */

const CONVERSATION = asConversationId('conv-persist');
const SECRET_LOOKING = 'sk-test-not-a-real-credential-0000';

const openStores: ConversationStore[] = [];

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

async function tempDirectory(tag: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `pilot-store-${tag}-`));
}

async function open(
  backend: ConversationBackend,
  directory: string,
  overrides: { readonly writerLease?: { ttlMs: number; heartbeatIntervalMs: number } } = {},
): Promise<ConversationStore> {
  const store = await openConversationStore({
    conversationId: CONVERSATION,
    directory,
    backend,
    ...overrides,
  });
  openStores.push(store);
  return store;
}

/** Every byte under `directory`, concatenated. The privacy proof reads this. */
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

function userTurn(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1_700_000_000_000 };
}

/** The assistant turn that asks for the observation `observationResult` answers. */
function observationCall(): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'tc-1', name: 'observe_screen', arguments: {} }],
    api: 'faux',
    provider: 'pilot-faux',
    model: 'faux-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 1_700_000_000_000,
  } as unknown as AgentMessage;
}

function observationResult(): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'tc-1',
    toolName: 'observe_screen',
    content: [
      { type: 'text', text: 'The Auto Renew switch is on.' },
      { type: 'image', data: PNG_1PX_BASE64, mimeType: 'image/png' },
    ],
    isError: false,
    timestamp: 1_700_000_000_001,
  };
}

/**
 * An assistant message shaped the way Pi actually builds one, with the three
 * explicit `undefined` properties that make `appendMessage` throw
 * (`docs/pi-notes.md` §3.3). The cast is what makes the shape expressible
 * under `exactOptionalPropertyTypes`.
 */
function assistantTurnAsPiBuildsIt(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'faux',
    provider: 'pilot-faux',
    model: 'faux-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1_700_000_000_002,
    responseId: undefined,
    errorMessage: undefined,
    deferred: undefined,
  } as unknown as AgentMessage;
}

function summaryFixture(text: string): CompactionSummary {
  return {
    generation: 1,
    coveredMessages: 4,
    goals: ['- The user asked, earlier in this conversation: “what does Auto Renew do?”'],
    decisions: [],
    namedElements: ['Auto Renew'],
    screens: [],
    unresolved: [],
    safety: [],
    observedScenes: ['scene-17'],
    omitted: 0,
    text,
  };
}

function compactionStateFixture(text: string): CompactionState {
  return {
    generation: 1,
    boundaryIndex: 2,
    summary: summaryFixture(text),
    observationsAtLastCompaction: 3,
    summaryTimestamp: 1_700_000_000_500,
    questions: [
      {
        utteranceId: 'utt-9',
        messageIndex: 2,
        transcript: 'and what about the other one?',
        sceneId: 'scene-17',
        sceneRevision: 5,
        windowTitle: 'Billing settings',
      },
    ],
  };
}

const BACKENDS: ConversationBackend[] = ['sqlite', 'jsonl'];

describe.each(BACKENDS)('ConversationStore on the %s backend', (backend) => {
  it('writes the text of a conversation to disk and never the image bytes', async () => {
    const directory = await tempDirectory(backend);
    const store = await open(backend, directory);

    await store.transcript.append(userTurn(`what does Auto Renew do? ${SECRET_LOOKING}`));
    await store.transcript.append(observationCall());
    await store.transcript.append(observationResult());
    await store.transcript.append(assistantTurnAsPiBuildsIt('It renews your plan automatically.'));
    await store.close();

    const bytes = await bytesOnDisk(directory);
    // The proof, on real files: the pixels are not there…
    expect(bytes.includes(Buffer.from(PNG_1PX_BASE64))).toBe(false);
    // …the audit trail that replaced them is…
    expect(bytes.includes(Buffer.from('[image withheld: image/png'))).toBe(true);
    // …and the text conversation §13 does persist is.
    expect(bytes.includes(Buffer.from('It renews your plan automatically.'))).toBe(true);
  });

  it('restores the transcript verbatim, minus the pixels', async () => {
    const directory = await tempDirectory(backend);
    const store = await open(backend, directory);

    await store.transcript.append(userTurn('what does Auto Renew do?'));
    await store.transcript.append(observationCall());
    await store.transcript.append(observationResult());
    await store.transcript.append(assistantTurnAsPiBuildsIt('It renews your plan automatically.'));

    const restored = await store.restore();

    expect(restored.messages).toHaveLength(4);
    expect(restored.repairedMessages).toBe(0);
    expect(restored.persistedMessageCount).toBe(4);
    expect(restored.messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'tc-1',
      content: [
        { type: 'text', text: 'The Auto Renew switch is on.' },
        { type: 'text', text: expect.stringContaining('[image withheld: image/png') as string },
      ],
    });
    // The `undefined`-carrying assistant message survived the round trip with
    // the offending keys simply absent, which is what `toDurablePayload` does.
    const assistant = restored.messages[3] as unknown as Record<string, unknown>;
    expect(Object.hasOwn(assistant, 'responseId')).toBe(false);
    expect(assistant['stopReason']).toBe('stop');
  });

  it('restores the compaction summary and boundary alongside the transcript', async () => {
    const directory = await tempDirectory(backend);
    const store = await open(backend, directory);

    await store.transcript.append(userTurn('first'));
    await store.transcript.append(assistantTurnAsPiBuildsIt('first answer'));
    await store.transcript.append(userTurn('second'));
    await store.transcript.append(assistantTurnAsPiBuildsIt('second answer'));
    await store.saveCompaction(compactionStateFixture('[Earlier in this conversation…]'));
    await store.close();

    const reopened = await open(backend, directory);
    const restored = await reopened.restore();

    expect(restored.messages).toHaveLength(4);
    expect(restored.compaction).toMatchObject({
      generation: 1,
      boundaryIndex: 2,
      observationsAtLastCompaction: 3,
      summaryTimestamp: 1_700_000_000_500,
    });
    expect(restored.compaction?.summary.text).toBe('[Earlier in this conversation…]');
    expect(restored.compaction?.questions[0]?.utteranceId).toBe('utt-9');
  });

  it('keeps only the newest snapshot, so a second fold supersedes the first', async () => {
    const directory = await tempDirectory(backend);
    const store = await open(backend, directory);

    await store.transcript.append(userTurn('first'));
    await store.transcript.append(assistantTurnAsPiBuildsIt('first answer'));
    await store.saveCompaction(compactionStateFixture('generation one'));
    await store.saveCompaction({
      ...compactionStateFixture('generation two'),
      generation: 2,
      boundaryIndex: 2,
    });

    const restored = await store.restore();
    expect(restored.compaction?.generation).toBe(2);
    expect(restored.compaction?.summary.text).toBe('generation two');
  });

  it('accepts a summary carrying an explicit undefined, which Pi would reject', async () => {
    const directory = await tempDirectory(backend);
    const store = await open(backend, directory);
    await store.transcript.append(userTurn('first'));
    await store.transcript.append(assistantTurnAsPiBuildsIt('first answer'));
    const state = compactionStateFixture('summary with holes');
    const holed = {
      ...state,
      summary: { ...state.summary, supersededBy: undefined },
    } as unknown as CompactionState;

    // Pi's `assertJsonSerializable` runs on custom entries exactly as it does
    // on messages; `toDurableJson` is what keeps this from throwing.
    await expect(store.saveCompaction(holed)).resolves.toBeUndefined();
    expect((await store.restore()).compaction?.summary.text).toBe('summary with holes');
  });

  it('clears the conversation: gone from the store and gone from the bytes', async () => {
    const directory = await tempDirectory(backend);
    const store = await open(backend, directory);

    await store.transcript.append(userTurn(`what does Auto Renew do? ${SECRET_LOOKING}`));
    await store.transcript.append(assistantTurnAsPiBuildsIt('It renews your plan automatically.'));
    await store.saveCompaction(compactionStateFixture('a summary nobody should keep'));
    expect((await store.restore()).messages).toHaveLength(2);

    await store.clear();

    expect(await store.restore()).toMatchObject({
      messages: [],
      persistedMessageCount: 0,
      repairedMessages: 0,
    });
    expect((await store.restore()).compaction).toBeUndefined();

    // Not just unreachable — gone. SQLite would otherwise keep the deleted
    // pages readable in the file until it happened to reuse them, so `clear()`
    // reclaims them; the JSONL backend deletes the whole file.
    const bytes = await bytesOnDisk(directory);
    expect(bytes.includes(Buffer.from(SECRET_LOOKING))).toBe(false);
    expect(bytes.includes(Buffer.from('It renews your plan automatically.'))).toBe(false);
    expect(bytes.includes(Buffer.from('a summary nobody should keep'))).toBe(false);

    // …and the store is still usable afterwards, on the same conversation id.
    await store.transcript.append(userTurn('a fresh start'));
    expect((await store.restore()).messages).toHaveLength(1);
  });

  it('reopens the same conversation by id rather than creating a second one', async () => {
    const directory = await tempDirectory(backend);
    const first = await open(backend, directory);
    await first.transcript.append(userTurn('remember me'));
    await first.close();

    const second = await open(backend, directory);
    expect((await second.restore()).messages).toHaveLength(1);
    await second.transcript.append(assistantTurnAsPiBuildsIt('remembered'));
    await second.close();

    const third = await open(backend, directory);
    expect((await third.restore()).messages).toHaveLength(2);
  });

  it('is empty, not broken, when nothing was ever written', async () => {
    const store = await open(backend, await tempDirectory(backend));
    expect(await store.restore()).toMatchObject({ messages: [], persistedMessageCount: 0 });
  });

  it('close() is idempotent, so a double shutdown is not an error', async () => {
    const store = await open(backend, await tempDirectory(backend));
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });
});

/**
 * The SQLite writer lease (`SqliteWriterLeaseOptions`, default 30 s TTL with a
 * 10 s heartbeat). The Electron main process has to respect it; these tests
 * pin what it will see.
 */
describe('the SQLite writer lease', () => {
  it('states Pi 0.84.1 defaults as code, so an upstream change fails here first', () => {
    expect(DEFAULT_WRITER_LEASE).toEqual({ ttlMs: 30_000, heartbeatIntervalMs: 10_000 });
    expect(DEFAULT_WRITER_LEASE.heartbeatIntervalMs).toBeLessThan(DEFAULT_WRITER_LEASE.ttlMs);
  });

  it('refuses a second writer while the first holds the lease', async () => {
    const directory = await tempDirectory('lease');
    const first = await open('sqlite', directory);
    await first.transcript.append(userTurn('mine'));

    // A second repository against the same database file is, as far as the
    // `writer_leases` table is concerned, exactly a second process.
    await expect(open('sqlite', directory)).rejects.toSatisfy(isWriterLeaseHeld);
    await expect(open('sqlite', directory)).rejects.toThrow(/another Pilot process/i);

    // …and it is available again the moment the holder closes.
    await first.close();
    const second = await open('sqlite', directory);
    expect((await second.restore()).messages).toHaveLength(1);
  });

  it('locks out a new writer until a crashed process’s lease expires', async () => {
    const directory = await tempDirectory('crash');
    const store = await open('sqlite', directory);
    await store.transcript.append(userTurn('written before the crash'));
    await store.close();

    // What a SIGKILLed process leaves behind: a lease row nobody heartbeats.
    // Writing it directly is the only way to reproduce that without actually
    // killing a process, and it is byte-for-byte the same on-disk state.
    const databasePath = join(directory, 'sessions.db');
    const database = await createNodeSqliteFactory().open(databasePath);
    const claim = (expiresAtMs: number): void => {
      database
        .prepare(
          `INSERT INTO writer_leases (session_id, owner_id, fence, expires_at_ms)
           VALUES (?, 'ghost-process', 7, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             owner_id = excluded.owner_id, expires_at_ms = excluded.expires_at_ms`,
        )
        .run(String(CONVERSATION), expiresAtMs);
    };

    claim(Date.now() + DEFAULT_WRITER_LEASE.ttlMs);
    database.close();
    await expect(open('sqlite', directory)).rejects.toSatisfy(isWriterLeaseHeld);

    // Once the TTL has passed — 30 s after the crashed process's last
    // heartbeat — the next opener takes over. Nothing has to be deleted by
    // hand, and the conversation written before the crash is intact.
    const expirer = await createNodeSqliteFactory().open(databasePath);
    expirer
      .prepare('UPDATE writer_leases SET expires_at_ms = ? WHERE session_id = ?')
      .run(Date.now() - 1, String(CONVERSATION));
    expirer.close();

    const recovered = await open('sqlite', directory);
    expect((await recovered.restore()).messages).toHaveLength(1);
  });

  it('stops a zombie writer dead once its lease has been taken over', async () => {
    const directory = await tempDirectory('zombie');
    const zombie = await open('sqlite', directory);
    await zombie.transcript.append(userTurn('before the takeover'));

    // Expire the zombie's lease behind its back and let a new writer claim it.
    // The claim bumps the lease *fence*, which is what the zombie's next write
    // checks — so the two can never interleave writes.
    const databasePath = join(directory, 'sessions.db');
    const database = await createNodeSqliteFactory().open(databasePath);
    database
      .prepare('UPDATE writer_leases SET expires_at_ms = ? WHERE session_id = ?')
      .run(Date.now() - 1, String(CONVERSATION));
    database.close();

    const successor = await open('sqlite', directory);
    await successor.transcript.append(userTurn('after the takeover'));

    await expect(zombie.transcript.append(userTurn('a write that must not land'))).rejects.toThrow(
      /writer lease was lost/,
    );
    const messages = (await successor.restore()).messages;
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages)).not.toContain('a write that must not land');
  });

  it('does not apply to the JSONL backend, which holds no lease at all', async () => {
    const directory = await tempDirectory('jsonl-lease');
    const first = await open('jsonl', directory);
    await first.transcript.append(userTurn('mine'));
    const second = await open('jsonl', directory);
    expect((await second.restore()).messages).toHaveLength(1);
  });
});

describe('the compaction entry type', () => {
  it('is namespaced, so it can never collide with a Pi entry type', () => {
    expect(PILOT_COMPACTION_ENTRY_TYPE).toBe('pilot.compaction.v1');
    expect(PILOT_COMPACTION_ENTRY_TYPE.startsWith('pilot.')).toBe(true);
  });
});

describe('repairTranscript', () => {
  const assistantWithToolCall = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'tc-9', name: 'observe_screen', arguments: {} }],
    stopReason: 'toolUse',
    timestamp: 1,
  } as unknown as AgentMessage;
  const resultFor = (id: string): AgentMessage =>
    ({
      role: 'toolResult',
      toolCallId: id,
      toolName: 'observe_screen',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: 2,
    }) as unknown as AgentMessage;

  it('leaves a complete transcript alone', () => {
    const messages = [userTurn('q'), assistantWithToolCall, resultFor('tc-9')];
    expect(repairTranscript(messages)).toEqual({ messages, dropped: 0 });
  });

  it('drops an assistant turn whose tool call was never answered', () => {
    const user = userTurn('q');
    // The user's own question stays: it was really asked, and a transcript
    // ending in a question is a valid provider context.
    expect(repairTranscript([user, assistantWithToolCall])).toEqual({
      messages: [user],
      dropped: 1,
    });
  });

  it('drops an orphan tool result wherever it sits, and is idempotent', () => {
    const messages = [
      userTurn('q'),
      resultFor('tc-missing'),
      assistantWithToolCall,
      resultFor('tc-9'),
    ];
    const once = repairTranscript(messages);
    expect(once.dropped).toBe(1);
    expect(repairTranscript(once.messages)).toEqual({ messages: once.messages, dropped: 0 });
  });
});
