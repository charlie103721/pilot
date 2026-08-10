import { useRef } from 'react';
import { WINDOW_DEMO_EVENTS, type WindowDemoEvent } from '../ipc/schemas.js';
import {
  observationControl,
  type ObservationControlId,
  type ObservationView,
  type SelectedWindowSummary,
  type WindowRowView,
} from '../observation/view-model.js';
import type { WindowsShell } from './use-windows.js';

/**
 * Window picker, selected-window summary, and the observation controls.
 *
 * The component renders decisions, it does not make them: the indicator, every
 * control's availability and every refusal message come from
 * `src/observation/view-model.ts`. What this file is responsible for is that
 * the six indicator states are told apart *without reading* — a different
 * class, a different label and a `data-capturing` flag that is true in exactly
 * one of them — and that no control is ever disabled without its reason being
 * on screen next to it.
 */

const DEMO_LABELS: Readonly<Record<WindowDemoEvent, string>> = {
  'close-selected': 'close selected window',
  'retitle-selected': 'retitle selected window',
  'hide-selected': 'minimise selected window',
  'restore-windows': 'restore all windows',
};

function Indicator({ view }: { view: ObservationView }) {
  return (
    <div
      className={`observation__indicator observation__indicator--${view.tone}`}
      data-testid="observation-indicator"
      data-indicator={view.indicator}
      data-capturing={view.capturing ? 'true' : 'false'}
      role="status"
      aria-live="polite"
    >
      <span className="observation__dot" aria-hidden="true" />
      <span className="observation__label" data-testid="observation-indicator-label">
        {view.indicatorLabel}
      </span>
      <span className="observation__capture" data-testid="observation-capture-state">
        {view.capturing ? 'capturing now' : 'not capturing'}
      </span>
    </div>
  );
}

function Summary({ summary }: { summary: SelectedWindowSummary }) {
  return (
    <dl className="facts" data-testid="observation-summary">
      <dt>Window</dt>
      <dd data-testid="observation-summary-title">{summary.title}</dd>
      <dt>Application</dt>
      <dd data-testid="observation-summary-app">
        {summary.applicationName} ({summary.bundleLabel})
      </dd>
      <dt>Display</dt>
      <dd data-testid="observation-summary-display">
        {summary.displayLabel} · {summary.scaleLabel}
      </dd>
      <dt>Size</dt>
      <dd data-testid="observation-summary-size">{summary.sizeLabel}</dd>
    </dl>
  );
}

function Control({
  id,
  view,
  onActivate,
}: {
  id: ObservationControlId;
  view: ObservationView;
  onActivate: () => void;
}) {
  const control = observationControl(view, id);
  const reasonId = `observation-reason-${id}`;
  return (
    <span className="observation__control">
      <button
        type="button"
        className={`button${control.primary ? ' button--primary' : ''}`}
        data-testid={`observation-${id}`}
        data-available={control.available ? 'true' : 'false'}
        disabled={!control.available}
        // A disabled button carries no explanation of its own; the note beside
        // it does, and this ties the two together for assistive technology.
        aria-describedby={control.unavailableReason === null ? undefined : reasonId}
        onClick={onActivate}
      >
        {control.label}
      </button>
      {control.unavailableReason === null ? null : (
        <span className="observation__reason" id={reasonId} data-testid={`observation-why-${id}`}>
          {control.unavailableReason}
        </span>
      )}
    </span>
  );
}

function WindowRow({ row, onSelect }: { row: WindowRowView; onSelect: () => void }) {
  const reasonId = `window-reason-${row.windowId}`;
  return (
    <li
      className={`window${row.selected ? ' window--selected' : ''}`}
      data-testid={`window-${row.windowId}`}
      data-selected={row.selected ? 'true' : 'false'}
      data-on-screen={row.onScreen ? 'true' : 'false'}
    >
      <div className="window__head">
        <span className="window__title" data-testid={`window-title-${row.windowId}`}>
          {row.title}
        </span>
        <span className="window__app">{row.applicationName}</span>
        {row.selected ? (
          <span className="chip chip--selected" data-testid={`window-badge-${row.windowId}`}>
            Selected
          </span>
        ) : null}
        {row.onScreen ? null : (
          <span className="chip chip--offscreen" data-testid={`window-offscreen-${row.windowId}`}>
            Hidden
          </span>
        )}
      </div>
      <p className="window__meta">
        {row.displayId} · {row.sizeLabel}
      </p>
      <div className="window__actions">
        <button
          type="button"
          className="button"
          data-testid={`window-select-${row.windowId}`}
          disabled={!row.selectable}
          aria-describedby={row.unavailableReason === null ? undefined : reasonId}
          onClick={onSelect}
        >
          {row.actionLabel}
        </button>
        {row.unavailableReason === null ? null : (
          <span
            className="observation__reason"
            id={reasonId}
            data-testid={`window-why-${row.windowId}`}
          >
            {row.unavailableReason}
          </span>
        )}
      </div>
    </li>
  );
}

export function ObservationControls({
  view,
  windows,
}: {
  view: ObservationView;
  windows: WindowsShell;
}) {
  const listRef = useRef<HTMLOListElement>(null);

  return (
    <section
      className={`observation observation--${view.indicator}`}
      aria-label="Observation"
      data-testid="observation"
      data-indicator={view.indicator}
      data-capturing={view.capturing ? 'true' : 'false'}
    >
      <header className="observation__head">
        <Indicator view={view} />
        <p className="observation__detail" data-testid="observation-detail">
          {view.indicatorDetail}
        </p>
      </header>

      {view.notice === null ? null : (
        <div
          className="banner banner--degraded"
          role="alert"
          data-testid="observation-notice"
          data-reason={view.notice.reason}
        >
          <div className="banner__title" data-testid="observation-notice-headline">
            {view.notice.headline}
          </div>
          <p className="banner__message" data-testid="observation-notice-message">
            {view.notice.message}
          </p>
          <button
            type="button"
            className="button button--quiet"
            data-testid="observation-notice-dismiss"
            onClick={() => windows.dismissNotice()}
          >
            Dismiss
          </button>
        </div>
      )}

      {view.lastError === null ? null : (
        <div className="banner banner--error" role="alert" data-testid="observation-error">
          <p className="banner__message">{view.lastError.userMessage}</p>
          <dl className="banner__meta">
            <dt>Code</dt>
            <dd data-testid="observation-error-code">{view.lastError.code}</dd>
          </dl>
        </div>
      )}

      {windows.transportError === null ? null : (
        <div
          className="banner banner--error"
          role="alert"
          data-testid="observation-transport-error"
        >
          <p className="banner__message">{windows.transportError.userMessage}</p>
        </div>
      )}

      {view.selection === null ? (
        <p className="observation__empty" data-testid="observation-no-selection">
          Pilot is not set to watch any window.
        </p>
      ) : (
        <>
          <Summary summary={view.selection} />
          {view.selection.warning === null ? null : (
            <p className="observation__warning" data-testid="observation-summary-warning">
              {view.selection.warning}
            </p>
          )}
        </>
      )}

      <div className="button-row" data-testid="observation-controls">
        <Control id="start" view={view} onActivate={() => windows.start()} />
        <Control id="stop" view={view} onActivate={() => windows.stop()} />
        <Control id="pause" view={view} onActivate={() => windows.pause()} />
        <Control id="resume" view={view} onActivate={() => windows.resume()} />
        <Control
          id="change"
          view={view}
          // The only control with no main-process action: it takes the user
          // back to the list, where switching windows is one click.
          onActivate={() => listRef.current?.focus()}
        />
      </div>

      <div className="observation__list-head">
        <h2 className="observation__headline">Windows Pilot can watch</h2>
        <button
          type="button"
          className="button button--quiet"
          data-testid="window-refresh"
          onClick={() => windows.refresh()}
        >
          Refresh list
        </button>
      </div>

      {view.listNote === null ? null : (
        <p
          className="observation__empty"
          data-testid="window-list-note"
          data-status={view.listStatus}
        >
          {view.listNote}
        </p>
      )}

      <ol className="windows" data-testid="window-list" ref={listRef} tabIndex={-1}>
        {view.rows.map((row) => (
          <WindowRow key={row.windowId} row={row} onSelect={() => windows.select(row.windowId)} />
        ))}
      </ol>

      {view.grounding === 'reduced' && view.groundingNote !== null ? (
        <p className="observation__warning" data-testid="observation-grounding">
          {view.groundingNote}
        </p>
      ) : null}

      {windows.gate.demoEvents ? (
        <div className="scenarios" aria-label="Fake window events" data-testid="window-demo-bar">
          <span className="scenarios__label">Fake window events</span>
          {WINDOW_DEMO_EVENTS.map((event) => (
            <button
              key={event}
              type="button"
              className="button button--quiet"
              data-testid={`window-demo-${event}`}
              onClick={() => windows.applyDemoEvent(event)}
            >
              {DEMO_LABELS[event]}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
