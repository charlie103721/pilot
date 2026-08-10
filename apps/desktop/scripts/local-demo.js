import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

/**
 * Runs PR-039's walkthrough (`pnpm demo:local`): Pilot as one app against a
 * locally running OpenAI-compatible endpoint — base URL and model settings, the
 * endpoint health check, the vision and tool capability probe, every
 * unsupported-model diagnostic with the sentence the user would see, the
 * capability gate refusing before any screen data is sent, and locality
 * labelling.
 *
 * The walkthrough itself is TypeScript shared with the app
 * (`src/main/local-demo.ts` over `src/main/local-model.ts`,
 * `src/main/agent-runtime.ts` and `src/main/interaction-runtime.ts` — the same
 * three the composition root uses), so the demo exercises the code that ships
 * rather than a parallel description of it. Vite loads it through the same
 * workspace aliases `electron.vite.config.ts` and `vitest.config.ts` use, which
 * is why this script needs no build step.
 *
 * `@earendil-works/*` is inlined rather than externalized: those packages are
 * resolvable from `packages/agent`, not from `apps/desktop`, which is exactly
 * the arrangement that keeps Pi out of the app's own dependency list.
 *
 * **THE ENDPOINT IS A STUB WRITTEN FOR THIS PR** — an HTTP server that answers
 * in OpenAI shapes, on 127.0.0.1, with scripted replies. There is no inference
 * server, no model weights and no GPU on this machine. It is NOT a second Pilot
 * service: `docs/implementation.md` PR-039 forbids one and nothing in production
 * constructs it. `docs/handoff.md` §1 step 17 lists what only a real local model
 * server can answer.
 *
 * Usage:
 *   pnpm demo:local
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
  const module = await server.ssrLoadModule('/src/main/local-demo.ts');
  const result = await module.runLocalDemo();
  process.stdout.write(`${result.lines.join('\n')}\n`);
} finally {
  await server.close();
}
