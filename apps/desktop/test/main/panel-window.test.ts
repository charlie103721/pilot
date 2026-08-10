import { describe, expect, it } from 'vitest';
import { createCounterIdSource, createIdFactory, parseEventEnvelope } from '@pilot/shared';
import { panelVisibilityEvent, viewStateChangedEvent } from '../../src/ipc/channels.js';
import { PanelController } from '../../src/main/panel-window.js';
import { FakePanelHost } from './support.js';

function controller() {
  const host = new FakePanelHost();
  const panel = new PanelController({
    host,
    ids: createIdFactory(createCounterIdSource()),
    now: () => 1_700_000_000_000,
  });
  return { host, panel };
}

describe('PanelController', () => {
  it('creates the window lazily on the first show', () => {
    const { host, panel } = controller();

    expect(host.created).toHaveLength(0);
    expect(panel.isVisible()).toBe(false);

    panel.show();

    expect(host.created).toHaveLength(1);
    expect(panel.isVisible()).toBe(true);
    expect(host.latest?.focusCount).toBe(1);
  });

  it('reuses the same window across hide and show', () => {
    const { host, panel } = controller();

    panel.show();
    panel.hide();
    panel.show();

    expect(host.created).toHaveLength(1);
    expect(panel.isVisible()).toBe(true);
  });

  it('toggles between visible and hidden', () => {
    const { panel } = controller();

    expect(panel.toggle()).toBe(true);
    expect(panel.isVisible()).toBe(true);
    expect(panel.toggle()).toBe(false);
    expect(panel.isVisible()).toBe(false);
  });

  it('recreates the window after it is closed by the OS', () => {
    const { host, panel } = controller();

    panel.show();
    host.latest?.closeExternally();

    expect(panel.isVisible()).toBe(false);

    panel.show();

    expect(host.created).toHaveLength(2);
    expect(panel.isVisible()).toBe(true);
  });

  it('emits a validated visibility event on every change', () => {
    const { host, panel } = controller();

    panel.show();
    const [first] = host.latest?.sent ?? [];
    expect(first).toBeDefined();

    const { payload } = parseEventEnvelope(panelVisibilityEvent, first);
    expect(payload).toEqual({ visible: true });
    expect(first?.channel).toBe(panelVisibilityEvent.name);
  });

  it('drops broadcasts when there is no window rather than failing', () => {
    const { panel } = controller();

    expect(
      panel.broadcast(viewStateChangedEvent, {
        state: 'idle',
        conversationId: null,
        permissions: null,
        selectedWindow: null,
        observationEnabled: false,
        speaking: false,
        liveTranscript: null,
        transcript: [],
        lastError: null,
      }),
    ).toBe(false);
  });

  it('survives a window that dies mid-send', () => {
    const { host, panel } = controller();

    panel.show();
    const window = host.latest;
    expect(window).toBeDefined();
    window!.sendError = new Error('Object has been destroyed');

    expect(
      panel.broadcast(viewStateChangedEvent, {
        state: 'error',
        conversationId: null,
        permissions: null,
        selectedWindow: null,
        observationEnabled: false,
        speaking: false,
        liveTranscript: null,
        transcript: [],
        lastError: null,
      }),
    ).toBe(false);
  });

  it('refuses to send an event payload that violates the channel schema', () => {
    const { panel } = controller();
    panel.show();

    expect(() =>
      panel.broadcast(viewStateChangedEvent, { state: 'not-a-state' } as never),
    ).toThrowError();
  });

  it('destroys the window on dispose and refuses further use', () => {
    const { host, panel } = controller();

    panel.show();
    panel.dispose();

    expect(host.latest?.destroyed).toBe(true);
    expect(() => panel.show()).toThrowError();
  });
});
