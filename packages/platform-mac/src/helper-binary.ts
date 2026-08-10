import { PilotError } from '@pilot/shared';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locates the embedded helper executable.
 *
 * The helper ships inside the app bundle (system-design §4) and is never a
 * user-managed service, so there is no PATH lookup and no configuration file:
 * only an explicit override for development, the packaged location, and the
 * SwiftPM build output.
 */

/**
 * Name of the executable produced by `native/Package.swift`. The SwiftPM
 * product and target share this name so the build output path is unambiguous.
 */
export const HELPER_EXECUTABLE_NAME = 'PilotHelper';

/** Development override, absolute path to a helper binary. */
export const HELPER_BINARY_ENV_VAR = 'PILOT_HELPER_BINARY';

export type HelperBinarySource = 'env' | 'packaged' | 'swift-build';

export interface HelperBinaryCandidate {
  readonly source: HelperBinarySource;
  readonly path: string;
}

export interface ResolveHelperBinaryOptions {
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Packaged app resources directory (`process.resourcesPath` in Electron). */
  readonly resourcesPath?: string | undefined;
  /** `debug` (default) or `release`; selects the SwiftPM build directory. */
  readonly configuration?: 'debug' | 'release';
  /** Overrides the existence check. Injected by tests. */
  readonly exists?: (path: string) => boolean;
}

/** Directory holding `native/Package.swift`, resolved from this module. */
export function nativePackageDirectory(): string {
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'native');
}

/** Every location that is searched, in priority order. */
export function helperBinaryCandidates(
  options: ResolveHelperBinaryOptions = {},
): readonly HelperBinaryCandidate[] {
  const env = options.env ?? process.env;
  const configuration = options.configuration ?? 'debug';
  const candidates: HelperBinaryCandidate[] = [];

  const override = env[HELPER_BINARY_ENV_VAR];
  if (override !== undefined && override !== '') {
    candidates.push({ source: 'env', path: override });
  }
  if (options.resourcesPath !== undefined && options.resourcesPath !== '') {
    candidates.push({
      source: 'packaged',
      path: join(options.resourcesPath, 'helper', HELPER_EXECUTABLE_NAME),
    });
  }
  candidates.push({
    source: 'swift-build',
    path: join(nativePackageDirectory(), '.build', configuration, HELPER_EXECUTABLE_NAME),
  });

  return candidates;
}

/**
 * Returns the first candidate that exists.
 *
 * Throws `helper-unavailable` listing every location searched — the helper
 * being missing is an explicit, reportable state, not a silent no-op
 * (delivery rules).
 */
export function resolveHelperBinary(
  options: ResolveHelperBinaryOptions = {},
): HelperBinaryCandidate {
  const exists = options.exists ?? existsSync;
  const candidates = helperBinaryCandidates(options);
  for (const candidate of candidates) {
    if (exists(candidate.path)) {
      return candidate;
    }
  }
  throw new PilotError('helper-unavailable', 'The macOS helper executable was not found', {
    userMessage: 'Pilot’s macOS helper is missing. Reinstall Pilot.',
    retryable: false,
    details: {
      searched: candidates.map((candidate) => `${candidate.source}:${candidate.path}`),
      buildHint: `swift build --package-path ${nativePackageDirectory()}`,
    },
  });
}
