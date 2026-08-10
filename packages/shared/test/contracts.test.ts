import { describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION,
  MVP_SCREEN_CONTEXT_POLICY,
  MVP_SCREEN_POLICY,
  PilotError,
  UNKNOWN_NORMALIZED_POINT,
  UNKNOWN_SCENE_ID,
  asDisplayId,
  asSceneId,
  asWindowId,
  buildGroundedPointer,
  createCounterIdSource,
  createIdFactory,
  deserializePilotError,
  envelopePointerInsideWindow,
  envelopePointerKnown,
  isPointerInsideWindow,
  isSameSceneLineage,
  isSceneObserved,
  modelProfileSchema,
  observeScreenRequestSchema,
  questionEnvelopeSchema,
  sceneStateSchema,
  supportsVisualConversation,
  toPilotError,
  type QuestionAnchor,
  type SceneState,
  type WindowGeometry,
} from '@pilot/shared';

const RETINA_WINDOW: WindowGeometry = {
  windowId: asWindowId('window-retina'),
  displayId: asDisplayId('display-primary'),
  bounds: { x: 100, y: 80, width: 1200, height: 800 },
  scaleFactor: 2,
  captureSize: { width: 2400, height: 1600 },
};

describe('identifiers', () => {
  it('produces reproducible ids from the counter source', () => {
    const first = createIdFactory(createCounterIdSource());
    const second = createIdFactory(createCounterIdSource());
    expect(first.utterance()).toBe(second.utterance());
    expect(first.utterance()).toBe('utt-000002');
  });

  it('rejects empty identifiers at the schema boundary', () => {
    expect(() => asSceneId('')).toThrow();
  });

  it('exposes a contract version', () => {
    expect(CONTRACT_VERSION).toBe(1);
  });
});

describe('error taxonomy', () => {
  it('assigns a domain and a default retryability per code', () => {
    const error = new PilotError('rate-limited', 'Too many observations');
    expect(error.domain).toBe('policy');
    expect(error.retryable).toBe(true);
    expect(new PilotError('permission-denied', 'denied').retryable).toBe(false);
  });

  it('round-trips through serialization', () => {
    const original = new PilotError('protected-content', 'Window blocks capture', {
      userMessage: 'This app prevents Pilot from seeing its window.',
      details: { windowId: 'window-retina' },
    });
    const restored = deserializePilotError(JSON.parse(JSON.stringify(original)));
    expect(restored).toBeInstanceOf(PilotError);
    expect(restored.code).toBe('protected-content');
    expect(restored.userMessage).toBe(original.userMessage);
    expect(restored.details).toEqual({ windowId: 'window-retina' });
  });

  it('normalizes unknown throwables and abort errors', () => {
    expect(toPilotError('boom').code).toBe('internal');
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(toPilotError(abort).code).toBe('cancelled');
    const existing = new PilotError('timeout', 'slow');
    expect(toPilotError(existing)).toBe(existing);
  });
});

describe('scene state', () => {
  const scene: SceneState = sceneStateSchema.parse({
    sceneId: 'scene-0001',
    revision: 4,
    windowId: 'window-retina',
    windowTitle: 'Billing Settings',
    fingerprint: 'fp-1',
    updatedAt: 1_760_000_000_000,
  });

  it('reports whether the model has seen the current revision', () => {
    expect(isSceneObserved(scene)).toBe(false);
    expect(isSceneObserved({ ...scene, lastObservedRevision: 4 })).toBe(true);
  });

  it('detects a lineage change after a new window selection', () => {
    expect(isSameSceneLineage(scene, { ...scene, revision: 5 })).toBe(true);
    expect(isSameSceneLineage(scene, { ...scene, sceneId: asSceneId('scene-0002') })).toBe(false);
  });
});

describe('grounded pointer', () => {
  it('builds a pointer inside the window with the accessibility target', () => {
    const pointer = buildGroundedPointer({ x: 730, y: 495 }, RETINA_WINDOW, {
      role: 'AXCheckBox',
      label: 'Auto Renew',
      value: 'off',
      bounds: { x: 700, y: 480, width: 60, height: 30 },
      isSecure: false,
    });

    expect(isPointerInsideWindow(pointer)).toBe(true);
    expect(pointer.normalizedPoint.x).toBeCloseTo(0.525, 10);
    expect(pointer.capturedPixelPoint?.x).toBeCloseTo(1260, 6);
    expect(pointer.capturedPixelPoint?.y).toBeCloseTo(830, 6);
    expect(pointer.accessibilityTarget?.label).toBe('Auto Renew');
    expect(pointer.accessibilityTarget?.normalizedBounds).toEqual({
      x: 0.5,
      y: 0.5,
      width: 0.05,
      height: 0.0375,
    });
  });

  it('never carries the value of a secure field', () => {
    const pointer = buildGroundedPointer({ x: 500, y: 610 }, RETINA_WINDOW, {
      role: 'AXTextField',
      label: 'Password',
      value: 'hunter2',
      isSecure: true,
    });
    expect(pointer.accessibilityTarget?.value).toBeUndefined();
    expect(JSON.stringify(pointer)).not.toContain('hunter2');
  });

  it('reports a pointer outside the window instead of inventing a target', () => {
    const pointer = buildGroundedPointer({ x: -500, y: 495 }, RETINA_WINDOW);
    expect(isPointerInsideWindow(pointer)).toBe(false);
    expect(pointer.accessibilityTarget).toBeUndefined();
  });
});

describe('question envelope', () => {
  it('accepts a valid envelope and rejects image payloads', () => {
    const envelope = questionEnvelopeSchema.parse({
      utteranceId: 'utt-0001',
      transcript: 'What is this?',
      conversationId: 'conv-0001',
      scene: { id: 'scene-0001', revision: 4, lastObservedRevision: 3, windowTitle: 'Billing' },
      pointer: { normalizedX: 0.5, normalizedY: 0.5 },
    });
    expect(envelopePointerInsideWindow(envelope)).toBe(true);

    expect(() =>
      questionEnvelopeSchema.parse({
        utteranceId: 'utt-0001',
        transcript: 'What is this?',
        conversationId: 'conv-0001',
        scene: { id: 'scene-0001', revision: 4, windowTitle: 'Billing' },
        pointer: { normalizedX: 0.5, normalizedY: 0.5 },
        image: 'AAAA',
      }),
    ).toThrow();
  });

  it('reports an out-of-window pointer', () => {
    const envelope = questionEnvelopeSchema.parse({
      utteranceId: 'utt-0002',
      transcript: 'And this?',
      conversationId: 'conv-0001',
      scene: { id: 'scene-0001', revision: 4, windowTitle: 'Billing' },
      pointer: { normalizedX: 1.4, normalizedY: 0.5 },
    });
    expect(envelopePointerInsideWindow(envelope)).toBe(false);
  });

  /** PR-024 added `anchor`; the field is optional so PR-001 envelopes still parse. */
  it('treats the anchor as additive', () => {
    const withoutAnchor = questionEnvelopeSchema.parse({
      utteranceId: 'utt-0003',
      transcript: 'Still valid?',
      conversationId: 'conv-0001',
      scene: { id: 'scene-0001', revision: 4, windowTitle: 'Billing' },
      pointer: { normalizedX: 0.5, normalizedY: 0.5 },
    });
    expect(withoutAnchor.anchor).toBeUndefined();
    expect(envelopePointerKnown(withoutAnchor)).toBe(true);

    const anchor: QuestionAnchor = {
      grounding: 'pointer-unknown',
      utteranceStartedAt: 1_000,
      utteranceEndedAt: 2_000,
      pointerSampleCount: 0,
      pointerCrossedWindowBorder: false,
      sceneRevisedDuringUtterance: false,
      observationStale: true,
      targetAvailability: 'none',
    };
    const unknownPointer = questionEnvelopeSchema.parse({
      utteranceId: 'utt-0004',
      transcript: 'Where am I pointing?',
      conversationId: 'conv-0001',
      scene: { id: UNKNOWN_SCENE_ID, revision: 0, windowTitle: '' },
      pointer: { ...UNKNOWN_NORMALIZED_POINT },
      anchor,
    });
    // The sentinel is never mistaken for a position.
    expect(envelopePointerKnown(unknownPointer)).toBe(false);
    expect(envelopePointerInsideWindow(unknownPointer)).toBe(false);
  });
});

describe('observe_screen request', () => {
  it('accepts every documented view/moment combination', () => {
    for (const view of ['pointer', 'window', 'both'] as const) {
      for (const moment of ['question', 'current', 'before-and-after'] as const) {
        expect(observeScreenRequestSchema.parse({ view, moment })).toEqual({ view, moment });
      }
    }
  });

  it('rejects undocumented values', () => {
    expect(() =>
      observeScreenRequestSchema.parse({ view: 'display', moment: 'current' }),
    ).toThrow();
  });
});

describe('screen policy', () => {
  it('exposes the mvp-01 §10 constants', () => {
    expect(MVP_SCREEN_POLICY.fullFrameMaxEdge).toBe(1440);
    expect(MVP_SCREEN_POLICY.pointerCropPixels).toBe(640);
    expect(MVP_SCREEN_POLICY.ringDurationMs).toBe(3000);
    expect(MVP_SCREEN_POLICY.persistRawFrames).toBe(false);
  });

  it('maps onto the system-design §10 structured policy', () => {
    expect(MVP_SCREEN_CONTEXT_POLICY).toEqual({
      capture: { selectedWindowOnly: true, maxRequestsPerSecond: 2 },
      image: { fullFrameMaxEdge: 1440, pointerCropPixels: 640, jpegQuality: 0.75 },
      activeContext: { maxFullFrames: 1, maxPointerCrops: 1, maxComparisonFrames: 2 },
      localBuffer: { durationMs: 3000, persist: false },
    });
  });
});

describe('model profile', () => {
  it('gates visual conversations on vision and tools', () => {
    const profile = modelProfileSchema.parse({
      id: 'profile-1',
      provider: 'fake',
      model: 'fake-vision-1',
      authMode: 'local',
      baseUrl: 'http://localhost:11434/v1',
      supportsVision: true,
      supportsTools: true,
      isRemote: false,
    });
    expect(supportsVisualConversation(profile)).toBe(true);
    expect(supportsVisualConversation({ ...profile, supportsVision: false })).toBe(false);
  });

  it('rejects an unknown auth mode', () => {
    expect(() =>
      modelProfileSchema.parse({
        id: 'profile-1',
        provider: 'fake',
        model: 'fake-1',
        authMode: 'oauth',
        supportsVision: true,
        supportsTools: true,
        isRemote: true,
      }),
    ).toThrow();
  });
});
