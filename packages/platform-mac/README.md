# @pilot/platform-mac

macOS platform package. **PR-003 delivers the transport only**: the framed
stdio protocol shared with the embedded Swift helper, and the supervision that
keeps that helper alive. No ScreenCaptureKit, no Accessibility, no permissions
— PR-011 onward owns those and builds on top of what is here.

The helper is started by Pilot and is not a user-managed service
(`docs/system-design.md` §4). Its IPC is typed, length-bounded and restricted
to explicit operations.

```text
src/protocol/frame.ts        length-prefixed binary framing
src/protocol/messages.ts     JSON message envelopes (request/response/event)
src/protocol/operations.ts   the closed operation set: health, echo
src/transport/channel.ts     framing bound to a pair of streams
src/transport/helper-transport.ts  spawn, restart, correlation, deadlines
src/helper-binary.ts         where the helper executable lives
native/                      SwiftPM package producing `PilotHelper`
test/support/helper-stub.ts  Node stand-in that speaks the same protocol
test/demo.ts                 the PR-003 demo
```

## Wire format

Version **1**. A frame is a fixed 16-byte header followed by two
length-prefixed bodies: a UTF-8 JSON message and an opaque binary payload. The
binary body exists from day one so PR-012 (capture frames) and PR-014 (audio)
can attach bytes without a second protocol or a base64 detour through JSON.

```text
offset  size  field
     0     4  magic, ASCII "PILT"
     4     1  protocolVersion (uint8) = 1
     5     1  flags (uint8) — reserved, must be 0
     6     2  reserved (uint16 big-endian) — must be 0
     8     4  messageLength (uint32 big-endian), UTF-8 JSON, must be > 0
    12     4  binaryLength (uint32 big-endian), may be 0
    16     …  message bytes, then binary bytes
```

All multi-byte integers are big-endian (network order), so Swift and TypeScript
agree without negotiating endianness.

| Limit | Value | Constant |
| --- | ---: | --- |
| JSON message body | 1 MiB (1 048 576 B) | `MAX_FRAME_MESSAGE_BYTES` |
| Binary body | 32 MiB (33 554 432 B) | `MAX_FRAME_BINARY_BYTES` |
| Whole frame | header + both ceilings | `MAX_FRAME_BYTES` |
| Operation name | 64 chars, `^[a-z][a-z0-9]*([.-][a-z0-9]+)*$` | `HELPER_OP_NAME_MAX_LENGTH` |

The message ceiling matches `MAX_IPC_MESSAGE_BYTES` in `@pilot/shared`, so a
payload that can cross the renderer boundary can also cross the helper
boundary. Both ceilings are enforced **from the header alone**, before any body
byte is buffered.

The message body mirrors `@pilot/shared`'s renderer IPC envelopes, with `op`
in place of `channel`:

```jsonc
{ "kind": "request",  "protocolVersion": 1, "id": "req-…", "op": "echo", "issuedAt": 0, "payload": {} }
{ "kind": "response", "protocolVersion": 1, "id": "req-…", "op": "echo", "issuedAt": 0, "ok": true,  "payload": {} }
{ "kind": "response", "protocolVersion": 1, "id": "req-…", "op": "echo", "issuedAt": 0, "ok": false, "error": { /* SerializedPilotError */ } }
{ "kind": "event",    "protocolVersion": 1, "id": "evt-…", "op": "helper.ready", "issuedAt": 0, "payload": {} }
```

Binary never appears in the JSON. It rides in the frame's second body, so
message metadata stays printable and log-safe.

### Operations (PR-003)

| Operation | Request | Response | Binary |
| --- | --- | --- | --- |
| `health` | `{}` | `{ status, helperVersion, protocolVersion, pid, uptimeMs }` | none |
| `echo` | `{ text }` | `{ text, binaryLength }` | request and response |

`health` doubles as the startup handshake: `start()` does not resolve until the
helper answers it.

### Extending it (PR-011 onward)

Append to `HELPER_OPERATIONS` in `src/protocol/operations.ts` and to
`HelperProtocol.Operation` in `native/Sources/PilotHelperCore/HelperProtocol.swift`.
Bump `HELPER_PROTOCOL_VERSION` (and `FrameConstants.protocolVersion`) only for
a change that is not backwards compatible; both sides reject a version they do
not know with `protocol-version-mismatch`.

## Failure modes

Nothing hangs and nothing is dropped silently. Every failure is a typed
`PilotError`:

| Failure | Code |
| --- | --- |
| helper executable missing, spawn failed | `helper-unavailable` |
| helper exits with work in flight | `helper-unavailable` |
| helper never answers the startup probe | `helper-unavailable` |
| restart budget exhausted | `helper-unavailable` (terminal, state `failed`) |
| helper never answers a request | `timeout` |
| caller aborts | `cancelled` |
| malformed header, bad magic, reserved bits | `invalid-request` |
| declared body over a ceiling | `payload-too-large` |
| unknown frame/message version | `protocol-version-mismatch` |
| response for an id nobody is waiting on | `invalid-request`, emitted as `protocol-error` |
| response for the wrong operation, or failing its schema | `invalid-request` |

Restarts use exponential backoff (250 ms × 2ⁿ, capped at 5 s) with a budget of
5 restarts per 60 s window; exceeding it puts the transport in `failed` and
every later request rejects immediately. A framing failure is fatal for the
connection: the byte stream is no longer known to be frame-aligned, so the
helper is killed and restarted rather than resynchronised on a guess.

Frame bodies are never logged. Only operation names, request ids, state and
byte counts reach the logger, which additionally redacts anything
binary-shaped.

## Verification

### On Linux (everything except the Swift build)

From the repository root:

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The host-side tests run against `test/support/helper-stub.ts`, a Node process
that speaks the identical framed protocol. It imports nothing from `src/`, so
it is a genuinely independent implementation of the wire format — a codec that
only agrees with itself cannot pass. It covers framing, oversized input,
malformed headers, request correlation, timeouts, aborts, crash reporting,
restart with backoff, restart-budget exhaustion and shutdown escalation.

Demo (requires `pnpm build` first, because it runs against `dist/`):

```sh
pnpm --filter @pilot/platform-mac demo
```

It prints the health handshake, a typed echo, a 256 KiB binary fixture round
trip verified by SHA-256, the explicit failure states, and a crash → crash
report → restart cycle.

### On the Mac (Swift, batched per runbook §2)

The Swift toolchain does not exist on the Linux development machine, so
`native/` has never been compiled. These are the steps to run:

```sh
cd packages/platform-mac

# 1. Build the helper (Xcode command line tools, Swift 5.9+, macOS 13+).
swift build --package-path native            # debug
swift build --package-path native -c release # release

# 2. Run the Swift unit tests (frame codec + server behaviour).
swift test --package-path native

# 3. Run the same demo against the real helper instead of the Node stub.
cd ../..
pnpm build
pnpm --filter @pilot/platform-mac demo
```

Step 3 needs no configuration: `resolveHelperBinary()` finds
`native/.build/debug/PilotHelper` on its own. Set `PILOT_HELPER_BINARY` to
point somewhere else, or `--configuration release` output. The demo prints
which target it chose on its first line; if it says "Node stub", the Swift
build did not land where it was expected.

Expected results: `swift build` produces `native/.build/debug/PilotHelper`;
`swift test` passes; the demo's sections 1–4 and 6 behave exactly as they do
against the stub (section 5 is skipped — the Swift helper has no crash-on-demand
operation).

If `swift build` fails, that is a PR-003 defect: report the compiler output.
Nothing in `native/` depends on ScreenCaptureKit, Accessibility or any
entitlement, so no TCC prompt should appear.
