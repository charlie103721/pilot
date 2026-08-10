# @pilot/platform-mac

macOS platform package.

- **PR-003** delivered the transport: the framed stdio protocol shared with the
  embedded Swift helper, and the supervision that keeps that helper alive.
- **PR-011** adds the first two adapters on top of it: permissions — including
  parent-bundle attribution validation — and window enumeration with lifecycle
  events.
- **PR-013** adds the third: pointer sampling at ~30 Hz with coalescing,
  normalised window geometry, Accessibility hit testing, the secure-field flag
  and the outside-window rule.

Capture (PR-012), speech (PR-014) and push-to-talk (PR-015) come next.
- **PR-014** adds speech: Apple Speech transcription with an on-device
  preference and a renderable privacy disclosure, and `AVSpeechSynthesizer`
  playback with prompt interruption.

Capture (PR-012), Accessibility grounding (PR-013) and push-to-talk (PR-015)
come next.

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
src/protocol/speech-ops.ts         speech operations and their schemas
src/protocol/window-ops.ts         window operations and their schemas
src/protocol/accessibility-ops.ts  pointer and accessibility operations
src/transport/channel.ts           framing bound to a pair of streams
src/transport/helper-transport.ts  spawn, restart, correlation, deadlines
src/permissions/attribution.ts     the attribution verdict table
src/permissions/mac-permission-adapter.ts
src/speech/disclosure.ts           the on-device decision and its disclosure
src/speech/errors.ts               typed errors for every speech failure
src/speech/mac-speech-input-adapter.ts
src/speech/mac-speech-output-adapter.ts
src/windows/window-model.ts        stable window ids and domain mapping
src/windows/window-diff.ts         lifecycle events, by snapshot diff
src/windows/mac-window-adapter.ts
src/accessibility/pointer-grounding.ts   the three grounding rules, pure
src/accessibility/pointer-sampler.ts     ~30 Hz sampling with coalescing
src/accessibility/mac-accessibility-adapter.ts
src/polling.ts                     subscription-driven poller
src/helper-binary.ts               where the helper executable lives
native/                            SwiftPM package producing `PilotHelper`
test/support/helper-stub.ts        Node stand-in that speaks the same protocol
test/demo.ts                       the PR-003 demo
test/demo-permissions.ts           the PR-011 demo
test/demo-accessibility.ts         the PR-013 demo
test/demo-speech.ts                the PR-014 demo
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
| `accessibility.sample` | `{ includeElement?, ownerPid?, includeValue? }` | `{ point, pointerSource, sampledAt, axTrusted, element, outcome }` | none | 013 |
| `accessibility.element-at` | `{ point, ownerPid?, includeValue? }` | `{ axTrusted, element, outcome }` | none | 013 |
| `speech.input.availability` | `{ locale? }` | `{ facts, microphone, speechRecognition }` | none | 014 |
| `speech.input.start` | `{ utteranceId, onDevice, locale? }` | `{ started, onDevice, locale }` | none | 014 |
| `speech.input.stop` | `{ utteranceId }` | `{ accepted }` | none | 014 |
| `speech.input.cancel` | `{ utteranceId }` | `{ accepted }` | none | 014 |
| `speech.input.poll` | `{ sinceSequence }` | `{ events, sequence, dropped, recording, activeUtteranceId }` | none | 014 |
| `speech.output.availability` | `{}` | `{ available, voices }` | none | 014 |
| `speech.output.speak` | `{ speechId, text, voice?, rate? }` | `{ accepted, queued }` | none | 014 |
| `speech.output.stop` | `{ speechId? }` | `{ stopped }` | none | 014 |
| `speech.output.poll` | `{ sinceSequence }` | `{ events, sequence, dropped, speaking, activeSpeechId }` | none | 014 |

`health` doubles as the startup handshake: `start()` does not resolve until the
helper answers it.

Neither PR-011 nor PR-013 bumped `HELPER_PROTOCOL_VERSION`. Appending operations is
Every `speech.*` row says `none` under **Binary**, and that is load-bearing
rather than incidental — see [Speech](#speech).

PR-011 and PR-014 did **not** bump `HELPER_PROTOCOL_VERSION`. Appending operations is
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

## Pointer and Accessibility grounding (PR-013)

### Normalised geometry, and why Retina and multi-display are not special cases

Every conversion goes through `@pilot/shared`'s geometry module — the one
geometry module of system-design §5. `src/accessibility/pointer-grounding.ts`
contains no arithmetic of its own.

| Fact | Consequence |
| --- | --- |
| Window bounds are display-independent **points** | A 2× display does not change the normalised pointer at all |
| `capturedPixelPoint` derives from `captureSize`, not `scaleFactor` | A policy-downscaled capture still lines up |
| Screen points are **global**, and displays left of or above the primary have negative origins | `(point − bounds.origin) / bounds.size` is already display-agnostic |

So a 1200×800 pt window on a 2× display captures at 2400×1600 px and its centre
is `0.5, 0.5` / `1200, 800 px`; a 1000×700 pt window at `x = −1600` on a 1×
display whose own origin is `−1920` normalises identically. Both are fixtures in
`test/support/harness.ts` and every geometry assertion is made against both.

### Three defences against describing a window Pilot is not observing

PR-024 fixed the contract: outside the selected window the grounding is
`pointer-outside-window` and **no element is identified**. Whatever is under the
pointer then belongs to a window Pilot has no permission to describe.

1. **The hit test is not issued.** `ground()` normalises first; when the pointer
   is outside, `accessibility.element-at` is never sent. Proved on the wire, not
   on the shape of the answer (`test/mac-accessibility-adapter.test.ts`).
2. **An element supplied anyway is discarded.** `groundPointer` drops it even
   when a caller passes one, and `buildGroundedPointer` is then called without a
   target, so `GroundedPointer` cannot carry one.
3. **A foreign element is rejected.** The helper scopes its hit test to the
   window's application (`AXUIElementCreateApplication`), and the host rejects an
   element that names a different `ownerPid` or whose frame shares no area with
   the window — so a floating palette or a notification stacked over the selected
   window yields `foreign-application`, not a description.

`groundFast()` — the one-round-trip form the sampler uses — cannot make decision
1 for the sample it is about to take, because position and hit test are atomic.
It instead carries the previous sample's side of the border: a pointer resting
outside issues no hit test at all, and the single crossing sample that does is
scoped to the selected window's own application and has its element discarded
before any consumer sees it. Question anchoring uses `ground()`, which is strict.

### The secure-field flag, and exactly what it promises

`isSecure` is **best effort** (system-design §14), and the code is arranged so
that nothing reads it as more than that:

- The wire carries a `secureBasis` — `role`, `subrole`, `ancestor` or `none` —
  so `false` reads as *"nothing macOS exposes marks this element as secure"*
  rather than as a safety claim. What is recognised is `AXSecureTextField` as a
  role, as a subrole (how AppKit and WebKit mark password inputs), or on an
  ancestor within four levels.
- **No heuristics on labels.** Guessing "Password" from a placeholder would
  create the appearance of coverage while leaving every non-English and every
  unlabelled field uncovered.
- **Element values are opt-in and off by default** (`includeElementValues`).
  Because the flag protecting a value is best effort, the default is to carry
  what an element *is*, never what it says.
- A secure value is dropped three times: the helper does not read `AXValue` at
  all for a secure element, `toAccessibilityNode` drops it, and
  `buildGroundedPointer` drops it again.
- `SECURE_FIELD_DISCLOSURE` is the exact sentence the product must show, exported
  so it is quoted rather than paraphrased.

What it does **not** cover, and no tuning would: a token pasted into a plain text
view, a secret drawn into a canvas or a PDF, an API key in a window title, a
recovery phrase in a chat transcript. Screenshots can still contain secrets
outside recognised fields.

### Sampling at ~30 Hz with coalescing

`PointerSampler` reads `MVP_SCREEN_POLICY.pointerSampleHz` (30 → 33⅓ ms) rather
than restating a literal, drives the same `Poller` the other adapters use, and
suppresses two kinds of redundancy, counted separately:

- **By interval** — at most one emission per bucket, `floor(at / interval)`.
  This is a bucket, not a gap, and it is deliberately the *same* rule
  `PointerTimeline` (PR-004) uses to decide whether an arriving sample replaces
  the last retained one, so the emitted rate and the retained rate agree.
- **By equality** — a sample in a new bucket identical to the last **emitted**
  one is not news. Comparing against the last emitted sample is what keeps a
  move-and-move-back from being swallowed.

Every timestamp comes from an injected clock and every tick from an injected
timer, so the boundary is asserted at the exact millisecond instead of raced.

### Degraded mode is real

A denied Accessibility permission is a degraded mode, not a stop (system-design
§16). The pointer comes from `CGEvent(source: nil)?.location`, which needs no
grant, so `ground()` keeps answering with a position and reports
`targetOutcome: 'accessibility-denied'`, `degraded: true`. Nothing throws — a
thrown error would stop question anchoring, and the position alone is still
grounding. `availability()` reports `pointer` and `hitTesting` separately for
exactly this reason.

### Extending it (PR-012 onward)

Append to `HELPER_OPERATIONS` in `src/protocol/operations.ts` and to
`HelperProtocol.Operation` in `native/Sources/PilotHelperCore/HelperProtocol.swift`.
Bump `HELPER_PROTOCOL_VERSION` (and `FrameConstants.protocolVersion`) only for
a change that is not backwards compatible; both sides reject a version they do
not know with `protocol-version-mismatch`.

## Speech

### Raw audio never leaves the helper process

`docs/system-design.md` §13 lists raw microphone buffers under *memory-only*
and raw audio under *never logged*. The design honours that by giving the audio
nowhere to go rather than by remembering not to move it:

| Guarantee | How it is enforced | Where it is asserted |
| --- | --- | --- |
| No audio crosses the helper boundary | every `speech.*` operation declares `requestBinary: false, responseBinary: false`, and the transport rejects a binary payload on an operation that does not accept one | `test/speech-privacy.test.ts` |
| No audio reaches disk | the Swift speech sources contain no file, `URLSession` or `AVAudioFile` API at all, and use `SFSpeechAudioBufferRecognitionRequest` rather than the URL-based request that reads audio from a file | source scan in the same test |
| Audio has exactly one destination | one `.append(buffer)` in the whole tree — the `AVAudioEngine` tap into the recognition request | source scan in the same test |
| Nothing transcript-shaped is logged | a full transcription and playback run under a logger set to `onViolation: 'throw'` | the same test |

Transcripts are treated the same way as audio. `@pilot/shared`'s logger already
redacts fields named `transcript`; the adapters simply never pass one, and log
ids, event kinds and reasons instead.

### On-device preference, and the disclosure when it cannot be honoured

`SFSpeechRecognizer` recognises speech remotely by default. When a Mac cannot
handle a locale on device, the microphone audio is uploaded to Apple and the
API says nothing about it — same transcript, no flag on the result, no
observable difference except that it stops working offline.

So Pilot does not *infer* that recognition stayed local. It **requires** it:
`requiresOnDeviceRecognition` makes recognition fail rather than fall back, and
that flag is the only guarantee macOS offers. Reading
`supportsOnDeviceRecognition` and hoping is an inference, not a guarantee, and
this package never makes it.

The helper reports facts; the host decides (`src/speech/disclosure.ts`), the
same split PR-011 used for attribution and for the same reason — the decision
is then testable on Linux:

| Recogniser | `requireOnDevice` | Outcome | `destination` | `leavesDevice` |
| --- | --- | --- | --- | --- |
| absent or offline | either | refuse | `unknown` | `false` |
| supports on device | either | record locally | `on-device` | `false` |
| no on-device support | `true` | **refuse** | `remote-service` | `true` |
| no on-device support | `false` | record, disclosed | `remote-service` | `true` |

Every row produces a `SpeechRecognitionDisclosure` (`@pilot/shared`) with a
headline, a detail and a machine-readable reason — data the renderer draws,
exactly like PR-008's permission catalogue. It reaches consumers three ways:
`availability()`, the optional `disclosure()` method on `SpeechInputAdapter`,
and `details.disclosure` on the `speech-unavailable` error raised by a refusal,
so the refusal can explain itself instead of reading as a malfunction.

`requireOnDevice` defaults to `true`, which is what PR-025's binding sends and
what PR-008's onboarding copy promises the user ("If this Mac can only
recognise speech by sending audio away, Pilot refuses and asks you to type
instead").

### Why the host polls for transcripts

Recognition is asynchronous, but the helper's stdio loop is single-threaded and
blocking. Pushing events would mean a second thread writing frames concurrently
with the request loop — a write lock and a second failure surface, in Swift
that cannot be compiled here. PR-011 declined that for window lifecycle;
PR-014 declines it for the same reason.

Callbacks therefore append to a lock-protected queue inside the helper and the
host drains it with `speech.*.poll` (60 ms while an utterance is open or
something is speaking; the poller stops when neither is true). A drain is
idempotent — it asks for everything after `sinceSequence` — so a poll lost to a
deadline is simply repeated. Overflow drops the *oldest* event and reports a
cumulative count, because the oldest entry of an overflowing queue is a stale
partial and the newest is the transcript.

The two places where latency is the requirement do not poll at all:

- **Stopping speech** (§17 budgets below 300 ms) is a request whose response
  names every utterance the synthesiser discarded, so `stopped` is emitted from
  that response. One round trip, no interval.
- **Starting recognition** returns the on-device decision in its own response.

### Teardown is idempotent on both sides

Apple Speech endpoints on its own, so a `final` routinely arrives *before*
push-to-talk is released; it can deliver a second `isFinal`; and a cancelled
task can still call its handler. PR-025's binding absorbs all of that one layer
up, but the native layer does not lean on it:

- `stop()` and `cancel()` for an utterance that is not open **resolve**; they do
  not throw. (PR-025 found the defect: a recogniser that finished early made
  `stop-listening` throw, the throw became `failure`, and an already-submitted
  question landed the user in `error`.)
- At most one terminal event per utterance reaches a caller. The adapter keeps
  a bounded ledger of ended utterances; the helper keeps its own
  (`SpeechTerminalLedger`).
- A recogniser that finalises early releases the microphone there and then,
  rather than waiting for a `stop` that may never come.
- A helper that dies with an utterance open fails that utterance immediately
  rather than leaving a caller waiting for a transcript that cannot arrive.

### One synthesis queue, one stop

`AVSpeechSynthesizer` owns its queue and offers no way to remove one entry, so
stopping any utterance flushes all of them. That is reported rather than
hidden: `stop(id)` returns every discarded id and the adapter emits `stopped`
for each, so nothing upstream waits on a chunk that will never be spoken.
Handing consecutive chunks (PR-026) to that native queue is also what keeps
sentence-to-sentence playback gapless — the host is not in the loop between
them.

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
| Microphone or Speech Recognition not granted | `permission-denied` / `permission-restricted` / `permission-unknown`, with `details.kind` (PR-014) |
| recognition would have to leave the Mac and the caller required on device | `speech-unavailable`, with `details.disclosure` (PR-014) |
| no recogniser for the locale, or the recogniser is offline | `speech-unavailable` (PR-014) |
| recognition heard nothing, lost the microphone, or failed | `speech-input-failed` (PR-014) |
| the Mac has no synthesis voice | `speech-unavailable` (PR-014) |
| synthesis failed or was lost mid-utterance | `speech-output-failed` (PR-014) |

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
window enumeration, the lifecycle diff and the failure paths of both adapters,
plus (PR-013) pointer grounding on a Retina and a negative-origin display, the
outside-window case proved at the wire, the foreign-application case, the
secure-field case, coalescing at its exact boundary and Accessibility-denied
degradation.

PR-014 extends the stub into a **scripted, deliberately misbehaving
recogniser**: it finalises before the key is released, finalises twice, calls
back after `cancel()`, attributes a result to a superseded utterance and fails
halfway through — because Apple Speech does all five. A stub that quietly
refused to reproduce them would make the host's defences untestable.

Demos (require `pnpm build` first, because they run against `dist/`):

```sh
pnpm --filter @pilot/platform-mac demo               # PR-003 transport
pnpm --filter @pilot/platform-mac demo:permissions   # PR-011 permissions and windows
pnpm --filter @pilot/platform-mac demo:accessibility # PR-013 pointer and accessibility
pnpm --filter @pilot/platform-mac demo:speech        # PR-014 speech
```

The first prints the health handshake, a typed echo, a 256 KiB binary fixture
round trip verified by SHA-256, the explicit failure states, and a crash →
crash report → restart cycle.

The second prints the four permissions in each of the four states, the
attribution verdict, the whole verdict table evaluated on synthetic evidence,
the enumerated windows with geometry, and a scripted lifecycle sequence
(retitle → move+resize → close → screen lock).

The third walks a **scripted** pointer path across a scripted 2× window and
prints, for every position, the normalised point, the captured pixel point and
exactly which target was selected or why none was — including the secure field
withholding its value, the foreign element being rejected, the outside-window
positions, and the same walk with Accessibility denied. It ends with a ~30 Hz
coalescing run and the secure-field disclosure. **No real pointer is read**; it
says so on its second line.
The third prints the on-device decision table, a held recording transcribed
partial-by-partial, a recogniser that finalises early, a double final, a
callback after cancel, a mid-utterance failure, the privacy refusal and its
disclosure, both permission denials, two spoken chunks interrupted mid-sentence
with the measured `stop()` round trip, and a Mac with no voice. Against the
stub **nothing is recorded and nothing is audible**; it says so, and it ends
with the list of what it could not demonstrate.

All three print which target they selected on their first line; if it says
"Node stub", the Swift build did not land where it was expected.

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
- **No pointer has ever been read.** `CGEvent(source:)?.location`,
  `NSEvent.mouseLocation` and `CGDisplayBounds(CGMainDisplayID())` are
  unexercised, and the AppKit coordinate flip has never run against a real
  screen — only against its own unit test.
- **No accessibility element has ever been hit-tested.**
  `AXUIElementCreateSystemWide`, `AXUIElementCreateApplication`,
  `AXUIElementCopyElementAtPosition`, `AXUIElementCopyAttributeValue`,
  `AXUIElementGetPid`, `AXValueGetValue` and `AXUIElementSetMessagingTimeout`
  are unexercised.
- **Whether `AXSecureTextField` actually appears where PR-013 assumes** — as a
  role in AppKit, as a subrole in AppKit's text system and in WebKit — is
  unconfirmed against any real application. The classifier logic is fully
  tested; which attribute a given password field really exposes is the open
  question, and it is the one that decides whether the redaction PR-018 builds
  on ever fires.
- Whether a 200 ms accessibility messaging timeout is enough for a busy
  application, or too long for the 30 Hz path.
- Whether the pointer sample rate is actually achievable through the stdio loop
  on a real machine. Everything measured here is measured against a Node stub.

New with PR-014, and none of it exercised either:

- **Nothing has been recorded and nothing has been spoken.** No microphone has
  been opened, no `AVAudioEngine` started, no utterance synthesised.
  `SFSpeechRecognizer`, `SFSpeechAudioBufferRecognitionRequest`,
  `AVAudioEngine`, `AVSpeechSynthesizer` and `AVSpeechSynthesisVoice` are
  entirely unexercised.
- **Whether `requiresOnDeviceRecognition` really keeps the audio local.** The
  whole privacy story rests on Apple's documented behaviour — that it fails
  rather than falling back — and that has not been observed.
- **Whether `SFSpeechRecognizer.queue` is enough.** The helper's main thread is
  blocked in the stdio read loop and runs no run loop, so a callback delivered
  on the main queue would never fire. The recogniser's queue is set explicitly
  to avoid that; if it turns out not to be sufficient, the fallback is to move
  the stdio loop off the main thread.
- **Whether `AVSpeechSynthesizerDelegate` fires at all** in a process with no
  run loop. `SystemSpeechOutputService` therefore does not depend on it: a
  poll-time reconciliation against `isSpeaking` ends utterances the delegate
  never reported. If the delegate works, the reconciliation finds nothing to
  do. **If neither works, TTS completion never arrives** — this is the single
  most important thing to watch for in `demo:speech` on a Mac.
- **The Apple Speech error numbers are folklore.** `kAFAssistantErrorDomain` is
  undocumented; `SpeechErrorMapper` degrades an unrecognised number to
  `recognizer-failed`, which is still a correct typed failure.
- Whether `addsPunctuation`, `taskHint` and `AVSpeechSynthesisVoiceQuality`
  behave as assumed, and whether an early `endAudio()` really yields a final.

The Swift that *is* covered by `swift test` is the pure logic: the permission
state mappers, the settings-URL table, the bundle-path walk, the
`CGWindowListCopyWindowInfo` dictionary parser, display assignment, JSON
serialisation, every PR-011 operation dispatched through `HelperServer` with
stub services, and (PR-013) the secure-field classifier, the label preference
order, the AppKit coordinate flip, the text clamps and both accessibility
operations dispatched through `HelperServer` with a stub service.
serialisation, the speech event queue, the terminal ledger, the speech error
classifier, the rate mapper, and every PR-011 and PR-014 operation dispatched
through `HelperServer` with stub services.

### On the Mac (Swift, batched per runbook §2)

The Swift toolchain does not exist on the Linux development machine, so
`native/` has never been compiled. These are the steps to run:

```sh
cd packages/platform-mac

# 1. Build the helper (Xcode command line tools, Swift 5.9+, macOS 13+).
swift build --package-path native            # debug
swift build --package-path native -c release # release

# 2. Run the Swift unit tests (frame codec, server behaviour, PR-011 and
#    PR-013 pure logic).
swift test --package-path native

# 3. Run the three demos against the real helper instead of the Node stub.
#    PR-014 pure logic).
swift test --package-path native

# 3. Run all three demos against the real helper instead of the Node stub.
cd ../..
pnpm build
pnpm --filter @pilot/platform-mac demo
pnpm --filter @pilot/platform-mac demo:permissions
pnpm --filter @pilot/platform-mac demo:accessibility
pnpm --filter @pilot/platform-mac demo:speech
```

Step 3 needs no configuration: `resolveHelperBinary()` finds
`native/.build/debug/PilotHelper` on its own. Set `PILOT_HELPER_BINARY` to
point somewhere else, or `--configuration release` output. All three demos print
which target they chose on their first line; if it says "Node stub", the Swift
build did not land where it was expected.
point somewhere else, or `--configuration release` output. All three demos
print which target they chose on their first line; if it says "Node stub", the
Swift build did not land where it was expected.

Expected results: `swift build` produces `native/.build/debug/PilotHelper`;
`swift test` passes; `demo`'s sections 1–4 and 6 behave exactly as they do
against the stub (section 5 is skipped — the Swift helper has no crash-on-demand
operation).

A `swift build` failure in PR-003 code is a PR-003 defect; in the PR-011 files
it is a PR-011 defect; in the PR-013 files it is a PR-013 defect. Either way,
report the compiler output rather than working around it. New compile risk:

```text
PR-011
Sources/PilotHelperCore/PermissionModel.swift    pure — Foundation only
Sources/PilotHelperCore/Attribution.swift        pure — Foundation only
Sources/PilotHelperCore/WindowModel.swift        pure — Foundation only
Sources/PilotHelperCore/PermissionProbes.swift   AVFoundation, Speech, ApplicationServices, CoreGraphics, Darwin
Sources/PilotHelperCore/WindowEnumerator.swift   CoreGraphics, AppKit

PR-013
Sources/PilotHelperCore/AccessibilityModel.swift   pure — Foundation only
Sources/PilotHelperCore/AccessibilityProbes.swift  ApplicationServices, CoreGraphics, AppKit
A `swift build` failure in PR-003 code is a PR-003 defect; in the files below
it is a PR-011 or PR-014 defect. Either way, report the compiler output rather
than working around it. New compile risk:

```text
Sources/PilotHelperCore/PermissionModel.swift    pure — Foundation only          PR-011
Sources/PilotHelperCore/Attribution.swift        pure — Foundation only          PR-011
Sources/PilotHelperCore/WindowModel.swift        pure — Foundation only          PR-011
Sources/PilotHelperCore/PermissionProbes.swift   AVFoundation, Speech, ApplicationServices, CoreGraphics, Darwin   PR-011
Sources/PilotHelperCore/WindowEnumerator.swift   CoreGraphics, AppKit            PR-011
Sources/PilotHelperCore/SpeechModel.swift        pure — Foundation only          PR-014
Sources/PilotHelperCore/SpeechServices.swift     AVFoundation, Speech            PR-014
```

The pure files are the ones the tests cover; the framework files are the risk.
`PermissionProbes.swift` uses `dlsym` for
`responsibility_get_pid_responsible_for_pid`, which is SPI — if it does not
resolve, attribution reports `inferred` rather than failing.
`AccessibilityProbes.swift` carries two `as!` casts guarded by `CFGetTypeID`
checks (`AXUIElement` and `AXValue` do not bridge through `as?`); those are the
lines to look at first if it fails to compile.

### What `demo:accessibility` will do on a Mac

It raises **no** prompt of its own. `AXIsProcessTrusted()` does not prompt, and
nothing here calls `AXIsProcessTrustedWithOptions`, so a machine that has not
granted Accessibility will simply print `trusted=false` and the degraded mode —
which is itself worth confirming.

Three things to look for:

1. **Does any element come back at all?** With Accessibility granted, section 1
   should name a role and a label for a position over a real control. All
   `no target (none)` while `trusted=true` means `AXUIElementCopyElementAtPosition`
   is not answering the way this assumes.
2. **Does a real password field report `isSecure`?** Point at a login form —
   Safari and a native app both, they may not agree — and check for
   `[SECURE: value withheld]`. **This is the finding that matters most**: PR-018
   redacts on this flag, and if it never fires the redaction never happens.
   Report the role and subrole that actually appear.
3. **Do the normalised coordinates match where the pointer really is?** Put the
   pointer at a window's top-left corner and its bottom-right; expect `0.000,
   0.000` and `1.000, 1.000`. A vertical mirror image means the coordinate flip
   is wrong; an offset by a display height means the wrong display was used.

### What `demo:speech` will do on a Mac

Unlike the stub run, this one **opens the microphone and makes noise**, and it
prompts if Microphone or Speech Recognition has not been granted. Watch for, in
order:

1. **Section 1**: `onDevice`. `true` means this Mac can recognise the locale
   locally and nothing leaves. `false` on an English-locale Mac would be a
   surprise worth reporting — it means Pilot refuses to listen by default.
2. **Section 2**: whether partial transcripts appear at all. If the section
   prints only a `final`, or nothing, the recognition callbacks are not
   reaching the helper's queue — the `SFSpeechRecognizer.queue` question above.
   This is the most likely single point of failure in the whole PR.
3. **Sections 3–5**: whether the *real* recogniser reproduces the scripted
   misbehaviour. Report what it actually does; the host handles all of it
   either way, and the answer is worth having written down.
4. **Section 9**: whether both chunks are audible, whether the second follows
   the first without a gap, and whether the interruption is audibly immediate.
   The printed `stop()` round trip is only the IPC cost — the number that
   matters against the 300 ms budget is when the sound actually stops.
5. **Section 9 again**: whether `finished` is ever reported for a chunk left to
   play out. If it never arrives, neither the delegate nor the `isSpeaking`
   reconciliation is working, and PR-026's buffer will stall on the first
   chunk.

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
