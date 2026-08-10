import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type AssistantMessage,
  type Context,
  type FauxProviderHandle,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import {
  asConversationId,
  asModelProfileId,
  asSceneId,
  asUtteranceId,
  type ModelProfile,
  type ObserveScreenRequest,
  type QuestionEnvelope,
  type ScreenObservation,
  type ScreenStatus,
} from '@pilot/shared';
import type { ScreenContextService } from '@pilot/platform';

export { fauxAssistantMessage, fauxToolCall };

/**
 * A 1x1 transparent PNG. Small enough to inline, unique enough to grep for in
 * a database file — which is exactly what the persistence test does.
 */
export const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export interface FauxHarness {
  readonly faux: FauxProviderHandle;
  readonly models: Models;
  readonly model: Model<Api>;
  /** Provider-visible contexts, newest last. Lets tests assert on what was actually sent. */
  readonly seenContexts: Context[];
}

/**
 * A `Models` collection backed only by Pi's built-in faux provider.
 *
 * No network, no credentials, no environment variables. `fauxProvider()` is
 * shipped by `@earendil-works/pi-ai` for exactly this purpose
 * (`dist/providers/faux.d.ts`).
 */
export function createFauxHarness(
  options: { readonly vision?: boolean; readonly tokensPerSecond?: number } = {},
): FauxHarness & { setResponses(steps: (AssistantMessage | (() => AssistantMessage))[]): void } {
  const seenContexts: Context[] = [];
  const faux = fauxProvider({
    provider: 'pilot-faux',
    models: [
      {
        id: 'faux-model',
        input: options.vision === false ? ['text'] : ['text', 'image'],
      },
    ],
    // Slow the faux stream down so abort/steer tests have a window to act in.
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();

  return {
    faux,
    models,
    model,
    seenContexts,
    setResponses(steps): void {
      faux.setResponses(
        steps.map((step) => (context: Context) => {
          // Tools carry functions, so structuredClone would throw. Snapshot the
          // messages only — that is what assertions care about.
          seenContexts.push({
            ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
            messages: JSON.parse(JSON.stringify(context.messages)) as Context['messages'],
          });
          return typeof step === 'function' ? step() : step;
        }),
      );
    },
  };
}

export const FAUX_PROFILE: ModelProfile = {
  id: asModelProfileId('profile-faux'),
  provider: 'pilot-faux',
  model: 'faux-model',
  authMode: 'local',
  baseUrl: 'http://localhost:0',
  supportsVision: true,
  supportsTools: true,
  isRemote: false,
};

export function envelope(overrides: Partial<QuestionEnvelope> = {}): QuestionEnvelope {
  return {
    utteranceId: asUtteranceId('utt-1'),
    transcript: 'What does this toggle do?',
    conversationId: asConversationId('conv-1'),
    scene: {
      id: 'scene-17',
      revision: 4,
      windowTitle: 'Billing settings',
      lastObservedRevision: 3,
    },
    pointer: {
      normalizedX: 0.42,
      normalizedY: 0.61,
      targetRole: 'switch',
      targetLabel: 'Auto Renew',
    },
    ...overrides,
  };
}

export function observation(overrides: Partial<ScreenObservation> = {}): ScreenObservation {
  return {
    observationId: 'obs-1' as ScreenObservation['observationId'],
    sceneId: asSceneId('scene-17'),
    sceneRevision: 4,
    capturedAt: 1_700_000_000_000,
    windowTitle: 'Billing settings',
    pointer: { x: 0.42, y: 0.61 },
    target: { role: 'switch', label: 'Auto Renew', isSecure: false },
    images: [{ mimeType: 'image/png', base64: PNG_1PX_BASE64, purpose: 'pointer' }],
    ...overrides,
  };
}

const IDLE_STATUS: ScreenStatus = {
  enabled: true,
  paused: false,
  selectedWindow: null,
  scene: null,
  permissions: { screenRecording: 'granted', accessibility: 'granted' },
  buffer: { frameCount: 0, byteCount: 0, oldestFrameAt: null, newestFrameAt: null },
  lastError: null,
};

/** Minimal `ScreenContextService` that returns a fixture or throws. */
export function fakeScreenContext(
  result: ScreenObservation | Error,
): ScreenContextService & { readonly requests: ObserveScreenRequest[] } {
  const requests: ObserveScreenRequest[] = [];
  return {
    requests,
    status: () => IDLE_STATUS,
    observe: async (request) => {
      requests.push(request);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    clear: () => undefined,
  };
}
