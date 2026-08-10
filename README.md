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
open apps/desktop/release/mac-arm64/Pilot.app
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
says so in its own text. Speech (PR-032/033) and observation (PR-028/030) are
still mocked: no screen is read and no sound is made.

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
