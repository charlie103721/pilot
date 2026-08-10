import type { Api, Model } from '@earendil-works/pi-ai';
import {
  asModelProfileId,
  isLoopbackUrl,
  modelProfileSchema,
  type ModelProfile,
} from '@pilot/shared';
import type { AgentSessionCapabilities } from '@pilot/platform';
import {
  assertCapabilityDecision,
  checkVisualConversation,
  type CapabilityConfidence,
} from './capability.js';

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
   *
   * When omitted, {@link toModelProfileWithProvenance} reports the value as
   * `'assumed'` so nothing downstream can mistake the default for a probe.
   */
  readonly supportsTools?: boolean;
}

/** @deprecated Prefer `isLoopbackUrl` from `@pilot/shared`; kept for source compatibility. */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  return isLoopbackUrl(baseUrl);
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
    isRemote: !isLoopbackUrl(model.baseUrl),
  });
}

export interface ModelProfileWithProvenance {
  readonly profile: ModelProfile;
  /**
   * `'verified'` when the caller stated `supportsTools` explicitly,
   * `'assumed'` when the default was taken. Feed this into the profile store
   * and the capability report so the distinction survives persistence.
   */
  readonly toolSupport: CapabilityConfidence;
}

/** {@link toModelProfile}, but it also tells you how much to trust `supportsTools`. */
export function toModelProfileWithProvenance(
  model: Model<Api>,
  input: ModelProfileInput,
): ModelProfileWithProvenance {
  return {
    profile: toModelProfile(model, input),
    toolSupport: input.supportsTools === undefined ? 'assumed' : 'verified',
  };
}

/** Narrows a full {@link CapabilityReport} to the `@pilot/platform` contract shape. */
export function capabilitiesOf(profile: ModelProfile): AgentSessionCapabilities {
  return { vision: profile.supportsVision, tools: profile.supportsTools };
}

/**
 * Capability gate from system-design §12, applied before any provider request.
 * Throws `unsupported-capability`; the caller may fall back to the degraded,
 * explicitly labelled accessibility/OCR-only mode instead.
 *
 * Kept for source compatibility with PR-005. New code should prefer
 * {@link checkVisualConversation} (typed decision, no exception) or
 * {@link verifyProfileAgainstModel} (also re-probes Pi metadata).
 */
export function assertSupportsVisualConversation(profile: ModelProfile): void {
  assertCapabilityDecision(checkVisualConversation(profile));
}
