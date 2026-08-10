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
  asDisplayId,
  asModelProfileId,
  asSceneId,
  asUtteranceId,
  asWindowId,
  type ModelProfile,
  type ObservedWindow,
  type ObserveScreenRequest,
  type QuestionEnvelope,
  type SceneState,
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

/**
 * The window `observe_screen` is allowed to look at, and nothing else. The
 * selected-window-only tests key off this identity.
 */
export const SELECTED_WINDOW: ObservedWindow = {
  windowId: asWindowId('window-billing'),
  displayId: asDisplayId('display-primary'),
  title: 'Billing settings',
  applicationName: 'Safari',
  bounds: { x: 100, y: 80, width: 1200, height: 800 },
  scaleFactor: 2,
  isOnScreen: true,
};

export const SELECTED_SCENE: SceneState = {
  sceneId: asSceneId('scene-17'),
  revision: 4,
  windowId: SELECTED_WINDOW.windowId,
  windowTitle: SELECTED_WINDOW.title,
  fingerprint: 'fingerprint-17',
  updatedAt: 1_700_000_000_000,
};

export function screenStatus(overrides: Partial<ScreenStatus> = {}): ScreenStatus {
  return {
    enabled: true,
    paused: false,
    selectedWindow: SELECTED_WINDOW,
    scene: SELECTED_SCENE,
    permissions: { screenRecording: 'granted', accessibility: 'granted' },
    buffer: {
      frameCount: 9,
      byteCount: 9 * 64,
      oldestFrameAt: 1_700_000_000_000,
      newestFrameAt: 1_700_000_002_664,
    },
    lastError: null,
    ...overrides,
  };
}

export interface FakeScreenContext extends ScreenContextService {
  readonly requests: ObserveScreenRequest[];
  /** Signals seen by `observe`, so tests can assert the abort signal is passed on. */
  readonly signals: (AbortSignal | undefined)[];
  status(): ScreenStatus;
}

export interface FakeScreenContextOptions {
  /** Snapshot returned by `status()`. Defaults to "the selected window is live". */
  readonly status?: ScreenStatus;
  /** Runs before the result is produced; lets a test abort mid-observation. */
  readonly onObserve?: (signal: AbortSignal | undefined) => void | Promise<void>;
}

/**
 * Minimal `ScreenContextService` that returns a fixture or throws.
 *
 * Deliberately *not* `FakeScreenContextService` from `@pilot/platform/fakes`:
 * these tests need to script one exact outcome per case, including outcomes a
 * well-behaved service would never produce (an observation from a scene that is
 * not the selected window). The contract is the same one.
 */
export function fakeScreenContext(
  result: ScreenObservation | Error,
  options: FakeScreenContextOptions = {},
): FakeScreenContext {
  return scriptedScreenContext([result], options);
}

/**
 * `ScreenContextService` that walks a script, one outcome per `observe` call.
 *
 * PR-022a needs a *sequence* of observations — several in a row, a comparison,
 * a scene change — to show active-context limits holding across turns. The last
 * entry repeats once the script runs out, so a test never fails because it
 * mis-counted turns.
 */
export function scriptedScreenContext(
  results: readonly (ScreenObservation | Error)[],
  options: FakeScreenContextOptions = {},
): FakeScreenContext {
  const requests: ObserveScreenRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const status = options.status ?? screenStatus();
  let index = 0;
  return {
    requests,
    signals,
    status: () => status,
    observe: async (request, signal) => {
      requests.push(request);
      signals.push(signal);
      await options.onObserve?.(signal);
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      if (result === undefined) {
        throw new Error('scriptedScreenContext was given no results');
      }
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    clear: () => undefined,
  };
}

/**
 * Distinct, real base64 for a fixture image.
 *
 * Distinct matters: the transcript-is-unmutated proof asserts that *every*
 * payload the tool ever produced is still in `session.messages`, which a shared
 * fixture string could not tell apart.
 */
export function fixtureImageBase64(tag: string, repeats = 8): string {
  return Buffer.from(`${tag}-`.repeat(repeats)).toString('base64');
}
