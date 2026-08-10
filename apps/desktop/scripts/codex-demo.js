import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

/**
 * Runs PR-037's walkthrough (`pnpm demo:codex`): device-code sign-in, token
 * lifecycle, the vision/tool capability gate refusing before any screen data is
 * read, auth-expiry recovery, the MVP point-ask-hear flow on the Codex profile,
 * and a scan proving no credential reaches renderer state, an application log,
 * a session transcript or a provider request.
 *
 * The walkthrough itself is TypeScript shared with the app
 * (`src/codex/codex-demo.ts` over `src/main/codex-runtime.ts` and
 * `src/observation/observe-rig.ts`), so the demo exercises the code that ships
 * rather than a parallel description of it. Vite loads it through the same
 * workspace aliases `electron.vite.config.ts` and `vitest.config.ts` use, which
 * is why this script needs no build step and no extra dependency.
 *
 * Section 5 spawns the Node helper stub as a child process — the same stub
 * `packages/platform-mac` tests itself against. **There is no ChatGPT account,
 * no sign-in, no token, no network and no macOS here**; section 7 of the output
 * says what that leaves unproven.
 *
 * Usage:
 *   pnpm demo:codex
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
  const module = await server.ssrLoadModule('/src/codex/codex-demo.ts');
  const result = await module.runCodexDemo();
  process.stdout.write(`${result.lines.join('\n')}\n`);
} finally {
  await server.close();
}
