import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

/**
 * Runs PR-041's audit (`pnpm demo:privacy`): twenty claims about what Pilot
 * keeps, writes and sends, each treated as something to falsify.
 *
 * The audit itself is TypeScript shared with the app
 * (`src/privacy/privacy-audit.ts` over `src/observation/observe-rig.ts`, the
 * same rig PR-028…PR-040 use), so it audits the code that ships rather than a
 * parallel description of it. Vite loads it through the same workspace aliases
 * `electron.vite.config.ts` and `vitest.config.ts` use, which is why this script
 * needs no build step and no extra dependency.
 *
 * It spawns the Node helper stub as a child process several times, writes to a
 * real SQLite session database and two real credential files in a fresh
 * temporary directory, opens a socket to a closed port, and drives Pi's faux
 * provider with a scripted reply. **There is no macOS, no model, no credential,
 * no audio and no pixels here**; section 10 of the output is the list of privacy
 * properties that leaves for the user's Mac, and `docs/handoff.md` §1 step 21 is
 * its runnable form.
 *
 * Exits non-zero when any claim failed or when a claim that was supposed to run
 * did not — an audit that silently stops checking is the failure this walkthrough
 * exists to prevent, so it must not be able to end quietly.
 *
 * Run `pnpm build` first if you want the built bundle inspected too; without it
 * that one check reports UNPROVABLE rather than passing.
 *
 * Usage:
 *   pnpm demo:privacy
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

let result;
try {
  const module = await server.ssrLoadModule('/src/privacy/privacy-audit.ts');
  result = await module.runPrivacyAudit();
  process.stdout.write(`${result.lines.join('\n')}\n`);
} finally {
  await server.close();
}

// A failed claim, or a claim that never ran, must not exit 0: this walkthrough
// is a gate, not a report.
if (result?.ok !== true) {
  process.exitCode = 1;
}
