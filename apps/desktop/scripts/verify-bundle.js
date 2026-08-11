import { extractFile, listPackage } from '@electron/asar';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
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
 * ## What PR-042 added, and why each check earns its place
 *
 * PR-036 taught this file its one lesson (see `REQUIRED_APP_FILES`): a
 * dependency that reads its own files off disk cannot be bundled, and NOTHING
 * but opening the built artefact finds it. Lint, typecheck, 1 874 tests, every
 * demo and `pnpm build` were all green while the packaged app answered
 * questions and persisted nothing. Every check below is that lesson applied to
 * a different way the same thing can happen:
 *
 *  - **presence** — the file is in the archive (PR-036's check, extended to the
 *    stylesheet, which is the difference between the panel and a heap of
 *    unstyled text);
 *  - **reachability** — `package.json#main` names a file that is actually
 *    there, because an asar whose entry point is missing fails at launch with
 *    Electron's own default window and no Pilot log line at all;
 *  - **self-containment** — nothing in the two Node-side bundles imports a
 *    package the asar does not carry. The asar ships **no `node_modules`** on
 *    purpose, so an externalised dependency resolves perfectly in development
 *    and fails only once packaged, which is the worst possible ordering. This
 *    assertion used to live only in `test/build/development-build.test.ts`,
 *    against `dist/` — it is here now because `dist/` is not what ships;
 *  - **loadability** — the renderer's tags have no `crossorigin` and no
 *    absolute paths, both of which are refused over `file:` and both of which
 *    produce a blank window rather than an error;
 *  - **the security posture survived packaging** — the CSP in the *archived*
 *    `index.html`, byte for byte against the one `electron.vite.config.ts`
 *    records;
 *  - **size** — cross-lane hazard 24: an `await import()` behind a flag is not
 *    lazy under `inlineDynamicImports`, and wiring a provider catalogue took
 *    the main bundle from 1.66 MB to 5.97 MB with every gate green;
 *  - **executability** — a spawned binary cannot be run from inside an asar
 *    (the archive is one file to the kernel), so the helper must be a real file
 *    outside it, and nothing that looks like an executable may be inside it;
 *  - **the macOS bundle**, when there is one: `Info.plist` identifier, the TCC
 *    usage strings, `LSUIElement`, the helper's location, and whether the thing
 *    carries a code signature at all. None of that can be produced on Linux, so
 *    those checks report `not checked here` rather than passing quietly.
 *
 * Run automatically by `pnpm --filter @pilot/desktop run package`; the same
 * assertions are made independently from `test/build/development-build.test.ts`.
 *
 * Usage: node scripts/verify-bundle.js [--release-dir <dir>]
 */

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files that must be inside the asar for the app to start at all. */
export const REQUIRED_APP_FILES = [
  'package.json',
  'dist/main/index.js',
  'dist/preload/index.cjs',
  'dist/renderer/index.html',
  'dist/renderer/renderer.js',
  // PR-042. Not fatal the way the four above are, and included anyway: without
  // it the panel renders as unstyled text, which is a bug report about "the UI
  // is broken" rather than a crash anyone can trace to packaging.
  'dist/renderer/index.css',
  // PR-036. The SQLite backend reads its schema off disk relative to
  // `import.meta.url`, and electron-vite inlines the package into
  // `dist/main/index.js`, so the file has to be staged beside the bundle
  // (`stageSqliteMigrations` in electron.vite.config.ts). Without it the app
  // starts, answers questions, and silently persists nothing — which is why it
  // is checked here rather than left to whoever notices.
  'dist/main/migrations/001_initial.sql',
];

/** Files that must be beside the asar, as real files on disk. */
export const REQUIRED_RESOURCE_FILES = ['helper/PilotHelper', 'helper/helper.json'];

/**
 * Ceiling for the main bundle, in bytes.
 *
 * Cross-lane hazard 24. PR-038 wired a provider catalogue behind an
 * `await import()` guarded by a flag, and `inlineDynamicImports` — which the
 * main bundle needs, because a single-file ESM output has nowhere to put a
 * chunk — turned the lazy import into an eager one: 1.66 MB → 5.97 MB, with
 * lint, typecheck, the full suite and `pnpm build` all green. Nothing else in
 * this repository would have noticed.
 *
 * The number is a budget, not a measurement: it sits roughly 50 % above the
 * current bundle so ordinary growth does not trip it, and far below the
 * regression it exists to catch. **Do not raise it to make a build pass** — a
 * jump of megabytes is a dependency that got inlined, and the fix is at the
 * import, not here.
 */
export const MAIN_BUNDLE_MAX_BYTES = 3_500_000;

/**
 * The Content-Security-Policy the archived panel must carry.
 *
 * Duplicated from `electron.vite.config.ts` on purpose: that file asserts the
 * policy at *build* time against `src/renderer/index.html`, and this asserts it
 * at *package* time against the bytes in the archive. Two independent readings
 * of the same fact, which is the only way a transform between them can be
 * caught.
 */
export const PRODUCTION_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** Info.plist keys the packaged macOS app must carry, with why. */
export const REQUIRED_INFO_PLIST_KEYS = {
  CFBundleIdentifier: 'TCC keys its grants on this; a change re-prompts for everything',
  NSMicrophoneUsageDescription: 'macOS terminates a process that opens the mic without it',
  NSSpeechRecognitionUsageDescription: 'same, for SFSpeechRecognizer',
  LSUIElement: 'menu bar app: no Dock icon, no window on launch',
  LSMinimumSystemVersion: 'the helper needs macOS 13; without this it starts and then fails',
};

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
    candidates.push({ root: base, resources: join(base, 'resources'), macApp: null });
    for (const nested of readdirSync(base, { withFileTypes: true })) {
      if (nested.isDirectory() && nested.name.endsWith('.app')) {
        candidates.push({
          root: join(base, nested.name),
          resources: join(base, nested.name, 'Contents', 'Resources'),
          macApp: join(base, nested.name),
        });
      }
    }
  }
  return candidates.find((candidate) => existsSync(join(candidate.resources, 'app.asar'))) ?? null;
}

/** Collapses the CSP's source formatting so only the directives are compared. */
function contentSecurityPolicy(html) {
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html);
  return match?.[1] === undefined ? null : match[1].replace(/\s+/g, ' ').trim();
}

/**
 * Every module specifier an ESM or CJS bundle still asks the runtime for.
 *
 * Deliberately textual. Parsing the bundle would be more precise and would also
 * mean shipping a parser to a check that has to keep working when the bundle is
 * 2 MB of someone else's minified output; the two patterns below are what
 * Rollup emits for an unresolved external, in both formats.
 */
export function externalSpecifiers(source) {
  const specifiers = new Set();
  for (const match of source.matchAll(/^import\s[^'"]*from\s*["'](.*?)["']/gm)) {
    specifiers.add(match[1] ?? '');
  }
  for (const match of source.matchAll(/^import\s*["'](.*?)["'];?\s*$/gm)) {
    specifiers.add(match[1] ?? '');
  }
  for (const match of source.matchAll(/require\((["'])(.*?)\1\)/g)) {
    specifiers.add(match[2] ?? '');
  }
  return [...specifiers];
}

/**
 * `true` when the runtime really does provide this specifier.
 *
 * Unprefixed built-ins count: PR-029 pulled Pi into the main bundle and its
 * dependencies import `process` and `buffer` without the `node:` prefix, which
 * resolve to the same built-ins. The invariant being protected is narrower than
 * "no imports" — it is that **no npm package** is left external, because the
 * asar ships no `node_modules`.
 */
export function isRuntimeProvided(specifier) {
  return (
    specifier === 'electron' ||
    specifier.startsWith('node:') ||
    builtinModules.includes(specifier) ||
    // Relative imports resolve inside the archive.
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

/** First bytes of a Mach-O (either endianness, thin or fat) or an ELF. */
export function looksExecutable(buffer) {
  if (buffer.length < 4) {
    return false;
  }
  const magic = buffer.readUInt32BE(0);
  return (
    magic === 0x7f454c46 || // ELF
    magic === 0xfeedface ||
    magic === 0xfeedfacf ||
    magic === 0xcefaedfe ||
    magic === 0xcffaedfe ||
    magic === 0xcafebabe || // Mach-O universal
    magic === 0xbebafeca
  );
}

/**
 * Reads a `.plist` as `{ key: string }`, whatever encoding it is in.
 *
 * electron-builder writes `Info.plist` as a **binary** plist, which cannot be
 * read with a regex. On macOS `plutil` converts it; anywhere else this returns
 * `null` and the caller reports the checks as *not run* rather than passing
 * them. A check that silently stops checking is the failure mode PR-041's
 * `auditSelfCheck` exists for, and the same rule applies here.
 */
export function readPlist(path) {
  if (!existsSync(path)) {
    return { entries: null, reason: `no plist at ${path}` };
  }
  let text = readFileSync(path, 'utf8');
  if (text.startsWith('bplist00')) {
    const converted = spawnSync('plutil', ['-convert', 'xml1', '-o', '-', path], {
      encoding: 'utf8',
    });
    if (converted.status !== 0) {
      return {
        entries: null,
        reason: `${path} is a binary plist and \`plutil\` is unavailable (host is ${process.platform})`,
      };
    }
    text = converted.stdout;
  }
  return { entries: parsePlistXml(text), reason: null };
}

/**
 * Minimal XML plist reader: top-level `<key>` to a scalar value.
 *
 * Enough for the flat dictionaries this checks and nothing more — arrays and
 * nested dictionaries are reported as their tag name, which is all any caller
 * here needs to know.
 */
export function parsePlistXml(text) {
  const entries = {};
  const pattern =
    /<key>([^<]*)<\/key>\s*(?:<(true|false)\s*\/>|<(string|integer|real)>([\s\S]*?)<\/\3>|<(dict|array)>)/g;
  for (const match of text.matchAll(pattern)) {
    const key = match[1] ?? '';
    if (match[2] !== undefined) {
      entries[key] = match[2];
    } else if (match[3] !== undefined) {
      entries[key] = (match[4] ?? '').trim();
    } else {
      entries[key] = `<${match[5] ?? ''}>`;
    }
  }
  return entries;
}

function readAsarText(asarPath, entry) {
  try {
    return extractFile(asarPath, entry).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * The macOS half. Runs only when a `.app` was actually produced, which on this
 * project's development machine is never — hence `checked: false` rather than a
 * pass.
 */
export function verifyMacApp(macApp, problems, notes) {
  if (macApp === null) {
    notes.push(
      'no .app in this bundle: the macOS Info.plist, entitlements and signature are NOT CHECKED',
    );
    return { checked: false, identifier: null, signed: null };
  }

  const executable = join(macApp, 'Contents', 'MacOS', 'Pilot');
  if (!existsSync(executable)) {
    problems.push(`the .app has no Contents/MacOS/Pilot to launch (looked in ${macApp})`);
  }

  const helper = join(macApp, 'Contents', 'Resources', 'helper', 'PilotHelper');
  if (!existsSync(helper)) {
    problems.push(
      `the .app has no Contents/Resources/helper/PilotHelper — this is the path resolveHelperBinary() looks in`,
    );
  }

  const { entries, reason } = readPlist(join(macApp, 'Contents', 'Info.plist'));
  if (entries === null) {
    notes.push(`Info.plist NOT CHECKED: ${String(reason)}`);
    return { checked: false, identifier: null, signed: null };
  }
  for (const [key, why] of Object.entries(REQUIRED_INFO_PLIST_KEYS)) {
    if (entries[key] === undefined) {
      problems.push(`Info.plist has no ${key} — ${why}`);
    }
  }
  if (
    entries['LSUIElement'] !== undefined &&
    entries['LSUIElement'] !== 'true' &&
    entries['LSUIElement'] !== '1'
  ) {
    problems.push(
      `Info.plist LSUIElement is ${String(entries['LSUIElement'])}; Pilot is a menu bar app and must not take a Dock icon`,
    );
  }

  // The signature. Reported rather than required: an unsigned bundle is a
  // legitimate intermediate state on an Intel Mac, and a fatal one on Apple
  // silicon, and this check cannot tell which machine will run it.
  let signed = null;
  if (process.platform === 'darwin') {
    const probe = spawnSync('codesign', ['--display', '--verbose=2', macApp], { encoding: 'utf8' });
    signed =
      probe.status === 0
        ? `${probe.stderr}`.trim().split('\n').slice(0, 3).join(' | ')
        : 'NOT SIGNED';
    if (probe.status !== 0) {
      problems.push('the .app carries no code signature; it will not launch on Apple silicon');
    }
  } else {
    notes.push(
      `code signature NOT CHECKED: \`codesign\` needs macOS (host is ${process.platform})`,
    );
  }

  return { checked: true, identifier: entries['CFBundleIdentifier'] ?? null, signed };
}

export function verifyBundle(bundle) {
  const problems = [];
  /** Things this run could NOT check. Printed, never silently skipped. */
  const notes = [];
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

  // The asar must carry no dependency tree. A `node_modules` in here is pnpm's
  // symlink farm flattened wrong, and it is megabytes of the wrong versions.
  const bundledModules = [...entries].filter((entry) => entry.startsWith('node_modules'));
  if (bundledModules.length > 0) {
    problems.push(
      `app.asar contains ${String(bundledModules.length)} node_modules entries; ` +
        'electron-vite inlines every dependency and the archive must carry none',
    );
  }

  // A spawned binary cannot be executed from inside an asar: to the kernel the
  // archive is a single file. Anything executable in here is a packaging bug
  // that shows up as ENOEXEC at the worst moment.
  for (const entry of entries) {
    if (entry.endsWith('/') || entry.split('/').pop()?.includes('.') === true) {
      continue;
    }
    try {
      const head = extractFile(asarPath, entry).subarray(0, 8);
      if (looksExecutable(head)) {
        problems.push(
          `app.asar contains what looks like an executable (${entry}); ` +
            'a binary must be an extraResource, because nothing can be spawned from inside an archive',
        );
      }
    } catch {
      // A directory entry. `listPackage` returns those too.
    }
  }

  // `package.json#main` has to name a file that is really in the archive.
  const manifestText = readAsarText(asarPath, 'package.json');
  if (manifestText === null) {
    problems.push('app.asar has no readable package.json');
  } else {
    try {
      const parsed = JSON.parse(manifestText);
      const mainEntry = typeof parsed.main === 'string' ? parsed.main.replace(/^\.\//, '') : null;
      if (mainEntry === null) {
        problems.push(
          'app.asar package.json declares no "main"; Electron would load its default app',
        );
      } else if (!entries.has(mainEntry)) {
        problems.push(`app.asar package.json main is "${mainEntry}", which is not in the archive`);
      }
      if (parsed.type !== 'module') {
        problems.push(
          'app.asar package.json is not "type": "module"; the main bundle is emitted as ESM',
        );
      }
    } catch (cause) {
      problems.push(`app.asar package.json is not readable JSON: ${String(cause)}`);
    }
  }

  // Self-containment, read out of the archive rather than out of `dist/`.
  for (const [entry, label] of [
    ['dist/main/index.js', 'main'],
    ['dist/preload/index.cjs', 'preload'],
  ]) {
    const source = readAsarText(asarPath, entry);
    if (source === null) {
      continue; // already reported as missing above
    }
    for (const specifier of externalSpecifiers(source)) {
      if (specifier !== '' && !isRuntimeProvided(specifier)) {
        problems.push(
          `${label} bundle imports "${specifier}", which the asar does not contain ` +
            '(it ships no node_modules, so this resolves in development and fails only once packaged)',
        );
      }
    }
    if (label === 'preload') {
      // A sandboxed preload has no module loader at all.
      if (/^\s*(import|export)\s/m.test(source)) {
        problems.push(
          'the preload is an ES module; a sandboxed preload cannot be one and the bridge would be dead',
        );
      }
    }
  }

  // Size. See MAIN_BUNDLE_MAX_BYTES.
  let mainBytes = 0;
  try {
    mainBytes = extractFile(asarPath, 'dist/main/index.js').length;
    if (mainBytes > MAIN_BUNDLE_MAX_BYTES) {
      problems.push(
        `dist/main/index.js is ${String(mainBytes)} bytes, over the ${String(MAIN_BUNDLE_MAX_BYTES)} budget. ` +
          'Something that was meant to be lazy was inlined (cross-lane hazard 24). ' +
          'Do not raise the budget to make this pass.',
      );
    }
  } catch {
    // Missing, already reported.
  }

  // The panel, as it will actually be loaded: from a file: URL, out of the archive.
  const html = readAsarText(asarPath, 'dist/renderer/index.html');
  if (html !== null) {
    const csp = contentSecurityPolicy(html);
    if (csp === null) {
      problems.push('the packaged index.html has no Content-Security-Policy meta tag');
    } else if (csp !== PRODUCTION_CSP) {
      problems.push(
        `the packaged Content-Security-Policy is not the one electron.vite.config.ts records.\n` +
          `      archive: ${csp}\n      expected: ${PRODUCTION_CSP}`,
      );
    }
    if (html.includes('crossorigin')) {
      problems.push(
        'the packaged index.html has a crossorigin attribute; a CORS-mode fetch is refused over file: and the panel comes up blank',
      );
    }
    if (/(src|href)="\//.test(html)) {
      problems.push(
        'the packaged index.html has an absolute asset path, which resolves against the filesystem root under file:',
      );
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
    const stats = lstatSync(helperPath);
    if (stats.isSymbolicLink()) {
      problems.push(
        'helper/PilotHelper is a symlink; the app bundle must contain the binary itself, ' +
          'and a signature does not follow a link',
      );
    }
    const mode = statSync(helperPath).mode;
    if ((mode & 0o111) === 0) {
      problems.push('helper/PilotHelper is not executable');
    }
    if (statSync(helperPath).size === 0) {
      problems.push('helper/PilotHelper is empty');
    }
    const head = readFileSync(helperPath).subarray(0, 8);
    if (manifest?.kind === 'native' && !looksExecutable(head)) {
      problems.push(
        'helper.json says the helper is native, but helper/PilotHelper is not a Mach-O binary. ' +
          'A placeholder has been staged over a real build, or the copy was truncated.',
      );
    }
    if (manifest?.kind === 'placeholder' && looksExecutable(head)) {
      problems.push(
        'helper.json says the helper is a placeholder, but helper/PilotHelper is a real binary. ' +
          'The manifest and the file disagree; do not trust either.',
      );
    }
  }

  if (manifest !== null && manifest.kind !== 'native' && manifest.kind !== 'placeholder') {
    problems.push(`helper/helper.json has an unrecognised kind: ${String(manifest.kind)}`);
  }
  if (manifest?.kind === 'native' && manifest.infoPlist == null) {
    // Not fatal — `--no-embed-info-plist` is a supported choice — but it is the
    // difference between a survivable TCC misattribution and a crash.
    notes.push(
      'the native helper carries NO embedded Info.plist: if macOS attributes the microphone ' +
        'to the helper rather than to the app, it will be terminated rather than denied',
    );
  }

  const mac = verifyMacApp(bundle.macApp ?? null, problems, notes);

  return { problems, notes, manifest, asarEntryCount: entries.size, mainBytes, mac };
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

  const { problems, notes, manifest, asarEntryCount, mainBytes, mac } = verifyBundle(bundle);
  say(`bundle: ${bundle.root}`);
  say(`app.asar: ${String(asarEntryCount)} entries`);
  say(
    `main bundle: ${String(mainBytes)} bytes ` +
      `(budget ${String(MAIN_BUNDLE_MAX_BYTES)}; ${String(Math.round((mainBytes / MAIN_BUNDLE_MAX_BYTES) * 100))}% used)`,
  );
  if (manifest !== null) {
    say(
      manifest.kind === 'native'
        ? `helper: native, built ${String(manifest.builtAt)} on ${String(manifest.host)}, ` +
            `Info.plist ${manifest.infoPlist == null ? 'NOT embedded' : 'embedded'}`
        : `helper: PLACEHOLDER (${String(manifest.reason)}) — this bundle cannot observe the screen`,
    );
  }
  if (mac.checked) {
    say(`macOS bundle: ${String(mac.identifier)}, signature: ${String(mac.signed)}`);
  }
  for (const note of notes) {
    say(`  note: ${note}`);
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
