import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

/**
 * Runs the text-conversation walkthrough (`pnpm demo:agent`).
 *
 * The walkthrough itself is TypeScript shared with the app
 * (`src/main/agent-demo.ts`), so the demo exercises the code that ships rather
 * than a parallel description of it — the same arrangement
 * `scripts/conversation-demo.js` uses. Vite loads it through the same workspace
 * aliases `electron.vite.config.ts` and `vitest.config.ts` use, which is why
 * this script needs no build step.
 *
 * `@earendil-works/*` is inlined rather than externalized: those packages are
 * resolvable from `packages/agent`, not from `apps/desktop`, which is exactly
 * the arrangement that keeps Pi out of the app's own dependency list.
 *
 * Usage:
 *   pnpm demo:agent
 */

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');

const server = await createServer({
  configFile: false,
  root: appRoot,
  appType: 'custom',
  logLevel: 'warn',
  server: { middlewareMode: true, fs: { allow: [repoRoot] } },
  ssr: { noExternal: [/^@earendil-works\//] },
  resolve: {
    // Longest prefix first, exactly as in vitest.config.ts.
    alias: [
      {
        find: '@pilot/platform/fakes',
        replacement: resolve(repoRoot, 'packages/platform/src/fakes/index.ts'),
      },
      { find: '@pilot/platform', replacement: resolve(repoRoot, 'packages/platform/src/index.ts') },
      {
        find: '@pilot/interaction',
        replacement: resolve(repoRoot, 'packages/interaction/src/index.ts'),
      },
      { find: '@pilot/agent', replacement: resolve(repoRoot, 'packages/agent/src/index.ts') },
      { find: '@pilot/shared', replacement: resolve(repoRoot, 'packages/shared/src/index.ts') },
    ],
  },
});

try {
  const module = await server.ssrLoadModule('/src/main/agent-demo.ts');
  const result = await module.runAgentDemo();
  process.stdout.write(`${result.lines.join('\n')}\n`);
} finally {
  await server.close();
}
