import { PilotError, type PermissionKind } from '@pilot/shared';
import type { PermissionAdapter } from '@pilot/platform';
import { permissionCopy } from '../permissions/catalog.js';
import type { PermissionSettingsAvailability } from '../ipc/schemas.js';

/**
 * The "open System Settings" affordance system-design §16 asks for, behind a
 * platform seam.
 *
 * There is no System Settings on the machine this repository is developed on,
 * and runbook §5 amendment 8 defers all Mac verification, so the unavailable
 * case is not a corner: it is the case every local run takes. It is therefore
 * modelled explicitly — an availability the panel can read *before* drawing a
 * button, plus a typed refusal if something asks anyway — rather than left as a
 * control that silently does nothing.
 */

export interface PermissionSettingsShortcut {
  availability(): PermissionSettingsAvailability;
  /** Opens the pane for one permission. Rejects when unavailable. */
  open(kind: PermissionKind): Promise<void>;
}

export interface SettingsShortcutOptions {
  /** `process.platform` of the host running the main process. */
  readonly platform: string;
  readonly adapter: PermissionAdapter;
}

/** The only platform whose settings panes Pilot knows how to address. */
const SUPPORTED_PLATFORM = 'darwin';

export function unavailableReason(platform: string): string {
  return (
    'Pilot can only open a permissions pane on macOS, and this copy of Pilot is running on ' +
    `${platform}.`
  );
}

export function createSettingsShortcut(
  options: SettingsShortcutOptions,
): PermissionSettingsShortcut {
  const available = options.platform === SUPPORTED_PLATFORM;
  const availability: PermissionSettingsAvailability = {
    available,
    platform: options.platform,
    reason: available ? null : unavailableReason(options.platform),
  };

  return {
    availability: () => availability,
    async open(kind: PermissionKind): Promise<void> {
      if (!available) {
        const copy = permissionCopy(kind);
        throw new PilotError(
          'unsupported-capability',
          `System Settings shortcut is unavailable on ${options.platform}`,
          {
            userMessage:
              `${availability.reason ?? ''} Open ${copy.settingsPane} yourself on the Mac you want to use Pilot on.`.trim(),
            details: { kind, platform: options.platform },
          },
        );
      }
      await options.adapter.openSettings(kind);
    },
  };
}
