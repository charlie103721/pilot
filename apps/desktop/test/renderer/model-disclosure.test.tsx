// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { describeModelDataDisclosure, type ModelDataDisclosure } from '@pilot/agent';
import { asModelProfileId, type ModelProfile } from '@pilot/shared';
import { FakeInteractionController } from '@pilot/platform/fakes';
import { ConversationPanel } from '../../src/renderer/ConversationPanel.js';
import { buildConversationView } from '../../src/conversation/view-model.js';
import { buildObservationView } from '../../src/observation/view-model.js';
import { buildPermissionOnboardingView } from '../../src/permissions/view-model.js';
import { INITIAL_CONVERSATION_GATE_STATE } from '../../src/renderer/use-conversation.js';
import { modelDataDisclosureSchema } from '../../src/ipc/schemas.js';
import type { ConversationShell } from '../../src/renderer/use-conversation.js';

/**
 * The remote-data banner, rendered (PR-038; system-design §14).
 *
 * > "Show whether the configured provider is local or remote **before
 * > observation begins**."
 *
 * Two things are asserted and neither can be got from a unit test of the
 * wording: that the banner is in the DOM before anything has been observed, and
 * that its shape survives the IPC schema — the panel is a separate process and
 * a field the schema does not know about never arrives.
 *
 * The panel is rendered directly rather than through `App` and the bridge:
 * this file is about one banner, and the bridge path is already covered by
 * `conversation.test.tsx`.
 */

const REMOTE_PROFILE: ModelProfile = {
  id: asModelProfileId('api-key:recorded-vendor:recorded-vision-pro'),
  provider: 'recorded-vendor',
  model: 'recorded-vision-pro',
  authMode: 'api-key',
  baseUrl: 'https://api.recorded-vendor.example/v1',
  supportsVision: true,
  supportsTools: true,
  isRemote: true,
};

function shell(disclosure: ModelDataDisclosure | null): ConversationShell {
  // Through the schema, exactly as the preload validates it: a disclosure that
  // could not cross the wire fails here rather than in production.
  const parsed = disclosure === null ? null : modelDataDisclosureSchema.parse(disclosure);
  return {
    gate: { ...INITIAL_CONVERSATION_GATE_STATE, modelDisclosure: parsed },
    transportError: null,
    refresh: () => undefined,
    clearTelemetry: () => undefined,
    setDiagnosticsVisible: () => undefined,
    replayFixture: () => undefined,
  };
}

function renderWith(disclosure: ModelDataDisclosure | null): void {
  const controller = new FakeInteractionController();
  const conversation = shell(disclosure);
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
  render(
    <ConversationPanel
      view={buildConversationView({ view, gate: conversation.gate, observation })}
      conversation={conversation}
      onCommand={() => undefined}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe('the remote-data banner', () => {
  it('is on screen before anything has been observed, and says where the screen goes', () => {
    renderWith(
      describeModelDataDisclosure({
        profile: REMOTE_PROFILE,
        credential: {
          providerId: 'recorded-vendor',
          configured: true,
          kind: 'api_key',
          source: 'stored credential',
          expiresAt: null,
          isSubscription: false,
        },
        storageName: 'the macOS Keychain',
        verification: 'verified',
      }),
    );

    const banner = screen.getByTestId('model-disclosure');
    expect(banner.getAttribute('data-remote')).toBe('true');
    expect(banner.getAttribute('data-verification')).toBe('verified');
    // Loud, because screen data leaves the machine.
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('Screen images are sent to api.recorded-vendor.example');
    expect(banner.textContent).toContain('The request is made with your API key.');
    expect(screen.getByTestId('model-disclosure-destination').textContent).toBe(
      'sent to api.recorded-vendor.example',
    );
    expect(screen.getByTestId('model-disclosure-credential').textContent).toContain(
      'the macOS Keychain',
    );
    // Nothing has been observed yet: the transcript is empty and the banner is
    // already there, which is the whole of §14's "before observation begins".
    expect(screen.getByTestId('transcript-empty')).toBeTruthy();
  });

  it('says so when the model has not been verified, rather than looking like it works', () => {
    renderWith(
      describeModelDataDisclosure({ profile: REMOTE_PROFILE, verification: 'unverified' }),
    );
    const banner = screen.getByTestId('model-disclosure');
    expect(banner.getAttribute('data-verification')).toBe('unverified');
    expect(screen.getByTestId('model-disclosure-verification').textContent).toBe('unverified');
    expect(banner.textContent).toContain('has not yet confirmed');
    // No credential configured, so no credential line at all.
    expect(screen.queryByTestId('model-disclosure-credential')).toBeNull();
  });

  it('reads the other way for a loopback endpoint — PR-039’s contrast case', () => {
    renderWith(
      describeModelDataDisclosure({
        profile: {
          ...REMOTE_PROFILE,
          authMode: 'local',
          baseUrl: 'http://localhost:11434/v1',
          isRemote: false,
        },
        verification: 'verified',
      }),
    );
    const banner = screen.getByTestId('model-disclosure');
    expect(banner.getAttribute('data-remote')).toBe('false');
    expect(banner.getAttribute('role')).toBe('note');
    expect(banner.textContent).toContain('Screen images stay on this Mac');
    expect(screen.getByTestId('model-disclosure-destination').textContent).toBe(
      'stay on this Mac (localhost)',
    );
  });

  it('shows no banner at all when the main process has not said', () => {
    renderWith(null);
    expect(screen.queryByTestId('model-disclosure')).toBeNull();
  });
});
