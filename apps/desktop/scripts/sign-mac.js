import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * electron-builder `afterPack` hook: the ad-hoc code signature (PR-042).
 *
 * ## Why this exists at all
 *
 * `mac.identity: null` tells electron-builder not to search the keychain for a
 * Developer ID, which is correct — there is none (runbook §7, user decision).
 * But "not signed at all" is not a shipping state on Apple silicon: the loader
 * refuses an unsigned arm64 Mach-O outright, so a bundle with no signature does
 * not merely warn, it fails to launch. An **ad-hoc** signature (`codesign
 * --sign -`) is what a machine with no certificate can produce, and it is
 * enough for a local install.
 *
 * ## Order, and why it is not `--deep`
 *
 * `codesign --deep` is deprecated and signs nested code with the *outer*
 * entitlements, which would hand the helper V8's JIT entitlements. So this
 * signs inside out, each with its own entitlements file:
 *
 *   1. `Contents/Resources/helper/PilotHelper` — the Swift helper, with
 *      `build/entitlements.helper.plist` (microphone only);
 *   2. `Contents/MacOS/Pilot` and the app bundle — with
 *      `build/entitlements.mac.plist` (JIT plus microphone).
 *
 * Signing the helper *first* matters for a second reason: signing the app seals
 * a hash of everything inside it, so a helper signed afterwards invalidates the
 * app's own signature.
 *
 * ## What this hook does NOT do
 *
 * It does not notarise, it does not staple, and it does not check Gatekeeper.
 * An ad-hoc signature has no team identifier, so it satisfies the loader and
 * nothing else — a copy that has been through a browser or a mail client keeps
 * its `com.apple.quarantine` attribute and Gatekeeper will still refuse it.
 * `docs/handoff.md` §1 step 22 says what the user has to do about that.
 *
 * ## NEVER EXECUTED ON A MAC
 *
 * The darwin branch below has never run: no `.app` has ever existed, `codesign`
 * has never been invoked from this repository, and no signed binary has ever
 * been launched. What *is* verified is the branch that matters for the gate —
 * a Linux `pnpm package` runs this hook on every build and it declines, by
 * name, without touching the bundle. {@link signPlan} is pure and is asserted
 * against a synthesised macOS context in `test/build/sign-mac.test.ts`.
 */

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const APP_ENTITLEMENTS = join(appRoot, 'build', 'entitlements.mac.plist');
const HELPER_ENTITLEMENTS = join(appRoot, 'build', 'entitlements.helper.plist');

/** Ad-hoc: no certificate, no team, no keychain lookup. */
export const AD_HOC_IDENTITY = '-';

function say(message) {
  process.stdout.write(`[pilot:sign] ${message}\n`);
}

/**
 * Decides what to sign, and with what. Pure — no filesystem, no spawning — so
 * the whole decision can be asserted on Linux.
 *
 * @param {{ appOutDir: string, packager: { platform: { name: string }, appInfo: { productFilename: string } } }} context
 *   The subset of electron-builder's `AfterPackContext` this hook reads.
 * @returns {{ skipped: string | null, appBundle: string, steps: { label: string, target: string, entitlements: string }[] }}
 */
export function signPlan(context) {
  const platform = context.packager.platform.name;
  const productFilename = context.packager.appInfo.productFilename;
  const appBundle = join(context.appOutDir, `${productFilename}.app`);

  if (platform !== 'mac') {
    return {
      skipped: `target platform is ${platform}, not mac; nothing to codesign`,
      appBundle,
      steps: [],
    };
  }
  if (process.platform !== 'darwin') {
    // Cross-building a mac target from Linux is possible for the *files* and
    // impossible for the signature: `codesign` is a macOS tool.
    return {
      skipped: `host is ${process.platform}, not darwin; \`codesign\` does not exist here`,
      appBundle,
      steps: [],
    };
  }

  return {
    skipped: null,
    appBundle,
    steps: [
      {
        label: 'helper',
        target: join(appBundle, 'Contents', 'Resources', 'helper', 'PilotHelper'),
        entitlements: HELPER_ENTITLEMENTS,
      },
      {
        label: 'app',
        target: appBundle,
        entitlements: APP_ENTITLEMENTS,
      },
    ],
  };
}

/**
 * The exact `codesign` argument vector for one step. Separated from
 * {@link signPlan} so a test can read it without a macOS context.
 *
 * `--options runtime` is what turns on the hardened runtime; without it the
 * entitlements file is accepted and then ignored, which is the silent-success
 * shape this repository keeps finding.
 */
export function codesignArgs(step) {
  return [
    '--force',
    '--sign',
    AD_HOC_IDENTITY,
    '--options',
    'runtime',
    '--timestamp=none', // an ad-hoc signature cannot be timestamped
    '--entitlements',
    step.entitlements,
    step.target,
  ];
}

/** @param {{ appOutDir: string, packager: unknown }} context */
export default function afterPack(context) {
  const plan = signPlan(context);
  if (plan.skipped !== null) {
    say(`skipped: ${plan.skipped}`);
    return;
  }

  for (const step of plan.steps) {
    if (!existsSync(step.target)) {
      // Loud rather than skipped: a missing helper here means `extraResources`
      // did not copy it, and an app signed without it would look fine and be
      // unable to observe anything.
      throw new Error(
        `[pilot:sign] cannot sign the ${step.label}: ${step.target} does not exist. ` +
          'The bundle is not what this hook was written for; do not ship it.',
      );
    }
    const args = codesignArgs(step);
    say(`codesign ${args.join(' ')}`);
    const result = spawnSync('codesign', args, { stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(
        `[pilot:sign] codesign failed for the ${step.label} (status ${String(result.status)}). ` +
          'An unsigned arm64 bundle will not launch; fix this rather than shipping it.',
      );
    }
  }

  // Reported, not asserted: `codesign --verify` on an ad-hoc signature says
  // what it says, and the useful thing is that the human packaging the app can
  // read it.
  const verify = spawnSync('codesign', ['--verify', '--verbose=2', plan.appBundle], {
    encoding: 'utf8',
  });
  say(`codesign --verify: ${(verify.stderr || verify.stdout || '').trim() || 'no output'}`);
  const display = spawnSync('codesign', ['--display', '--entitlements', '-', plan.appBundle], {
    encoding: 'utf8',
  });
  say(`entitlements actually sealed into the bundle:\n${display.stdout || display.stderr || ''}`);
}
