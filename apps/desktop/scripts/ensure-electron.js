import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

/**
 * Fetches the Electron runtime binary if it is missing.
 *
 * Electron 43 removed its `postinstall` hook: the download is now an explicit
 * `install-electron` step. Without it `pnpm install` leaves only the JavaScript
 * shim and type definitions, and nothing says so until someone tries to launch
 * the app.
 *
 * This runs from the desktop package's own `postinstall`, and is deliberately
 * non-fatal. `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` all
 * work without the binary — only launching needs it — so a machine with no
 * access to the Electron release host still gets a green workspace and a clear
 * warning rather than a failed install.
 *
 * Set `PILOT_SKIP_ELECTRON_DOWNLOAD=1` to skip entirely.
 */

const require = createRequire(import.meta.url);

function warn(message) {
  process.stderr.write(`[pilot] ${message}\n`);
}

if (process.env.PILOT_SKIP_ELECTRON_DOWNLOAD === '1') {
  warn('skipping the Electron runtime download (PILOT_SKIP_ELECTRON_DOWNLOAD=1).');
  process.exit(0);
}

let packageRoot;
try {
  packageRoot = dirname(require.resolve('electron/package.json'));
} catch {
  warn('the `electron` package is not installed; skipping the runtime download.');
  process.exit(0);
}

if (existsSync(join(packageRoot, 'dist'))) {
  process.exit(0);
}

const result = spawnSync(process.execPath, [resolve(packageRoot, 'install.js')], {
  stdio: 'inherit',
  cwd: packageRoot,
});

if (result.status !== 0) {
  warn(
    'could not download the Electron runtime. Lint, typecheck, test and build still work; ' +
      'run `pnpm --filter @pilot/desktop exec install-electron` before `pnpm dev`.',
  );
}

// Never fail the install: see the note above.
process.exit(0);
