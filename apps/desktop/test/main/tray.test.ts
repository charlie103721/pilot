import { describe, expect, it } from 'vitest';
import { PilotError } from '@pilot/shared';
import { FakeInteractionController, FIXTURE_WINDOW_RETINA } from '@pilot/platform/fakes';
import { buildTrayMenu, buildTrayTooltip, TrayController } from '../../src/main/tray.js';
import { FakeTrayHost } from './support.js';

function actions() {
  const log: string[] = [];
  return {
    log,
    actions: {
      togglePanel: () => log.push('toggle-panel'),
      toggleObservation: (enabled: boolean) => log.push(`observation:${String(enabled)}`),
      setPaused: (paused: boolean) => log.push(`paused:${String(paused)}`),
      quit: () => log.push('quit'),
    },
  };
}

/**
 * A recoverable failure to render. Was `scenarios.ts`'s `DEMO_FAILURE` until
 * PR-029 deleted the fake scenario driver along with the fake controller it
 * drove; the tooltip rule under test has nothing to do with where the error
 * came from.
 */
const DEMO_FAILURE = new PilotError(
  'helper-unavailable',
  'The Pilot helper process is not running',
  {
    userMessage: 'Pilot lost contact with its screen helper. Observation is unavailable.',
  },
);

describe('tray menu rendering', () => {
  it('shows the interaction state and the selected window', () => {
    const controller = new FakeInteractionController();
    controller.set({ state: 'listening', selectedWindow: FIXTURE_WINDOW_RETINA });

    const menu = buildTrayMenu(controller.snapshot(), false);
    const status = menu.find((item) => item.id === 'status');

    expect(status?.label).toBe('Listening — Billing Settings');
    expect(status?.enabled).toBe(false);
  });

  it('says no window is selected rather than showing an empty label', () => {
    const controller = new FakeInteractionController();

    const status = buildTrayMenu(controller.snapshot(), false).find((item) => item.id === 'status');

    expect(status?.label).toBe('Idle — No window selected');
  });

  it('disables observation until a window is chosen', () => {
    const controller = new FakeInteractionController();

    const withoutWindow = buildTrayMenu(controller.snapshot(), false).find(
      (item) => item.id === 'toggle-observation',
    );
    expect(withoutWindow?.enabled).toBe(false);

    controller.set({ selectedWindow: FIXTURE_WINDOW_RETINA, observationEnabled: true });
    const withWindow = buildTrayMenu(controller.snapshot(), false).find(
      (item) => item.id === 'toggle-observation',
    );
    expect(withWindow?.enabled).toBe(true);
    expect(withWindow?.checked).toBe(true);
  });

  it('names the panel action after what it will do', () => {
    const controller = new FakeInteractionController();

    expect(
      buildTrayMenu(controller.snapshot(), false).find((item) => item.id === 'toggle-panel')?.label,
    ).toBe('Show Pilot');
    expect(
      buildTrayMenu(controller.snapshot(), true).find((item) => item.id === 'toggle-panel')?.label,
    ).toBe('Hide Pilot');
  });

  it('surfaces a failure in the tooltip instead of a generic state name', () => {
    const controller = new FakeInteractionController();
    controller.fail(DEMO_FAILURE.toJSON());

    expect(buildTrayTooltip(controller.snapshot())).toContain(DEMO_FAILURE.userMessage);
  });
});

describe('TrayController', () => {
  it('renders tooltip and menu once a view state arrives', () => {
    const host = new FakeTrayHost();
    const { actions: trayActions } = actions();
    const controller = new TrayController({ host, actions: trayActions });

    expect(controller.create().available).toBe(true);
    controller.update(new FakeInteractionController().snapshot());

    expect(host.latest?.tooltip).toBe('Pilot — Idle');
    expect(host.latest?.item('quit')?.label).toBe('Quit Pilot');
  });

  it('reports an unavailable menu bar instead of throwing', () => {
    const host = new FakeTrayHost();
    host.failure = new Error('no StatusNotifier host is running');
    const { actions: trayActions } = actions();
    const controller = new TrayController({ host, actions: trayActions });

    const availability = controller.create();

    expect(availability.available).toBe(false);
    expect(availability.available === false && availability.reason).toContain('StatusNotifier');
    // Updating without a tray must stay harmless.
    expect(() => controller.update(new FakeInteractionController().snapshot())).not.toThrow();
  });

  it('routes menu selections to the matching action', () => {
    const host = new FakeTrayHost();
    const { actions: trayActions, log } = actions();
    const controller = new TrayController({ host, actions: trayActions });
    controller.create();

    const interaction = new FakeInteractionController();
    interaction.set({ selectedWindow: FIXTURE_WINDOW_RETINA, observationEnabled: false });
    controller.update(interaction.snapshot());

    controller.select('toggle-panel');
    controller.select('toggle-observation');
    controller.select('pause-resume');
    controller.select('quit');

    expect(log).toEqual(['toggle-panel', 'observation:true', 'paused:true', 'quit']);
  });

  it('offers resume once paused', () => {
    const host = new FakeTrayHost();
    const { actions: trayActions, log } = actions();
    const controller = new TrayController({ host, actions: trayActions });
    controller.create();

    const interaction = new FakeInteractionController();
    interaction.set({ state: 'paused' });
    controller.update(interaction.snapshot());

    expect(host.latest?.item('pause-resume')?.label).toBe('Resume');
    controller.select('pause-resume');
    expect(log).toEqual(['paused:false']);
  });

  it('toggles the panel when the menu bar item is clicked', () => {
    const host = new FakeTrayHost();
    const { actions: trayActions, log } = actions();
    new TrayController({ host, actions: trayActions }).create();

    host.latest?.click();

    expect(log).toEqual(['toggle-panel']);
  });

  it('destroys the tray on dispose', () => {
    const host = new FakeTrayHost();
    const { actions: trayActions } = actions();
    const controller = new TrayController({ host, actions: trayActions });
    controller.create();

    controller.dispose();

    expect(host.latest?.destroyed).toBe(true);
    expect(controller.availability.available).toBe(false);
  });
});
