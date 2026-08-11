# Pilot MVP 01 — Known issues and accepted exceptions

Status: Live document
Last updated: 2026-08-11 (PR-044)

This is the release-candidate list of everything wrong with, missing from, or
unproven about Pilot MVP 01, written for somebody who has not read the fifty
PRs that produced it.

It has four parts and a ledger:

- **§1 Accepted exceptions** — things deliberately not done. They are not
  defects; they are the price of decisions already taken, and they are what the
  Phase 5 gate's *"or documents an explicitly accepted exception"* clause is
  discharged against.
- **§2 Known issues you would meet as a user** — defects and limitations in the
  build as it stands.
- **§3 Privacy, data retention and stale output** — the gate's third clause,
  answered claim by claim rather than asserted.
- **§4 Not user-facing** — open engineering items, each with the reason it
  cannot reach a user.
- **§5 The ledger** — every open follow-up and hazard in `docs/runbook.md` §8,
  with its disposition here. Nothing is left unaccounted for.

Two things to hold on to while reading. **Almost every issue below is a
statement about a machine nobody has run.** There is no Mac in this project's
history: no compiled Swift helper, no captured pixel, no keystroke, no recorded
audio, no spoken word, no language model, no signed bundle. And **"no known
defect" here means "nothing the evidence we have can see"** — §3 says exactly
what that evidence is.

Severity is about the user, not the engineering:

| | |
| --- | --- |
| **blocker** | ships broken or misleads the user about what Pilot is doing |
| **major** | the product works but a reasonable user hits it and is annoyed or confused |
| **minor** | narrow, cosmetic, or self-explaining when it happens |
| **unknown** | cannot be graded until the thing runs on a Mac with a model |

---

## 1. Accepted exceptions

These are recorded decisions, not surprises. `docs/handoff.md` §3 is the
canonical table; this is the same list in release language.

### E-01 — No notarization. *Accepted; user decision (no Developer ID account).*

Any machine that did not build the app will quarantine it. Installing a copy
needs `xattr -dr com.apple.quarantine Pilot.app` or a right-click → Open.
`docs/handoff.md` §1a is the clean-machine sequence. Unchangeable without an
Apple developer account.

### E-02 — Ad-hoc signing only. *Accepted; same cause.*

`codesign --sign -` hashes the bytes, so **every rebuild is a new TCC subject**
and every permission has to be granted again. This is also why a rebuild is the
cheapest way to reset a bad permission state, and why a *stale* grant surviving
a rebuild would be a much worse finding than a re-prompt (`docs/handoff.md` §1
step 22 (h) is the check).

### E-03 — No macOS bundle has ever been built, signed, installed or launched.

Every line under `mac:` in `apps/desktop/electron-builder.yml`, both
entitlements files, the helper's embedded `Info.plist` and the whole darwin
branch of `scripts/sign-mac.js` are configuration that has never executed.
`pnpm verify:package` checks they are *internally consistent* — a much weaker
claim, and the only one available on Linux. It prints under a `CONFIGURED, NOT
VERIFIED` heading for that reason.

### E-04 — No CI. *Accepted; user decision.*

The commands in `docs/runbook.md` §6 are the only gate, run locally before every
merge.

### E-05 — Grounding accuracy is a manual checklist, and it has never been scored.

The plan's release gate is ≥90% correct grounding across ~30 curated cases
(`docs/mvp-01-point-ask-hear.md` §19). `pnpm acceptance` builds and runs all
thirty, but only the *input* side: what Pilot sends the model — the anchor, the
crop, the element, the envelope. 23 of the 30 report their verdict as pending a
model. **No grounding-accuracy number exists**, and computing one against the
scripted provider in this repository would measure the script.
`docs/handoff.md` §1 step 23 (a) is the procedure that produces the real one.

### E-06 — No acceptance criterion is fully verified.

`pnpm acceptance` today: **0 verified, 13 verified-in-part, 0 failed, 2
blocked-on-mac** across A-01…A-15; 51 pass-condition checks, 35 executed on
Linux, 16 waiting on a Mac (10), a real model (5) or both (1). This is the
honest state of the §19 gate and it is re-derivable at any time.

### E-07 — A-09's degraded grounding mode has never met a real TCC or a real model.

The defect is fixed (PR-044): losing Accessibility now leaves Pilot watching and
tells the model that it cannot name the control. What remains is the two pass
conditions that need a machine — a real System Settings revocation under a
running session, and whether a model given a picture, a point and a
`reduced grounding:` instruction answers about the right control *and repeats
the uncertainty to the user*. `docs/handoff.md` §1 step 24.

### E-08 — The packaged app cannot be pointed at a model from its own UI.

Provider selection is by environment variable, and a double-clicked app has
none. PR-042 added the launch environment file
(`~/Library/Application Support/Pilot/pilot.env`) so a terminal is not required,
and PR-044's model-status row makes the current provider visible and names that
file as the remedy. There is still **no model picker in the panel** — see
KI-02.

---

## 2. Known issues you would meet as a user

### KI-01 — The menu bar item has no icon. *major.* Follow-up 45.

`LSUIElement: true` means no Dock icon and no window on launch, so the menu bar
item is the **only** affordance a double-clicked Pilot has — and it is
`nativeImage.createEmpty()` plus the text `Pilot`. It is findable, and `pnpm
smoke:launch` asserts it exists even from an empty environment, but it will look
unfinished beside every other menu bar item. Deliberately not fixed here:
shipping an untested template image into the one control the user has, on a
platform this repository cannot render, trades a state that demonstrably works
for one nobody can check. Needs a Mac, both `trayIconTemplate.png` and its `@2x`,
and a look with the naked eye.

### KI-02 — There is no model picker. *major.* Follow-ups 39, 40; hazard 28.

Which model Pilot talks to is decided by `PILOT_MODEL_PROFILE`,
`PILOT_LOCAL_BASE_URL`, `PILOT_API_PROVIDER` and friends — read from the
environment, or from `~/Library/Application Support/Pilot/pilot.env` in a
packaged launch. `ModelProfileStore` exists (PR-020) and nothing persists to it,
so the choice is recomputed at every launch. A user with no terminal configures
Pilot by writing a text file the panel tells them the path of. That works and it
is not what a shipped application does.

### KI-03 — With nothing configured, Pilot answers with a stand-in that is not a model. *major, mitigated.* Hazard 28.

A Finder launch supplies no environment, so Pilot falls through to Pi's faux
provider: it starts, opens its database, and answers questions with placeholder
text. PR-044's model-status row is the mitigation — a red `role="alert"` reading
`NOT A REAL MODEL — answers are placeholder text` above the first thing in the
panel, with the remedy and the absolute path of the launch file. **No human has
ever seen that row.** Whether it reads as a warning or as a badge is
`docs/handoff.md` §1 step 25 (a), and it is two minutes of the user's time for
the single highest-consequence piece of copy in the product.

### KI-04 — Speech that fails is indistinguishable from speech that is off. *major.* `docs/handoff.md` §5 (PR-033).

A synthesiser that fails, a Mac with no installed voice, and a build with no
helper all end identically: the answer complete on screen and nothing heard.
This is `docs/system-design.md` §16 honoured to the letter — a synthesis failure
must never cost the answer — and the counter and the log line
(`desktop.main.speech-out`) are the only trace. Nothing in the panel says
"Pilot could not speak that".

### KI-05 — The 300 ms interruption budget is half-measured. *unknown.* `docs/handoff.md` §5 (PR-035).

What Linux measures is the time from the interaction machine accepting
`push-to-talk-down` to `speech.output.stop` crossing the pipe: ~1 ms. Everything
a user actually perceives as "the voice stopped" is after that —
`AVSpeechSynthesizer.stopSpeaking(at:)`, the synthesiser draining its buffer,
the audio device going quiet — and none of it has ever run. A
`stopSpeaking(at: .word)` instead of `.immediate` would finish the current word.
**Do not read a green `pnpm demo:interrupt-flow` as "interruption meets §17".**
`docs/handoff.md` §1 step 15 (b) settles it by ear.

### KI-06 — An interrupted observation is lost, not resumed. *minor, by decision.* Follow-up 14.

Interrupting while Pilot is looking aborts the capture and Pilot does not keep
or retry the frame. Correct for the case the decision was about — the user
replaced the question, so the picture was for a question nobody is asking — but
it also applies to an interruption the user did not mean, such as a stuck key.
Reversible in one line (`interruptModeFor` in
`packages/interaction/src/table.ts`); see the decisions list in
`docs/release-candidate.md` §4.

### KI-07 — Push-to-talk may need a permission Pilot does not model. *unknown, possibly blocker.* `docs/handoff.md` §5 (PR-015/PR-032).

The whole feature rests on a `CGEventTap`, and Pilot assumes Accessibility is
what macOS asks for. Recent macOS also gates keyboard taps behind **Input
Monitoring**, which appears in no `PermissionKind`, no onboarding screen and no
entitlement here. If `docs/handoff.md` §1 step 12 comes back
`unavailable/permission-missing` *after* Accessibility is granted, that is the
answer and the fix touches four places. The failure is at least loud: the
shortcut reports itself unavailable with a sentence and the §16 text box stays
live, so nobody is left holding a key that does nothing.

### KI-08 — Right Option is a live dead-key modifier on some keyboard layouts. *unknown.* `docs/handoff.md` §5.

On layouts where Right Option composes characters, holding it to talk may also
type. Never observed; no key has ever been pressed.

### KI-09 — Password redaction is best effort and may never fire. *unknown, privacy-relevant.* `docs/handoff.md` §5 (PR-013/PR-017).

Pilot promises not to send the contents of a secure field. The detection is
`AXSecureTextField` plus heuristics, and no real password field has ever been
hit-tested. `docs/mvp-01-point-ask-hear.md` §14 says "best effort" out loud, and
the product says so to the user; that is the honest ceiling until
`docs/handoff.md` §1 step 6 runs. The grounding checklist has a password-field
case (`docs/handoff.md` §1 step 23) and it expects `redactionsApplied ≥ 1`.

### KI-10 — The pointer crop covers less of the window on a Retina display. *minor→unknown.* Follow-up 48.

`pointerCropPixels` is 640 **captured** pixels and the capture is not the same
size at both scales, so the same gesture hands the model a crop covering ~640 pt
of window at 1× and ~533 pt at 2×. Nothing is wrong at either scale and the
geometry is correct throughout; it is a policy question `docs/system-design.md`
§10 never asked, and only a real model can say whether the tighter Retina crop
loses context an answer needed.

### KI-11 — A pointer outside the selected window still produces a crop. *minor→unknown.* Follow-up 49.

`docs/mvp-01-point-ask-hear.md` §8 says Pilot must report that state and not
invent a target. It does not invent a target — the element is discarded and the
envelope says `outside the selected window; no element was identified`. But
`view: 'both'` still returns a *picture*: the crop rectangle is clamped into the
frame, so the model receives a close-up of the window corner nearest the
pointer, labelled `pointer`. Whether a model nevertheless describes that corner
as if you had pointed at it is unknown. `docs/handoff.md` §1 step 23 (b) asks
the question three times.

### KI-12 — A force-quit locks the conversation for up to 30 seconds. *minor, by design.* `docs/handoff.md` §5 (PR-023/PR-036).

The session database is single-writer. A relaunch inside 30 s of a crash cannot
open the conversation, and Pilot says so — *"Pilot is already open in another
window. Close it, or wait up to 30 seconds if it stopped unexpectedly."* —
beside a live text box: it still answers, it just will not remember. It clears
itself. **Deleting the database is not the workaround**; if deleting it is the
only thing that helps, that is a defect worth reporting.

### KI-13 — "What changed?" can miss a small, meaningful change. *minor.* `docs/handoff.md` §5 (PR-016).

The content fingerprint is a downsampled perceptual hash. A single toggle
flipping in a large window can fall under its threshold, in which case Pilot
does not register a new scene revision and the comparison has nothing to
compare. Tuned against synthetic screens only.

### KI-14 — A minimised window cannot be selected. *minor, by decision.*

`isOnScreen: false` makes a window unavailable in the picker, with an
explanation; a selected window that becomes hidden raises a warning rather than
stopping. There is no design ruling on this and no evidence about what
ScreenCaptureKit returns for a minimised window.

### KI-15 — Decoding a JPEG source frame misses the 150 ms preprocessing budget. *minor, mitigated.* `docs/handoff.md` §5 (PR-018).

Pure-JS JPEG decode costs ~165 ms for a 1440×960 frame against a 150 ms budget.
Mitigated by the capture path delivering `png` rather than `jpeg`
(`CAPTURE_ENCODING = 'png'`), which also removes the double-JPEG legibility
risk. The number stands for any path that ever reintroduces a JPEG source.

### KI-16 — `api-key-runtime.test.ts` has timed out once under full-suite load. *minor, developer-facing.* Follow-up 47.

One test — *"comes back on a second launch with no environment at all"* — timed
out once, on the first full run after a cold `pnpm install`. It takes 1.02 s in
isolation against a 5 000 ms limit and has been green on every run since,
including this release candidate's. **Do not raise the timeout**; hazard 7 is
explicit about why. Re-run it alone before treating it as a regression.

---

## 3. Privacy, data retention and stale output

The Phase 5 gate says: *"There are no known privacy, data-retention, or unsafe
stale-output defects."* This section is the working, not the claim.

### 3.1 What was actually checked

`pnpm demo:privacy` runs **21 claims** against the shipping composition and
decides each from an artefact rather than from an accessor — the raw bytes of a
real SQLite conversation while it is open *and* after it closes, the emitted
`LogRecord[]` rather than the fields the calls passed, the base64 in every
provider request decoded and its PNG header read, both credential stores' real
files and modes, and `$HOME` plus the repository listed before and after and
diffed. Its ten byte scanners are each proved against a positive and a negative
control **before any of them is believed** (claim A1): a scanner that has
stopped matching reports a clean disk forever and looks exactly like one that
checked.

Result on this tree: **20 claims held, 1 unprovable, 0 failed.**

### 3.2 Retention

All five of `docs/system-design.md` §13's retention occasions — pause,
screen-lock, window-loss, logout, shutdown — are reachable from the shipping
composition, name themselves correctly in the retention log, and each empties
the buffers rather than merely stopping the reads (claims R1, R2; verified by
reading `ScreenStatus.buffer` and `ObservationRuntimeMetrics.pointerTargets`
afterwards, deliberately *not* the guard's own report). `RETENTION_EVENTS` is
compared against the set the audit drives, so an occasion the audit does not
know about is a failure rather than an omission (R3). No image bytes, base64
payload, `data:` URI or audio container header is on disk, live or after closing
(D1, D2), while a canary planted in a question *is* on disk — which is what
proves the disk checks read a file with content in it (D3).

**Two retention items are open and neither retains anything.** Follow-up 37: the
`logout` occasion depends on Electron's `powerMonitor` `shutdown` event, which
nobody has seen fire; if macOS kills the process first, the `before-quit`
shutdown clear does the same clearing under a different name, and what is lost
is the *distinction in the log*, not the data. Follow-up 44: the `shutdown`
clear is not awaited on quit; if Electron exits first the buffers go with the
process, and again what is lost is the log entry that says so. Both are
evidence-quality defects, not leaks. Both are graded **minor** and both are on
the Mac list (`docs/handoff.md` §1 step 21 (g)).

### 3.3 Privacy

One structural limit is reported as **UNPROVABLE** rather than passed, and it is
the honest headline of this section:

> **The log redactor matches on key *name*, so it cannot see a secret in a
> value** (claim L2, follow-up 42). Three shapes are demonstrated passing
> through it on every run: a base URL carrying user information under
> `endpoint`; a provider key pasted into a sentence under `line`; a `data:` URI
> in the *middle* of a string under `cause`.

This is why every disk and log check in the audit reads the **emitted** records
rather than trusting the redactor, and why PR-041 fixed the one live instance at
its source (`scrubUrlCredentials`) instead of widening a pattern. The one live
instance was real and was found here: a credential embedded in
`PILOT_LOCAL_BASE_URL` reached two log fields, the sentence the panel renders,
and — through `AgentRuntimeOptions.blockedBy` — the durable transcript on disk.
It is fixed and claim C3 asserts it. The *general* fix, a value-shaped pass
beside the name-shaped one, is not done.

Credentials: one file, mode 0600 inside a 0700 directory, ciphertext, and no
credential of any of the four profiles reaches a log record (C1, C2). **On
Linux, `safeStorage` does not exist**, so the Codex file in the audit is written
through the plaintext protector — `protected: false` is the only value this
machine can produce and it is the one value that must not ship.
`docs/handoff.md` §1 step 21 (e) is the check, and a `protected: false` on a Mac
is a **release blocker, not a note**.

Policy: no provider request ever carried more, larger or bigger images than
`docs/system-design.md` §10 allows — every `image` block in every recorded
request base64-decoded and its PNG IHDR read (P1). The observation rate limit
holds under pressure and its refusals are visible on the wire (P2). Raw frame
persistence and capture scope are *literal types*, so widening either is a
compile error rather than a configuration mistake (P3).

### 3.4 Stale output

Four independent mechanisms, all verified on Linux:

1. **Identity guards.** Results from stale window selections, scene ids and
   utterance ids are discarded by the interaction machine before they can reach
   the user. PR-035 found this guard doing more work than anyone had noticed:
   it is what keeps a `run-failed` from an interrupted tool call out of the
   user's face.
2. **The question anchor.** `moment: 'question'` answers from the frame that was
   on screen when the question was *asked*, chosen at-or-before the anchor
   timestamp — never a newer frame. Hazard 27 is the record of that ordering
   rule being real enough to break a demo.
3. **Replacement records.** When compaction drops an observation, the record
   left behind is past-tense, names the scene and revision it described, names
   which image went, and ends with *"This is a past record of scene-N at
   revision R, not a description of the screen now"*, naming the scene the
   screen has since moved to when that is known. `pnpm demo:memory` reads every
   one out of the requests the provider received.
4. **Retry says no.** Pilot retries a failed observation exactly once, and only
   while the scene lineage and revision are the ones the request was made
   against. Everything else becomes "ask again" with a reason. A retry that
   succeeds against a screen the user has moved past is a confident wrong
   answer.

**And here is what that rests on.** Every one of those four is a check on
Pilot's *input to the model*. A scripted provider cannot make a stale-screen
claim, so no model has ever been observed reading a replacement record, or
deciding whether an observation is stale enough to look again, or answering from
one. `docs/system-design.md` §11's premise — that the model, not Pilot, decides
when to re-observe — is untested at the only end that matters.

### 3.5 The verdict, stated precisely

**No privacy, data-retention or unsafe-stale-output defect is known.** Three
were found during Phase 5 and all three are fixed: the retention occasion armed
on only one of the app's two command routes; the credential in the local base
URL reaching the durable transcript; and the product's own `retention clear` log
line having three of its six evidence fields eaten by the redactor.

What "known" rests on: a Linux machine with **no Mac, no model, no credential,
no microphone and no pixels**. Specifically unproven, and listed in section 10
of `pnpm demo:privacy`'s own output —

- where the files actually are (`~/Library/Application Support/Pilot/` has never
  existed);
- whether macOS itself keeps a copy (window-server caches, Saved Application
  State, Spotlight, Time Machine — all outside every scanner and outside Pilot's
  control);
- whether the Keychain seals the token (`safeStorage` has never run);
- whether real audio is ever buffered (no microphone has ever been opened, so
  "no audio bytes anywhere" is proved for a run in which no audio existed);
- whether real pixels behave (no real capture of a window containing a password
  field has ever been masked, redacted or measured);
- whether a real provider receives what was counted (no screen image has ever
  left this machine);
- whether a real logout clears (see §3.2).

`docs/handoff.md` §1 step 21 is that list written as runnable commands, with
what a bad answer looks like beside each one.

---

## 4. Open items that cannot reach a user

Each of these is a real open item in `docs/runbook.md` §8. None is a known issue
in the release sense, and the reason is given.

| # | Item | Why it cannot reach a user |
| --- | --- | --- |
| 2 | `QuestionEnvelope.pointer` carries a sentinel (`-1,-1`) rather than `null` | With `renderAnchoredQuestionEnvelope` wired, the sentinel is never rendered as a coordinate — the envelope says `pointer: unknown` and a test reads the provider's own request for the absence of `-1.000`. A shape preference on a `docs/system-design.md` §8 contract, nothing more. |
| 26 | `PiAgentSessionOptions.tools` is `readonly AgentTool<never>[]`, which nothing real is assignable to | A typing defect behind `asSessionTool()`. The composition root contains no cast; widening the field is a deliberate contract change. |
| 29 | `ObservedWindow` should carry `ownerPid` | A latent hazard for the *next* engineer, not for a user: PR-013's two foreign-application defences are conditional on an optional argument, and today's one caller passes it (asserted at the wire). Any new caller of `ground`/`groundFast` must pass it by hand until the field lands. Graded here as a **latent privacy hazard for future work** — see cross-lane issue 12 for what it cost the first time. |
| 30 | The first pointer sample after a border crossing still asks for an element | Nothing leaks: the request is scoped to the selected window's application and the element is discarded (both asserted at the wire). It is one unnecessary hit test per crossing. |
| 32 | `AgentRuntimeOptions.blockedBy` should be consolidated across the three provider profiles | Three lanes each landed the same refusal shape. Consolidating is tidying; the behaviour is identical and correct. |
| 36 | `AuthFacade` is built and nothing in the app calls it | Dead provider-neutral seam. The three profiles each built their own auth path; nothing reads this one, so nothing can misbehave. |
| 40 | `ModelProfileStore` is unwired | Real, and its *consequence* is user-facing — that is KI-02. The store itself is unreferenced code. |
| 41 | PR-037 and PR-039 should reuse PR-038's storage, disclosure and probe | Duplication across three provider lanes, each independently tested. |
| 44 | The `shutdown` retention clear is not awaited | Nothing is retained — the buffers are process memory. What is lost is the log line. See §3.2. |
| 8, 13 | Compaction summary persistence; `SpeechInputAdapter.disclosure()` routing | **Both closed** (PR-023 and PR-032 respectively) and left with unstruck duplicate rows by a parallel merge. Closed in this PR's runbook edit. |
| 50 | Whether `pnpm acceptance` belongs in the per-merge gate | **Decided by this PR: no.** The same evidence already runs inside `pnpm test` via `acceptance-suite.test.ts`; what §6 would gain is the printed distribution, which is worth reading at a release rather than at every merge. It is now in the release checklist (`docs/runbook.md` §6). |

---

## 5. The ledger

Every numbered follow-up in `docs/runbook.md` §8 and every cross-lane hazard,
with where it went. Follow-ups struck through in the runbook are closed and are
not repeated here.

| Follow-up | Disposition |
| --- | --- |
| 1, 3, 4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 31, 33, 35, 43, 46 | Closed in the runbook. |
| 8, 13 | Closed; duplicate open rows struck by PR-044. |
| 2, 26, 29, 30, 32, 36, 40, 41, 44 | Open, not user-facing — §4. |
| 34 | KI, local-model profile — see below. |
| 37 | §3.2 (retention log distinction). |
| 38 | KI, Codex profile — see below. |
| 39 | KI-02. |
| 42 | §3.3 (redactor). |
| 45 | KI-01. |
| 47 | KI-16. |
| 48 | KI-10. |
| 49 | KI-11. |
| 50 | Decided by PR-044 — §4. |

Two provider-profile issues that belong in §2 but only exist once a real model
is configured, so they are stated here with the rest of the ledger:

**KI-17 — The local-model vision probe can be fooled one time in six.** *unknown.*
Follow-up 34. A local `GET /v1/models` reports no capabilities, so Pilot probes:
it shows the endpoint an 8×8 solid swatch and asks the model to name the colour
from a list of six. A blind model that guesses is right ~17% of the time (a
false pass, and Pi *silently ignores* images for a non-vision model, so the
symptom is a confident wrong answer about a screen it never saw). A
vision-capable model that is simply bad at colour naming is refused (a false
fail, and the likelier of the two; `PILOT_LOCAL_VISION_COMPREHENSION=0` is the
escape hatch). Both rates are unmeasured because no real model has ever taken
the probe.

**KI-18 — `supportsTools: true` for the Codex profile is an assertion, not a
probe.** *unknown.* Follow-up 38. Pi carries no tool metadata for any model, so
the profile states it and records the provenance as "a human decided". The
reasoning is that every model in the `openai-codex` catalogue is a Responses
model and the Responses API is a tool-calling API. If the first real session
shows `observe_screen` rejected or ignored, the honest setting is `false` and
the profile degrades to `docs/system-design.md` §12's labelled
accessibility-only mode. One field in `createCodexModelSource`.

### Cross-lane hazards

Hazards 1–31 in `docs/runbook.md` §8 are engineering lessons, not defects: each
records a trap that already bit and how it was closed. Three are live enough to
name here.

- **Hazard 7 (with 27) — three test suites are timing-sensitive under load.**
  `packages/observation/test/bounds.stress.test.ts`,
  `packages/platform-mac/test/helper-transport.test.ts` and (before its fix)
  `apps/desktop/.../codex-demo.test.ts`. Re-run a failure in isolation before
  treating it as a regression, and **do not widen tolerances** — the bound is
  the property under test. Add KI-16 to that list.
- **Hazard 28 — a double-clicked app has no environment, and every provider
  selector in this product is one.** Mitigated twice (the launch file, the model
  status row) and it is KI-02 and KI-03.
- **Hazard 22 — "checking" is not "denied".** A permission being re-read was
  once reported as one withdrawn, stopping observation on every panel open. Read
  a tri-state permission as a tri-state; PR-044's `accessibilityGroundingOf` is
  the same shape and is deliberately not a boolean.
