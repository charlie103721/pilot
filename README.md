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
typecheck, test and build all pass without it, and only launching the app needs
it. Set `PILOT_SKIP_ELECTRON_DOWNLOAD=1` to skip it.

## Verification

Run from the repository root. These four commands are the only gate — there is
no CI workflow (runbook §5, amendment 5).

```sh
pnpm install
pnpm lint       # eslint + prettier --check
pnpm typecheck  # tsc over every package's src and test files
pnpm test       # vitest
pnpm build      # tsc --build over the project references
```

## Demo (PR-001)

1. Run the complete workspace check above; all four commands must pass.
2. Run one fake adapter contract test on its own:

   ```sh
   pnpm exec vitest run packages/platform/test/fakes.contract.test.ts
   ```

   Every block in that file binds a fake to the interface a real
   implementation will have to satisfy, so it fails to compile if a fake drifts
   from its contract.

## Demo (PR-002 — desktop shell)

Build first (`pnpm build`), then:

```sh
pnpm dev                                    # launch the shell
pnpm --filter @pilot/desktop run smoke      # headless launch check (Linux, Xvfb)
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
