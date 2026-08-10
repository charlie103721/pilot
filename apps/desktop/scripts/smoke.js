import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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
 * Usage: `xvfb-run -a node scripts/smoke.js`
 */

const require = createRequire(import.meta.url);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electron = require('electron');

const TIMEOUT_MS = 45_000;

const child = spawn(
  electron,
  [
    appRoot,
    // Chromium sandboxing needs kernel features many containers lack. This
    // affects only this smoke check; the app's own `sandbox: true` renderer
    // setting is untouched.
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
  ],
  {
    env: { ...process.env, PILOT_OPEN_PANEL_ON_START: '1', PILOT_LOG_LEVEL: 'debug' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

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
