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
packages/shared/      identifiers, geometry, errors, IPC envelopes, logging, domain types
packages/platform/    adapter interfaces, cross-block service contracts, fakes
packages/observation/ frame ring, pointer timeline, scene revision, deterministic clear
```

Later PRs add `apps/desktop/`, `packages/platform-mac/`,
`packages/agent-runtime/` and `packages/interaction/` per
`docs/system-design.md` §20.

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
