import { describe, expect, it } from 'vitest';
import {
  FakeInteractionController,
  FIXTURE_PERMISSIONS_MIXED,
  FIXTURE_WINDOW_RETINA,
} from '@pilot/platform/fakes';
import type { InteractionCommand } from '@pilot/platform';
import { asUtteranceId, PERMISSION_KINDS } from '@pilot/shared';
import {
  EVENT_CHANNELS,
  findEventChannel,
  findRequestChannel,
  REQUEST_CHANNELS,
} from '../../src/ipc/channels.js';
import {
  conversationActionSchema,
  conversationFixtureSchema,
  conversationGateStateSchema,
  interactionCommandSchema,
  permissionActionSchema,
  permissionFixtureSchema,
  permissionGateStateSchema,
  pilotViewStateSchema,
  telemetrySampleSchema,
  windowActionSchema,
  windowDemoEventSchema,
  windowGateStateSchema,
  ABORT_CATEGORIES,
  CONVERSATION_FIXTURES,
  DEFAULT_TELEMETRY_CAPACITY,
  OBSERVATION_NOTICE_REASONS,
  PERMISSION_FIXTURES,
  TELEMETRY_METRICS,
  TELEMETRY_METRIC_UNITS,
  WINDOW_DEMO_EVENTS,
  type ConversationAction,
  type ConversationGateState,
  type PermissionAction,
  type PermissionGateState,
  type TelemetryMetric,
  type WindowAction,
  type WindowGateState,
} from '../../src/ipc/schemas.js';
import { PERMISSION_FIXTURE_SNAPSHOTS } from '../../src/main/permission-fixtures.js';
import { assertCatalogueIsComplete, PERMISSION_COPY } from '../../src/permissions/catalog.js';

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
    // Keyed by command type so TypeScript fails the build when @pilot/platform
    // gains a command that has no sample here. The `z.ZodType<InteractionCommand>`
    // annotation on the schema does NOT catch a missing union member — a
    // narrower union stays assignable — which is how `dismiss-error` reached
    // the renderer with no validator behind it.
    const samples: Record<InteractionCommand['type'], InteractionCommand> = {
      'select-window': { type: 'select-window', windowId: FIXTURE_WINDOW_RETINA.windowId },
      'set-observation-enabled': { type: 'set-observation-enabled', enabled: true },
      'push-to-talk-down': { type: 'push-to-talk-down' },
      'push-to-talk-up': { type: 'push-to-talk-up' },
      'submit-text': { type: 'submit-text', text: 'hello' },
      'look-now': { type: 'look-now' },
      interrupt: { type: 'interrupt' },
      'stop-speaking': { type: 'stop-speaking' },
      'clear-conversation': { type: 'clear-conversation' },
      pause: { type: 'pause' },
      resume: { type: 'resume' },
      'dismiss-error': { type: 'dismiss-error' },
    };

    for (const command of Object.values(samples)) {
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

describe('permission action schema', () => {
  it('accepts every permission action the panel can send', () => {
    // Same guard as the interaction commands above, for the same reason: a
    // `z.ZodType<PermissionAction>` annotation stays satisfied by a schema that
    // is missing a union member, so the samples are keyed by action type and
    // TypeScript fails the build when one has no validator.
    const samples: Record<PermissionAction['type'], PermissionAction> = {
      refresh: { type: 'refresh' },
      request: { type: 'request', kind: 'screen-recording' },
      'open-settings': { type: 'open-settings', kind: 'accessibility' },
      'dismiss-error': { type: 'dismiss-error' },
    };

    for (const action of Object.values(samples)) {
      expect(permissionActionSchema.safeParse(action).success).toBe(true);
    }
  });

  it('accepts a request for every permission kind in the contract', () => {
    for (const kind of PERMISSION_KINDS) {
      expect(permissionActionSchema.safeParse({ type: 'request', kind }).success).toBe(true);
    }
  });

  it('rejects an unknown permission kind', () => {
    expect(permissionActionSchema.safeParse({ type: 'request', kind: 'filesystem' }).success).toBe(
      false,
    );
  });

  it('rejects extra properties on a known action', () => {
    expect(
      permissionActionSchema.safeParse({ type: 'refresh', andAlso: 'grant-everything' }).success,
    ).toBe(false);
  });
});

describe('permission gate state schema', () => {
  const base: PermissionGateState = {
    snapshot: FIXTURE_PERMISSIONS_MIXED,
    pending: ['microphone'],
    checkedAt: 1_700_000_000_000,
    settings: { available: false, platform: 'linux', reason: 'no System Settings here' },
    lastError: null,
    fixture: 'mixed',
  };

  it('accepts a fully populated state', () => {
    expect(permissionGateStateSchema.parse(base).snapshot).toEqual(FIXTURE_PERMISSIONS_MIXED);
  });

  it('accepts the pre-first-check state, which is not the same as a denial', () => {
    const parsed = permissionGateStateSchema.parse({
      ...base,
      snapshot: null,
      checkedAt: null,
      fixture: null,
    });
    expect(parsed.snapshot).toBeNull();
  });

  it('rejects a snapshot that is missing a permission', () => {
    const { accessibility: _dropped, ...partial } = FIXTURE_PERMISSIONS_MIXED;
    expect(permissionGateStateSchema.safeParse({ ...base, snapshot: partial }).success).toBe(false);
  });

  it('rejects unknown fields, so nothing rides along on the wire', () => {
    expect(permissionGateStateSchema.safeParse({ ...base, screenshot: 'AAAA' }).success).toBe(
      false,
    );
  });
});

describe('window action schema', () => {
  it('accepts every observation control the panel can operate', () => {
    // Same guard as the two unions above, for the same reason: a
    // `z.ZodType<WindowAction>` annotation stays satisfied by a schema that is
    // missing a union member, so the samples are keyed by action type and
    // TypeScript fails the build when one has no validator behind it.
    const samples: Record<WindowAction['type'], WindowAction> = {
      refresh: { type: 'refresh' },
      select: { type: 'select', windowId: FIXTURE_WINDOW_RETINA.windowId },
      start: { type: 'start' },
      stop: { type: 'stop' },
      pause: { type: 'pause' },
      resume: { type: 'resume' },
      'dismiss-notice': { type: 'dismiss-notice' },
    };

    for (const action of Object.values(samples)) {
      expect(windowActionSchema.safeParse(action).success).toBe(true);
    }
  });

  it('rejects a selection with no window and extra properties on a known action', () => {
    expect(windowActionSchema.safeParse({ type: 'select' }).success).toBe(false);
    expect(windowActionSchema.safeParse({ type: 'start', andAlso: 'record' }).success).toBe(false);
  });

  it('accepts only the demo events the shell knows how to cause', () => {
    for (const event of WINDOW_DEMO_EVENTS) {
      expect(windowDemoEventSchema.safeParse(event).success).toBe(true);
    }
    expect(windowDemoEventSchema.safeParse('capture-everything').success).toBe(false);
  });
});

describe('window gate state schema', () => {
  const base: WindowGateState = {
    windows: [FIXTURE_WINDOW_RETINA],
    listedAt: 1_700_000_000_000,
    listing: false,
    notice: {
      reason: 'selected-window-closed',
      window: FIXTURE_WINDOW_RETINA,
      wasObserving: true,
      at: 1_700_000_000_000,
    },
    lastError: null,
    demoEvents: true,
  };

  it('accepts a fully populated state', () => {
    expect(windowGateStateSchema.parse(base).windows).toEqual([FIXTURE_WINDOW_RETINA]);
  });

  it('accepts the pre-first-list state, which is not the same as "no windows"', () => {
    const parsed = windowGateStateSchema.parse({
      ...base,
      windows: [],
      listedAt: null,
      listing: true,
      notice: null,
    });
    expect(parsed.listedAt).toBeNull();
  });

  it('accepts every notice reason the app can raise', () => {
    for (const reason of OBSERVATION_NOTICE_REASONS) {
      expect(
        windowGateStateSchema.safeParse({ ...base, notice: { ...base.notice, reason } }).success,
      ).toBe(true);
    }
    expect(
      windowGateStateSchema.safeParse({ ...base, notice: { ...base.notice, reason: 'because' } })
        .success,
    ).toBe(false);
  });

  it('rejects a window carrying image bytes, and any unknown field', () => {
    expect(
      windowGateStateSchema.safeParse({
        ...base,
        windows: [{ ...FIXTURE_WINDOW_RETINA, thumbnail: 'AAAA' }],
      }).success,
    ).toBe(false);
    expect(windowGateStateSchema.safeParse({ ...base, frame: 'AAAA' }).success).toBe(false);
  });
});

describe('conversation action schema', () => {
  it('accepts every conversation action the panel can send', () => {
    // Same guard as the three unions above, for the same reason: a
    // `z.ZodType<ConversationAction>` annotation stays satisfied by a schema
    // that is missing a union member, so the samples are keyed by action type
    // and TypeScript fails the build when one has no validator behind it.
    const samples: Record<ConversationAction['type'], ConversationAction> = {
      refresh: { type: 'refresh' },
      'clear-telemetry': { type: 'clear-telemetry' },
      'set-diagnostics-visible': { type: 'set-diagnostics-visible', visible: true },
    };

    for (const action of Object.values(samples)) {
      expect(conversationActionSchema.safeParse(action).success).toBe(true);
    }
  });

  it('rejects a visibility toggle with no value, and extra properties', () => {
    expect(conversationActionSchema.safeParse({ type: 'set-diagnostics-visible' }).success).toBe(
      false,
    );
    expect(
      conversationActionSchema.safeParse({ type: 'refresh', andAlso: 'record-everything' }).success,
    ).toBe(false);
  });

  it('accepts only the fixture conversations the shell knows how to replay', () => {
    for (const fixture of CONVERSATION_FIXTURES) {
      expect(conversationFixtureSchema.safeParse(fixture).success).toBe(true);
    }
    expect(conversationFixtureSchema.safeParse('transcribe-everything').success).toBe(false);
  });
});

describe('telemetry schema', () => {
  const base = {
    seq: 0,
    at: 1_700_000_000_000,
    turn: 1,
    metric: 'stt-duration' as TelemetryMetric,
    value: 1_240,
    category: null,
  };

  it('has a unit for every metric §17 names', () => {
    // Keyed by metric so a new metric with no unit fails the build rather than
    // rendering as a bare number whose meaning nobody can recover.
    for (const metric of TELEMETRY_METRICS) {
      expect(TELEMETRY_METRIC_UNITS[metric]).toBeDefined();
    }
  });

  it('accepts every metric and every category in the closed vocabulary', () => {
    for (const metric of TELEMETRY_METRICS) {
      expect(telemetrySampleSchema.safeParse({ ...base, metric }).success).toBe(true);
    }
    for (const category of ABORT_CATEGORIES) {
      expect(
        telemetrySampleSchema.safeParse({ ...base, metric: 'abort', value: 1, category }).success,
      ).toBe(true);
    }
    expect(
      telemetrySampleSchema.safeParse({ ...base, metric: 'failure', value: 1, category: 'timeout' })
        .success,
    ).toBe(true);
  });

  it('rejects a sample carrying anything that is not a number or a category', () => {
    // The privacy rule, enforced by the wire type rather than by review
    // (system-design §13, §17). Every one of these is a way screen content
    // could have reached a diagnostics panel.
    for (const smuggled of [
      { ...base, note: 'the user asked about Auto Renew' },
      { ...base, frame: 'iVBORw0KGgo' },
      { ...base, details: { windowTitle: 'Billing Settings' } },
      { ...base, userMessage: 'Pilot could not read the screen' },
      { ...base, metric: 'transcript' },
      { ...base, category: 'the user said “what does this do”' },
      { ...base, value: 'fast' },
      { ...base, value: -1 },
    ]) {
      expect(telemetrySampleSchema.safeParse(smuggled).success).toBe(false);
    }
  });
});

describe('conversation gate state schema', () => {
  const base: ConversationGateState = {
    telemetry: {
      samples: [
        {
          seq: 0,
          at: 1_700_000_000_000,
          turn: 1,
          metric: 'stt-duration',
          value: 1_240,
          category: null,
        },
      ],
      capacity: DEFAULT_TELEMETRY_CAPACITY,
      recorded: 1,
      dropped: 0,
    },
    diagnosticsVisible: false,
    pushToTalk: {
      usable: false,
      status: 'unavailable',
      message: 'Type your question instead.',
      blockingPermission: 'accessibility',
      label: 'Right Option',
    },
    disclosure: null,
    fixture: 'spoken-question',
    demoFixtures: true,
  };

  it('accepts a fully populated state', () => {
    expect(conversationGateStateSchema.parse(base).telemetry.samples).toHaveLength(1);
  });

  it('accepts the build with no shortcut and no recogniser, which is not the same as a refusal', () => {
    const parsed = conversationGateStateSchema.parse({
      ...base,
      pushToTalk: null,
      disclosure: null,
      fixture: null,
    });
    expect(parsed.pushToTalk).toBeNull();
  });

  it('rejects a transcript, an image or any unknown field riding along', () => {
    expect(conversationGateStateSchema.safeParse({ ...base, transcript: ['hello'] }).success).toBe(
      false,
    );
    expect(conversationGateStateSchema.safeParse({ ...base, frame: 'AAAA' }).success).toBe(false);
    expect(
      conversationGateStateSchema.safeParse({
        ...base,
        telemetry: { ...base.telemetry, lastQuestion: 'what does this do' },
      }).success,
    ).toBe(false);
  });
});

describe('permission fixtures and catalogue', () => {
  it('has a snapshot behind every fixture name the wire accepts', () => {
    for (const name of PERMISSION_FIXTURES) {
      expect(permissionFixtureSchema.safeParse(name).success).toBe(true);
      expect(PERMISSION_FIXTURE_SNAPSHOTS[name]).toBeDefined();
    }
  });

  it('describes every permission kind in the contract', () => {
    expect(() => assertCatalogueIsComplete()).not.toThrow();
    for (const kind of PERMISSION_KINDS) {
      expect(PERMISSION_COPY[kind].why.length).toBeGreaterThan(0);
    }
  });

  it('never explains a permission in API terms', () => {
    // The onboarding copy is a product promise, not a platform readout. These
    // are the names that keep creeping in from the macOS side of the codebase.
    const apiWords = /TCC|ScreenCaptureKit|AXIsProcessTrusted|SFSpeechRecognizer|AVAudioSession/i;
    for (const kind of PERMISSION_KINDS) {
      const copy = PERMISSION_COPY[kind];
      expect(`${copy.why} ${copy.whenMissing} ${copy.bound}`).not.toMatch(apiWords);
    }
  });
});
