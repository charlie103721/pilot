import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The Swift helper build hook, exercised on whatever host is running the tests.
 *
 * The interesting case here is the one this machine is in: no Swift toolchain,
 * no `packages/platform-mac`, and a packaging path that still has to work. The
 * hook is allowed to skip the native build, but it is not allowed to skip it
 * quietly — the bundle must end up with a real file at the real path, a
 * manifest saying the file is a placeholder and why, and a placeholder that
 * refuses to pretend it is a helper when something runs it.
 */

const appRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const script = join(appRoot, 'scripts', 'build-helper.js');

interface HelperManifest {
  readonly name: string;
  readonly kind: 'native' | 'placeholder';
  readonly reason: string | null;
  readonly detail: string | null;
  readonly host: string;
}

let stagingDir: string;
let result: { status: number | null; stdout: string; stderr: string };
let manifest: HelperManifest;

beforeAll(() => {
  stagingDir = mkdtempSync(join(tmpdir(), 'pilot-helper-'));
  result = spawnSync(process.execPath, [script, '--out', stagingDir], { encoding: 'utf8' });
  manifest = JSON.parse(readFileSync(join(stagingDir, 'helper.json'), 'utf8')) as HelperManifest;
});

afterAll(() => {
  rmSync(stagingDir, { recursive: true, force: true });
});

describe('the Swift helper build hook', () => {
  it('succeeds and stages a helper file whether or not Swift is available', () => {
    expect(result.status, result.stderr).toBe(0);
    const staged = statSync(join(stagingDir, 'pilot-helper'));
    expect(staged.size).toBeGreaterThan(0);
    // Something has to be able to spawn it.
    expect(staged.mode & 0o111).not.toBe(0);
  });

  it('records in the manifest which of the two it staged, and why', () => {
    expect(manifest.name).toBe('pilot-helper');
    expect(['native', 'placeholder']).toContain(manifest.kind);
    if (manifest.kind === 'placeholder') {
      // A skip with no stated reason is the failure mode this guards against.
      expect(manifest.reason).toMatch(
        /^(host-is-not-macos|swift-toolchain-missing|native-package-missing)$/,
      );
      expect(manifest.detail).toBeTruthy();
    } else {
      expect(manifest.reason).toBeNull();
    }
  });

  it('says out loud that the staged helper is a placeholder', () => {
    if (manifest.kind !== 'placeholder') {
      return;
    }
    expect(result.stdout).toContain('PLACEHOLDER');
    expect(result.stdout).toContain(manifest.reason ?? '');
  });

  it('stages a placeholder that fails loudly instead of pretending to be a helper', () => {
    if (manifest.kind !== 'placeholder') {
      return;
    }
    const run = spawnSync(join(stagingDir, 'pilot-helper'), [], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('placeholder');
    expect(run.stderr).toContain(manifest.reason ?? '');
    // It must not print anything a caller could mistake for a protocol reply.
    expect(run.stdout).toBe('');
  });

  it('refuses to stage a placeholder under --require-native', () => {
    if (manifest.kind !== 'placeholder') {
      return;
    }
    const strict = mkdtempSync(join(tmpdir(), 'pilot-helper-strict-'));
    try {
      const run = spawnSync(process.execPath, [script, '--out', strict, '--require-native'], {
        encoding: 'utf8',
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(manifest.reason ?? '');
      expect(run.stderr).toContain('Refusing to stage a placeholder');
    } finally {
      rmSync(strict, { recursive: true, force: true });
    }
  });

  it('rejects unknown arguments with usage instead of a stack trace', () => {
    const run = spawnSync(process.execPath, [script, '--wat'], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('unknown argument --wat');
    expect(run.stderr).toContain('Usage:');
    expect(run.stderr).not.toContain('at ');
  });
});
