import { z } from 'zod';
import { modelProfileIdSchema } from './ids.js';

/**
 * Model profile (system-design §12), verbatim apart from `id` carrying the
 * `ModelProfileId` brand.
 *
 * PROVISIONAL: PR-005 probes the pinned Pi release and may add fields (for
 * example real capability metadata or provider-specific auth hints). Consumers
 * should treat unknown extra fields as possible and re-parse rather than cast.
 */
export const modelProfileSchema = z.strictObject({
  id: modelProfileIdSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  authMode: z.enum(['subscription', 'api-key', 'local']),
  baseUrl: z.url().optional(),
  supportsVision: z.boolean(),
  supportsTools: z.boolean(),
  isRemote: z.boolean(),
});

export type ModelProfile = z.infer<typeof modelProfileSchema>;

/**
 * A visual conversation requires both vision and tool calling. A profile that
 * fails this check may still be used in the degraded, explicitly labelled
 * accessibility/OCR-only mode (system-design §12).
 */
export function supportsVisualConversation(profile: ModelProfile): boolean {
  return profile.supportsVision && profile.supportsTools;
}

/* ------------------------------------------------------------------------- *
 * Endpoint locality (PR-020)
 *
 * ADDITIVE ONLY. No existing export above was changed, and `ModelProfile`
 * gained no field. Everything below is new, pure, and dependency-free so the
 * renderer can use it: system-design §14 requires the UI to "show whether the
 * configured provider is local or remote before observation begins", and the
 * renderer must never import `@pilot/agent` (which carries the Pi packages).
 * ------------------------------------------------------------------------- */

/**
 * Hosts that mean "this machine". Deliberately narrow: a model served from
 * `192.168.x.x` is on the *network*, not on this Mac, and screen data still
 * leaves the machine to reach it.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
]);

/** Hostname of a base URL, or `null` when it is absent or unparseable. */
export function endpointHost(baseUrl: string | undefined): string | null {
  if (baseUrl === undefined) {
    return null;
  }
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return null;
  }
}

/** True when a base URL points at this machine. Unparseable URLs are not local. */
export function isLoopbackUrl(baseUrl: string): boolean {
  const host = endpointHost(baseUrl);
  return host !== null && LOOPBACK_HOSTNAMES.has(host);
}

export interface EndpointDescription {
  /**
   * What the UI must act on. Fails closed: if the stored flag and the base URL
   * disagree, this is `true`. A privacy claim is only allowed to err toward
   * "your screen leaves this machine".
   */
  readonly isRemote: boolean;
  /** `ModelProfile.isRemote` as stored. */
  readonly declaredRemote: boolean;
  /** Locality implied by the base URL. A missing base URL implies remote. */
  readonly derivedRemote: boolean;
  /** False when `declaredRemote` and `derivedRemote` disagree — a profile bug. */
  readonly consistent: boolean;
  readonly host: string | null;
  /** One short line, safe to render next to the observation controls. */
  readonly label: string;
  /** Longer disclosure for the privacy panel. */
  readonly detail: string;
}

/**
 * Describes where screen data goes for a profile, for display *before*
 * observation begins (system-design §14).
 */
export function describeEndpoint(profile: ModelProfile): EndpointDescription {
  const host = endpointHost(profile.baseUrl);
  const derivedRemote = profile.baseUrl === undefined ? true : !isLoopbackUrl(profile.baseUrl);
  const consistent = derivedRemote === profile.isRemote;
  const isRemote = profile.isRemote || derivedRemote;
  const where = host ?? profile.provider;

  if (!isRemote) {
    return {
      isRemote,
      declaredRemote: profile.isRemote,
      derivedRemote,
      consistent,
      host,
      label: `Local model on this Mac (${where})`,
      detail: `Screen images stay on this Mac. ${profile.provider}/${profile.model} is served from ${where}.`,
    };
  }

  const suffix = consistent
    ? ''
    : ' The saved profile claims this endpoint is local; the base URL says otherwise, so Pilot treats it as remote.';
  return {
    isRemote,
    declaredRemote: profile.isRemote,
    derivedRemote,
    consistent,
    host,
    label: `Remote model — screen images are sent to ${where}`,
    detail: `Screen images leave this Mac and are sent to ${where} for ${profile.provider}/${profile.model}.${suffix}`,
  };
}
