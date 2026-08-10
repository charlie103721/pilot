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
packages/observation/  frame ring, pointer timeline, scene revision, deterministic clear
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
the floating panel, or the panel's own **Fake state** row to render each
interaction state — `idle`, `listening`, `thinking`, `speaking`, `observing`
and `error`. Everything is driven by the PR-001 fake interaction controller;
there is no real platform, agent or voice code yet.

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
