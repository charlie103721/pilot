import {
  nullLogger,
  redactUrlCredentials,
  scrubUrlCredentials,
  type Logger,
  type PilotError,
} from '@pilot/shared';
import {
  checkVisualConversation,
  createLocalModelSource,
  localityStatement,
  probeLocalEndpoint,
  readLocalEndpointSettings,
  toLocalEndpointError,
  type LocalDiagnosis,
  type LocalEndpointReport,
  type LocalEndpointSettings,
  type LocalModelSource,
} from '@pilot/agent';

/**
 * The local OpenAI-compatible profile, resolved for the composition root
 * (PR-039).
 *
 * `docs/runbook.md` follow-up 22 records the shape this has to fit: the app
 * consumes a `ModelSource` "and nothing else, so a real provider is one call
 * site". This module is that call site's other half — everything that has to
 * happen *before* a `ModelSource` exists for a user's own endpoint, which for a
 * local model is more than for a hosted one, because nothing about a local
 * model is known until it is asked.
 *
 * THE RULE THIS FILE ENFORCES
 * ---------------------------
 * A configured-but-unusable endpoint must not look like a working model. So
 * there are three outcomes and no fourth:
 *
 *  1. **Not configured** (`PILOT_LOCAL_BASE_URL` unset) — `source: null`,
 *     `blockedBy: null`. The caller uses the development source, exactly as
 *     before this PR.
 *  2. **Configured and usable** — a `LocalModelSource` whose profile carries
 *     probed capabilities and a loopback locality label.
 *  3. **Configured and not usable** — a `LocalModelSource` *and* a
 *     `blockedBy` error. The source is still returned so the app names the
 *     model the user chose; `blockedBy` makes `createAgentRuntime` build a
 *     refusing session whose every answer is the reason. Falling back silently
 *     to a model that works would be the worst of the three: the user would be
 *     talking to something other than what they configured and would not know.
 */

export interface LocalModelResolution {
  /** Whether a local endpoint was configured at all. */
  readonly configured: boolean;
  /** `null` only when nothing was configured. */
  readonly source: LocalModelSource | null;
  /** Set when the endpoint cannot serve a visual conversation. */
  readonly blockedBy: PilotError | null;
  readonly report: LocalEndpointReport | null;
  /** Human-readable startup lines. Contain no credential and no screen data. */
  readonly lines: readonly string[];
}

export interface ResolveLocalModelOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger?: Logger;
  /** Injected for tests. Defaults to the real probe. */
  readonly probe?: typeof probeLocalEndpoint;
}

const NOT_CONFIGURED: LocalModelResolution = {
  configured: false,
  source: null,
  blockedBy: null,
  report: null,
  lines: [],
};

/**
 * Chooses which diagnosis to show the user.
 *
 * A fatal one wins — there is no point telling someone their model cannot see
 * when the server is not running. Otherwise the first capability diagnosis
 * wins, because it is strictly more useful than the capability gate's generic
 * sentence: "this model accepted an image but could not tell Pilot what was in
 * it" names the actual problem, where "this model cannot see images" does not
 * distinguish it from a text-only model.
 */
export function blockingDiagnosisFor(report: LocalEndpointReport): LocalDiagnosis | null {
  if (report.blocking !== null) {
    return report.blocking;
  }
  return (
    report.diagnoses.find(
      (entry) =>
        entry.code !== 'context-window-below-reserve' && entry.code !== 'endpoint-not-local',
    ) ?? null
  );
}

export async function resolveLocalModelSource(
  options: ResolveLocalModelOptions,
): Promise<LocalModelResolution> {
  const logger = options.logger ?? nullLogger;
  let settings: LocalEndpointSettings | null;
  try {
    settings = readLocalEndpointSettings(options.env);
  } catch (cause) {
    // A malformed environment variable is a configuration mistake, not a
    // reason to boot into a different model without saying so.
    // `reason` is not one of the redactor's key patterns and a zod message
    // quotes what it was given, so the address is scrubbed here (PR-041).
    logger.warn('local model settings could not be read', {
      reason: scrubUrlCredentials(String(cause)),
    });
    return NOT_CONFIGURED;
  }
  if (settings === null) {
    return NOT_CONFIGURED;
  }

  const probe = options.probe ?? probeLocalEndpoint;
  const report = await probe(settings);
  const source = createLocalModelSource(report, {
    ...(settings.apiKey === undefined ? {} : { apiKey: settings.apiKey }),
  });

  // Belt and braces, and it is worth the two lines: the capability gate is what
  // actually stands between an unsupported model and the user's screen, and the
  // probe is only how it was informed. If they ever disagree, the *stricter*
  // answer wins, which is what `checkVisualConversation` already computes.
  const gate = checkVisualConversation(source.profile, { toolSupport: source.toolSupport });
  const diagnosis = blockingDiagnosisFor(report);
  const blockedBy =
    diagnosis !== null
      ? toLocalEndpointError(diagnosis)
      : gate.ok
        ? null
        : toLocalEndpointError({
            code: 'probe-failed',
            userMessage: gate.refusal.userMessage,
            remedy: gate.refusal.remedy,
            detail: gate.refusal.message,
            fatal: true,
          });

  const lines = describeResolution(source, report, blockedBy);
  for (const line of lines) {
    logger.info('local model endpoint', { line });
  }
  if (blockedBy !== null) {
    logger.warn('local model endpoint is configured but unusable', {
      code: blockedBy.code,
      reason: diagnosis?.code ?? 'capability-gate',
      // The address, never the key — and `endpoint` is not one of the
      // redactor's key patterns, so a base URL carrying user information used
      // to arrive here verbatim (PR-041).
      endpoint: redactUrlCredentials(report.health.baseUrl),
    });
  }

  return { configured: true, source, blockedBy, report, lines };
}

/**
 * The startup lines. Locality comes first on purpose: system-design §14 asks
 * the user be able to tell where their screen goes *before* observation begins,
 * and the address is the whole answer for this profile.
 */
export function describeResolution(
  source: LocalModelSource,
  report: LocalEndpointReport,
  blockedBy: PilotError | null,
): readonly string[] {
  const lines: string[] = [];
  lines.push(localityStatement(source));
  const capability = (finding: { supported: boolean; probed: boolean }): string =>
    finding.supported ? 'probed ok' : finding.probed ? 'no' : 'never probed';
  lines.push(
    `model ${source.profile.model} at ${redactUrlCredentials(report.health.baseUrl)}` +
      ` · vision ${capability(report.vision)}` +
      ` · tools ${capability(report.tools)} (${source.toolSupport})`,
  );
  lines.push(
    report.health.contextWindow.tokens === null
      ? 'context window: the endpoint reported none, so Pilot uses its conservative default'
      : `context window: ${report.health.contextWindow.note}`,
  );
  for (const diagnosis of report.diagnoses) {
    lines.push(
      `${diagnosis.fatal ? 'PROBLEM' : 'note'} [${diagnosis.code}] ${diagnosis.userMessage} — ${diagnosis.remedy}`,
    );
  }
  if (blockedBy !== null) {
    lines.push(`Pilot will refuse every question until this is fixed: ${blockedBy.userMessage}`);
  }
  return lines;
}
