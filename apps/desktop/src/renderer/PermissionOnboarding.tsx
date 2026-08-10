import { PERMISSION_FIXTURES, type PermissionFixtureName } from '../ipc/schemas.js';
import type { PermissionOnboardingView, PermissionRowView } from '../permissions/view-model.js';
import type { PermissionsShell } from './use-permissions.js';

/**
 * Permission onboarding.
 *
 * The component renders decisions, it does not make them: every label,
 * severity and affordance below comes from `src/permissions/view-model.ts`.
 * What this file is responsible for is that each of the five row statuses is
 * visually and textually distinct — in particular that "checking" and "refused"
 * can never be confused — and that a control the platform cannot honour is
 * disabled *with* its explanation rather than simply present.
 */

const CONSEQUENCE_LABELS = {
  blocks: 'Required',
  degrades: 'Recommended',
  limits: 'Needed for voice',
} as const;

function relativeCheckedAt(checkedAt: number | null): string {
  return checkedAt === null
    ? 'not checked yet'
    : `last checked ${new Date(checkedAt).toLocaleTimeString()}`;
}

function RowAction({
  row,
  permissions,
}: {
  row: PermissionRowView;
  permissions: PermissionsShell;
}) {
  switch (row.action.kind) {
    case 'none':
      return null;
    case 'wait':
      return (
        <span className="permission__waiting" data-testid={`permission-waiting-${row.kind}`}>
          Waiting for macOS…
        </span>
      );
    case 'request':
      return (
        <button
          type="button"
          className="button button--primary"
          data-testid={`permission-request-${row.kind}`}
          onClick={() => permissions.request(row.kind)}
        >
          {row.action.label}
        </button>
      );
    case 'open-settings':
      return (
        <button
          type="button"
          className="button"
          data-testid={`permission-settings-${row.kind}`}
          disabled={!row.action.enabled}
          // A disabled button has no accessible explanation on its own; the
          // note rendered beside it carries the reason, and this ties them
          // together for assistive technology.
          aria-describedby={row.settingsNote === null ? undefined : `settings-note-${row.kind}`}
          onClick={() => permissions.openSettings(row.kind)}
        >
          {row.action.label}
        </button>
      );
  }
}

function PermissionRow({
  row,
  permissions,
}: {
  row: PermissionRowView;
  permissions: PermissionsShell;
}) {
  return (
    <li
      className={`permission permission--${row.status}`}
      data-testid={`permission-${row.kind}`}
      data-status={row.status}
      data-consequence={row.consequence}
    >
      <div className="permission__head">
        <span className="permission__title">{row.title}</span>
        <span
          className={`chip chip--${row.consequence}`}
          data-testid={`permission-need-${row.kind}`}
        >
          {CONSEQUENCE_LABELS[row.consequence]}
        </span>
        <span
          className={`chip chip--status chip--${row.status}`}
          data-testid={`permission-status-${row.kind}`}
          aria-live={row.status === 'checking' ? 'polite' : 'off'}
        >
          {row.statusLabel}
        </span>
      </div>

      <p className="permission__why" data-testid={`permission-why-${row.kind}`}>
        {row.why}
      </p>
      <p className="permission__bound">{row.bound}</p>

      {row.impact === '' ? null : (
        <p className="permission__impact" data-testid={`permission-impact-${row.kind}`}>
          {row.impact}
        </p>
      )}

      <div className="permission__actions">
        <RowAction row={row} permissions={permissions} />
      </div>

      {row.settingsNote === null ? null : (
        <p
          className="permission__note"
          id={`settings-note-${row.kind}`}
          data-testid={`permission-settings-note-${row.kind}`}
        >
          {row.settingsNote}
        </p>
      )}
    </li>
  );
}

function FixtureBar({
  current,
  onApply,
}: {
  current: PermissionFixtureName | null;
  onApply: (name: PermissionFixtureName) => void;
}) {
  return (
    <div className="scenarios" aria-label="Fake permission states">
      <span className="scenarios__label">Fake permissions</span>
      {PERMISSION_FIXTURES.map((name) => (
        <button
          key={name}
          type="button"
          className={`button button--quiet${name === current ? ' button--active' : ''}`}
          data-testid={`permission-fixture-${name}`}
          aria-pressed={name === current}
          onClick={() => onApply(name)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

export function PermissionOnboarding({ permissions }: { permissions: PermissionsShell }) {
  const view: PermissionOnboardingView = permissions.view;

  return (
    <section
      className={`onboarding onboarding--${view.readiness}`}
      aria-label="Permissions"
      data-testid="permission-onboarding"
      data-readiness={view.readiness}
    >
      <header className="onboarding__head">
        <h2 className="onboarding__headline" data-testid="permission-headline">
          {view.headline}
        </h2>
        <p className="onboarding__summary" data-testid="permission-summary">
          {view.summary}
        </p>
        <div className="onboarding__meta">
          <span data-testid="permission-checked-at">{relativeCheckedAt(view.checkedAt)}</span>
          <button
            type="button"
            className="button button--quiet"
            data-testid="permission-recheck"
            onClick={() => permissions.refresh()}
          >
            Check again
          </button>
        </div>
      </header>

      {view.groundingDisclosure === null ? null : (
        <p className="banner banner--degraded" role="status" data-testid="grounding-disclosure">
          {view.groundingDisclosure}
        </p>
      )}

      {view.settings.available ? null : (
        <p className="onboarding__note" data-testid="settings-unavailable">
          {view.settings.reason} Every permission below lists the pane to open by hand.
        </p>
      )}

      {view.lastError === null ? null : (
        <div className="banner banner--error" role="alert" data-testid="permission-error">
          <p className="banner__message">{view.lastError.userMessage}</p>
          <dl className="banner__meta">
            <dt>Code</dt>
            <dd data-testid="permission-error-code">{view.lastError.code}</dd>
          </dl>
          <button
            type="button"
            className="button button--quiet"
            data-testid="permission-error-dismiss"
            onClick={() => permissions.dismissError()}
          >
            Dismiss
          </button>
        </div>
      )}

      {permissions.transportError === null ? null : (
        <div className="banner banner--error" role="alert" data-testid="permission-transport-error">
          <p className="banner__message">{permissions.transportError.userMessage}</p>
        </div>
      )}

      <ol className="permissions" data-testid="permission-rows">
        {view.rows.map((row) => (
          <PermissionRow key={row.kind} row={row} permissions={permissions} />
        ))}
      </ol>

      {view.fixture === null ? null : (
        <FixtureBar current={view.fixture} onApply={(name) => permissions.applyFixture(name)} />
      )}
    </section>
  );
}
