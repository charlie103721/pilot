import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

/**
 * Runs PR-043's acceptance and grounding suite (`pnpm acceptance`).
 *
 * The suite walks `docs/mvp-01-point-ask-hear.md` §18's A-01…A-15 and the
 * thirty curated grounding cases, and reports a verdict per criterion out of a
 * closed set — `verified`, `verified-in-part`, `failed`, `blocked-on-mac`,
 * `blocked-on-model`, `not-implemented` — computed from the checks that
 * actually ran rather than asserted. **A criterion with no executed evidence
 * cannot report as passing**; that rule is `acceptanceVerdict` in
 * `src/acceptance/verdict.ts` and it is pinned by its own test.
 *
 * The suite itself is TypeScript shared with the app
 * (`src/acceptance/*.ts` over `src/observation/observe-rig.ts`, the same rig
 * PR-028 through PR-042 use), so it reads its evidence off the objects
 * `main/index.ts` builds rather than off a parallel description of them. Vite
 * loads it through the same workspace aliases `electron.vite.config.ts` and
 * `vitest.config.ts` use, which is why this script needs no build step and no
 * extra dependency.
 *
 * **There is no macOS, no model, no microphone, no speaker and no screen here**
 * (runbook §5 amendment 8). The suite says so at the top of its own output and
 * prints the verdict distribution before anything else, because most of A-01…
 * A-15 remains blocked and a reader who skims must not come away thinking
 * otherwise.
 *
 * Usage:
 *   pnpm acceptance
 */

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');

const server = await createServer({
  configFile: false,
  root: appRoot,
  appType: 'custom',
  logLevel: 'warn',
  server: { middlewareMode: true, fs: { allow: [repoRoot] } },
  resolve: {
    // Longest prefix first, exactly as in vitest.config.ts.
    alias: [
      {
        find: '@pilot/platform/fakes',
        replacement: resolve(repoRoot, 'packages/platform/src/fakes/index.ts'),
      },
      {
        find: '@pilot/platform-mac',
        replacement: resolve(repoRoot, 'packages/platform-mac/src/index.ts'),
      },
      { find: '@pilot/platform', replacement: resolve(repoRoot, 'packages/platform/src/index.ts') },
      { find: '@pilot/shared', replacement: resolve(repoRoot, 'packages/shared/src/index.ts') },
      {
        find: '@pilot/observation',
        replacement: resolve(repoRoot, 'packages/observation/src/index.ts'),
      },
      {
        find: '@pilot/interaction',
        replacement: resolve(repoRoot, 'packages/interaction/src/index.ts'),
      },
      { find: '@pilot/agent', replacement: resolve(repoRoot, 'packages/agent/src/index.ts') },
    ],
  },
});

try {
  const module = await server.ssrLoadModule('/src/acceptance/acceptance-suite.ts');
  const result = await module.runAcceptanceSuite();
  process.stdout.write(`${result.lines.join('\n')}\n`);
  // The exit code is the one thing a reader cannot misread. A criterion that
  // ran and *failed* is a defect; a criterion that is blocked is not, and the
  // distribution at the top of the output is where the blocked ones are read.
  process.exitCode = result.failed === 0 ? 0 : 1;
} finally {
  await server.close();
}
