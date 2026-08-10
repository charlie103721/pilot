import { describe, expect, it } from 'vitest';
import { isAttributionFailure, isAttributionTrusted, isPilotError } from '@pilot/shared';
import {
  ATTRIBUTION_REASONS,
  assertAttributionUsable,
  attributionError,
  attributionUserMessage,
  evaluateAttribution,
  type AttributionEvidence,
} from '@pilot/platform-mac';

/**
 * Parent-bundle attribution: the verdict table.
 *
 * This is the single highest structural risk in the MVP plan and it cannot be
 * observed on this machine, so the decision was deliberately put in TypeScript
 * where every branch can be driven directly. What is *not* proved here is that
 * the helper reports the evidence correctly — that needs a Mac.
 */

const HOST_PID = 1234;
const HELPER_PID = 4321;

const EXPECTED = {
  bundleIdentifier: 'com.pilot.app',
  bundlePath: '/Applications/Pilot.app',
  hostPid: HOST_PID,
} as const;

function evidence(overrides: Partial<AttributionEvidence> = {}): AttributionEvidence {
  return {
    helperPid: HELPER_PID,
    parentPid: HOST_PID,
    helperExecutablePath: '/Applications/Pilot.app/Contents/MacOS/PilotHelper',
    helperBundleIdentifier: null,
    enclosingAppBundlePath: '/Applications/Pilot.app',
    enclosingAppBundleIdentifier: 'com.pilot.app',
    responsibleProcessPid: HOST_PID,
    responsibleProcessQueried: true,
    mainBundleIsApp: false,
    ...overrides,
  };
}

const evaluate = (overrides: Partial<AttributionEvidence> = {}) =>
  evaluateAttribution({ evidence: evidence(overrides), expected: EXPECTED, checkedAt: 1_000 });

describe('attribution — direct evidence', () => {
  it('accepts a helper whose responsible process is the host', () => {
    const attribution = evaluate();
    expect(attribution.verdict).toBe('matched');
    expect(attribution.confidence).toBe('direct');
    expect(attribution.reason).toBe(ATTRIBUTION_REASONS.responsibleIsHost);
    expect(isAttributionTrusted(attribution)).toBe(true);
    expect(isAttributionFailure(attribution)).toBe(false);
  });

  it('rejects a helper that macOS holds responsible for itself', () => {
    // The failure mode this whole PR exists to catch: the user grants Pilot
    // screen recording, TCC checks the helper's identity instead, and capture
    // silently returns nothing.
    const attribution = evaluate({ responsibleProcessPid: HELPER_PID });
    expect(attribution.verdict).toBe('helper-attributed');
    expect(attribution.confidence).toBe('direct');
    expect(attribution.reason).toBe(ATTRIBUTION_REASONS.responsibleIsHelper);
    expect(isAttributionFailure(attribution)).toBe(true);
    expect(isAttributionTrusted(attribution)).toBe(false);
  });

  it('rejects a helper attributed to some third process', () => {
    const attribution = evaluate({ responsibleProcessPid: 9999 });
    expect(attribution.verdict).toBe('bundle-mismatch');
    expect(attribution.confidence).toBe('direct');
    expect(attribution.reason).toBe(ATTRIBUTION_REASONS.responsibleIsForeign);
    expect(attribution.attributed.pid).toBe(9999);
  });

  it('reports the identities it compared', () => {
    const attribution = evaluate({ responsibleProcessPid: HELPER_PID });
    expect(attribution.expected).toEqual({
      bundleIdentifier: 'com.pilot.app',
      path: '/Applications/Pilot.app',
      pid: HOST_PID,
    });
    expect(attribution.attributed.pid).toBe(HELPER_PID);
    expect(attribution.checkedAt).toBe(1_000);
  });
});

describe('attribution — inferred evidence', () => {
  const unqueried = { responsibleProcessQueried: false, responsibleProcessPid: null } as const;

  it('accepts a bare helper inside the expected bundle, but only as inferred', () => {
    const attribution = evaluate(unqueried);
    expect(attribution.verdict).toBe('matched');
    expect(attribution.confidence).toBe('inferred');
    expect(attribution.reason).toBe(ATTRIBUTION_REASONS.bundledUnderExpectedApp);
  });

  it('rejects a helper carrying its own bundle identifier', () => {
    // Its own identifier makes it a separate TCC subject no matter where on
    // disk it lives, so this outranks the enclosing-bundle check.
    const attribution = evaluate({
      ...unqueried,
      helperBundleIdentifier: 'com.pilot.app.helper',
    });
    expect(attribution.verdict).toBe('helper-attributed');
    expect(attribution.confidence).toBe('inferred');
    expect(attribution.reason).toBe(ATTRIBUTION_REASONS.helperHasOwnBundleId);
    expect(attribution.attributed.bundleIdentifier).toBe('com.pilot.app.helper');
  });

  it('accepts a helper whose own identifier is the expected one', () => {
    const attribution = evaluate({ ...unqueried, helperBundleIdentifier: 'com.pilot.app' });
    expect(attribution.verdict).toBe('matched');
  });

  it('rejects a helper inside a different application bundle', () => {
    const attribution = evaluate({
      ...unqueried,
      enclosingAppBundlePath: '/Applications/Something Else.app',
      enclosingAppBundleIdentifier: 'com.example.other',
    });
    expect(attribution.verdict).toBe('bundle-mismatch');
    expect(attribution.reason).toBe(ATTRIBUTION_REASONS.bundleIdMismatch);
    expect(attribution.attributed.bundleIdentifier).toBe('com.example.other');
  });

  it('rejects a bundle whose identifier could not be read', () => {
    // An `.app` with no readable `CFBundleIdentifier` is not the expected
    // bundle; treating null as "probably fine" is how this check would end up
    // never firing.
    const attribution = evaluate({ ...unqueried, enclosingAppBundleIdentifier: null });
    expect(attribution.verdict).toBe('bundle-mismatch');
  });
});

describe('attribution — undetermined', () => {
  const unqueried = { responsibleProcessQueried: false, responsibleProcessPid: null } as const;

  it('reports unknown for a loose executable, which is the development layout', () => {
    const attribution = evaluate({
      ...unqueried,
      helperExecutablePath: '/repo/packages/platform-mac/native/.build/debug/PilotHelper',
      enclosingAppBundlePath: null,
      enclosingAppBundleIdentifier: null,
    });
    expect(attribution.verdict).toBe('unknown');
    expect(attribution.confidence).toBe('none');
    expect(attribution.reason).toBe(ATTRIBUTION_REASONS.notBundled);
  });

  it('reports unknown when the host stated no expected identity', () => {
    const attribution = evaluateAttribution({
      evidence: evidence(unqueried),
      expected: { bundleIdentifier: null, bundlePath: null, hostPid: HOST_PID },
      checkedAt: 0,
    });
    expect(attribution.verdict).toBe('unknown');
    expect(attribution.reason).toBe(ATTRIBUTION_REASONS.noExpectedIdentity);
  });

  it('treats unknown as neither trusted nor a failure', () => {
    // The distinction the brief insists on: a status that could not be
    // determined is not a denial, and it is not a pass either.
    const attribution = evaluate({
      ...unqueried,
      enclosingAppBundlePath: null,
      enclosingAppBundleIdentifier: null,
    });
    expect(isAttributionTrusted(attribution)).toBe(false);
    expect(isAttributionFailure(attribution)).toBe(false);
    expect(() => {
      assertAttributionUsable(attribution);
    }).not.toThrow();
  });

  it('prefers the direct answer over the inferred one when both are available', () => {
    // Bundle layout looks perfect; macOS says the helper is responsible.
    // The direct answer wins, because the layout is only a proxy for it.
    const attribution = evaluate({ responsibleProcessPid: HELPER_PID });
    expect(attribution.verdict).toBe('helper-attributed');
    expect(attribution.confidence).toBe('direct');
  });
});

describe('attribution — the typed failure', () => {
  it('throws permission-attribution-mismatch, not permission-denied', () => {
    // The two demand opposite responses: a denial is fixed by granting the
    // permission, and this is not. A UI that switched on `permission-denied`
    // would send the user round a loop that cannot terminate.
    const attribution = evaluate({ responsibleProcessPid: HELPER_PID });
    expect(() => {
      assertAttributionUsable(attribution);
    }).toThrow(/wrong process/i);

    try {
      assertAttributionUsable(attribution);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isPilotError(error)).toBe(true);
      if (!isPilotError(error)) {
        return;
      }
      expect(error.code).toBe('permission-attribution-mismatch');
      expect(error.domain).toBe('permission');
      expect(error.retryable).toBe(false);
    }
  });

  it('carries both identities in its details, for a diagnosable report', () => {
    const attribution = evaluate({
      responsibleProcessQueried: false,
      responsibleProcessPid: null,
      helperBundleIdentifier: 'com.pilot.app.helper',
    });
    const error = attributionError(attribution);
    expect(error.details).toMatchObject({
      verdict: 'helper-attributed',
      confidence: 'inferred',
      expectedBundleIdentifier: 'com.pilot.app',
      attributedBundleIdentifier: 'com.pilot.app.helper',
      expectedPid: HOST_PID,
      attributedPid: HELPER_PID,
    });
  });

  it('never puts screen content, audio or credentials in its details', () => {
    const error = attributionError(evaluate({ responsibleProcessPid: HELPER_PID }));
    const serialised = JSON.stringify(error.toJSON());
    expect(serialised).not.toMatch(/token|secret|password|bytes/i);
  });

  it('tells the user the permission screen is lying and that regranting will not help', () => {
    const message = attributionUserMessage(evaluate({ responsibleProcessPid: HELPER_PID }));
    expect(message).toMatch(/will not\s+reach/i);
    expect(message).toMatch(/again will not fix this/i);
    expect(message).toMatch(/reinstall/i);
  });

  it('tells a bundle-mismatch user to launch the installed copy instead', () => {
    const message = attributionUserMessage(evaluate({ responsibleProcessPid: 9999 }));
    expect(message).toMatch(/Applications folder/i);
  });

  it('is serialisable across the IPC boundary', () => {
    const error = attributionError(evaluate({ responsibleProcessPid: HELPER_PID }));
    const json = error.toJSON();
    expect(json.code).toBe('permission-attribution-mismatch');
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});
