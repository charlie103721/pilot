import { listPackage } from '@electron/asar';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Proves that a bundle electron-builder just produced actually contains what
 * the app needs, by opening it — not by trusting that the build configuration
 * said so.
 *
 * A packaging config can be wrong in ways every build step still reports as
 * success: an `extraResources` glob that matches nothing, an asar `files`
 * pattern that quietly drops `dist/preload`, a helper staged after the copy
 * happened. Each of those produces a bundle that launches to a blank panel or
 * dies the first time it tries to observe the screen. So this reads the real
 * `app.asar` and the real resources directory and reports what is in them.
 *
 * Run automatically by `pnpm --filter @pilot/desktop run package`; the same
 * assertions are made independently from `test/build/development-build.test.ts`.
 *
 * Usage: node scripts/verify-bundle.js [--release-dir <dir>]
 */

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files that must be inside the asar for the app to start at all. */
const REQUIRED_APP_FILES = [
  'package.json',
  'dist/main/index.js',
  'dist/preload/index.cjs',
  'dist/renderer/index.html',
  'dist/renderer/renderer.js',
  // PR-036. The SQLite backend reads its schema off disk relative to
  // `import.meta.url`, and electron-vite inlines the package into
  // `dist/main/index.js`, so the file has to be staged beside the bundle
  // (`stageSqliteMigrations` in electron.vite.config.ts). Without it the app
  // starts, answers questions, and silently persists nothing — which is why it
  // is checked here rather than left to whoever notices.
  'dist/main/migrations/001_initial.sql',
];

/** Files that must be beside the asar, as real files on disk. */
const REQUIRED_RESOURCE_FILES = ['helper/PilotHelper', 'helper/helper.json'];

function fail(message) {
  process.stderr.write(`[pilot:verify] FAIL: ${message}\n`);
  process.exit(1);
}

function say(message) {
  process.stdout.write(`[pilot:verify] ${message}\n`);
}

/**
 * Locates the produced bundle. electron-builder names its `dir` output after
 * the platform and architecture (`linux-unpacked`, `mac-arm64`, …), so rather
 * than hard-coding a matrix this looks for the one thing every layout has: a
 * `resources/app.asar`.
 */
export function findBundle(releaseDir) {
  if (!existsSync(releaseDir)) {
    return null;
  }
  const candidates = [];
  for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const base = join(releaseDir, entry.name);
    // Linux/Windows: <name>-unpacked/resources. macOS: <name>/Pilot.app/Contents/Resources.
    candidates.push({ root: base, resources: join(base, 'resources') });
    for (const nested of readdirSync(base, { withFileTypes: true })) {
      if (nested.isDirectory() && nested.name.endsWith('.app')) {
        candidates.push({
          root: join(base, nested.name),
          resources: join(base, nested.name, 'Contents', 'Resources'),
        });
      }
    }
  }
  return candidates.find((candidate) => existsSync(join(candidate.resources, 'app.asar'))) ?? null;
}

export function verifyBundle(bundle) {
  const problems = [];
  const asarPath = join(bundle.resources, 'app.asar');

  // `@electron/asar` is what electron-builder itself uses to write the archive.
  const entries = new Set(
    listPackage(asarPath, { isPack: false }).map((name) => name.replace(/^[/\\]/, '')),
  );
  for (const file of REQUIRED_APP_FILES) {
    if (!entries.has(file)) {
      problems.push(`app.asar does not contain ${file}`);
    }
  }

  for (const file of REQUIRED_RESOURCE_FILES) {
    const full = join(bundle.resources, file);
    if (!existsSync(full)) {
      problems.push(`missing bundled resource ${file} (looked in ${bundle.resources})`);
    }
  }

  let manifest = null;
  const manifestPath = join(bundle.resources, 'helper', 'helper.json');
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (cause) {
      problems.push(`helper/helper.json is not readable JSON: ${String(cause)}`);
    }
  }

  const helperPath = join(bundle.resources, 'helper', 'PilotHelper');
  if (existsSync(helperPath)) {
    const mode = statSync(helperPath).mode;
    if ((mode & 0o111) === 0) {
      problems.push('helper/PilotHelper is not executable');
    }
    if (statSync(helperPath).size === 0) {
      problems.push('helper/PilotHelper is empty');
    }
  }

  if (manifest !== null && manifest.kind !== 'native' && manifest.kind !== 'placeholder') {
    problems.push(`helper/helper.json has an unrecognised kind: ${String(manifest.kind)}`);
  }

  return { problems, manifest, asarEntryCount: entries.size };
}

function main() {
  const argv = process.argv.slice(2);
  let releaseDir = resolve(appRoot, 'release');
  const flagIndex = argv.indexOf('--release-dir');
  if (flagIndex !== -1) {
    const value = argv[flagIndex + 1];
    if (value === undefined) {
      fail('--release-dir needs a directory argument');
    }
    releaseDir = resolve(process.cwd(), value);
  }

  const bundle = findBundle(releaseDir);
  if (bundle === null) {
    fail(
      `no packaged bundle with a resources/app.asar under ${releaseDir}. ` +
        'Run `pnpm --filter @pilot/desktop run package` first.',
    );
    return;
  }

  const { problems, manifest, asarEntryCount } = verifyBundle(bundle);
  say(`bundle: ${bundle.root}`);
  say(`app.asar: ${String(asarEntryCount)} entries`);
  if (manifest !== null) {
    say(
      manifest.kind === 'native'
        ? `helper: native, built ${String(manifest.builtAt)} on ${String(manifest.host)}`
        : `helper: PLACEHOLDER (${String(manifest.reason)}) — this bundle cannot observe the screen`,
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`[pilot:verify]   - ${problem}\n`);
    }
    fail(`${String(problems.length)} problem(s) in the produced bundle`);
  }

  say('OK: every required file is present in the produced bundle');
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
