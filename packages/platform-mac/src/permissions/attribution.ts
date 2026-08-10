import {
  PilotError,
  isAttributionFailure,
  type PermissionAttribution,
  type PermissionAttributionConfidence,
  type PermissionAttributionVerdict,
} from '@pilot/shared';
import type {
  AttributionEvidence,
  PermissionAttributionRequest,
} from '../protocol/permission-ops.js';

/**
 * Parent-bundle attribution: deciding whether a permission Pilot reports is a
 * permission Pilot actually has.
 *
 * ## The failure this exists to catch
 *
 * Pilot is an application bundle that spawns a native helper as a child
 * process (system-design §4). The user grants Screen Recording to *Pilot* in
 * System Settings. Whether that grant reaches the helper depends on which
 * process macOS considers **responsible** for the helper:
 *
 * - Responsible process is the parent app → TCC checks the parent's identity,
 *   the grant applies, everything works, and System Settings lists "Pilot".
 * - Responsible process is the helper itself → TCC checks the helper's own
 *   identity. The grant the user gave Pilot means nothing. System Settings
 *   grows a second entry for "PilotHelper", or none at all, and every capture
 *   returns black frames or fails outright.
 *
 * The second case is the top structural risk in the MVP plan
 * (`docs/runbook.md` §7, `docs/handoff.md` §5). Without this check its symptom
 * is "screen recording is granted but capture is blank" — a permission state
 * that reads as correct while being wrong, which is precisely the silent wrong
 * answer the delivery rules forbid.
 *
 * ## How it is decided
 *
 * The helper reports facts only (`AttributionEvidence`); the verdict is
 * computed here. Two independent lines of evidence, in priority order:
 *
 * 1. **Direct.** macOS is asked, through
 *    `responsibility_get_pid_responsible_for_pid`, which pid it holds
 *    responsible for the helper. That pid *is* the TCC identity. If it is the
 *    host's pid, attribution is correct. If it is the helper's own pid,
 *    attribution is broken. This is an SPI and may be unavailable.
 * 2. **Inferred.** Failing that, the helper's location and identity: a helper
 *    living inside the expected `.app` bundle and carrying no bundle
 *    identifier of its own is the layout that normally attributes to the
 *    parent. Evidence, not proof — hence `confidence: 'inferred'`.
 *
 * When neither is conclusive the verdict is `unknown`. `unknown` is not a
 * pass. It is also not a failure: running the helper straight out of
 * `.build/debug` during development produces it, and refusing to operate then
 * would make the package undevelopable.
 */

/** Machine-readable reasons. Stable strings; the UI maps them, never prints them. */
export const ATTRIBUTION_REASONS = {
  responsibleIsHost: 'responsible-process-is-host',
  responsibleIsHelper: 'responsible-process-is-helper',
  responsibleIsForeign: 'responsible-process-is-a-third-process',
  bundleIdMismatch: 'enclosing-bundle-identifier-differs-from-expected',
  helperHasOwnBundleId: 'helper-carries-its-own-bundle-identifier',
  bundledUnderExpectedApp: 'helper-is-inside-the-expected-application-bundle',
  notBundled: 'helper-is-not-inside-any-application-bundle',
  noExpectedIdentity: 'host-supplied-no-expected-bundle-identity',
} as const;

export type AttributionReason = (typeof ATTRIBUTION_REASONS)[keyof typeof ATTRIBUTION_REASONS];

export interface EvaluateAttributionOptions {
  readonly evidence: AttributionEvidence;
  readonly expected: PermissionAttributionRequest['expected'];
  readonly checkedAt: number;
}

function toEvidenceRecord(
  evidence: AttributionEvidence,
): Record<string, string | number | boolean | null> {
  return {
    helperPid: evidence.helperPid,
    parentPid: evidence.parentPid,
    helperExecutablePath: evidence.helperExecutablePath,
    helperBundleIdentifier: evidence.helperBundleIdentifier,
    enclosingAppBundlePath: evidence.enclosingAppBundlePath,
    enclosingAppBundleIdentifier: evidence.enclosingAppBundleIdentifier,
    responsibleProcessPid: evidence.responsibleProcessPid,
    responsibleProcessQueried: evidence.responsibleProcessQueried,
    mainBundleIsApp: evidence.mainBundleIsApp,
  };
}

interface Decision {
  readonly verdict: PermissionAttributionVerdict;
  readonly confidence: PermissionAttributionConfidence;
  readonly reason: AttributionReason;
  readonly attributedPid: number | null;
}

/**
 * The whole decision, isolated from the report it is wrapped in so the table
 * of cases is readable in one screen and testable one row at a time.
 */
function decide(
  evidence: AttributionEvidence,
  expected: PermissionAttributionRequest['expected'],
): Decision {
  // 1. Direct evidence. macOS answered which process it holds responsible.
  if (evidence.responsibleProcessQueried && evidence.responsibleProcessPid !== null) {
    const responsible = evidence.responsibleProcessPid;
    if (responsible === expected.hostPid) {
      return {
        verdict: 'matched',
        confidence: 'direct',
        reason: ATTRIBUTION_REASONS.responsibleIsHost,
        attributedPid: responsible,
      };
    }
    if (responsible === evidence.helperPid) {
      return {
        verdict: 'helper-attributed',
        confidence: 'direct',
        reason: ATTRIBUTION_REASONS.responsibleIsHelper,
        attributedPid: responsible,
      };
    }
    // Neither Pilot nor the helper. A launcher, a debugger, or a shell — in
    // every case not the identity the user granted anything to.
    return {
      verdict: 'bundle-mismatch',
      confidence: 'direct',
      reason: ATTRIBUTION_REASONS.responsibleIsForeign,
      attributedPid: responsible,
    };
  }

  // 2. Inferred evidence. The helper's own identity comes first: a helper with
  //    its own bundle identifier is a separate TCC subject regardless of where
  //    it lives on disk.
  if (
    evidence.helperBundleIdentifier !== null &&
    evidence.helperBundleIdentifier !== expected.bundleIdentifier
  ) {
    return {
      verdict: 'helper-attributed',
      confidence: 'inferred',
      reason: ATTRIBUTION_REASONS.helperHasOwnBundleId,
      attributedPid: evidence.helperPid,
    };
  }

  if (evidence.enclosingAppBundlePath === null) {
    // A loose executable: the development layout. Nothing to compare against.
    return {
      verdict: 'unknown',
      confidence: 'none',
      reason: ATTRIBUTION_REASONS.notBundled,
      attributedPid: null,
    };
  }

  if (expected.bundleIdentifier === null) {
    return {
      verdict: 'unknown',
      confidence: 'none',
      reason: ATTRIBUTION_REASONS.noExpectedIdentity,
      attributedPid: null,
    };
  }

  if (evidence.enclosingAppBundleIdentifier !== expected.bundleIdentifier) {
    return {
      verdict: 'bundle-mismatch',
      confidence: 'inferred',
      reason: ATTRIBUTION_REASONS.bundleIdMismatch,
      attributedPid: null,
    };
  }

  return {
    verdict: 'matched',
    confidence: 'inferred',
    reason: ATTRIBUTION_REASONS.bundledUnderExpectedApp,
    attributedPid: expected.hostPid,
  };
}

/** Turns raw helper evidence into the platform-neutral report the contract carries. */
export function evaluateAttribution(options: EvaluateAttributionOptions): PermissionAttribution {
  const { evidence, expected, checkedAt } = options;
  const decision = decide(evidence, expected);

  const attributedBundleIdentifier =
    decision.verdict === 'helper-attributed'
      ? evidence.helperBundleIdentifier
      : (evidence.enclosingAppBundleIdentifier ?? null);
  const attributedPath =
    decision.verdict === 'helper-attributed'
      ? evidence.helperExecutablePath
      : (evidence.enclosingAppBundlePath ?? evidence.helperExecutablePath);

  return {
    verdict: decision.verdict,
    confidence: decision.confidence,
    expected: {
      bundleIdentifier: expected.bundleIdentifier,
      path: expected.bundlePath,
      pid: expected.hostPid,
    },
    attributed: {
      bundleIdentifier: attributedBundleIdentifier,
      path: attributedPath,
      pid: decision.attributedPid,
    },
    reason: decision.reason,
    evidence: toEvidenceRecord(evidence),
    checkedAt,
  };
}

/**
 * Prose the user sees when attribution is wrong.
 *
 * Written out here, not assembled at the throw site, so it can be asserted in
 * a test and reviewed as text. It has to do three things: say that the
 * permission screen is lying, say that granting again will not help, and give
 * one concrete action.
 */
export function attributionUserMessage(attribution: PermissionAttribution): string {
  const expected = attribution.expected.bundleIdentifier ?? 'Pilot';
  if (attribution.verdict === 'helper-attributed') {
    const helper = attribution.attributed.bundleIdentifier ?? 'Pilot’s helper process';
    return (
      `macOS is crediting Pilot’s screen and accessibility permissions to ${helper} ` +
      `instead of to ${expected}. Permissions granted to Pilot in System Settings will not ` +
      `reach the part of Pilot that needs them, so screen observation cannot work. ` +
      `Granting the permission again will not fix this. Quit Pilot and reinstall it from the ` +
      `original download; if it happens again, report it — this is a defect in how Pilot is packaged.`
    );
  }
  const attributed = attribution.attributed.bundleIdentifier ?? 'an unknown application';
  return (
    `Pilot is running as part of ${attributed}, but its permissions were granted to ${expected}. ` +
    `Screen observation will not work until Pilot is launched from the installed copy of the app. ` +
    `Quit Pilot and open it from your Applications folder.`
  );
}

/**
 * Converts a failing attribution into the typed error that carries it.
 *
 * `permission-attribution-mismatch` is its own code rather than a flavour of
 * `permission-denied` because the two demand opposite responses: a denial is
 * fixed by granting the permission, and this is not.
 */
export function attributionError(attribution: PermissionAttribution): PilotError {
  return new PilotError(
    'permission-attribution-mismatch',
    `macOS attributes Pilot's permissions to the wrong process (${attribution.reason})`,
    {
      userMessage: attributionUserMessage(attribution),
      retryable: false,
      details: {
        verdict: attribution.verdict,
        confidence: attribution.confidence,
        reason: attribution.reason,
        expectedBundleIdentifier: attribution.expected.bundleIdentifier,
        attributedBundleIdentifier: attribution.attributed.bundleIdentifier,
        expectedPid: attribution.expected.pid,
        attributedPid: attribution.attributed.pid,
      },
    },
  );
}

/** Throws {@link attributionError} for a failing verdict; returns for any other. */
export function assertAttributionUsable(attribution: PermissionAttribution): void {
  if (isAttributionFailure(attribution)) {
    throw attributionError(attribution);
  }
}
