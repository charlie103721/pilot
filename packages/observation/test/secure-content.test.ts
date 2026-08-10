import { describe, expect, it } from 'vitest';
import type { AccessibilityNode } from '@pilot/shared';
import {
  FIXTURE_ACCESSIBILITY_NODE,
  FIXTURE_GEOMETRY_RETINA,
  FIXTURE_SECURE_NODE,
} from '@pilot/platform/fakes';
import {
  planRedaction,
  secureRegionFromNode,
  toSafeTargetSummary,
  type SecureRegion,
} from '../src/secure-content.js';
import {
  DEFAULT_SCREEN_CONTEXT_POLICY,
  defineScreenPolicy,
  SCREEN_REDACTION_CAVEAT,
} from '../src/screen-policy.js';

/**
 * PR-017 secure content (§10 step 4, §14).
 *
 * The point of these tests is the *shape of the promise*: a value is never
 * forwarded, a located field is masked, an unlocatable field is refused rather
 * than silently unmasked, and every allowed plan carries the caveat that says
 * redaction is best effort.
 */

const NO_BOUNDS_SECURE: AccessibilityNode = {
  role: 'AXTextField',
  subrole: 'AXSecureTextField',
  label: 'Password',
  value: 'hunter2',
  isSecure: true,
};

describe('secure target summaries', () => {
  it('never forwards a secure field value, and says the field is secure', () => {
    const summary = toSafeTargetSummary(FIXTURE_SECURE_NODE, FIXTURE_GEOMETRY_RETINA);

    expect(summary.isSecure).toBe(true);
    expect(summary.value).toBeUndefined();
    expect(summary.label).toBe('Password');
    expect(JSON.stringify(summary)).not.toContain('hunter2');
  });

  it('keeps an ordinary field value', () => {
    const summary = toSafeTargetSummary(FIXTURE_ACCESSIBILITY_NODE, FIXTURE_GEOMETRY_RETINA);
    expect(summary).toMatchObject({ isSecure: false, label: 'Auto Renew', value: 'off' });
  });

  it('produces a region only for a secure node', () => {
    expect(secureRegionFromNode(FIXTURE_ACCESSIBILITY_NODE, FIXTURE_GEOMETRY_RETINA)).toBeNull();
    expect(secureRegionFromNode(FIXTURE_SECURE_NODE, FIXTURE_GEOMETRY_RETINA)).toMatchObject({
      source: 'pointer-target',
      label: 'Password',
    });
  });
});

describe('planRedaction', () => {
  it('masks a located secure field and lets the observation proceed', () => {
    const plan = planRedaction(DEFAULT_SCREEN_CONTEXT_POLICY, {
      pointerTarget: FIXTURE_SECURE_NODE,
      geometry: FIXTURE_GEOMETRY_RETINA,
    });

    expect(plan.allowed).toBe(true);
    if (!plan.allowed) {
      throw new Error('unreachable');
    }
    expect(plan.masks).toHaveLength(1);
    expect(plan.masks[0]?.normalizedBounds.width).toBeCloseTo(0.2, 6);
    expect(plan.report).toMatchObject({
      maskedRegions: 1,
      unmaskableRegions: 0,
      withheldValues: 1,
      guarantee: 'best-effort',
      recognizedFieldsOnly: true,
    });
  });

  it('carries the honest caveat even when nothing was masked', () => {
    const plan = planRedaction(DEFAULT_SCREEN_CONTEXT_POLICY, {
      pointerTarget: FIXTURE_ACCESSIBILITY_NODE,
      geometry: FIXTURE_GEOMETRY_RETINA,
    });

    expect(plan.allowed).toBe(true);
    expect(plan.report.maskedRegions).toBe(0);
    expect(plan.report.caveat).toBe(SCREEN_REDACTION_CAVEAT);
    expect(plan.report.caveat).toContain('best effort');
    expect(plan.report.caveat).toContain('outside recognised');
  });

  it('refuses a secure field it cannot locate rather than claiming redaction', () => {
    const plan = planRedaction(DEFAULT_SCREEN_CONTEXT_POLICY, {
      pointerTarget: NO_BOUNDS_SECURE,
      geometry: FIXTURE_GEOMETRY_RETINA,
    });

    expect(plan.allowed).toBe(false);
    if (plan.allowed) {
      throw new Error('unreachable');
    }
    expect(plan.rule).toBe('unmaskable-secure-region');
    expect(plan.report.unmaskableRegions).toBe(1);
    expect(plan.report.maskedRegions).toBe(0);
  });

  it('proceeds with an unlocatable field when the policy accepts that risk', () => {
    const policy = defineScreenPolicy({ secureContent: { requireMaskableBounds: false } });
    const plan = planRedaction(policy, {
      pointerTarget: NO_BOUNDS_SECURE,
      geometry: FIXTURE_GEOMETRY_RETINA,
    });

    expect(plan.allowed).toBe(true);
    expect(plan.report.unmaskableRegions).toBe(1);
    // The value is still withheld; only the pixels are at risk.
    expect(plan.report.withheldValues).toBe(1);
  });

  it('refuses the whole observation when the policy is set to reject', () => {
    const policy = defineScreenPolicy({ secureContent: { onSecureTarget: 'reject' } });
    const plan = planRedaction(policy, {
      pointerTarget: FIXTURE_SECURE_NODE,
      geometry: FIXTURE_GEOMETRY_RETINA,
    });

    expect(plan.allowed).toBe(false);
    if (plan.allowed) {
      throw new Error('unreachable');
    }
    expect(plan.rule).toBe('secure-content-refused');
    expect(plan.report.mode).toBe('reject');
  });

  it('masks secure regions found by an accessibility scan, not only the pointer target', () => {
    const scanned: readonly SecureRegion[] = [
      {
        source: 'accessibility-scan',
        label: 'Card number',
        normalizedBounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
      },
      { source: 'accessibility-scan', label: 'CVC' },
    ];
    const policy = defineScreenPolicy({ secureContent: { requireMaskableBounds: false } });
    const plan = planRedaction(policy, {
      pointerTarget: FIXTURE_ACCESSIBILITY_NODE,
      secureRegions: scanned,
      geometry: FIXTURE_GEOMETRY_RETINA,
    });

    expect(plan.allowed).toBe(true);
    if (!plan.allowed) {
      throw new Error('unreachable');
    }
    expect(plan.masks).toHaveLength(1);
    expect(plan.masks[0]?.source).toBe('accessibility-scan');
    expect(plan.report.unmaskableRegions).toBe(1);
  });

  it('reports nothing to mask when no accessibility information exists at all', () => {
    const plan = planRedaction(DEFAULT_SCREEN_CONTEXT_POLICY, { geometry: null });

    expect(plan.allowed).toBe(true);
    expect(plan.report).toMatchObject({
      maskedRegions: 0,
      unmaskableRegions: 0,
      withheldValues: 0,
    });
    // And it still refuses to promise anything: this is the case where
    // accessibility is denied and redaction can recognise nothing whatsoever.
    expect(plan.report.guarantee).toBe('best-effort');
  });
});
