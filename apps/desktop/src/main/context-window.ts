import type { ModelProfile } from '@pilot/shared';
import type { ModelSource } from '@pilot/agent';

/**
 * How big the model's context window is *taken to be* (PR-036, runbook
 * follow-ups 7 and 9).
 *
 * `PiAgentSession` defaults `compaction.contextWindow` to `model.contextWindow`
 * — the number the provider advertises. That default is right for a hosted
 * model and wrong for a local one: an OpenAI-compatible endpoint reports
 * whatever its configuration file says, and a 7B model served with a 128k rope
 * scale does not *handle* 128k, it degrades. §11's "estimated model context
 * usage exceeds 60%" trigger is measured against this number, so trusting an
 * inflated one means compaction never fires and the conversation grows until
 * the endpoint truncates it — silently, in the middle, which is the one failure
 * mode a summary exists to prevent.
 *
 * The rule is deliberately small, pure and exported, because it is the kind of
 * wiring that is easy to get subtly wrong and impossible to notice afterwards:
 *
 * | profile | advertised | resolved | reason |
 * | --- | --- | --- | --- |
 * | remote (hosted) | any positive | advertised | the provider is the authority |
 * | local (loopback base URL) | ≤ ceiling | advertised | it fits already |
 * | local | > ceiling | {@link CONSERVATIVE_CONTEXT_WINDOW} | `local-ceiling` |
 * | any | absent, zero or not finite | {@link CONSERVATIVE_CONTEXT_WINDOW} | `unknown` |
 * | any | — | `PILOT_CONTEXT_WINDOW` | `override` |
 *
 * Locality is read from `ModelProfile.isRemote`, which `toModelProfile` derives
 * from the base URL being loopback — the same fact §14 makes the panel show
 * before an observation is sent. `authMode: 'local'` is a *credential* axis and
 * is deliberately not consulted: an API key against a loopback endpoint is
 * still a local model.
 *
 * Note what this is not: it is not a probe. Nothing here measures what the
 * endpoint really handles; it declines to trust a number it cannot check and
 * says which of the five rows above produced the answer, so a diagnostics line
 * can report `local-ceiling` rather than an unexplained integer. PR-039 owns
 * the local-profile UI and can let the user raise it.
 */

/**
 * The window Pilot assumes when it cannot trust the advertised one.
 *
 * `docs/pi-notes.md` §9.3 sizes a local OpenAI-compatible deployment at 32 768
 * tokens (the Qwen2.5-VL configuration recorded there), and 8k and 16k are
 * common. Compaction's `provider-headroom` input — Pi's own `shouldCompact` —
 * degenerates to "always compact" at or below its fixed 16 384-token reserve
 * (`packages/agent/src/compaction.ts`), so anything smaller than that would
 * fold on every single turn. 32 768 is the smallest value that is both a real
 * local deployment size and above that reserve.
 */
export const CONSERVATIVE_CONTEXT_WINDOW = 32_768;

/** Why {@link resolveContextWindow} answered what it answered. */
export type ContextWindowSource =
  /** The provider's own number, trusted. */
  | 'model'
  /** A local endpoint advertising more than {@link CONSERVATIVE_CONTEXT_WINDOW}. */
  | 'local-ceiling'
  /** No usable number was advertised at all. */
  | 'unknown'
  /** `PILOT_CONTEXT_WINDOW` in the environment. */
  | 'override';

export interface ContextWindowDecision {
  /** What `SessionCompactionOptions.contextWindow` is set to. */
  readonly contextWindow: number;
  /** What the model reported, before any of this. `null` when it reported nothing usable. */
  readonly advertised: number | null;
  readonly source: ContextWindowSource;
  /** True when the endpoint is not loopback (system-design §12/§14). */
  readonly remote: boolean;
}

/** What {@link resolveContextWindow} needs. `ModelSource` satisfies it. */
export interface ContextWindowInput {
  readonly profile: Pick<ModelProfile, 'isRemote'>;
  readonly model: { readonly contextWindow?: number };
}

/**
 * Parses `PILOT_CONTEXT_WINDOW`.
 *
 * Anything that is not a positive integer is ignored rather than treated as
 * zero: a typo must not silently turn compaction into a per-turn event.
 */
export function parseContextWindowOverride(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveContextWindow(
  source: ContextWindowInput,
  options: { readonly override?: number | null; readonly ceiling?: number } = {},
): ContextWindowDecision {
  const ceiling = options.ceiling ?? CONSERVATIVE_CONTEXT_WINDOW;
  const reported = source.model.contextWindow;
  const advertised =
    typeof reported === 'number' && Number.isFinite(reported) && reported > 0 ? reported : null;
  const remote = source.profile.isRemote;

  const override = options.override ?? null;
  if (override !== null) {
    return { contextWindow: override, advertised, source: 'override', remote };
  }
  if (advertised === null) {
    return { contextWindow: ceiling, advertised, source: 'unknown', remote };
  }
  if (!remote && advertised > ceiling) {
    return { contextWindow: ceiling, advertised, source: 'local-ceiling', remote };
  }
  return { contextWindow: advertised, advertised, source: 'model', remote };
}

/** One line for the startup log. Contains no conversation content. */
export function describeContextWindow(decision: ContextWindowDecision): string {
  const advertised = decision.advertised === null ? 'nothing' : String(decision.advertised);
  return (
    `${String(decision.contextWindow)} tokens (${decision.source}; ` +
    `${decision.remote ? 'remote' : 'local'} endpoint advertised ${advertised})`
  );
}

/** Narrowing helper so the composition root can pass a whole {@link ModelSource}. */
export function contextWindowInputOf(source: ModelSource): ContextWindowInput {
  return { profile: source.profile, model: source.model };
}
