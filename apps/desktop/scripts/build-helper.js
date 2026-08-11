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

/**
 * The `Info.plist` linked into the helper's `__TEXT,__info_plist` section
 * (PR-042).
 *
 * A bare Mach-O executable has no bundle and so no usage strings, and macOS
 * *terminates* a process that asks for the microphone or for speech recognition
 * without one. Whether that ever applies to `PilotHelper` depends on whether
 * TCC treats the app bundle or the helper as the requesting subject — the
 * oldest open structural risk in this project. Embedding the section is cheap
 * insurance for the case where it is the helper, and inert in the case where it
 * is the app.
 *
 * It is done with linker flags on the `swift build` COMMAND LINE rather than
 * with `linkerSettings` in `native/Package.swift`, on purpose:
 * `Package.swift` has never been compiled, and putting `unsafeFlags` into the
 * one file the user's very first Mac step depends on would risk turning "the
 * helper does not build" into the answer to a question nobody asked. Step 1 of
 * `docs/handoff.md` §1 builds the package plainly; this only affects step 3,
 * and `--no-embed-info-plist` backs it out.
 */
const INFO_PLIST = resolve(appRoot, 'build', 'PilotHelper-Info.plist');

/**
 * `swift build` arguments, including the `-sectcreate` flags when the helper's
 * `Info.plist` is being embedded.
 *
 * Exported and pure so the flags can be read on a machine with no Swift.
 */
export function swiftBuildArgs({ packagePath, infoPlist }) {
  const args = ['build', '-c', 'release', '--package-path', packagePath, '--product', HELPER_NAME];
  if (infoPlist !== null) {
    // Each `-Xlinker` forwards exactly one token to `ld`, hence four of them
    // for `-sectcreate __TEXT __info_plist <file>`.
    for (const token of ['-sectcreate', '__TEXT', '__info_plist', infoPlist]) {
      args.push('-Xlinker', token);
    }
  }
  return args;
}

export function parseArgs(argv) {
  let out = resolve(appRoot, 'resources', 'helper');
  let requireNative = false;
  let embedInfoPlist = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      // `pnpm run build:helper -- --require-native` forwards the separator
      // itself, so the command docs/handoff.md documents arrives here with a
      // bare `--` in front. Skipping it is what every other CLI does.
      continue;
    } else if (arg === '--require-native') {
      requireNative = true;
    } else if (arg === '--no-embed-info-plist') {
      // The escape hatch for the one thing here that can break a `swift build`
      // that already worked: the extra linker flags. See INFO_PLIST below.
      embedInfoPlist = false;
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
  return { out, requireNative, embedInfoPlist };
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

function buildNative(outDir, embedInfoPlist) {
  const infoPlist = embedInfoPlist && existsSync(INFO_PLIST) ? INFO_PLIST : null;
  say(`building the Swift helper from ${nativePackageDir}`);
  if (infoPlist === null) {
    say('NOT embedding an Info.plist section; the helper will carry no usage strings');
  } else {
    say(`embedding ${infoPlist} into __TEXT,__info_plist`);
  }
  const args = swiftBuildArgs({ packagePath: nativePackageDir, infoPlist });
  const build = spawnSync('swift', args, { stdio: 'inherit' });
  if (build.status !== 0) {
    fail(
      `\`swift build\` failed with status ${String(build.status)}. ` +
        'Fix the native package before packaging; the bundle would otherwise ship a helper ' +
        'that cannot start.' +
        (infoPlist === null
          ? ''
          : '\nIf the failure names the linker or `-sectcreate`, re-run with ' +
            '`--no-embed-info-plist`: that backs out the only flags this script adds ' +
            'beyond a plain `swift build`, and tells you the package itself is fine.'),
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
  return {
    kind: 'native',
    reason: null,
    source: built,
    swift: swiftVersion(),
    infoPlist,
  };
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
  return {
    kind: 'placeholder',
    reason: blocker,
    source: null,
    swift: swiftVersion(),
    infoPlist: null,
  };
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

  const result =
    blocker === null
      ? buildNative(args.out, args.embedInfoPlist)
      : stagePlaceholder(args.out, blocker);

  const manifest = {
    name: HELPER_NAME,
    kind: result.kind,
    reason: result.reason === null ? null : result.reason.code,
    detail: result.reason === null ? null : result.reason.detail,
    builtAt: new Date().toISOString(),
    host: `${process.platform}-${process.arch}`,
    swift: result.swift,
    source: result.source,
    // PR-042. Read back by `scripts/verify-bundle.js` and by handoff step 22:
    // whether the helper carries its own usage strings decides what happens if
    // TCC ever attributes the microphone to the helper instead of to the app.
    infoPlist: result.infoPlist,
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

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
