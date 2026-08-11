import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlistXml } from './verify-bundle.js';

/**
 * The staged helper's filename.
 *
 * A literal rather than an import of `HELPER_EXECUTABLE_NAME`: this script runs
 * from `pnpm package`, which does not build `packages/*` first, so importing
 * `@pilot/platform-mac` would make packaging depend on a prior `tsc --build`.
 * `test/build/helper-name.test.ts` pins this string to the resolver's constant,
 * which is the same mechanism `build-helper.js` uses for the same reason.
 */
const HELPER_EXECUTABLE_NAME = 'PilotHelper';

/**
 * Reads the macOS packaging *configuration* and reports what it says (PR-042).
 *
 * ## Why this is a separate script from `verify-bundle.js`
 *
 * `verify-bundle.js` opens an artefact and asserts facts about it. Nothing it
 * checks can be a guess. This script checks the opposite kind of thing: the
 * settings that only take effect on a machine this project has never had.
 *
 * **Nothing here is evidence that the packaged macOS app works.** It is
 * evidence that the configuration says what its authors think it says, which is
 * a much weaker claim and the only one available on Linux. Every check is of
 * the form "the file exists, parses, and contains the key that the reasoning in
 * its own header depends on" — so a plist that gets truncated, an entitlement
 * that gets renamed in a merge, or a usage string that gets deleted because
 * "nothing reads it" fails here rather than on the user's Mac three steps into
 * a permission walkthrough.
 *
 * The one genuinely load-bearing cross-check is the last: **the path the
 * packaging config stages the helper into and the path the runtime resolver
 * looks in are computed from two different files, and this asserts they agree.**
 * That pair has been broken before by hardcoding `mac-arm64`.
 *
 * Usage: node scripts/verify-package.js
 * Also: `pnpm verify:package` from the repository root.
 */

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every TCC-gated capability Pilot uses, and how the packaged app has to be
 * configured for it.
 *
 * The `usageString` column is the point: a permission whose usage string is
 * missing does not produce a denial, it produces a *termination*, and one whose
 * string is `null` cannot be prompted for at all — those are the two the panel
 * has to route to System Settings instead.
 */
export const TCC_CAPABILITIES = [
  {
    capability: 'Microphone',
    api: 'AVAudioEngine, in the helper',
    usageString: 'NSMicrophoneUsageDescription',
    entitlement: 'com.apple.security.device.audio-input',
  },
  {
    capability: 'Speech Recognition',
    api: 'SFSpeechRecognizer, in the helper',
    usageString: 'NSSpeechRecognitionUsageDescription',
    entitlement: null,
  },
  {
    capability: 'Screen Recording',
    api: 'ScreenCaptureKit, in the helper',
    // There is no usage string for Screen Recording; macOS shows a fixed
    // sentence and sends the user to System Settings.
    usageString: null,
    entitlement: null,
  },
  {
    capability: 'Accessibility',
    api: 'AXUIElement + CGEventTap, in the helper',
    // Same: no string, no entitlement, System Settings only.
    usageString: null,
    entitlement: null,
  },
];

/** Entitlements the app bundle must carry, and why. */
export const REQUIRED_APP_ENTITLEMENTS = {
  'com.apple.security.cs.allow-jit':
    'V8; Electron does not start under the hardened runtime without it',
  'com.apple.security.cs.allow-unsigned-executable-memory': 'same engine, same requirement',
  'com.apple.security.device.audio-input': 'the microphone, under the hardened runtime',
};

/** Entitlements that must NOT be present, each because it buys nothing here. */
export const FORBIDDEN_APP_ENTITLEMENTS = [
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.app-sandbox',
];

function say(message) {
  process.stdout.write(`[pilot:package] ${message}\n`);
}

function readYamlish(path) {
  // The builder config is small, flat-ish YAML and this only needs to know
  // whether a key is present and what scalar follows it. A YAML parser is not a
  // dependency worth adding to a check that would then have to be trusted.
  return readFileSync(path, 'utf8');
}

/** `key: value` at any indentation, ignoring comment lines. */
export function yamlScalar(text, key) {
  const pattern = new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`, 'm');
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) {
      continue;
    }
    const match = pattern.exec(line);
    if (match !== null) {
      return (match[1] ?? '').trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return null;
}

export function verifyPackaging(root = appRoot) {
  const problems = [];
  const facts = [];

  const builderPath = join(root, 'electron-builder.yml');
  if (!existsSync(builderPath)) {
    return { problems: [`no electron-builder.yml at ${builderPath}`], facts };
  }
  const builder = readYamlish(builderPath);

  const appId = yamlScalar(builder, 'appId');
  const productName = yamlScalar(builder, 'productName');
  facts.push(`appId ${String(appId)} / productName ${String(productName)}`);
  if (appId === null || productName === null) {
    problems.push(
      'electron-builder.yml must set both appId and productName; TCC keys grants on the first',
    );
  }

  // Signing posture, stated rather than assumed.
  const hardened = yamlScalar(builder, 'hardenedRuntime');
  const identity = yamlScalar(builder, 'identity');
  const afterPack = yamlScalar(builder, 'afterPack');
  facts.push(
    `hardenedRuntime ${String(hardened)}, identity ${String(identity)}, afterPack ${String(afterPack)}`,
  );
  if (hardened !== 'true') {
    problems.push(
      'mac.hardenedRuntime is not true; the entitlements file is then accepted and ignored',
    );
  }
  if (afterPack === null) {
    problems.push('no afterPack hook: an unsigned arm64 bundle does not launch at all');
  } else if (!existsSync(join(root, afterPack))) {
    problems.push(`afterPack names ${afterPack}, which does not exist`);
  }

  // The usage strings, read out of the builder config's extendInfo block.
  for (const entry of TCC_CAPABILITIES) {
    if (entry.usageString === null) {
      facts.push(
        `${entry.capability}: no usage string exists; System Settings only (${entry.api})`,
      );
      continue;
    }
    const value = yamlScalar(builder, entry.usageString);
    if (value === null || value === '') {
      problems.push(
        `mac.extendInfo has no ${entry.usageString} — macOS TERMINATES a process that uses ` +
          `${entry.api} without it, which does not look like a permission problem to anyone`,
      );
    } else {
      facts.push(`${entry.capability}: "${value}"`);
    }
  }
  if (yamlScalar(builder, 'LSUIElement') !== 'true') {
    problems.push('mac.extendInfo.LSUIElement is not true; Pilot is a menu bar app');
  }
  if (yamlScalar(builder, 'NSSupportsSuddenTermination') !== 'false') {
    problems.push(
      'mac.extendInfo.NSSupportsSuddenTermination is not false; macOS may SIGKILL the app at ' +
        'logout, stranding the SQLite writer lease and skipping the §13 retention clear',
    );
  }

  // Entitlements.
  const entitlementsPath = yamlScalar(builder, 'entitlements');
  const app = readEntitlements(
    join(root, entitlementsPath ?? 'build/entitlements.mac.plist'),
    problems,
    'app',
  );
  for (const [key, why] of Object.entries(REQUIRED_APP_ENTITLEMENTS)) {
    if (app !== null && app[key] !== 'true') {
      problems.push(`app entitlements do not grant ${key} — ${why}`);
    }
  }
  for (const key of FORBIDDEN_APP_ENTITLEMENTS) {
    if (app !== null && app[key] !== undefined) {
      problems.push(
        `app entitlements grant ${key}, which this app does not need and must not ask for`,
      );
    }
  }
  if (app !== null) {
    facts.push(`app entitlements: ${Object.keys(app).join(', ')}`);
  }

  const helper = readEntitlements(
    join(root, 'build', 'entitlements.helper.plist'),
    problems,
    'helper',
  );
  if (helper !== null) {
    facts.push(`helper entitlements: ${Object.keys(helper).join(', ')}`);
    if (helper['com.apple.security.cs.allow-jit'] !== undefined) {
      problems.push('the helper is compiled Swift and must not be granted V8’s JIT entitlements');
    }
    if (helper['com.apple.security.device.audio-input'] !== 'true') {
      problems.push(
        'the helper opens the microphone itself and needs com.apple.security.device.audio-input',
      );
    }
  }

  // The helper's embedded Info.plist: the hedge for TCC crediting the helper.
  const helperPlist = join(root, 'build', 'PilotHelper-Info.plist');
  if (!existsSync(helperPlist)) {
    problems.push(`no ${helperPlist}: the helper would carry no usage strings of its own`);
  } else {
    const entries = parsePlistXml(readFileSync(helperPlist, 'utf8'));
    for (const key of [
      'CFBundleIdentifier',
      'NSMicrophoneUsageDescription',
      'NSSpeechRecognitionUsageDescription',
    ]) {
      if (entries[key] === undefined) {
        problems.push(`${helperPlist} has no ${key}`);
      }
    }
    const helperId = entries['CFBundleIdentifier'];
    if (appId !== null && helperId !== undefined && !helperId.startsWith(`${appId}.`)) {
      problems.push(
        `the helper's bundle identifier (${helperId}) is not a child of the app's (${appId}); ` +
          'an unrelated identifier guarantees a second TCC subject',
      );
    }
    facts.push(`helper bundle identifier: ${String(helperId)}`);
  }

  // The cross-check that is not a matter of opinion: where the config puts the
  // helper, and where the runtime looks for it, must be the same path.
  const stagedTo = /extraResources:\s*\n\s*-\s*from:\s*(\S+)\s*\n\s*to:\s*(\S+)/.exec(builder);
  if (stagedTo === null) {
    problems.push('electron-builder.yml stages no helper into extraResources');
  } else {
    const runtimeRelative = join(stagedTo[2] ?? '', HELPER_EXECUTABLE_NAME);
    facts.push(
      `helper staged to Contents/Resources/${runtimeRelative}, which is where resolveHelperBinary() looks`,
    );
    if (stagedTo[2] !== 'helper') {
      problems.push(
        `extraResources stages the helper to "${String(stagedTo[2])}", but ` +
          '`helperBinaryCandidates` in @pilot/platform-mac joins resourcesPath with "helper/"',
      );
    }
  }

  return { problems, facts };
}

function readEntitlements(path, problems, label) {
  if (!existsSync(path)) {
    problems.push(`no ${label} entitlements at ${path}`);
    return null;
  }
  const text = readFileSync(path, 'utf8');
  if (!text.includes('<plist')) {
    problems.push(`${path} is not a plist`);
    return null;
  }
  return parsePlistXml(text);
}

function main() {
  const { problems, facts } = verifyPackaging();
  say('CONFIGURED, NOT VERIFIED — none of this has run on macOS:');
  for (const fact of facts) {
    say(`  ${fact}`);
  }
  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`[pilot:package]   - ${problem}\n`);
    }
    process.stderr.write(
      `[pilot:package] FAIL: ${String(problems.length)} problem(s) in the packaging configuration\n`,
    );
    process.exit(1);
  }
  say('OK: the macOS packaging configuration is internally consistent.');
  say('It has still never produced, signed or launched a .app. See docs/handoff.md §1 step 22.');
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
