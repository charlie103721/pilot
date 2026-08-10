import { describe, expect, it } from 'vitest';
import {
  FAKE_INITIAL_VIEW_STATE,
  FIXTURE_WINDOWS,
  FIXTURE_WINDOW_RETINA,
  FIXTURE_WINDOW_SECONDARY,
} from '@pilot/platform/fakes';
import type { PilotViewState } from '@pilot/platform';
import type { ObservedWindow } from '@pilot/shared';
import type {
  ObservationNotice,
  PermissionFixtureName,
  PermissionGateState,
  WindowGateState,
} from '../../src/ipc/schemas.js';
import { PERMISSION_FIXTURE_SNAPSHOTS } from '../../src/main/permission-fixtures.js';
import { buildPermissionOnboardingView } from '../../src/permissions/view-model.js';
import {
  buildObservationView,
  observationControl,
  OBSERVATION_CONTROLS,
  OBSERVATION_INDICATORS,
  OBSERVATION_REASONS,
  type ObservationControlId,
  type ObservationIndicator,
  type ObservationViewInput,
} from '../../src/observation/view-model.js';

/**
 * The observation indicator and the control rules.
 *
 * Everything privacy-critical about PR-009 is decided in the view model, so
 * this is where it is pinned down: that "capturing" is true in exactly one of
 * the six states, that a blocked Pilot is offered no observation, that a
 * *degraded* Pilot still is, and that no control is ever disabled without a
 * reason attached to it.
 */

function permissions(fixture: PermissionFixtureName, checked = true) {
  const gate: PermissionGateState = {
    snapshot: checked ? PERMISSION_FIXTURE_SNAPSHOTS[fixture] : null,
    pending: [],
    checkedAt: checked ? 1_700_000_000_000 : null,
    settings: { available: false, platform: 'linux', reason: 'no System Settings here' },
    lastError: null,
    fixture,
  };
  return buildPermissionOnboardingView(gate);
}

function gateState(patch: Partial<WindowGateState> = {}): WindowGateState {
  return {
    windows: FIXTURE_WINDOWS,
    listedAt: 1_700_000_000_000,
    listing: false,
    notice: null,
    lastError: null,
    demoEvents: true,
    ...patch,
  };
}

function viewState(patch: Partial<PilotViewState> = {}): PilotViewState {
  return { ...FAKE_INITIAL_VIEW_STATE, ...patch };
}

function input(patch: Partial<ObservationViewInput> = {}): ObservationViewInput {
  return {
    gate: gateState(),
    view: viewState(),
    permissions: permissions('granted'),
    ...patch,
  };
}

function reasonFor(view: ReturnType<typeof buildObservationView>, id: ObservationControlId) {
  return observationControl(view, id).unavailableReason;
}

const SELECTED: ObservedWindow = FIXTURE_WINDOW_RETINA;

describe('observation indicator', () => {
  const cases: Readonly<Record<ObservationIndicator, ObservationViewInput>> = {
    checking: input({ permissions: permissions('granted', false) }),
    blocked: input({ permissions: permissions('screen-denied') }),
    'no-window': input(),
    paused: input({ view: viewState({ selectedWindow: SELECTED, state: 'paused' }) }),
    stopped: input({ view: viewState({ selectedWindow: SELECTED, observationEnabled: false }) }),
    observing: input({
      view: viewState({ selectedWindow: SELECTED, observationEnabled: true, state: 'observing' }),
    }),
  };

  it('reaches every declared indicator state', () => {
    for (const indicator of OBSERVATION_INDICATORS) {
      const entry = cases[indicator];
      expect(buildObservationView(entry).indicator).toBe(indicator);
    }
  });

  it('says Pilot is capturing in exactly one of them', () => {
    const capturing = OBSERVATION_INDICATORS.filter(
      (indicator) => buildObservationView(cases[indicator]).capturing,
    );
    expect(capturing).toEqual(['observing']);
  });

  it('gives every state its own label, detail and tone weight', () => {
    const labels = new Set<string>();
    const details = new Set<string>();
    for (const indicator of OBSERVATION_INDICATORS) {
      const view = buildObservationView(cases[indicator]);
      labels.add(view.indicatorLabel);
      details.add(view.indicatorDetail);
      // Every state that is not capture says so in words, not only in colour.
      if (!view.capturing) {
        expect(view.indicatorDetail.toLowerCase()).toContain('nothing is being captured');
      }
    }
    expect(labels.size).toBe(OBSERVATION_INDICATORS.length);
    expect(details.size).toBe(OBSERVATION_INDICATORS.length);
    expect(buildObservationView(cases.observing).tone).toBe('live');
    expect(buildObservationView(cases.paused).tone).not.toBe('live');
  });

  it('never reports a paused Pilot as capturing, even with observation switched on', () => {
    const view = buildObservationView(
      input({
        view: viewState({ selectedWindow: SELECTED, observationEnabled: true, state: 'paused' }),
      }),
    );
    expect(view.indicator).toBe('paused');
    expect(view.capturing).toBe(false);
  });

  it('separates "not decided yet" from "refused"', () => {
    expect(
      buildObservationView(input({ permissions: permissions('denied', false) })).indicator,
    ).toBe('checking');
    expect(buildObservationView(input({ permissions: permissions('denied') })).indicator).toBe(
      'blocked',
    );
  });

  it('does not claim an empty window list before it has read one', () => {
    const before = buildObservationView(
      input({ gate: gateState({ windows: [], listedAt: null, listing: true }) }),
    );
    expect(before.listStatus).toBe('checking');
    expect(before.listNote).toContain('Reading');

    const after = buildObservationView(input({ gate: gateState({ windows: [] }) }));
    expect(after.listStatus).toBe('empty');
    expect(after.listNote).toContain('No windows');
  });
});

describe('permissions gate the controls', () => {
  it('offers no observation at all while Screen Recording is refused', () => {
    const view = buildObservationView(input({ permissions: permissions('screen-denied') }));

    expect(view.allowed).toBe(false);
    expect(view.indicator).toBe('blocked');
    for (const id of ['start', 'stop', 'change'] as const) {
      expect(observationControl(view, id).available).toBe(false);
      expect(reasonFor(view, id)).toBe(OBSERVATION_REASONS.blocked);
    }
    // …and no window can be picked either, with the same reason on every row.
    for (const row of view.rows) {
      expect(row.selectable).toBe(false);
      expect(row.unavailableReason).toBe(OBSERVATION_REASONS.blocked);
    }
  });

  it('still allows selection and observation when only Accessibility is refused', () => {
    const view = buildObservationView(input({ permissions: permissions('accessibility-denied') }));

    expect(view.allowed).toBe(true);
    expect(view.grounding).toBe('reduced');
    expect(view.groundingNote).toContain('pointer position');
    for (const row of view.rows) {
      expect(row.selectable).toBe(true);
      expect(row.unavailableReason).toBeNull();
    }
    // Blocked and degraded must not render the same: one refuses, one warns.
    expect(view.indicator).not.toBe('blocked');
  });

  it('discloses the reduced grounding on the indicator while it is watching', () => {
    const view = buildObservationView(
      input({
        permissions: permissions('accessibility-denied'),
        view: viewState({ selectedWindow: SELECTED, observationEnabled: true }),
      }),
    );
    expect(view.capturing).toBe(true);
    expect(view.indicatorDetail).toContain('Accessibility is not allowed');
  });
});

describe('control availability', () => {
  it('states a reason for every unavailable control and none for available ones', () => {
    const inputs = [
      input(),
      input({ permissions: permissions('screen-denied') }),
      input({ view: viewState({ selectedWindow: SELECTED, state: 'paused' }) }),
      input({ view: viewState({ selectedWindow: SELECTED, observationEnabled: true }) }),
    ];
    for (const entry of inputs) {
      const view = buildObservationView(entry);
      expect(view.controls.map((control) => control.id)).toEqual([...OBSERVATION_CONTROLS]);
      for (const control of view.controls) {
        expect(control.available).toBe(control.unavailableReason === null);
      }
      expect(view.controls.filter((control) => control.primary).length).toBeLessThanOrEqual(1);
    }
  });

  it('cannot start without a selection', () => {
    const view = buildObservationView(input());
    expect(reasonFor(view, 'start')).toBe(OBSERVATION_REASONS.noSelection);
    expect(reasonFor(view, 'stop')).toBe(OBSERVATION_REASONS.noSelection);
    expect(reasonFor(view, 'change')).toBe(OBSERVATION_REASONS.noSelection);
  });

  it('offers start once a window is selected and stop once it is watching', () => {
    const selected = buildObservationView(input({ view: viewState({ selectedWindow: SELECTED }) }));
    expect(observationControl(selected, 'start').available).toBe(true);
    expect(observationControl(selected, 'start').primary).toBe(true);
    expect(reasonFor(selected, 'stop')).toBe(OBSERVATION_REASONS.notWatching);

    const watching = buildObservationView(
      input({ view: viewState({ selectedWindow: SELECTED, observationEnabled: true }) }),
    );
    expect(reasonFor(watching, 'start')).toBe(OBSERVATION_REASONS.alreadyWatching);
    expect(observationControl(watching, 'stop').available).toBe(true);
    expect(observationControl(watching, 'stop').primary).toBe(true);
  });

  it('keeps resume reachable while paused and start unreachable', () => {
    const view = buildObservationView(
      input({
        view: viewState({ selectedWindow: SELECTED, observationEnabled: true, state: 'paused' }),
      }),
    );
    expect(observationControl(view, 'resume').available).toBe(true);
    expect(observationControl(view, 'resume').primary).toBe(true);
    expect(reasonFor(view, 'pause')).toBe(OBSERVATION_REASONS.alreadyPaused);
    expect(reasonFor(view, 'start')).toBe(OBSERVATION_REASONS.paused);
    expect(reasonFor(view, 'change')).toBe(OBSERVATION_REASONS.paused);
    for (const row of view.rows) {
      expect(row.selectable).toBe(false);
      expect(row.unavailableReason).toBe(OBSERVATION_REASONS.paused);
    }
  });

  it('refuses to resume a Pilot that is not paused', () => {
    const view = buildObservationView(input());
    expect(reasonFor(view, 'resume')).toBe(OBSERVATION_REASONS.notPaused);
    expect(observationControl(view, 'pause').available).toBe(true);
  });

  it('has nothing to change when no window was ever listed', () => {
    const view = buildObservationView(
      input({ gate: gateState({ windows: [] }), view: viewState({ selectedWindow: SELECTED }) }),
    );
    expect(reasonFor(view, 'change')).toBe(OBSERVATION_REASONS.noWindows);
  });
});

describe('window rows', () => {
  it('labels the change action distinctly from the first choice', () => {
    const fresh = buildObservationView(input());
    expect(fresh.rows.map((row) => row.actionLabel)).toEqual([
      'Watch this window',
      'Watch this window',
    ]);

    const chosen = buildObservationView(
      input({ view: viewState({ selectedWindow: SELECTED, observationEnabled: true }) }),
    );
    const [first, second] = chosen.rows;
    expect(first?.selected).toBe(true);
    expect(first?.actionLabel).toBe('Watching now');
    expect(first?.selectable).toBe(false);
    expect(first?.unavailableReason).toBe(OBSERVATION_REASONS.selected);
    expect(second?.actionLabel).toBe('Switch to this window');
    expect(second?.selectable).toBe(true);
  });

  it('refuses a window that is not on screen, and says why', () => {
    const hidden = { ...FIXTURE_WINDOW_SECONDARY, isOnScreen: false };
    const view = buildObservationView(
      input({ gate: gateState({ windows: [FIXTURE_WINDOW_RETINA, hidden] }) }),
    );
    const row = view.rows.find((entry) => entry.windowId === hidden.windowId);
    expect(row?.selectable).toBe(false);
    expect(row?.unavailableReason).toBe(OBSERVATION_REASONS.offScreen);
  });
});

describe('selected-window summary', () => {
  it('carries enough to be sure Pilot is watching the right thing', () => {
    const view = buildObservationView(
      input({ view: viewState({ selectedWindow: SELECTED, observationEnabled: true }) }),
    );
    const summary = view.selection;
    expect(summary?.title).toBe('Billing Settings');
    expect(summary?.applicationName).toBe('Safari');
    expect(summary?.bundleLabel).toBe('com.apple.Safari');
    expect(summary?.sizeLabel).toBe('1200 × 800 at (100, 80)');
    expect(summary?.scaleLabel).toBe('2×');
    expect(summary?.warning).toBeNull();
  });

  it('follows a retitle rather than showing a stale claim', () => {
    const retitled = { ...SELECTED, title: 'Billing Settings — Invoice 4172' };
    const view = buildObservationView(
      input({
        gate: gateState({ windows: [retitled, FIXTURE_WINDOW_SECONDARY] }),
        view: viewState({ selectedWindow: retitled, observationEnabled: true }),
      }),
    );
    expect(view.selection?.title).toBe('Billing Settings — Invoice 4172');
    expect(view.selection?.stale).toBe(false);
    expect(view.rows[0]?.title).toBe('Billing Settings — Invoice 4172');
  });

  it('warns when the selected window has left the list', () => {
    const view = buildObservationView(
      input({
        gate: gateState({ windows: [FIXTURE_WINDOW_SECONDARY] }),
        view: viewState({ selectedWindow: SELECTED, observationEnabled: true }),
      }),
    );
    expect(view.selection?.stale).toBe(true);
    expect(view.selection?.warning).toContain('no longer find');
  });

  it('warns when the selected window is minimised', () => {
    const hidden = { ...SELECTED, isOnScreen: false };
    const view = buildObservationView(
      input({
        gate: gateState({ windows: [hidden, FIXTURE_WINDOW_SECONDARY] }),
        view: viewState({ selectedWindow: hidden }),
      }),
    );
    expect(view.selection?.warning).toContain('minimised or hidden');
  });
});

describe('the §16 prompt', () => {
  const notice = (patch: Partial<ObservationNotice> = {}): ObservationNotice => ({
    reason: 'selected-window-closed',
    window: SELECTED,
    wasObserving: true,
    at: 1_700_000_000_000,
    ...patch,
  });

  it('asks for a new selection when the window Pilot was watching closed', () => {
    const view = buildObservationView(input({ gate: gateState({ notice: notice() }) }));
    expect(view.notice?.headline).toBe('Pilot stopped watching');
    expect(view.notice?.message).toContain('Safari — Billing Settings');
    expect(view.notice?.message).toContain('Choose another window');
    expect(view.notice?.windowLabel).toBe('Safari — Billing Settings');
  });

  it('distinguishes a window that closed before Pilot ever watched it', () => {
    const view = buildObservationView(
      input({ gate: gateState({ notice: notice({ wasObserving: false }) }) }),
    );
    expect(view.notice?.headline).toBe('That window is gone');
    expect(view.notice?.message).toContain('before Pilot started watching');
  });

  it('explains a permission withdrawn mid-observation', () => {
    const view = buildObservationView(
      input({
        permissions: permissions('screen-denied'),
        gate: gateState({ notice: notice({ reason: 'observation-permission-lost' }) }),
      }),
    );
    expect(view.notice?.reason).toBe('observation-permission-lost');
    expect(view.notice?.message).toContain('Screen Recording is no longer allowed');
    expect(view.capturing).toBe(false);
  });
});
