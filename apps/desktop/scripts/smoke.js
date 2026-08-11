import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 *   xvfb-run -a node scripts/smoke.js --packaged --no-inherit-env
 *
 * `--packaged` runs the same check against the app electron-builder produced,
 * which is a strictly stronger claim: it proves the asar contents, the packaged
 * paths and the bundled Electron all agree, not just the files on disk.
 *
 * ## `--no-inherit-env`: the no-terminal launch (PR-042)
 *
 * Everything above runs the app with this shell's environment, and that is not
 * how anybody starts a Mac app. Finder launches through `launchd`: no
 * `~/.zshrc`, no `export`, no `PILOT_*` of any kind. Pilot reads a great deal
 * from `process.env` — `PILOT_MODEL_PROFILE`, `PILOT_LOCAL_BASE_URL`,
 * `PILOT_API_KEY`, `PILOT_HELPER_BINARY`, `PILOT_LOG_LEVEL` — and **all of it
 * is absent** in that launch.
 *
 * So this mode wipes the environment down to what `launchd` really provides
 * (`PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, plus the display, which stands in
 * for the window server) and asserts four things:
 *
 *   1. the app still boots — `shell ready`;
 *   2. the menu bar item exists, because with `LSUIElement` there is no Dock
 *      icon and no window, and a Pilot with no tray item is a process the user
 *      can neither see nor quit;
 *   3. the launch environment file (`main/launch-env.ts`) is read and applied,
 *      which is the ONLY way a double-clicked Pilot can be pointed at a real
 *      model provider;
 *   4. a `PILOT_API_KEY` in that file is refused, **and its value never appears
 *      in the output**. A plaintext credential in a config file would undo
 *      PR-038's sealing, so the refusal is a privacy property, not a
 *      convenience.
 *
 * The renderer round trip is deliberately NOT asserted here: opening the panel
 * needs `PILOT_OPEN_PANEL_ON_START`, which is exactly the kind of variable a
 * Finder launch does not have, and no script can click a menu bar item.
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
const noInheritEnv = process.argv.includes('--no-inherit-env');
const target = packaged ? packagedTarget() : developmentTarget();

/** A value that must be refused by the launch file and must never be printed. */
const REFUSED_SECRET = 'sk-pilot-smoke-must-never-appear';

/**
 * The environment `launchd` gives a double-clicked `.app`, and nothing else.
 *
 * `DISPLAY`/`XAUTHORITY` stand in for the macOS window server: a Mac app always
 * has one, and under Xvfb this is how Chromium finds it. They are not
 * configuration.
 */
function launchdEnvironment() {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env['HOME'] ?? '/root',
    USER: process.env['USER'] ?? 'user',
    LOGNAME: process.env['LOGNAME'] ?? 'user',
    SHELL: '/bin/sh',
    TMPDIR: '/tmp/',
    ...(process.env['DISPLAY'] === undefined ? {} : { DISPLAY: process.env['DISPLAY'] }),
    ...(process.env['XAUTHORITY'] === undefined ? {} : { XAUTHORITY: process.env['XAUTHORITY'] }),
  };
}

/**
 * A throwaway `userData` directory holding a launch file, so the check reads
 * the real code path rather than a fixture. Electron's own `--user-data-dir`
 * switch is what makes `app.getPath('userData')` point at it.
 */
function stageLaunchFile() {
  const directory = mkdtempSync(join(tmpdir(), 'pilot-smoke-'));
  writeFileSync(
    join(directory, 'pilot.env'),
    [
      '# Written by scripts/smoke.js --no-inherit-env.',
      'PILOT_LOG_LEVEL=debug',
      `PILOT_API_KEY=${REFUSED_SECRET}`,
      'PILOT_NOT_A_REAL_SETTING=1',
      '',
    ].join('\n'),
  );
  return directory;
}

const userDataDir = noInheritEnv ? stageLaunchFile() : null;
const extraArgs = userDataDir === null ? [] : [`--user-data-dir=${userDataDir}`];

process.stdout.write(
  `launching ${packaged ? 'packaged' : 'development'} app: ${target.command}` +
    `${noInheritEnv ? ' (with an empty, launchd-like environment)' : ''}\n`,
);

const child = spawn(target.command, [...target.args, ...CHROMIUM_FLAGS, ...extraArgs], {
  env: noInheritEnv
    ? launchdEnvironment()
    : { ...process.env, PILOT_OPEN_PANEL_ON_START: '1', PILOT_LOG_LEVEL: 'debug' },
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
  () =>
    finish(
      1,
      noInheritEnv
        ? 'FAIL: timed out waiting for the shell to come up with no environment'
        : 'FAIL: timed out waiting for the shell and the renderer round trip',
    ),
  TIMEOUT_MS,
);

/** The four claims of `--no-inherit-env`. Each names what its absence means. */
function checkEmptyEnvironmentLaunch() {
  const failures = [];
  if (!output.includes('"trayAvailable":true')) {
    failures.push(
      'the menu bar item was not created. With LSUIElement there is no Dock icon and no ' +
        'window, so a Pilot with no tray item cannot be seen, used or quit.',
    );
  }
  if (!output.includes('"message":"launch environment file"')) {
    failures.push(
      'the launch environment file was not read. It is the only way a double-clicked Pilot ' +
        'can be pointed at a real model provider.',
    );
  }
  if (!output.includes('PILOT_LOG_LEVEL')) {
    failures.push('the launch file set PILOT_LOG_LEVEL and the app did not report applying it');
  }
  if (!output.includes('PILOT_API_KEY: a credential must not sit in a plaintext file')) {
    failures.push('PILOT_API_KEY in the launch file was not refused with its reason');
  }
  if (output.includes(REFUSED_SECRET)) {
    failures.push(
      `the refused credential's VALUE reached the output. That is a leak, not a formatting bug.`,
    );
  }
  return failures;
}

const onData = (chunk) => {
  output += chunk.toString();
  const booted = output.includes('"message":"shell ready"');
  if (noInheritEnv) {
    if (booted) {
      const failures = checkEmptyEnvironmentLaunch();
      finish(
        failures.length === 0 ? 0 : 1,
        failures.length === 0
          ? 'OK: the packaged app starts from an empty, launchd-like environment, keeps its menu ' +
              'bar item, reads its launch file and refuses a credential in it'
          : `FAIL:\n  - ${failures.join('\n  - ')}`,
      );
    }
    return;
  }
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
