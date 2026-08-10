import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

/**
 * Runs the conversation and diagnostics walkthrough (`pnpm demo:conversation`).
 *
 * The walkthrough itself is TypeScript shared with the app
 * (`src/conversation/demo.ts`), so the demo exercises the code that ships
 * rather than a parallel description of it — the same arrangement
 * `scripts/windows-demo.js` uses. Vite loads it through the same workspace
 * aliases `electron.vite.config.ts` and `vitest.config.ts` use, which is why
 * this script needs no build step and no extra dependency.
 *
 * Usage:
 *   pnpm demo:conversation
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
      { find: '@pilot/platform', replacement: resolve(repoRoot, 'packages/platform/src/index.ts') },
      {
        find: '@pilot/interaction',
        replacement: resolve(repoRoot, 'packages/interaction/src/index.ts'),
      },
      { find: '@pilot/shared', replacement: resolve(repoRoot, 'packages/shared/src/index.ts') },
    ],
  },
});

try {
  const module = await server.ssrLoadModule('/src/conversation/demo.ts');
  const result = await module.runConversationDemo();
  process.stdout.write(`${result.lines.join('\n')}\n`);
} finally {
  await server.close();
}
