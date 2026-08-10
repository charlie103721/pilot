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

## 5a. Pending Mac batch

Everything below needs the user's Mac. Nothing else is blocked on it.

| What | Command / action | From |
| --- | --- | --- |
| Compile the Swift helper | `swift build --package-path native` in `packages/platform-mac` | PR-003 |
| Swift unit tests | `swift test --package-path native` | PR-003 |
| Helper demo against the real binary | `pnpm --filter @pilot/platform-mac demo` | PR-003 |
| Codex sign-in probe | `docs/pi-notes.md` §9.1 | PR-005 |
| Desktop shell visual demo | `pnpm dev` — menu bar item, panel, fake states | PR-002 |

A Swift compile failure is a **PR-003 defect**: send the compiler output and it
gets fixed, not worked around. Nothing in `native/` touches ScreenCaptureKit,
Accessibility or entitlements yet, so this batch should raise no TCC prompt —
it isolates "does the helper build and talk" from "does macOS trust it".

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
  legibility; `sharp` prebuilds inside packaged Electron (arm64).
- **Signing**: development signing only. Notarization is a recorded gap
  against the DoD (user decision — no Developer ID account yet).
- **Grounding metric**: manual checklist over real apps (user decision), not
  a purpose-built test app.
- Effort note: implementation.md's PR size bands sum to roughly 2–3× the
  estimate in `dp/m1.md`; treat dates with suspicion until a few PRs calibrate
  actual velocity.

## 8. Current status

- Nothing implemented yet. Repo contains docs, `dp/m1.md`, `.nvmrc`, and this
  runbook.
- 2026-08-10: execution started on branch
  `claude/implementation-md-approach-21bepa` (Linux session). Node 24.19.0
  installed via `/opt/nvm` and set as default; pnpm 10.33 confirmed; Pi
  packages re-verified on npm. PR-001 dispatched.
- Next action: **PR-001** (solo, on `main`), then fan out PR-002…PR-007 in
  parallel worktrees (per amendment 6: 003/004/005/006 parallel, 002 → 007
  sequential pair).
- After PR-001, keep a running status section here (or in commit history) so
  any session can resume: which PRs are merged, which are in flight, and any
  contract-change follow-ups pending.

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
