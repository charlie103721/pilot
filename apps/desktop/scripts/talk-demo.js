import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

/**
 * Runs PR-032's walkthrough (`pnpm demo:talk`): hold the push-to-talk key while
 * another application is in front, speak, let go, and see the question
 * submitted — plus the four ways it can go wrong and still leave the user able
 * to ask.
 *
 * The walkthrough itself is TypeScript shared with the app
 * (`src/voice/talk-demo.ts` over `src/observation/observe-rig.ts`, the same rig
 * PR-028, PR-030 and PR-031 use), so the demo exercises the code that ships
 * rather than a parallel description of it. Vite loads it through the same
 * workspace aliases `electron.vite.config.ts` and `vitest.config.ts` use, which
 * is why this script needs no build step and no extra dependency.
 *
 * It spawns the Node helper stub as a child process — the same stub
 * `packages/platform-mac` tests itself against — and drives Pi's faux provider
 * with a scripted reply. **No key has ever been pressed and no audio has ever
 * been recorded**: there is no macOS, no CGEventTap and no microphone here
 * (runbook §5 amendment 8), and section 8 of the output says what follows.
 *
 * Usage:
 *   pnpm demo:talk
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
  const module = await server.ssrLoadModule('/src/voice/talk-demo.ts');
  const result = await module.runTalkDemo();
  process.stdout.write(`${result.lines.join('\n')}\n`);
} finally {
  await server.close();
}
