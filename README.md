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
packages/shared/       identifiers, geometry, errors, IPC envelopes, logging, domain types
packages/platform/     adapter interfaces, cross-block service contracts, fakes
packages/interaction/  the interaction state machine, its transition table and controller
```

Later PRs add `apps/desktop/`, `packages/platform-mac/`, `packages/observation/`
and `packages/agent-runtime/` per `docs/system-design.md` §20.

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
