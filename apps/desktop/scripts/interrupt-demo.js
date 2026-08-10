import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

/**
 * Runs PR-035's walkthrough (`pnpm demo:interrupt-flow`): end-to-end
 * interruption in the states where it is hard — while the model is looking at
 * the screen (runbook §8 follow-up 14, decided here), twice in quick
 * succession, and in the window between an answer and its first spoken word —
 * plus where the abandoned runs ended, the §17 measurement and what it does not
 * measure, and the three places late output could resurface and does not.
 *
 * The walkthrough itself is TypeScript shared with the app
 * (`src/voice/interrupt-demo.ts` over `src/observation/observe-rig.ts`, the same
 * rig PR-028 through PR-034 use, and PR-034's own trace helpers), so the demo
 * exercises the code that ships rather than a parallel description of it. Vite
 * loads it through the same workspace aliases `electron.vite.config.ts` and
 * `vitest.config.ts` use, which is why this script needs no build step and no
 * extra dependency.
 *
 * It spawns the Node helper stub as a child process — the same stub
 * `packages/platform-mac` tests itself against — and drives Pi's faux provider
 * with scripted replies. **There is no macOS, no key, no microphone, no speaker
 * and no model here** (runbook §5 amendment 8); in particular "the synthesiser
 * was told to stop" is a JSON round trip over a pipe and not sound ceasing.
 * Sections 5 and 8 of the output say so.
 *
 * Usage:
 *   pnpm demo:interrupt-flow
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
  const module = await server.ssrLoadModule('/src/voice/interrupt-demo.ts');
  const result = await module.runInterruptFlowDemo();
  process.stdout.write(`${result.lines.join('\n')}\n`);
} finally {
  await server.close();
}
