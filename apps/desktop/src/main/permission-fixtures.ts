import type { PermissionSnapshot } from '@pilot/shared';
import {
  FIXTURE_PERMISSIONS_ACCESSIBILITY_DENIED,
  FIXTURE_PERMISSIONS_DENIED,
  FIXTURE_PERMISSIONS_GRANTED,
  FIXTURE_PERMISSIONS_MIXED,
  FIXTURE_PERMISSIONS_RESTRICTED,
  FIXTURE_PERMISSIONS_SCREEN_DENIED,
  FIXTURE_PERMISSIONS_UNKNOWN,
  type FakePermissionAdapter,
} from '@pilot/platform/fakes';
import { PERMISSION_FIXTURES, type PermissionFixtureName } from '../ipc/schemas.js';
import type { PermissionFixtureSource } from './permission-gate.js';

/**
 * The named permission states a reviewer can walk through at runtime.
 *
 * `docs/implementation.md` asks PR-008 to demo "unknown, denied, restricted and
 * granted"; system-design §16 additionally requires that Screen Recording
 * denied and Accessibility denied be *different* failures, so both have their
 * own fixture and the demo can show that they render differently.
 *
 * Keyed by fixture name so TypeScript fails the build if a name is added to the
 * wire schema without a snapshot behind it.
 */
export const PERMISSION_FIXTURE_SNAPSHOTS: Readonly<
  Record<PermissionFixtureName, PermissionSnapshot>
> = {
  unknown: FIXTURE_PERMISSIONS_UNKNOWN,
  granted: FIXTURE_PERMISSIONS_GRANTED,
  denied: FIXTURE_PERMISSIONS_DENIED,
  restricted: FIXTURE_PERMISSIONS_RESTRICTED,
  'screen-denied': FIXTURE_PERMISSIONS_SCREEN_DENIED,
  'accessibility-denied': FIXTURE_PERMISSIONS_ACCESSIBILITY_DENIED,
  mixed: FIXTURE_PERMISSIONS_MIXED,
};

/** The fixture a build starts in when nothing says otherwise. */
export const DEFAULT_PERMISSION_FIXTURE: PermissionFixtureName = 'unknown';

/**
 * Resolves the boot fixture from the environment, so a reviewer can start the
 * app in any of the four states without editing source:
 *
 *   PILOT_PERMISSION_FIXTURE=denied pnpm dev
 *
 * An unrecognised value falls back to the default rather than failing the
 * launch, and says so through the returned name.
 */
export function resolvePermissionFixture(value: string | undefined): PermissionFixtureName {
  const match = PERMISSION_FIXTURES.find((name) => name === value);
  return match ?? DEFAULT_PERMISSION_FIXTURE;
}

/**
 * Binds the fixture catalogue to a fake adapter. The gate holds this behind
 * {@link PermissionFixtureSource}, so nothing outside development builds can
 * reach a fixture.
 */
export function createPermissionFixtureSource(
  adapter: FakePermissionAdapter,
  initial: PermissionFixtureName = DEFAULT_PERMISSION_FIXTURE,
): PermissionFixtureSource {
  let current: PermissionFixtureName = initial;
  adapter.setSnapshot(PERMISSION_FIXTURE_SNAPSHOTS[initial]);

  return {
    apply(name: PermissionFixtureName): void {
      current = name;
      adapter.setSnapshot(PERMISSION_FIXTURE_SNAPSHOTS[name]);
    },
    current: () => current,
  };
}
