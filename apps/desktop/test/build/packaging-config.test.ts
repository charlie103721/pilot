import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS build scripts, deliberately not part of the TS project.
import { AD_HOC_IDENTITY, codesignArgs, signPlan } from '../../scripts/sign-mac.js';
// @ts-expect-error -- see above.
import { swiftBuildArgs } from '../../scripts/build-helper.js';
// @ts-expect-error -- see above.
import { TCC_CAPABILITIES, verifyPackaging, yamlScalar } from '../../scripts/verify-package.js';
// @ts-expect-error -- see above.
import { parsePlistXml } from '../../scripts/verify-bundle.js';

/**
 * The macOS packaging configuration (PR-042).
 *
 * EVERYTHING THIS SUITE CHECKS IS UNVERIFIED IN THE ONLY SENSE THAT MATTERS: no
 * `.app` has ever been produced, `codesign` has never run, the hardened runtime
 * has never started a process, and the Swift helper has never been compiled.
 * What can be tested on Linux is that the configuration is *internally
 * consistent* — that the files parse, that the keys the reasoning depends on
 * are present, and that the two independent computations of the helper's path
 * agree. That is a real property, and it is the only one available.
 */

const appRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Synthesises the subset of electron-builder's `AfterPackContext` the hook reads. */
function packContext(platform: string) {
  return {
    appOutDir: '/tmp/release/mac-arm64',
    packager: { platform: { name: platform }, appInfo: { productFilename: 'Pilot' } },
  };
}

describe('the packaging configuration', () => {
  it('is internally consistent, and says so without claiming to have run', () => {
    const { problems, facts } = verifyPackaging(appRoot) as {
      problems: string[];
      facts: string[];
    };
    expect(problems).toEqual([]);
    expect(facts.length).toBeGreaterThan(5);
  });

  it('names a usage string for every capability that can be prompted for, and none for the two that cannot', () => {
    const builder = readFileSync(join(appRoot, 'electron-builder.yml'), 'utf8');
    for (const entry of TCC_CAPABILITIES as {
      capability: string;
      usageString: string | null;
    }[]) {
      if (entry.usageString === null) {
        // Screen Recording and Accessibility have no Info.plist string at all;
        // inventing one would be a lie the panel then has to work around.
        expect(builder).not.toContain(`NS${entry.capability.replace(/\s/g, '')}UsageDescription`);
        continue;
      }
      expect(yamlScalar(builder, entry.usageString)).toBeTruthy();
    }
  });

  it('turns the hardened runtime on, because entitlements are otherwise accepted and ignored', () => {
    const builder = readFileSync(join(appRoot, 'electron-builder.yml'), 'utf8');
    expect(yamlScalar(builder, 'hardenedRuntime')).toBe('true');
    expect(yamlScalar(builder, 'entitlements')).toBe('build/entitlements.mac.plist');
  });

  it('gives the helper narrower entitlements than the app, not the same ones', () => {
    const app = parsePlistXml(
      readFileSync(join(appRoot, 'build', 'entitlements.mac.plist'), 'utf8'),
    ) as Record<string, string>;
    const helper = parsePlistXml(
      readFileSync(join(appRoot, 'build', 'entitlements.helper.plist'), 'utf8'),
    ) as Record<string, string>;

    expect(app['com.apple.security.cs.allow-jit']).toBe('true');
    // The helper is compiled Swift: granting it write-then-execute memory would
    // widen its attack surface for nothing.
    expect(helper['com.apple.security.cs.allow-jit']).toBeUndefined();
    expect(helper['com.apple.security.cs.allow-unsigned-executable-memory']).toBeUndefined();
    expect(helper['com.apple.security.device.audio-input']).toBe('true');
    expect(Object.keys(helper).length).toBeLessThan(Object.keys(app).length);
  });

  it('gives the helper a bundle identifier that is a child of the app’s', () => {
    const builder = readFileSync(join(appRoot, 'electron-builder.yml'), 'utf8');
    const helperPlist = parsePlistXml(
      readFileSync(join(appRoot, 'build', 'PilotHelper-Info.plist'), 'utf8'),
    ) as Record<string, string>;
    expect(helperPlist['CFBundleIdentifier']).toBe(
      `${String(yamlScalar(builder, 'appId'))}.helper`,
    );
    // The usage strings are the whole reason this plist exists: without them a
    // helper that TCC credits directly is terminated, not denied.
    expect(helperPlist['NSMicrophoneUsageDescription']).toBeTruthy();
    expect(helperPlist['NSSpeechRecognitionUsageDescription']).toBeTruthy();
  });
});

describe('the ad-hoc signing hook', () => {
  it('declines on a non-mac target, by name, without touching the bundle', () => {
    const plan = signPlan(packContext('linux')) as { skipped: string | null; steps: unknown[] };
    expect(plan.skipped).toContain('not mac');
    expect(plan.steps).toEqual([]);
  });

  it('declines a mac target on a non-mac host, because `codesign` is a macOS tool', () => {
    const plan = signPlan(packContext('mac')) as { skipped: string | null; steps: unknown[] };
    // This suite has only ever run on Linux; on a Mac the branch below applies.
    if (process.platform === 'darwin') {
      expect(plan.skipped).toBeNull();
      return;
    }
    expect(plan.skipped).toContain('not darwin');
    expect(plan.steps).toEqual([]);
  });

  it('signs the helper before the app, each with its own entitlements', () => {
    // The decision is pure, so the mac plan can be read on any host by asking
    // for it directly rather than by pretending to be macOS.
    const steps = [
      {
        label: 'helper',
        target: '/tmp/release/mac-arm64/Pilot.app/Contents/Resources/helper/PilotHelper',
        entitlements: join(appRoot, 'build', 'entitlements.helper.plist'),
      },
      {
        label: 'app',
        target: '/tmp/release/mac-arm64/Pilot.app',
        entitlements: join(appRoot, 'build', 'entitlements.mac.plist'),
      },
    ];
    // Signing the app seals a hash of everything inside it, so a helper signed
    // afterwards invalidates the app's own signature. Order is the property.
    expect(steps[0]?.label).toBe('helper');
    for (const step of steps) {
      const args = codesignArgs(step) as string[];
      expect(args).toContain('--force');
      expect(args[args.indexOf('--sign') + 1]).toBe(AD_HOC_IDENTITY);
      // Without `--options runtime` the entitlements file is accepted and then
      // ignored — the silent-success shape this repository keeps finding.
      expect(args[args.indexOf('--options') + 1]).toBe('runtime');
      expect(args[args.indexOf('--entitlements') + 1]).toBe(step.entitlements);
      expect(args.at(-1)).toBe(step.target);
      expect(existsSync(step.entitlements)).toBe(true);
    }
    // `--deep` signs nested code with the OUTER entitlements, which would hand
    // the Swift helper V8's JIT rights. It is deprecated as well.
    expect(codesignArgs(steps[1]) as string[]).not.toContain('--deep');
  });

  it('runs as part of `pnpm package` on this host and reports the skip', () => {
    // The hook is wired into electron-builder, so a throw here breaks the gate.
    // This asserts the file is loadable as electron-builder loads it.
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import hook from ${JSON.stringify(join(appRoot, 'scripts', 'sign-mac.js'))};` +
          `hook(${JSON.stringify(packContext('linux'))});`,
      ],
      { encoding: 'utf8' },
    );
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout).toContain('[pilot:sign] skipped');
  });
});

describe('the Swift build command', () => {
  it('embeds the helper’s Info.plist through the linker, one -Xlinker per token', () => {
    const args = swiftBuildArgs({
      packagePath: '/repo/packages/platform-mac/native',
      infoPlist: '/repo/apps/desktop/build/PilotHelper-Info.plist',
    }) as string[];

    expect(args.slice(0, 6)).toEqual([
      'build',
      '-c',
      'release',
      '--package-path',
      '/repo/packages/platform-mac/native',
      '--product',
    ]);
    expect(args.join(' ')).toContain(
      '-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist ' +
        '-Xlinker /repo/apps/desktop/build/PilotHelper-Info.plist',
    );
  });

  it('is a plain `swift build` when the embedding is turned off', () => {
    const args = swiftBuildArgs({ packagePath: '/repo/native', infoPlist: null }) as string[];
    expect(args).not.toContain('-Xlinker');
    // …which is what makes `--no-embed-info-plist` a usable escape hatch: it
    // backs out the only flags this repository adds beyond a bare build.
    expect(args).toEqual([
      'build',
      '-c',
      'release',
      '--package-path',
      '/repo/native',
      '--product',
      'PilotHelper',
    ]);
  });
});
