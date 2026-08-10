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
      {
        find: '@pilot/platform-mac',
        replacement: fromRoot('./packages/platform-mac/src/index.ts'),
      },
      { find: '@pilot/platform', replacement: fromRoot('./packages/platform/src/index.ts') },
      { find: '@pilot/shared', replacement: fromRoot('./packages/shared/src/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    reporters: ['default'],
  },
});
