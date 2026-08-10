/**
 * Exact Pi versions this package was written and verified against (PR-005).
 *
 * These are duplicated here on purpose: `docs/pi-notes.md` cites file/line
 * numbers inside these exact tarballs, and a silent bump would invalidate the
 * findings. {@link assertPinnedPiVersions} lets a test fail loudly on drift.
 */
export const PINNED_PI_VERSIONS = {
  '@earendil-works/pi-agent-core': '0.84.1',
  '@earendil-works/pi-ai': '0.84.1',
  '@earendil-works/pi-session-backend-sqlite-node': '0.84.1',
  // Not a Pi package, but part of the Pi surface: `AgentTool.parameters` is a
  // TypeBox `TSchema` and Pi validates every tool call against it before
  // `execute` runs. PR-021 authors that schema, so a typebox bump changes what
  // arguments reach `observe_screen`. Pinned exactly, and depended on directly
  // by `@pilot/agent` rather than reached through pi-ai's re-export.
  typebox: '1.3.7',
} as const;

/**
 * Packages deliberately NOT used, with the reason.
 *
 * `pi-storage-sqlite-node` is the package named in `docs/runbook.md` §7. It is
 * stuck at 0.83.0 and is *not* compatible with `pi-agent-core@0.84.1`: its
 * `SessionRepo.create()` returns a 0.83.0 `Session` whose method surface is
 * different (`getEntries`/`buildContext`/`appendTypedEntry` instead of
 * `findEntries`/`appendRecord`/lanes), and installing it drags a duplicate
 * 0.83.0 copy of `pi-agent-core` and `pi-ai` into the tree. The 0.84.1
 * replacement is `@earendil-works/pi-session-backend-sqlite-node`.
 */
export const REJECTED_PI_PACKAGES = {
  '@earendil-works/pi-storage-sqlite-node': {
    latest: '0.83.0',
    reason:
      'Renamed to @earendil-works/pi-session-backend-sqlite-node at 0.84.x. The 0.83.0 build ' +
      'returns an incompatible Session class and duplicates pi-agent-core/pi-ai in the tree.',
  },
} as const;

export type PinnedPiPackage = keyof typeof PINNED_PI_VERSIONS;

/**
 * Compares {@link PINNED_PI_VERSIONS} against the versions actually installed.
 * Returns the mismatches; an empty array means the tree matches the notes.
 */
export function findPinnedVersionDrift(
  installed: Readonly<Record<string, string>>,
): { readonly name: PinnedPiPackage; readonly expected: string; readonly actual?: string }[] {
  const drift: { name: PinnedPiPackage; expected: string; actual?: string }[] = [];
  for (const [name, expected] of Object.entries(PINNED_PI_VERSIONS) as [
    PinnedPiPackage,
    string,
  ][]) {
    const actual = installed[name];
    if (actual !== expected) {
      drift.push(actual === undefined ? { name, expected } : { name, expected, actual });
    }
  }
  return drift;
}
