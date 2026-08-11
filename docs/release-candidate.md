# Pilot MVP 01 — release candidate

Status: PR-044, the last PR of the delivery plan
Date: 2026-08-11
Commit: the tree this document is committed on

You asked for the confirmations you owe to be collected into one document. This
is it. It is written to be read in ten minutes by somebody who has not followed
the last fifty pull requests, and it is written to be believed — which means the
uncomfortable parts come early rather than in an appendix.

---

## 1. What Pilot is, and what state it is actually in

Pilot is a macOS menu bar application. You pick one window for it to watch. You
hold the Right Option key, ask a question out loud about something you are
pointing at in that window, and let go. Pilot takes a picture of that window at
the moment you asked, works out what your pointer was on, hands both to a
language model, and reads the answer back to you while the text appears in a
small floating panel. Interrupting it is holding the key again. It remembers the
conversation across a quit, and it never looks at any window but the one you
chose.

All of that is built. Every one of the 44 planned pull requests is merged. On
this Linux machine the whole thing runs end to end as one trace: `pnpm demo:flow`
walks the scenario above — window selected, pointer anchored at the instant of
the question, spoken question transcribed, model calls `observe_screen`,
policy-checked image returned, answer streamed into the panel and spoken
sentence by sentence, interrupted mid-answer, follow-up answered on the same
conversation — and it passes. 2 309 tests across 157 files pass. Lint,
typecheck, build, packaging, three separate smoke checks of the *packaged*
bundle, the privacy audit and the acceptance harness all pass, and they pass
from a `git clone` of this commit into an empty directory.

**And none of it has ever met the world.** There is no Mac anywhere in this
project's history. The Swift helper that does the actual screen capture, pointer
reading, key tapping, speech recognition and speech synthesis has **never been
compiled**. No pixel has ever been captured, no key has ever been pressed, no
second of audio has ever been recorded, nothing has ever been spoken aloud, no
`.app` has ever been built or signed or launched, and no request has ever left
this machine to any language model. Every screen in every test is a synthetic
PNG this project drew for itself; every transcript is a string a stub was handed;
every model answer is a string this project scripted.

So the honest summary is: **the machine is fully assembled and has never been
switched on.**

### The Phase 5 gate, clause by clause

`docs/implementation.md`'s Phase 5 gate has three clauses. Here is the verdict
on each.

> *"The packaged application meets the MVP definition of done or documents an
> explicitly accepted exception."*

**Met only as the second half.** The packaged application does **not** meet the
definition of done and cannot on this machine. What is delivered instead is the
complete, explicit list of exceptions, each traceable to a cause:
`docs/known-issues.md` §1, eight of them — no notarization (no Developer ID
account, your decision), ad-hoc signing only (same cause, and it means every
rebuild re-asks for every permission), no macOS bundle ever built or launched,
no CI (your decision), a grounding metric that is a manual checklist which has
never been scored, no acceptance criterion fully verified, A-09's degraded mode
never tested against a real TCC or a real model, and no way to choose a model
from inside the app. **Do not read this clause as passed.** It is discharged by
enumeration, not by achievement.

> *"All acceptance evidence is committed."*

**Met.** The evidence is an executable harness rather than a checked-in run log
— `pnpm acceptance` over `apps/desktop/src/acceptance/`, with the thirty
grounding cases as data in `grounding-cases.ts`. It is committed, and it
re-derives from a clean checkout: I cloned this commit into an empty directory
with no `node_modules`, ran `pnpm install --frozen-lockfile`, `pnpm build` and
the walkthroughs, and everything reproduced. `pnpm acceptance` exits 0.

**Read the banner it prints, not the exit code.** Exit 0 means "no criterion has
an executed check that failed". It does *not* mean the acceptance run passed.
The distribution is **0 verified, 13 verified-in-part, 0 failed, 2
blocked-on-mac** across A-01…A-15; 51 pass-condition checks, 35 executed here,
16 waiting on a Mac (10), a real model (5) or both (1).

> *"There are no known privacy, data-retention, or unsafe stale-output
> defects."*

**Met, and the word doing the work is "known".** This is not asserted; it is
checked. `pnpm demo:privacy` decides 21 claims from artefacts rather than from
accessors — the raw bytes of a real SQLite conversation while it is open *and*
after it closes, the log records a sink would actually receive, the base64 in
every provider request decoded and its PNG header read, both credential files
and their modes, and `$HOME` listed before and after and diffed — with all ten
of its byte scanners proved against positive and negative controls before any of
them is believed. Result: 20 held, 1 unprovable, 0 failed. All five retention
occasions are reachable, name themselves correctly, and empty the buffers rather
than merely stopping the reads. Three real defects were found in Phase 5 and all
three are fixed, including a credential in `PILOT_LOCAL_BASE_URL` that was
reaching the durable transcript on disk.

The one unprovable claim is structural and worth knowing: **the log redactor
matches on key name, so it cannot see a secret hidden in a value.** Three shapes
are demonstrated passing through it on every run. That is why every check reads
the emitted records rather than trusting the redactor.

What "known" rests on is a Linux box with no Mac, no model, no credential, no
microphone and no pixels. `docs/known-issues.md` §3 sets that out in full,
including the seven privacy properties only your Mac can establish — among them
the one that would be a hard blocker if it went the wrong way: whether
`safeStorage` really seals the credential. On Linux it cannot, so `protected:
false` is the only value this machine can produce, and `protected: false` on a
Mac must not ship.

---

## 2. What has never been verified

This is the headline, and it deserves to be stated without softening.

**No macOS.** Not once. `swift build` has never run against
`packages/platform-mac/native`. Every line of Swift in this repository —
ScreenCaptureKit capture, `AXUIElementCopyElementAtPosition` hit testing,
`CGEventTap` key tapping, `SFSpeechRecognizer`, `AVSpeechSynthesizer`, the TCC
attribution probe — has been written, reviewed and typechecked by a Node stub
that speaks the same framed protocol, and has never been compiled by a Swift
compiler. A syntax error would be news.

**No compiled helper, therefore no permission has ever been asked for.** No TCC
prompt has ever appeared. The oldest open question in the project is still open:
when Pilot asks for Screen Recording, does macOS credit the grant to `Pilot.app`
or to the spawned `PilotHelper`? Everything about the packaging is configured
for the first answer and **nobody knows**. If it is the second, the fix is a
design change — the helper has to become a proper `.app` inside
`Contents/Library/` — not a setting.

**No model.** Every provider request Pilot has ever made went to Pi's faux
provider or to a stub HTTP server written for the tests, containing no model at
all. Nothing has ever been signed in to. No API key exists here. No screen image
has ever left this machine.

**No microphone, no speaker, no keystroke.** Nothing in this project has ever
recorded a second of audio, spoken a word aloud, or observed a key being
pressed.

**No real pixels.** Every frame is a synthetic screenshot Pilot drew for itself.
The decode, the crop, the resize and the encode are real code doing real work;
the subject is not a screen.

**No signed application.** `codesign` has never run. No `.app` exists. The
entitlements files, the hardened runtime, the usage strings and the helper's
embedded `Info.plist` are configuration that has never been applied to anything.

### And therefore the two questions the product turns on are untested

Pilot exists to do two things, and neither has ever been observed:

1. **Does a model look when it needs to?** `docs/system-design.md` §11's premise
   is that the *model*, not application heuristics, decides when its view of the
   screen is stale and calls `observe_screen` again. Every time a model has
   "decided" to look in this repository, the decision was a line in a script.
2. **Does it answer about the control you were pointing at?** The plan's release
   gate is ≥90% correct grounding across thirty curated cases. All thirty are
   built and all thirty run — but only the *input* side: the anchor, the crop,
   the element, the envelope. 23 of the 30 report their verdict as pending a
   model. **There is no grounding-accuracy number. Not 90%, not any figure.**
   Producing one against a scripted provider would measure the script, and would
   be the single most misleading number this project could publish.

Everything else in this document is detail. That paragraph is the state of MVP
01.

---

## 3. What you have to do, in priority order

Two batches. `docs/handoff.md` §1 is 25 steps on your Mac; §2 is the Codex
sign-in. Both are written as runnable commands with, for each one, what a good
answer looks like and what a bad one looks like. Total hands-on time is roughly
**11 to 13 hours**, and it does not have to be one sitting — the ordering below
is designed so that each block is worth doing even if you stop after it.

### The single step that buys the most certainty per minute

**Step 1: `swift build --package-path packages/platform-mac/native`. Ten
minutes.**

It is the cheapest step in the entire list and it gates eighteen of the other
twenty-four. Nothing about the Swift helper has ever been compiled, so this is
the one place where a plain, uninteresting mistake — a dropped comma, a
duplicated property, a missing brace — could be sitting in the file that
everything else depends on, and merging three parallel lanes into one Swift file
is exactly how those get in (`docs/runbook.md` §8, cross-lane issue 8, is the
record of four such defects that a textual merge introduced and no gate here
could see). If it compiles, two thirds of the list becomes possible. If it does
not, send the compiler output; it gets fixed, not worked around.

**The runner-up, and you can do it tonight on any machine: step 17, a real local
model.** About an hour, mostly downloading weights. It needs no Mac and no Swift
helper — `ollama serve && ollama pull qwen2.5vl:7b`, then
`PILOT_LOCAL_BASE_URL=http://127.0.0.1:11434/v1 pnpm dev`. It is the only step
that can touch the *other* half of the unknown: it makes a real model look at a
real image and answer, which is the first time either of the two questions above
gets asked. It also unblocks the model half of the caveat attached to steps
10 through 16.

If you can only spend one evening, do step 1 and step 17.

### Block A — does the native half exist at all? (~1 hour, no prompts)

Steps 1, 2, 3, 4. Compile the helper, run the transport demo against the real
binary, build a bundle containing it, and look at the desktop shell with your
eyes for the first time. No permission prompt, no microphone, no noise. The
value is that a failure anywhere in here is a *build* problem, cleanly separated
from the "does macOS trust us" question that follows.

### Block B — does macOS trust it? (~1.5 hours, prompts for everything)

Steps 5, 6, 8, 9, 7 — in that order, and **step 5 first**, because without a
Screen Recording grant step 8's capture failure would look like a capture bug
rather than a missing permission. Step 5 is the one that answers the attribution
question; screenshot the prompt, because *what it names* is the answer.

### Block C — does the product work? (~3.5 hours, prompts, microphone, noise)

Steps 10, 11, 11b, 12, 13, 14, 15, 16. Each has a stub-driven walkthrough that
already passes here, so run that first: a difference on the Mac is then a
difference in the *platform*, not in the wiring. Step 14 is the MVP scenario —
point, speak, hear, interrupt, follow up — and it is the run this product exists
for. Four things have to be true together and the fourth is the one nothing can
fake: the transcript is what you said, the answer is about the control you were
pointing at rather than the window in general, the text and the voice agree, and
**the first word is spoken before the last word is written.**

### Block D — a real model (~1 hour, no Mac needed)

Step 17, and then step 19 (§2, the Codex sign-in — about 30 minutes, needs a
ChatGPT Plus/Pro account and the device-code flow, not browser login). Doing
either one turns every "NOT REAL: no model" caveat in blocks C and E into a real
result.

### Block E — does it fail safely, and does it keep anything? (~2 hours)

Steps 18 (really revoke a permission, really lock the screen, really log out,
really kill the helper, really point it at a DRM window), 21 (the manual disk
inspection: what Pilot actually wrote under `~/Library/Application Support/`,
and whether any of it is a picture), 24 (degraded grounding under a real
revocation), 20 if you want to try a real API key.

### Block F — the release questions (~4 hours)

Step 22 (package it, sign it, install it, and **start it by double-clicking in
Finder with no terminal anywhere** — nine parts, and part (g) is the attribution
question), step 25 (two minutes: read the first thing the panel says on a real
first launch — nobody has ever seen that row), and step 23, which is the
big one: the thirty grounding cases by hand against System Settings, Safari,
Mail and Notes, scored. **Step 23 is where the 90% number comes from and it does
not exist until you run it.** Budget three hours and do it last.

---

## 4. Decisions waiting on you

Everything below was decided on your behalf under the standing instruction to
use my own judgement, and everything below is reversible. You asked for
recommendations rather than open questions, so each one has a recommendation
firm enough to act on by replying with a yes or a name.

The full list with the original reasoning is `docs/handoff.md` §4; there are
about thirty entries and most of them are settled well enough that raising them
would waste your time. These are the ones where your answer would actually
change something.

### 4.1 Answer these before the Mac batch — they change what you will be testing

**D-01 — Interrupting Pilot while it is *looking* throws the observation away.**
A push-to-talk that lands while `observe_screen` is in flight aborts the
capture; Pilot does not keep or retry the frame it was in the middle of taking.
Correct when you meant to replace the question, wrong if the key was stuck.
→ **Recommendation: keep it.** The alternative was found to be backwards during
PR-035 — a "steer" leaves the capture running and appends its image to the
context for a question you have replaced. One line in `interruptModeFor` if you
disagree.

**D-02 — Pilot retries a failed observation exactly once, and only if the screen
has not changed.** Everything else becomes "ask again" with a sentence saying
why. → **Recommendation: keep it.** A retry that succeeds against a screen you
have moved past is a confident wrong answer, which is worse than the failure it
replaced. Revisit only if the Mac batch shows benign transient capture failures
being common.

**D-03 — Observation has two switches, not one:** start/stop ("may Pilot watch
this window at all") and pause/resume ("suspend everything, including the
agent"). → **Recommendation: keep both for MVP 01, and revisit after you have
used it.** Collapsing them later is easy; splitting them again is not. This is
the one on the list most likely to feel wrong in your hand rather than on paper.

**D-04 — Choosing a window starts watching it.** Selecting a window is treated
as consent to watch it, so capture begins. → **Recommendation: keep it.** It is
what the shipped transition table does and what the panel already tells the user;
the alternative adds a second click to the most common action.

**D-05 — A model that goes quiet mid-answer speaks what it already had, about
1.2 s later, rather than waiting for the run to end.** → **Recommendation: keep
it.** It is opt-in machinery that is now switched on, and the alternative is
audible dead air.

**D-06 — When the synthesiser fails, the answer stays on screen and nothing is
heard, and the user is not told.** → **Recommendation: change this, but not
now.** The behaviour (never lose the answer to a speech failure) is right; the
silence is the problem, because a Pilot that cannot speak and a Pilot that is
broken look identical (`docs/known-issues.md` KI-04). It needs a non-fatal
notice surface in the panel, which is small but is new UI. **Decide after step
13**, when you have heard what a working one sounds like.

### 4.2 Model and provider

**D-07 — There is no model picker.** Which model answers is an environment
variable, or a line in `~/Library/Application Support/Pilot/pilot.env` for a
double-clicked app. → **Recommendation: accept it for MVP 01 and build the
picker first in MVP 02.** It is the largest single "this is not a finished
application" gap left (`docs/known-issues.md` KI-02), and building it now means
UI work in three profiles' surfaces with no way to test any of them against a
real provider. `ModelProfileStore` was written for it and is waiting.

**D-08 — An API key that a provider rejects is *not* deleted.** Pilot stops
using it and says so, but the stored credential stays. → **Recommendation: keep
it.** Providers return 401 for suspended accounts, regional blocks and bad
clocks; deleting a key you may have to re-paste from a password manager on the
strength of one HTTP status is not a trade Pilot should make silently.

**D-09 — With no `safeStorage`, Pilot stores nothing rather than storing a key
in plaintext.** → **Recommendation: keep it, and treat the opposite as a
blocker.** If step 21 (e) shows `protected: false` on your Mac, that is a
release blocker, not a note.

**D-10 — A capability probe runs on every launch and costs one text-only
request.** It is what makes "this model can use tools" a measurement rather than
an assumption. → **Recommendation: keep it on by default.** The alternative is
how a user ends up with a confident answer about a screen the model never saw.
If step 17 (g) shows it making launch feel slow, it can move behind the first
question.

**D-11 — A local endpoint's advertised context window is capped at 32 768 tokens
however large a number it claims; a hosted one is believed.** → **Recommendation:
keep the cap until step 17 (d) measures where a real local model actually starts
losing the thread.** That measurement is the only thing that should move it, in
either direction. `PILOT_CONTEXT_WINDOW` overrides it meanwhile.

**D-12 — Compaction summaries are extractive** — quoted and derived from the
transcript — rather than model-generated. Free, cannot invent a screen it never
saw, and asserted by test. The trade is that a summary of a very long
conversation reads as a list rather than as prose. → **Recommendation: keep it
for MVP 01.** Swapping in a model-backed summariser later is contained: it is a
pure function of a typed input.

### 4.3 Things I would leave alone, listed so you know they were considered

**D-13 — `QuestionEnvelope.pointer` carries a `-1,-1` sentinel rather than
`null`.** → **Recommendation: close this question; keep the sentinel.** It never
reaches the model as a coordinate (the envelope renders it as `pointer:
unknown`, and a test reads the provider's own request to prove it). Spending a
contract PR on a shape preference that no user can observe is not worth it now.

**D-14 — Accessibility *values* are off by default** — Pilot reads a control's
role and label but not its contents unless a caller opts in, and never for a
secure element. → **Recommendation: keep it.** The secure-field flag that would
keep a password out of a value is best effort and has never fired against a real
password field.

**D-15 — "Look now" shares the observation rate limit with the model.** Pressing
it twice while Pilot is already looking gets a refusal. → **Recommendation: keep
it.** The limit exists to bound how much of your screen leaves the machine and
would be meaningless if a second caller had its own budget.

**D-16 — The durable transcript records *that* an observation happened and of
which window, with the image replaced by a placeholder.** The pixels never reach
disk; the audit metadata does. → **Recommendation: keep it.** It is what
`docs/system-design.md` §11 asks for and what makes a restored conversation
legible.

**D-17 — Voice input refuses to start if the TCC attribution verdict is bad.**
→ **Recommendation: keep it.** The failure is loud rather than silent — the
shortcut reports itself unavailable and the text box stays live. Revisit only if
step 12 shows the verdict being wrong on a real Mac.

### 4.4 Decisions I have taken in this PR, which you can reverse

**D-18 — `pnpm acceptance` is *not* in the per-merge gate.** It is in a new
release checklist (`docs/runbook.md` §6) instead. The same harness already runs
inside `pnpm test`; what the checklist adds is the printed verdict distribution,
which a human reads at a release and nobody reads at a merge. (This closes
runbook follow-up 50, which was explicitly assigned to this PR.)

**D-19 — Every direct dependency is pinned to an exact version, and `engines`
gained an upper bound** (`node >=24 <25`, `pnpm >=10.33 <11`). Nothing else
changed: the resolved dependency graph is byte-identical, and the lockfile diff
is 24 specifier lines. Say if you would rather keep caret ranges for tooling.

---

## 5. Known issues and accepted exceptions

The full document is `docs/known-issues.md`. It accounts for **every** open
follow-up and hazard in `docs/runbook.md` §8 — each one is either a known issue,
closed, or explicitly deemed not user-facing with a reason. Nothing is left
dangling.

The count: **eight accepted exceptions** (§1 there), **eighteen known issues**
(sixteen in §2 plus the two provider-profile ones in §5), and **nine open
engineering items that cannot reach a user**, each with the reason why — plus
three rows closed or decided by this PR (follow-ups 8, 13 and 50).

The ones you would notice in the first five minutes of using it:

- **KI-01** — the menu bar item has no icon, and under `LSUIElement` it is the
  *only* affordance a double-clicked Pilot has. It works; it will look
  unfinished. Deliberately not fixed blind.
- **KI-02** — no model picker. You configure Pilot by writing a text file whose
  path the panel prints.
- **KI-03** — with nothing configured, Pilot answers with a stand-in that is not
  a language model. There is now a red alert saying exactly that, in those
  words, above everything else in the panel. **No human has ever seen it**, and
  whether it reads as a warning or as a badge is two minutes of your time
  (`docs/handoff.md` §1 step 25) for the highest-consequence sentence in the
  product.
- **KI-04** — a speech failure is silent and indistinguishable from speech being
  off. See D-06.
- **KI-05** — the 300 ms interruption budget is measured only up to the pipe.
  Whether the *sound* stops in time is unknown and can only be timed by ear.
- **KI-07** — push-to-talk may need Input Monitoring, a permission Pilot does
  not model anywhere. If it does, the fix touches four places. Loud rather than
  silent when it fails.

And the two the release turns on, both accepted exceptions rather than issues:
**E-05**, there is no grounding-accuracy number; and **E-06**, no acceptance
criterion is fully verified.

---

## 6. Where everything lives

| If you want to know… | Read / run |
| --- | --- |
| Where MVP 01 stands | this file |
| What is wrong with it | `docs/known-issues.md` |
| What only you can do, as runnable commands with expected output | `docs/handoff.md` §1 (25 steps) and §2 (Codex sign-in) |
| What was decided on your behalf, and how to reverse it | `docs/handoff.md` §4 |
| What is risky but not yet wrong | `docs/handoff.md` §5 |
| What each PR landed, and what broke while merging | `docs/runbook.md` §8 |
| Traps that already bit, so they do not bite again | `docs/runbook.md` §8, cross-lane issues 1–31 |
| How to run the gate, and how to cut a release artefact | `docs/runbook.md` §6 |
| What the product is supposed to do | `docs/product-spec.md`, `docs/mvp-01-point-ask-hear.md` |
| How it is built | `docs/system-design.md`, `docs/logic.md` |
| What Pi 0.84.1 actually does, as opposed to what the docs assume | `docs/pi-notes.md` |
| Whether the tree is healthy | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` |
| Whether it is acceptable | `pnpm acceptance` — **read the banner, not the exit code** |
| Whether it keeps anything it should not | `pnpm build && pnpm demo:privacy` |
| What it does end to end | `pnpm demo:flow` |
| What it does when things break | `pnpm demo:failure` |
| Whether the packaged bundle is sane | `pnpm package && pnpm verify:package && pnpm smoke:launch` |

### What is frozen

- **Pi**: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai` and
  `@earendil-works/pi-session-backend-sqlite-node`, all exactly `0.84.1`. They
  were already exact and stay that way. Do not use
  `@earendil-works/pi-storage-sqlite-node` — it was renamed for the 0.84 line
  and duplicates the runtime.
- **Electron** `43.3.0`, **electron-builder** `26.15.3`, **electron-vite**
  `5.0.0`, **vite** `7.3.6`, **React** `19.2.8`, **zod** `4.4.3`, **jpeg-js**
  `0.4.4`, **TypeScript** `5.9.3`, **vitest** `4.1.10` — every direct dependency
  in every workspace package is now an exact version rather than a caret range.
- **Node** `>=24 <25`, **pnpm** `>=10.33 <11`, and `packageManager` is
  `pnpm@10.33.0`. `.nvmrc` says `24`.
- **`pnpm-lock.yaml` is committed**, and `pnpm install --frozen-lockfile` is the
  supported install.
- **The Swift package pins nothing because it depends on nothing** — no external
  SwiftPM dependencies, so there is no `Package.resolved` to commit. It targets
  `.macOS(.v13)`, matching `LSMinimumSystemVersion: '13.0'` in the bundle.

### What still floats

- **Transitive dependencies** float in their specifiers and are fixed by the
  lockfile. That is the normal arrangement and the lockfile is the freeze.
- **The Electron runtime binary download** (`apps/desktop/scripts/ensure-electron.js`)
  fetches at install time for the host architecture. Version-pinned; the
  *artefact* is fetched, not vendored.
- **The macOS SDK, Swift toolchain and Xcode version** on whatever Mac builds
  the helper. Nothing here can pin them and nothing here has ever seen them.
- **Whatever model you point Pilot at.** There is no pinned model; the Codex
  profile prefers `gpt-5.5` and falls back through the vision catalogue, and the
  local profile uses whatever your endpoint is serving.

---

## One last thing

If this document has done its job you should finish it able to say, without
hedging, that MVP 01 is **built and unproven**. Not "nearly done" and not
"shipping". The code is complete, the evidence is committed and re-derivable,
the known issues are written down, and every gate that can be run on a machine
without a screen is green.

The remaining work is not more code. It is eleven hours on a Mac with the volume
up, and one evening with a language model, to find out whether any of it is
true.
