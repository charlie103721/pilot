import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * Development build for the Pilot desktop app.
 *
 * Three independent bundles, one per Electron process, all emitted under
 * `dist/` so `package.json#main` and `electron-builder.yml` can name stable
 * paths:
 *
 *   dist/main/index.js       ESM, Node/Electron privileges
 *   dist/preload/index.cjs   CommonJS — see PRELOAD below
 *   dist/renderer/*          Chromium, loaded over `file:` when packaged
 *
 * PRELOAD: the panel runs with `sandbox: true` (system-design §14), and a
 * sandboxed preload cannot be an ES module. The format and the `.cjs`
 * extension below are therefore load-bearing, not style — `dist/preload/
 * index.cjs` is what `main/index.ts` hands to `webPreferences.preload`.
 *
 * RENDERER CSP: `src/renderer/index.html` carries the panel's Content Security
 * Policy. The production build must ship it byte for byte; the plugins below
 * assert that and relax it *only* while the Vite dev server is running, where
 * HMR needs a websocket and Vite injects styles as inline <style> elements.
 *
 * WORKSPACE SOURCES: `@pilot/shared` and `@pilot/platform` are aliased to their
 * TypeScript sources rather than their published `dist/`, matching
 * `vitest.config.ts`. One consequence worth knowing: this build does not depend
 * on `tsc --build` having run first, so a clean checkout can produce a runnable
 * app in one step. Types are still checked — by `pnpm typecheck`, not here;
 * Vite only transpiles.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const fromApp = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

/** Ordered longest-prefix-first, exactly as in `vitest.config.ts`. */
const workspaceAliases = [
  {
    find: '@pilot/platform/fakes',
    replacement: fromApp('../../packages/platform/src/fakes/index.ts'),
  },
  { find: '@pilot/platform', replacement: fromApp('../../packages/platform/src/index.ts') },
  {
    // PR-010: the renderer asks the transition table whether a command is
    // accepted, rather than deciding for itself. Pure TypeScript with no Node
    // built-ins, so it bundles into a Chromium renderer unchanged.
    find: '@pilot/interaction',
    replacement: fromApp('../../packages/interaction/src/index.ts'),
  },
  {
    // PR-028: the main process owns a real `ObservationCore` ring behind
    // PR-019's `PilotScreenContextService`. Main-process only — no frame, no
    // decoded pixel and no image codec reaches Chromium.
    find: '@pilot/observation',
    replacement: fromApp('../../packages/observation/src/index.ts'),
  },
  {
    // PR-028: the macOS adapters and the framed stdio transport. Main-process
    // only, and it spawns a child process, so it must never be renderer-side.
    find: '@pilot/platform-mac',
    replacement: fromApp('../../packages/platform-mac/src/index.ts'),
  },
  {
    // PR-029: the main process builds a real `PiAgentSession`. This pulls
    // `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` into the main
    // bundle, which is what `ssr.noExternal` below is for — the packaged asar
    // ships no `node_modules`. It is **main-process only**: nothing in the
    // renderer imports it, and nothing should, so a Pi type never reaches
    // Chromium.
    find: '@pilot/agent',
    replacement: fromApp('../../packages/agent/src/index.ts'),
  },
  { find: '@pilot/shared', replacement: fromApp('../../packages/shared/src/index.ts') },
];

/** Never bundled: provided by the Electron runtime or by Node itself. */
const runtimeExternals = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
];

/**
 * The exact CSP directives the panel ships with. Kept here as data so a change
 * to `index.html` that this file does not know about fails the build instead of
 * silently producing a dev server that cannot load, or a packaged app whose
 * security posture drifted.
 */
const PRODUCTION_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * Dev-server-only relaxation:
 *  - `style-src 'unsafe-inline'` because Vite injects CSS as <style> elements
 *    created at runtime; the production build emits a real stylesheet file.
 *  - `connect-src 'self' ws:` for the HMR websocket and module graph fetches.
 * Everything else, including `script-src 'self'`, is unchanged — there is no
 * inline script in dev either.
 */
const DEVELOPMENT_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self' ws:; form-action 'none'; " +
  "base-uri 'none'";

const CSP_PATTERN = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/;

function readCsp(html: string, context: string): string {
  const match = CSP_PATTERN.exec(html);
  if (match?.[2] === undefined) {
    throw new Error(
      `${context}: src/renderer/index.html has no Content-Security-Policy meta tag. ` +
        'The panel must ship one (system-design §14); restore it before building.',
    );
  }
  // The tag is written across several lines in the source file.
  return match[2].replace(/\s+/g, ' ').trim();
}

/**
 * Fails the build if the shipped CSP is not the one this config knows about,
 * and strips the `crossorigin` attributes Vite adds to its emitted tags: the
 * packaged panel is loaded from `file:`, where a CORS-mode module script or
 * stylesheet is refused outright and the window comes up blank.
 */
function rendererCspGuard(): Plugin {
  return {
    name: 'pilot:renderer-csp-guard',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html: string): string {
        const csp = readCsp(html, 'renderer build');
        if (csp !== PRODUCTION_CSP) {
          throw new Error(
            'renderer build: the Content-Security-Policy in src/renderer/index.html no longer ' +
              'matches the policy recorded in electron.vite.config.ts.\n' +
              `  index.html: ${csp}\n  config:     ${PRODUCTION_CSP}\n` +
              'Update both together, and update the dev-server policy as well.',
          );
        }
        return html.replace(/\s+crossorigin(?==|\s|>)/g, '');
      },
    },
  };
}

/** Swaps in {@link DEVELOPMENT_CSP} while `electron-vite dev` is serving. */
function rendererDevCsp(): Plugin {
  return {
    name: 'pilot:renderer-dev-csp',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler(html: string): string {
        const csp = readCsp(html, 'renderer dev server');
        if (csp !== PRODUCTION_CSP) {
          throw new Error(
            'renderer dev server: unexpected Content-Security-Policy in index.html; ' +
              'see electron.vite.config.ts.',
          );
        }
        return html.replace(CSP_PATTERN, `$1${DEVELOPMENT_CSP}$3`);
      },
    },
  };
}

/**
 * INLINING. The main and preload bundles must contain their dependencies:
 *
 *  - the sandboxed preload has no module loader and no Node resolution, so a
 *    surviving `require('@pilot/shared')` is an immediate crash and a dead
 *    bridge — the panel comes up in its "bridge unavailable" state;
 *  - the packaged asar deliberately contains no `node_modules` (see
 *    `electron-builder.yml`), so an externalized `zod` would resolve fine in
 *    development and fail only once packaged, which is the worst ordering.
 *
 * Three separate mechanisms would otherwise leave dependencies external, and
 * each has to be turned off explicitly:
 *
 *  1. `build.externalizeDeps` — electron-vite externalizes every `dependencies`
 *     entry of the nearest package.json by default. Correct for an app that
 *     ships `node_modules`; wrong for this one.
 *  2. Vite's SSR externalization for `main`/`preload`, hence `ssr.noExternal`.
 *  3. Vite's library mode, which adds the same dependency list again — which is
 *     why both processes are built through `rollupOptions.input` rather than
 *     `build.lib`. Same single-entry build, without that rule.
 *
 * After all three, only `electron` and the Node built-ins stay external.
 */
export default defineConfig({
  main: {
    resolve: { alias: workspaceAliases },
    ssr: { noExternal: true },
    build: {
      outDir: fromApp('dist/main'),
      emptyOutDir: true,
      externalizeDeps: false,
      sourcemap: true,
      minify: false,
      rollupOptions: {
        input: fromApp('src/main/index.ts'),
        external: runtimeExternals,
        output: {
          format: 'es',
          entryFileNames: 'index.js',
          chunkFileNames: '[name].js',
          inlineDynamicImports: true,
        },
      },
    },
  },

  preload: {
    resolve: { alias: workspaceAliases },
    ssr: { noExternal: true },
    build: {
      outDir: fromApp('dist/preload'),
      emptyOutDir: true,
      externalizeDeps: false,
      sourcemap: true,
      minify: false,
      rollupOptions: {
        input: fromApp('src/preload/index.ts'),
        // A sandboxed preload has no module loader and no Node resolution, so
        // nothing may survive as an external import except `electron`, which
        // the sandbox injects.
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
          chunkFileNames: '[name].cjs',
          inlineDynamicImports: true,
        },
      },
    },
  },

  renderer: {
    root: fromApp('src/renderer'),
    // Relative asset URLs: the packaged panel is loaded with `loadFile`, so
    // absolute `/assets/...` paths would resolve to the filesystem root.
    base: './',
    // electron-vite defaults `publicDir` to `resources/`, which is where the
    // native helper is staged for electron-builder. Nothing in the panel is
    // served statically, so turn the whole mechanism off rather than leave a
    // rule that would copy the helper into the renderer output.
    publicDir: false,
    resolve: { alias: workspaceAliases },
    plugins: [rendererCspGuard(), rendererDevCsp()],
    esbuild: { jsx: 'automatic' },
    server: {
      // The renderer imports workspace sources from outside its own root.
      fs: { allow: [repoRoot] },
    },
    build: {
      outDir: fromApp('dist/renderer'),
      emptyOutDir: true,
      sourcemap: true,
      // `<link rel="modulepreload">` buys nothing over `file:` and adds another
      // CORS-mode fetch.
      modulePreload: false,
      rollupOptions: {
        input: fromApp('src/renderer/index.html'),
        output: {
          // Stable, unhashed names: the app is loaded from disk, never cached
          // by a CDN, and stable names make the packaged-bundle check readable.
          entryFileNames: 'renderer.js',
          chunkFileNames: '[name].js',
          assetFileNames: '[name].[ext]',
        },
      },
    },
  },
});
