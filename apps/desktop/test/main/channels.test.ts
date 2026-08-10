import { describe, expect, it } from 'vitest';
import { FakeInteractionController, FIXTURE_WINDOW_RETINA } from '@pilot/platform/fakes';
import { asUtteranceId } from '@pilot/shared';
import {
  EVENT_CHANNELS,
  findEventChannel,
  findRequestChannel,
  REQUEST_CHANNELS,
} from '../../src/ipc/channels.js';
import { interactionCommandSchema, pilotViewStateSchema } from '../../src/ipc/schemas.js';

describe('channel catalogue', () => {
  it('names every channel exactly once', () => {
    const names = [...REQUEST_CHANNELS, ...EVENT_CHANNELS].map((channel) => channel.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('uses the pilot:<area>/<action> convention', () => {
    for (const channel of [...REQUEST_CHANNELS, ...EVENT_CHANNELS]) {
      expect(channel.name).toMatch(/^pilot:[a-z-]+\/[a-z-]+$/);
    }
  });

  it('only accepts renderer-to-main requests', () => {
    for (const channel of REQUEST_CHANNELS) {
      expect(channel.direction).toBe('renderer-to-main');
    }
  });

  it('resolves channels by name and rejects unknown ones', () => {
    for (const channel of REQUEST_CHANNELS) {
      expect(findRequestChannel(channel.name)).toBe(channel);
    }
    for (const channel of EVENT_CHANNELS) {
      expect(findEventChannel(channel.name)).toBe(channel);
    }
    expect(findRequestChannel('pilot:app/info-but-evil')).toBeUndefined();
    expect(findEventChannel('pilot:view-state/changed-evil')).toBeUndefined();
  });
});

describe('view state schema', () => {
  it('accepts the initial state of the fake controller', () => {
    expect(pilotViewStateSchema.parse(new FakeInteractionController().snapshot())).toBeDefined();
  });

  it('accepts a fully populated state', () => {
    const controller = new FakeInteractionController();
    controller.set({ selectedWindow: FIXTURE_WINDOW_RETINA, liveTranscript: 'partial' });
    controller.appendTranscript({
      utteranceId: asUtteranceId('utt-0001'),
      role: 'user',
      text: 'what does this do',
      at: 1_700_000_000_000,
      pending: false,
    });

    const parsed = pilotViewStateSchema.parse(controller.snapshot());
    expect(parsed.transcript).toHaveLength(1);
    expect(parsed.selectedWindow?.title).toBe('Billing Settings');
  });

  it('rejects a state carrying image bytes', () => {
    const controller = new FakeInteractionController();
    const smuggled = { ...controller.snapshot(), frame: 'AAAA' };

    expect(pilotViewStateSchema.safeParse(smuggled).success).toBe(false);
  });
});

describe('interaction command schema', () => {
  it('accepts every command the platform contract declares', () => {
    const commands = [
      { type: 'select-window', windowId: FIXTURE_WINDOW_RETINA.windowId },
      { type: 'set-observation-enabled', enabled: true },
      { type: 'push-to-talk-down' },
      { type: 'push-to-talk-up' },
      { type: 'submit-text', text: 'hello' },
      { type: 'look-now' },
      { type: 'interrupt' },
      { type: 'stop-speaking' },
      { type: 'clear-conversation' },
      { type: 'pause' },
      { type: 'resume' },
    ];

    for (const command of commands) {
      expect(interactionCommandSchema.safeParse(command).success).toBe(true);
    }
  });

  it('rejects an empty text submission', () => {
    expect(interactionCommandSchema.safeParse({ type: 'submit-text', text: '' }).success).toBe(
      false,
    );
  });

  it('rejects extra properties on a known command', () => {
    expect(interactionCommandSchema.safeParse({ type: 'pause', andAlso: 'capture' }).success).toBe(
      false,
    );
  });
});
