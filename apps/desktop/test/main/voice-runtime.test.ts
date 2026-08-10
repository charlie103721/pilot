import { describe, expect, it } from 'vitest';
import type { PermissionAttribution } from '@pilot/shared';
import {
  hotkeyUnavailableMessage,
  isHotkeyUsable,
  type HotkeyAdapter,
  type HotkeyAvailability,
  type HotkeyEvent,
  type HotkeyStatus,
  type InteractionCommand,
} from '@pilot/platform';
import { FakeHotkeyAdapter } from '@pilot/platform/fakes';
import { isTextFallbackAvailable } from '@pilot/interaction';
import { createVoiceRuntime } from '../../src/main/voice-runtime.js';

/**
 * PR-032's mapping, on its own (runbook follow-ups 12 and 19).
 *
 * The end-to-end walkthrough — a real `MacHotkeyAdapter` and a real
 * `MacSpeechInputAdapter` over the Node helper stub, driving the shipping
 * composition — is `test/voice/talk-demo.test.ts`. These are the rules that
 * would otherwise only be observable there by accident.
 */

const ATTRIBUTION_BASE = {
  confidence: 'direct',
  expected: { bundleIdentifier: 'com.pilot.app', path: '/Applications/Pilot.app', pid: 1234 },
  attributed: { bundleIdentifier: null, path: null, pid: 4321 },
  reason: 'responsible-process-is-helper',
  evidence: {},
  checkedAt: 0,
} as const;

function attribution(verdict: PermissionAttribution['verdict']): PermissionAttribution {
  return { ...ATTRIBUTION_BASE, verdict };
}

function rig(
  options: {
    readonly availability?: HotkeyAvailability;
    readonly attribution?: PermissionAttribution;
  } = {},
): {
  readonly hotkey: FakeHotkeyAdapter;
  readonly commands: InteractionCommand[];
  readonly published: HotkeyEvent[];
  readonly voice: ReturnType<typeof createVoiceRuntime>;
} {
  const hotkey = new FakeHotkeyAdapter({
    ...(options.availability === undefined ? {} : { availability: options.availability }),
  });
  const commands: InteractionCommand[] = [];
  const voice = createVoiceRuntime({
    hotkey,
    dispatch: (command) => commands.push(command),
    ...(options.attribution === undefined
      ? {}
      : { attribution: () => Promise.resolve(options.attribution) }),
    clock: () => 0,
  });
  const published: HotkeyEvent[] = [];
  voice.pushToTalk.subscribe((event) => published.push(event));
  return { hotkey, commands, published, voice };
}

describe('push-to-talk → the interaction controller (follow-up 19)', () => {
  it('turns a press and a release into push-to-talk-down and push-to-talk-up', async () => {
    const { hotkey, commands, voice } = rig();
    await voice.start();

    hotkey.pressDown();
    hotkey.pressUp();

    expect(commands.map((command) => command.type)).toEqual([
      'push-to-talk-down',
      'push-to-talk-up',
    ]);
    expect(voice.stats()).toMatchObject({ downs: 1, ups: 1, syntheticUps: 0 });
  });

  it('dispatches push-to-talk-up for a SYNTHETIC release', async () => {
    // The one release that must never be filtered: it is how a dead event tap,
    // a crashed helper or a key-up macOS lost lets go of the microphone. A
    // mapping that ignored it would leave the machine in `listening` for ever.
    const { hotkey, commands, voice } = rig();
    await voice.start();

    hotkey.pressDown();
    // macOS switches the tap off while the key is down. `FakeHotkeyAdapter`
    // enforces the same pairing invariant the macOS adapter does.
    hotkey.setAvailability({
      status: 'unavailable',
      reason: 'listener-disabled',
      detail: 'the event tap was disabled by the system',
    });

    const releases = commands.filter((command) => command.type === 'push-to-talk-up');
    expect(releases).toHaveLength(1);
    expect(voice.stats().syntheticUps).toBe(1);
    // And the user is still told, in words, that typing works.
    expect(hotkeyUnavailableMessage(voice.availability())).toContain('Type your question');
  });

  it('publishes hotkey-availability-changed to the panel’s source', async () => {
    const { hotkey, published, voice } = rig();
    await voice.start();

    hotkey.setAvailability({
      status: 'unavailable',
      reason: 'permission-missing',
      permission: 'accessibility',
      detail: 'AXIsProcessTrusted() is false',
    });

    const changes = published.filter((event) => event.type === 'hotkey-availability-changed');
    expect(changes.at(-1)).toMatchObject({
      availability: { status: 'unavailable', reason: 'permission-missing' },
    });
    expect(isHotkeyUsable(voice.availability())).toBe(false);
  });

  it('releases a held key on dispose, and the release still reaches the machine', async () => {
    // Shutdown mid-utterance. `hotkey.stop()` synthesises the release; a
    // runtime that unsubscribed first would swallow it and leave the machine in
    // `listening` with the recogniser open — which is why the app disposes
    // voice *before* the controller.
    const { hotkey, commands, voice } = rig();
    await voice.start();
    hotkey.pressDown();

    await voice.dispose();

    expect(commands.map((command) => command.type)).toEqual([
      'push-to-talk-down',
      'push-to-talk-up',
    ]);
    expect(voice.stats().syntheticUps).toBe(1);
    // Idempotent, and nothing further is forwarded.
    await voice.dispose();
    hotkey.pressDown();
    expect(commands).toHaveLength(2);
  });

  it('enables the mapping before the adapter’s start resolves', async () => {
    // Regression. A `hotkey.start` response and a `hotkey.key` event can arrive
    // in the same read, and `NativeHelperTransport` dispatches the event before
    // the awaited continuation runs — so a runtime that enabled itself *after*
    // awaiting `start()` dropped the first press, intermittently.
    const commands: InteractionCommand[] = [];
    const listeners: ((event: HotkeyEvent) => void)[] = [];
    const eager: HotkeyAdapter = {
      subscribe: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
      status: () => Promise.resolve(stopped()),
      async start(): Promise<HotkeyStatus> {
        // The key arrives while `start` is still in flight.
        for (const listener of listeners) {
          listener({
            type: 'hotkey-down',
            binding: stopped().binding,
            at: 0,
            sequence: 1,
          });
        }
        return active();
      },
      stop: () => Promise.resolve(stopped()),
    };
    const voice = createVoiceRuntime({
      hotkey: eager,
      dispatch: (command) => commands.push(command),
      clock: () => 0,
    });

    await voice.start();

    expect(commands.map((command) => command.type)).toEqual(['push-to-talk-down']);
    expect(voice.stats().droppedWhileDisabled).toBe(0);
  });
});

describe('voice is gated on TCC attribution (follow-up 12)', () => {
  it('never starts the tap when macOS credits the grants elsewhere', async () => {
    const { hotkey, commands, voice } = rig({ attribution: attribution('helper-attributed') });

    const status = await voice.start();

    expect(voice.enabled).toBe(false);
    // The adapter was never asked to listen, so nothing could reach a key.
    expect((await hotkey.status()).availability.status).toBe('stopped');
    expect(status.availability).toMatchObject({
      status: 'unavailable',
      reason: 'permission-unattributed',
      permission: 'microphone',
    });
    // Even a tap that somehow ran anyway cannot open a microphone.
    hotkey.setAvailability({ status: 'active' });
    hotkey.pressDown();
    expect(commands).toEqual([]);
    expect(voice.stats().droppedWhileDisabled).toBeGreaterThan(0);
  });

  it('says why, and says that typing still works', async () => {
    const { voice } = rig({ attribution: attribution('bundle-mismatch') });
    await voice.start();

    const message = hotkeyUnavailableMessage(voice.availability());
    expect(message).toContain('another program');
    expect(message).toContain('You can still type your question.');
    // §16, the single most important behaviour in this PR.
    for (const state of ['idle', 'observing', 'error'] as const) {
      expect(isTextFallbackAvailable(state)).toBe(true);
    }
  });

  it('starts the tap on `matched`, and on `unknown` — a non-answer is not a failure', async () => {
    for (const verdict of ['matched', 'unknown'] as const) {
      const { voice, hotkey, commands } = rig({ attribution: attribution(verdict) });
      await voice.start();
      expect(voice.enabled).toBe(true);
      expect((await hotkey.status()).availability.status).toBe('active');
      hotkey.tap();
      expect(commands.map((command) => command.type)).toEqual([
        'push-to-talk-down',
        'push-to-talk-up',
      ]);
    }
  });

  it('starts the tap when there is no attribution seam to read', async () => {
    const { voice } = rig();
    await voice.start();
    expect(voice.enabled).toBe(true);
    expect(voice.attribution()).toBeUndefined();
  });

  it('a missing Accessibility grant is a state, not an exception', async () => {
    // PR-015's promise, re-checked at the wiring: `start()` resolves, the panel
    // renders the reason, and the composer is the way to ask.
    const { voice } = rig({
      availability: {
        status: 'unavailable',
        reason: 'permission-missing',
        permission: 'accessibility',
        detail: 'AXIsProcessTrusted() is false',
      },
    });

    const status = await voice.start();

    expect(status.availability.status).toBe('unavailable');
    expect(hotkeyUnavailableMessage(status.availability)).toContain('type your question');
    expect(isTextFallbackAvailable('observing')).toBe(true);
  });
});

function stopped(): HotkeyStatus {
  return {
    binding: { keyCode: 61, label: 'Right Option', isModifierKey: true, requiredModifiers: [] },
    availability: { status: 'stopped' },
    held: false,
    counters: {
      downs: 0,
      ups: 0,
      suppressed: 0,
      synthetic: 0,
      listenerDisabled: 0,
      listenerRestored: 0,
    },
  };
}

function active(): HotkeyStatus {
  return { ...stopped(), availability: { status: 'active' } };
}
