import type { Api, Model } from '@earendil-works/pi-ai';
import {
  PilotError,
  describeEndpoint,
  type EndpointDescription,
  type ModelProfile,
  type ModelProfileId,
} from '@pilot/shared';
import type { AgentSessionCapabilities } from '@pilot/platform';

/**
 * Capability gating (PR-020, system-design §12).
 *
 * WHY THIS IS A CORRECTNESS REQUIREMENT, NOT AN OPTIMISATION
 * ----------------------------------------------------------
 * `@earendil-works/pi-ai`'s README, quoted in `docs/pi-notes.md` §2.3: "If you
 * pass images to a non-vision model, **they are silently ignored**." Pi does
 * not throw, does not warn, and the run completes normally. The user then
 * receives a confident answer about a screen the model never saw.
 *
 * Therefore every check here runs *before* a provider request is constructed,
 * and an unsupported combination is a typed refusal — never a degrade that the
 * user cannot see.
 *
 * HONEST SOURCE SPLIT
 * -------------------
 * The two capabilities are not equally knowable, and this module refuses to
 * pretend otherwise:
 *
 *  - `vision`  — PROBED from Pi. `Model.input` is a `("text" | "image")[]`, so
 *                `input.includes("image")` is ground truth from the provider
 *                catalogue.
 *  - `tools`   — CONFIGURED by Pilot. Pi's `Model` carries no tool metadata of
 *                any kind. `compat.supportsStrictTools` is about constrained
 *                sampling, not tool support (`docs/pi-notes.md` §6.3). There is
 *                nothing to look up, so a profile's `supportsTools` is either
 *                something an operator asserted or a default we assumed.
 */

/** Where a capability value came from. */
export type CapabilitySource =
  /** Read from Pi's `Model` metadata. Ground truth. */
  | 'pi-model-metadata'
  /** Asserted by Pilot configuration. Pi has nothing to check it against. */
  | 'pilot-configuration';

/** How firmly a Pilot-configured value is held. */
export type CapabilityConfidence =
  /** Probed, or explicitly configured by an operator/provider PR. */
  | 'verified'
  /** Taken from a default because nothing could verify it. */
  | 'assumed';

export interface CapabilityFact {
  readonly supported: boolean;
  readonly source: CapabilitySource;
  readonly confidence: CapabilityConfidence;
  /** Plain-language provenance, safe to show in diagnostics. */
  readonly evidence: string;
}

/**
 * Structurally an {@link AgentSessionCapabilities} (so it satisfies the
 * `@pilot/platform` contract unchanged) plus the provenance the contract
 * deliberately does not carry.
 */
export interface CapabilityReport extends AgentSessionCapabilities {
  readonly profileId: ModelProfileId;
  readonly vision: boolean;
  readonly tools: boolean;
  readonly facts: {
    readonly vision: CapabilityFact;
    readonly tools: CapabilityFact;
  };
  readonly endpoint: EndpointDescription;
}

export type MissingCapability = 'vision' | 'tools';

export interface CapabilityRefusal {
  readonly reason: 'no-vision' | 'no-tools' | 'no-vision-or-tools' | 'profile-model-mismatch';
  readonly missing: readonly MissingCapability[];
  /** The only string that may be rendered to a user. */
  readonly userMessage: string;
  /** What the user can actually do about it. */
  readonly remedy: string;
  /** Technical detail for logs and diagnostics. Never contains screen data. */
  readonly message: string;
}

export type CapabilityDecision =
  | { readonly ok: true; readonly report: CapabilityReport }
  | { readonly ok: false; readonly report: CapabilityReport; readonly refusal: CapabilityRefusal };

export interface DescribeCapabilitiesOptions {
  /**
   * Whether `profile.supportsTools` was explicitly configured or merely
   * defaulted. Defaults to `'assumed'`, which is the truthful answer for a
   * profile built by {@link toModelProfile} without an explicit flag.
   */
  readonly toolSupport?: CapabilityConfidence;
}

const VISION_EVIDENCE_YES = 'Pi Model.input includes "image"';
const VISION_EVIDENCE_NO = 'Pi Model.input does not include "image"';
const TOOLS_EVIDENCE_VERIFIED = 'Pilot profile configuration (explicitly set; Pi reports nothing)';
const TOOLS_EVIDENCE_ASSUMED = 'Pilot profile default (Pi reports nothing about tool support)';

/** Builds the capability report for a profile, with provenance attached. */
export function describeCapabilities(
  profile: ModelProfile,
  options: DescribeCapabilitiesOptions = {},
): CapabilityReport {
  const toolConfidence = options.toolSupport ?? 'assumed';
  return {
    profileId: profile.id,
    vision: profile.supportsVision,
    tools: profile.supportsTools,
    facts: {
      vision: {
        supported: profile.supportsVision,
        source: 'pi-model-metadata',
        confidence: 'verified',
        evidence: profile.supportsVision ? VISION_EVIDENCE_YES : VISION_EVIDENCE_NO,
      },
      tools: {
        supported: profile.supportsTools,
        source: 'pilot-configuration',
        confidence: toolConfidence,
        evidence: toolConfidence === 'verified' ? TOOLS_EVIDENCE_VERIFIED : TOOLS_EVIDENCE_ASSUMED,
      },
    },
    endpoint: describeEndpoint(profile),
  };
}

function refusalFor(missing: readonly MissingCapability[]): CapabilityRefusal {
  const lacksVision = missing.includes('vision');
  const lacksTools = missing.includes('tools');
  if (lacksVision && lacksTools) {
    return {
      reason: 'no-vision-or-tools',
      missing,
      userMessage: 'This model cannot look at your screen. Pick a different model to continue.',
      remedy: 'Choose a model that accepts images and can call tools.',
      message: 'Profile supports neither vision nor tools; refusing to start a visual conversation',
    };
  }
  if (lacksVision) {
    return {
      reason: 'no-vision',
      missing,
      userMessage:
        'This model cannot see images, so it cannot answer questions about your screen. Pick a different model to continue.',
      remedy: 'Choose a model whose provider lists image input.',
      message:
        'Profile supportsVision=false (probed from Pi Model.input); a non-vision model silently ignores images, so the request is refused',
    };
  }
  return {
    reason: 'no-tools',
    missing,
    userMessage:
      'This model cannot use Pilot’s screen tool, so it cannot look at your screen. Pick a different model to continue.',
    remedy: 'Choose a model configured with tool support.',
    message:
      'Profile supportsTools=false (Pilot configuration; Pi carries no tool metadata); refusing to start a visual conversation',
  };
}

/**
 * The gate. Call this *before* constructing a request, registering
 * `observe_screen`, or asking the screen-context service for anything.
 */
export function checkVisualConversation(
  profile: ModelProfile,
  options: DescribeCapabilitiesOptions = {},
): CapabilityDecision {
  const report = describeCapabilities(profile, options);
  const missing: MissingCapability[] = [];
  if (!report.vision) {
    missing.push('vision');
  }
  if (!report.tools) {
    missing.push('tools');
  }
  if (missing.length === 0) {
    return { ok: true, report };
  }
  return { ok: false, report, refusal: refusalFor(missing) };
}

/**
 * Cross-checks a stored profile against the Pi model it claims to describe.
 *
 * This closes the hole the profile store alone cannot: a persisted profile is
 * data, and data can be stale or hand-edited. If a profile claims vision but
 * the live `Model.input` says otherwise, believing the profile would put us
 * straight back into the silent-degrade bug.
 *
 * THE COMBINING RULE IS `AND`, IN BOTH DIRECTIONS.
 *
 * Pi metadata can only ever *remove* vision, never grant it:
 *
 *  - profile says yes, Pi says no  → refuse. Trusting the profile would send an
 *    image the model silently drops. Reported as `profile-model-mismatch` so
 *    diagnostics can tell a stale profile from a deliberate setting.
 *  - profile says no, Pi says yes  → refuse. `supportsVision: false` is also
 *    how an operator switches a capable model into the degraded, labelled
 *    accessibility/OCR-only mode (system-design §12). Overriding it with the
 *    probe would ship screen images to a model the user asked not to show them
 *    to — a privacy regression, not a fix.
 *
 * Tools are not cross-checked: there is nothing on `Model` to check against.
 */
export function verifyProfileAgainstModel(
  profile: ModelProfile,
  model: Model<Api>,
  options: DescribeCapabilitiesOptions = {},
): CapabilityDecision {
  const probedVision = model.input.includes('image');
  const effectiveVision = profile.supportsVision && probedVision;
  const declared = describeCapabilities(profile, options);
  const report: CapabilityReport = {
    ...declared,
    vision: effectiveVision,
    facts: {
      ...declared.facts,
      vision: {
        supported: effectiveVision,
        source: 'pi-model-metadata',
        confidence: 'verified',
        evidence:
          probedVision === profile.supportsVision
            ? probedVision
              ? VISION_EVIDENCE_YES
              : VISION_EVIDENCE_NO
            : `${probedVision ? VISION_EVIDENCE_YES : VISION_EVIDENCE_NO}, but the saved profile says supportsVision=${String(profile.supportsVision)}; the stricter of the two wins`,
      },
    },
  };

  const identityMismatch = model.provider !== profile.provider || model.id !== profile.model;
  if (identityMismatch) {
    return {
      ok: false,
      report,
      refusal: {
        reason: 'profile-model-mismatch',
        missing: [],
        userMessage: 'The selected model no longer matches its saved settings. Pick it again.',
        remedy: 'Re-select the model so Pilot can re-read its capabilities.',
        message: `Profile ${profile.provider}/${profile.model} does not describe Pi model ${model.provider}/${model.id}`,
      },
    };
  }

  if (profile.supportsVision && !probedVision) {
    return {
      ok: false,
      report,
      refusal: {
        reason: 'profile-model-mismatch',
        missing: ['vision'],
        userMessage:
          'This model cannot see images, so it cannot answer questions about your screen. Pick a different model to continue.',
        remedy: 'Choose a model whose provider lists image input.',
        message: `Saved profile claims vision but Pi Model.input for ${model.provider}/${model.id} is [${model.input.join(', ')}]; Pi metadata wins`,
      },
    };
  }

  const decision = checkVisualConversation(
    { ...profile, supportsVision: effectiveVision },
    options,
  );
  // Preserve the cross-checked evidence string that `checkVisualConversation`
  // cannot know about.
  return decision.ok ? { ok: true, report } : { ok: false, report, refusal: decision.refusal };
}

/** Turns a refusal into the error the rest of Pilot already knows how to route. */
export function toCapabilityError(
  refusal: CapabilityRefusal,
  report: CapabilityReport,
): PilotError {
  return new PilotError('unsupported-capability', refusal.message, {
    userMessage: refusal.userMessage,
    retryable: false,
    details: {
      profileId: report.profileId,
      reason: refusal.reason,
      missing: [...refusal.missing],
      remedy: refusal.remedy,
      supportsVision: report.vision,
      visionSource: report.facts.vision.source,
      supportsTools: report.tools,
      toolsSource: report.facts.tools.source,
      toolsConfidence: report.facts.tools.confidence,
      endpointIsRemote: report.endpoint.isRemote,
      endpointHost: report.endpoint.host,
    },
  });
}

/** Throws unless `decision.ok`. Convenience for constructors and entry points. */
export function assertCapabilityDecision(decision: CapabilityDecision): CapabilityReport {
  if (decision.ok) {
    return decision.report;
  }
  throw toCapabilityError(decision.refusal, decision.report);
}
