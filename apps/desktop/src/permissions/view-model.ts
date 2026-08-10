import type { PermissionKind, PermissionState, PermissionStatus } from '@pilot/shared';
import type { PermissionGateState, PermissionSettingsAvailability } from '../ipc/schemas.js';
import {
  PERMISSION_ORDER,
  permissionCopy,
  type PermissionConsequence,
  type PermissionCopy,
} from './catalog.js';

/**
 * Derives everything the panel draws from the gate state plus the catalogue.
 *
 * Pure and synchronous on purpose: every onboarding rule that matters — what is
 * blocking, what is merely degraded, whether a permission is being checked or
 * has actually been refused, whether the System Settings shortcut can do
 * anything here — is decided in this file and asserted in unit tests, so the
 * React components have no logic left to get wrong.
 */

/**
 * What the user is looking at for one permission.
 *
 * `checking` is a first-class value rather than a boolean flag beside `state`,
 * because an in-flight check and a refusal must never render the same
 * (delivery rule: no silent states). `unknown` is likewise its own value: a
 * permission nobody has been asked for yet is not a permission that was
 * refused.
 */
export const PERMISSION_ROW_STATUSES = [
  'checking',
  'unknown',
  'granted',
  'denied',
  'restricted',
] as const;

export type PermissionRowStatus = (typeof PERMISSION_ROW_STATUSES)[number];

/** The single control that most likely moves this row forward. */
export type PermissionRowAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'wait' }
  | { readonly kind: 'request'; readonly label: string }
  | { readonly kind: 'open-settings'; readonly label: string; readonly enabled: boolean };

export interface PermissionRowView {
  readonly kind: PermissionKind;
  readonly title: string;
  readonly why: string;
  readonly bound: string;
  readonly status: PermissionRowStatus;
  readonly statusLabel: string;
  readonly consequence: PermissionConsequence;
  /** True when this row currently costs the user something. */
  readonly satisfied: boolean;
  /** What is true right now because of this row. Empty when satisfied. */
  readonly impact: string;
  readonly action: PermissionRowAction;
  readonly settingsPane: string;
  /** Shown under the row when the settings shortcut cannot be offered here. */
  readonly settingsNote: string | null;
}

/**
 * Where onboarding as a whole stands.
 *
 *  - `checking`  — nothing has been decided yet.
 *  - `blocked`   — a `blocks` permission is missing; Pilot cannot work.
 *  - `degraded`  — Pilot works, with reduced grounding it must disclose.
 *  - `limited`   — Pilot works fully; one input mode is unavailable.
 *  - `ready`     — all four granted.
 */
export const PERMISSION_READINESS = [
  'checking',
  'blocked',
  'degraded',
  'limited',
  'ready',
] as const;

export type PermissionReadiness = (typeof PERMISSION_READINESS)[number];

export interface PermissionOnboardingView {
  readonly readiness: PermissionReadiness;
  readonly headline: string;
  readonly summary: string;
  readonly rows: readonly PermissionRowView[];
  /** Rows that stop Pilot working. */
  readonly blocking: readonly PermissionKind[];
  /** Rows that leave Pilot working with weaker grounding. */
  readonly degrading: readonly PermissionKind[];
  /** Rows that close off one way of using Pilot. */
  readonly limiting: readonly PermissionKind[];
  /**
   * The disclosure system-design §16 requires when Accessibility is missing.
   * Null when there is nothing to disclose.
   */
  readonly groundingDisclosure: string | null;
  readonly settings: PermissionSettingsAvailability;
  readonly checking: boolean;
  readonly checkedAt: number | null;
  readonly lastError: PermissionGateState['lastError'];
  readonly fixture: PermissionGateState['fixture'];
}

const STATUS_LABELS: Readonly<Record<PermissionRowStatus, string>> = {
  checking: 'Checking…',
  unknown: 'Not asked for yet',
  granted: 'Allowed',
  denied: 'Refused',
  restricted: 'Not available on this Mac',
};

const RESTRICTED_IMPACT =
  'Whoever manages this Mac has switched this off, so neither you nor Pilot can turn it on from System Settings.';

function rowStatus(status: PermissionStatus | undefined, pending: boolean): PermissionRowStatus {
  if (status === undefined || pending) {
    // No snapshot yet, or a check/prompt is in flight. Either way nothing has
    // been refused, and the row must not look as though something had been.
    return 'checking';
  }
  const state: PermissionState = status.state;
  return state;
}

function rowAction(
  status: PermissionRowStatus,
  canRequest: boolean,
  settings: PermissionSettingsAvailability,
): PermissionRowAction {
  switch (status) {
    case 'checking':
      return { kind: 'wait' };
    case 'granted':
      return { kind: 'none' };
    case 'unknown':
      return canRequest
        ? { kind: 'request', label: 'Allow…' }
        : { kind: 'open-settings', label: 'Open System Settings', enabled: settings.available };
    case 'denied':
      // macOS prompts once. After a refusal only System Settings can change it,
      // so offering "Allow…" again would be a button that cannot work.
      return canRequest
        ? { kind: 'request', label: 'Ask again' }
        : { kind: 'open-settings', label: 'Open System Settings', enabled: settings.available };
    case 'restricted':
      // Policy, not the user, is holding this. Settings will not help, so the
      // row offers no action at all rather than a control that leads nowhere.
      return { kind: 'none' };
  }
}

function rowImpact(status: PermissionRowStatus, copy: PermissionCopy): string {
  switch (status) {
    case 'granted':
      return '';
    case 'checking':
      return 'Pilot is asking macOS about this permission.';
    case 'restricted':
      return `${copy.whenMissing} ${RESTRICTED_IMPACT}`;
    case 'unknown':
    case 'denied':
      return copy.whenMissing;
  }
}

/**
 * Explains a System Settings control the user cannot use.
 *
 * Null whenever the shortcut works or is not offered. When it does not work,
 * the note carries both halves the user needs: why the button is inert here,
 * and the exact pane to open by hand instead.
 */
function settingsNote(
  action: PermissionRowAction,
  copy: PermissionCopy,
  settings: PermissionSettingsAvailability,
): string | null {
  if (action.kind !== 'open-settings' || action.enabled) {
    return null;
  }
  const reason = settings.reason ?? 'Pilot cannot open System Settings on this computer.';
  return `${reason} Grant it by hand at ${copy.settingsPane}.`;
}

export function buildPermissionRow(
  kind: PermissionKind,
  gate: PermissionGateState,
): PermissionRowView {
  const copy = permissionCopy(kind);
  const status = gate.snapshot?.[kind];
  const pending = gate.pending.includes(kind);
  const rendered = rowStatus(status, pending);
  const action = rowAction(rendered, status?.canRequest ?? false, gate.settings);
  return {
    kind,
    title: copy.title,
    why: copy.why,
    bound: copy.bound,
    status: rendered,
    statusLabel: STATUS_LABELS[rendered],
    consequence: copy.consequence,
    satisfied: rendered === 'granted',
    impact: rowImpact(rendered, copy),
    action,
    settingsPane: copy.settingsPane,
    settingsNote: settingsNote(action, copy, gate.settings),
  };
}

function readinessOf(rows: readonly PermissionRowView[]): PermissionReadiness {
  const unsatisfied = rows.filter((row) => !row.satisfied);
  if (unsatisfied.length === 0) {
    return 'ready';
  }
  if (unsatisfied.some((row) => row.consequence === 'blocks')) {
    // A blocking permission still being checked is not yet a block, but it is
    // not "ready" either — `checking` wins only while nothing is decided.
    return unsatisfied.every((row) => row.status === 'checking') ? 'checking' : 'blocked';
  }
  if (unsatisfied.every((row) => row.status === 'checking')) {
    return 'checking';
  }
  return unsatisfied.some((row) => row.consequence === 'degrades') ? 'degraded' : 'limited';
}

const HEADLINES: Readonly<Record<PermissionReadiness, string>> = {
  checking: 'Checking what Pilot is allowed to do',
  blocked: 'Pilot needs permission before it can see anything',
  degraded: 'Pilot can work, but it will be less precise',
  limited: 'Pilot is ready — voice is switched off',
  ready: 'Pilot has everything it needs',
};

function summaryOf(readiness: PermissionReadiness, rows: readonly PermissionRowView[]): string {
  const missing = rows.filter((row) => !row.satisfied).map((row) => row.title);
  switch (readiness) {
    case 'checking':
      return 'Asking macOS which permissions Pilot already has. Nothing has been refused.';
    case 'blocked':
      return `Pilot cannot look at a window until Screen Recording is allowed. Still needed: ${missing.join(', ')}.`;
    case 'degraded':
      return `Pilot can see your window and answer questions. Without ${missing.join(' and ')} its answers about the exact control under your pointer are less reliable, and it will say so.`;
    case 'limited':
      return `Pilot can see your window and answer typed questions. Spoken questions stay unavailable until ${missing.join(' and ')} are allowed.`;
    case 'ready':
      return 'All four permissions are allowed. Pilot can see the window you choose, read the control under your pointer, and hear a spoken question.';
  }
}

const GROUNDING_DISCLOSURE =
  'Reduced grounding: Accessibility is not allowed, so Pilot works out what you are pointing at from the picture of the window and the pointer position alone. It cannot read the name or value of the control, and may misidentify small or overlapping items.';

/**
 * system-design §16 requires the reduced-grounding disclosure when Accessibility
 * is *denied*. A permission nobody has been asked for yet gets the row's own
 * explanation instead: warning a first-run user about degraded answers, when one
 * click would fix it, teaches them to ignore the warning that matters.
 */
const DISCLOSED_STATUSES: ReadonlySet<PermissionRowStatus> = new Set<PermissionRowStatus>([
  'denied',
  'restricted',
]);

export function buildPermissionOnboardingView(gate: PermissionGateState): PermissionOnboardingView {
  const rows = PERMISSION_ORDER.map((kind) => buildPermissionRow(kind, gate));
  const readiness = readinessOf(rows);
  const unsatisfiedOf = (consequence: PermissionConsequence): readonly PermissionKind[] =>
    rows
      .filter(
        (row) => !row.satisfied && row.status !== 'checking' && row.consequence === consequence,
      )
      .map((row) => row.kind);

  const accessibility = rows.find((row) => row.kind === 'accessibility');
  return {
    readiness,
    headline: HEADLINES[readiness],
    summary: summaryOf(readiness, rows),
    rows,
    blocking: unsatisfiedOf('blocks'),
    degrading: unsatisfiedOf('degrades'),
    limiting: unsatisfiedOf('limits'),
    groundingDisclosure:
      accessibility !== undefined && DISCLOSED_STATUSES.has(accessibility.status)
        ? GROUNDING_DISCLOSURE
        : null,
    settings: gate.settings,
    checking: gate.snapshot === null || gate.pending.length > 0,
    checkedAt: gate.checkedAt,
    lastError: gate.lastError,
    fixture: gate.fixture,
  };
}

/** True when Pilot may start observing at all. */
export function permissionsAllowObservation(view: PermissionOnboardingView): boolean {
  return view.readiness !== 'blocked' && view.readiness !== 'checking';
}
