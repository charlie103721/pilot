import { createPackage } from '@electron/asar';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAIN_BUNDLE_MAX_BYTES,
  PRODUCTION_CSP,
  externalSpecifiers,
  findBundle,
  isRuntimeProvided,
  looksExecutable,
  parsePlistXml,
  verifyBundle,
  // @ts-expect-error -- see above.
} from '../../scripts/verify-bundle.js';

/**
 * The bundle verifier, checked against bundles that are deliberately wrong
 * (PR-042).
 *
 * A checker nobody has ever seen fail is indistinguishable from a checker that
 * always passes — PR-041's claim A1 in a different costume. So this synthesises
 * a correct bundle, asserts it passes, and then breaks it one way at a time.
 * Each case below is a real packaging failure that every other gate in this
 * repository reports as success:
 *
 *  - a missing staged data file (the PR-036 defect: the app starts, answers,
 *    and persists nothing);
 *  - an externalised dependency (resolves in development, fails only packaged);
 *  - a `crossorigin` attribute (blank panel over `file:`, no error anywhere);
 *  - a `main` that names a file which is not in the archive;
 *  - a binary inside the archive (nothing can be spawned from an asar);
 *  - a main bundle that grew by megabytes (cross-lane hazard 24).
 */

const directories: string[] = [];

const GOOD_MAIN = [
  "import { app } from 'electron';",
  "import { readFile } from 'node:fs/promises';",
  "import process from 'process';",
  'export const boot = () => app;',
  'export const read = readFile;',
  'export const pid = process.pid;',
  '',
].join('\n');

const GOOD_PRELOAD = [
  "const { contextBridge } = require('electron');",
  'module.exports = {};',
  '',
].join('\n');

const GOOD_HTML = [
  '<!doctype html>',
  '<html><head>',
  `<meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`,
  '<link rel="stylesheet" href="./index.css">',
  '</head><body><script type="module" src="./renderer.js"></script></body></html>',
  '',
].join('\n');

interface BundleShape {
  readonly main?: string;
  readonly preload?: string;
  readonly html?: string;
  readonly packageJson?: unknown;
  /** Extra files inside the archive, by relative path. */
  readonly extra?: Record<string, Buffer | string>;
  /** Drop these from the archive. */
  readonly omit?: readonly string[];
  readonly helperKind?: 'native' | 'placeholder';
}

/** Builds a real `release/<dir>/resources` layout with a real asar in it. */
async function stageBundle(shape: BundleShape = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pilot-verify-'));
  directories.push(root);
  const src = join(root, 'src');
  const resources = join(root, 'release', 'app-unpacked', 'resources');
  mkdirSync(join(src, 'dist', 'main', 'migrations'), { recursive: true });
  mkdirSync(join(src, 'dist', 'preload'), { recursive: true });
  mkdirSync(join(src, 'dist', 'renderer'), { recursive: true });
  mkdirSync(join(resources, 'helper'), { recursive: true });

  const files: Record<string, Buffer | string> = {
    'package.json': JSON.stringify(
      shape.packageJson ?? { name: 'pilot', type: 'module', main: './dist/main/index.js' },
    ),
    'dist/main/index.js': shape.main ?? GOOD_MAIN,
    'dist/main/migrations/001_initial.sql': 'CREATE TABLE sessions (id TEXT);',
    'dist/preload/index.cjs': shape.preload ?? GOOD_PRELOAD,
    'dist/renderer/index.html': shape.html ?? GOOD_HTML,
    'dist/renderer/renderer.js': 'export const mount = () => undefined;',
    'dist/renderer/index.css': 'body { margin: 0 }',
    ...(shape.extra ?? {}),
  };
  for (const name of shape.omit ?? []) {
    delete files[name];
  }
  for (const [name, contents] of Object.entries(files)) {
    const full = join(src, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
  await createPackage(src, join(resources, 'app.asar'));

  const kind = shape.helperKind ?? 'placeholder';
  writeFileSync(join(resources, 'helper', 'PilotHelper'), '#!/bin/sh\nexit 78\n', { mode: 0o755 });
  chmodSync(join(resources, 'helper', 'PilotHelper'), 0o755);
  writeFileSync(
    join(resources, 'helper', 'helper.json'),
    JSON.stringify({ name: 'PilotHelper', kind, reason: 'host-is-not-macos', infoPlist: null }),
  );

  return { releaseDir: join(root, 'release'), resources };
}

function problemsOf(bundle: { resources: string }): string[] {
  return (verifyBundle({ ...bundle, macApp: null }) as { problems: string[] }).problems;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('the bundle verifier', () => {
  it('passes a bundle that is actually correct', async () => {
    const staged = await stageBundle();
    expect(problemsOf(staged)).toEqual([]);
    expect(findBundle(staged.releaseDir)).not.toBeNull();
  });

  it('catches the PR-036 defect: a staged data file that did not get staged', async () => {
    const staged = await stageBundle({ omit: ['dist/main/migrations/001_initial.sql'] });
    expect(problemsOf(staged)).toEqual([
      'app.asar does not contain dist/main/migrations/001_initial.sql',
    ]);
  });

  it('catches a stylesheet that never made it in', async () => {
    const staged = await stageBundle({ omit: ['dist/renderer/index.css'] });
    expect(problemsOf(staged)).toContain('app.asar does not contain dist/renderer/index.css');
  });

  it('catches a dependency left external, which only ever fails once packaged', async () => {
    const staged = await stageBundle({
      main: `${GOOD_MAIN}import { z } from 'zod';\nexport const schema = z;\n`,
    });
    expect(problemsOf(staged).join('\n')).toContain('main bundle imports "zod"');
  });

  it('catches an externalised require in the preload as well', async () => {
    const staged = await stageBundle({
      preload: `${GOOD_PRELOAD}const shared = require('@pilot/shared');\n`,
    });
    expect(problemsOf(staged).join('\n')).toContain('preload bundle imports "@pilot/shared"');
  });

  it('catches a preload emitted as ESM, which a sandboxed renderer cannot load', async () => {
    const staged = await stageBundle({ preload: "import { contextBridge } from 'electron';\n" });
    expect(problemsOf(staged).join('\n')).toContain('the preload is an ES module');
  });

  it('catches a crossorigin attribute, which is a blank panel and no error', async () => {
    const staged = await stageBundle({
      html: GOOD_HTML.replace('type="module"', 'type="module" crossorigin'),
    });
    expect(problemsOf(staged).join('\n')).toContain('crossorigin');
  });

  it('catches an absolute asset path, which resolves against / under file:', async () => {
    const staged = await stageBundle({
      html: GOOD_HTML.replace('"./renderer.js"', '"/renderer.js"'),
    });
    expect(problemsOf(staged).join('\n')).toContain('absolute asset path');
  });

  it('catches a Content-Security-Policy that drifted during packaging', async () => {
    const staged = await stageBundle({
      html: GOOD_HTML.replace("connect-src 'none'", 'connect-src *'),
    });
    expect(problemsOf(staged).join('\n')).toContain('not the one electron.vite.config.ts records');
  });

  it('catches a package.json whose main is not in the archive', async () => {
    const staged = await stageBundle({
      packageJson: { name: 'pilot', type: 'module', main: './dist/main/nope.js' },
    });
    expect(problemsOf(staged).join('\n')).toContain('which is not in the archive');
  });

  it('catches a package.json that is not an ES module, which the main bundle is', async () => {
    const staged = await stageBundle({
      packageJson: { name: 'pilot', main: './dist/main/index.js' },
    });
    expect(problemsOf(staged).join('\n')).toContain('"type": "module"');
  });

  it('catches a binary inside the archive, which nothing can spawn', async () => {
    const machO = Buffer.alloc(64);
    machO.writeUInt32BE(0xcffaedfe, 0);
    const staged = await stageBundle({ extra: { 'dist/main/SomeBinary': machO } });
    expect(problemsOf(staged).join('\n')).toContain('looks like an executable');
  });

  it('catches a node_modules tree dragged into the archive', async () => {
    const staged = await stageBundle({
      extra: { 'node_modules/zod/index.js': 'export default 1;' },
    });
    expect(problemsOf(staged).join('\n')).toContain('node_modules entries');
  });

  it('catches the hazard-24 size regression', async () => {
    const staged = await stageBundle({
      main: `${GOOD_MAIN}// ${'x'.repeat(MAIN_BUNDLE_MAX_BYTES + 1)}\n`,
    });
    expect(problemsOf(staged).join('\n')).toContain('Do not raise the budget');
  });

  it('catches a manifest that disagrees with the file beside it', async () => {
    const staged = await stageBundle({ helperKind: 'native' });
    expect(problemsOf(staged).join('\n')).toContain('not a Mach-O binary');
  });

  it('says what it did NOT check, rather than passing quietly', async () => {
    const staged = await stageBundle();
    const result = verifyBundle({ ...staged, macApp: null }) as { notes: string[] };
    expect(result.notes.join('\n')).toContain('NOT CHECKED');
  });
});

describe('the verifier’s own primitives', () => {
  it('treats unprefixed built-ins as runtime-provided and npm packages as not', () => {
    for (const specifier of ['electron', 'node:fs', 'process', 'buffer', './local.js']) {
      expect(isRuntimeProvided(specifier), specifier).toBe(true);
    }
    for (const specifier of ['zod', '@pilot/shared', 'react']) {
      expect(isRuntimeProvided(specifier), specifier).toBe(false);
    }
  });

  it('finds every shape of specifier Rollup emits for an external', () => {
    const source = [
      "import { a } from 'alpha';",
      "import 'beta';",
      "const c = require('gamma');",
      "import def from 'delta';",
    ].join('\n');
    expect(externalSpecifiers(source).sort()).toEqual(['alpha', 'beta', 'delta', 'gamma']);
  });

  it('recognises Mach-O and ELF headers and nothing else', () => {
    const machO = Buffer.alloc(8);
    machO.writeUInt32BE(0xfeedfacf, 0);
    expect(looksExecutable(machO)).toBe(true);
    expect(looksExecutable(Buffer.from('#!/bin/sh\n'))).toBe(false);
    expect(looksExecutable(Buffer.from('ab'))).toBe(false);
  });

  it('reads a flat XML plist, booleans included', () => {
    const parsed = parsePlistXml(
      [
        '<plist><dict>',
        '<key>LSUIElement</key><true/>',
        '<key>CFBundleIdentifier</key><string>works.pilot.desktop</string>',
        '<key>NSSupportsSuddenTermination</key><false/>',
        '</dict></plist>',
      ].join('\n'),
    ) as Record<string, string>;
    expect(parsed).toEqual({
      LSUIElement: 'true',
      CFBundleIdentifier: 'works.pilot.desktop',
      NSSupportsSuddenTermination: 'false',
    });
  });
});
