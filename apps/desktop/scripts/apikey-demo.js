import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

/**
 * Runs PR-038's walkthrough (`pnpm demo:apikey`): provider and model selection
 * off Pi's live catalogue, an API key sealed into a file that does not contain
 * it, a capability probe that refuses a text-only model with zero provider
 * requests and a no-tools model with one text-only request, invalid-key
 * detection and recovery, the remote-data banner, and then the acceptance
 * subset — one screen question answered end to end on the verified profile.
 *
 * The walkthrough itself is TypeScript shared with the app
 * (`src/model/apikey-demo.ts`), and the two objects it drives are the ones
 * `main/index.ts` drives: `openApiKeyProfileRuntime` and
 * `src/observation/observe-rig.ts`. Vite loads it through the same workspace
 * aliases `electron.vite.config.ts` and `vitest.config.ts` use, which is why
 * this script needs no build step and no extra dependency.
 *
 * It spawns the Node helper stub as a child process, writes a sealed credential
 * file into a fresh temporary directory and deletes it again. **There is no API
 * key, no provider and no macOS Keychain here**; section 8 of the output says
 * what that leaves unproven.
 *
 * Usage:
 *   pnpm demo:apikey
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
  const module = await server.ssrLoadModule('/src/model/apikey-demo.ts');
  const result = await module.runApiKeyDemo();
  process.stdout.write(`${result.lines.join('\n')}\n`);
} finally {
  await server.close();
}
