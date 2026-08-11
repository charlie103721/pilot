import { useState } from 'react';
import type { InteractionCommand } from '@pilot/platform';
import {
  CONVERSATION_FIXTURES,
  type ConversationFixtureName,
  type ModelDataDisclosureView,
  type ModelStatusView,
} from '../ipc/schemas.js';
import {
  conversationControl,
  type ConversationControlId,
  type ConversationTurnView,
  type ConversationView,
  type StreamedResponseView,
  type VoiceDisclosureView,
} from '../conversation/view-model.js';
import { DiagnosticsPanel } from './DiagnosticsPanel.js';
import type { ConversationShell } from './use-conversation.js';

/**
 * Transcript, streamed response, text input, and the interaction state.
 *
 * The component renders decisions, it does not make them: every label, every
 * availability and every refusal message comes from
 * `src/conversation/view-model.ts`. What this file is responsible for is that
 * the states are told apart *without reading* — a different class, a different
 * `data-tone` and a different `data-activity` — and that the text box is never
 * removed from the page in a state the machine would accept a question in.
 */

const FIXTURE_LABELS: Readonly<Record<ConversationFixtureName, string>> = {
  'spoken-question': 'spoken question',
  'typed-question': 'typed question',
  'interrupted-answer': 'interrupt mid-answer',
  'stt-failure': 'speech recognition fails',
  reset: 'reset',
};

function StateBadge({ view }: { view: ConversationView }) {
  return (
    <div
      className={`conversation__state conversation__state--${view.tone}`}
      data-testid="conversation-state"
      data-state={view.state}
      data-tone={view.tone}
      data-activity={view.activity}
      data-busy={view.busy ? 'true' : 'false'}
      role="status"
      aria-live="polite"
    >
      <span className="conversation__pulse" aria-hidden="true" />
      <span className="conversation__state-label" data-testid="conversation-state-label">
        {view.stateLabel}
      </span>
      <p className="conversation__state-detail" data-testid="conversation-state-detail">
        {view.stateDetail}
      </p>
    </div>
  );
}

function Turn({ turn }: { turn: ConversationTurnView }) {
  return (
    <li
      className={`turn turn--${turn.role} turn--${turn.status}`}
      data-testid={`turn-${turn.utteranceId}`}
      data-role={turn.role}
      data-status={turn.status}
    >
      <span className="turn__role">{turn.speaker}</span>
      <span className="turn__text" data-testid={`turn-text-${turn.utteranceId}`}>
        {turn.text}
      </span>
      {turn.status === 'streaming' ? (
        <span className="turn__badge turn__badge--streaming" data-testid="turn-streaming">
          still arriving
        </span>
      ) : null}
      {turn.status === 'interrupted' ? (
        <span className="turn__badge turn__badge--interrupted" data-testid="turn-interrupted">
          interrupted
        </span>
      ) : null}
    </li>
  );
}

/**
 * The streamed answer, announced separately from the transcript.
 *
 * `aria-live="polite"` on the transcript list would re-announce every chunk of
 * a growing answer. Announcing the stream once, here, is what makes a streamed
 * response usable rather than a stutter.
 */
function Stream({ stream }: { stream: StreamedResponseView }) {
  return (
    <p
      className="conversation__stream"
      data-testid="conversation-stream"
      data-streaming={stream.streaming ? 'true' : 'false'}
      data-interrupted={stream.interrupted ? 'true' : 'false'}
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="conversation__stream-text">{stream.text}</span>
      <span className="conversation__stream-meta" data-testid="conversation-stream-meta">
        {stream.streaming
          ? `${String(stream.characters)} characters so far`
          : `stopped after ${String(stream.characters)} characters`}
      </span>
    </p>
  );
}

function Disclosure({ disclosure }: { disclosure: VoiceDisclosureView }) {
  return (
    <div
      className={`banner ${disclosure.needsAttention ? 'banner--degraded' : 'banner--quiet'}`}
      data-testid="speech-disclosure"
      data-needs-attention={disclosure.needsAttention ? 'true' : 'false'}
      data-leaves-device={disclosure.leavesDevice ? 'true' : 'false'}
      role={disclosure.needsAttention ? 'alert' : 'note'}
    >
      <div className="banner__title">{disclosure.headline}</div>
      <p className="banner__message">{disclosure.detail}</p>
      <dl className="banner__meta">
        <dt>Recognised</dt>
        <dd data-testid="speech-disclosure-destination">{disclosure.destination}</dd>
        {disclosure.service === null ? null : (
          <>
            <dt>Service</dt>
            <dd data-testid="speech-disclosure-service">{disclosure.service}</dd>
          </>
        )}
        {disclosure.locale === null ? null : (
          <>
            <dt>Language</dt>
            <dd>{disclosure.locale}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/**
 * Where the configured model sends screen images (PR-038, system-design §14).
 *
 * Rendered above the transcript and above the voice disclosure, because it
 * answers the earlier question: audio disclosure is about the microphone, this
 * is about the screen, and the screen is what Pilot is for. Every string comes
 * from `describeModelDataDisclosure` in the main process; nothing is worded
 * here, so the panel, the startup log and `pnpm demo:apikey` cannot drift.
 */
function ModelDisclosure({ disclosure }: { disclosure: ModelDataDisclosureView }) {
  return (
    <div
      className={`banner ${disclosure.needsAttention ? 'banner--degraded' : 'banner--quiet'}`}
      data-testid="model-disclosure"
      data-remote={disclosure.sendsScreenOffDevice ? 'true' : 'false'}
      data-verification={disclosure.verification}
      role={disclosure.needsAttention ? 'alert' : 'note'}
    >
      <div className="banner__title">{disclosure.headline}</div>
      <p className="banner__message">{disclosure.detail}</p>
      <dl className="banner__meta">
        <dt>Screen images</dt>
        <dd data-testid="model-disclosure-destination">
          {disclosure.sendsScreenOffDevice
            ? `sent to ${disclosure.destination}`
            : `stay on this Mac (${disclosure.destination})`}
        </dd>
        <dt>Model checked</dt>
        <dd data-testid="model-disclosure-verification">{disclosure.verification}</dd>
        {disclosure.credentialSummary === null ? null : (
          <>
            <dt>Credential</dt>
            <dd data-testid="model-disclosure-credential">{disclosure.credentialSummary}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/**
 * Which model Pilot is talking to (runbook follow-ups 46 and 33).
 *
 * Rendered **always** and **first**, above the error banner and above both
 * disclosures, because it is the only thing on this panel that is true before
 * the user does anything: which provider is in force, and whether their screen
 * leaves the machine to reach it (system-design §14, "before observation
 * begins").
 *
 * The `critical` branch is the whole point. A packaged Pilot that has never
 * been given a `pilot.env` answers questions with Pi's faux provider, which is
 * not a language model, and said so only in a stderr line a Finder launch
 * discards. It is a `role="alert"` with its own class and its own heading, not
 * a subtle badge — a user who does not read the small print of an answer must
 * still be unable to miss it.
 *
 * Every string comes from `describeModelStatus` in the main process; nothing is
 * worded here, and nothing here can hold a credential.
 */
function ModelStatus({ status }: { status: ModelStatusView }) {
  const critical = status.severity === 'critical';
  return (
    <section
      className={`banner model-status model-status--${status.severity}`}
      data-testid="model-status"
      data-profile={status.profile}
      data-real-model={status.realModel ? 'true' : 'false'}
      data-remote={status.sendsScreenOffDevice ? 'true' : 'false'}
      data-severity={status.severity}
      role={critical ? 'alert' : 'note'}
      aria-label="Model"
    >
      <div className="banner__title" data-testid="model-status-headline">
        {status.headline}
      </div>
      <p className="banner__message" data-testid="model-status-detail">
        {status.detail}
      </p>
      <dl className="banner__meta">
        <dt>Model</dt>
        <dd data-testid="model-status-model">
          {status.profileLabel} · {status.modelLabel}
        </dd>
        <dt>Screen images</dt>
        <dd data-testid="model-status-locality">{status.localityLabel}</dd>
      </dl>
      {status.remedy === null ? null : (
        <p className="banner__hint" data-testid="model-status-remedy">
          {status.remedy}
        </p>
      )}
    </section>
  );
}

function Control({
  id,
  view,
  onActivate,
  onRelease,
}: {
  id: ConversationControlId;
  view: ConversationView;
  onActivate: () => void;
  onRelease?: () => void;
}) {
  const control = conversationControl(view, id);
  const reasonId = `conversation-reason-${id}`;
  return (
    <span className="conversation__control">
      <button
        type="button"
        className="button"
        data-testid={`conversation-${id}`}
        data-available={control.available ? 'true' : 'false'}
        disabled={!control.available}
        aria-describedby={control.unavailableReason === null ? undefined : reasonId}
        onMouseDown={onRelease === undefined ? undefined : onActivate}
        onMouseUp={onRelease}
        onClick={onRelease === undefined ? onActivate : undefined}
      >
        {control.label}
      </button>
      {control.unavailableReason === null ? null : (
        <span className="conversation__reason" id={reasonId} data-testid={`conversation-why-${id}`}>
          {control.unavailableReason}
        </span>
      )}
    </span>
  );
}

function Composer({
  view,
  onSubmit,
}: {
  view: ConversationView;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const composer = view.composer;

  return (
    <form
      className="composer"
      data-testid="composer"
      data-available={composer.available ? 'true' : 'false'}
      data-only-way={composer.onlyWayToAsk ? 'true' : 'false'}
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = text.trim();
        if (trimmed.length === 0 || !composer.available) {
          return;
        }
        onSubmit(trimmed);
        setText('');
      }}
    >
      <label className="composer__label" htmlFor="question">
        {composer.label}
      </label>
      {/* Never removed from the page: `error` is a state the machine accepts a
          typed question in (system-design §16), and a text box that disappears
          when it is most needed is the failure runbook follow-up 4 describes. */}
      <input
        id="question"
        className="composer__input"
        data-testid="composer-input"
        value={text}
        maxLength={composer.maxLength}
        placeholder={composer.placeholder}
        disabled={!composer.available}
        aria-describedby={composer.unavailableReason === null ? undefined : 'composer-reason'}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="submit"
        className="button button--primary"
        data-testid="composer-submit"
        disabled={!composer.available}
      >
        {composer.submitLabel}
      </button>
      {composer.unavailableReason === null ? null : (
        <p className="conversation__reason" id="composer-reason" data-testid="composer-why">
          {composer.unavailableReason}
        </p>
      )}
      {composer.notes.map((note) => (
        <p className="composer__note" key={note} data-testid="composer-note">
          {note}
        </p>
      ))}
    </form>
  );
}

export function ConversationPanel({
  view,
  conversation,
  onCommand,
}: {
  view: ConversationView;
  conversation: ConversationShell;
  onCommand: (command: InteractionCommand) => void;
}) {
  return (
    <section
      className={`conversation conversation--${view.tone}`}
      aria-label="Conversation"
      data-testid="conversation"
      data-state={view.state}
      data-tone={view.tone}
      data-activity={view.activity}
    >
      <StateBadge view={view} />

      {/* First, and never conditional on a profile being selected: the panel
          used to show a Model section only when `PILOT_MODEL_PROFILE=codex`. */}
      {view.modelStatus === null ? null : <ModelStatus status={view.modelStatus} />}

      {view.lastError === null ? null : (
        <div
          className="banner banner--error"
          role="alert"
          data-testid="conversation-error"
          data-observation-failure={view.observationFailure?.failure ?? 'none'}
        >
          <p className="banner__message">{view.lastError.userMessage}</p>
          {/* PR-030: a refused look says whether looking again could help, and
              which §10 rule refused when a policy rule is what refused. Both
              come from `readObservationFailure`; nothing here decides. */}
          {view.observationFailure === null ? null : (
            <p className="banner__hint" data-testid="conversation-observation-hint">
              {view.observationFailure.hint}
            </p>
          )}
          {/* PR-040: what to do about it, and which of the two endings this was.
              From `readLifecycleGuidance`, which is total over the error
              taxonomy — so this line is present for every failure, including
              ones raised by code that has never heard of it. */}
          {view.recovery === null ? null : (
            <p
              className="banner__hint"
              data-testid="conversation-recovery-remedy"
              data-disposition={view.recovery.disposition}
            >
              {view.recovery.remedy}
            </p>
          )}
          <dl className="banner__meta">
            <dt>Code</dt>
            <dd data-testid="conversation-error-code">{view.lastError.code}</dd>
            {view.observationFailure === null ? null : (
              <>
                <dt>Look</dt>
                <dd data-testid="conversation-observation-failure">
                  {view.observationFailure.failure}
                  {view.observationFailure.policyRule === null
                    ? ''
                    : ` · ${view.observationFailure.policyRule}`}
                </dd>
              </>
            )}
          </dl>
          <button
            type="button"
            className="button button--quiet"
            data-testid="conversation-dismiss-error"
            onClick={() => onCommand({ type: 'dismiss-error' })}
          >
            Dismiss
          </button>
        </div>
      )}

      {view.modelDisclosure === null ? null : <ModelDisclosure disclosure={view.modelDisclosure} />}

      {view.disclosure === null ? null : <Disclosure disclosure={view.disclosure} />}

      <ol className="transcript__list" data-testid="transcript">
        {view.turns.map((turn) => (
          <Turn key={turn.utteranceId} turn={turn} />
        ))}
      </ol>

      {view.empty ? (
        <p className="transcript__empty" data-testid="transcript-empty">
          Nothing said yet.
        </p>
      ) : null}

      {view.liveTranscript === null ? null : (
        <p className="transcript__live" data-testid="live-transcript" aria-live="polite">
          {view.liveTranscript}
        </p>
      )}

      {view.stream === null ? null : <Stream stream={view.stream} />}

      <Composer view={view} onSubmit={(text) => onCommand({ type: 'submit-text', text })} />

      <div className="button-row" data-testid="conversation-controls">
        <Control
          id="push-to-talk"
          view={view}
          onActivate={() => onCommand({ type: 'push-to-talk-down' })}
          onRelease={() => onCommand({ type: 'push-to-talk-up' })}
        />
        <Control id="look-now" view={view} onActivate={() => onCommand({ type: 'look-now' })} />
        <Control id="interrupt" view={view} onActivate={() => onCommand({ type: 'interrupt' })} />
        <Control
          id="stop-speaking"
          view={view}
          onActivate={() => onCommand({ type: 'stop-speaking' })}
        />
        <Control
          id="clear-conversation"
          view={view}
          onActivate={() => onCommand({ type: 'clear-conversation' })}
        />
      </div>

      <DiagnosticsPanel gate={conversation.gate} conversation={conversation} />

      {conversation.gate.demoFixtures ? (
        <div className="scenarios" aria-label="Fixture conversations" data-testid="fixture-bar">
          <span className="scenarios__label">Replay</span>
          {CONVERSATION_FIXTURES.map((fixture) => (
            <button
              key={fixture}
              type="button"
              className="button button--quiet"
              data-testid={`fixture-${fixture}`}
              onClick={() => conversation.replayFixture(fixture)}
            >
              {FIXTURE_LABELS[fixture]}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
