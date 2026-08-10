import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlSessionRepo, type AgentMessage, type Session } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  SqliteSessionRepository,
  createNodeSqliteFactory,
} from '@earendil-works/pi-session-backend-sqlite-node';
import {
  containsImageBytes,
  createDurableTranscriptSink,
  createUnsafeDurableTranscriptSinkForTests,
  stripImageBlocks,
  toDurablePayload,
} from '../src/index.js';
import { PNG_1PX_BASE64 } from './support.js';

/**
 * The system-design §11 question, answered on real disk:
 * "does the pinned Pi session implementation serialize image blocks?"
 *
 * Answer: yes, verbatim, on both shipped backends. And it can be prevented,
 * because Pilot is the only writer.
 */

const imageMessage = {
  role: 'toolResult' as const,
  toolCallId: 'tc-1',
  toolName: 'observe_screen',
  content: [
    { type: 'text' as const, text: 'observation' },
    { type: 'image' as const, data: PNG_1PX_BASE64, mimeType: 'image/png' },
  ],
  isError: false,
  timestamp: 1_700_000_000_000,
};

const openRepositories: SqliteSessionRepository[] = [];

afterEach(async () => {
  await Promise.all(openRepositories.splice(0).map((repo) => repo.close()));
});

async function tempEnv(): Promise<NodeExecutionEnv> {
  return new NodeExecutionEnv({ cwd: await mkdtemp(join(tmpdir(), 'pilot-pi-cwd-')) });
}

async function bytesOnDisk(directory: string): Promise<Buffer> {
  const files = await readdir(directory);
  const chunks = await Promise.all(files.map((file) => readFile(join(directory, file))));
  return Buffer.concat(chunks);
}

async function sqliteSession(): Promise<{ directory: string; session: Session }> {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-pi-sqlite-'));
  const env = await tempEnv();
  const repo = new SqliteSessionRepository({
    env,
    sqlite: createNodeSqliteFactory(),
    databasePath: join(directory, 'sessions.db'),
  });
  openRepositories.push(repo);
  return { directory, session: await repo.create({ cwd: env.cwd }) };
}

describe('Pi durable session storage', () => {
  it('SQLite backend writes raw base64 image bytes to disk when nothing strips them', async () => {
    const { directory, session } = await sqliteSession();

    await createUnsafeDurableTranscriptSinkForTests(session).append(imageMessage);

    const entries = await session.findEntries();
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0])).toContain(PNG_1PX_BASE64);
    expect((await bytesOnDisk(directory)).includes(Buffer.from(PNG_1PX_BASE64))).toBe(true);
  });

  it('SQLite backend keeps image bytes off disk when the sanitising sink is used', async () => {
    const { directory, session } = await sqliteSession();

    await createDurableTranscriptSink(session).append(imageMessage);

    const entries = await session.findEntries();
    expect(entries).toHaveLength(1);
    const stored = entries[0];
    expect(stored?.type).toBe('message');
    // The audit trail survives; the pixels do not.
    expect(JSON.stringify(stored)).toContain('[image withheld: image/png');
    expect(JSON.stringify(stored)).not.toContain(PNG_1PX_BASE64);
    expect((await bytesOnDisk(directory)).includes(Buffer.from(PNG_1PX_BASE64))).toBe(false);
  });

  it('JSONL backend behaves identically — raw by default, clean when sanitised', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-pi-jsonl-'));
    const env = await tempEnv();
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });

    const dirty = await repo.create({ cwd: env.cwd });
    await createUnsafeDurableTranscriptSinkForTests(dirty).append(imageMessage);
    const dirtyPath = (await dirty.getMetadata()).path;
    expect(await readFile(dirtyPath, 'utf8')).toContain(PNG_1PX_BASE64);

    const clean = await repo.create({ cwd: env.cwd });
    await createDurableTranscriptSink(clean).append(imageMessage);
    const cleanPath = (await clean.getMetadata()).path;
    const cleanText = await readFile(cleanPath, 'utf8');
    expect(cleanText).not.toContain(PNG_1PX_BASE64);
    expect(cleanText).toContain('[image withheld: image/png');
  });
});

describe('Session.appendMessage payload validation', () => {
  it('rejects Pi assistant messages verbatim because they carry explicit undefined', async () => {
    const { session } = await sqliteSession();
    const assistantMessageAsPiBuildsIt = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
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
      stopReason: 'stop' as const,
      timestamp: 1,
      // Pi sets these three explicitly, and this is what trips the assertion.
      // Pilot's own `exactOptionalPropertyTypes` would reject writing them, so
      // the cast is what makes the runtime shape expressible here at all.
      responseId: undefined,
      errorMessage: undefined,
      deferred: undefined,
    } as unknown as AgentMessage;

    await expect(session.appendMessage(assistantMessageAsPiBuildsIt)).rejects.toMatchObject({
      code: 'invalid_payload',
    });
    // toDurablePayload (applied by the sanitising sink) is the fix.
    await expect(
      session.appendMessage(toDurablePayload(assistantMessageAsPiBuildsIt)),
    ).resolves.toBeTypeOf('string');
  });
});

describe('stripImageBlocks', () => {
  it('replaces image blocks and leaves everything else untouched', () => {
    const stripped = stripImageBlocks(imageMessage);
    expect(containsImageBytes(imageMessage)).toBe(true);
    expect(containsImageBytes(stripped)).toBe(false);
    expect(stripped).toMatchObject({
      role: 'toolResult',
      toolCallId: 'tc-1',
      isError: false,
      content: [
        { type: 'text', text: 'observation' },
        { type: 'text', text: expect.stringContaining('[image withheld: image/png') as string },
      ],
    });
  });

  it('passes through messages with plain string content', () => {
    const message = { role: 'user' as const, content: 'plain', timestamp: 1 };
    expect(stripImageBlocks(message)).toBe(message);
  });
});
