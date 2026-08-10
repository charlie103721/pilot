import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * Minimal renderer + preload bundler.
 *
 * PR-007 owns the real development build (electron-vite) and packaging
 * (electron-builder). This script exists only so PR-002 leaves a shell that can
 * actually be launched: it is the smallest thing that produces a loadable panel
 * and a sandbox-compatible preload, and PR-007 is expected to replace it.
 *
 * The main process is *not* bundled here — `tsc --build` emits it through the
 * workspace project references, so `pnpm build` typechecks and builds it for
 * real rather than hiding it inside a bundler.
 *
 * Two deliberate output choices:
 *  - the preload is CommonJS, because `sandbox: true` preloads cannot use ESM;
 *  - the renderer is a single ESM file with React bundled in, because the panel
 *    is loaded over `file:` and cannot resolve bare specifiers.
 */

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (relativePath) => resolve(appRoot, 'src', relativePath);
const out = (relativePath) => resolve(appRoot, 'dist', relativePath);

const production = process.env.NODE_ENV === 'production';

/**
 * Both Chromium-side bundles (renderer, sandboxed preload) pull in
 * `@pilot/shared`, which imports `node:crypto` at module scope. Neither has Node
 * built-ins, so the import is redirected to a browser shim. See `src/shims/`.
 */
const chromiumNodeShims = {
  name: 'chromium-node-shims',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^(node:)?crypto$/ }, () => ({
      path: src('shims/node-crypto.ts'),
    }));
  },
};

const chromiumCommon = {
  bundle: true,
  platform: 'browser',
  plugins: [chromiumNodeShims],
  inject: [src('shims/buffer.ts')],
  sourcemap: true,
  minify: production,
  logLevel: 'warning',
};

await mkdir(out('renderer'), { recursive: true });
await mkdir(out('preload'), { recursive: true });

await build({
  ...chromiumCommon,
  entryPoints: [src('preload/index.ts')],
  outfile: out('preload/index.cjs'),
  format: 'cjs',
  target: ['chrome130'],
  // Provided by the Electron runtime, never bundled.
  external: ['electron'],
});

await build({
  ...chromiumCommon,
  entryPoints: [src('renderer/main.tsx')],
  outfile: out('renderer/renderer.js'),
  format: 'esm',
  target: ['chrome130'],
  jsx: 'automatic',
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
});

await cp(src('renderer/index.html'), out('renderer/index.html'));
