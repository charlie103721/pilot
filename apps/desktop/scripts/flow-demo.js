import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

/**
 * Runs PR-034's walkthrough (`pnpm demo:flow`): the MVP "point, ask, hear"
 * scenario as one trace — select a window, hold the key, speak, let the model
 * call `observe_screen`, read the answer, hear it, interrupt it and ask a
 * follow-up — plus the invariants every earlier PR established, checked on that
 * same trace, and one refusal the user can carry on past.
 *
 * The walkthrough itself is TypeScript shared with the app
 * (`src/voice/flow-demo.ts` over `src/observation/observe-rig.ts`, the same rig
 * PR-028, PR-030, PR-031, PR-032 and PR-033 use), so the demo exercises the code
 * that ships rather than a parallel description of it. Vite loads it through the
 * same workspace aliases `electron.vite.config.ts` and `vitest.config.ts` use,
 * which is why this script needs no build step and no extra dependency.
 *
 * It spawns the Node helper stub as a child process — the same stub
 * `packages/platform-mac` tests itself against — and drives Pi's faux provider
 * with a scripted reply. **There is no macOS, no key, no microphone, no speaker
 * and no model here** (runbook §5 amendment 8); sections 4 and 5 of the output
 * say exactly which acceptance rows that leaves unevidenced.
 *
 * Usage:
 *   pnpm demo:flow
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
  const module = await server.ssrLoadModule('/src/voice/flow-demo.ts');
  const result = await module.runFlowDemo();
  process.stdout.write(`${result.lines.join('\n')}\n`);
} finally {
  await server.close();
}
