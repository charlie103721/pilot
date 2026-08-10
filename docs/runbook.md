# Pilot MVP 01 — Execution Runbook

Status: Active
Last updated: 2026-08-10

This is the operating manual for executing MVP 01. It is written for a fresh
Claude Code session (or a human) starting with zero context. Read this first;
it tells you what to read next, how the work is organized, and exactly how to
run it.

## 1. Document map (read in this order)

| Doc | What it is |
| --- | --- |
| `docs/product-spec.md` | Product requirements and principles |
| `docs/system-design.md` | Authoritative architecture (interfaces, policy, boundaries) |
| `docs/logic.md` | Block diagram of the architecture |
| `docs/mvp-01-point-ask-hear.md` | MVP scope, checkpoints, acceptance matrix A-01…A-15, definition of done |
| `dp/m1.md` | Engineering plan: decisions, ownership/effort, phase details |
| `docs/implementation.md` | **The execution plan**: 44 PRs (PR-001…PR-044) with scope, owner lane, size, dependencies, demo per PR |
| `docs/runbook.md` | This file — how to actually run the delivery |
| `docs/pi-notes.md` | PR-005 spike findings: the verified reality of pinned Pi 0.84.1 |
| `docs/handoff.md` | Open items needing the user, accepted gaps, and decisions taken on their behalf |

Precedence: `docs/system-design.md` for architecture, `dp/m1.md` for
engineering decisions, `docs/implementation.md` for PR scope/order, this
runbook for process. If they conflict, flag it before proceeding.

## 2. Toolchain conventions (user-mandated)

- **Node 24** — pinned in `.nvmrc` (`nvm use` on entry). Root `package.json`
  must carry `"engines": {"node": ">=24"}`.
- **pnpm only** — never npm or npx (`pnpm dlx` replaces npx). Root
  `package.json` carries a `"packageManager": "pnpm@…"` field.
- TypeScript strict, ESM (`"type": "module"`, NodeNext), Vitest, ESLint flat
  config + Prettier.
- Development happens on Linux; anything marked **Mac** in the table below can
  only be *verified* on the user's Mac (Swift builds, ScreenCaptureKit, TCC
  prompts, packaging, acceptance runs). Write the code anywhere; batch Mac
  verification.
- Commits: small, one PR-unit per commit (or short-lived branch), message
  prefixed with the PR ID, e.g. `PR-004: observation core`. Keep `main`
  buildable after every merge. Push only when the user asks.

## 3. Execution model

1. **One task per PR.** The 44 PRs in `docs/implementation.md` are the work
   items. Track them in the session task list (recreate it from the table in
   §5 — task lists do not survive across sessions; this table is the source of
   truth).
2. **Each PR is implemented by a subagent** (user-mandated). The orchestrating
   session dispatches a subagent with: the PR's section from
   `docs/implementation.md`, the relevant doc references, the toolchain rules
   from §2, and an instruction not to commit. The orchestrator then reviews
   the diff, runs the checks (§6), commits, and marks the task complete.
3. **Parallel groups run in git worktrees** (user-mandated). When dispatching
   concurrent subagents, give each `isolation: "worktree"` so they cannot
   clobber each other; merge results back to `main` as each finishes.
   Sequential work runs directly on `main` — no worktree.
4. **Landing a PR** (user-mandated): each PR unit is committed on the
   development branch `claude/implementation-md-approach-21bepa`, pushed, then
   **opened as a GitHub pull request and merged into `main`**. Do not leave
   finished work sitting only on the development branch, and do not
   direct-push to `main` in place of the pull request. After the merge, the
   development branch and `main` are identical, and the next PR continues from
   there.
5. **Delivery rules** (from `docs/implementation.md`, enforced on every PR):
   one capability per PR; `main` stays runnable; tests or a deterministic
   harness included; a demo command or manual verification procedure
   documented; explicit failure/unavailable states; integration PRs replace at
   most one fake boundary at a time.

## 4. Parallelization plan

| Group | PRs | Mode |
| --- | --- | --- |
| Gate | PR-001 | Solo, on `main` — nothing else may start |
| Foundations | PR-002…PR-007 | Up to 6 parallel subagents, worktrees |
| Desktop lane | PR-008 → 009 → 010 | Sequential within lane |
| macOS platform lane | PR-011 → {012, 013, 014, 015} | 012–015 parallelizable after 011 |
| Observation lane | PR-016 → 017 → 018 → 019 | Sequential within lane |
| Agent runtime lane | PR-020 → 021 → 022 → 023 | Sequential within lane |
| Interaction lane | PR-024 → 025 → 026 → 027 | Sequential within lane |
| (the five lanes above run in parallel with each other, one worktree per lane) | | |
| Integration | PR-028 → … → PR-036 | Strictly sequential, on `main`, merge in order |
| Providers | PR-037, PR-038, PR-039 | 3 parallel subagents, worktrees |
| Hardening/release | PR-040 → 041 → 042 → 043 → 044 | Sequential, on `main` (043 also needs 037–039) |

## 5. Task table (source of truth for the task list)

`Needs Mac` = final verification requires the user's Mac; code can still be
written on Linux.

| PR | Title | Depends on | Group | Needs Mac |
| --- | --- | --- | --- | --- |
| 001 | Workspace, contracts, fakes, CI | — | gate | |
| 002 | Desktop shell | 001 | foundation | |
| 003 | Native helper transport | 001 | foundation | build check |
| 004 | Observation core | 001 | foundation | |
| 005 | Pi Agent Core capability spike | 001 | foundation | live probes |
| 006 | Interaction state machine | 001 | foundation | |
| 007 | Development build baseline | 001 | foundation | bundle smoke |
| 008 | Permission onboarding UI | 002 | desktop | |
| 009 | Window picker and observation controls | 008 | desktop | |
| 010 | Conversation and diagnostics panel | 009 | desktop | |
| 011 | Native permissions and window enumeration | 003 | platform-mac | yes |
| 012 | Selected-window capture | 011 | platform-mac | yes |
| 013 | Pointer and Accessibility grounding | 011 | platform-mac | yes |
| 014 | Native STT and TTS | 011 | platform-mac | yes |
| 015 | Global push-to-talk | 011 | platform-mac | yes |
| 016 | Scene and pointer timeline | 004 | observation | |
| 017 | Screen policy | 016 | observation | |
| 018 | Image processing pipeline | 017 | observation | |
| 019 | Screen context facade | 018 | observation | |
| 020 | Model profiles and capability checks | 005 | agent-runtime | |
| 021 | observe_screen tool | 020 | agent-runtime | |
| 022 | Visual context pruning and compaction | 021 | agent-runtime | |
| 023 | Safe session persistence | 022 | agent-runtime | |
| 024 | Question envelope | 006 | interaction | |
| 025 | Voice orchestration | 024 | interaction | |
| 026 | Response and TTS buffer | 025 | interaction | |
| 027 | Interruption and cancellation | 026 | interaction | |
| 028 | Observe a real selected window | 010, 012, 013, 019 | integration | yes |
| 029 | Text conversation with real Pi session | 010, 020, 024 | integration | |
| 030 | Model-requested real observation | 028, 029, 021 | integration | yes |
| 031 | Point-and-ask with text input | 030 | integration | yes |
| 032 | Real push-to-talk input | 014, 015, 025, 031 | integration | yes |
| 033 | Spoken response | 032, 026 | integration | yes |
| 034 | Complete voice screen-grounding flow | 033 | integration | yes |
| 035 | End-to-end interruption | 027, 034 | integration | yes |
| 036 | Bounded multi-turn conversations | 023, 035 | integration | |
| 037 | Codex subscription profile | 036 | providers | yes |
| 038 | API-key provider profile | 036 | providers | yes |
| 039 | Local OpenAI-compatible profile | 036 | providers | yes |
| 040 | Lifecycle and failure recovery | 036 | hardening | yes |
| 041 | Privacy and retention verification | 040 | hardening | yes |
| 042 | Packaged macOS application | 041 | hardening | yes |
| 043 | Acceptance and grounding suite | 037, 038, 039, 042 | hardening | yes |
| 044 | MVP 01 release candidate | 043 | hardening | yes |

### Amendments to `docs/implementation.md` (apply during execution)

These came from plan review; the implementation doc has not been edited to
include them:

1. **PR-030** additionally implements the **"Look now"** manual observation
   action (`dp/m1.md` Phase 4; missing from implementation.md).
2. **PR-029…PR-036 run on a development model profile** produced by the
   PR-005 spike (an API key configured by hand). The provider settings UI and
   real auth flows arrive in Phase 4 — don't block Phase 3 on them.
3. **PR-037**: ~~if the PR-005 probe finds Codex subscription auth unsupported
   in the pinned Pi release, implement the fallback recorded in
   `docs/pi-notes.md` instead~~ — **CLOSED by PR-005.** Codex subscription auth
   is supported (`openai-codex` provider, `isSubscription: true`, browser and
   device-code login). No fallback needed. The remaining work and the exact
   sign-in steps are in `docs/pi-notes.md` §9.1; note the browser flow binds
   local port 1455 and does not open a browser for you.
4. **PR-001 contracts are provisional** for the agent facade and platform
   adapters until PR-005 (Pi API reality) and PR-011 (TCC reality) land.
   Expect and accept small contract-change follow-ups.
5. **No CI** (user decision, 2026-08-10): PR-001 does not add a CI workflow.
   Verification is the §6 local command set, run before every commit.
6. **PR-007 runs after PR-002**, not in parallel with it — both own root
   config (electron-vite, builder config, root scripts); parallel worktrees
   would conflict. Foundations fan-out is therefore 003/004/005/006 parallel,
   with 002 → 007 as a sequential pair alongside them.
7. **Model access is Codex subscription** (user decision, 2026-08-10). PR-005
   verified Pi 0.84.1 supports it (`openai-codex`, `isSubscription: true`).
   Sign-in happens on the user's Mac; PR-037 must use the **device-code flow**,
   because browser login binds local port 1455 and does not open a browser.
   No API key exists in the Linux environment, so Phase 3 integration
   (PR-029+) runs on mocks until that sign-in happens.
8. **Mac verification is deferred** (user decision, 2026-08-10): keep building
   Mac-gated code unverified and batch it. Accepted risk: the Swift helper has
   never been compiled, and PR-011…PR-015 accumulate on top of it. Keep a
   running list of what the Mac batch must cover (§10).
9. **`docs/system-design.md` is corrected in place** when a spike disproves it
   (user decision, 2026-08-10), citing the evidence doc. Done for §2.7/§2.10,
   §8 and §12 from `docs/pi-notes.md`. Do not leave a known-wrong statement
   standing in a doc marked authoritative.
10. **PR-022 is split into PR-022a (pruning and image limits) and PR-022b
    (compaction orchestration)**, per the PR-005 finding that Pi supplies no
    compaction orchestrator and its primitives operate on session `Entry[]`
    rather than the agent's `AgentMessage[]`. PR-023 grows from S to M for the
    same reason — it owns the whole `Agent ↔ Session` bridge, restore-on-launch,
    the `undefined`-payload trap and the SQLite writer lease.
11. **Anything needing the user goes in `docs/handoff.md`**, not scattered
    through PR reports. Keep it current as lanes land.
12. **`docs/handoff.md` is updated and merged with every PR** (user decision,
    2026-08-10). Before landing a PR, ask what it changed for the user —
    a new blocker, a decision taken on their behalf, a gap accepted, a risk
    surfaced — and write it into `docs/handoff.md` in the *same* merge. A
    finding that lives only in a PR description or a chat message is lost.

## 5a. Pending Mac batch

Everything below needs the user's Mac. Nothing else is blocked on it.

The authoritative, runnable version of this list is `docs/handoff.md` §1; keep
the two in step.

| What | Command / action | From | Prompts? |
| --- | --- | --- | --- |
| Compile the Swift helper | `swift build --package-path native` in `packages/platform-mac` | PR-003, PR-011 | no |
| Swift unit tests | `swift test --package-path native` | PR-003, PR-011 | no |
| Helper demo against the real binary | `pnpm --filter @pilot/platform-mac demo` | PR-003 | no |
| Codex sign-in probe | `docs/pi-notes.md` §9.1 | PR-005 | no |
| Desktop shell visual demo | `pnpm dev` — menu bar item, panel, fake states | PR-002 | no |
| **TCC attribution + real permissions and windows** | `pnpm --filter @pilot/platform-mac demo:permissions`, then again with `PILOT_HELPER_BINARY` pointing inside the packaged `.app` | PR-011 | **yes** |
| Pointer grounding, AX hit testing, secure fields | `pnpm --filter @pilot/platform-mac demo:accessibility`, with and without an Accessibility grant | PR-013 | no |
| **Real speech: transcription, on-device recognition and audible playback** | `pnpm --filter @pilot/platform-mac demo:speech` — opens the microphone and makes noise; run after the permissions row | PR-014 | **yes** |
| **Selected-window capture** — the first real pixel | `pnpm --filter @pilot/platform-mac demo:capture` (run the row above first; without a Screen Recording grant this cannot work) | PR-012 | **yes** |
| **Global push-to-talk against a real `CGEventTap`** | `pnpm --filter @pilot/platform-mac demo:hotkey`, then again from inside the packaged `.app`; hold Right Option **with another app in front** | PR-015 | **yes** |

A Swift compile failure is a **PR-003 defect** in the transport files, a
**PR-011 defect** in `PermissionModel.swift`, `Attribution.swift`,
`WindowModel.swift`, `PermissionProbes.swift` and `WindowEnumerator.swift`, and
a **PR-013 defect** in `AccessibilityModel.swift` and
`AccessibilityProbes.swift`: either way, send the compiler output and it gets
fixed, not worked around.

Every row but the TCC one raises **no TCC prompt** — that separation is
deliberate, isolating "does the helper build and talk" from "does macOS trust
it". The TCC row is the second question, and it is the one that settles the
top structural risk in the plan (§7). The PR-013 row raises no prompt either
(`AXIsProcessTrusted` does not ask), but it is the only way to learn whether
real password fields are recognised at all — the flag PR-018's redaction rests
on. What to look for is spelled out in `docs/handoff.md` §1.
a **PR-014 defect** in `SpeechModel.swift` and `SpeechServices.swift`: either
way, send the compiler output and it gets fixed, not worked around.

Every row but the last two raises **no TCC prompt** — that separation is
deliberate, isolating "does the helper build and talk" from "does macOS trust
it". The permissions row is the second question, and it is the one that settles
the top structural risk in the plan (§7). The speech row is the only one that
opens the microphone or produces sound, and part of its answer is audible
rather than printed. What to look for in both is spelled out in
`docs/handoff.md` §1.
a **PR-012 defect** in `CaptureModel.swift` and `CaptureEngine.swift`: either
way, send the compiler output and it gets fixed, not worked around.

Every row but the last two raises **no TCC prompt** — that separation is
deliberate, isolating "does the helper build and talk" from "does macOS trust
it". The last two are the second question, and the permissions one settles the
top structural risk in the plan (§7). What to look for in both is spelled out
a **PR-015 defect** in `HotkeyModel.swift`, `HotkeyTap.swift` and
`FrameWriter.swift` (PR-015 also edited `HelperServer.swift` and
`HelperProtocol.swift` additively): either way, send the compiler output and it
gets fixed, not worked around.

Every row but the last two raises **no TCC prompt** — that separation is
deliberate, isolating "does the helper build and talk" from "does macOS trust
it". The last two rows are the second question. The permissions row settles the
top structural risk in the plan (§7); the push-to-talk row settles whether
Accessibility alone is enough for a keyboard tap or macOS also demands Input
Monitoring, which Pilot does not model. What to look for in each is spelled out
in `docs/handoff.md` §1.

## 6. Verification commands

Every PR must leave these green (run from repo root, on Linux):

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Mac-only verification (batch when a Mac is available):

```sh
# Swift helper
swift build --package-path packages/platform-mac/native
swift test  --package-path packages/platform-mac/native   # where present

# Dev app + packaging (exact scripts defined by PR-007/PR-042)
pnpm dev
pnpm package
```

Acceptance evidence lives in `docs/acceptance.md` (A-01…A-15 run log) and
`docs/grounding-checklist.md` (~30 point-and-ask cases, ≥90% required) — both
created during PR-043.

## 7. Known facts and open risks (verified 2026-08-10)

- **Pi packages are public on npm.** Corrected by PR-005 (2026-08-10) — the
  pinned set is `@earendil-works/pi-agent-core@0.84.1`,
  `@earendil-works/pi-ai@0.84.1`, and
  `@earendil-works/pi-session-backend-sqlite-node@0.84.1`. Source:
  <https://github.com/earendil-works/pi>. There is no package named
  `@earendil-works/pi` or `pi-agent` — don't look for one.
  **`@earendil-works/pi-storage-sqlite-node@0.83.0` (named in the original
  draft of this section) must not be used**: it was renamed for the 0.84 line,
  it pins `pi-agent-core@^0.83.0` so it duplicates the runtime in the tree, and
  the `Session` it returns has an incompatible method surface. Details and
  evidence: `docs/pi-notes.md` §1.1.
- **PR-005 findings are recorded in `docs/pi-notes.md`.** Read §6
  (contradictions with `docs/system-design.md`) and §8 (consequences for
  PR-020…PR-023) before starting any agent-lane PR. Amendment 3 below is
  closed: Codex subscription auth *is* supported in the pinned release.
- Top risks (details in `dp/m1.md` §Risks): Pi API mismatch vs doc
  assumptions; TCC permission attribution for the spawned Swift helper; Codex
  subscription support in the pinned Pi release; double-JPEG small-text
  legibility; ~~`sharp` prebuilds inside packaged Electron (arm64)~~.
- **The `sharp` packaging risk is closed** (PR-018): there is no native image
  dependency. PNG runs on Node's built-in `node:zlib`, JPEG on pure-JS
  `jpeg-js@0.4.4`, `bgra` on a channel swap. PR-042 has no image-related
  packaging work. What replaced it is a *latency* risk, measured and recorded in
  `docs/handoff.md` §5: decoding a JPEG source frame in pure JavaScript costs
  ~165 ms for a 1440×960 frame, which is the only path that misses §17's 150 ms
  preprocessing budget. The cheapest fix is for **PR-012 to deliver `bgra` or
  `png` frames instead of JPEG** — no contract change needed, and it also
  removes the double-JPEG legibility risk.
- **Double-JPEG legibility is now measured, not assumed** (PR-018): on a pointer
  crop at a non-block-aligned offset, a second JPEG generation at q0.75 roughly
  doubles the luma error and the share of visibly-damaged pixels. The pipeline
  avoids paying it by passing an unchanged full frame through unencoded and by
  encoding interface content losslessly. `pnpm --filter @pilot/observation
  demo:image` prints the numbers.
- **TCC attribution now has detection but not an answer** (PR-011). The adapter
  establishes which process macOS credits grants to and raises a typed
  `permission-attribution-mismatch` instead of reporting a permission Pilot
  cannot use. The verdict logic is fully tested on Linux; which verdict a real
  Mac produces is unknown until §5a's last row runs. PR-012…PR-015 all assume
  it comes back `matched`.
- **Signing**: development signing only. Notarization is a recorded gap
  against the DoD (user decision — no Developer ID account yet).
- **Grounding metric**: manual checklist over real apps (user decision), not
  a purpose-built test app.
- Effort note: implementation.md's PR size bands sum to roughly 2–3× the
  estimate in `dp/m1.md`; treat dates with suspicion until a few PRs calibrate
  actual velocity.

## 8. Current status

Keep this current. A fresh session should be able to resume from here plus
`git log --oneline | grep 'PR-'`.

### Phase 1 — COMPLETE (2026-08-10)

All seven foundation PRs are merged to `main`, each through its own pull
request. Environment: Node 24.19.0 (installed via `/opt/nvm`, set as default),
pnpm 10.33.

| PR | What landed | PR # |
| --- | --- | ---: |
| 001 | Workspace, contracts, fakes (no CI) | — |
| 002 | Desktop shell: Electron lifecycle, tray, panel, validated IPC | #3 |
| 003 | Native helper transport: framed stdio v1, supervision | #6 |
| 004 | Observation core: frame ring, pointer timeline, scene tracker | #2 |
| 005 | Pi capability spike — see `docs/pi-notes.md` | #5 |
| 006 | Interaction state machine: 330-cell total transition table | #4 |
| 007 | Development build baseline: electron-vite, packaging | #7 |

Verified from a clean tree (all `dist/` removed) after Phase 1: `pnpm lint`,
`typecheck`, `test` (33 files, 415 tests), `build` all pass, and all four
demos run — observation, interaction, agent `observe_screen`, helper
transport. The packaged bundle launches headlessly and completes a validated
IPC round trip (`pnpm --filter @pilot/desktop run smoke:packaged`).

### Phase 2 — in flight

Lanes run concurrently in worktrees. Merged so far: PR-008, PR-011, PR-016,
PR-017, PR-018, PR-020, PR-021, PR-022a, PR-024, PR-025. In flight at the time
PR-018 landed: PR-009, PR-012, PR-013, PR-014, PR-022b, PR-026.

The observation lane (PR-016 → 017 → 018) has closed its image work: §10's
step 5 now produces real pixels behind the `ImageProcessor` seam PR-017 left,
with no native image dependency. PR-019 is unblocked.

### Cross-lane issues found while merging — read before adding a lane

1. **Root config collides on every merge.** `tsconfig.json`,
   `tsconfig.base.json`, `vitest.config.ts`, `package.json` and `README.md`
   conflict each time. Every collision so far has been a **union, not a
   choice** — each lane needs its own project reference, path alias and vitest
   entry. Resolve as a union, then re-run the full §6 gate; a clean merge does
   not imply a working tree.
2. **A contract change can pass typecheck and still break the app.** PR-006
   added `dismiss-error` to `InteractionCommand`; the desktop's zod validator
   did not gain it, so the renderer could never dispatch it and the `error`
   state had no exit. `z.ZodType<T>` does not catch this — a narrower union
   stays assignable. The command-schema test now keys samples by
   `InteractionCommand['type']` via a `Record` so TypeScript fails the build.
   **Use that pattern for any new discriminated-union contract.**
3. **Lint was nondeterministic** until `.claude/` was excluded: `eslint .`
   descended into other agents' half-written worktrees.
4. **Do not trust a subagent's "all green" report.** Re-run the gate yourself
   after merging. PR-004's agent reported lint passing, and in its isolated
   worktree that was true — the failure only appeared with other lanes running.
5. **Two lanes can add the same method to the same fake, and git will merge
   both.** PR-011 and PR-016 each added `FakeWindowAdapter.changeWindow` with
   different signatures; the textual merge was clean and `tsc` then reported
   `TS2393: Duplicate function implementation`. Resolution: keep both under
   distinct names when both behaviours are wanted (here `changeWindow` for the
   detailed form and `replaceWindow` for the upsert form) rather than deleting
   one lane's and silently changing its tests' meaning.
6. **A richer fake changes event counts.** PR-011 made `closeWindow` also emit
   `window-list-changed`, which is more faithful — a closing window really does
   change the list — and that broke a PR-016 test asserting an exact ignored-
   event count. Update the count and say why in a comment; do not weaken the
   assertion to a range, and do not revert the more faithful behaviour.
7. **Timing-sensitive tests fail under concurrent agent load, not from a
   defect.** With seven lanes building at once, two suites have failed once
   each and passed on every rerun and in isolation:
   `packages/observation/test/bounds.stress.test.ts` (20k frames at 60 FPS) and
   `packages/platform-mac/test/helper-transport.test.ts` ("rejects in-flight
   work and reports the crash", which races a helper crash against a request
   deadline). **Before treating either as a regression, re-run it alone.** If
   one starts failing in isolation, that is real. Do not "fix" them by widening
   their tolerances — the bounds and the deadline are the properties under
   test, and a stress test that cannot fail proves nothing.
7. **A test that anticipates a later PR must be updated, not deleted.** PR-011
   asserted "binary is attached to nothing but `echo`" and said in a comment
   that capture frames arrive in PR-012. They did: `capture.pull` answers with
   a binary body. PR-012 narrowed that assertion to "nothing but `echo` and
   `capture.pull`, and only on the response" and said why in the comment,
   rather than removing it — the invariant it was protecting (a permission or
   window response must never carry bytes) is still worth having.
8. **Optional interface members are the additive shape that works.** PR-011
   added `PermissionAdapter.attribution?()`; PR-012 added
   `ObservationAdapter.subscribeEvents?`. Both are source-compatible — existing
   implementations, including the shared fakes, still satisfy the interface
   untouched — which matters because `packages/platform/src/adapters.ts`
   collides on nearly every merge. Keep such additions in one contiguous block
   marked with the PR id so the collision resolves as a union.

8. **Never union conflict regions in *code* mechanically.** Merging PR-012,
   PR-013 and PR-014 — three lanes appending to the same protocol registry,
   the same Swift `HelperServer` and the same Node stub — a textual union
   introduced four defects that no conflict marker showed:
   - a **dropped comma** in a Swift parameter list (`accessibility: … ()`
     followed by `speechInput:`), which only a Mac compile would catch;
   - a **duplicated `private var eventCounter`** and a duplicated doc comment
     in the same Swift class;
   - a **dropped closing brace** on a TypeScript function, which moved every
     following declaration inside it — `tsc` reported it only as `'}' expected`
     at end of file, 600 lines away from the cause;
   - a block of interface fields unioned into the **wrong interface**, so
     `StubConfig` compiled while the code reading those fields did not.

   Union the *lists* (registry entries, exports, switch cases, doc rows); write
   the *prose* deliberately, because two lanes each describing "the third
   adapter" produce contradictory paragraphs. Afterwards check, in order:
   `grep` for duplicate declarations and duplicate switch cases, a brace-balance
   scan that skips strings and comments, then `pnpm typecheck`. For Swift,
   none of this is caught by any gate here — read the init parameter list and
   the property block by eye.

### Pending cross-lane follow-ups

Open items a later PR must close. Each was raised by the lane that found it.

| # | Item | Must be closed by |
| --- | --- | --- |
| 1 | **PR-029 must pass `renderAnchoredQuestionEnvelope`** (exported from `@pilot/interaction`) as `PilotSessionOptions.renderEnvelope`, or teach `packages/agent`'s `renderQuestionEnvelope` about `anchor`. PR-024 deliberately did not edit the agent renderer because that lane was running in parallel. Left undone, an unknown pointer prints to the model as `-1.000, -1.000` — a coordinate the model would reasonably treat as real. | PR-029 |
| 2 | **`QuestionEnvelope.pointer` uses a sentinel, not `null`.** system-design §8 types it as a required numeric pair, so "no pointer was recorded" is carried as `UNKNOWN_NORMALIZED_POINT` (`-1,-1`, deliberately outside `[0,1]`) plus `grounding: 'pointer-unknown'`, read through `envelopePointerKnown()`. Making it nullable is the cleaner shape and needs a coordinated change across two readers. | PR-029 or a focused contract PR |
| 3 | **`QuestionAnchorSource` is declared on the interaction side** because no contract exposed scene plus pointer-by-instant/interval to that lane. It mirrors `PointerTimeline.select`/`.between` including the tie-break, so PR-031's adapter is the identity function. If it belongs on `ScreenContextService` instead, moving it is mechanical. | PR-031 |
| 4 | **The panel must offer text input in the `error` state.** PR-025 changed the transition table so `error + submit-text` is accepted (system-design §16: "STT fails → … then offer text input"); a failed recogniser is exactly what puts the machine in `error`. `isTextFallbackAvailable(state)` (exported from `@pilot/interaction`, derived from the table) is the affordance test the renderer should use — if the panel disables its text box whenever `state === 'error'`, the documented fallback is unreachable in the app even though the machine allows it. | PR-010 or PR-032 |
| 5 | **The app must wire the observation notebook** (PR-022a). `createObservationNotebook()` from `@pilot/agent` has to be passed *twice* — as `createObserveScreenTool({ onObservation: notebook.note })` and as `new PiAgentSession({ visualContext: { summaryFor: notebook.summaryFor } })`. Wire neither and pruning still holds the image limits, but every replacement record degrades to "No description of that frame was recorded." — truthful, and useless. The same notebook now also feeds compaction summaries (PR-022b), so the cost of not wiring it has gone up. `packages/agent/demo/visual-context-demo.mjs` shows the wiring. | PR-029 |
| 6 | **The native TTS adapter must report per-chunk identifiers.** PR-026 speaks an answer as several adapter utterances named `<speechId>#<n>` (`speechChunkId()`, exported from `@pilot/interaction`); `SpeechOutputBinding` matches every `started`/`finished`/`stopped`/`error` callback against the chunk currently in flight and discards the rest. A native adapter that reports the *stream* id, or a different id of its own, will have every callback discarded as `unknown-chunk` and the answer will never report completion. Echo back the `speechId` the request carried. | PR-014 / PR-033 |
| 7 | **A stalled-but-open run does not speak its tail until it ends.** The phrase timeout is evaluated against the injected clock whenever a run event arrives, and unconditionally at `run-completed`, so nothing is ever lost — but a model that emits a clause and then goes quiet without ending the run stays silent until it does. A real-time wake-up needs either a new machine input or a scheduler in library code; neither belonged in PR-026's scope. | PR-027, if wanted |
| 8 | ~~**PR-023 must persist the compaction summary alongside the transcript** (PR-022b).~~ **CLOSED by PR-023.** `ConversationStore.saveCompaction()` writes `{ generation, boundaryIndex, summary, summaryTimestamp, observationsAtLastCompaction, questions }` as a namespaced custom entry (`pilot.compaction.v1`) beside the transcript, enqueued *behind* the message writes so the boundary always indexes a transcript that is already durable; `restore()` reads both back and `PiAgentSessionOptions.restore` reinstates them together. Measured in `pnpm --filter @pilot/agent run demo:persistence` §4b: the first provider request after a relaunch is 30 messages with the summary and 49 without. | ~~PR-023~~ |
| 9 | **PR-036 should set `compaction.contextWindow` from the real profile, and the panel should surface `context-compacted`** (PR-022b). The default is `model.contextWindow`, which is right for a hosted model and too generous for a local one that advertises more than it handles well. `PiAgentSession.lastCompaction` carries the triggers and the before/after token estimate for the diagnostics panel; the `context-compacted` event itself carries only the summary text. | PR-036, PR-010 |
| 10 | **`apps/desktop/src/main/window-feed.ts` must be deleted** (PR-009). It is the `ObservationInteraction` port over the *fake* interaction controller, which has no event input, so `windows-changed` and `window-closed` are applied to its view state by hand — reproducing `@pilot/interaction`'s transition-table rows for those two events. The port's `report(event)` is deliberately shaped as those two `InteractionEvent` members, so the real wiring is `report: (event) => controller.send(event)` and nothing else changes. Leave the fake bridge in and the §16 behaviour is asserted twice, in two places that can drift. | PR-029 |
| 11 | **Nothing acts on `screen-locked` / `screen-unlocked` in the desktop shell** (PR-009). `WindowGate` subscribes to the window adapter and logs those two events rather than handling them; system-design §6 and §14 require capture to stop and buffers to clear on lock. The interaction table already has the rows (`screen-locked` → stop-capture + clear-buffers), so the fix is the same one-line change as follow-up 6 — forward them through the port instead of logging them. Until then a locked screen is a gap on the fake shell only, because no capture exists yet. | PR-029 (with 6) |
| 12 | **Voice input is not gated on TCC attribution.** `MacSpeechInputAdapter` reads the Microphone and Speech Recognition states from the helper's own probes and refuses when either is not `granted`. It does **not** run PR-011's attribution check, which is what turns "the OS says granted" into "the grant reaches this process" — coupling the two adapters would have meant a dependency and an extra round trip on every push-to-talk. If attribution is wrong, voice input will report `granted` and then fail to hear anything, exactly the silent wrong answer PR-011 exists to prevent. The wiring PR should establish attribution once through `MacPermissionAdapter` before enabling the voice path. | PR-032 |
| 13 | **`SpeechInputAdapter.disclosure()` has no route to the renderer.** PR-014 added the optional method and the `SpeechRecognitionDisclosure` shape in `@pilot/shared` (with a zod schema, so it can cross IPC as it stands), but nothing surfaces it. Left unwired, a Mac that cannot recognise the user's language locally simply refuses to listen with a message nobody sees, which reads as a broken microphone. | PR-032, with PR-010 for the panel |
| 6 | ~~**A stalled-but-open run does not speak its tail until it ends.**~~ **Accepted and closed by PR-027**, but the app must opt in. The wake-up is a new machine input (`phrase-timeout`, guarded by `pendingAnswerSince` like every other identity) plus an injected `Scheduler` port — not a timer in the machine. `PilotInteractionController` arms it only when a `scheduler` option is passed; the default never fires and behaves exactly as PR-026 did. **Pass `createTimeoutScheduler()` (exported from `@pilot/interaction`) when the controller is constructed in the app**, or a model that stalls mid-sentence still says nothing until its run ends. | ~~PR-027~~ — remaining wiring: PR-033 / PR-035 |
| 14 | **A new question during `observe_screen` steers the old run *and* submits a new one.** PR-006 chose `steer` in `observing-screen` so a capture can unwind (§15), but `steer` does not end the run: with the real `PiAgentSession`, the `submit-question` that follows in the same transition hits `run-already-active` and surfaces as a user-visible error ("Pilot is still working on the previous question"). It recovers — the failure teardown aborts the steered run — but the interruption did not do what the user asked. The fakes now model this faithfully (`InterruptibleAgentSession`), and `test/interruption.test.ts` pins the current behaviour so it cannot drift silently. The fix is a design decision PR-027 declined to take alone: either deliver the new question *as* the steering message (keeping `activeRunId`, no new run), or abort instead of steering once a replacement question exists. | PR-035 |
| 15 | **The native TTS adapter must tolerate a `stop()` for a stream it never started.** PR-027 stops speech the instant an interruption lands, which can be before the first chunk of that stream reached the synthesiser. `SpeechOutputBinding` remembers the identifier and discards the chunk when it arrives, so the adapter sees a `stop()` for something it has never heard of. That must be a no-op, not an error. | PR-014 / PR-033 |
| 16 | **`PilotImageProcessor.clear()` must be wired into the retention guard** (PR-018). The processor keeps at most one decoded frame in memory so `view: 'both'` decodes its source once instead of twice. It is memory-only and never written anywhere, but it is a decoded screenshot and must be dropped on pause, screen lock, window loss and shutdown alongside the frame ring. `RetentionGuard` takes `core`, `policy` and `rateLimiter` today; add the processor there, or call `clear()` from whatever owns both. | PR-019 |
| 17 | **Capture should hand over `bgra` or `png`, not `jpeg`** (PR-018). No contract change: `FrameEncoding` already admits all three and `CaptureOptions` says nothing about encoding. Delivering an encoded JPEG costs ~165 ms of pure-JS decode per observation that needs a pointer crop (the only path over §17's 150 ms budget) and adds a second generation of compression loss to exactly the small text grounding depends on. `png` fits the 16 MiB ring ceiling where `bgra` does not; `bgra` is the right choice for the fresh `captureFresh` path, which does not enter the ring. Measured in `pnpm --filter @pilot/observation demo:image` §5. | PR-012, confirmed in PR-028 |
| 4 | **The panel must offer text input in the `error` state.** PR-025 changed the transition table so `error + submit-text` is accepted (system-design §16: "STT fails → … then offer text input"); a failed recogniser is exactly what puts the machine in `error`. `isTextFallbackAvailable(state)` (exported from `@pilot/interaction`, derived from the table) is the affordance test the renderer should use — if the panel disables its text box whenever `state === 'error'`, the documented fallback is unreachable in the app even though the machine allows it. **PR-015 adds a second trigger for the same affordance**: when `HotkeyAdapter` reports `availability.status !== 'active'` there is no way to speak at all, so the text box is the only way to ask. Pair `isHotkeyUsable()` with `isTextFallbackAvailable()` and show `hotkeyUnavailableMessage()`. | PR-010 or PR-032 |
| 6 | **PR-032 must wire the hotkey adapter to the controller.** `MacHotkeyAdapter` emits `hotkey-down`/`hotkey-up`; the controller takes `push-to-talk-down`/`push-to-talk-up`. The mapping is one `subscribe` and a `switch`, but two details are not optional: a `hotkey-up` with `synthetic: true` must still dispatch `push-to-talk-up` (it is how a dead tap releases the microphone), and `hotkey-availability-changed` must reach the UI or an unavailable shortcut looks like a broken one. | PR-032 |
| 5 | **The app must wire the observation notebook** (PR-022a). `createObservationNotebook()` from `@pilot/agent` has to be passed *twice* — as `createObserveScreenTool({ onObservation: notebook.note })` and as `new PiAgentSession({ visualContext: { summaryFor: notebook.summaryFor } })`. Wire neither and pruning still holds the image limits, but every replacement record degrades to "No description of that frame was recorded." — truthful, and useless. `packages/agent/demo/visual-context-demo.mjs` shows the wiring. | PR-029 |
| 18 | **The app must own the `ConversationStore` lifecycle** (PR-023). `openConversationStore({ conversationId, directory })` → `store.restore()` → `new PiAgentSession({ store, restore })`, and `store.close()` on `before-quit`. Three details are not optional. (a) The SQLite **writer lease** is per process: a second instance fails immediately with a `WriterLeaseHeldError` (`isWriterLeaseHeld(error)`, `details.reason === 'writer-lease-held'`, `code: 'internal'`) — pair it with `app.requestSingleInstanceLock()` and surface `error.userMessage`; a crashed process holds it for 30 s more and then the next launch takes over by itself, so do not delete the database to "fix" a launch. (b) Skip `restore` and the user's history is silently invisible to the model even though it is on disk. (c) Skip `store.close()` and every relaunch inside 30 s fails. `packages/agent/demo/persistence-demo.mjs` shows the whole sequence. | PR-036 |
| 19 | **`clearConversation()` needs a route to the panel** (PR-023). `AgentSession.clearConversation?()` is the new optional facade member (system-design §13); `PiAgentSession` implements it, aborting an active run, dropping the transcript and the summary together, and reclaiming the SQLite pages so the text is gone from the file rather than merely unreachable. Nothing in the renderer or the IPC surface offers it yet, so today the only way to clear a conversation is from code. | PR-010 / PR-036 |

## 9. Quick start for a new session

1. Read this file, then `docs/implementation.md`, then `dp/m1.md`.
2. `nvm use` (Node 24), confirm `pnpm --version` works.
3. Recreate the task list from §5 (one task per PR, wire `blockedBy` from the
   Depends-on column; tag parallel groups per §4).
4. Find the first PR whose dependencies are all merged (check `git log
   --oneline` for `PR-NNN:` prefixes) and dispatch a subagent for it.
5. Review, verify (§6), commit as `PR-NNN: <title>`, repeat. Batch
   Mac-dependent verification; never mark a Mac-gated PR complete until it has
   actually run on the Mac.
