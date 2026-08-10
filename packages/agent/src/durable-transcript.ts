import type { AgentMessage, Session } from '@earendil-works/pi-agent-core';
import { createSanitisingTranscriptSink, type TranscriptSink } from './session.js';

/**
 * Durable transcript backed by a Pi `Session`.
 *
 * VERIFIED (see `docs/pi-notes.md` §5 and `test/persistence.test.ts`):
 * `Session.appendMessage(message)` JSON-serializes the message verbatim into
 * the backend's entry payload. With the SQLite backend the base64 payload of
 * an image block ends up in `session_entries.payload` and is observable in
 * `sessions.db-wal` on disk; with the JSONL backend it is one line of the
 * `.jsonl` file. There is no image-stripping, no external blob store, and no
 * option to disable it.
 *
 * There is also no *automatic* writer in 0.84.1: `Agent` never touches a
 * `Session`, and the `AgentHarness` that would have wired the two is a stub
 * whose every operation throws `HarnessNotImplemented`. Pilot is therefore the
 * only writer, which is exactly what makes the guarantee enforceable — this
 * factory is the single choke point.
 */
export function createDurableTranscriptSink(session: Session): TranscriptSink {
  return createSanitisingTranscriptSink({
    async append(message: AgentMessage): Promise<void> {
      await session.appendMessage(message);
    },
  });
}

/**
 * Deliberately unsanitised sink. Exists so the persistence test can prove the
 * *negative* — that Pi does write image bytes when nothing strips them.
 * Never use this in product code.
 */
export function createUnsafeDurableTranscriptSinkForTests(session: Session): TranscriptSink {
  return {
    async append(message: AgentMessage): Promise<void> {
      await session.appendMessage(message);
    },
  };
}
