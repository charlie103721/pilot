import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { findBundle } from './verify-bundle.js';

/**
 * Headless launch check.
 *
 * Starts the real Electron binary against the built shell and waits for two
 * things in the main process log:
 *   1. `shell ready`  — main booted, the tray was attempted, the panel exists;
 *   2. a served `pilot:view-state/get` — which only happens if the sandboxed
 *      preload loaded, React mounted, and a validated envelope made the round
 *      trip renderer → main → renderer.
 *
 * That is the whole IPC path under a real Electron. It is not a substitute for
 * the manual demo on a Mac: under Xvfb there is no menu bar to look at and
 * nobody sees the panel.
 *
 * Usage:
 *   xvfb-run -a node scripts/smoke.js              # the built dist/ in place
 *   xvfb-run -a node scripts/smoke.js --packaged   # the electron-builder bundle
 *
 * `--packaged` runs the same check against the app electron-builder produced,
 * which is a strictly stronger claim: it proves the asar contents, the packaged
 * paths and the bundled Electron all agree, not just the files on disk.
 */

const require = createRequire(import.meta.url);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TIMEOUT_MS = 45_000;

/** Chromium sandboxing needs kernel features many containers lack. This affects
 * only the smoke check; the panel's own `sandbox: true` setting is untouched. */
const CHROMIUM_FLAGS = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];

function die(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

/** Locates the executable inside an electron-builder `dir` output. */
function packagedTarget() {
  const bundle = findBundle(resolve(appRoot, 'release'));
  if (bundle === null) {
    die(
      'no packaged bundle found under apps/desktop/release. ' +
        'Run `pnpm --filter @pilot/desktop run package` first.',
    );
  }
  // macOS: Pilot.app/Contents/MacOS/Pilot. Linux: linux-unpacked/pilot.
  for (const candidate of [
    join(bundle.root, 'Contents', 'MacOS', 'Pilot'),
    join(bundle.root, 'pilot'),
  ]) {
    if (existsSync(candidate)) {
      return { command: candidate, args: [] };
    }
  }
  return die(`found ${bundle.root} but no launchable executable inside it`);
}

function developmentTarget() {
  if (!existsSync(join(appRoot, 'dist', 'main', 'index.js'))) {
    die(
      'apps/desktop/dist is missing or incomplete. ' +
        'Run `pnpm --filter @pilot/desktop run build:app` first.',
    );
  }
  let electron;
  try {
    electron = require('electron');
  } catch {
    return die('the `electron` package is not installed');
  }
  if (typeof electron !== 'string' || !existsSync(electron)) {
    return die(
      'the Electron runtime binary is missing. Run ' +
        '`pnpm --filter @pilot/desktop exec install-electron`.',
    );
  }
  return { command: electron, args: [appRoot] };
}

const packaged = process.argv.includes('--packaged');
const target = packaged ? packagedTarget() : developmentTarget();

process.stdout.write(`launching ${packaged ? 'packaged' : 'development'} app: ${target.command}\n`);

const child = spawn(target.command, [...target.args, ...CHROMIUM_FLAGS], {
  env: { ...process.env, PILOT_OPEN_PANEL_ON_START: '1', PILOT_LOG_LEVEL: 'debug' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let settled = false;

const finish = (code, message) => {
  if (settled) {
    return;
  }
  settled = true;
  clearTimeout(timer);
  process.stdout.write(`${output}\n${message}\n`);
  child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 250);
};

const timer = setTimeout(
  () => finish(1, 'FAIL: timed out waiting for the shell and the renderer round trip'),
  TIMEOUT_MS,
);

const onData = (chunk) => {
  output += chunk.toString();
  const booted = output.includes('"message":"shell ready"');
  const rendererTalked =
    output.includes('"message":"served renderer request"') &&
    output.includes('pilot:view-state/get');
  if (booted && rendererTalked) {
    finish(0, 'OK: main started, preload loaded, renderer completed a validated IPC round trip');
  }
};

child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('error', (cause) => finish(1, `FAIL: could not spawn Electron: ${String(cause)}`));
child.on('exit', (code) => finish(1, `FAIL: Electron exited early with code ${String(code)}`));
