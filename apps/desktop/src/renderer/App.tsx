import { useState } from 'react';
import type { InteractionState, SerializedPilotError } from '@pilot/shared';
import type { PilotViewState } from '@pilot/platform';
import { VIEW_SCENARIOS, type ViewScenario } from '../ipc/schemas.js';
import { permissionsAllowObservation } from '../permissions/view-model.js';
import { PermissionOnboarding } from './PermissionOnboarding.js';
import { usePermissions } from './use-permissions.js';
import { usePilotShell } from './use-pilot-shell.js';

/**
 * The floating panel.
 *
 * Every interaction state named in mvp-01 §7 has a visible rendering, including
 * the two that are easy to leave as blank screens: `error`, and the case where
 * the panel cannot reach the main process at all. PR-009 and PR-010 replace the
 * body of this panel with window selection and conversation views; the state
 * plumbing and the failure surfaces stay.
 *
 * Permission onboarding (PR-008) sits above all of it: while a permission that
 * blocks Pilot is missing, the conversation controls are replaced by the
 * onboarding view and an explicit reason, because offering a "hold to talk"
 * button that cannot work is the silent failure the delivery rules forbid.
 */

const STATE_LABELS: Readonly<Record<InteractionState, string>> = {
  idle: 'Idle',
  'needs-permission': 'Needs permission',
  paused: 'Paused',
  observing: 'Observing',
  listening: 'Listening',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  'observing-screen': 'Looking at the screen',
  speaking: 'Speaking',
  error: 'Error',
};

const STATE_DESCRIPTIONS: Readonly<Record<InteractionState, string>> = {
  idle: 'Pick a window, then hold the push-to-talk key to ask about it.',
  'needs-permission': 'Pilot needs screen and microphone access before it can help.',
  paused: 'Observation is paused. Nothing is being captured.',
  observing: 'Watching the selected window. Ask a question at any time.',
  listening: 'Listening — release the key when you have finished speaking.',
  transcribing: 'Turning what you said into text.',
  thinking: 'Working out an answer.',
  'observing-screen': 'Taking a fresh look at the selected window.',
  speaking: 'Answering aloud.',
  error: 'Something went wrong. The details are below.',
};

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
  return (
    <header className="header">
      <div className={`pill pill--${view.state}`} data-testid="state-pill">
        {STATE_LABELS[view.state]}
      </div>
      <p className="header__description" data-testid="state-description">
        {STATE_DESCRIPTIONS[view.state]}
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

function Transcript({ view }: { view: PilotViewState }) {
  return (
    <section className="transcript" aria-label="Conversation">
      {view.transcript.length === 0 && view.liveTranscript === null ? (
        <p className="transcript__empty" data-testid="transcript-empty">
          Nothing said yet.
        </p>
      ) : null}
      <ol className="transcript__list">
        {view.transcript.map((entry) => (
          <li key={entry.utteranceId} className={`turn turn--${entry.role}`}>
            <span className="turn__role">{entry.role === 'user' ? 'You' : 'Pilot'}</span>
            <span className="turn__text">{entry.text}</span>
            {entry.pending ? <span className="turn__pending">…</span> : null}
          </li>
        ))}
      </ol>
      {view.liveTranscript === null ? null : (
        <p className="transcript__live" data-testid="live-transcript">
          {view.liveTranscript}
        </p>
      )}
    </section>
  );
}

function Controls({
  view,
  onCommand,
}: {
  view: PilotViewState;
  onCommand: ReturnType<typeof usePilotShell>['dispatch'];
}) {
  const [text, setText] = useState('');
  const paused = view.state === 'paused';

  return (
    <section className="controls" aria-label="Controls">
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = text.trim();
          if (trimmed.length === 0) {
            return;
          }
          onCommand({ type: 'submit-text', text: trimmed });
          setText('');
        }}
      >
        <label className="composer__label" htmlFor="question">
          Ask about the selected window
        </label>
        <input
          id="question"
          className="composer__input"
          value={text}
          placeholder="What does this toggle do?"
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="button button--primary">
          Send
        </button>
      </form>

      <div className="button-row">
        <button
          type="button"
          className="button"
          onMouseDown={() => onCommand({ type: 'push-to-talk-down' })}
          onMouseUp={() => onCommand({ type: 'push-to-talk-up' })}
        >
          Hold to talk
        </button>
        <button type="button" className="button" onClick={() => onCommand({ type: 'look-now' })}>
          Look now
        </button>
        <button type="button" className="button" onClick={() => onCommand({ type: 'interrupt' })}>
          Interrupt
        </button>
        <button
          type="button"
          className="button"
          onClick={() => onCommand({ type: paused ? 'resume' : 'pause' })}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          className="button button--quiet"
          onClick={() => onCommand({ type: 'clear-conversation' })}
        >
          Clear
        </button>
      </div>
    </section>
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
  const [dismissedCommandError, setDismissedCommandError] = useState(false);

  if (shell.status.kind === 'unavailable') {
    return (
      <main className="panel panel--unavailable" data-testid="panel-unavailable">
        <h1 className="panel__title">Pilot is not available</h1>
        <ErrorBanner error={shell.status.error} title="Cannot reach the Pilot application" />
      </main>
    );
  }

  if (shell.status.kind === 'connecting' || shell.view === null) {
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

      {canConverse ? (
        <>
          <Transcript view={view} />
          <Controls
            view={view}
            onCommand={(command) => {
              setDismissedCommandError(false);
              shell.dispatch(command);
            }}
          />
        </>
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
