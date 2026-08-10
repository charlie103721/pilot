import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPackage } from '@electron/asar';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The development build, end to end, from a clean tree.
 *
 * Everything here is asserted against files the build actually produced. That
 * distinction is the point of this suite: a packaging configuration can be
 * wrong in ways every step still reports as success — an `extraResources` entry
 * that matches nothing, a `files` pattern that drops `dist/preload`, a preload
 * emitted as ESM that a sandboxed renderer will refuse hours later. So the
 * suite deletes the outputs, rebuilds them, and then opens the results.
 *
 * The bundle is produced with `--dir`, the same development configuration the
 * README documents. It is skipped only when the Electron runtime binary is
 * absent, which is the one thing this cannot substitute for.
 */

const appRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const dist = join(appRoot, 'dist');
const release = join(appRoot, 'release');
const staging = join(appRoot, 'resources', 'helper');

/** `pnpm install` fetches this; see apps/desktop/scripts/ensure-electron.js. */
const electronDist = join(appRoot, 'node_modules', 'electron', 'dist');
const hasElectron = existsSync(electronDist);

const BUILD_TIMEOUT_MS = 600_000;

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], { cwd: appRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `\`${command} ${args.join(' ')}\` failed with status ${String(result.status)}\n` +
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
}

/** The bundle layout electron-builder produced, whatever platform made it. */
function findResourcesDir(): string {
  for (const entry of readdirSync(release, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const base = join(release, entry.name);
    const candidates = [join(base, 'resources')];
    for (const nested of readdirSync(base, { withFileTypes: true })) {
      if (nested.isDirectory() && nested.name.endsWith('.app')) {
        candidates.push(join(base, nested.name, 'Contents', 'Resources'));
      }
    }
    const found = candidates.find((candidate) => existsSync(join(candidate, 'app.asar')));
    if (found !== undefined) {
      return found;
    }
  }
  throw new Error(`no resources directory with an app.asar under ${release}`);
}

/** Collapses the CSP's source formatting so only the directives are compared. */
function contentSecurityPolicy(html: string): string {
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html);
  if (match?.[1] === undefined) {
    throw new Error('no Content-Security-Policy meta tag');
  }
  return match[1].replace(/\s+/g, ' ').trim();
}

describe.skipIf(!hasElectron)('the development build, from a clean tree', () => {
  let resourcesDir: string;
  let asarEntries: Set<string>;

  beforeAll(() => {
    for (const path of [dist, release, staging]) {
      rmSync(path, { recursive: true, force: true });
    }
    run(process.execPath, [join(appRoot, 'scripts', 'build-helper.js')]);
    run('pnpm', ['exec', 'electron-vite', 'build']);
    run('pnpm', ['exec', 'electron-builder', '--dir', '--config', 'electron-builder.yml']);

    resourcesDir = findResourcesDir();
    asarEntries = new Set(
      listPackage(join(resourcesDir, 'app.asar'), { isPack: false }).map((name) =>
        name.replace(/^[/\\]/, ''),
      ),
    );
  }, BUILD_TIMEOUT_MS);

  it('emits one bundle per Electron process', () => {
    expect(existsSync(join(dist, 'main', 'index.js'))).toBe(true);
    expect(existsSync(join(dist, 'preload', 'index.cjs'))).toBe(true);
    expect(existsSync(join(dist, 'renderer', 'index.html'))).toBe(true);
    expect(existsSync(join(dist, 'renderer', 'renderer.js'))).toBe(true);
  });

  it('emits the preload as self-contained CommonJS, because the panel is sandboxed', () => {
    const preload = readFileSync(join(dist, 'preload', 'index.cjs'), 'utf8');
    // A sandboxed preload cannot be an ES module...
    expect(preload).not.toMatch(/^\s*(import|export)\s/m);
    // ...and it has no module resolution, so `electron` is the only thing it
    // may ask the runtime for.
    const required = [...preload.matchAll(/require\((["'])(.*?)\1\)/g)].map((match) => match[2]);
    expect([...new Set(required)]).toEqual(['electron']);
  });

  it('leaves nothing but electron and node built-ins external to the main bundle', () => {
    const main = readFileSync(join(dist, 'main', 'index.js'), 'utf8');
    const imported = [...main.matchAll(/^import\s[^'"]*from\s*["'](.*?)["']/gm)].map(
      (match) => match[1] ?? '',
    );
    for (const specifier of imported) {
      expect(
        specifier === 'electron' ||
          specifier.startsWith('node:') ||
          // Unprefixed built-ins count too. PR-029 pulled `@pilot/agent` — and
          // with it Pi — into the main bundle, and Pi's dependencies import
          // `process` and `buffer` without the `node:` prefix. Those resolve to
          // the same built-ins. The invariant this test protects is that no
          // *npm package* is left external, because the packaged asar ships no
          // `node_modules`.
          builtinModules.includes(specifier),
        `main/index.js imports ${specifier}, which the packaged asar does not contain`,
      ).toBe(true);
    }
    expect(imported).toContain('electron');
  });

  it('ships the renderer CSP byte for byte', () => {
    const source = readFileSync(join(appRoot, 'src', 'renderer', 'index.html'), 'utf8');
    const built = readFileSync(join(dist, 'renderer', 'index.html'), 'utf8');
    expect(contentSecurityPolicy(built)).toBe(contentSecurityPolicy(source));
    expect(contentSecurityPolicy(built)).toContain("default-src 'none'");
    expect(contentSecurityPolicy(built)).toContain("script-src 'self'");
    expect(contentSecurityPolicy(built)).toContain("connect-src 'none'");
  });

  it('emits renderer tags that a file: URL can actually load', () => {
    const built = readFileSync(join(dist, 'renderer', 'index.html'), 'utf8');
    // CORS-mode fetches are refused over file:, and the window comes up blank.
    expect(built).not.toContain('crossorigin');
    // Absolute asset paths would resolve against the filesystem root.
    expect(built).not.toMatch(/(src|href)="\//);
    expect(built).toMatch(/src="\.\/renderer\.js"/);
  });

  it('packages the app entry points into the asar and nothing else', () => {
    for (const entry of [
      'package.json',
      'dist/main/index.js',
      'dist/preload/index.cjs',
      'dist/renderer/index.html',
      'dist/renderer/renderer.js',
    ]) {
      expect([...asarEntries]).toContain(entry);
    }
    // pnpm's symlinked store must not have been dragged in.
    expect([...asarEntries].filter((entry) => entry.startsWith('node_modules'))).toEqual([]);
  });

  it('puts the helper payload inside the produced bundle, not just in the config', () => {
    const helper = join(resourcesDir, 'helper', 'PilotHelper');
    expect(existsSync(helper), `expected a helper at ${helper}`).toBe(true);
    expect(statSync(helper).size).toBeGreaterThan(0);
    expect(statSync(helper).mode & 0o111).not.toBe(0);

    // The helper is spawned as a child process, so it must be a real file
    // beside the archive rather than an entry inside it.
    expect([...asarEntries].some((entry) => entry.includes('PilotHelper'))).toBe(false);

    const manifest = JSON.parse(
      readFileSync(join(resourcesDir, 'helper', 'helper.json'), 'utf8'),
    ) as { kind: string; reason: string | null };
    expect(['native', 'placeholder']).toContain(manifest.kind);
    if (manifest.kind === 'placeholder') {
      expect(manifest.reason).toBeTruthy();
    }
  });

  it('agrees with the standalone bundle check that `pnpm package` runs', () => {
    const check = spawnSync(process.execPath, [join(appRoot, 'scripts', 'verify-bundle.js')], {
      cwd: appRoot,
      encoding: 'utf8',
    });
    expect(check.status, `${check.stdout}\n${check.stderr}`).toBe(0);
    expect(check.stdout).toContain('OK: every required file is present');
  });

  it('reports a missing bundle clearly rather than passing on an empty release dir', () => {
    const check = spawnSync(
      process.execPath,
      [join(appRoot, 'scripts', 'verify-bundle.js'), '--release-dir', join(appRoot, 'no-such-dir')],
      { cwd: appRoot, encoding: 'utf8' },
    );
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('no packaged bundle');
    expect(check.stderr).toContain('run `pnpm --filter @pilot/desktop run package`'.slice(4));
  });
});
