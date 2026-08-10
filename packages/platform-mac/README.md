# @pilot/platform-mac

macOS platform package.

- **PR-003** delivered the transport: the framed stdio protocol shared with the
  embedded Swift helper, and the supervision that keeps that helper alive.
- **PR-011** adds the first two adapters on top of it: permissions — including
  parent-bundle attribution validation — and window enumeration with lifecycle
  events.

Capture (PR-012), Accessibility grounding (PR-013), speech (PR-014) and
push-to-talk (PR-015) come next.

> **Nothing under `native/` has ever been compiled.** There is no Swift
> toolchain and no Mac on the development machine (`docs/runbook.md` amendment
> 8). Everything on the TypeScript side runs against a Node stub; the Swift
> side is written unverified and batched for the Mac. See
> [Verification](#verification) for exactly what that leaves unproven.

The helper is started by Pilot and is not a user-managed service
(`docs/system-design.md` §4). Its IPC is typed, length-bounded and restricted
to explicit operations.

```text
src/protocol/frame.ts              length-prefixed binary framing
src/protocol/messages.ts           JSON message envelopes (request/response/event)
src/protocol/operation-kit.ts      the operation type and its constructor
src/protocol/operations.ts         the closed operation set
src/protocol/permission-ops.ts     permission operations and their schemas
src/protocol/window-ops.ts         window operations and their schemas
src/transport/channel.ts           framing bound to a pair of streams
src/transport/helper-transport.ts  spawn, restart, correlation, deadlines
src/permissions/attribution.ts     the attribution verdict table
src/permissions/mac-permission-adapter.ts
src/windows/window-model.ts        stable window ids and domain mapping
src/windows/window-diff.ts         lifecycle events, by snapshot diff
src/windows/mac-window-adapter.ts
src/polling.ts                     subscription-driven poller
src/helper-binary.ts               where the helper executable lives
native/                            SwiftPM package producing `PilotHelper`
test/support/helper-stub.ts        Node stand-in that speaks the same protocol
test/demo.ts                       the PR-003 demo
test/demo-permissions.ts           the PR-011 demo
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

### Operations

| Operation | Request | Response | Binary | PR |
| --- | --- | --- | --- | --- |
| `health` | `{}` | `{ status, helperVersion, protocolVersion, pid, uptimeMs }` | none | 003 |
| `echo` | `{ text }` | `{ text, binaryLength }` | request and response | 003 |
| `permissions.status` | `{ kind }` | `{ probe }` | none | 011 |
| `permissions.snapshot` | `{}` | `{ probes[4] }` | none | 011 |
| `permissions.request` | `{ kind }` | `{ probe, prompted }` | none | 011 |
| `permissions.open-settings` | `{ kind }` | `{ opened, target }` | none | 011 |
| `permissions.attribution` | `{ expected }` | `{ evidence }` | none | 011 |
| `windows.list` | `{ includeAllLayers? }` | `{ windows, displays, screenLocked, titlesWithheld, capturedAt }` | none | 011 |
| `windows.get` | `{ windowNumber }` | `{ window, display, screenLocked }` | none | 011 |

`health` doubles as the startup handshake: `start()` does not resolve until the
helper answers it.

PR-011 did **not** bump `HELPER_PROTOCOL_VERSION`. Appending operations is
backwards compatible in both directions: an unknown operation is already a
typed `invalid-request` on the helper, and an unregistered response is already
a typed `invalid-request` on the host.

## Permissions

### The four states stay four states

`unknown`, `denied`, `restricted` and `granted` mean different things and drive
different UI, so none is allowed to collapse into another. The awkward part is
that macOS does not report them uniformly:

| Permission | API | States it can express |
| --- | --- | --- |
| Screen Recording | `CGPreflightScreenCaptureAccess` | granted / not-granted (a `Bool`) |
| Accessibility | `AXIsProcessTrusted` | granted / not-granted (a `Bool`) |
| Microphone | `AVCaptureDevice.authorizationStatus` | all four |
| Speech Recognition | `SFSpeechRecognizer.authorizationStatus` | all four |

The two boolean APIs cannot distinguish "the user refused" from "nobody has
asked yet", and cannot express `restricted` at all. So `false` from them is
reported as **`unknown`, never `denied`**, until this process has actually
raised the prompt and still been refused — the one moment the distinction
becomes observable. `restrictedRepresentable: false` on the wire records that
`restricted` is unreachable through that API rather than merely absent.

The two authorization enums also disagree on their raw values (`1` is
`restricted` for AVFoundation and `denied` for Speech), which is why they get
one mapper each and both are unit-tested in Swift.

`requiresRelaunch: true` on Screen Recording records that macOS keeps handing
the old answer to an already-running process after the user grants it.

`permissions.request` returns as soon as the prompt is raised, **not** when the
user answers. The helper's stdio loop is single-threaded; blocking it on a
dialog would stall `health` and the supervisor would eventually kill the helper
mid-prompt. The resulting state arrives through polling.

#### Info.plist hazard

macOS **kills** a process that requests Microphone or Speech Recognition
without `NSMicrophoneUsageDescription` / `NSSpeechRecognitionUsageDescription`
in the responsible process's `Info.plist`. Both keys are already declared for
the packaged app in `apps/desktop/electron-builder.yml` (`extendInfo`), so a
packaged run is covered.

The helper itself is a bare executable with no `Info.plist`, so it survives
that request only if macOS is attributing it to the parent bundle — the very
question this PR is about. Which makes the crash a diagnostic:

> If requesting Microphone or Speech Recognition kills the helper, TCC is
> reading the helper's own (non-existent) `Info.plist` and attribution is
> wrong, regardless of what the verdict says.

It degrades safely — the supervisor rejects the in-flight request with
`helper-unavailable`, files a crash report and restarts — but expect it when
running `demo:permissions` straight out of `.build/debug`.

### Parent-bundle attribution

The top structural risk in the MVP plan (`docs/runbook.md` §7). Pilot is an
app bundle that spawns a helper; whether a grant the user gives *Pilot* reaches
the *helper* depends on which process macOS holds responsible for it. If it
holds the helper responsible, the user grants the permission, Pilot reports
`granted`, and capture returns nothing — a permission state that reads correct
while being wrong.

`MacPermissionAdapter` establishes the answer before reporting any status. The
helper reports facts only; the verdict is computed host-side in
`src/permissions/attribution.ts`, so it can be tested on Linux.

| Verdict | Confidence | Established by |
| --- | --- | --- |
| `matched` | `direct` | responsible process is the host pid |
| `helper-attributed` | `direct` | responsible process is the helper pid |
| `bundle-mismatch` | `direct` | responsible process is some third process |
| `helper-attributed` | `inferred` | helper carries its own bundle identifier |
| `bundle-mismatch` | `inferred` | helper is inside a different `.app` |
| `matched` | `inferred` | bare helper inside the expected `.app` |
| `unknown` | `none` | helper is inside no `.app` (the development layout) |

`direct` comes from `responsibility_get_pid_responsible_for_pid`, resolved by
`dlsym` because it is SPI. When the symbol is missing the verdict degrades to
`inferred` — never to a guess and never to a crash.

**`unknown` is not a pass.** It is also not a failure: running the helper out
of `.build/debug` produces it, and refusing to operate then would make the
package undevelopable.

Under the default `enforce` policy, a failing verdict makes `status()`,
`snapshot()` and `request()` throw `permission-attribution-mismatch` rather
than return states that would be lies. `openSettings()` keeps working — the one
action that might help must not be blocked. `attribution()` always returns the
report so it can be diagnosed. `warn` and `off` policies exist for tests and
for a deliberate operator override.

## Windows

### What a `WindowId` guarantees

`WindowId = "mac-window-" + CGWindowID`, and nothing else feeds it — no
counter, no array index, no session nonce, no clock. This matters because
`ObservationCore.ingestFrame` (PR-004) drops any frame whose `windowId` is not
exactly the selected window's, so an id that drifts does not raise an error,
it produces silence.

| Event | Does the id change? |
| --- | --- |
| Retitled, moved, resized, minimised, hidden | **No** |
| Moved to another display or Space | **No** |
| Helper crashes and is restarted | **No** |
| Pilot relaunched | **No** |
| Owning application quits and reopens | Yes — a new window |
| Window closed, another opened | Yes — a new window |

The restart row is the one PR-012 depends on: the new helper process
re-derives every id from the same `CGWindowID`s, so an in-flight observation
keeps ingesting across a supervisor restart.

`CGWindowID`s can be recycled by the window server after a window is
destroyed, so `ownerPid` travels alongside and the diff treats "same id,
different owner" as a close followed by an appearance — never as a change. A
recycled id therefore cannot be inherited by a live selection without a
`window-closed` being delivered first.

### Lifecycle events

The helper answers `windows.list` with a snapshot and forgets. Everything about
appeared / closed / retitled / moved / resized is derived host-side by
comparing consecutive snapshots (`src/windows/window-diff.ts`).

Helper-side events would need a background thread writing frames concurrently
with the request loop — a write lock and a second failure surface, in Swift
that cannot be compiled here. Snapshot diffing puts every lifecycle rule in
TypeScript where the tests actually execute.

Within one tick the order is: lock/unlock, then `window-closed` per closure,
then one `window-list-changed` carrying `appeared`/`disappeared`, then
`window-changed` per mutation. Closures come first so a consumer that tears
down on `window-closed` (system-design §16) has stopped before it hears about
whatever replaced the window.

Polling runs only while something is subscribed, and the adapter forces a tick
when the transport returns to `ready` after a restart rather than waiting out
the interval.

`windows.list` uses `CGWindowListCopyWindowInfo`, not `SCShareableContent`: it
is synchronous, needs no concurrency, and degrades observably — macOS withholds
`kCGWindowName` without a Screen Recording grant, so `titlesWithheld` is an
independent cross-check on the TCC probe. PR-012 needs `SCShareableContent` for
capture filters regardless.

### Extending it (PR-012 onward)

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
| macOS credits permissions to the helper or another bundle | `permission-attribution-mismatch` (PR-011) |
| System Settings could not be opened | `platform-unavailable` (PR-011) |
| helper omits a permission from its snapshot | `invalid-request` (PR-011) |

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
restart with backoff, restart-budget exhaustion and shutdown escalation, plus
(PR-011) all four permissions in all four states, every attribution verdict,
window enumeration, the lifecycle diff and the failure paths of both adapters.

Demos (require `pnpm build` first, because they run against `dist/`):

```sh
pnpm --filter @pilot/platform-mac demo               # PR-003 transport
pnpm --filter @pilot/platform-mac demo:permissions   # PR-011 permissions and windows
```

The first prints the health handshake, a typed echo, a 256 KiB binary fixture
round trip verified by SHA-256, the explicit failure states, and a crash →
crash report → restart cycle.

The second prints the four permissions in each of the four states, the
attribution verdict, the whole verdict table evaluated on synthetic evidence,
the enumerated windows with geometry, and a scripted lifecycle sequence
(retitle → move+resize → close → screen lock). Both print which target they
selected on their first line; if it says "Node stub", the Swift build did not
land where it was expected.

### What is *not* verified anywhere

Stated plainly, because none of it has run:

- `native/` has never been compiled. Not once, not partially.
- No TCC API has been called. `CGPreflightScreenCaptureAccess`,
  `AXIsProcessTrusted`, `AVCaptureDevice.authorizationStatus`,
  `SFSpeechRecognizer.authorizationStatus` and all four request calls are
  unexercised.
- No permission dialog has been raised or dismissed.
- No window has been enumerated. `CGWindowListCopyWindowInfo`,
  `CGGetActiveDisplayList`, `CGDisplayCopyDisplayMode`,
  `CGSessionCopyCurrentDictionary` and `NSRunningApplication` are unexercised.
- The `responsibility_get_pid_responsible_for_pid` lookup has never resolved.
  Whether the symbol exists on macOS 13+ at all is unconfirmed; the code
  degrades to `inferred` if it does not.
- **The real attribution verdict is unknown.** The verdict *logic* is fully
  tested; which branch a real Mac takes is exactly the open question.
- Whether macOS withholds window titles the way `titlesWithheld` assumes.
- Whether the `/usr/bin/open` settings URLs land on the right panes.

The Swift that *is* covered by `swift test` is the pure logic: the permission
state mappers, the settings-URL table, the bundle-path walk, the
`CGWindowListCopyWindowInfo` dictionary parser, display assignment, JSON
serialisation, and every PR-011 operation dispatched through `HelperServer`
with stub services.

### On the Mac (Swift, batched per runbook §2)

The Swift toolchain does not exist on the Linux development machine, so
`native/` has never been compiled. These are the steps to run:

```sh
cd packages/platform-mac

# 1. Build the helper (Xcode command line tools, Swift 5.9+, macOS 13+).
swift build --package-path native            # debug
swift build --package-path native -c release # release

# 2. Run the Swift unit tests (frame codec, server behaviour, PR-011 pure logic).
swift test --package-path native

# 3. Run both demos against the real helper instead of the Node stub.
cd ../..
pnpm build
pnpm --filter @pilot/platform-mac demo
pnpm --filter @pilot/platform-mac demo:permissions
```

Step 3 needs no configuration: `resolveHelperBinary()` finds
`native/.build/debug/PilotHelper` on its own. Set `PILOT_HELPER_BINARY` to
point somewhere else, or `--configuration release` output. Both demos print
which target they chose on their first line; if it says "Node stub", the Swift
build did not land where it was expected.

Expected results: `swift build` produces `native/.build/debug/PilotHelper`;
`swift test` passes; `demo`'s sections 1–4 and 6 behave exactly as they do
against the stub (section 5 is skipped — the Swift helper has no crash-on-demand
operation).

A `swift build` failure in PR-003 code is a PR-003 defect; in the files below
it is a PR-011 defect. Either way, report the compiler output rather than
working around it. New in PR-011, and therefore new compile risk:

```text
Sources/PilotHelperCore/PermissionModel.swift    pure — Foundation only
Sources/PilotHelperCore/Attribution.swift        pure — Foundation only
Sources/PilotHelperCore/WindowModel.swift        pure — Foundation only
Sources/PilotHelperCore/PermissionProbes.swift   AVFoundation, Speech, ApplicationServices, CoreGraphics, Darwin
Sources/PilotHelperCore/WindowEnumerator.swift   CoreGraphics, AppKit
```

The three pure files are the ones the tests cover; the two framework files are
the risk. `PermissionProbes.swift` uses `dlsym` for
`responsibility_get_pid_responsible_for_pid`, which is SPI — if it does not
resolve, attribution reports `inferred` rather than failing.

### What `demo:permissions` will now raise on a Mac

Unlike the PR-003 batch, **this one does touch TCC**. Running it will prompt.
That is the point: it is the first time anything in Pilot asks macOS for a
permission, and the first observation of the attribution risk.

Watch for, in order:

1. `verdict=` in section 2. Running out of `.build/debug` this should read
   `unknown (none)` — the helper is not inside an `.app`. That is expected and
   is not the answer that matters.
2. The real answer needs a **packaged bundle** (PR-042). Run
   `demo:permissions` with `PILOT_HELPER_BINARY` pointing at the helper inside
   a built `.app`, and check whether the verdict is `matched (direct)`.
3. Section 4: whether window titles appear at all. If every title reads
   "(title unavailable — Screen Recording not granted)" while the permission
   probe says `granted`, that is the attribution bug showing itself from the
   other side.
4. Whether System Settings shows one entry named Pilot or a second one named
   `PilotHelper`. A second entry is the failure, visible without any code.
