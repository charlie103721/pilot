import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    // Ordered longest-prefix-first: workspace packages resolve to TypeScript
    // sources so `pnpm test` does not require a prior `pnpm build`.
    alias: [
      {
        find: '@pilot/platform/fakes',
        replacement: fromRoot('./packages/platform/src/fakes/index.ts'),
      },
      { find: '@pilot/platform', replacement: fromRoot('./packages/platform/src/index.ts') },
      { find: '@pilot/shared', replacement: fromRoot('./packages/shared/src/index.ts') },
      {
        find: '@pilot/observation',
        replacement: fromRoot('./packages/observation/src/index.ts'),
      },
    ],
  },
  test: {
    environment: 'node',
    // Renderer suites opt into jsdom with a `@vitest-environment` docblock.
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
    reporters: ['default'],
  },
});
