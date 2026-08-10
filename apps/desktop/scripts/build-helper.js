import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Stages the native macOS helper into the app bundle's resources.
 *
 * Pilot's ScreenCaptureKit / Accessibility / Speech work lives in a Swift
 * executable that ships *inside* the app bundle and is spawned by the main
 * process (system-design §"Embedded native helper"). Packaging therefore has to
 * put a real file at a known path, and something has to build it first.
 *
 * Three facts shape this script:
 *
 *  1. `packages/platform-mac/` is PR-003's, and may not exist yet. A missing
 *     native package is a normal state, not a build failure.
 *  2. Development happens on Linux, where there is no Swift toolchain and no
 *     ScreenCaptureKit. A native build is impossible here and pretending
 *     otherwise would ship a lie.
 *  3. The packaging path still has to be exercisable on Linux, or nobody finds
 *     out it is broken until they are on the Mac.
 *
 * So: build natively when that is genuinely possible, and otherwise stage a
 * placeholder that *is* a real file at the real path but fails loudly the
 * moment anything tries to run it. Either way a `helper.json` manifest records
 * which of the two happened and why, so the packaged-resource check and any
 * human reading a bundle can tell them apart without guessing.
 *
 * Usage:
 *   node scripts/build-helper.js [--out <dir>] [--require-native]
 *
 *   --require-native   exit non-zero instead of staging a placeholder. Use this
 *                      on the Mac for a build that must contain real native
 *                      code (PR-042 packaging, release builds).
 */

/**
 * The executable's name, used for three things that must agree: the SwiftPM
 * product to build, the file to look for in the build directory, and the name
 * to stage under `Resources/helper/`.
 *
 * The source of truth is `HELPER_EXECUTABLE_NAME` in
 * `packages/platform-mac/src/helper-binary.ts` — the runtime resolver that has
 * to *find* this file inside the bundle — and `native/Package.swift`, which
 * declares the product. A literal rather than an import because this script
 * runs before `dist/` is guaranteed to exist; `helper-name.test.ts` pins the
 * three together so they cannot drift again.
 */
const HELPER_NAME = 'PilotHelper';
const MANIFEST_NAME = 'helper.json';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const nativePackageDir = resolve(repoRoot, 'packages', 'platform-mac', 'native');

function parseArgs(argv) {
  let out = resolve(appRoot, 'resources', 'helper');
  let requireNative = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      // `pnpm run build:helper -- --require-native` forwards the separator
      // itself, so the command docs/handoff.md documents arrives here with a
      // bare `--` in front. Skipping it is what every other CLI does.
      continue;
    } else if (arg === '--require-native') {
      requireNative = true;
    } else if (arg === '--out') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error('--out needs a directory argument');
      }
      out = resolve(process.cwd(), value);
      index += 1;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return { out, requireNative };
}

function say(message) {
  process.stdout.write(`[pilot:helper] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[pilot:helper] ${message}\n`);
  process.exit(1);
}

/**
 * Why a native build cannot happen here, or `null` when it can. The order is
 * deliberate: report the most fundamental reason first, so a Linux checkout
 * without the native package says "not on macOS" rather than sending someone
 * looking for a package they were never going to build.
 */
function nativeBlocker() {
  if (process.platform !== 'darwin') {
    return {
      code: 'host-is-not-macos',
      detail:
        `this host is ${process.platform}; the helper links ScreenCaptureKit and ` +
        'Accessibility and can only be built on macOS',
    };
  }
  const probe = spawnSync('swift', ['--version'], { encoding: 'utf8' });
  if (probe.error !== undefined || probe.status !== 0) {
    return {
      code: 'swift-toolchain-missing',
      detail: 'no working `swift` on PATH; install Xcode or the Swift toolchain',
    };
  }
  if (!existsSync(join(nativePackageDir, 'Package.swift'))) {
    return {
      code: 'native-package-missing',
      detail: `no SwiftPM package at ${nativePackageDir} (PR-003 adds it)`,
    };
  }
  return null;
}

function swiftVersion() {
  const probe = spawnSync('swift', ['--version'], { encoding: 'utf8' });
  return probe.status === 0 ? `${probe.stdout}${probe.stderr}`.trim().split('\n')[0] : null;
}

function buildNative(outDir) {
  say(`building the Swift helper from ${nativePackageDir}`);
  const build = spawnSync(
    'swift',
    ['build', '-c', 'release', '--package-path', nativePackageDir, '--product', HELPER_NAME],
    { stdio: 'inherit' },
  );
  if (build.status !== 0) {
    fail(
      `\`swift build\` failed with status ${String(build.status)}. ` +
        'Fix the native package before packaging; the bundle would otherwise ship a helper ' +
        'that cannot start.',
    );
  }

  const binPath = spawnSync(
    'swift',
    ['build', '-c', 'release', '--package-path', nativePackageDir, '--show-bin-path'],
    { encoding: 'utf8' },
  );
  if (binPath.status !== 0) {
    fail('could not locate the SwiftPM build directory (`swift build --show-bin-path` failed)');
  }
  const built = join(binPath.stdout.trim(), HELPER_NAME);
  if (!existsSync(built)) {
    fail(
      `\`swift build\` reported success but produced no ${HELPER_NAME} at ${built}. ` +
        `Check that the SwiftPM package declares an executable product named ${HELPER_NAME}.`,
    );
  }

  const staged = join(outDir, HELPER_NAME);
  copyFileSync(built, staged);
  chmodSync(staged, 0o755);
  return { kind: 'native', reason: null, source: built, swift: swiftVersion() };
}

function stagePlaceholder(outDir, blocker) {
  const staged = join(outDir, HELPER_NAME);
  writeFileSync(
    staged,
    [
      '#!/bin/sh',
      '# Staged by apps/desktop/scripts/build-helper.js. Not the real helper.',
      `echo "PilotHelper: this bundle contains a placeholder, not the native macOS helper." >&2`,
      `echo "PilotHelper: reason: ${blocker.code} — ${blocker.detail}" >&2`,
      `echo "PilotHelper: build a real one on macOS with: pnpm --filter @pilot/desktop run build:helper -- --require-native" >&2`,
      '# EX_CONFIG: the bundle is misconfigured for this use, not broken at runtime.',
      'exit 78',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(staged, 0o755);
  return { kind: 'placeholder', reason: blocker, source: null, swift: swiftVersion() };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (cause) {
    fail(
      `${String(cause instanceof Error ? cause.message : cause)}\nUsage: node scripts/build-helper.js [--out <dir>] [--require-native]`,
    );
    return;
  }

  rmSync(args.out, { recursive: true, force: true });
  mkdirSync(args.out, { recursive: true });

  const blocker = nativeBlocker();

  if (blocker !== null && args.requireNative) {
    fail(
      `--require-native was given but the helper cannot be built: ${blocker.code} — ${blocker.detail}.\n` +
        'Refusing to stage a placeholder into a build that asked for real native code.',
    );
    return;
  }

  const result = blocker === null ? buildNative(args.out) : stagePlaceholder(args.out, blocker);

  const manifest = {
    name: HELPER_NAME,
    kind: result.kind,
    reason: result.reason === null ? null : result.reason.code,
    detail: result.reason === null ? null : result.reason.detail,
    builtAt: new Date().toISOString(),
    host: `${process.platform}-${process.arch}`,
    swift: result.swift,
    source: result.source,
  };
  writeFileSync(join(args.out, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);

  if (result.kind === 'native') {
    say(`staged the native helper into ${args.out}`);
  } else {
    say(
      `staged a PLACEHOLDER helper into ${args.out} (${blocker.code}: ${blocker.detail}). ` +
        'Packaging works and the resource check passes, but the packaged app cannot observe ' +
        'the screen until it is rebuilt on macOS.',
    );
  }
}

main();
