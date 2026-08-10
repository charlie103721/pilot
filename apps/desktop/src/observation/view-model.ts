import type { ObservedWindow, SerializedPilotError } from '@pilot/shared';
import type { PilotViewState } from '@pilot/platform';
import type {
  ObservationNotice,
  ObservationNoticeReason,
  WindowGateState,
} from '../ipc/schemas.js';
import {
  permissionsAllowObservation,
  type PermissionOnboardingView,
} from '../permissions/view-model.js';

/**
 * Derives the window picker and the observation indicator.
 *
 * Pure and synchronous, like `src/permissions/view-model.ts` and for the same
 * reason: the rules that matter here are privacy rules, and they are asserted
 * in unit tests rather than inferred from a rendered tree. The React components
 * below this file render decisions; they do not make any.
 *
 * The one rule this file must never re-derive is *whether observation may be
 * offered at all*. That is `permissionsAllowObservation` (PR-008), used
 * verbatim, so there is a single answer to it in the app.
 */

// ---------------------------------------------------------------------------
// The observation indicator
// ---------------------------------------------------------------------------

/**
 * What Pilot is doing about the screen, right now.
 *
 * These are six distinct states rather than one badge with a boolean, because
 * the difference between them is the difference between "your screen is being
 * captured" and four separate reasons why it is not. Collapsing them would make
 * the most privacy-sensitive fact in the product the least legible one.
 */
export const OBSERVATION_INDICATORS = [
  /** Nothing is decided yet: permissions or the window list are still being read. */
  'checking',
  /** Permissions forbid observation. Pilot can see nothing at all. */
  'blocked',
  /** Allowed, but no window has been chosen. */
  'no-window',
  /** Pilot is suspended. Capture cannot run whatever else is true. */
  'paused',
  /** A window is selected and observation is switched off. */
  'stopped',
  /** Capture is running against the selected window. */
  'observing',
] as const;

export type ObservationIndicator = (typeof OBSERVATION_INDICATORS)[number];

/** Visual weight for the indicator. `live` is reserved for actual capture. */
export type ObservationTone = 'neutral' | 'danger' | 'idle' | 'warning' | 'live';

interface IndicatorCopy {
  readonly label: string;
  readonly detail: string;
  readonly tone: ObservationTone;
}

const INDICATOR_COPY: Readonly<Record<ObservationIndicator, IndicatorCopy>> = {
  checking: {
    label: 'Checking',
    detail:
      'Pilot is working out whether it is allowed to watch a window. Nothing is being captured.',
    tone: 'neutral',
  },
  blocked: {
    label: 'Cannot watch',
    detail:
      'Screen Recording is not allowed, so Pilot can see nothing at all. Nothing is being captured.',
    tone: 'danger',
  },
  'no-window': {
    label: 'No window selected',
    detail:
      'Pilot is not watching anything and nothing is being captured. Choose a window from the list below.',
    tone: 'idle',
  },
  paused: {
    label: 'Paused',
    detail: 'Pilot is paused. Nothing is being captured until you resume it.',
    tone: 'warning',
  },
  stopped: {
    label: 'Not watching',
    detail:
      'A window is selected but observation is switched off. Nothing is being captured until you start it.',
    tone: 'idle',
  },
  observing: {
    label: 'Watching this window',
    detail: 'Pilot is capturing the selected window now, and nothing else on your screen.',
    tone: 'live',
  },
};

function indicatorOf(input: ObservationViewInput, allowed: boolean): ObservationIndicator {
  if (!allowed) {
    // "Not decided yet" is not "refused" — the same distinction PR-008 draws.
    return input.permissions.readiness === 'checking' ? 'checking' : 'blocked';
  }
  if (input.view.state === 'paused') {
    return 'paused';
  }
  if (input.gate.listedAt === null && input.view.selectedWindow === null) {
    return 'checking';
  }
  if (input.view.selectedWindow === null) {
    return 'no-window';
  }
  return input.view.observationEnabled ? 'observing' : 'stopped';
}

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

/**
 * Every reason a control can be unavailable, in one place.
 *
 * A disabled control without a reason is the failure mode the delivery rules
 * name explicitly, so `unavailableReason` is non-null exactly when `available`
 * is false and these are the only strings it can hold.
 */
export const OBSERVATION_REASONS = {
  checking: 'Pilot is still checking what it is allowed to do.',
  blocked: 'Screen Recording is not allowed, so Pilot cannot watch a window.',
  paused: 'Pilot is paused. Resume it first.',
  alreadyPaused: 'Pilot is already paused.',
  notPaused: 'Pilot is not paused.',
  noSelection: 'Choose a window from the list first.',
  alreadyWatching: 'Pilot is already watching this window.',
  notWatching: 'Pilot is not watching anything right now.',
  noWindows: 'Pilot has not found any windows it can watch.',
  offScreen: 'This window is minimised or hidden, so there is nothing to watch.',
  selected: 'This is the window Pilot is set to watch.',
} as const;

/** The reason nothing about observation can be changed, or null. */
function globalReason(input: ObservationViewInput, allowed: boolean): string | null {
  if (!allowed) {
    return input.permissions.readiness === 'checking'
      ? OBSERVATION_REASONS.checking
      : OBSERVATION_REASONS.blocked;
  }
  return input.view.state === 'paused' ? OBSERVATION_REASONS.paused : null;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export const OBSERVATION_CONTROLS = ['start', 'stop', 'pause', 'resume', 'change'] as const;

export type ObservationControlId = (typeof OBSERVATION_CONTROLS)[number];

export interface ObservationControlView {
  readonly id: ObservationControlId;
  readonly label: string;
  readonly available: boolean;
  /** Non-null exactly when `available` is false. */
  readonly unavailableReason: string | null;
  /** The control the user most likely wants next. At most one is true. */
  readonly primary: boolean;
}

const CONTROL_LABELS: Readonly<Record<ObservationControlId, string>> = {
  start: 'Start watching',
  stop: 'Stop watching',
  pause: 'Pause Pilot',
  resume: 'Resume Pilot',
  change: 'Change window',
};

function controlReason(
  id: ObservationControlId,
  input: ObservationViewInput,
  allowed: boolean,
  hasWindows: boolean,
): string | null {
  const paused = input.view.state === 'paused';
  const selected = input.view.selectedWindow !== null;
  const observing = input.view.observationEnabled;

  // Pause and resume are the way in and out of the paused state, so they are
  // the two controls a paused Pilot must not disable.
  if (id === 'pause') {
    return paused ? OBSERVATION_REASONS.alreadyPaused : null;
  }
  if (id === 'resume') {
    return paused ? null : OBSERVATION_REASONS.notPaused;
  }

  const blocking = globalReason(input, allowed);
  if (blocking !== null) {
    return blocking;
  }
  switch (id) {
    case 'start':
      if (!selected) {
        return OBSERVATION_REASONS.noSelection;
      }
      return observing ? OBSERVATION_REASONS.alreadyWatching : null;
    case 'stop':
      if (!selected) {
        return OBSERVATION_REASONS.noSelection;
      }
      return observing ? null : OBSERVATION_REASONS.notWatching;
    case 'change':
      if (!hasWindows) {
        return OBSERVATION_REASONS.noWindows;
      }
      return selected ? null : OBSERVATION_REASONS.noSelection;
  }
}

function primaryControl(indicator: ObservationIndicator): ObservationControlId | null {
  switch (indicator) {
    case 'paused':
      return 'resume';
    case 'stopped':
      return 'start';
    case 'observing':
      return 'stop';
    case 'checking':
    case 'blocked':
    case 'no-window':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Window rows
// ---------------------------------------------------------------------------

export interface WindowRowView {
  readonly windowId: ObservedWindow['windowId'];
  readonly title: string;
  readonly applicationName: string;
  readonly displayId: string;
  readonly sizeLabel: string;
  readonly selected: boolean;
  readonly onScreen: boolean;
  readonly actionLabel: string;
  readonly selectable: boolean;
  /** Non-null exactly when `selectable` is false. */
  readonly unavailableReason: string | null;
}

function sizeLabelOf(window: ObservedWindow): string {
  const { width, height, x, y } = window.bounds;
  return `${String(Math.round(width))} × ${String(Math.round(height))} at (${String(Math.round(x))}, ${String(Math.round(y))})`;
}

function buildRow(
  window: ObservedWindow,
  input: ObservationViewInput,
  allowed: boolean,
): WindowRowView {
  const selected = input.view.selectedWindow?.windowId === window.windowId;
  // Order matters. A reason that stops *everything* — no permission, paused —
  // is reported on every row, so the user is told once why nothing can be
  // picked rather than being told four different second-order things.
  const reason =
    globalReason(input, allowed) ??
    (!window.isOnScreen
      ? OBSERVATION_REASONS.offScreen
      : selected
        ? OBSERVATION_REASONS.selected
        : null);
  return {
    windowId: window.windowId,
    title: window.title,
    applicationName: window.applicationName,
    displayId: window.displayId,
    sizeLabel: sizeLabelOf(window),
    selected,
    onScreen: window.isOnScreen,
    actionLabel: selected
      ? input.view.observationEnabled
        ? 'Watching now'
        : 'Selected'
      : input.view.selectedWindow === null
        ? 'Watch this window'
        : 'Switch to this window',
    selectable: reason === null,
    unavailableReason: reason,
  };
}

// ---------------------------------------------------------------------------
// Selected-window summary
// ---------------------------------------------------------------------------

export interface SelectedWindowSummary {
  readonly window: ObservedWindow;
  readonly title: string;
  readonly applicationName: string;
  /** Bundle identifier, or an explicit statement that the platform gave none. */
  readonly bundleLabel: string;
  readonly displayLabel: string;
  readonly sizeLabel: string;
  readonly scaleLabel: string;
  readonly onScreen: boolean;
  /** True when the window is no longer in the list Pilot last read. */
  readonly stale: boolean;
  /** Something the user should know about this window, or null. */
  readonly warning: string | null;
}

function buildSelection(input: ObservationViewInput): SelectedWindowSummary | null {
  const window = input.view.selectedWindow;
  if (window === null) {
    return null;
  }
  const stale =
    input.gate.listedAt !== null &&
    !input.gate.windows.some((entry) => entry.windowId === window.windowId);
  const warning = !window.isOnScreen
    ? 'This window is minimised or hidden. There is nothing for Pilot to capture until it is visible again.'
    : stale
      ? 'Pilot can no longer find this window in the list of open windows.'
      : null;
  return {
    window,
    title: window.title,
    applicationName: window.applicationName,
    bundleLabel: window.applicationBundleId ?? 'no bundle identifier reported',
    displayLabel: window.displayId,
    sizeLabel: sizeLabelOf(window),
    scaleLabel: `${String(window.scaleFactor)}×`,
    onScreen: window.isOnScreen,
    stale,
    warning,
  };
}

// ---------------------------------------------------------------------------
// The §16 prompt
// ---------------------------------------------------------------------------

export interface ObservationNoticeView {
  readonly reason: ObservationNoticeReason;
  readonly headline: string;
  readonly message: string;
  readonly at: number;
  readonly windowLabel: string | null;
}

function windowLabel(notice: ObservationNotice): string | null {
  return notice.window === null
    ? null
    : `${notice.window.applicationName} — ${notice.window.title}`;
}

function buildNotice(notice: ObservationNotice | null): ObservationNoticeView | null {
  if (notice === null) {
    return null;
  }
  const label = windowLabel(notice);
  const named = label === null ? 'The selected window' : label;
  switch (notice.reason) {
    case 'selected-window-closed':
      return {
        reason: notice.reason,
        headline: notice.wasObserving ? 'Pilot stopped watching' : 'That window is gone',
        message: notice.wasObserving
          ? `${named} closed. Pilot stopped watching and cleared what it had. Choose another window to carry on.`
          : `${named} closed before Pilot started watching it. Choose another window.`,
        at: notice.at,
        windowLabel: label,
      };
    case 'observation-permission-lost':
      return {
        reason: notice.reason,
        headline: 'Pilot stopped watching',
        message:
          label === null
            ? 'Screen Recording is no longer allowed, so Pilot stopped watching and is capturing nothing. Allow it again above to carry on.'
            : `Screen Recording is no longer allowed, so Pilot stopped watching ${label} and is capturing nothing. Allow it again above to carry on.`,
        at: notice.at,
        windowLabel: label,
      };
  }
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export type WindowListStatus = 'checking' | 'empty' | 'listed';

/**
 * Shown while an observation is in flight (PR-030).
 *
 * Present tense and specific about the scope: §14's promise is that Pilot looks
 * at the selected window and nothing else, and the moment to repeat it is the
 * moment it is actually happening.
 */
export const OBSERVATION_LOOKING_NOTE =
  'Pilot is reading an image of this window right now — this window only.';

export interface ObservationViewInput {
  readonly gate: WindowGateState;
  readonly view: PilotViewState;
  readonly permissions: PermissionOnboardingView;
}

export interface ObservationView {
  readonly indicator: ObservationIndicator;
  readonly indicatorLabel: string;
  readonly indicatorDetail: string;
  readonly tone: ObservationTone;
  /**
   * The single privacy fact: true only while Pilot is actually capturing.
   * Every other state — paused, blocked, stopped, nothing selected — is false.
   */
  readonly capturing: boolean;
  /**
   * The *second* privacy fact (PR-030): a frame is being read **right now**.
   *
   * Not a re-derivation of {@link capturing} and not a seventh indicator state:
   * capture is a stream Pilot holds open for as long as a window is selected,
   * and looking is the moment an image of that window is turned into something
   * a model can read. system-design §14 asks the user be able to see the
   * second, and until PR-030 nothing in the observation surface showed it —
   * `observe_screen` reached a fake, so there was nothing to show.
   *
   * True in exactly one interaction state, `observing-screen`, which is where
   * the transition table puts both the model's tool call (`tool-started`) and
   * the user's "Look now". The conversation panel says the same thing in its
   * own words through `INTERACTION_STATE_PRESENTATION`; this is the observation
   * surface's copy of the fact, next to the window it is about.
   */
  readonly looking: boolean;
  /** One sentence while {@link looking}, else null. */
  readonly lookingNote: string | null;
  /** Whether observation may be offered at all (PR-008's rule, unmodified). */
  readonly allowed: boolean;
  /** Accessibility refused leaves Pilot working with weaker grounding (§16). */
  readonly grounding: 'full' | 'reduced';
  readonly groundingNote: string | null;
  readonly selection: SelectedWindowSummary | null;
  readonly rows: readonly WindowRowView[];
  readonly listStatus: WindowListStatus;
  readonly listNote: string | null;
  readonly listedAt: number | null;
  readonly controls: readonly ObservationControlView[];
  readonly notice: ObservationNoticeView | null;
  readonly lastError: SerializedPilotError | null;
}

const LIST_NOTES: Readonly<Record<WindowListStatus, string | null>> = {
  checking: 'Reading the list of open windows…',
  empty: 'No windows are open that Pilot could watch.',
  listed: null,
};

export function buildObservationView(input: ObservationViewInput): ObservationView {
  const allowed = permissionsAllowObservation(input.permissions);
  const indicator = indicatorOf(input, allowed);
  const copy = INDICATOR_COPY[indicator];
  const rows = input.gate.windows.map((window) => buildRow(window, input, allowed));
  const listStatus: WindowListStatus =
    input.gate.listedAt === null ? 'checking' : rows.length === 0 ? 'empty' : 'listed';
  const primary = primaryControl(indicator);
  const reduced = input.permissions.groundingDisclosure !== null;
  // Read off the machine, which is the only thing that knows an observation is
  // in flight — and read as a state name, never as "capture is on and something
  // is happening", which would be a second, disagreeing answer.
  const looking = input.view.state === 'observing-screen';

  const controls = OBSERVATION_CONTROLS.map((id): ObservationControlView => {
    const reason = controlReason(id, input, allowed, rows.length > 0);
    return {
      id,
      label: CONTROL_LABELS[id],
      available: reason === null,
      unavailableReason: reason,
      primary: reason === null && id === primary,
    };
  });

  return {
    indicator,
    indicatorLabel: copy.label,
    indicatorDetail:
      indicator === 'observing' && reduced
        ? `${copy.detail} Accessibility is not allowed, so it is working from the picture alone.`
        : copy.detail,
    tone: copy.tone,
    capturing: indicator === 'observing',
    looking,
    lookingNote: looking ? OBSERVATION_LOOKING_NOTE : null,
    allowed,
    grounding: reduced ? 'reduced' : 'full',
    groundingNote: input.permissions.groundingDisclosure,
    selection: buildSelection(input),
    rows,
    listStatus,
    listNote: LIST_NOTES[listStatus],
    listedAt: input.gate.listedAt,
    controls,
    notice: buildNotice(input.gate.notice),
    lastError: input.gate.lastError,
  };
}

/** Looks one control up. Throws rather than returning undefined: the set is fixed. */
export function observationControl(
  view: ObservationView,
  id: ObservationControlId,
): ObservationControlView {
  const control = view.controls.find((entry) => entry.id === id);
  if (control === undefined) {
    throw new Error(`no observation control named ${id}`);
  }
  return control;
}
