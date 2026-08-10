import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

/**
 * Runs PR-031's walkthrough (`pnpm demo:ask`): point at something, type a
 * question about it, and get an answer grounded in what you were pointing at.
 *
 * The walkthrough itself is TypeScript shared with the app
 * (`src/observation/ask-demo.ts` over `src/observation/observe-rig.ts`, the
 * same rig PR-028 and PR-030 use), so the demo exercises the code that ships
 * rather than a parallel description of it. Vite loads it through the same
 * workspace aliases `electron.vite.config.ts` and `vitest.config.ts` use, which
 * is why this script needs no build step and no extra dependency.
 *
 * It spawns the Node helper stub as a child process — the same stub
 * `packages/platform-mac` tests itself against — and drives Pi's faux provider
 * with a scripted reply. There is neither macOS nor model access here (runbook
 * §5 amendment 8, `docs/handoff.md` §2), and section 7 of the output says what
 * follows from that.
 *
 * Usage:
 *   pnpm demo:ask
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
  const module = await server.ssrLoadModule('/src/observation/ask-demo.ts');
  const result = await module.runAskDemo();
  process.stdout.write(`${result.lines.join('\n')}\n`);
} finally {
  await server.close();
}
