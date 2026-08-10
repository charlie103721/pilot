# Pi Agent Core — capability spike findings (PR-005)

Status: Complete for Part A. Part B blocked on user credentials (§9).
Last updated: 2026-08-10
Owner lane: E4

This document replaces assumptions about the Pi packages with facts. Every
"VERIFIED" claim below is backed by a test in `packages/agent/test/` that runs
with `pnpm test` — no network, no credentials. Every "BLOCKED" item names
exactly what the user must supply.

**Read §6 first if you are short of time.** It is the list of places where
`docs/system-design.md` assumed something Pi does not do.

---

## 1. Pinned versions

| Package | Pinned | Where the API surface was read |
| --- | --- | --- |
| `@earendil-works/pi-agent-core` | **0.84.1** | `node_modules/@earendil-works/pi-agent-core/dist/*.d.ts` + `README.md` |
| `@earendil-works/pi-ai` | **0.84.1** | `node_modules/@earendil-works/pi-ai/dist/*.d.ts` + `README.md` |
| `@earendil-works/pi-session-backend-sqlite-node` | **0.84.1** | `node_modules/@earendil-works/pi-session-backend-sqlite-node/dist/**` |

Exact (non-caret) pins live in `packages/agent/package.json`. They are also
duplicated as constants in `packages/agent/src/pinned.ts`, and
`packages/agent/test/visual-context.test.ts` fails if the installed tree drifts
from them — because the file/line citations in this document are only valid for
these exact tarballs.

Upstream source: <https://github.com/earendil-works/pi> (MIT, author Mario
Zechner / Earendil Works). The npm tarballs ship `.d.ts`, `.d.ts.map` and
readable ESM `.js`; everything below was read from the installed packages
rather than from GitHub, so it matches what we actually run.

### 1.1 CORRECTION to `docs/runbook.md` §7

> `@earendil-works/pi-storage-sqlite-node@0.83.0`

**This is the wrong package.** It was renamed for the 0.84 line. Findings:

- `pi-storage-sqlite-node` stops at 0.83.0 (`npm view … versions`). Its manifest
  depends on `@earendil-works/pi-agent-core: ^0.83.0`, which does **not** admit
  0.84.1, so installing it alongside `pi-agent-core@0.84.1` puts a **second,
  duplicate copy** of `pi-agent-core` *and* `pi-ai` in the tree (confirmed in a
  scratch lockfile: both `0.83.0` and `0.84.1` resolved).
- The duplicate is not merely wasteful, it is **incompatible**. A `Session`
  returned by 0.83.0's `SqliteSessionRepo.create()` is a different class with a
  different method surface:
  - 0.83.0: `getEntries`, `buildContext`, `appendTypedEntry`, `appendCompaction`,
    `getBranch`, `moveTo`, …
  - 0.84.1: `findEntries`, `findEntriesOnBranch`, `appendRecord`, `appendEntry`,
    `createLane`, `moveLane`, `getLog`, `view`, …
  A direct call to `session.findEntries()` on the 0.83.0 object throws
  `TypeError: s3.findEntries is not a function`, and `instanceof` against the
  0.84.1 `Session` is `false`.
- The 0.84-line replacement is **`@earendil-works/pi-session-backend-sqlite-node`**
  (versions 0.84.0, 0.84.1). The class is also renamed:
  `SqliteSessionRepo` → **`SqliteSessionRepository`**, its options type is
  `SqliteSessionRepositoryOptions`, and it gained `close()` /
  `[Symbol.asyncDispose]` plus a writer-lease mechanism
  (`SqliteWriterLeaseOptions`, default TTL 30 s, heartbeat 10 s).
- `npm search @earendil-works/pi` does **not** list the new package (search
  index lag); `npm view @earendil-works/pi-session-backend-sqlite-node versions`
  does. The rename is documented in `pi-agent-core`'s own README, which already
  refers to "`@earendil-works/pi-session-backend-sqlite-node`".

**Action:** amend `docs/runbook.md` §7. The correct triple is
`pi-agent-core@0.84.1`, `pi-ai@0.84.1`,
`pi-session-backend-sqlite-node@0.84.1`.

Also relevant, published at 0.84.1 and not currently used: `pi-telemetry`
(transitive dependency), `pi-client`, `pi-protocol`, `pi-tui`, `pi-web-ui`,
`pi-coding-agent` (the reference application), `pi-radius`.

---

## 2. Verified capabilities

Test file abbreviations: **[R]** `packages/agent/test/pi-api-reality.test.ts`,
**[S]** `packages/agent/test/pilot-session.test.ts`,
**[P]** `packages/agent/test/persistence.test.ts`,
**[V]** `packages/agent/test/visual-context.test.ts`.

### 2.1 Session creation and streaming — VERIFIED [R]

```ts
new Agent({
  streamFn: (model, context, options) => models.streamSimple(model, context, options),
  initialState: { systemPrompt, model, tools },
  transformContext?, convertToLlm?, beforeToolCall?, afterToolCall?,
  shouldStopAfterTurn?, prepareNextTurn?, steeringMode?, followUpMode?,
  sessionId?, thinkingBudgets?, transport?, toolExecution?, getApiKey?,
})
```

- `Agent` is the *stateful* wrapper (`dist/agent.d.ts`). It owns
  `state.messages`, `state.tools`, `state.systemPrompt`, `state.model`,
  `state.isStreaming`, `state.pendingToolCalls`, `state.errorMessage`.
- `models` comes from `createModels()` in `@earendil-works/pi-ai`; providers are
  registered with `models.setProvider(provider)`.
- Event order for a plain text turn, observed exactly:
  `agent_start → turn_start → message_start(user) → message_end(user) →
   message_start(assistant) → message_update×N → message_end → turn_end →
   agent_end`. Matches `pi-agent-core/README.md` "prompt() Event Sequence".
- Text deltas arrive as `message_update` events whose
  `assistantMessageEvent.type === "text_delta"` carries `.delta`. There is **no
  top-level `text_delta` agent event**; you must unwrap.
- `agent.subscribe(listener)` returns an unsubscribe function. Listener promises
  are awaited and are part of run settlement.
- **One run at a time**: a second `agent.prompt()` while streaming rejects with
  `Error: Agent is already processing a prompt. Use steer() or followUp() to
  queue messages, or wait for completion.` This is what backs
  `run-already-active` in the Pilot facade — Pilot does not have to police it.

### 2.2 Typed tool definition and registration — VERIFIED [R][S]

`interface AgentTool<TParameters extends TSchema, TDetails>` in
`pi-agent-core/dist/types.d.ts`:

```ts
{
  name: string;
  label: string;                 // required, UI display
  description: string;
  parameters: TSchema;           // TypeBox schema (typebox@1.3.7)
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute(toolCallId, params, signal?, onUpdate?): Promise<AgentToolResult<TDetails>>;
  executionMode?: "sequential" | "parallel";
}
```

- Schemas are **TypeBox**, re-exported from `@earendil-works/pi-ai` as `Type`
  and `Static`. Not zod, not raw JSON Schema types (a plain object literal works
  at runtime but will not typecheck).
- Pi validates arguments against the schema **before** `execute` runs; the
  validated object arrives as `params`, and `tool_execution_start.args` carries
  it.
- Tools are registered by assigning `state.tools` (or `initialState.tools`).
  Assignment copies the top-level array.
- Default `toolExecution` is **`"parallel"`**. For `observe_screen` this matters:
  set `executionMode: "sequential"` if concurrent captures are unsafe.
- **Errors: throw, do not encode.** Pi converts a thrown error into
  `{ isError: true, content: [{ type: "text", text: err.message }] }` and the
  loop continues to the next turn — verified: a tool that throws
  `new Error('window closed')` produced exactly that tool result and the run
  still finished `stopReason: "stop"`.
- `AgentToolResult.details` is carried on the tool-result message and on the
  `tool_execution_end` event, and is **not** sent to the model. Good home for
  observation ids and scene metadata.

#### 2.2.1 AMENDMENT (PR-021): "throw, do not encode" destroys `details`

Reading `dist/agent-loop.js` rather than the `.d.ts` changes the advice above.
A thrown error is converted by `createErrorToolResult(err.message)`, which is
literally `{ content: [{ type: "text", text: message }], details: {} }`. So
throwing **discards `details` entirely** — the `PilotError` code, retryability
and remedy are flattened into one English sentence, and Pilot's `tool-failed`
event has nothing typed to carry.

`AgentOptions.afterToolCall` is the way out, and it is verified to run on
*both* the success and the throw path (`finalizeExecutedToolCall` is called
with whatever `executePreparedToolCall` produced). `AfterToolCallResult.isError`
replaces the loop's flag. So a Pilot tool can return a normal result whose
`details` declare failure, and a generic hook
(`packages/agent/src/tool-result.ts`, `markFailedToolResults`) sets `isError`
— the model, the transcript, `tool_execution_end` and the UI then agree, with
`details` intact. That is what `observe_screen` does.

Two more verified facts from the same file, both found by test:

- **Abort pre-empts the tool entirely.** `prepareToolCall` checks
  `signal?.aborted` three times and returns `createErrorToolResult("Operation
  aborted")` without calling `execute`. A run aborted between
  `tool_execution_start` and execution therefore produces a tool result the
  tool never authored, with `details: {}`. Pilot maps that exact string to
  `cancelled` (`PI_ABORTED_TOOL_TEXT`) so the UI does not report a capture
  failure for a user cancellation.
- **`onUpdate` is real and cheap.** The fourth `execute` parameter emits
  `tool_execution_update` with the partial result attached; PR-021 uses it for
  the "observing" state Pilot's `tool-progress` event carries.

### 2.3 Image tool results — VERIFIED [R][S]

The content-block shape a tool returns for an image is:

```ts
{ type: "image", data: "<base64, NO data: prefix>", mimeType: "image/png" }
```

(`@earendil-works/pi-ai` `dist/types.d.ts`, `interface ImageContent` — three
fields, nothing else. There is no `url`, no `source`, no `purpose`, no
`detail`.)

- A tool result content array is `(TextContent | ImageContent)[]`. Mixed
  text + image in one result is supported and is what `observe_screen` uses.
- The result lands on the transcript as a `ToolResultMessage`:
  `{ role: "toolResult", toolCallId, toolName, content, details?, isError,
  timestamp }`.
- Vision capability is `model.input.includes("image")`. Per `pi-ai`'s README:
  "If you pass images to a non-vision model, **they are silently ignored**."
  So Pilot's own capability gate is load-bearing — Pi will not error.
- Helpers exist for building image blocks from bytes:
  `detectSupportedImageMimeType(buffer)` and `encodeBase64(bytes)` from
  `pi-agent-core` (`dist/harness/tools/image.d.ts`).

### 2.4 Abort — VERIFIED [R][S], with a caveat

- `agent.abort()` takes **no arguments** and returns `void`. `agent.signal`
  exposes the active `AbortSignal`.
- **There is no abort event.** Nothing in the `AgentEvent` union signals an
  abort. The only evidence is the final assistant message:
  `stopReason: "aborted"` and `errorMessage: "Request was aborted"`, mirrored on
  `agent.state.errorMessage`. Pilot's `run-aborted` event is synthesised from
  that in `packages/agent/src/session.ts`.
- Abort **during tool execution** propagates to the tool's `signal` parameter
  (verified: listener fired, tool rejected). Note the resulting final message is
  `stopReason: **"error"**`, not `"aborted"` — a tool rejecting is modelled as a
  failure, not a cancellation. PR-027 must treat both as "interrupted".
- `agent.waitForIdle()` resolves after `agent_end` listeners settle. `prompt()`
  itself resolves earlier, so aborting reliably needs `waitForIdle()`.

### 2.5 Steer and follow-up — VERIFIED [R]

- `agent.steer(message: AgentMessage)` queues a message injected at the next
  drain point (after the current assistant turn's tool calls complete). It takes
  a **whole message**, not a reason string.
- `agent.followUp(message)` queues a message that runs only after the agent
  would otherwise stop.
- Queue draining is configurable: `steeringMode` / `followUpMode` are
  `"all" | "one-at-a-time"`.
- Also available: `clearSteeringQueue()`, `clearFollowUpQueue()`,
  `clearAllQueues()`, `hasQueuedMessages()`.
- **Caveat, not fully pinned down:** the exact position of a steered message in
  `state.messages` relative to the in-flight assistant message varies with when
  `steer()` is called (a steer issued immediately after `prompt()` was drained
  ahead of the assistant turn). The *effect* — the model answers the replacement
  question — is verified; the precise interleaving is not, and PR-027 should not
  depend on transcript index arithmetic.

### 2.6 Context transformation (the image-pruning hook) — VERIFIED [R][V]

`AgentOptions.transformContext(messages, signal?) => Promise<AgentMessage[]>`
runs before every provider request, and before `convertToLlm`.

Verified precisely: with a transform that swaps image blocks for text, the
context handed to the provider contained the replacement and **not** the base64,
while `agent.state.messages` still held the original image block. That is
exactly the mechanism system-design §11 needs — "replace obsolete image blocks
with a compact record" — with the bonus that the app keeps the pixels for a
later turn.

Pi's contract (from the `.d.ts`): `transformContext` "must not throw or reject.
Return the original messages or another safe fallback." `pruneVisualContext` in
`packages/agent/src/visual-context.ts` is total by construction.

Message flow, from `pi-agent-core/README.md`:
`AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM`.

Note `AgentMessage` is wider than an LLM `Message`: via declaration merging it
also includes `BashExecutionMessage`, `CustomMessage`, `BranchSummaryMessage`
and `CompactionSummaryMessage` (`dist/harness/messages.d.ts`). Anything touching
`message.content` must narrow first — `'content' in message` — because
`BashExecutionMessage` has no `content` field. This is a real compile error
under Pilot's strict config, not a theoretical one.

### 2.7 Compaction primitives — VERIFIED (local half) [R]

Exported from `pi-agent-core` (`dist/harness/compaction/compaction.d.ts`):

| Symbol | Nature | Notes |
| --- | --- | --- |
| `estimateTokens(message)` | pure, local | conservative character heuristic |
| `estimateContextTokens(messages)` | pure, local | prefers real provider `usage` when present; returns `{tokens, usageTokens, trailingTokens, lastUsageIndex}` |
| `calculateContextTokens(usage)` | pure, local | |
| `shouldCompact(tokens, contextWindow, settings)` | pure, local | verified `true` at 5100/8000, `false` at 1000/128000 |
| `DEFAULT_COMPACTION_SETTINGS` | constant | `{ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }` |
| `findCutPoint`, `findTurnStartIndex` | pure, local | turn-aware cut selection |
| `prepareCompaction(entries, settings)` | pure, local | returns a `Result<CompactionPreparation \| undefined>` |
| `generateSummary` / `generateSummaryWithUsage` / `compact` | **needs a provider call** | takes `models` + `model`, so it costs tokens |
| `SUMMARIZATION_SYSTEM_PROMPT` | constant | the summariser's system prompt |
| `serializeConversation` | pure | |
| `collectEntriesForBranchSummary`, `generateBranchSummary`, `prepareBranchEntries` | mixed | branch summaries |

Two things to note for PR-022:

1. `prepareCompaction` and `compact` operate on **session `Entry[]`**, not on
   `AgentMessage[]`. Using them means maintaining a `Session` entry list in
   parallel with the `Agent` transcript, or converting.
2. There is **no automatic compaction**. Nothing triggers `compact()` for you;
   `DEFAULT_COMPACTION_SETTINGS.enabled` is read by the (stubbed) harness, not
   by `Agent`. Pilot owns the trigger logic in system-design §11 outright.

### 2.8 Model / provider layer — VERIFIED (metadata only)

`interface Model<TApi>` (`pi-ai` `dist/types.d.ts`) has:
`id, name, api, provider, baseUrl, reasoning, thinkingLevelMap?, input:
("text"|"image")[], cost, contextWindow, maxTokens, samplingParams?, headers?,
compat?`.

- 38 built-in providers (`getBuiltinProviders()`), including `anthropic`,
  `openai`, `openai-codex`, `google`, `github-copilot`, `openrouter`,
  `amazon-bedrock`, `mistral`, `groq`, `cerebras`, …
- Custom / local providers: `createProvider({ id, name, baseUrl, auth, models,
  api })` with `openAICompletionsApi()` from
  `@earendil-works/pi-ai/api/openai-completions.lazy`. Documented in the pi-ai
  README §"Custom Providers" with a working Ollama example.
- Auth model (`dist/auth/types.d.ts`): a **provider** carries
  `auth: { apiKey?: ApiKeyAuth; oauth?: OAuthAuth }`. `OAuthAuth.isSubscription`
  flags subscription-backed access. Credentials are app-owned via a
  `CredentialStore` interface (`read`/`list`/`modify`/`delete`); `Models` runs
  OAuth refresh under the store lock.
- Faux provider for tests: `fauxProvider()`, `fauxAssistantMessage()`,
  `fauxToolCall()`, `fauxText()`, `fauxThinking()` from
  `@earendil-works/pi-ai` (`dist/providers/faux.d.ts`). Supports scripted
  response sequences, response factories that inspect the request context,
  `tokensPerSecond` throttling, and a `state.callCount`. This is what every test
  in `packages/agent` runs against.

---

## 3. The durable-storage question, answered definitively

> system-design §11: "If the pinned Pi session implementation serializes image
> blocks automatically, Pilot must use a session adapter or custom context
> representation that prevents raw frame retention."

### 3.1 Does Pi serialize image blocks to disk? **Yes, verbatim.** [P]

`Session.appendMessage(message)` stores the message as-is inside a
`MessageEntry` (`dist/harness/session/types.d.ts`:
`interface MessageEntry extends EntryBase { type: "message"; message: AgentMessage }`).
Backends then `JSON.stringify` the entry payload:

- **SQLite backend**: `session_entries.payload TEXT NOT NULL` (see the shipped
  `migrations/001_initial.sql`). Verified by direct SQL read from a second
  connection, and by scanning the files: the base64 string appears in
  `sessions.db-wal` on disk.
- **JSONL backend** (`JsonlSessionRepo`, in-package at 0.84.1): one line per
  entry, base64 inline. Verified by reading the `.jsonl` file.

There is no image stripping, no external blob store, no configuration flag, and
no size cap.

### 3.2 Can images be excluded? **Yes — completely, and easily.** [P][S]

Two independent reasons this is straightforward:

1. **Pilot is the only writer.** `Agent` never touches a `Session`. The class
   that *would* have wired them together, `AgentHarness`, is a stub in 0.84.1
   (§4). So every byte that reaches disk goes through a call Pilot makes.
2. The sanitisation is a pure function on the message.

Exactly how, as implemented:

```ts
// packages/agent/src/session.ts
createSanitisingTranscriptSink(inner) // → toDurablePayload(stripImageBlocks(message))

// packages/agent/src/durable-transcript.ts
createDurableTranscriptSink(piSession) // the single choke point used by PiAgentSession
```

`stripImageBlocks` replaces every `{type:"image"}` block with
`{type:"text", text:"[image withheld: image/png, 96 base64 chars]"}` — the audit
trail survives, the pixels do not.

Verified on real disk, in `packages/agent/test/persistence.test.ts`:

| Backend | Sink | base64 on disk |
| --- | --- | --- |
| SQLite 0.84.1 | unsanitised | **true** |
| SQLite 0.84.1 | sanitising | **false** |
| JSONL 0.84.1 | unsanitised | **true** |
| JSONL 0.84.1 | sanitising | **false** |

and end-to-end through a real run in
`packages/agent/test/pilot-session.test.ts` ("persists text but never image
bytes"), which additionally asserts the pixels *were* present in the live model
context — i.e. we did not achieve privacy by breaking the feature.

PR-023 extended this to the whole store rather than a single sink:
`packages/agent/test/conversation-store.test.ts` and
`packages/agent/test/session-restore.test.ts` run twelve-turn conversations
against both backends in real temporary directories and scan every byte of
every file, and `packages/agent/demo/persistence-demo.mjs` prints that scan.
The same has to hold for the *second* write path — the compaction summary goes
to disk as a custom entry, and custom entry payloads are serialized verbatim
too.

### 3.3 Trap: Pi's own messages cannot be persisted verbatim — VERIFIED [P]

`Session.appendMessage` runs `assertJsonSerializable`, which throws
`SessionError("invalid_payload", "Durable payload contains undefined")` on **any
`undefined` value at any depth** (also rejects non-finite numbers, cycles, and
non-JSON types).

Pi's own `AssistantMessage` objects always carry `responseId`, `errorMessage`
and `deferred` as *explicit* `undefined`. Taking a message straight off
`agent.state.messages` and persisting it therefore **throws**. This was found by
running the demo, not by reading types.

Fix: `toDurablePayload()` (a JSON round-trip), applied inside
`createSanitisingTranscriptSink`. PR-023 must keep it.

Note the irony worth recording: Pilot's `exactOptionalPropertyTypes: true` means
*we* cannot even write `responseId: undefined` in TypeScript — the test needs a
cast to express the shape Pi produces at runtime.

---

## 4. `AgentHarness` is a stub in 0.84.1 — VERIFIED [R]

This is the single most consequential finding for the agent lane.

`pi-agent-core` exports `AgentHarness`, a rich, session-backed, resumable,
multi-lane API: `prompt`, `steer`, `followUp`, `nextRun`, `compact`,
`navigateTree`, `resume`, `abort`, `watch`, `hooks`, lanes, writer leases,
suspended-operation recovery. Its `.d.ts` is ~500 lines and it looks exactly
like what system-design §8 describes ("session compaction primitives",
"steering, interruption, and follow-up queue behavior", "recent conversation
messages").

**None of it is implemented.** `dist/harness/agent-harness.js` is 251 lines, of
which the operational methods are all one-liners:

```js
prompt(...)   { return this.unavailable("prompt"); }
compact(...)  { return this.unavailable("compact"); }
abort()       { return this.unavailable("abort"); }
// unavailable() → Promise.reject(new HarnessNotImplemented(operation))
```

`AgentHarness.create()` *succeeds* (returns `{ harness, suspended: [] }`), which
makes this an easy trap: the failure only shows up on first use. Restoring an
existing session throws `HarnessNotImplemented("create.restore")`.

Verified in `pi-api-reality.test.ts`: `prompt`, `compact`, `abort` and
`waitForIdle` all reject with `HarnessNotImplemented`.

**Consequence:** Pilot must drive the low-level `Agent` class and own everything
the harness would have provided — run identity, persistence, compaction
triggering, resume-after-crash. That is what `packages/agent/src/session.ts`
does. The upside is that the "no images on disk" guarantee becomes trivially
enforceable (§3.2); the downside is that PR-022 and PR-023 are bigger than
`docs/implementation.md` sizes them.

---

## 5. What was built in this PR

| File | What it is |
| --- | --- |
| `packages/agent/src/pinned.ts` | Version pins as code + drift detector |
| `packages/agent/src/model-profile.ts` | Pi `Model` → `ModelProfile`; capability gate |
| `packages/agent/src/visual-context.ts` | `pruneVisualContext` (model context), `stripImageBlocks` (disk) |
| `packages/agent/src/observe-screen.ts` | `observe_screen` as a TypeBox-typed Pi tool returning images |
| `packages/agent/src/session.ts` | `PiAgentSession` — the Pilot facade over Pi's `Agent` |
| `packages/agent/src/durable-transcript.ts` | The single write path to a Pi `Session` |
| `packages/agent/src/system-prompt.ts` | System prompt, including the degraded no-vision variant |
| `packages/agent/demo/observe-screen-demo.mjs` | The PR demo (see §10) |

`packages/platform/src/agent.ts` was **reshaped** — see §7.

---

## 6. Contradictions with `docs/system-design.md`

Blunt list. Each item is a place the design doc assumed something Pi does not do.

### 6.1 §8 "Responsibilities owned by Pi" is materially overstated

The doc credits Pi with: model invocation and streaming; the tool-call loop;
recent conversation messages; **steering, interruption and follow-up queue
behavior**; provider-normalized image and tool-result messages; **session
compaction primitives**.

Reality:

| Claim | Reality |
| --- | --- |
| Model invocation and streaming | ✅ true (`Agent` + `Models.streamSimple`) |
| Tool-call loop | ✅ true |
| Recent conversation messages | ⚠️ in memory only. `Agent.state.messages` is not persisted by Pi; the persistent `Session` is a separate object Pilot must drive. |
| Steering / interruption / follow-up | ⚠️ primitives exist on `Agent` (`steer`, `followUp`, `abort`), but there is **no interruption *event***, and abort-during-tool is reported as `stopReason:"error"`. Pilot owns the semantics. |
| Provider-normalized image and tool-result messages | ✅ true |
| Session compaction primitives | ⚠️ the *primitives* exist, but the orchestration (`AgentHarness.compact`) is unimplemented, and the primitives operate on session `Entry[]` rather than the `AgentMessage[]` the `Agent` holds. |

### 6.2 §10 "Raw screenshots are not persisted by default" — false as stated

Pi's default *is* to persist them (§3.1). The correct statement is: **Pilot never
writes them**, because Pilot is the only writer and its single write path strips
them. Reword decision 10 to make the guarantee Pilot's, not Pi's.

### 6.3 §12 `ModelProfile.supportsTools` cannot be derived from Pi

Pi's `Model` carries **no tool-support metadata at all**. It has `input`
(→ `supportsVision`, trustworthy), `reasoning`, `thinkingLevelMap`, `cost`,
`contextWindow`, `maxTokens`, and `compat` (which contains
`supportsStrictTools` — that is *constrained sampling*, not tool support).

`supportsTools` is therefore Pilot-configured, defaulted to `true`, and PR-020's
"capability checks" cannot be a lookup. `packages/agent/src/model-profile.ts`
records this at the point of use.

Worse: a model that cannot do vision **does not error** when handed an image —
`pi-ai`'s README says images are "silently ignored". So the §12 gate is not an
optimisation, it is the only thing preventing a silently wrong answer.

### 6.4 §12 `ModelProfile.authMode` does not map 1:1 onto Pi

Pi attaches auth to the **provider**, not the model, and a provider may expose
*both* `apiKey` and `oauth` at once (`anthropic` does). `authMode` is a
Pilot-side statement about which credential Pilot chose, not a Pi fact.

### 6.5 §11 compaction triggers must be built entirely by Pilot

"Four new visual observations since the previous compaction", "estimated context
usage exceeds 60%", "the selected window changes" — none of these exist in Pi.
`shouldCompact()` implements a *different* rule (reserve-token headroom against
the context window). PR-022 writes its own trigger and may use `shouldCompact`
as one input.

### 6.6 §11 the replacement-record mechanism is real, but it is `transformContext`

The doc says "before a provider request, the visual context transformer replaces
obsolete image blocks". That maps exactly onto `AgentOptions.transformContext`
(§2.6) — worth naming in the doc so PR-022 does not reinvent it. Note it does
*not* mutate the transcript, which is better than the doc assumes.

### 6.7 §15 "one run at a time" is enforced by Pi

Not a contradiction, a simplification: Pi already rejects concurrent prompts, so
`run-already-active` is a mapping, not an invariant Pilot must maintain.

### 6.8 `docs/runbook.md` §7 names the wrong sqlite package

See §1.1. Amendment required.

---

## 7. Changes to shared contracts (LOUD — PR-002 / PR-006 read this)

`packages/platform/src/agent.ts` was reshaped. **The reshape is deliberately
source-compatible: no member was removed and no existing signature changed
arity or parameter types.** PR-002 and PR-006 continue to compile unchanged.

What changed:

1. `interrupt(mode, reason)` → `interrupt(mode, detail)`. **Parameter name and
   documented meaning only.** For `'abort'`, `detail` is an internal reason
   string that never reaches the model (Pi's `abort()` takes no argument). For
   `'steer'`, `detail` is **sent to the model verbatim** as the replacement
   user message, because Pi's `steer()` takes a whole message. Anyone calling
   `interrupt('steer', …)` must pass question text, not a reason code.
2. Added `AgentEvent` members `tool-progress` (Pi `tool_execution_update`) and
   `context-compacted`. Additive; the existing doc comment already warned the
   union is not closed.
3. Added the tool contract that PR-001 had none of: `AgentToolContent`
   (verified `text | image` block shape), `AgentToolResult`,
   `AgentToolDefinition`. PR-021 builds on these.
4. Added `AgentSessionCapabilities` and the optional
   `AgentSession.capabilities`, carrying the §6.3 caveat in its doc comment.
5. Corrected the `dispose()` comment: "images never are [persisted]" is a
   property of Pilot's writer, not of Pi.

`packages/platform/src/fakes/agent.ts` was **not** changed and still satisfies
the interface (its contract test passes).

`packages/shared/src/model.ts` was **not** changed. `ModelProfile` survives the
spike intact; only the *derivation* of `supportsTools` turned out to be
unverifiable (§6.3).

---

## 8. Consequences for PR-020 … PR-023 and the runbook amendments

### PR-020 — Model profiles and capability checks

- ⚠️ "vision/tool capability gating" cannot be a Pi metadata lookup for tools
  (§6.3). Split the gate: `supportsVision` from `model.input`, `supportsTools`
  from Pilot configuration with a safe default.
- Add: because a non-vision model **silently ignores** images, the gate must run
  before the first request, not as a nicety. `assertSupportsVisualConversation`
  in `packages/agent/src/model-profile.ts` already does this and is called from
  the `PiAgentSession` constructor.
- The "auth facade" should wrap Pi's `CredentialStore` interface
  (`read`/`list`/`modify`/`delete`) rather than invent one; `Models` performs
  OAuth refresh inside `modify` under a lock.
- Size still **M**. Mostly unaffected.

### PR-021 — `observe_screen` tool — **LANDED**

- ✅ Delivered. `packages/agent/src/observe-screen.ts` has the TypeBox schema,
  the `ScreenContextService` call, image/text result mapping, the full error
  mapping and lifecycle events, with `packages/agent/test/observe-screen.test.ts`
  covering every mapping, the abort path, the selected-window-only guarantee
  and an adversarial untrusted-content fixture.
- Schemas are **TypeBox**, not zod, so `observe_screen` states its enumeration
  twice. Three guards, in the order that catches drift earliest: both schemas
  are built from `OBSERVE_SCREEN_VIEWS`/`OBSERVE_SCREEN_MOMENTS` in
  `@pilot/shared`; `SCHEMAS_ARE_IN_SYNC` is a compile-time equality assertion
  that **fails `pnpm typecheck` and `pnpm build`** on divergence; and `execute`
  re-parses Pi's validated arguments through zod. `typebox@1.3.7` is now a
  direct, pinned dependency of `@pilot/agent` rather than reached through
  pi-ai's re-export — a typebox bump changes what arguments reach the tool.
- `executionMode: "sequential"` decided and set. Pi's default is `"parallel"`,
  and two concurrent captures of one window produce frames the scene checks
  cannot order.
- The error path returns a typed result rather than throwing, for the reason in
  §2.2.1.
- Size **M → S**, as predicted.

### PR-022 — Visual context pruning and compaction

- ⚠️ **Size M → L.** The pruning half is done and verified
  (`pruneVisualContext` wired through `transformContext`). The compaction half
  is larger than planned: there is no orchestrator (§4), the primitives take
  session `Entry[]` rather than `AgentMessage[]` (§2.7), and all three triggers
  from §11 must be written from scratch (§6.5).
- Recommend splitting: **PR-022a** active-image limits + obsolete-image
  replacement (nearly complete), **PR-022b** compaction trigger + summary
  generation + truthful scene summaries.

#### PR-022b — compaction orchestration — **LANDED**

Delivered in `packages/agent/src/compaction.ts`, wired into `PiAgentSession`,
covered by `packages/agent/test/compaction.test.ts` and demonstrated by
`packages/agent/demo/compaction-demo.mjs`. Four things found while building it
that are not in §2.7 and that PR-023/PR-036 must not rediscover:

1. **`Agent` silently drops `compactionSummary` messages.** `pi-agent-core`
   exports `createCompactionSummaryMessage` and a `convertToLlm` that renders it
   — but that converter lives in `dist/harness/messages.js` and is **not
   exported from the package index**. `Agent`'s own default is
   `defaultConvertToLlm` (`dist/agent.js` line 3), which is literally
   `messages.filter(m => m.role === "user" || "assistant" || "toolResult")`. A
   compaction summary inserted through `transformContext` as Pi's own message
   type is therefore discarded with no error and the model simply loses the
   history. Pilot's summary is a plain `user` message whose first line says
   whose voice it is. Asserted by test.
2. **`estimateContextTokens` is the wrong function for a §11 trigger.** It
   prefers the provider `usage` on the last assistant message, which describes
   the request that already happened; the faux provider reports a fixed handful
   of tokens for any context, so a trigger built on it never fires under test
   and reports last turn's number in production. `estimateTokens` (per message,
   pure) is the part worth using.
3. **Pi charges a flat 4800 characters — 1200 tokens — per image block**
   (`ESTIMATED_IMAGE_CHARS`), whatever its size. A 640px pointer crop and a
   1440px full frame cost the same. Pilot charges `64 + bytes/128` instead,
   computed from the `kept.images` / `kept.bytes` that PR-022a's
   `planVisualContext` already publishes.
4. **`shouldCompact` degenerates below a 16384-token window.** Its rule is
   `tokens > contextWindow - reserveTokens` with `reserveTokens: 16384` fixed,
   so for any window at or below that the right-hand side is ≤ 0 and the answer
   is always `true`. That is every 8k and 16k local model (§9.3). Pilot consults
   it only above the reserve, and reports it as `provider-headroom`, separate
   from §11's three.

One design tension worth recording rather than resolving silently: §11 asks for
compaction "when any condition is met" *and* for "last 6–10 text turns" in
active context. Early in a conversation those disagree — four observations can
land inside six turns. The retained tail wins, and the outcome is reported as
`nothing-to-compact` rather than as an error. It is why PR-022a's five-turn
tests still pass unchanged with compaction enabled by default.

### PR-023 — Safe session persistence — **LANDED**

- ✅ The core question is answered and the mechanism is built and tested.
- ⚠️ **Size S → M**, for two reasons: (a) with `AgentHarness` unavailable,
  PR-023 owns the whole `Agent ↔ Session` bridge including restore-on-launch and
  the `toDurablePayload` trap (§3.3); (b) the SQLite backend has a writer lease
  (30 s TTL, 10 s heartbeat) and `close()`/`asyncDispose` that the Electron main
  process lifecycle must respect, or a crashed run will hold a stale claim.
- The "assertions preventing image bytes from reaching disk" task is satisfied
  by `packages/agent/test/persistence.test.ts`; extend it rather than rewrite.

What landed, and the three things it found that were not in this document:

| File | What it is |
| --- | --- |
| `packages/agent/src/conversation-store.ts` | `ConversationStore` — one conversation's durable state. Sanitising transcript sink, compaction snapshot, restore, clear. Backend-agnostic: it talks to a Pi `Session`. |
| `packages/agent/src/session-backends.ts` | `openConversationStore({ conversationId, directory, backend, writerLease })` for both backends, the writer-lease numbers as code, and `WriterLeaseHeldError`. |
| `packages/agent/test/conversation-store.test.ts` | 27 tests, both backends, real temp directories, real bytes. |
| `packages/agent/test/session-restore.test.ts` | Restart mid-conversation, both backends; clear conversation; the follow-up-8 comparison. |
| `packages/agent/demo/persistence-demo.mjs` | The runnable proof; greps the files. |

1. **`appendCustomEntry` runs the same validator as `appendMessage`** — the
   summary snapshot needs `toDurableJson` for exactly the §3.3 reason, and its
   payload is serialized verbatim too, so the summary has to be text-only for
   the same reason the transcript does. Both are now asserted in
   `persistence.test.ts`.
2. **`findEntries()` defaults to `newestFirst`** on the SQLite backend
   (`storage/entries.js`). Transcript order has to be asked for:
   `findEntries({ order: 'oldestFirst' })`.
3. **A `VACUUM` in WAL mode does not shrink the file.** The rebuilt pages go to
   the `-wal` and the main file keeps its old length, so a cleared
   conversation's text is still readable past the logical end of the database —
   `grep` finds it. `clear()` therefore switches to `journal_mode=DELETE`
   first, where `VACUUM` truncates. The backend restores WAL mode itself on the
   next open. Measured in the demo, §6.

Also worth recording: a repository whose `open()` fails on the lease still owns
an open SQLite handle. Left unclosed it turns "another writer has it" into
`database is locked` for every later operation on that file, so the failure
path closes it before rethrowing.

### Runbook amendment 2 (dev model profile for PR-029…036)

Still correct in shape, and now cheap: §9.2 gives the exact profile and the
exact commands. Note that **PR-029…PR-036 can be developed against the faux
provider with no key at all** — `fauxProvider()` produces a fully-typed
`Models` collection. A real key is only needed to validate real provider
behaviour (streaming quirks, image handling, tool-call formats).

### Runbook amendment 3 (Codex fallback)

**Not needed.** Codex subscription auth *is* supported in the pinned release
(§9.1). The amendment can be closed, replaced by the concrete verification steps
in §9.1. The residual risk is not "unsupported" but "we have not signed in
once".

### Runbook §7 known facts

Amend the package triple per §1.1.

---

## 9. Part B — blocked on the user

Nothing in this section was attempted: this environment has no usable model API
key, and `ANTHROPIC_BASE_URL` points at the Claude Code proxy, which is not a
general-purpose credential.

### 9.1 Codex subscription authentication — SUPPORTED in 0.84.1, sign-in not attempted

Read from `pi-ai/dist/providers/openai-codex.js` and
`pi-ai/dist/auth/oauth/openai-codex.js`.

- Provider `openai-codex`, base URL `https://chatgpt.com/backend-api`,
  API `openai-codex-responses`.
- `auth.oauth` with **`isSubscription: true`** and display name
  `"OpenAI (ChatGPT Plus/Pro)"`.
- **Two login methods**, offered via a `select` prompt:
  - `browser` — PKCE authorize at `https://auth.openai.com/oauth/authorize`,
    with a local callback server **bound to port 1455** on `127.0.0.1`
    (override the host with `PI_OAUTH_CALLBACK_HOST`). Pi does **not** open the
    browser; it emits an `auth_url` event and the app must open it. A
    `manual_code` prompt races the callback server, so pasting the redirect URL
    also works.
  - `device_code` — headless; emits a `device_code` event with a user code and
    `https://auth.openai.com/codex/device`, 15-minute timeout.
- Credential is `{ type:"oauth", access, refresh, expires, accountId }`;
  `accountId` is decoded from the `https://api.openai.com/auth` JWT claim and
  login **fails** if it is absent. `toAuth()` sends the access token as the API
  key. Refresh is automatic under the credential-store lock.
- Vision: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna` all report
  `input: ["text","image"]` (272k context). `gpt-5.3-codex-spark` is
  **text-only** — do not offer it for a visual conversation.

**Implications for PR-037 and for Electron:** port 1455 must be free and the
main process must open the system browser itself. The device-code path is the
safer default inside a packaged app.

**What the user must do (~5 min, on the Mac):**

```sh
# Fastest smoke test, before any Pilot UI exists:
pnpm dlx @earendil-works/pi-ai@0.84.1 --help      # the package ships a `pi-ai` CLI
```

Then, once PR-020's auth facade exists, drive
`models.login('openai-codex', 'oauth', interaction)` and confirm a credential is
stored. Record whether the browser or device-code flow was used.

### 9.2 One API-key model — configuration recorded, not run

Anthropic is the cheapest thing to verify because the provider resolves
`ANTHROPIC_API_KEY` from the environment with no extra wiring
(`pi-ai/dist/providers/anthropic.js`, `anthropicApiKeyAuth().resolve`).

```ts
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel('anthropic', 'claude-sonnet-4-6'); // pick from getModels()
```

Resolution order for the key: stored credential → `ANTHROPIC_AUTH_TOKEN`
(sent as `Authorization: Bearer`) → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`.

**Exact commands for the user (~5 min, any machine with a key):**

```sh
cd <pilot repo>
export ANTHROPIC_API_KEY=sk-ant-...        # never commit this
pnpm build
node -e '
const { createModels } = await import("@earendil-works/pi-ai");
const { anthropicProvider } = await import("@earendil-works/pi-ai/providers/anthropic");
const models = createModels();
models.setProvider(anthropicProvider());
console.log("auth:", await models.checkAuth("anthropic"));
const vision = models.getModels("anthropic").filter(m => m.input.includes("image"));
console.log("vision models:", vision.map(m => m.id).join(", "));
const model = vision[0];
const answer = await models.completeSimple(model, {
  messages: [{ role: "user", content: [
    { type: "text", text: "Reply with the single word OK." }
  ], timestamp: Date.now() }],
});
console.log("reply:", JSON.stringify(answer.content), answer.stopReason);
'
```

Expected: `auth: { type: "api_key", source: "ANTHROPIC_API_KEY" }`, a non-empty
vision model list, and `reply: [{"type":"text","text":"OK"}] stop`.

Then repeat with a tool call and an image tool result — the highest-value check,
because that is the one path the faux provider cannot validate:

```sh
node -e '
/* same setup, then: */
const answer = await models.completeSimple(model, {
  messages: [{ role: "user", content: [
    { type: "text", text: "What colour is this image? Use the look tool first." }
  ], timestamp: Date.now() }],
  tools: [{ name: "look", description: "look at the screen",
            parameters: { type: "object", properties: {}, additionalProperties: false } }],
});
console.log(JSON.stringify(answer.content, null, 2), answer.stopReason);
'
```

Expected `stopReason: "toolUse"` with a `toolCall` block. Record the result here.

### 9.3 One local OpenAI-compatible endpoint — configuration recorded, not run

Pattern from `pi-ai/README.md` §"Custom Providers", verbatim shape:

```ts
import { createModels, createProvider, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const localModel: Model<'openai-completions'> = {
  id: 'qwen2.5-vl-7b',
  name: 'Qwen2.5-VL 7B (local)',
  api: 'openai-completions',
  provider: 'local',
  baseUrl: 'http://localhost:11434/v1',   // Ollama; LM Studio is :1234/v1
  reasoning: false,
  input: ['text', 'image'],               // MUST list "image" or Pilot's gate rejects it
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 4096,
  // Ollama/vLLM/SGLang do not understand the `developer` role or
  // `reasoning_effort`; pi-ai's README calls this out explicitly.
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
};

const local = createProvider({
  id: 'local',
  name: 'Local',
  baseUrl: 'http://localhost:11434/v1',
  // Keyless local servers still declare auth; resolving to {} means "configured".
  auth: { apiKey: { name: 'Local', resolve: async () => ({ auth: {} }) } },
  models: [localModel],
  api: openAICompletionsApi(),
});
```

`isLoopbackBaseUrl()` in `packages/agent/src/model-profile.ts` maps this to
`ModelProfile.isRemote === false`, which is what the privacy UI keys off.

**Exact commands for the user (~5 min, on the Mac):**

```sh
ollama serve &
ollama pull qwen2.5vl:7b            # or any vision model you already have
curl -s http://localhost:11434/v1/models | head   # confirm the OpenAI-compatible shim
# then run the snippet above with models.completeSimple(...) as in §9.2
```

Record: the model id string Ollama reports, whether images were actually
interpreted (not silently ignored), and whether tool calls work — small local
models frequently do not emit them, which would make
`ModelProfile.supportsTools = false` a real case rather than a theoretical one.

---

## 10. How to reproduce everything here

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test          # all Pi findings are asserted here; no network, no credentials
pnpm build
node packages/agent/demo/observe-screen-demo.mjs
```

The demo prints the Pilot event stream for a full `observe_screen` round trip
against the faux provider, then the retention check:

```
--- Pilot agent events ---
  run-started
  tool-started observe_screen
  [screen] observe({"view":"pointer","moment":"question"})
  tool-succeeded observe_screen
  text-delta "That switch "
  …
  run-completed "That switch turns on automatic renewal for your plan."

--- Retention check ---
  image bytes in live model context : true
  image bytes anywhere on disk      : false
```

---

## 11. Open questions and residual uncertainty

Recorded honestly rather than guessed:

1. **Steer interleaving** (§2.5). The transcript position of a steered message
   relative to the in-flight assistant turn was not pinned down. PR-027 should
   assert on behaviour, not on message indices.
2. **`AgentHarness` timeline.** It may land in 0.85.x, which would make a chunk
   of PR-022/PR-023 redundant. Worth re-checking upstream before starting
   PR-022. Do not design *toward* it.
3. **Compaction quality.** ~~`compact()` needs a live provider, so the summary
   quality requirement from §11 ("must not claim that an old screen description
   remains current") is untested.~~ **Closed by PR-022b, by not using
   `compact()`.** Pilot's summariser is *extractive*: every line is quoted or
   derived from the transcript, so there is no provider call, no cost, and
   nothing that can invent a screen it never saw. The §11 truthfulness
   requirement is therefore a property of Pilot's own rendering and is asserted
   by test rather than hoped for. The residual question is a different, smaller
   one: whether an extractive summary is *rich* enough for a long conversation
   compared with a generative one. A model-backed summariser can be swapped in
   later — `buildCompactionSummary` is a pure function of a typed input — but it
   would have to clear the same truthfulness bar, and a generative summariser
   can silently fail it.
4. **Real provider image handling.** The faux provider does not exercise
   provider-side image encoding. Anthropic, OpenAI Responses and
   OpenAI-compatible servers each transform `ImageContent` differently; only a
   live run proves the double-JPEG legibility risk from `dp/m1.md`.
5. **Electron bundling.** `pi-ai` pulls `@anthropic-ai/sdk`,
   `@aws-sdk/client-bedrock-runtime`, `@google/genai`, `@mistralai/mistralai`
   and `openai` as hard dependencies (~96 packages added to the tree). Provider
   modules are lazily imported, so tree-shaking *should* work, but this is
   unproven inside electron-builder and is a real risk for PR-042 bundle size.
   `pi-ai`'s README has a "Bundling and Tree Shaking" section to follow.
6. **`node:sqlite`.** The SQLite backend uses Node's built-in
   `node:sqlite` (`DatabaseSync`). It works on Node 24.19 here, and needs no
   native module — good news versus a `better-sqlite3` prebuild, but confirm it
   is available in Electron's bundled Node.
