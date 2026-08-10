# Pilot MVP 01 — Handoff and open items

Status: Live document
Last updated: 2026-08-10

**This file is updated and merged with every PR** (runbook amendment 12). If a
PR raises something the user must decide, do or verify, it lands here in the
same merge — never only in a PR description or a chat message.

This is the single place to look for **things only the user can do**, and for
**decisions taken on the user's behalf** that they may want to reverse. Anything
that could be decided from the docs, the code or a spike was decided and
recorded in `docs/runbook.md`; only genuine external blockers land here.

Everything below is non-blocking for development on Linux. Work continues past
each item using the fallback stated.

---

## 1. Blocked on the user's Mac

None of this can be verified on the Linux development machine. The code is
written and merged; only the verification is outstanding.

Run from a clean checkout on macOS 13+ with Swift 5.9+:

```sh
nvm use && pnpm install

# 1. The Swift helper has never been compiled. This is the highest-value check.
swift build --package-path packages/platform-mac/native
swift test  --package-path packages/platform-mac/native

# 2. The helper transport demo against the real binary (not the Node stub).
pnpm build && pnpm --filter @pilot/platform-mac demo

# 3. A packaged bundle containing the REAL helper.
pnpm --filter @pilot/desktop run build:helper -- --require-native
pnpm package
pnpm --filter @pilot/desktop exec node scripts/verify-bundle.js   # expect `helper: native`

# 4. The desktop shell, visually. Linux only proves it launches headlessly.
pnpm dev

# 5. PR-011 — permissions and window enumeration. THIS ONE PROMPTS.
#    Run it from the SwiftPM build first (attribution should read `unknown`),
#    then from inside the packaged .app, which is the answer that matters.
pnpm --filter @pilot/platform-mac demo:permissions

PILOT_HELPER_BINARY="$(pwd)/apps/desktop/release/mac-arm64/Pilot.app/Contents/Resources/helper/PilotHelper" \
  pnpm --filter @pilot/platform-mac demo:permissions

# 6. PR-012 — the first real pixel Pilot has ever captured. RUN STEP 5 FIRST:
#    without a Screen Recording grant this cannot work, and the failure would
#    look like a capture bug rather than a missing permission.
#    Open a window titled something recognisable before running it.
pnpm --filter @pilot/platform-mac demo:capture

PILOT_HELPER_BINARY="$(pwd)/apps/desktop/release/mac-arm64/Pilot.app/Contents/Resources/helper/PilotHelper" \
  pnpm --filter @pilot/platform-mac demo:capture
```

Notes:

- **A Swift compile failure is a PR-003 defect** for the transport files, a
  **PR-011 defect** for `PermissionModel.swift`, `Attribution.swift`,
  `WindowModel.swift`, `PermissionProbes.swift` and `WindowEnumerator.swift`,
  and a **PR-012 defect** for `CaptureModel.swift` and `CaptureEngine.swift`.
  Either way, send the compiler output; it gets fixed, not worked around. The
  authors could not compile any of it and deliberately avoided constructs they
  were unsure of.
- **Steps 1–4 raise no TCC prompt. Steps 5 and 6 do.** That separation is
  deliberate: it isolates "does the helper build and talk" from "does macOS
  trust it". Do steps 1–4 first; if the helper does not build, steps 5 and 6
  cannot tell you anything.
- `--require-native` in step 3 is the flag that matters. Without it the build
  silently stages a placeholder, and a bundle that cannot observe the screen is
  indistinguishable from one that can until someone tries it.

### What to look for in step 5 (PR-011)

This is the first observation of **TCC attribution**, the top structural risk
in the plan (§5 below). Four things, in order:

1. **Section 2, `verdict=`.** Run from `.build/debug` it should read
   `unknown (none)` — a loose executable is inside no `.app`, and that is a
   correct non-answer, not a bug. Run from inside the packaged `.app` it
   should read **`matched (direct)`**. Anything else — especially
   `helper-attributed` — is the risk materialising, and the whole permission
   model in `docs/system-design.md` §4 needs rework.
2. **`confidence=`.** `direct` means macOS answered which process it holds
   responsible. `inferred` means the
   `responsibility_get_pid_responsible_for_pid` SPI did not resolve and the
   verdict rests on bundle layout instead. `inferred` is still usable, but
   report it: it means the strongest available check is not working.
3. **Section 4, window titles.** If every title reads "(title unavailable —
   Screen Recording not granted)" while section 1 reports
   `screen-recording=granted`, that is the attribution bug showing itself from
   the other side, independently of the verdict. Report that combination even
   if the verdict says `matched`.
4. **System Settings → Privacy & Security → Screen Recording.** One entry
   named Pilot is correct. A second entry named `PilotHelper` is the failure,
   and it is visible without reading any output at all.

A crash worth expecting rather than reporting as a surprise: macOS kills a
process that requests Microphone or Speech Recognition without the matching
usage string in the responsible process's `Info.plist`. Both keys are already
declared for the packaged app (`apps/desktop/electron-builder.yml`,
`extendInfo`), so the packaged run in step 5 is covered — but the helper run
from `.build/debug` has no `Info.plist` of its own and may be killed. If it is
killed **in the packaged run too**, that is decisive: TCC is reading the
helper's own plist, so attribution is wrong whatever the verdict printed.
Either way the supervisor restarts it and the request fails as
`helper-unavailable`; nothing hangs.

Also worth capturing while you are there, since nothing else will produce it:

- Whether each permission prompt actually appears, and whether Screen
  Recording still reports the old state until Pilot is relaunched (the code
  assumes it does — `requiresRelaunch: true`).
- Whether the four `x-apple.systempreferences:` URLs land on the right panes.
- The raw values printed for Microphone and Speech Recognition, to confirm the
  two authorization enums map the way `PermissionStateMapper` assumes (they
  disagree: `1` is `restricted` for AVFoundation and `denied` for Speech).

### What to look for in step 6 (PR-012)

The demo targets a hard-coded fixture window on the stub. Against the real
helper it enumerates and picks one, and **prints which window it selected on
its second line** — check that line first: everything below it is scoped to
that window and to nothing else.

Then, in order:

1. **Does it capture at all.** Frames should appear with non-zero byte counts.
   Zero frames with `state=starting` means the stream never delivered; zero
   frames with `state=protected` means the window blocks capture (try a plain
   TextEdit window before concluding anything).
2. **`age=` on each frame.** This is `Date.now() - capturedAt`, and it is the
   mach → epoch timestamp conversion showing its work. Tens of milliseconds is
   right. **Hours, or a negative number, means the conversion is wrong** — the
   frame ring would then reject every frame as stale and Pilot would observe
   nothing while reporting no error at all. Report the number either way.
3. **Byte counts.** A 1440×960 JPEG of a normal UI window should be roughly
   100–400 KB. Consistently over ~1.8 MB would exhaust the 16 MiB ring in under
   three seconds and is worth reporting; the fix is the `quality` option.
4. **A motionless window.** Leave the window untouched for ten seconds. Frames
   should keep arriving at ~3 FPS with `contentChanged: false` — that is the
   re-send that keeps the ring populated. If they stop, the assumption that
   ScreenCaptureKit delivers `idle` frames at the configured interval is wrong,
   and a static window will have no frame to answer questions from.
5. **A window that blocks capture.** Try a DRM-protected video or a password
   manager. Expected: `protected-content` and a stopped stream. If instead a
   frame arrives that is entirely black, `SCFrameStatus.blank` is not being
   reported and §16's protected-content path never fires — say so, because the
   model would then describe a black rectangle as if it were the application.
6. **System Settings → Privacy & Security → Screen Recording**, again. Capture
   is the first thing that really uses the grant; a second entry named
   `PilotHelper` appearing here would be the attribution risk (§5) showing up
   at the moment it matters most.

**Fallback in use:** Mac-gated code is written unverified and batched here
(runbook amendment 8, user decision). Accepted risk: PR-011 through PR-015
accumulate on top of an uncompiled helper. PR-011 additionally ships an
attribution check whose *logic* is fully tested on Linux but whose *answer* is
unknown until step 5 runs.

---

## 2. Blocked on Codex sign-in

The user chose Codex subscription for model access (runbook amendment 7). Pi
0.84.1 supports it (`openai-codex`, `isSubscription: true`), verified by the
PR-005 spike. **No sign-in has happened**, and there is no API key in the Linux
environment, so no live provider call has ever been made.

Steps are in `docs/pi-notes.md` §9.1. Two findings to carry into it:

- **Use the device-code flow, not browser login.** Browser login binds local
  port 1455 and does *not* open a browser — it emits an `auth_url` the
  application must handle. The device-code flow is headless and is the right
  choice for a packaged app. PR-037 is written against this.
- Vision-capable models observed: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`,
  `gpt-5.6-luna`. `gpt-5.3-codex-spark` is text-only and must fail the
  capability gate rather than silently ignoring images.

**Fallback in use:** everything runs against the mock provider. Phase 2 is
unaffected. Phase 3 integration (PR-029 onward) can be *built* but cannot be
*demonstrated against a real model* until sign-in happens.

**What the mock cannot prove**, and therefore what the first real session must
be watched for: provider-side image encoding, real streaming timing, and
compaction summary quality.

---

## 3. Accepted gaps against the MVP definition of done

Recorded so they are not discovered at release time.

| Gap | Why | Owner |
| --- | --- | --- |
| No notarization | No Developer ID account (user decision). A packaged app needs `xattr -dr com.apple.quarantine` or right-click → Open on any machine that did not build it, and TCC grants are re-prompted whenever the signature changes. | PR-042 |
| Development signing only | Same. `mac.identity` is null, hardened runtime off. | PR-042 |
| No CI | User decision. The five local commands in `docs/runbook.md` §6 are the only gate, run before every merge. | — |
| Grounding metric is a manual checklist | User decision — real apps rather than a purpose-built test app. ~30 cases, ≥90% required. | PR-043 |

---

## 4. Decisions taken without asking

Made under the standing instruction to use my own recommendation. Each is
reversible; raise any that look wrong.

| Decision | Reasoning |
| --- | --- |
| **PR-022 split into 022a/022b** | The PR-005 spike found compaction far larger than planned: Pi has no orchestrator, `AgentHarness.compact` is a stub, and the primitives operate on session `Entry[]` rather than the `AgentMessage[]` the agent holds. Pruning (022a) is nearly done; compaction (022b) is close to a full PR on its own. |
| **PR-007 sequenced after PR-002** | Both own root config and `apps/desktop`. Running them in parallel worktrees guaranteed a conflict in exactly the files PR-007 restructures. Cost: nothing on the critical path. |
| **PR-008 held until PR-007 landed** | Same collision, same reasoning — PR-007 rewrote the bundler under `apps/desktop` while PR-008 builds UI in it. |
| **`docs/system-design.md` corrected in place** | User-confirmed. Three claims were disproved by the spike; leaving them in a doc marked authoritative would mislead every future session. |
| **Agent worktrees excluded from lint/format** | `eslint .` was descending into other agents' half-written worktrees, making the verification gate nondeterministic — it failed and then passed with no code change. |
| **`dismiss-error` added to the desktop IPC validator** | The contract and the state machine had it; the renderer's validator did not, so the `error` state had no exit from the UI. Typecheck did not catch it because a narrower zod union stays assignable. |
| **The capability gate ANDs profile and probe in both directions** (PR-020) | A first draft let the Pi probe *override* a profile's `supportsVision: false`. That is backwards: setting it false on a capable model is how an operator selects the degraded accessibility-only mode of system-design §12, so overriding it would send screen images to a model the user asked not to show them to. The reverse case (profile claims vision, Pi disagrees) reports a distinct `profile-model-mismatch` so a stale profile stays diagnosable. |
| **`QuestionEnvelope.pointer` carries a sentinel, not `null`** (PR-024) | system-design §8 types it as a required numeric pair, so "no pointer recorded" is `UNKNOWN_NORMALIZED_POINT` (`-1,-1`, outside `[0,1]`) plus `grounding: 'pointer-unknown'`, read via `envelopePointerKnown()`. Nullable is the cleaner shape but needs a coordinated change across two readers. **Say if you would rather have `null`** — it is a small, contained change now and a wider one later. |
| **`QuestionAnchorSource` declared on the interaction side** (PR-024) | No contract exposed scene plus pointer-by-instant/interval to that lane, and editing `packages/observation` mid-flight would have collided with PR-016. It mirrors `PointerTimeline` exactly, so PR-031's adapter is the identity function. Moving it onto `ScreenContextService` later is mechanical. |
| **Capture is pulled by the host, not pushed by the helper** (PR-012) | The helper's stdio loop is a single blocking read/answer cycle and a ScreenCaptureKit stream delivers on its own queue. Pushing frames would need a second writer racing the request loop for stdout — a write lock and an interleaving hazard on a *binary* body, in Swift nobody here can compile. The stream callback enqueues into a bounded in-helper queue and `capture.pull` drains it. Cost: one IPC round trip per frame (3/s). Benefit: one writer, explicit backpressure, and the drain rule lives in TypeScript where it is tested. |
| **Capture encodes JPEG in the helper at quality 0.9** (PR-012) | Raw BGRA at 1440×960 is 5.2 MB a frame; a three-second ring at 3 FPS would need ~47 MB against a 16 MiB bound. So capture must encode, and PR-018 encodes again — the double-JPEG risk already recorded in §5. `encoding: 'png'` is a one-line switch on `MacObservationAdapter` that removes the first lossy pass if PR-043 finds small text illegible; it costs ring bytes. **Say if you would rather start with `png`.** |
| **A motionless window is re-sent rather than left to age out** (PR-012) | ScreenCaptureKit only produces pixels when something changes, so a user reading a static page would fill the ring once and let it empty — and a question asked thirty seconds in would find no frame at all. On an idle frame the helper re-sends its retained encoding with a new instant and sequence, flagged `contentChanged: false`. It costs no new encoding and the frame is honest. It does assume idle frames arrive at the configured interval, which is unverified (§1 step 6, item 4). |
| **`ObservationAdapter.subscribeEvents` added as an *optional* member** (PR-012) | Capture has to report why it stopped — window lost, screen locked, protected content — and how many frames it refused; the four verbatim methods from system-design §5 carry none of that. Optional keeps it source-compatible: every existing implementation, including the shared fakes, still satisfies the interface untouched. Same shape as PR-011's `PermissionAdapter.attribution?()`. |

---

## 4a. Progress

| Phase | State |
| --- | --- |
| Phase 1 — foundations (PR-001…007) | **Complete.** All seven merged. |
| Phase 2 — capability lanes | In progress: PR-008, PR-011, PR-016, PR-020, PR-021, PR-024, PR-025 merged; PR-012, PR-013, PR-014, PR-017, PR-022a, PR-026 in flight. |
| Phase 3 — integration (028…036) | Not started. Blocked on Phase 2; most steps also need the Mac (§1) and a signed-in model (§2). |
| Phase 4 — providers (037…039) | Not started. PR-037 (Codex) is the one the user's decision selects. |
| Phase 5 — hardening and release (040…044) | Not started. |

Verification standard on every merge: `pnpm lint`, `typecheck`, `test`, `build`
re-run by the orchestrator — never taken on a subagent's word — plus each PR's
demo executed against the merged tree.
---

## 5. Risks worth watching

- **TCC attribution for the spawned Swift helper** remains the top structural
  risk in the plan. PR-011 has landed the *detection* for it — a typed
  `permission-attribution-mismatch` that fires instead of reporting a
  permission Pilot cannot actually use — but the **answer is still unverified**.
  §1 step 5 is what produces it. If macOS attributes permissions to the helper
  rather than the parent bundle, the permission model in
  `docs/system-design.md` §4 needs rework, and PR-012 through PR-015 are all
  built on the assumption that it does not.
  - What PR-011 guarantees today: if attribution *is* wrong, Pilot says so
    loudly and specifically rather than reporting `granted` and capturing
    nothing. What it does not guarantee: that attribution is right.
  - If it turns out wrong, the likely remedies are an XPC service with its own
    bundle inside the app (so the identity is deliberate rather than
    accidental) or moving these calls into the Electron main process. Both are
    larger than PR-011 and neither has been designed.
- **Nothing about ScreenCaptureKit has ever run** (PR-012). The capture engine
  is the largest piece of unverified Swift in the tree, and three of its
  assumptions are load-bearing enough to be worth stating on their own:
  - **Idle frames arrive at the configured interval.** If they do not, a
    motionless window puts nothing in the ring and a question about a static
    page finds no frame. §1 step 6, item 4 is the check.
  - **A protected window reports `SCFrameStatus.blank`.** If it instead hands
    over black pixels, `protected-content` never fires and the model describes
    a black rectangle as though it were the application. §1 step 6, item 5.
  - **The mach → epoch timestamp conversion is right.** If it is not, every
    frame is rejected by the ring as stale and Pilot observes nothing *while
    reporting no error at all*. The host substitutes its own clock when the
    skew is implausible, which turns a silent failure into a logged one, but
    the conversion is what should be correct. §1 step 6, item 2.
- **`sharp` prebuilds inside packaged Electron (arm64)** — PR-018 owns image
  encoding; the packaging interaction has not been tested.
- **Double-JPEG legibility of small text** — capture encodes once, the
  processing pipeline encodes again. If grounding accuracy on small UI text
  disappoints in PR-043, this is the first thing to check.
- **The content fingerprint cannot see a small, high-meaning change** (PR-016,
  and worth understanding because it shapes product behaviour). Scene revisions
  are minted when ≥15% of the *encoded* payload changes. A toggle flipping or a
  single digit changing is roughly 3% — below the bar. That is precisely the
  kind of change a user points at and asks about.

  Mitigations already in place: window title and accessibility-root changes are
  separate revision components, so many such changes are caught another way; the
  threshold is biased to over-report, because a false positive costs one
  observation while a false negative lets the model answer from a screen that no
  longer exists; and the model can always call `observe_screen` with
  `moment: 'current'` to force a fresh look regardless of revision state.

  The residual risk is a stale `lastObservedRevision` making the model *believe*
  its old observation is current after a small change. If acceptance testing
  (PR-043) shows wrong answers after toggles and small edits, the fix is a
  pixel-aware fingerprint — `ContentFingerprinter` is a standalone injectable
  component precisely so PR-018 can replace it behind the same interface.
  Two further blind spots are documented in `content-fingerprint.ts`: the same
  edit scores very differently near the top versus the bottom of a window in an
  entropy-coded format, and non-deterministic encoders or animation cause
  continuous false positives that keep `lastObservedRevision` permanently
  behind.
- **Effort calibration** — `docs/implementation.md` PR size bands sum to
  roughly 2–3× the estimate in `dp/m1.md`. Treat any date derived from them
  with suspicion until several PRs have calibrated actual velocity.
