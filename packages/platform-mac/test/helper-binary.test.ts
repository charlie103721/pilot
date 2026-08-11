import { isPilotError } from '@pilot/shared';
import {
  HELPER_BINARY_ENV_VAR,
  HELPER_EXECUTABLE_NAME,
  helperBinaryCandidates,
  nativePackageDirectory,
  resolveHelperBinary,
  workspaceNativeDirectory,
} from '@pilot/platform-mac';
import { describe, expect, it } from 'vitest';

describe('helper binary resolution', () => {
  it('searches the override, the packaged bundle, then the SwiftPM build', () => {
    const candidates = helperBinaryCandidates({
      env: { [HELPER_BINARY_ENV_VAR]: '/tmp/override' },
      resourcesPath: '/Applications/Pilot.app/Contents/Resources',
    });

    expect(candidates.map((candidate) => candidate.source)).toEqual([
      'env',
      'packaged',
      'swift-build',
    ]);
    expect(candidates[0]?.path).toBe('/tmp/override');
    expect(candidates[1]?.path).toBe(
      `/Applications/Pilot.app/Contents/Resources/helper/${HELPER_EXECUTABLE_NAME}`,
    );
    expect(candidates[2]?.path).toBe(
      `${nativePackageDirectory()}/.build/debug/${HELPER_EXECUTABLE_NAME}`,
    );
  });

  it('finds a helper in all three layouts the app is ever started in', () => {
    // PR-042. The three are: `pnpm dev` with a locally built helper, an
    // unpacked build (which is the packaged layout with the bundle unzipped),
    // and the packaged `.app`. The first was unreachable without naming
    // PILOT_HELPER_BINARY by hand until `appPath` existed, because the bundled
    // main process cannot compute the SwiftPM path from its own module URL.
    const appPath = '/repo/apps/desktop';
    const devHelper = `${workspaceNativeDirectory(appPath)}/.build/debug/${HELPER_EXECUTABLE_NAME}`;
    expect(devHelper).toBe(
      `/repo/packages/platform-mac/native/.build/debug/${HELPER_EXECUTABLE_NAME}`,
    );
    expect(resolveHelperBinary({ env: {}, appPath, exists: (path) => path === devHelper })).toEqual(
      {
        source: 'swift-build',
        path: devHelper,
      },
    );

    for (const resourcesPath of [
      '/Applications/Pilot.app/Contents/Resources',
      '/tmp/release/mac-arm64/Pilot.app/Contents/Resources',
      // Architecture-independent by construction: nothing here knows or cares
      // whether the directory is mac-arm64 or mac-x64.
      '/tmp/release/mac-x64/Pilot.app/Contents/Resources',
    ]) {
      const packaged = `${resourcesPath}/helper/${HELPER_EXECUTABLE_NAME}`;
      expect(
        resolveHelperBinary({
          env: {},
          resourcesPath,
          appPath: `${resourcesPath}/app.asar`,
          exists: (path) => path === packaged,
        }),
      ).toEqual({ source: 'packaged', path: packaged });
    }
  });

  it('prefers the packaged helper to a workspace build, and an override to both', () => {
    const appPath = '/repo/apps/desktop';
    const resourcesPath = '/Applications/Pilot.app/Contents/Resources';
    const everythingExists = (): boolean => true;

    expect(
      resolveHelperBinary({ env: {}, resourcesPath, appPath, exists: everythingExists }).source,
    ).toBe('packaged');
    expect(
      resolveHelperBinary({
        env: { [HELPER_BINARY_ENV_VAR]: '/tmp/override' },
        resourcesPath,
        appPath,
        exists: everythingExists,
      }).source,
    ).toBe('env');
  });

  it('offers both SwiftPM configurations when an app path is known', () => {
    const candidates = helperBinaryCandidates({ env: {}, appPath: '/repo/apps/desktop' });
    const workspace = candidates
      .map((candidate) => candidate.path)
      .filter((path) => path.startsWith('/repo/'));
    // Debug first, because that is what a bare `swift build` writes and what
    // `pnpm dev` is documented against; release second, because packaging uses
    // it and a developer may have run that last.
    expect(workspace).toEqual([
      `/repo/packages/platform-mac/native/.build/debug/${HELPER_EXECUTABLE_NAME}`,
      `/repo/packages/platform-mac/native/.build/release/${HELPER_EXECUTABLE_NAME}`,
    ]);
  });

  it('honours the release configuration', () => {
    const candidates = helperBinaryCandidates({ env: {}, configuration: 'release' });
    expect(candidates[0]?.path).toContain('/.build/release/');
  });

  it('returns the first existing candidate', () => {
    const resolved = resolveHelperBinary({
      env: { [HELPER_BINARY_ENV_VAR]: '/tmp/override' },
      exists: (path) => path === '/tmp/override',
    });
    expect(resolved).toEqual({ source: 'env', path: '/tmp/override' });
  });

  it('reports a missing helper as a typed error listing every location', () => {
    try {
      resolveHelperBinary({ env: {}, exists: () => false });
    } catch (error) {
      if (!isPilotError(error)) {
        throw error;
      }
      expect(error.code).toBe('helper-unavailable');
      expect(error.retryable).toBe(false);
      expect(String(error.details?.buildHint)).toContain('swift build');
      expect(Array.isArray(error.details?.searched)).toBe(true);
      return;
    }
    throw new Error('expected resolveHelperBinary to throw');
  });
});
