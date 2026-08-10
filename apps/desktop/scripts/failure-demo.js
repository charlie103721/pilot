import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

/**
 * Runs PR-040's walkthrough (`pnpm demo:failure`): the failure matrix — a
 * permission revoked mid-session, a screen locked, a logout, a window closed
 * (twice, once with an observation in flight), a window that blocks capture, a
 * helper that crashes during a capture pull and again during a spoken sentence,
 * a recogniser that will not start, a synthesiser that fails mid-answer, a
 * provider that signs Pilot out, and a request Pilot deliberately refuses to
 * retry.
 *
 * Every case ends recovered or in a safe terminal state, and the walkthrough
 * prints which, what the user sees, and what was left behind.
 *
 * The walkthrough itself is TypeScript shared with the app
 * (`src/lifecycle/failure-demo.ts` over `src/observation/observe-rig.ts`, the
 * same rig PR-028…PR-036 use), so it exercises the code that ships rather than a
 * parallel description of it. Vite loads it through the same workspace aliases
 * `electron.vite.config.ts` and `vitest.config.ts` use, which is why this script
 * needs no build step and no extra dependency.
 *
 * It spawns the Node helper stub as a child process — nine times, because
 * several of these cases are about a helper that dies — and drives Pi's faux
 * provider with a scripted reply. **There is no macOS and no model here**;
 * section 16 of the output says what that leaves unproven.
 *
 * Usage:
 *   pnpm demo:failure
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
  const module = await server.ssrLoadModule('/src/lifecycle/failure-demo.ts');
  const result = await module.runFailureDemo();
  process.stdout.write(`${result.lines.join('\n')}\n`);
} finally {
  await server.close();
}
