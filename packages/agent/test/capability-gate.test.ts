import { describe, expect, it } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { asConversationId, describeEndpoint, type ModelProfile } from '@pilot/shared';
import {
  PiAgentSession,
  buildSystemPrompt,
  checkVisualConversation,
  createObserveScreenTool,
  describeCapabilities,
  toCapabilityError,
  toModelProfileWithProvenance,
  verifyProfileAgainstModel,
} from '../src/index.js';
import {
  createFauxHarness,
  envelope,
  FAUX_PROFILE,
  fakeScreenContext,
  fauxAssistantMessage,
  fauxToolCall,
  observation,
  PNG_1PX_BASE64,
} from './support.js';

/**
 * PR-020 acceptance behaviour.
 *
 * The bug this PR exists to prevent, stated once: `pi-ai` SILENTLY IGNORES
 * images sent to a non-vision model. No error, no warning, a normal-looking
 * answer about a screen the model never saw. So the tests below do not merely
 * check that a refusal happens — they check that it happens *before* any
 * screen data is requested or any provider call is made.
 */

const TEXT_ONLY_PROFILE: ModelProfile = { ...FAUX_PROFILE, supportsVision: false };
const NO_TOOLS_PROFILE: ModelProfile = { ...FAUX_PROFILE, supportsTools: false };

describe('capability gate — sources are split honestly', () => {
  it('attributes vision to Pi metadata and tools to Pilot configuration', () => {
    const report = describeCapabilities(FAUX_PROFILE);
    expect(report.facts.vision).toMatchObject({
      supported: true,
      source: 'pi-model-metadata',
      confidence: 'verified',
    });
    expect(report.facts.vision.evidence).toContain('Model.input');
    expect(report.facts.tools).toMatchObject({
      supported: true,
      source: 'pilot-configuration',
    });
  });

  it('marks a defaulted supportsTools as assumed and an explicit one as verified', () => {
    const harness = createFauxHarness();
    const defaulted = toModelProfileWithProvenance(harness.model, {
      id: 'p-default',
      authMode: 'local',
    });
    expect(defaulted.toolSupport).toBe('assumed');
    expect(defaulted.profile.supportsTools).toBe(true);

    const explicit = toModelProfileWithProvenance(harness.model, {
      id: 'p-explicit',
      authMode: 'local',
      supportsTools: true,
    });
    expect(explicit.toolSupport).toBe('verified');
    expect(
      describeCapabilities(explicit.profile, { toolSupport: 'verified' }).facts.tools,
    ).toMatchObject({ confidence: 'verified' });
  });
});

describe('capability gate — typed refusals', () => {
  it('accepts a profile with both capabilities', () => {
    const decision = checkVisualConversation(FAUX_PROFILE);
    expect(decision.ok).toBe(true);
  });

  it('refuses a non-vision profile with reason no-vision', () => {
    const decision = checkVisualConversation(TEXT_ONLY_PROFILE);
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      throw new Error('unreachable');
    }
    expect(decision.refusal.reason).toBe('no-vision');
    expect(decision.refusal.missing).toEqual(['vision']);
    expect(decision.refusal.userMessage).toMatch(/cannot see images/i);
    expect(decision.refusal.remedy).toMatch(/image input/i);
  });

  it('refuses a no-tools profile separately, naming Pilot configuration as the source', () => {
    const decision = checkVisualConversation(NO_TOOLS_PROFILE);
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      throw new Error('unreachable');
    }
    expect(decision.refusal.reason).toBe('no-tools');
    expect(decision.refusal.message).toContain('Pilot configuration');
  });

  it('refuses a profile missing both, and lists both', () => {
    const decision = checkVisualConversation({
      ...FAUX_PROFILE,
      supportsVision: false,
      supportsTools: false,
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      throw new Error('unreachable');
    }
    expect(decision.refusal.reason).toBe('no-vision-or-tools');
    expect([...decision.refusal.missing].sort()).toEqual(['tools', 'vision']);
  });

  it('surfaces a refusal as a typed, serialisable PilotError carrying its provenance', () => {
    const decision = checkVisualConversation(TEXT_ONLY_PROFILE);
    if (decision.ok) {
      throw new Error('unreachable');
    }
    const error = toCapabilityError(decision.refusal, decision.report);
    expect(error.code).toBe('unsupported-capability');
    expect(error.domain).toBe('agent');
    expect(error.retryable).toBe(false);
    // What the renderer receives over IPC.
    const wire = error.toJSON();
    expect(wire.userMessage).toMatch(/Pick a different model/);
    expect(wire.details).toMatchObject({
      reason: 'no-vision',
      missing: ['vision'],
      visionSource: 'pi-model-metadata',
      toolsSource: 'pilot-configuration',
    });
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
  });
});

describe('capability gate — Pi metadata beats a stale stored profile', () => {
  it('refuses when a saved profile claims vision the live model does not have', () => {
    const harness = createFauxHarness({ vision: false });
    const lying: ModelProfile = { ...FAUX_PROFILE, supportsVision: true };
    const decision = verifyProfileAgainstModel(lying, harness.model);
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      throw new Error('unreachable');
    }
    expect(decision.refusal.reason).toBe('profile-model-mismatch');
    expect(decision.report.vision).toBe(false);
    expect(decision.refusal.message).toContain('Pi metadata wins');
  });

  it('refuses when the profile does not describe the model it was handed', () => {
    const harness = createFauxHarness();
    const decision = verifyProfileAgainstModel(
      { ...FAUX_PROFILE, model: 'some-other-model' },
      harness.model,
    );
    expect(decision.ok).toBe(false);
  });

  it('accepts when profile and Pi metadata agree', () => {
    const harness = createFauxHarness();
    expect(verifyProfileAgainstModel(FAUX_PROFILE, harness.model).ok).toBe(true);
  });

  /**
   * The rule combines with AND in BOTH directions. `supportsVision: false` on a
   * vision-capable model is how an operator puts a model into the degraded,
   * labelled accessibility/OCR-only mode (system-design §12). Letting the probe
   * override it would ship screen images to a model the user asked not to show
   * them to.
   */
  it('does not let a Pi probe grant vision that the profile withheld', () => {
    const harness = createFauxHarness(); // model DOES support images
    const decision = verifyProfileAgainstModel(TEXT_ONLY_PROFILE, harness.model);
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      throw new Error('unreachable');
    }
    expect(decision.report.vision).toBe(false);
    expect(decision.refusal.reason).toBe('no-vision');
    expect(decision.report.facts.vision.evidence).toContain('the stricter of the two wins');
  });
});

describe('capability gate — nothing is sent before the check', () => {
  /**
   * The load-bearing test. A non-vision profile, an `observe_screen` tool wired
   * to a fixture screenshot, and a faux provider ready to answer. If the gate
   * were missing, Pi would happily run the turn and quietly drop the image.
   */
  it('refuses a non-vision profile instead of silently sending an image', async () => {
    const harness = createFauxHarness({ vision: false });
    const screen = fakeScreenContext(observation());
    const tool = createObserveScreenTool({ screenContext: screen });
    harness.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('observe_screen', { view: 'pointer', moment: 'question' })],
        {
          stopReason: 'toolUse',
        },
      ),
      fauxAssistantMessage('That switch turns on automatic renewal.', { stopReason: 'stop' }),
    ]);

    expect(
      () =>
        new PiAgentSession({
          conversationId: asConversationId('conv-blind'),
          profile: TEXT_ONLY_PROFILE,
          models: harness.models,
          model: harness.model,
          systemPrompt: buildSystemPrompt(),
          tools: [tool as unknown as AgentTool<never>],
        }),
    ).toThrow(expect.objectContaining({ code: 'unsupported-capability' }));

    // The three things that must NOT have happened.
    expect(harness.faux.state.callCount).toBe(0);
    expect(screen.requests).toHaveLength(0);
    expect(JSON.stringify(harness.seenContexts)).not.toContain(PNG_1PX_BASE64);
  });

  /**
   * Positive control. Without this, the test above would still pass if
   * `PiAgentSession` were broken in some unrelated way, and we would not know
   * the assertions can detect a leak at all.
   */
  it('positive control: a vision profile really does send the image', async () => {
    const harness = createFauxHarness();
    const screen = fakeScreenContext(observation());
    const tool = createObserveScreenTool({ screenContext: screen });
    harness.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('observe_screen', { view: 'pointer', moment: 'question' })],
        {
          stopReason: 'toolUse',
        },
      ),
      fauxAssistantMessage('That switch turns on automatic renewal.', { stopReason: 'stop' }),
    ]);

    const session = new PiAgentSession({
      conversationId: asConversationId('conv-seeing'),
      profile: FAUX_PROFILE,
      models: harness.models,
      model: harness.model,
      systemPrompt: buildSystemPrompt(),
      tools: [tool as unknown as AgentTool<never>],
    });
    await (
      await session.submit(envelope())
    ).completed;

    expect(harness.faux.state.callCount).toBeGreaterThan(0);
    expect(screen.requests).toHaveLength(1);
    expect(JSON.stringify(harness.seenContexts)).toContain(PNG_1PX_BASE64);
    await session.dispose();
  });

  it('refuses a no-tools profile before constructing the Pi agent', () => {
    const harness = createFauxHarness();
    const screen = fakeScreenContext(observation());
    expect(
      () =>
        new PiAgentSession({
          conversationId: asConversationId('conv-no-tools'),
          profile: NO_TOOLS_PROFILE,
          models: harness.models,
          model: harness.model,
          systemPrompt: buildSystemPrompt(),
          tools: [
            createObserveScreenTool({ screenContext: screen }) as unknown as AgentTool<never>,
          ],
        }),
    ).toThrow(expect.objectContaining({ code: 'unsupported-capability' }));
    expect(harness.faux.state.callCount).toBe(0);
    expect(screen.requests).toHaveLength(0);
  });

  it('exposes the capability report on a session that was allowed', () => {
    const harness = createFauxHarness();
    const session = new PiAgentSession({
      conversationId: asConversationId('conv-report'),
      profile: FAUX_PROFILE,
      models: harness.models,
      model: harness.model,
      systemPrompt: buildSystemPrompt(),
      toolSupport: 'verified',
    });
    expect(session.capabilities).toEqual({ vision: true, tools: true });
    expect(session.capabilityReport.facts.tools.confidence).toBe('verified');
    expect(session.capabilityReport.endpoint.isRemote).toBe(false);
  });
});

describe('endpoint locality', () => {
  it('labels a loopback endpoint as local', () => {
    const endpoint = describeEndpoint(FAUX_PROFILE);
    expect(endpoint.isRemote).toBe(false);
    expect(endpoint.host).toBe('localhost');
    expect(endpoint.label).toMatch(/Local model on this Mac/);
    expect(endpoint.detail).toMatch(/stay on this Mac/);
    expect(endpoint.consistent).toBe(true);
  });

  it('labels a remote endpoint by host and says the screen leaves the machine', () => {
    const endpoint = describeEndpoint({
      ...FAUX_PROFILE,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      authMode: 'api-key',
      baseUrl: 'https://api.anthropic.com',
      isRemote: true,
    });
    expect(endpoint.isRemote).toBe(true);
    expect(endpoint.host).toBe('api.anthropic.com');
    expect(endpoint.label).toContain('api.anthropic.com');
    expect(endpoint.detail).toMatch(/leave this Mac/);
  });

  it('treats a provider-hosted profile with no base URL as remote', () => {
    const { baseUrl: _dropped, ...rest } = FAUX_PROFILE;
    const endpoint = describeEndpoint({ ...rest, provider: 'openai-codex', isRemote: true });
    expect(endpoint.isRemote).toBe(true);
    expect(endpoint.host).toBeNull();
    expect(endpoint.label).toContain('openai-codex');
  });

  it('fails closed when a profile claims local but the base URL is remote', () => {
    const endpoint = describeEndpoint({
      ...FAUX_PROFILE,
      baseUrl: 'https://api.example.com/v1',
      isRemote: false,
    });
    expect(endpoint.consistent).toBe(false);
    expect(endpoint.declaredRemote).toBe(false);
    // The privacy claim is only ever allowed to err toward "remote".
    expect(endpoint.isRemote).toBe(true);
    expect(endpoint.detail).toMatch(/treats it as remote/);
  });

  it('is reported alongside the capability decision', () => {
    const report = describeCapabilities(FAUX_PROFILE);
    expect(report.endpoint.isRemote).toBe(false);
  });
});
