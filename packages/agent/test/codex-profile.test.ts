import { describe, expect, it } from 'vitest';
import { asConversationId, asUtteranceId, type QuestionEnvelope } from '@pilot/shared';
import type { AgentEvent, AgentSession } from '@pilot/platform';
import {
  CODEX_PREFERRED_MODELS,
  CODEX_PROVIDER_ID,
  CODEX_TEXT_ONLY_MODEL,
  codexProfileId,
  createCodexAgentSession,
  createCodexModelSource,
  createFakeCodexModelSource,
  selectCodexModel,
} from '../src/index.js';

/**
 * The Codex `ModelSource` (PR-037).
 *
 * The claims under test, in the order they would cost most if they broke:
 *
 *  1. **A text-only model is refused, with nothing sent.** `requestCount()`
 *     must be zero. Pi ignores images for a non-vision model rather than
 *     erroring, so this is the only thing standing between the user and a
 *     confident answer about a screen the model never saw.
 *  2. **A signed-out or expired profile costs zero provider requests**, and the
 *     refusal happens at `submit()` — before the run starts, therefore before
 *     the model can call `observe_screen`.
 *  3. **Pi's own refresh failure reaches the user as a sentence they can act
 *     on**, not as `OAuth refresh failed for openai-codex`.
 *  4. **The description never says "signed in" when it is not.**
 */

const CONVERSATION = asConversationId('conv-codex');

function envelope(transcript = 'What is this?'): QuestionEnvelope {
  return {
    utteranceId: asUtteranceId(`utt-${String(Math.random()).slice(2, 8)}`),
    transcript,
    conversationId: CONVERSATION,
    scene: { id: 'scene-1', revision: 1, windowTitle: 'Billing', lastObservedRevision: 0 },
    pointer: { normalizedX: 0.5, normalizedY: 0.5, targetRole: 'button', targetLabel: 'Renew' },
  };
}

describe('model selection', () => {
  it('prefers a vision model from the recorded preference order', () => {
    const source = createFakeCodexModelSource();
    expect(source.profile.model).toBe(CODEX_PREFERRED_MODELS[0]);
    expect(source.profile.supportsVision).toBe(true);
    expect(source.visionModels).toContain('gpt-5.4');
    expect(source.visionModels).not.toContain(CODEX_TEXT_ONLY_MODEL);
  });

  it('projects the Pi model onto system-design §12’s profile', () => {
    const source = createFakeCodexModelSource();
    expect(source.profile).toMatchObject({
      id: codexProfileId(source.profile.model),
      provider: CODEX_PROVIDER_ID,
      authMode: 'subscription',
      supportsVision: true,
      // Configured, not probed: Pi carries no tool metadata at all.
      supportsTools: true,
      isRemote: true,
    });
    expect(source.toolSupport).toBe('verified');
  });

  it('is a hosted endpoint, so PR-036’s context-window rule believes it', () => {
    const source = createFakeCodexModelSource();
    // `resolveContextWindow` takes the "model" branch for a remote endpoint.
    // Asserted here rather than in the desktop suite because it is a property
    // of the profile, not of the wiring.
    expect(source.profile.isRemote).toBe(true);
    expect(source.model.contextWindow).toBeGreaterThan(32_768);
  });

  it('honours a model the caller names, including the text-only one', () => {
    const source = createFakeCodexModelSource({ model: CODEX_TEXT_ONLY_MODEL });
    expect(source.profile.model).toBe(CODEX_TEXT_ONLY_MODEL);
    expect(source.profile.supportsVision).toBe(false);
  });

  it('refuses a model the provider does not have, naming what it does have', () => {
    const source = createFakeCodexModelSource();
    expect(() => selectCodexModel(source.models, 'gpt-9-imaginary')).toThrow(/gpt-5\.5/);
  });
});

describe('the capability gate', () => {
  it('accepts a vision model', () => {
    const source = createFakeCodexModelSource();
    expect(source.capability.ok).toBe(true);
  });

  it('refuses the text-only model with the reason and the remedy', () => {
    const source = createFakeCodexModelSource({ model: CODEX_TEXT_ONLY_MODEL });
    expect(source.capability.ok).toBe(false);
    if (source.capability.ok) {
      throw new Error('unreachable');
    }
    expect(source.capability.refusal.reason).toBe('no-vision');
    expect(source.capability.refusal.userMessage).toMatch(/cannot see images/);
    expect(source.capability.report.facts.vision.source).toBe('pi-model-metadata');
    expect(source.capability.report.facts.tools.confidence).toBe('verified');
  });

  it('takes the decision without making a provider request', () => {
    const source = createFakeCodexModelSource({ model: CODEX_TEXT_ONLY_MODEL });
    expect(source.requestCount()).toBe(0);
  });
});

describe('the guarded, counting Models', () => {
  it('refuses to open a request while signed out, and counts none', () => {
    const source = createFakeCodexModelSource({ script: [{ say: 'never' }] });
    expect(() => source.models.streamSimple(source.model, { messages: [] })).toThrow(
      /no credential is configured/,
    );
    expect(source.requestCount()).toBe(0);
  });

  it('counts one request per call, through every entry point', async () => {
    const source = createFakeCodexModelSource({ script: [{ say: 'a' }, { say: 'b' }] });
    await source.auth.signIn({ deviceCode: () => undefined });
    const context = {
      messages: [{ role: 'user' as const, content: 'hi', timestamp: Date.now() }],
    };
    await source.models.completeSimple(source.model, context);
    expect(source.requestCount()).toBe(1);
    await source.models.streamSimple(source.model, context).result();
    expect(source.requestCount()).toBe(2);
  });

  it('refuses once the stored credential has actually expired', async () => {
    const source = createFakeCodexModelSource({ script: [{ say: 'a' }] });
    await source.auth.signIn({ deviceCode: () => undefined });
    await source.surface.expireIn(-1);
    await source.auth.refresh();
    expect(() => source.models.streamSimple(source.model, { messages: [] })).toThrow(/expired/);
  });
});

describe('the description stays honest', () => {
  it('says NOT SIGNED IN before a sign-in', () => {
    expect(createFakeCodexModelSource().description).toContain('NOT SIGNED IN');
  });

  it('says signed in afterwards, and expired after that', async () => {
    const source = createFakeCodexModelSource();
    await source.auth.signIn({ deviceCode: () => undefined });
    expect(source.description).toContain('signed in');
    expect(source.description).not.toContain('NOT SIGNED IN');
    await source.surface.expireIn(-1);
    await source.auth.refresh();
    expect(source.description).toContain('SIGN-IN EXPIRED');
  });

  it('names the capability refusal, so a refused profile cannot read as working', () => {
    const source = createFakeCodexModelSource({ model: CODEX_TEXT_ONLY_MODEL });
    expect(source.description).toContain('REFUSED BY THE CAPABILITY GATE');
  });
});

/* -------------------------------------------------------------------------- *
 * The session decorator
 * -------------------------------------------------------------------------- */

function stubSession(): AgentSession & {
  readonly submitted: string[];
  emit(event: AgentEvent): void;
} {
  const listeners = new Set<(event: AgentEvent) => void>();
  const submitted: string[] = [];
  return {
    conversationId: CONVERSATION,
    profile: createFakeCodexModelSource().profile,
    submitted,
    emit(event) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async submit(question) {
      submitted.push(question.transcript);
      return { runId: 'run-1' as never, completed: Promise.resolve() };
    },
    async interrupt() {
      return undefined;
    },
    async dispose() {
      listeners.clear();
    },
  };
}

describe('createCodexAgentSession', () => {
  it('refuses a question before the run starts when nothing is signed in', async () => {
    const source = createFakeCodexModelSource();
    const inner = stubSession();
    const session = createCodexAgentSession(inner, source.auth);
    await expect(session.submit(envelope())).rejects.toMatchObject({
      code: 'authentication-required',
      userMessage: expect.stringContaining('Sign in') as unknown as string,
    });
    // The whole ordering claim, as one assertion: the inner session — and
    // therefore Pi, and therefore `observe_screen` — was never reached.
    expect(inner.submitted).toEqual([]);
  });

  it('lets the question through once signed in', async () => {
    const source = createFakeCodexModelSource();
    await source.auth.signIn({ deviceCode: () => undefined });
    const inner = stubSession();
    const session = createCodexAgentSession(inner, source.auth);
    await session.submit(envelope('What is this?'));
    expect(inner.submitted).toEqual(['What is this?']);
  });

  it('re-reads the store, so a token that expired since the last read is caught', async () => {
    const source = createFakeCodexModelSource();
    await source.auth.signIn({ deviceCode: () => undefined });
    const inner = stubSession();
    const session = createCodexAgentSession(inner, source.auth);
    await source.surface.expireIn(-1);
    await expect(session.submit(envelope())).rejects.toMatchObject({
      details: { reason: 'expired' },
    });
    expect(inner.submitted).toEqual([]);
  });

  it('rewrites Pi’s refresh failure into a sentence the user can act on', async () => {
    const source = createFakeCodexModelSource();
    const inner = stubSession();
    const session = createCodexAgentSession(inner, source.auth);
    const seen: AgentEvent[] = [];
    session.subscribe((event) => seen.push(event));
    inner.emit({
      type: 'run-failed',
      runId: 'run-1' as never,
      error: {
        name: 'PilotError',
        code: 'provider-unavailable',
        domain: 'agent',
        message: 'OAuth refresh failed for openai-codex: token refresh failed (400)',
        userMessage: 'OAuth refresh failed for openai-codex: token refresh failed (400)',
        retryable: true,
      },
    });
    const [event] = seen;
    expect(event?.type).toBe('run-failed');
    expect(event).toMatchObject({
      error: {
        code: 'authentication-required',
        userMessage:
          'Pilot’s ChatGPT sign-in could not be renewed. Sign in again to keep asking questions.',
      },
    });
  });

  it('leaves a failure that is not an auth failure exactly as it was', () => {
    const source = createFakeCodexModelSource();
    const inner = stubSession();
    const session = createCodexAgentSession(inner, source.auth);
    const seen: AgentEvent[] = [];
    session.subscribe((event) => seen.push(event));
    const original: AgentEvent = {
      type: 'run-failed',
      runId: 'run-1' as never,
      error: {
        name: 'PilotError',
        code: 'capture-failed',
        domain: 'observation',
        message: 'the window closed',
        userMessage: 'Pilot lost sight of that window.',
        retryable: true,
      },
    };
    inner.emit(original);
    expect(seen[0]).toEqual(original);
  });

  it('forwards everything else untouched, including the absence of clearConversation', async () => {
    const source = createFakeCodexModelSource();
    const inner = stubSession();
    const session = createCodexAgentSession(inner, source.auth);
    expect(session.profile).toEqual(inner.profile);
    expect(session.conversationId).toBe(CONVERSATION);
    // PR-036 relies on `clearConversation` being optional; a decorator that
    // invented one would make `session.clearConversation?.()` always fire.
    expect(session.clearConversation).toBeUndefined();
    await session.dispose();
  });
});

describe('createCodexModelSource over the real provider', () => {
  it('registers the real openai-codex provider when given a bare collection', () => {
    const source = createCodexModelSource();
    expect(source.models.getProvider(CODEX_PROVIDER_ID)?.auth.oauth?.isSubscription).toBe(true);
    expect(source.profile.baseUrl).toBe('https://chatgpt.com/backend-api');
    // No credential in this environment, and building it must not need one.
    expect(source.auth.snapshot().state).toBe('signed-out');
    expect(source.requestCount()).toBe(0);
  });
});
