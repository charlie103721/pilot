import { isPilotError } from '@pilot/shared';
import {
  HELPER_BINARY_ENV_VAR,
  HELPER_EXECUTABLE_NAME,
  helperBinaryCandidates,
  nativePackageDirectory,
  resolveHelperBinary,
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
