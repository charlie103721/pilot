import { useMemo } from 'react';
import type { ConversationGateState } from '../ipc/schemas.js';
import {
  buildDiagnosticsView,
  type CategoryTallyView,
  type DiagnosticsSampleView,
  type MetricSummaryView,
} from '../diagnostics/view-model.js';
import type { ConversationShell } from './use-conversation.js';

/**
 * Developer diagnostics: timings and counts, and nothing else.
 *
 * Every value on this surface arrives as a `TelemetrySample` — five numbers and
 * one closed-vocabulary category — and is rendered through the named fields of
 * `src/diagnostics/view-model.ts`. There is no `JSON.stringify` of an event
 * here, no `details` object, no message and no transcript: a panel that dumped
 * raw events would undo the care taken in every other lane, and system-design
 * §13 and §17 are explicit that metrics record timings and counts, not content.
 *
 * The panel says so on itself, too. A developer reading numbers deserves to
 * know what the numbers cannot contain.
 */

function Summary({ metric }: { metric: MetricSummaryView }) {
  const measured = metric.samples > 0;
  return (
    <tr
      className="diagnostics__row"
      data-testid={`metric-${metric.metric}`}
      data-measured={measured ? 'true' : 'false'}
    >
      <th scope="row" className="diagnostics__metric">
        <span className="diagnostics__metric-label">{metric.label}</span>
        <span className="diagnostics__metric-note">{metric.note}</span>
      </th>
      <td data-testid={`metric-samples-${metric.metric}`}>{metric.samples}</td>
      {/* An unmeasured metric shows an em dash, never `0 ms`: "not measured"
          and "measured as zero" are different facts. */}
      <td data-testid={`metric-last-${metric.metric}`}>{metric.last ?? '—'}</td>
      <td>{metric.min ?? '—'}</td>
      <td>{metric.max ?? '—'}</td>
      <td>{metric.mean ?? '—'}</td>
    </tr>
  );
}

function Tally({ tally }: { tally: CategoryTallyView }) {
  return (
    <li
      className="diagnostics__tally"
      data-testid={`tally-${tally.metric}-${tally.category}`}
      data-count={tally.count}
    >
      <span className="chip chip--category">{tally.category}</span>
      <span className="diagnostics__count">
        {tally.count} {tally.count === 1 ? 'time' : 'times'}
      </span>
    </li>
  );
}

function Sample({ sample }: { sample: DiagnosticsSampleView }) {
  return (
    <li
      className="diagnostics__sample"
      data-testid={`sample-${String(sample.seq)}`}
      data-metric={sample.metric}
      data-turn={sample.turn}
    >
      <span className="diagnostics__sample-turn">
        {sample.turn === 0 ? 'no turn' : `turn ${String(sample.turn)}`}
      </span>
      <span className="diagnostics__sample-metric">{sample.label}</span>
      <span className="diagnostics__sample-value">{sample.formatted}</span>
      {sample.category === null ? null : (
        <span className="chip chip--category" data-testid={`sample-category-${String(sample.seq)}`}>
          {sample.category}
        </span>
      )}
    </li>
  );
}

export function DiagnosticsPanel({
  gate,
  conversation,
}: {
  gate: ConversationGateState;
  conversation: ConversationShell;
}) {
  const view = useMemo(() => buildDiagnosticsView(gate), [gate]);

  return (
    <section
      className="diagnostics"
      aria-label="Developer diagnostics"
      data-testid="diagnostics"
      data-visible={view.visible ? 'true' : 'false'}
    >
      <div className="diagnostics__head">
        <button
          type="button"
          className="button button--quiet"
          data-testid="diagnostics-toggle"
          aria-expanded={view.visible}
          aria-controls="diagnostics-body"
          onClick={() => conversation.setDiagnosticsVisible(!view.visible)}
        >
          {view.visible ? 'Hide developer diagnostics' : 'Show developer diagnostics'}
        </button>
        <span className="diagnostics__counts" data-testid="diagnostics-counts">
          {view.recorded} recorded · {view.retained} kept · ring of {view.capacity}
        </span>
      </div>

      {view.visible ? (
        <div className="diagnostics__body" id="diagnostics-body">
          <p className="diagnostics__privacy" data-testid="diagnostics-privacy">
            {view.privacyNote}
          </p>

          {view.truncated ? (
            <p className="diagnostics__note" data-testid="diagnostics-truncated">
              The ring buffer has dropped {view.dropped} older samples. What follows is the most
              recent {view.retained}.
            </p>
          ) : null}

          {view.withheldNote === null ? null : (
            <p className="diagnostics__note" role="alert" data-testid="diagnostics-withheld">
              {view.withheldNote}
            </p>
          )}

          {view.emptyNote === null ? null : (
            <p className="diagnostics__note" data-testid="diagnostics-empty">
              {view.emptyNote}
            </p>
          )}

          <table className="diagnostics__table" data-testid="diagnostics-metrics">
            <caption>Questions measured: {view.turns}</caption>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Samples</th>
                <th scope="col">Last</th>
                <th scope="col">Min</th>
                <th scope="col">Max</th>
                <th scope="col">Mean</th>
              </tr>
            </thead>
            <tbody>
              {view.metrics.map((metric) => (
                <Summary key={metric.metric} metric={metric} />
              ))}
            </tbody>
          </table>

          <h3 className="diagnostics__headline">Aborts</h3>
          {view.aborts.length === 0 ? (
            <p className="diagnostics__note" data-testid="diagnostics-no-aborts">
              Nothing has been abandoned.
            </p>
          ) : (
            <ul className="diagnostics__tallies" data-testid="diagnostics-aborts">
              {view.aborts.map((tally) => (
                <Tally key={tally.category} tally={tally} />
              ))}
            </ul>
          )}

          <h3 className="diagnostics__headline">Failures</h3>
          {view.failures.length === 0 ? (
            <p className="diagnostics__note" data-testid="diagnostics-no-failures">
              Nothing has failed.
            </p>
          ) : (
            <ul className="diagnostics__tallies" data-testid="diagnostics-failures">
              {view.failures.map((tally) => (
                <Tally key={tally.category} tally={tally} />
              ))}
            </ul>
          )}

          <h3 className="diagnostics__headline">Most recent samples</h3>
          <ol className="diagnostics__samples" data-testid="diagnostics-samples">
            {view.recent.map((sample) => (
              <Sample key={sample.seq} sample={sample} />
            ))}
          </ol>

          <button
            type="button"
            className="button button--quiet"
            data-testid="diagnostics-clear"
            onClick={() => conversation.clearTelemetry()}
          >
            Clear telemetry
          </button>
        </div>
      ) : null}

      {conversation.transportError === null ? null : (
        <div
          className="banner banner--error"
          role="alert"
          data-testid="diagnostics-transport-error"
        >
          <p className="banner__message">{conversation.transportError.userMessage}</p>
        </div>
      )}
    </section>
  );
}
