// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { asModelProfileId, type ModelProfile } from '@pilot/shared';
import { FakeInteractionController } from '@pilot/platform/fakes';
import { ConversationPanel } from '../../src/renderer/ConversationPanel.js';
import { describeModelStatus } from '../../src/conversation/model-status.js';
import { buildConversationView } from '../../src/conversation/view-model.js';
import { buildObservationView } from '../../src/observation/view-model.js';
import { buildPermissionOnboardingView } from '../../src/permissions/view-model.js';
import { INITIAL_CONVERSATION_GATE_STATE } from '../../src/renderer/use-conversation.js';
import { modelStatusSchema, type ModelProfileKind } from '../../src/ipc/schemas.js';
import type { ConversationShell } from '../../src/renderer/use-conversation.js';

/**
 * The Model row, rendered (runbook follow-ups 46 and 33; hazard 28).
 *
 * The defect was never in the wording — `main/index.ts` computed all of this
 * and logged it. It was that **nothing rendered it**: the panel's only provider
 * surface was `CodexStatus`, which returns `null` unless the Codex profile is
 * selected, so the three other profiles — including the faux one a packaged
 * Finder launch falls through to — put nothing on screen at all.
 *
 * So what is asserted here is presence: the row is in the DOM, for all four
 * profiles, **before anything has been observed and before any question has
 * been asked**, and the faux one is an `alert` rather than a badge.
 *
 * The panel is rendered directly rather than through `App` and the bridge, for
 * the same reason `model-disclosure.test.tsx` gives: this file is about one
 * row, and the bridge path is covered by `conversation.test.tsx`.
 */

const PROFILES: Readonly<Record<ModelProfileKind, ModelProfile>> = {
  development: {
    id: asModelProfileId('profile-faux'),
    provider: 'pilot-faux',
    model: 'faux-vision',
    authMode: 'local',
    baseUrl: 'http://localhost:0',
    supportsVision: true,
    supportsTools: true,
    isRemote: false,
  },
  codex: {
    id: asModelProfileId('codex:gpt-5.3-codex'),
    provider: 'openai-codex',
    model: 'gpt-5.3-codex',
    authMode: 'subscription',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    supportsVision: true,
    supportsTools: true,
    isRemote: true,
  },
  'api-key': {
    id: asModelProfileId('api-key:recorded-vendor:recorded-vision-pro'),
    provider: 'recorded-vendor',
    model: 'recorded-vision-pro',
    authMode: 'api-key',
    baseUrl: 'https://api.recorded-vendor.example/v1',
    supportsVision: true,
    supportsTools: true,
    isRemote: true,
  },
  local: {
    id: asModelProfileId('local:llama-vision'),
    provider: 'local',
    model: 'llama-vision',
    authMode: 'local',
    baseUrl: 'http://localhost:11434/v1',
    supportsVision: true,
    supportsTools: true,
    isRemote: false,
  },
};

const LAUNCH_FILE = '/Users/someone/Library/Application Support/Pilot/pilot.env';

function shellFor(kind: ModelProfileKind | null, blockedReason: string | null = null) {
  // Through the schema, exactly as the preload validates it.
  const status =
    kind === null
      ? null
      : modelStatusSchema.parse(
          describeModelStatus({
            kind,
            profile: PROFILES[kind],
            blockedReason,
            launchFile: LAUNCH_FILE,
          }),
        );
  const conversation: ConversationShell = {
    gate: { ...INITIAL_CONVERSATION_GATE_STATE, modelStatus: status },
    transportError: null,
    refresh: () => undefined,
    clearTelemetry: () => undefined,
    setDiagnosticsVisible: () => undefined,
    replayFixture: () => undefined,
  };
  return conversation;
}

function panelFor(conversation: ConversationShell) {
  const controller = new FakeInteractionController();
  const view = controller.snapshot();
  const permissions = buildPermissionOnboardingView({
    snapshot: null,
    pending: [],
    checkedAt: null,
    settings: { available: false, platform: 'linux', reason: 'not a Mac' },
    lastError: null,
    fixture: null,
  });
  const observation = buildObservationView({
    gate: {
      windows: [],
      listedAt: null,
      listing: false,
      notice: null,
      lastError: null,
      demoEvents: false,
    },
    view,
    permissions,
  });
  return (
    <ConversationPanel
      view={buildConversationView({ view, gate: conversation.gate, observation })}
      conversation={conversation}
      onCommand={() => undefined}
    />
  );
}

function renderWith(kind: ModelProfileKind | null, blockedReason: string | null = null): void {
  render(panelFor(shellFor(kind, blockedReason)));
}

afterEach(() => {
  cleanup();
});

describe('the Model row', () => {
  it('shouts when Pilot is not talking to a model at all', () => {
    renderWith('development');

    const row = screen.getByTestId('model-status');
    expect(row.getAttribute('data-real-model')).toBe('false');
    expect(row.getAttribute('data-severity')).toBe('critical');
    // An alert, not a badge. This is the case the whole surface exists for.
    expect(row.getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('model-status-headline').textContent).toBe(
      'NOT A REAL MODEL — answers are placeholder text',
    );
    expect(screen.getByTestId('model-status-detail').textContent).toContain(
      'It is not a language model, it never sees your screen, and nothing it says about your ' +
        'screen is true.',
    );
    expect(screen.getByTestId('model-status-locality').textContent).toBe(
      'Nothing is sent anywhere: there is no model to send it to.',
    );
    expect(screen.getByTestId('model-status-remedy').textContent).toContain(LAUNCH_FILE);
    // Before anything was observed and before anything was asked: §14's
    // "before observation begins", as a fact about the DOM.
    expect(screen.getByTestId('transcript-empty')).toBeTruthy();
  });

  it('names the ChatGPT subscription and that the screen leaves the Mac', () => {
    renderWith('codex');
    const row = screen.getByTestId('model-status');
    expect(row.getAttribute('data-profile')).toBe('codex');
    expect(row.getAttribute('data-real-model')).toBe('true');
    expect(row.getAttribute('data-remote')).toBe('true');
    expect(screen.getByTestId('model-status-headline').textContent).toBe(
      'Answering with your ChatGPT subscription',
    );
    expect(screen.getByTestId('model-status-model').textContent).toBe(
      'ChatGPT subscription · openai-codex/gpt-5.3-codex',
    );
    expect(screen.getByTestId('model-status-locality').textContent).toBe(
      'Remote model — screen images are sent to chatgpt.com',
    );
    // Nothing to fix, so no remedy line at all.
    expect(screen.queryByTestId('model-status-remedy')).toBeNull();
  });

  it('names the API-key profile, and never the key', () => {
    renderWith('api-key');
    const row = screen.getByTestId('model-status');
    expect(row.getAttribute('data-profile')).toBe('api-key');
    expect(screen.getByTestId('model-status-headline').textContent).toBe(
      'Answering with your own API key',
    );
    expect(screen.getByTestId('model-status-model').textContent).toBe(
      'Your own API key · recorded-vendor/recorded-vision-pro',
    );
    expect(row.textContent).toContain('api.recorded-vendor.example');
  });

  it('names a local endpoint, and says the screen stays here', () => {
    renderWith('local');
    const row = screen.getByTestId('model-status');
    expect(row.getAttribute('data-profile')).toBe('local');
    expect(row.getAttribute('data-remote')).toBe('false');
    expect(row.getAttribute('data-severity')).toBe('normal');
    expect(row.getAttribute('role')).toBe('note');
    expect(screen.getByTestId('model-status-locality').textContent).toBe(
      'Local model on this Mac (localhost)',
    );
  });

  it('says so when the configured profile cannot answer yet', () => {
    renderWith('codex', 'Pilot is not signed in to ChatGPT.');
    expect(screen.getByTestId('model-status-headline').textContent).toBe(
      'ChatGPT subscription — Pilot cannot answer questions yet',
    );
    expect(screen.getByTestId('model-status-detail').textContent).toContain(
      'Pilot is not signed in to ChatGPT.',
    );
  });

  it('is the first thing in the panel, ahead of both disclosures', () => {
    renderWith('development');
    const panel = screen.getByTestId('conversation');
    const row = screen.getByTestId('model-status');
    const state = screen.getByTestId('conversation-state');
    const children = [...panel.children];
    expect(children.indexOf(row)).toBe(children.indexOf(state) + 1);
  });

  it('shows nothing at all before the main process has said', () => {
    renderWith(null);
    expect(screen.queryByTestId('model-status')).toBeNull();
  });
});

describe('liveness', () => {
  it('follows a profile change without a relaunch', () => {
    // The gate publishes a new `ConversationGateState` on the same
    // `pilot:conversation/changed` event the panel already subscribes to, so a
    // sign-in, a sign-out or a key that stopped working re-renders this row.
    // What that looks like from the panel's side is exactly this: a new gate
    // state in, a different row out, with no remount.
    const { rerender } = render(panelFor(shellFor('development')));
    expect(screen.getByTestId('model-status').getAttribute('data-real-model')).toBe('false');
    expect(screen.getByTestId('model-status-headline').textContent).toContain('NOT A REAL MODEL');

    rerender(panelFor(shellFor('codex')));
    const signedIn = screen.getByTestId('model-status');
    expect(signedIn.getAttribute('data-real-model')).toBe('true');
    expect(signedIn.getAttribute('data-profile')).toBe('codex');
    expect(screen.getByTestId('model-status-headline').textContent).toBe(
      'Answering with your ChatGPT subscription',
    );

    // …and back again, which is the sign-out. A row that only ever got louder
    // would be a row that lies in the other direction.
    rerender(panelFor(shellFor('codex', 'Pilot is not signed in to ChatGPT.')));
    expect(screen.getByTestId('model-status-headline').textContent).toBe(
      'ChatGPT subscription — Pilot cannot answer questions yet',
    );
  });
});
