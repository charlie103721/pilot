import { useMemo, useState } from 'react';
import type { SerializedPilotError } from '@pilot/shared';
import type { PilotViewState } from '@pilot/platform';
import { VIEW_SCENARIOS, type ViewScenario } from '../ipc/schemas.js';
import {
  buildConversationView,
  INTERACTION_STATE_PRESENTATION,
} from '../conversation/view-model.js';
import { buildObservationView } from '../observation/view-model.js';
import { permissionsAllowObservation } from '../permissions/view-model.js';
import { ConversationPanel } from './ConversationPanel.js';
import { ObservationControls } from './ObservationControls.js';
import { PermissionOnboarding } from './PermissionOnboarding.js';
import { useConversation } from './use-conversation.js';
import { usePermissions } from './use-permissions.js';
import { usePilotShell } from './use-pilot-shell.js';
import { useWindows } from './use-windows.js';

/**
 * The floating panel.
 *
 * Every interaction state named in mvp-01 §7 has a visible rendering, including
 * the two that are easy to leave as blank screens: `error`, and the case where
 * the panel cannot reach the main process at all. The words for each state live
 * in `src/conversation/view-model.ts` (PR-010) so the header and the
 * conversation cannot describe the same state differently.
 *
 * Permission onboarding (PR-008) sits above all of it: while a permission that
 * blocks Pilot is missing, the conversation controls are replaced by the
 * onboarding view and an explicit reason, because offering a "hold to talk"
 * button that cannot work is the silent failure the delivery rules forbid.
 *
 * The window picker and the observation controls (PR-009) sit between the two,
 * and unlike the conversation they are rendered in *every* state including
 * blocked — because the one thing that must never disappear is the statement of
 * whether Pilot is capturing the screen.
 */

function ErrorBanner({
  error,
  title,
  onDismiss,
}: {
  error: SerializedPilotError;
  title: string;
  onDismiss?: () => void;
}) {
  return (
    <div className="banner banner--error" role="alert" data-testid="error-banner">
      <div className="banner__title">{title}</div>
      <p className="banner__message">{error.userMessage}</p>
      <dl className="banner__meta">
        <dt>Code</dt>
        <dd data-testid="error-code">{error.code}</dd>
        <dt>Retryable</dt>
        <dd>{error.retryable ? 'yes' : 'no'}</dd>
      </dl>
      {onDismiss === undefined ? null : (
        <button type="button" className="button button--quiet" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}

function StateHeader({ view }: { view: PilotViewState }) {
  const presentation = INTERACTION_STATE_PRESENTATION[view.state];
  return (
    <header className="header">
      <div
        className={`pill pill--${view.state}`}
        data-testid="state-pill"
        data-tone={presentation.tone}
        data-activity={presentation.activity}
      >
        {presentation.label}
      </div>
      <p className="header__description" data-testid="state-description">
        {presentation.detail}
      </p>
      <dl className="facts">
        <dt>Window</dt>
        <dd data-testid="selected-window">
          {view.selectedWindow === null
            ? 'None selected'
            : `${view.selectedWindow.applicationName} — ${view.selectedWindow.title}`}
        </dd>
        <dt>Observation</dt>
        <dd data-testid="observation-state">{view.observationEnabled ? 'On' : 'Off'}</dd>
        <dt>Speech</dt>
        <dd data-testid="speaking-state">{view.speaking ? 'Speaking' : 'Silent'}</dd>
      </dl>
    </header>
  );
}

function ScenarioBar({ onApply }: { onApply: (scenario: ViewScenario) => void }) {
  return (
    <footer className="scenarios" aria-label="Fake states">
      <span className="scenarios__label">Fake state</span>
      {VIEW_SCENARIOS.map((scenario) => (
        <button
          key={scenario}
          type="button"
          className="button button--quiet"
          data-testid={`scenario-${scenario}`}
          onClick={() => onApply(scenario)}
        >
          {scenario}
        </button>
      ))}
    </footer>
  );
}

export function App() {
  const shell = usePilotShell();
  const permissions = usePermissions();
  const windows = useWindows();
  const conversation = useConversation();
  const [dismissedCommandError, setDismissedCommandError] = useState(false);
  const observation = useMemo(
    () =>
      shell.view === null
        ? null
        : buildObservationView({
            gate: windows.gate,
            view: shell.view,
            permissions: permissions.view,
          }),
    [windows.gate, shell.view, permissions.view],
  );
  // `capturing` is read from the observation view and never re-derived, so the
  // conversation and the indicator cannot disagree about the one privacy fact.
  const conversationView = useMemo(
    () =>
      shell.view === null || observation === null
        ? null
        : buildConversationView({
            view: shell.view,
            gate: conversation.gate,
            observation,
          }),
    [shell.view, conversation.gate, observation],
  );

  if (shell.status.kind === 'unavailable') {
    return (
      <main className="panel panel--unavailable" data-testid="panel-unavailable">
        <h1 className="panel__title">Pilot is not available</h1>
        <ErrorBanner error={shell.status.error} title="Cannot reach the Pilot application" />
      </main>
    );
  }

  if (
    shell.status.kind === 'connecting' ||
    shell.view === null ||
    observation === null ||
    conversationView === null
  ) {
    return (
      <main className="panel panel--connecting" data-testid="panel-connecting">
        <h1 className="panel__title">Pilot</h1>
        <p className="panel__note">Connecting…</p>
      </main>
    );
  }

  const view = shell.view;
  const canConverse = permissionsAllowObservation(permissions.view);

  return (
    <main className="panel" data-testid="panel">
      <StateHeader view={view} />

      {view.lastError === null ? null : (
        <ErrorBanner error={view.lastError} title="Pilot hit a problem" />
      )}

      {shell.commandError === null || dismissedCommandError ? null : (
        <ErrorBanner
          error={shell.commandError}
          title="That action was rejected"
          onDismiss={() => setDismissedCommandError(true)}
        />
      )}

      <PermissionOnboarding permissions={permissions} />

      {/* Always rendered, including while blocked: the indicator has to say
          that Pilot is capturing nothing, and why, rather than disappear. */}
      <ObservationControls view={observation} windows={windows} />

      {canConverse ? (
        <ConversationPanel
          view={conversationView}
          conversation={conversation}
          onCommand={(command) => {
            setDismissedCommandError(false);
            shell.dispatch(command);
          }}
        />
      ) : (
        <p className="panel__note" data-testid="controls-withheld">
          {permissions.view.readiness === 'checking'
            ? 'Checking permissions before Pilot offers to look at a window.'
            : 'Asking Pilot about a window is unavailable until Screen Recording is allowed.'}
        </p>
      )}

      <ScenarioBar
        onApply={(scenario) => {
          setDismissedCommandError(false);
          shell.applyScenario(scenario);
        }}
      />
    </main>
  );
}
