# Pilot

macOS desktop assistant that observes one user-selected window, follows the
pointer, accepts push-to-talk spoken questions, and answers aloud grounded in
the screen.

Design and delivery documents live in `docs/` and `dp/`. Start with
`docs/runbook.md`.

## Toolchain

- **Node 24** (`nvm use` — pinned in `.nvmrc`)
- **pnpm only** — never `npm` or `npx`; use `pnpm dlx` in place of `npx`
- TypeScript strict, ESM (`NodeNext`), Vitest, ESLint flat config + Prettier

## Workspace layout

```text
apps/desktop/          Electron shell: main process, sandboxed preload, React panel
packages/shared/       identifiers, geometry, errors, IPC envelopes, logging, domain types
packages/platform/     adapter interfaces, cross-block service contracts, fakes
packages/platform-mac/ embedded Swift helper and its framed stdio transport
packages/observation/  frame ring, pointer timeline, scene revision, deterministic clear, screen policy
packages/interaction/  the interaction state machine, its transition table and controller
packages/agent/        Pi agent session, tools, and the Pi dependency boundary
```

`packages/platform-mac/native/` is a SwiftPM package that **cannot be built on
Linux**; see `packages/platform-mac/README.md` for the Mac-only steps.

`pnpm install` also downloads the Electron runtime binary
(`apps/desktop/scripts/ensure-electron.js`). That download is optional: lint,
typecheck, test and build all pass without it, and only launching or packaging
the app needs it. Set `PILOT_SKIP_ELECTRON_DOWNLOAD=1` to skip it.

## Verification

Run from the repository root. These commands are the only gate — there is no CI
workflow (runbook §5, amendment 5).

```sh
pnpm install
pnpm lint       # eslint + prettier --check
pnpm typecheck  # tsc over every package's src and test files
pnpm test       # vitest, including a clean build + packaged-bundle check
pnpm build      # shared libraries (tsc) + the three Electron bundles
```

## Running the app

From a clean checkout:

```sh
nvm use                 # Node 24
pnpm install
pnpm dev                # electron-vite dev server + Electron, hot reload
```

`pnpm dev` puts Pilot in the menu bar and hot-reloads renderer edits; main and
preload edits restart the process. To run the built app instead of the dev
server:

```sh
pnpm build
pnpm start
```

Headless launch check (Linux, needs `xvfb-run`; prints a single OK line):

```sh
pnpm smoke                                      # the built dist/
pnpm --filter @pilot/desktop run smoke:packaged # the packaged bundle
```

### Build layout

| Command | What it does |
| --- | --- |
| `pnpm build` | `tsc --build` for `packages/*`, then the desktop app |
| `pnpm --filter @pilot/desktop run build:app` | stages the helper, then electron-vite → `apps/desktop/dist/{main,preload,renderer}` |
| `pnpm --filter @pilot/desktop run build:helper` | the native helper hook alone → `apps/desktop/resources/helper/` |
| `pnpm package` | `build:app`, then electron-builder `--dir`, then the bundle check |

electron-vite bundles all three Electron processes from TypeScript source
(`apps/desktop/electron.vite.config.ts`). It does not typecheck — `pnpm
typecheck` does that — and it inlines every dependency, so the packaged
`app.asar` contains no `node_modules`. The preload is emitted as CommonJS
because the panel runs with `sandbox: true`, and the renderer's Content Security
Policy is shipped unchanged; both are asserted by
`apps/desktop/test/build/development-build.test.ts`.

## Packaging

```sh
pnpm package
```

produces an unpacked development bundle under `apps/desktop/release/` and then
verifies it by opening it (`apps/desktop/scripts/verify-bundle.js`): the app
entry points must be inside `app.asar`, and the native helper must be a real
executable beside it.

Known limits of this configuration — all deliberate:

- **Development signing only.** `mac.identity` is null, hardened runtime is off.
- **No notarization.** Recorded as a known gap against the MVP-01 definition of
  done (runbook §7; there is no Developer ID account). A packaged app therefore
  needs `xattr -dr com.apple.quarantine` or a right-click → Open on any machine
  that did not build it, and TCC grants are re-prompted whenever the signature
  changes.
- **`--dir` only.** No dmg, no installer; PR-042 owns the release packaging.
- **Host architecture only**, because the bundle reuses the Electron runtime in
  `node_modules` rather than downloading a second copy.

### The native macOS helper

Screen capture, Accessibility, speech and the global push-to-talk key live in a
Swift executable that ships inside the app bundle
(`packages/platform-mac/native`, owned by PR-003). Packaging stages it into
`Contents/Resources/helper/`.

`apps/desktop/scripts/build-helper.js` runs before every app build:

- **on macOS with Swift and the native package present** — it runs `swift build
  -c release` and stages the real binary;
- **anywhere else** (this repo's Linux development machines, or before PR-003
  lands) — it stages a placeholder, records the reason in
  `helper/helper.json`, and says so on stdout. The placeholder is a real
  executable that exits 78 with an explanation if anything runs it, so a bundle
  missing its helper fails loudly rather than looking healthy.

On the Mac, to build a bundle that contains the **real** helper:

```sh
nvm use && pnpm install
swift build -c release --package-path packages/platform-mac/native   # optional: check it alone
pnpm --filter @pilot/desktop run build:helper -- --require-native     # fails if Swift is missing
pnpm package
pnpm --filter @pilot/desktop exec node scripts/verify-bundle.js       # expect `helper: native`
open "$(find apps/desktop/release -maxdepth 2 -name 'Pilot.app' | head -1)"   # mac-arm64 or mac-x64
```

`--require-native` is the difference that matters: without it the hook falls
back to the placeholder, and a bundle that cannot observe the screen is
indistinguishable from one that can until someone tries it.

## Demo (PR-001)

1. Run the complete workspace check above; every command must pass.
2. Run one fake adapter contract test on its own:

   ```sh
   pnpm exec vitest run packages/platform/test/fakes.contract.test.ts
   ```

   Every block in that file binds a fake to the interface a real
   implementation will have to satisfy, so it fails to compile if a fake drifts
   from its contract.

## Demo (PR-002 — desktop shell)

```sh
pnpm dev                                    # launch the shell
pnpm build && pnpm smoke                    # headless launch check (Linux, Xvfb)
```

`pnpm dev` puts Pilot in the menu bar. Use the menu bar item to show and hide
the floating panel.

**The "Fake state" row is gone as of PR-029.** It forced the *fake* interaction
controller into a named view state; with the real `PilotInteractionController`
there is no such door, and there should not be one — a state is reached by
sending the machine an input and letting the table decide. Ask a question in the
text box and the panel goes through `thinking` → `speaking` → `observing` on its
own. The states nothing can cause on demand are reachable from the environment
instead: `PILOT_PERMISSION_FIXTURE`, `PILOT_HOTKEY_FIXTURE`,
`PILOT_SPEECH_DISCLOSURE` and `PILOT_MODEL_FIXTURE` (see PR-029's demo below).

On Linux the shell runs headlessly under `xvfb-run`, which is what the `smoke`
script does: it starts the real Electron binary and waits for the renderer to
complete a validated IPC round trip. There is no visible menu bar under Xvfb,
so the *visual* part of the demo needs a desktop session — the user's Mac.

## Demo (PR-004 — observation core)

Feed the recorded fixtures through the observation core and inspect the
selected frame and the buffer statistics:

```sh
pnpm build && pnpm --filter @pilot/observation demo
```

The run is driven by a fake clock, so its output is identical on every
machine. It prints the recorded session, the scene revision transitions, the
buffer statistics against their bounds, the frame and pointer sample selected
for the question moment, the explicit failures for out-of-range queries, and
the deterministic clear with proof that nothing is retrievable afterwards.

## Demo (PR-016 — scene and pointer timeline)

Replay the recorded events through the PR-001 platform fakes and inspect the
scene/revision transitions:

```sh
pnpm build && pnpm --filter @pilot/observation demo:scene
```

Frames arrive through `ObservationAdapter.subscribe`, pointer positions are
pulled from `AccessibilityAdapter`, and window lifecycle events come from
`WindowAdapter.subscribe`; a fake clock drives the whole run, so the output is
identical on every machine. It prints the content-fingerprint decision for
every frame (including the one scripted change the rule is documented as
unable to see), the scene revision ladder, the question anchor at the utterance
end with its envelope fields, the lock/unlock/resume and window-close
lifecycle, and the scene lineage — with every stale scene reference refused.

The fingerprint rule and its failure modes are documented at the top of
`packages/observation/src/content-fingerprint.ts`.

## Demo (PR-017 — screen policy)

Run allowed and rejected observation scenarios against the same fixtures and
see which policy rule decided each one:

```sh
pnpm build && pnpm --filter @pilot/observation demo:policy
```

It prints the policy in force (system-design §10), the full rule table
(rule → step → error code → what it rejects), six allowed observations with the
images they produced, nineteen rejected ones with the single rule that refused
each, the observation rate limit at its exact boundary, the buffer clear for
each of pause / screen lock / window loss / shutdown, and the sentence that says
what redaction does *not* promise. Three scenarios are marked `PRIVACY:` — they
are the ones that refuse to look at anything but the selected window.

The policy is data (`packages/observation/src/screen-policy.ts`) and its
execution order is an explicit seven-step sequence
(`packages/observation/src/policy-enforcer.ts`). Step 5 of §10 — the actual
image work — sits behind the `ImageProcessor` seam that PR-018 fills in.

## Demo (PR-018 — image processing pipeline)

Produce the approved full-frame and pointer-crop artefacts from fixture images:

```sh
pnpm build && pnpm --filter @pilot/observation demo:image
# artefacts land in packages/observation/artifacts/ ; pass `--out <dir>` to move them
```

It renders a deterministic synthetic billing-settings window at a Retina
(2400×1600 at 2×) and a standard-DPI (1000×700 at 1×) capture size, then runs
each §10 step-5 scenario through the real pipeline: a full frame passed through
untouched, a 2× capture reduced to the 1440 px policy edge, a frame with the
password field masked, pointer crops at the centre and clamped into a corner, a
before/after pair, and a photographic window. For each it prints the output
dimensions, the byte size, the encoding it chose and why, and what it cost.

Two sections are measurements rather than illustrations:

- **Double-JPEG legibility**, the risk recorded in `docs/handoff.md` §5, on a
  pointer crop taken at a deliberately non-block-aligned offset. The second JPEG
  generation roughly doubles the luma error on the crop; encoding it losslessly
  costs nothing extra.
- **The §17 preprocessing budget**, measured for every combination of capture
  size, source encoding and secure-field-in-view. The pipeline is inside 150 ms
  for the capture size the policy actually requests, except when the source
  frame is JPEG, where the pure-JavaScript decode alone is ~165 ms.

There is **no native image dependency**: PNG goes through Node's own `zlib`,
JPEG through pure-JS `jpeg-js`, and BGRA through a channel swap. The reasoning,
including why `sharp` was not adopted, is at the top of
`packages/observation/src/image-codec.ts`.

## Demo (PR-019 — screen context facade)

Call `ScreenContextService.observe()` against recorded and fake-fresh sources —
the whole observation lane assembled behind the system-design §5 interface:

```sh
pnpm build && pnpm --filter @pilot/observation demo:context
```

It runs every `view` × `moment` combination the `observe_screen` tool can ask
for and prints, for each, where the frames came from and what images they
produced; then shows which scene transition a `before-and-after` was bounded
around and why a *revision* bound is the one that is true; a superseded scene
reference being refused with a typed `scene-mismatch`; an abort landing while
the platform is capturing, honoured even by an adapter that ignores its signal;
retention dropping the frame ring **and** the pipeline's one decoded frame on
each of the eight clear events; and the typed error every refusal carries into
the tool. The frames are real PNG screenshots and the image pipeline runs on an
injected stopwatch, so the byte counts are real and the output is identical on
every machine.

The facade is `packages/observation/src/screen-context.ts`. It decides which
moment, which frames, whether the scene is still answerable, and what the
runtime state is; every refusal is one of PR-017's rules carrying that rule's
error code, so no code is invented that PR-021's tool has not already mapped.

## Demo (PR-006 — interaction state machine)

```sh
pnpm demo:interaction
```

Builds the workspace and replays one deterministic conversation against the
fake speech, agent and observation adapters:

```text
idle → observing → listening → transcribing → thinking → observing-screen →
thinking → speaking → (interrupted) listening → transcribing → thinking →
(interrupted) observing → idle
```

It prints the state path, everything that was spoken, the capture lifecycle,
and every input the machine discarded — including the late results from both
superseded runs, which is the property PR-027 later has to hold end to end.

The transition table itself is checked in as
`packages/interaction/test/transition-table.expected.ts`: one line per
(state × input) pair, asserted against the machine by
`packages/interaction/test/table.test.ts`.

## Demo (PR-026 — response and TTS buffer)

```sh
pnpm demo:response
```

Streams awkward punctuation past the sentence segmenter and prints the ordered
speech chunks that reached the fake synthesiser. Seven scenes: abbreviations,
decimals and dotted identifiers that must not split; lists and newlines that
must; a stream that ends mid-sentence, whose tail is spoken rather than lost;
the phrase timeout releasing a fragment the model left hanging; speech starting
while the model is still working and continuing across an `observe_screen`
call; a superseded run whose queued chunk is dropped and whose late text is
rejected; and a synthesiser that reports completion twice and out of order
without ending the turn early.

Deterministic: injected clock, counter identifiers, scripted agent and
synthesiser. The segmentation rule and every case it deliberately refuses to
split are documented at the top of
`packages/interaction/src/segmentation.ts`.

## Demo (PR-027 — interruption and cancellation)

```sh
pnpm demo:interrupt
```

Interrupts Pilot in eight different places and prints, for each, the four
places late output could resurface and does not: the panel transcript, the
synthesiser, the machine's rejections and the bindings' discards. The scenes
are an interruption while thinking; one while speaking, with the next sentence
already queued; one during `observe_screen`, which is *steered* rather than
aborted so the capture can unwind (system-design §15); a run that completes
after it was aborted; two interruptions in quick succession; one that lands
between the answer and its first spoken word; one that lands while the question
is still being submitted, where there is no run id to interrupt and the
submission's own `AbortSignal` is what stops it; and a run that stalls
mid-sentence, whose waiting fragment is spoken by an injected scheduler with no
run event at all.

Deterministic: injected clock, counter identifiers, scripted agent and
synthesiser, and a manual scheduler — the machine still owns no timers, and
nothing anywhere waits on real time.

## Demo (PR-023 — safe session persistence)

```sh
pnpm build && pnpm --filter @pilot/agent run demo:persistence
```

Runs twelve screen questions through a real Pi session backed by a real SQLite
session database in a temporary directory, quits, and relaunches — then
**scans every byte of every file on disk** for the image payloads that were in
the live model context a moment earlier. It prints each file, its size, and
whether the pixels, the withheld-image audit record, the question text and the
answer text are present.

The point is that Pi has no option for this. `Session.appendMessage`
serializes the message it is handed, verbatim, on both shipped backends
(`docs/pi-notes.md` §3.1); the pixels are absent because Pilot is the only
writer and every write goes through one sanitising choke point.

Six acts: the conversation and its compaction; the quit, which flushes the
writer queue and releases the SQLite writer lease; the disk scan; the
relaunch, which restores transcript **plus** summary **plus** boundary and
compares the two contexts property by property; what persisting the summary is
actually worth, as the size of the first provider request with and without it;
the writer lease, including what a second instance sees; and clear
conversation, followed by a second disk scan.

Deterministic: fixed fixtures, an injected clock, no network and no
credentials — the model is Pi's built-in faux provider. The only thing that
varies between runs is the temporary directory name.

## Demo (PR-007 — development build baseline)

```sh
pnpm package                                       # build + bundle + verify
pnpm --filter @pilot/desktop run smoke:packaged    # launch the bundle headlessly
```

The first command prints which helper went into the bundle. On Linux that line
reads `helper: PLACEHOLDER (host-is-not-macos)`, which is the honest answer:
this machine has no Swift toolchain and no ScreenCaptureKit. The second command
starts the packaged executable — not `dist/` — under Xvfb and waits for the
renderer to complete a validated IPC round trip, so it proves the asar, the
packaged paths and the bundled Electron runtime agree.

What Linux does **not** prove, and what needs the Mac: the Swift build itself,
the helper actually running, TCC prompts, the menu bar item, and anything
visual. See "Packaging" above for the exact Mac commands.

## Demo (PR-008 — permission onboarding)

```sh
pnpm demo:permissions                       # headless walkthrough, no display needed
pnpm demo:permissions -- darwin             # same, with a working System Settings shortcut
```

The walkthrough drives the real permission gate, the real settings seam and the
real view model through every fixture — `unknown`, `granted`, `denied`,
`restricted`, `screen-denied`, `accessibility-denied`, `mixed` — and prints what
the panel would show for each: the readiness, the per-permission status, the
consequence of each permission being missing, and the action offered. It ends
with a `denied → granted` sequence that recovers in place, and with the System
Settings shortcut's availability on each platform.

In the app:

```sh
pnpm dev                                    # starts in the "unknown" state
PILOT_PERMISSION_FIXTURE=denied pnpm dev    # start in any fixture instead
```

The panel's **Fake permissions** row switches between the same fixtures at
runtime, so all four contract states can be walked without editing source or
restarting. The four permissions are modelled by what their absence costs:
Screen Recording **blocks** Pilot entirely, Accessibility **degrades** it (Pilot
keeps working from visual pointer coordinates and says so — system-design §16),
and Microphone and Speech Recognition **limit** it to typed questions.

`Open System Settings` is disabled on Linux, with the reason and the pane to
open by hand printed beside it; it is enabled and functional only on macOS. A
permission refused and then granted outside Pilot recovers without a restart:
the gate follows adapter events, and re-reads whenever the panel is revealed,
because macOS TCC never notifies.

## Demo (PR-009 — window picker and observation controls)

```sh
pnpm demo:windows                           # headless walkthrough, no display needed
```

The walkthrough drives the real window gate, the real permission gate and the
real observation view model through **every** indicator state and prints what
the panel would show for each: the indicator, whether Pilot is capturing, the
selected-window summary, each control with its availability and — when it is
unavailable — the reason, and every window row with its own reason. It ends by
listing which of the six states it reached, so a state that stopped being
reachable fails loudly rather than quietly disappearing.

The six states are deliberately six, not one badge with a boolean:

| Indicator | Capturing | What it means |
| --- | --- | --- |
| `checking` | no | Permissions or the window list have not been read yet |
| `blocked` | no | Screen Recording is refused; Pilot can see nothing |
| `no-window` | no | Allowed, but nothing has been chosen |
| `paused` | no | Pilot is suspended — capture cannot run whatever else is true |
| `stopped` | no | A window is selected and observation is switched off |
| `observing` | **yes** | Capture is running against the selected window |

`data-capturing` is true in exactly one of them, and the indicator dot is filled
and pulsing only there.

In the app:

```sh
pnpm dev
```

Click path — no source edits, and it exercises everything in this PR:

1. **Fake permissions → `granted`.** The indicator reads *No window selected*.
2. **Watch this window** on *Billing Settings* → *Not watching*; **Start
   watching** becomes available and every other control states why it is not.
3. **Start watching** → *Watching this window*, `capturing now`.
4. **Fake window events → retitle selected window** → the summary and the list
   row follow the new title; Pilot keeps watching.
5. **Pause Pilot** → *Paused*, `not capturing`, and selecting a different window
   is refused with "Pilot is paused. Resume it first." **Resume Pilot** →
   *Watching this window* again.
6. **Fake window events → close selected window** → observation stops, the
   selection clears, the closed window leaves the list, and a prompt appears:
   "The window Pilot was watching closed… Choose another window to carry on"
   (system-design §16). Choosing another window answers the prompt.
7. **Fake permissions → `screen-denied`** → *Cannot watch*; every control and
   every window row is disabled with the Screen Recording reason.
8. **Fake permissions → `accessibility-denied`** → observation is still offered
   and still runs. Blocked and degraded are different states, per §16.
9. **Fake window events → restore all windows** puts the list back so the walk
   can be repeated.

## Demo (PR-010 — conversation and diagnostics panel)

```sh
pnpm demo:conversation                      # headless walkthrough, no display needed
```

The walkthrough drives the real conversation gate, the real fixture replay and
the real view models. It prints, in order: every interaction state with its
label, tone, activity and — the column that matters — whether the text box is
available in it; a spoken question answered in streamed chunks; the same
question typed; an answer interrupted mid-flight; the recogniser failing; the
same panel with no usable push-to-talk shortcut and a disclosure that the audio
would leave the machine; the ring buffer; and a privacy check that searches
every measured value for every word that was said.

### The interaction states

Ten states, ten labels, ten sentences. The five this PR names are additionally
given pairwise-distinct `tone` and `activity`, so they are told apart by colour
and pulse rather than by reading:

| State | Tone | Activity | Text box |
| --- | --- | --- | --- |
| `listening` | `listening` | `hearing` | available |
| `thinking` | `working` | `thinking` | available |
| `observing` | `ready` | `waiting` | available |
| `speaking` | `speaking` | `answering` | available |
| `error` | `error` | `failed` | **available** |

`error` is the row that matters. system-design §16 says "STT fails → … then
offer text input", and PR-025 made `error + submit-text` legal for exactly that.
The panel asks `isTextFallbackAvailable(state)` from `@pilot/interaction` rather
than deciding for itself, so the affordance and the machine cannot disagree.
Every other control asks the same transition table through `lookupRule`.

### Developer diagnostics

`Show developer diagnostics` opens a ring buffer of the system-design §17
metrics: capture-to-observation latency, STT duration, time to first token, time
to first spoken sentence, observation calls per question, image bytes, active
image count, and abort and failure categories.

**It records timings and counts, not content** (§13, §17). That is enforced by
shape, not by convention: a telemetry sample is five numbers plus one field from
a closed vocabulary, `TelemetryRing` has no recording method that accepts a
string, and the panel re-checks every sample against that vocabulary and
withholds anything that does not fit. There is no path by which a transcript, a
window title or an image could reach the surface.

In the app:

```sh
pnpm dev
PILOT_HOTKEY_FIXTURE=permission-missing pnpm dev   # no way to speak at all
PILOT_SPEECH_DISCLOSURE=remote pnpm dev            # audio would leave the Mac
```

Click path — no source edits:

1. **Fake permissions → `granted`**, then **Replay → spoken question**. The
   transcript fills in, the answer arrives in chunks, and the state badge walks
   listening → transcribing → thinking → looking at the screen → speaking.
2. **Show developer diagnostics** → speech-to-text, time to first token, time to
   first spoken sentence, observation calls, image bytes and the active image
   count all read as measured. The two compaction counters read `—`, because
   nothing has compacted: "not measured" and "measured as zero" are different
   facts.
3. **Replay → interrupt mid-answer** → the partial answer stays on screen badged
   *interrupted*, and the diagnostics gain one abort under `user-interrupted`.
4. **Replay → speech recognition fails** → the state badge reads *Something went
   wrong*, the failure is shown with its code, and the **text box is still
   live**, with "Pilot could not finish the last question. Type it instead."
   Typing a question there is accepted.
5. Start again with `PILOT_HOTKEY_FIXTURE=permission-missing pnpm dev` → *Hold
   to talk* is disabled with the Accessibility reason beside it, and the text box
   is marked as the only way to ask.
6. Start again with `PILOT_SPEECH_DISCLOSURE=remote pnpm dev` → a banner says
   what you say would be sent to Apple to be transcribed, and names the service.
7. **Clear telemetry** empties the ring; the metrics go back to `—`.

Since PR-029 the **Replay** row is no longer a replay: each control dispatches
the same commands the panel's own buttons dispatch, into the real interaction
controller and a real `PiAgentSession`. The words in the answers come from Pi's
faux provider, not from a model.

## Demo (PR-028 — observe a real selected window)

```sh
pnpm demo:observe                           # headless walkthrough, no display needed
```

**Read this first: `docs/implementation.md`'s demo for PR-028 — "select a real
window, inspect local frames/pointer target, pause, and verify immediate
clearing" — cannot be run on the development machine.** There is no macOS and no
Swift toolchain here (`docs/runbook.md` §5 amendment 8), so no ScreenCaptureKit
stream has ever produced a pixel and no TCC prompt has ever appeared. The Mac
commands that do run it are `docs/handoff.md` §1 step 7.

`pnpm demo:observe` is the equivalent that *can* be run here, and it is not a
model of the app — it is the app. The window gate, the permission gate, the real
interaction controller, `ObservationSession`, `ObservationCore` and
`PilotScreenContextService` are the shipping objects, driving the real
`MacWindowAdapter`, `MacPermissionAdapter`, `MacAccessibilityAdapter` and
`MacObservationAdapter` over the real framed stdio transport. The only stand-in
is the process on the far end of the pipe: the Node helper stub
`packages/platform-mac` tests itself against, which is a second, independent
implementation of the wire protocol.

Seven sections:

1. **The permission refusal an unwired facade produces.** `ScreenContextConditions.permissions`
   defaults to `'unknown'`, which system-design §10 step 1 refuses. Then the real
   states arrive from `MacPermissionAdapter`, with PR-011's attribution verdict
   beside them.
2. **Selecting a window starts capture** — the transition table's `select-window`
   row — **and the frames reach the ring**, with `encoding=png` (see below).
3. **One observation** through the seven-step policy, printing the frame
   provenance, the image bytes, the pointer, the accessibility target the
   timeline recorded, and the three §17 numbers it wrote to the diagnostics ring.
4. **Pause clears immediately**, through `RetentionGuard.clearFor` rather than
   through `ObservationSession` alone, so the decoded-frame cache goes with the
   ring. An observation asked for while paused is refused, not answered.
5. **The selected window closes** — driven by the real `MacWindowAdapter` diff,
   nothing here fakes the event — capture stops, the buffers clear, and the panel
   asks for a new selection (system-design §16).
6. **Two permission states that refuse**: Screen Recording denied, and — the one
   that matters — every permission `granted` while macOS credits the grant to the
   helper. PR-011's verdict is what turns the second into a refusal instead of a
   capture that quietly returns nothing.
7. **What none of it proves.** Printed by the demo itself, so it cannot be read
   as a verification it is not.

**Capture is asked for `png`, not `jpeg`.** PR-018 measured a JPEG *source*
frame at ~165 ms of pure-JS decode per observation needing a pointer crop — the
only path over §17's 150 ms budget — and a second JPEG generation roughly
doubling the visibly-damaged pixels on small text. `bgra` avoids both but does
not fit the 16 MiB ring. The choice lives at the composition root
(`CAPTURE_ENCODING` in `apps/desktop/src/main/platform-runtime.ts`), which is
the only place in the product that starts a stream.

In the app, the same thing by hand — the whole real stack, on Linux, against the
stub:

```sh
# The path must be absolute: the Electron main process does not run from the
# repository root.
PILOT_HELPER_STUB_PATH="$PWD/packages/platform-mac/test/support/helper-stub.ts" \
  PILOT_HELPER_STUB='{"permissions":{"screen-recording":"granted","accessibility":"granted","microphone":"granted","speech-recognition":"granted"},"desktop":{"windows":[{"windowNumber":42,"ownerPid":501,"applicationName":"Safari","applicationBundleId":"com.apple.Safari","title":"Billing Settings","titleAvailable":true,"bounds":{"x":100,"y":80,"width":1200,"height":800},"displayNumber":1,"isOnScreen":true,"layer":0}],"displays":[{"displayNumber":1,"bounds":{"x":0,"y":0,"width":1728,"height":1117},"scaleFactor":2,"isPrimary":true}]}}' \
  pnpm dev
```

The stub is TypeScript run by Node's own type stripping, and the Electron binary
is not Node, so the interpreter is named rather than assumed: `node` from `PATH`
inside Electron, `process.execPath` under plain Node, or
`PILOT_HELPER_STUB_NODE` when neither is right. A helper that will not start no
longer takes the application with it — the panel opens and the window and
permission gates report `helper-unavailable` where the user can see it.

Without that variable the app runs on the fake window and permission adapters
and has **no capture adapter at all** — the startup log says which and why
(`platform`, `platformReason`, `capture`), and every observation is refused with
a typed error naming the missing capture source rather than an empty ring naming
nothing. `PILOT_PLATFORM=fakes` forces that build on a Mac.

## Demo (PR-029 — text conversation with a real Pi session)

```sh
pnpm demo:agent                             # headless walkthrough, no display needed
```

This is the first PR in which asking Pilot a question reaches a real agent. The
walkthrough runs the exact composition `apps/desktop/src/main/index.ts` uses —
the real `PilotInteractionController` over a real `PiAgentSession` over Pi's own
`Agent` — and prints four things:

1. **Three turns in a row**, each answer naming the turn and quoting the question
   it answered. This is the case PR-022a's defect broke: `agent_end` fires before
   `Agent.prompt()` unwinds, so before that fix the second question failed with
   "Agent is already processing a prompt" and so did every question after it.
2. **The answer arriving as it is written** — how many times the panel
   re-rendered while the text grew, and at what sizes. Each one is a `text-delta`
   becoming a new view state.
3. **An interruption mid-answer**: what had arrived stays on screen, still marked
   pending (the panel renders that as *interrupted*), `lastError` stays null
   because an interruption is not a failure (system-design §15), and the next
   question still gets an answer — the property an abort is most likely to break.
4. **The capability gate refusing** a model with no image input, with the number
   of provider requests it made: zero. The gate runs inside `PiAgentSession`'s
   constructor, before Pi's `Agent` exists.

**What is real, and what is not.** Real: the transition table, the question
envelope (rendered by `renderAnchoredQuestionEnvelope`, so an unknown pointer
reads as "pointer: unknown" rather than as a position at `-1, -1`),
`PiAgentSession`, the capability gate, streamed deltas, `Agent.abort()`.

Not real: **the model**. There is no model access on this machine — the user
chose Codex subscription, no sign-in has happened and there is no API key
(`docs/handoff.md` §2) — so the provider is Pi's built-in faux provider and the
sentences in the answers are generated by `@pilot/agent`'s `answerFor`, which
says so in its own text. Speech (PR-032/033) is still mocked, and observation
was mocked when PR-029 landed — **PR-030 replaced it**, so `pnpm demo:agent`
still runs with a mocked screen (its own rig supplies no `screenContext`) while
the app itself no longer does.

In the app, the same thing by hand:

```sh
pnpm dev                                    # type a question in the panel
PILOT_MODEL_FIXTURE=faux-text-only pnpm dev # the capability gate refuses
PILOT_MODEL_FIXTURE=faux-no-tools pnpm dev  # refused for the other reason
```

Click path — no source edits:

1. **Fake permissions → `granted`.** The permission fixture the app boots into
   is `unknown`, and the real machine rests in `needs-permission` until it hears
   otherwise, so the text box is disabled with that reason beside it until you
   grant. That is not a regression: before PR-029 the fake controller reported
   permissions as granted no matter what the onboarding said, and the panel and
   the machine could not disagree about it because there was no machine.
2. Type a question and press **Ask**. The state badge goes *Thinking* →
   *Speaking* → *Watching*, the answer fills in a clause at a time, and the
   transcript keeps both turns. Ask two more.
3. **Interrupt** while an answer is arriving → the partial answer stays, badged
   *interrupted*, and the diagnostics gain one abort under `user-interrupted`.
4. **Show developer diagnostics** → time to first token is now measured from a
   real run rather than replayed.
5. Start again with `PILOT_MODEL_FIXTURE=faux-text-only pnpm dev` → the panel
   opens in `error` with "This model cannot see images…" *before* any question
   is asked, and the text box stays live because system-design §16 requires a
   way to ask. Asking anyway repeats the refusal and sends nothing.

## Demo (PR-030 — model-requested real observation, and "Look now")

```sh
pnpm demo:look                              # headless walkthrough, no display needed
```

This is the PR in which the **model** can see the screen. `observe_screen` no
longer reaches `FakeScreenContextService`: `createAgentRuntime({ screenContext })`
receives PR-019's real `PilotScreenContextService` — the *same instance* the
interaction table's "Look now" drives — so a model look and a user look share
one scene lineage, one retention guard, one decoded frame and one §10 rate
limit.

**Read this first, twice over.** `docs/implementation.md`'s demo for PR-030 —
"ask a text question that causes the model to call `observe_screen` and answer
from the selected window" — cannot be fully run here, for two independent
reasons:

- **No pixel is real.** There is no macOS and no Swift toolchain
  (`docs/runbook.md` §5 amendment 8), so every frame comes from the Node helper
  stub over the real framed stdio protocol. Its bytes are not a decodable image,
  so the decode-and-crop half of system-design §10 step 5 is unreachable from
  here.
- **No model is real.** There is no model access (`docs/handoff.md` §2), so the
  provider is Pi's faux one and *that* it calls `observe_screen` is scripted
  (`createScriptedModelSource`). Whether a real model decides to look, and what
  it makes of the image, is the largest open question in the tree.

Everything between those two ends is the shipping code, and the demo prints
nine sections:

1. **The boundary that changed** — `agent.screenContext === observation.screenContext`.
2. **With no window selected the tool refuses**, `no-window-selected`, before
   anything is captured. There is no whole-display fallback to fall back to.
3. **The model calls `observe_screen` and gets an image** — read back out of the
   provider's own inbox as a mime type and a base64 length, never as bytes — then
   answers.
4. **The user can see it happening**: `looking=true` on the observation
   indicator with "Pilot is reading an image of this window right now — this
   window only", while `capturing` stays true. Two facts, deliberately.
5. **"Look now"** through the machine (`look-now` → `observing-screen` →
   `observing`), asking for `view: 'window'`, `moment: 'current'`.
6. **One service, one budget**: a third look inside the same second is refused
   `rate-limited` / `policy-rejected`, because the model and the user share the
   §10 limiter.
7. **Selected-window-only, four ways** against the real service — lineage
   matching its own `status()`, every retained frame belonging to the selected
   window, an observation of the window the user has since left refused
   `scene-changed`, and the absence of any display parameter to ask with.
8. **A refusal reaching the user** on both paths: the model's, through PR-021's
   tool result, and the user's, through `main/observation-failure.ts`, which
   gives a manual refusal the same shape — a sentence, a failure kind, and
   whether looking again would help. The text box stays live (§16).
9. **What none of it proves**, printed by the demo itself.

In the app, the same thing by hand — the whole real stack, on Linux, against the
stub (use the long `PILOT_HELPER_STUB` from the PR-028 section above):

```sh
PILOT_HELPER_STUB_PATH="$PWD/packages/platform-mac/test/support/helper-stub.ts" \
  PILOT_HELPER_STUB='…' pnpm dev
```

Click path: grant the permission fixtures, pick a window, then press **Look
now** — the indicator says Pilot is reading the window, and the developer
diagnostics gain `capture-to-observation`, `image-bytes` and `active-images`.
The faux provider does not call the tool on its own, so a *model*-initiated look
needs either the scripted source (`pnpm demo:look`) or a signed-in model.

## Demo (PR-031 — point-and-ask with text input)

```sh
pnpm demo:ask                               # headless walkthrough, no display needed
```

This is the PR in which the product's core idea first works: **point at
something, ask about it in words, and get an answer grounded in what you were
pointing at.** One fake boundary went — the **question anchor**.
`FakeQuestionAnchorSource` (an empty recording) is gone from the real path, and
`ScreenContextInputs.anchor`, the last unwired input on the observation side, is
set at submission. `apps/desktop/src/main/question-anchor.ts` builds PR-024's
envelope factory over the real `ObservationCore` pointer timeline and, in the
same call, hands the resolved system-design §6 anchor to the *same*
`PilotScreenContextService` the `observe_screen` tool holds. Three things come
alive at once:

- `moment: 'question'` selects the frame from **when the question was asked**
  rather than the newest one in the ring;
- `view: 'pointer'` crops around the anchor rather than around wherever the
  mouse was last seen;
- the accessibility element under the anchor reaches the model as
  `pointer target: AXButton — Update payment method`, and reaches §10's
  redaction step as an `AccessibilityNode` with `isSecure` and bounds.

**Read this first.** `docs/implementation.md`'s demo for PR-031 — "point at a UI
element, type 'what is this?', receive a grounded answer" — cannot be fully run
here, for three independent reasons, and the third is the one that matters:

- **No model is real** (`docs/handoff.md` §2). Pi's faux provider, scripted, so
  *that* the tool is called and with which `moment` is chosen by the demo.
- **No pixel was ever on a screen.** The stub's frames are not a decodable image
  and a pointer crop must decode, so the frames are synthetic screenshots
  (`renderSyntheticScreen` + `encodePng`) pushed through the same
  `ObservationSession.ingestFrame` the capture stream arrives on. The decode,
  the crop and the encode are real; the subject is not.
- **No real pointer has ever been read, and no real accessibility element has
  ever been hit-tested.** There is no macOS here. So *"the crop is centred on
  what the user pointed at"* is **not verified anywhere in this repository** —
  only that it is centred on the pointer sample the anchor selected.
  `docs/handoff.md` §1 step 9 is what settles it, and item 1 of that list is the
  single most valuable observation in the whole Mac batch.

The walkthrough prints seven sections:

1. **The boundary that changed**, and that one `ObservationCore` sits behind
   both the envelope and the facade.
2. **Point at a button, type "what is this?"** — the anchor (`insideWindow`,
   `skewMs`, `targetRole`), the observation (`moment=question`, a `window` image
   and a `pointer` crop), the **rendered envelope the model actually received**,
   and the answer.
3. **The anchor selects the question-time frame**: a newer frame lands in the
   ring and the answer still comes from the one that was on screen when the
   question was asked.
4. **The crop follows the anchor**: the same window and the same screen, two
   pointer positions, two different pictures at the same policy crop size.
5. **The window changes between the question and the tool call** —
   `requestedSceneStatus=stale-revision`, `revisionsBehind=1`. Answered, not
   refused, and the model is told how far behind it is.
6. **A pointer that is not over the selected window identifies nothing**, in
   both of its forms — outside the window's frame (proved *at the wire*:
   `accessibility.element-at` is never sent) and inside the frame but over
   another application's window (proved at the wire too: `accessibility.sample`
   carries `ownerPid`). Plus an unknown pointer rendering as `pointer: unknown`
   and never as `-1.000`.
7. **What none of it proves**, printed by the demo itself.

Section 6b is there because PR-031 had to fix it. `AccessibilityGroundingTarget.
ownerPid` is optional and **both** of PR-013's foreign-application defences are
conditional on it; PR-028 omitted it, which cost nothing until the element
started reaching a prompt. The first run of this demo put a label from the
*other* stub window into the model's request. See `docs/runbook.md` cross-lane
issue 12 and follow-up 29.

In the app, the same thing by hand — the whole real stack, on Linux, against the
stub (use the long `PILOT_HELPER_STUB` from the PR-028 section above):

```sh
PILOT_HELPER_STUB_PATH="$PWD/packages/platform-mac/test/support/helper-stub.ts" \
  PILOT_HELPER_STUB='…' pnpm dev
```

Click path: grant the permission fixtures, pick a window, type a question. With
`PILOT_LOG_LEVEL=debug` the observation scope logs `question anchored` with the
scene, the revision, the skew and the target role at submission, and
`observation allowed` with `targetRole` when the look happens. The stub's frames
do not decode, so a `view: 'pointer'` observation is refused there — that is the
stub's limit, not the anchor's, and `pnpm demo:ask` is where the crop is real.

## Demo (PR-032 — real push-to-talk input)

```sh
pnpm demo:talk                              # headless walkthrough, no display needed
```

**This is where voice enters the conversation.** Until PR-032 every question in
this repository was typed. One fake boundary went — **speech input**:
`FakeHotkeyAdapter` and `FakeSpeechInputAdapter` are gone from the shell's real
path, and `MacHotkeyAdapter` (PR-015) and `MacSpeechInputAdapter` (PR-014) drive
the interaction controller instead. `apps/desktop/src/main/voice-runtime.ts` is
the whole of the new code: it maps `hotkey-down`/`hotkey-up` onto the machine's
`push-to-talk-down`/`push-to-talk-up`, publishes `hotkey-availability-changed`
to the panel, and establishes PR-011's TCC attribution verdict **before**
anything can open the microphone.

Nothing changed in the recogniser handling, and that is the point: PR-025's
`SpeechInputBinding` already absorbs a recogniser that finalises before the key
is released, finalises twice, or calls back after `cancel` — and Apple Speech
does all three. PR-032 hands it a different adapter and nothing else.

**Read this first.** `docs/implementation.md`'s demo for PR-032 — "hold Right
Option in another app, speak, release, and see the question submitted" —
**cannot be run here at all**:

- **No key has ever been pressed.** There is no macOS, no `CGEventTap`, and the
  Swift that would create one has never been compiled (runbook §5 amendment 8).
  Every key transition in the walkthrough is the Node helper stub playing a
  script.
- **No audio has ever been recorded.** No microphone has been opened, no
  `AVAudioEngine` has run, and no `SFSpeechRecognizer` has produced a word.
  Every partial and every final is a string the stub was handed.
- **No model is real** (`docs/handoff.md` §2). Pi's faux provider, scripted.

What the walkthrough *does* prove is that Pilot's half is correct given a tap
and a recogniser that behave as macOS's do — including badly. `docs/handoff.md`
§1 step 12 is the Mac run that settles the rest.

The walkthrough prints eight sections:

1. **The boundary that changed**, and the platform kind behind it.
2. **Hold the key, speak, release** — `observing` → `listening` → the live
   transcript growing partial by partial, exactly as `ConversationPanel`
   renders it → `transcribing` → the accepted transcript submitted as the
   question → the answer.
3. **The utterance interval reaches the anchor.** PR-031 built the anchor over
   `utteranceStartedAt`/`askedAt`; with a typed question both are "now", so
   `pointerSampleCount`, `pointerCrossedWindowBorder` and
   `sceneRevisedDuringUtterance` are degenerate by construction. Push-to-talk
   fills them with real key-down and key-up instants, and the pointer really
   does move during the hold. **The anchoring code needed no change.**
4. **The event tap dies while the key is held.** The synthetic `hotkey-up`
   still dispatches `push-to-talk-up`, the recogniser lets go of the
   microphone, and the words it did hear still become the question.
5. **The microphone is denied at the moment of the press.** `error`, with the
   adapter's own sentence — and then the same question typed from `error`, and
   answered. §16's fallback is demonstrated, not asserted.
6. **macOS credits Pilot's permissions to something else** (runbook follow-up
   12). The tap is never started, the panel says why, and typing still works.
7. **Where the audio would go** (runbook follow-up 13): the real adapter's
   `disclosure()` reaching the panel's gate state, on device and not.
8. **What none of it proves**, printed by the demo itself.

In the app, the same thing by hand — the whole real stack, on Linux, against the
stub (use the long `PILOT_HELPER_STUB` from the PR-028 section above, and add a
scripted tap and recogniser):

```sh
PILOT_HELPER_STUB_PATH="$PWD/packages/platform-mac/test/support/helper-stub.ts" \
  PILOT_HELPER_STUB='{"permissions":{"screen-recording":"granted","accessibility":"granted","microphone":"granted","speech-recognition":"granted"},"hotkeyScript":[{"key":"down"},{"key":"up"}],"speechInput":{"scripts":[{"steps":[{"on":"start","emit":[{"type":"partial","transcript":"what does this"}]},{"on":"stop","emit":[{"type":"final","transcript":"What does this do?"}]}]}]}}' \
  PILOT_LOG_LEVEL=debug pnpm dev
```

`hotkeyScript` replays on every `hotkey.start`, and the first one happens at
launch — so the tap presses and releases itself once, before a window has been
picked, and the panel shows a spoken question going through with no key to
press. Watch `desktop.main.voice` at `debug` for the mapping. On the build with
no helper (a plain `pnpm dev` on Linux) the fakes stay, and PR-010's fixtures
still reach every state without editing source:

```sh
PILOT_HOTKEY_FIXTURE=permission-missing pnpm dev      # no way to speak
PILOT_HOTKEY_FIXTURE=permission-unattributed pnpm dev # PR-011's verdict refuses voice
PILOT_SPEECH_DISCLOSURE=remote pnpm dev               # the audio would leave the Mac
```


## Demo (PR-033 — spoken response)

```sh
pnpm demo:speak                             # headless walkthrough, no display needed
```

**This closes the voice loop.** PR-032 made Pilot hear; PR-033 makes it speak.
The last fake boundary in `docs/system-design.md` §5 went with it —
`createSilentSpeechOutputAdapter` is deleted, and `MacSpeechOutputAdapter`
(PR-014) over `AVSpeechSynthesizer` drives the machine's `speak` and
`stop-speech` instead. Nothing changed inside `@pilot/interaction`: PR-026's
`SpeechOutputBinding` already cuts an answer into `<speechId>#<n>` chunks, plays
them in order and reports one completion for the whole answer, and PR-033 hands
it a different adapter and nothing else.

`apps/desktop/src/main/speech-runtime.ts` is the new code, and it exists for one
rule: **no `error` ever leaves the speech-output seam.**

| what the synthesiser did | what the machine is told |
| --- | --- |
| `started` / `finished` / `stopped` | the same event, with the same chunk id |
| `error` for a chunk | `finished` for that chunk — silent, and the stream carries on |
| `speak()` rejected | `started` then `finished` for that chunk |
| there is no synthesiser (no helper, or no installed voice) | `started` then `finished` for every chunk |

That is not defensiveness. The interaction table's `speech-failed` row goes to
`error` **and tears the run down with it**, so a synthesiser failing on chunk 2
of an answer the model is still streaming would abort the run and lose the rest
of the reply — the opposite of §16's "TTS fails → continue showing streamed
text". Every silenced chunk is counted and logged; none of them costs the
answer.

**Read this first.** `docs/implementation.md`'s demo for PR-033 — "hear the
answer while it also streams in the panel" — **is only half runnable here**:

- **Nothing has ever been spoken aloud.** There is no macOS, no
  `AVSpeechSynthesizer`, no voice and no audio device, and the Swift that would
  speak has never been compiled (runbook §5 amendment 8). Every `started`,
  `finished`, `stopped` and `error` is the Node helper stub answering a script.
- **No model is real** (`docs/handoff.md` §2). Pi's faux provider, scripted.

The walkthrough prints eight sections:

1. **The boundary that changed**, and the voices the platform reports.
2. **Ask, and the answer is spoken while it streams** — three sentences, three
   utterances, in order, and the panel's *Speaking* indicator going up once and
   down once for the whole answer.
3. **The per-chunk identifiers, read off the wire** (runbook follow-up 5). Every
   `speech.output.speak` matched against `speechChunkId(stream, n)`, zero
   callbacks discarded as `unknown-chunk`, and the answer reporting completion.
   This is the way this PR fails silently, so it is checked at the protocol.
4. **The synthesiser fails mid-answer** (§16) — and the answer is still there,
   complete, out of `error`, with the text box live. Then a Mac with no voice at
   all, which asks the platform for nothing.
5. **`stop()` for a stream the synthesiser never started** (follow-up 15): a
   no-op, not an error.
6. **Interrupting speech**, measured at this seam against §17's 300 ms budget —
   command in, synthesiser told.
7. **A model that goes quiet mid-sentence** (follow-ups 6 and 25): the same
   answer with and without `createTimeoutScheduler()`, which the app now passes.
8. **What none of it proves**, printed by the demo itself.

In the app, the same thing by hand — the whole real stack, on Linux, against the
stub. The synthesiser needs a script that *finishes*, or the first answer leaves
the panel in `speaking` for ever:

```sh
PILOT_HELPER_STUB_PATH="$PWD/packages/platform-mac/test/support/helper-stub.ts" \
  PILOT_HELPER_STUB='{"permissions":{"screen-recording":"granted","accessibility":"granted","microphone":"granted","speech-recognition":"granted"},"speechOutput":{"scripts":[[{"type":"started"},{"type":"finished"}]]}}' \
  PILOT_LOG_LEVEL=debug pnpm dev
```

Watch `desktop.main.speech-out` at `debug`, and the `speech output` line at
startup: `real=true available=true` means there is a synthesiser with a voice,
`silent` in the `shell ready` line means this build reads its answers instead of
speaking them. On a plain `pnpm dev` on Linux there is no helper and therefore
no synthesiser, so every answer is silent — the same code path a Mac with no
installed voice takes.
## Demo (PR-034 — the complete voice screen-grounding flow)

```sh
pnpm demo:flow                              # headless walkthrough, no display needed
```

**This PR adds no capability.** PR-028 through PR-033 built every boundary the
MVP scenario needs; `docs/mvp-01-point-ask-hear.md` §2 asks whether they hold
together, and this is that question answered as **one trace** through the
shipping composition — not a bespoke harness. In order, in a single run:

1. a window is **selected**, and only that window is watched (`capture.start`
   read off the wire, and a frame stamped with the other window refused);
2. the **pointer is anchored** at the moment of the question — after crossing
   out of the window and over another application's window while the key is
   held, which only a spoken question can produce;
3. a **spoken question is transcribed**, partial by partial, into the panel;
4. the model **calls `observe_screen`**, and the machine passes through
   `observing-screen`;
5. a **policy-checked image** reaches it — a 1280×800 window frame and a 640×640
   pointer crop, really decoded, cropped and encoded;
6. the answer **streams** into the panel;
7. …and is **spoken in order**, sentence by sentence, as `<speechId>#0`, `#1`,
   while the text is still arriving;
8. a second press **interrupts it mid-answer**, and the follow-up is answered on
   the same conversation with no stale chunk following.

The §7 rows the trace walked are read back out of the recorded
`PilotViewState` path rather than narrated, and six invariants are then checked
**on that same trace**: selected-window-only, the capability gate (which ran
before a single provider request), no image bytes in any log line or written
anywhere under the repository, no accessibility target outside the selected
window, the unknown-pointer sentinel never reaching the model as a coordinate,
and the §16 text fallback. Section 3 is a refusal the user can carry on past —
macOS crediting the grants to the helper, so voice is refused *and* the look is
refused, and a typed question is still answered and still spoken.

**Read section 4 of the output before quoting any of this.** It lists
`docs/mvp-01-point-ask-hear.md` §18's acceptance rows one by one, and against
the Node helper stub and Pi's scripted faux provider the honest answer is
**A-01, A-03, A-08, A-11 and A-14 in part; the other ten not at all**. There is
no macOS here, no key has been pressed, no microphone opened, no word spoken
aloud, and no model chose to look. PR-043 owns running the matrix; this owns the
single trace. The Mac run that settles it is `docs/handoff.md` §1 step 14.

In the app, the same thing by hand: the PR-032 and PR-033 stub configurations
above, combined — a scripted tap, a scripted recogniser and a synthesiser script
that finishes — and then a question that needs the screen.

## Demo (PR-035 — end-to-end interruption)

```sh
pnpm demo:interrupt-flow                    # headless walkthrough, no display needed
```

PR-034's trace interrupts an answer that is being **spoken**, which is the easy
half. This walkthrough is the hard half — the states where an interruption has
something to *unwind* rather than merely something to stop — and it settles the
last open design question in Phase 3 (runbook §8 follow-up 14).

**The decision: an interruption aborts the run, in every state, including while
`observe_screen` is in flight.** PR-006 chose `steer` there so a capture could
unwind. With the real `PiAgentSession` that is wrong three ways: a steer does not
*end* the run, so the replacement question meets `run-already-active`; the
steered run keeps producing output the machine has already forgotten; and the
capture the steer was meant to protect **completes**, putting an image of the
screen into the model's context for a question the user has replaced. Aborting is
what unwinds it — `observe_screen` checks the run's `AbortSignal` before it
captures and discards a result that arrives after it, `ScreenContextService`
races the platform capture against the same signal, and
`PiAgentSession.interrupt('abort')` waits for Pi to go idle so no run is left
holding the conversation.

Four cases, each through the shipping composition:

1. **while the model is looking** — a fresh capture genuinely in flight
   (`moment: 'current'`, the helper told to take 1 200 ms over `capture.pull`),
   interrupted 1 ms after the press and cancelled ~1 190 ms before the helper
   answered. No frame reaches the ring, no image reaches any prompt, the tool
   result reads `"failure":"cancelled"`, and **the replacement question is asked
   and answered** with no `run-already-active`;
2. **two interruptions in quick succession** — three questions, two
   interruptions, one answer spoken to the end, with the sentence queued behind
   each interrupted one dropped rather than deferred;
3. **between `run-completed` and the first spoken word** — the answer exists,
   the synthesiser has accepted it, not a syllable has been produced, and the
   key goes down there;
4. **where each abandoned run ended** — `run-failed` after a cancelled tool
   call, `run-aborted` after a cancelled stream, both discarded as `stale-run`.
   Read that first one twice: the `run-failed` cell goes to `error` and writes
   `lastError`, so the identity guard running *before* the transition table is
   the only thing between an interruption and a user-visible failure about a
   question they already replaced.

Late output is then checked in the three places it could resurface: the panel
transcript (read from the one `PilotViewState` stream the renderer subscribes
to — every abandoned answer still reads exactly as far as it got, §16), the
synthesiser (read from `speech.output.speak` **off the framed wire** — no
superseded stream ever speaks again), and the diagnostics (every discarded
result is a rejection or a binding diagnostic, and `lastError` is `(none)` in
every section).

**On the timing, read section 5 of the output.** It reports ~1 ms from the
machine accepting `push-to-talk-down` to `speech.output.stop` crossing the pipe,
and then says what that is not: it is Pilot's half of §17's 300 ms, on an idle
Linux box, once. **No `AVSpeechSynthesizer` has ever run here and no sound has
ever been stopped** — the helper dispatching to `stopSpeaking(at: .immediate)`,
the synthesiser draining and the audio device going quiet are all unmeasured,
and they are the part a person in the room would actually hear. The Mac run that
settles it is `docs/handoff.md` §1 step 15, and it settles it by ear.

## Demo (PR-036 — bounded multi-turn conversations)

```sh
pnpm demo:memory                            # headless walkthrough, no display needed
```

Nine screen questions on **one** conversation, while the screen changes under
them twice — first its content (same window, new scene revision), then the
window itself (a new scene id, which is §11's third compaction trigger). It is
the first thing in this repository that writes a file the user would keep: a
real SQLite session database in a real temporary directory, opened, restored,
closed and finally scanned byte by byte.

Five claims, each read off the objects the app itself uses rather than narrated:

1. **Images stay bounded.** Counted as `"type":"image"` blocks in the requests
   the provider actually received. Nine observations were taken, each producing
   a full frame *and* a pointer crop, and **no request ever carried more than
   two** — §10's `maxActiveFullFrames: 1` plus `maxActivePointerCrops: 1`. The
   transcript grows by four messages a turn; the provider-facing context stops
   growing. That gap is the whole of §11.
2. **The text survives.** Every one of the nine questions is still reachable in
   the last request — in one of §11's six retained turns, or quoted inside the
   summary that replaced its turn — and again after a relaunch, read off the
   first request the restored session sent.
3. **No stale screen is offered as current.** Every replacement record is
   past-tense and scene-stamped and ends "not a description of the screen now";
   once the scene has moved, it also says *where it went*
   (`…the screen has since moved to scene-b03d…/revision-1`).
4. **Compaction fires and is visible.** Three folds, printed with their triggers
   and reaching PR-010's diagnostics ring as `context-tokens-before` /
   `context-tokens-after`. The `context-compacted` event carries the summary
   *text* and it is deliberately never recorded: `AgentTelemetrySink` has one
   method and it takes a number (§17).
5. **The conversation can be forgotten.** `clear-conversation` — the panel's own
   command — empties the panel, the model's context *and* the file: the demo
   greps the database afterwards for the questions, the answers and the
   observation records, and finds none of them, because `clear()` reclaims the
   freed SQLite pages rather than leaving the text past the logical end of the
   file.

Plus the lifecycle those depend on. The store is opened before the session
exists and closed on `before-quit`, and a **second opener meets the SQLite
writer lease**: the demo prints the refusal exactly as the panel shows it —
`code: internal`, `details.reason: writer-lease-held`, and *"Pilot is already
open in another window. Close it, or wait up to 30 seconds if it stopped
unexpectedly."* Nothing retries and nothing deletes the database; the lease
expires on its own.

**The §11 context budget no longer comes from the model's own claim.**
`main/context-window.ts` believes a hosted endpoint and caps a loopback one at
32 768 tokens, because a local model's advertised window is a configuration
value rather than a measurement, and §11's 60% trigger is measured against it —
believe an inflated number and compaction never fires. The development profile
(Pi's faux provider, 128 000 tokens against `http://localhost:0`) takes the
capped branch, so this is the path the app runs on today. `PILOT_CONTEXT_WINDOW`
overrides it.

**Read section 8 of the output before quoting any of this.** The strongest
limit is not that there is no macOS: it is that **a scripted provider cannot
make a stale-screen claim**, so what sections 3 and 4 check is Pilot's *input* to
the model — the images each request carried, and the words the replacement
records used. Whether a real model reads a past-tense, scene-stamped record as
history is the actual requirement, and it is untested. The Mac run is
`docs/handoff.md` §1 step 16; the model run waits on §2.

In the app, the same thing by hand — persistence is on by every `pnpm dev`.
Ask a few questions, quit, relaunch, and ask what you asked first:

```sh
PILOT_LOG_LEVEL=debug pnpm dev
```

The `durable conversation opened` line prints the directory and
`restored: <n>`; the `shell ready` line repeats `durable`, `restored` and
`contextWindow`. `restored: 0` after a real conversation means the transcript is
on disk and the model was never told about it, which is the failure runbook
follow-up 20 (b) exists for.
