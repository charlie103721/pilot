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
  /**
   * Electron's `app.getAppPath()`. See {@link workspaceNativeDirectory}: the
   * bundled main process cannot compute the SwiftPM build path from its own
   * module URL, so `pnpm dev` needs this to find a locally built helper.
   */
  readonly appPath?: string | undefined;
  /** `debug` (default) or `release`; selects the SwiftPM build directory. */
  readonly configuration?: 'debug' | 'release';
  /** Overrides the existence check. Injected by tests. */
  readonly exists?: (path: string) => boolean;
}

/** Directory holding `native/Package.swift`, resolved from this module. */
export function nativePackageDirectory(): string {
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'native');
}

/**
 * The same directory, derived from an Electron `app.getAppPath()` instead of
 * from this module's own URL.
 *
 * PR-042. {@link nativePackageDirectory} is correct whenever this file runs as
 * a *file* — vitest, the platform demos, `tsc --build` output — because
 * `import.meta.url` then really is inside `packages/platform-mac/src/`. It is
 * wrong in exactly one layout, and it is the layout a developer uses most:
 * under `pnpm dev` electron-vite has inlined this module into
 * `apps/desktop/dist/main/index.js`, so `import.meta.url` points at `dist/main`
 * and the computed package directory is `apps/desktop/dist/native`, which never
 * exists. That is why `docs/handoff.md` told the user to name
 * `PILOT_HELPER_BINARY` by hand for every `pnpm dev` run on a Mac.
 *
 * `app.getAppPath()` is `apps/desktop` in development (and `…/app.asar` when
 * packaged, where this candidate resolves to a path that cannot exist and is
 * skipped), so the workspace root is two levels up from it.
 */
export function workspaceNativeDirectory(appPath: string): string {
  return resolve(appPath, '..', '..', 'packages', 'platform-mac', 'native');
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
  if (options.appPath !== undefined && options.appPath !== '') {
    // Both configurations, because this candidate exists for the human running
    // `swift build` in another terminal and `swift build -c release` is just as
    // likely as the default. `configuration` still decides which is preferred.
    const other = configuration === 'debug' ? 'release' : 'debug';
    for (const which of [configuration, other]) {
      candidates.push({
        source: 'swift-build',
        path: join(
          workspaceNativeDirectory(options.appPath),
          '.build',
          which,
          HELPER_EXECUTABLE_NAME,
        ),
      });
    }
  }

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
