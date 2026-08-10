import type { Api, Model } from '@earendil-works/pi-ai';
import {
  PilotError,
  asModelProfileId,
  modelProfileSchema,
  supportsVisualConversation,
  type ModelProfile,
} from '@pilot/shared';
import type { AgentSessionCapabilities } from '@pilot/platform';

/**
 * How Pilot obtained credentials for a profile. This is Pilot's own axis;
 * Pi models carry no auth-mode field (auth lives on the *provider*, and a
 * provider may offer both `apiKey` and `oauth` at once).
 */
export type PilotAuthMode = ModelProfile['authMode'];

export interface ModelProfileInput {
  /** Stable Pilot-side profile id. */
  readonly id: string;
  readonly authMode: PilotAuthMode;
  /**
   * Whether this model can call tools.
   *
   * MUST be supplied by the caller. Pi's `Model` carries no tool-support
   * metadata of any kind (verified: `@earendil-works/pi-ai`
   * `dist/types.d.ts` `interface Model<TApi>` has `input`, `reasoning`,
   * `cost`, `contextWindow`, `maxTokens`, `thinkingLevelMap`, `compat` — and
   * nothing about tools). Defaults to `true` because every provider Pi ships
   * a chat API for accepts tool definitions; set it to `false` for a model
   * you know does not.
   */
  readonly supportsTools?: boolean;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** True when a base URL points at this machine, i.e. the model is local. */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Projects a Pi `Model` onto the `ModelProfile` from system-design §12.
 *
 * Verified derivations:
 *  - `supportsVision` ← `model.input.includes("image")`. This is the only
 *    capability flag Pi actually reports.
 *  - `isRemote` ← base URL is not loopback. Pi has no locality field.
 *  - `provider` / `model` / `baseUrl` ← read straight off the Pi model.
 *
 * Unverifiable, therefore taken from the caller: `supportsTools`, `authMode`.
 */
export function toModelProfile(model: Model<Api>, input: ModelProfileInput): ModelProfile {
  return modelProfileSchema.parse({
    id: asModelProfileId(input.id),
    provider: model.provider,
    model: model.id,
    authMode: input.authMode,
    baseUrl: model.baseUrl,
    supportsVision: model.input.includes('image'),
    supportsTools: input.supportsTools ?? true,
    isRemote: !isLoopbackBaseUrl(model.baseUrl),
  });
}

export function capabilitiesOf(profile: ModelProfile): AgentSessionCapabilities {
  return { vision: profile.supportsVision, tools: profile.supportsTools };
}

/**
 * Capability gate from system-design §12, applied before any provider request.
 * Throws `unsupported-capability`; the caller may fall back to the degraded,
 * explicitly labelled accessibility/OCR-only mode instead.
 */
export function assertSupportsVisualConversation(profile: ModelProfile): void {
  if (supportsVisualConversation(profile)) {
    return;
  }
  throw new PilotError('unsupported-capability', 'Model lacks vision or tool support', {
    userMessage: 'The selected model cannot look at your screen. Choose another model.',
    details: {
      profileId: profile.id,
      supportsVision: profile.supportsVision,
      supportsTools: profile.supportsTools,
    },
  });
}
