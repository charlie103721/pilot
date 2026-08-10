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

**Confirmed by the user (2026-08-10): the Swift helper will be built on the Mac
later.** Development continues on Linux without it. Nothing in the plan waits
for it, and the batch below accumulates until there is a Mac to run it on. The
macOS lane (PR-012…PR-015) is therefore written blind on top of an uncompiled
helper, by design rather than by oversight.

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
```

Notes:

- **A Swift compile failure is a PR-003 defect** for the transport files, and a
  **PR-011 defect** for `PermissionModel.swift`, `Attribution.swift`,
  `WindowModel.swift`, `PermissionProbes.swift` and `WindowEnumerator.swift`.
  Either way, send the compiler output; it gets fixed, not worked around. The
  authors could not compile any of it and deliberately avoided constructs they
  were unsure of.
- **Steps 1–4 raise no TCC prompt. Step 5 does.** That separation is
  deliberate: it isolates "does the helper build and talk" from "does macOS
  trust it". Do steps 1–4 first; if the helper does not build, step 5 cannot
  tell you anything.
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
| **Replacement records say more than §11's example** (PR-022a) | §11 shows `[Observation scene-17/revision-4 removed. <summary>]` but its prose forbids a record that "claims an old screen description remains current". A past tense alone is a weak signal to a model, so every record also ends with "This is a past record of scene-17 at revision 4, not a description of the screen now", and names the scene the screen has since moved to when that is known. It also names which image went — full frame, pointer crop, or comparison half — because one observation can contribute several blocks and identical repeated sentences read as a bug. Longer than the example, and deliberately so: this is the difference between the model saying "you were on the billing page" and "you are on the billing page". |
| **`AgentRunHandle.completed` now waits for Pi to go idle** (PR-022a) | Found by this PR's own demo. `agent_end` fires before `Agent.prompt()` unwinds, so two questions in a row — `await submit(q1).completed; await submit(q2).completed` — produced `run-failed: "Agent is already processing a prompt"` on the second and every one after. Events were always correct; only the promise resolved a tick early. `completed` now also awaits `Agent.waitForIdle()`. Nothing else changed, but any caller that relied on `completed` resolving *before* the agent settled now resolves slightly later. |
| **`QuestionAnchorSource` declared on the interaction side** (PR-024) | No contract exposed scene plus pointer-by-instant/interval to that lane, and editing `packages/observation` mid-flight would have collided with PR-016. It mirrors `PointerTimeline` exactly, so PR-031's adapter is the identity function. Moving it onto `ScreenContextService` later is mechanical. |
| **The screen policy grew four groups beyond the interface printed in system-design §10** (PR-017) | §10's printed `ScreenPolicy` has no field for a ring byte ceiling (§17 requires one), for pointer retention (an utterance outlives the three-second frame ring), for image byte limits (§14 requires size *and* count limits on image tool results), or for the secure-content rule (§10 step 4 and §14 require one). `ScreenContextPolicy` in `packages/observation` adds them; `toScreenPolicyContract()` projects back onto the printed shape and a test pins that projection to `MVP_SCREEN_CONTEXT_POLICY`, so the numbers cannot drift. **`packages/shared` was not changed** — three lanes were running in parallel and none of the additions needed to cross a package boundary. |
| **New image byte ceilings were chosen, not derived** (PR-017) | Nothing in the docs states one. 4 MiB per image and 8 MiB per observation: a 1440-px JPEG at quality 0.75 is a few hundred kilobytes, so these only fire on a pathological encode, and they bound the base64 payload (4/3 inflation) at ~10.7 MiB. **Say if you want them tighter** — they are one field in a frozen record. |
| **Secure content defaults to `redact`, and refuses when it cannot mask** (PR-017) | §14 allows masking password fields but demands the product warn that screenshots can still contain secrets. Where macOS reports a secure field *without* bounds, Pilot cannot mask it; the default (`requireMaskableBounds: true`) refuses the observation rather than shipping it under a redaction claim it does not meet. The alternative — send it and warn — is available as a one-field policy override. |
| **No native image dependency; `sharp` was not adopted** (PR-018) | PR-018 owned the recorded `sharp`-on-arm64 packaging risk and chose not to take it on. PNG goes through Node's built-in `node:zlib` (native C, already in the runtime, nothing to prebuild, and asynchronous so it runs off the JS thread); JPEG goes through `jpeg-js@0.4.4` (pure JavaScript, BSD-3, zero dependencies, no install scripts, no binaries); `bgra` is a channel swap. Nothing new to unpack from an asar and nothing architecture-specific, so **PR-042 has no image-related packaging work**. The cost is stated below and in §5: pure-JS JPEG decoding is slow. `FrameCodec` is an interface precisely so a WASM or native codec can be injected later without a caller changing. |
| **The full frame is passed through unencoded whenever nothing has to change** (PR-018) | When a request needs no mask, no crop and no marker and the frame is already JPEG or PNG inside the 1440 px bound, the pipeline returns the capture's own bytes. This is the ordinary `view: 'window'` case. It removes the second JPEG generation entirely and costs ~0 ms. The safety conditions are all-or-nothing: anything to mask, crop or annotate takes the decode path. |
| **PNG is chosen over JPEG for interface content** (PR-018) | mvp-01 §10 makes JPEG the default and permits PNG "when compression makes small text unreadable". The pipeline measures the image (fraction of pixels identical to their left neighbour) and encodes interface content losslessly, photographic content as JPEG. Measured in the PR-018 demo: a second JPEG generation on a pointer crop taken at a non-block-aligned offset raises the mean luma error from 1.80 to 3.20 and the share of visibly-moved pixels from 3.2% to 7.6%. Lossless costs none of that, is usually *smaller* for flat interface content, and through `zlib` is roughly an order of magnitude faster than the pure-JS JPEG encoder. **Say if you would rather always ship JPEG** — it is one constant (`DEFAULT_ENCODING_SELECTION.flatRunRatioForLossless`). |
| **The content fingerprint was *not* replaced with a pixel-aware one** (PR-018) | PR-016 left the seam for this and asked PR-018 to consider it. It is deferred, on a measurement rather than a preference: a pixel-aware fingerprint has to decode **every sampled frame**, at 2–3 FPS, for as long as observation is on. The pure-JS JPEG decode measured ~165 ms for a policy-bounded 1440×960 frame, so at 3 FPS that is roughly half a CPU core burning continuously — a straight regression against §17's sampling budget, to fix a blind spot that PR-043 has not yet shown to matter. It becomes cheap the moment capture hands over `bgra` or `png` (see the row below), at which point the replacement is a small class behind the same `observe(frame) → ContentFingerprintUpdate` shape. Left for PR-043's evidence to decide, as §5 already says. |
| **`ImageRenderRequest.maxBytes` and `RenderedImage.stats` were added** (PR-018) | Both additive and optional, both inside `packages/observation`. `maxBytes` is the policy's own `image.maxImageBytes` passed *down*: the number stays a policy decision and the policy still enforces it, but the pipeline can now choose an encoding that fits instead of handing back a lossless image the enforcer must reject. `stats` is a content-free record of what the pipeline did and what each stage cost, which is how the §17 budget is measured rather than assumed. `FakeImageProcessor` does not set `stats`, so every reader handles `undefined`. |
| **`before-and-after` takes a comparison *window*, not two moments** (PR-017) | §9 says "two bounded frames around a relevant scene transition" but the tool input carries no timestamps, so someone has to choose them. The enforcer takes `comparisonWindow: {from, to}` and returns the earliest frame at or after `from` and the latest at or before `to`; PR-019 sets the window around the transition it finds in the scene lineage. The default window is the whole local buffer up to the question anchor. |

---

## 4a. Progress

| Phase | State |
| --- | --- |
| Phase 1 — foundations (PR-001…007) | **Complete.** All seven merged. |
| Phase 2 — capability lanes | In progress: PR-008, PR-011, PR-016, PR-017, PR-018, PR-020, PR-021, PR-022a, PR-024, PR-025 merged; PR-009, PR-012, PR-013, PR-014, PR-022b, PR-026 in flight. |
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
- ~~**`sharp` prebuilds inside packaged Electron (arm64)**~~ — **CLOSED by
  PR-018, by not taking the risk.** There is no native image dependency: PNG
  through `node:zlib`, JPEG through pure-JS `jpeg-js`, `bgra` through a channel
  swap. Nothing to prebuild, nothing architecture-specific, nothing for PR-042
  to unpack from the asar. The risk it was traded for is the next bullet.
- **Pure-JS JPEG decoding is the pipeline's one over-budget number** (PR-018,
  measured, replaces the `sharp` risk). §17 targets under 150 ms of image
  preprocessing per observation. Measured on the Linux development machine for
  one full frame plus one pointer crop at the capture size the policy actually
  requests (1440 px longest edge — `toCaptureOptions` bounds it there):

  | source frame | secure field in view | total |
  | --- | --- | ---: |
  | `bgra` | no / yes | 74 / 102 ms |
  | `png` | no / yes | 71 / 135 ms |
  | `jpeg` | no / yes | **165 / 259 ms** |

  The full frame is free when nothing has to change (the bytes are passed
  through); the cost is decoding a JPEG *source* to get pixels for the crop, at
  ~165 ms for 1440×960 in `jpeg-js`. Three ways out, cheapest first:

  1. **Have PR-012 deliver `bgra` or `png` frames** rather than JPEG. This is
     the recommended one: it removes the decode cost *and* the double-JPEG
     generation loss below, and needs no contract change — `FrameEncoding`
     already admits all three. A 3-second ring at 1440×960 `bgra` does not fit
     the 16 MiB ring ceiling (§17), so `png` is the realistic choice there and
     `bgra` the right one for a fresh `captureFresh` capture.
  2. Inject a WASM or native codec through `FrameCodec`. One line at the
     construction site; no caller changes.
  3. Host the pipeline in a `worker_threads` worker (PR-019/PR-028). This does
     not make it faster, but §17 and mvp-01 §10 require it anyway — the main and
     renderer processes must not block on image encoding. The pipeline is a pure
     function of bytes and numbers, with no handles and no platform state, so it
     is worker-transferable as written.

  A Mac is faster than this container, so the real numbers will be lower; the
  ordering will not change. **Nothing is blocked on this** — it is a latency
  target, not a correctness bound.
- **Double-JPEG legibility of small text** — capture encodes once, the
  processing pipeline encodes again. **Measured by PR-018 and largely
  mitigated.** On a pointer crop taken at a non-block-aligned offset (which is
  every pointer crop), a second JPEG generation at q0.75 raises the mean luma
  error against the compositor's pixels from 1.80 to 3.20 and the share of
  pixels moved by more than 8 from 3.2% to 7.6%. The pipeline avoids paying it:
  a full frame that needs no change is passed through unencoded, and interface
  content is re-encoded losslessly as PNG. It is still paid on photographic
  content, and on any frame where the model asks for a crop of a JPEG capture.
  If grounding accuracy on small UI text disappoints in PR-043, check this
  first, and check it together with the row above — both are solved by capture
  handing over `bgra` or `png`.
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
  component precisely so it can be replaced behind the same interface.
  **PR-018 considered doing exactly that and did not**, for a reason worth
  keeping: a pixel-aware rule must decode every sampled frame, and the pure-JS
  JPEG decode is ~165 ms for a policy-bounded frame, which at the 2–3 FPS
  sampling rate would burn most of a core continuously for as long as
  observation is on. It becomes cheap as soon as capture delivers `bgra` or
  `png` (see the JPEG-decode bullet above), so the two decisions are the same
  decision. PR-018 left the seam untouched and the code path unused.
  Two further blind spots are documented in `content-fingerprint.ts`: the same
  edit scores very differently near the top versus the bottom of a window in an
  entropy-coded format, and non-deterministic encoders or animation cause
  continuous false positives that keep `lastObservedRevision` permanently
  behind.
- **Redaction is best effort, and the product must say so out loud** (PR-017).
  The policy masks only fields the accessibility tree marks `isSecure`. A secret
  in a plain text field, a token in a terminal, a recovery code rendered as an
  image, or a notification banner from another app overlapping the window all
  pass through untouched. Every allowed observation therefore carries
  `SCREEN_REDACTION_CAVEAT` — "a screenshot can still contain secrets outside
  recognised fields" — whether or not anything was masked, so no caller can read
  "redaction applied" as "safe". **This sentence needs to reach the user
  interface, not only the model**: PR-021 surfaces it to the model, and the
  onboarding/observation UI (PR-009/PR-010) is where a person should see it.
  Nothing in the current UI says it yet.

  PR-018 added the pixels behind the promise and nothing to the promise. Masks
  are painted on the source frame **before** the crop and before the resize, with
  rectangles rounded outward, so a downscale cannot leave a rim of a password
  field outside a rounded mask; the pipeline reports how many rects it painted
  and how many lay outside the frame entirely, rather than dropping either
  silently; and pass-through — returning the capture's own bytes — is refused
  outright whenever there is anything at all to mask. The pipeline still does
  not *detect* anything: it paints what PR-013's `isSecure` flag produced, and a
  frame with no masks remains a frame that may be full of secrets.
- **Effort calibration** — `docs/implementation.md` PR size bands sum to
  roughly 2–3× the estimate in `dp/m1.md`. Treat any date derived from them
  with suspicion until several PRs have calibrated actual velocity.
