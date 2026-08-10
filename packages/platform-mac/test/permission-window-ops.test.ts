import { describe, expect, it } from 'vitest';
import { PERMISSION_KINDS, PERMISSION_STATES } from '@pilot/shared';
import {
  HELPER_OPERATIONS,
  HELPER_OPERATION_NAMES,
  HELPER_OP_NAME_MAX_LENGTH,
  HELPER_PROTOCOL_VERSION,
  MAX_ENUMERATED_WINDOWS,
  attributionEvidenceSchema,
  echoOperation,
  healthOperation,
  nativeWindowSchema,
  permissionAttributionOperation,
  permissionProbeSchema,
  permissionSnapshotOperation,
  windowListOperation,
  windowSnapshotSchema,
} from '@pilot/platform-mac';

/**
 * The operation table itself: names the host will accept, schemas that reject
 * rather than coerce, and the compatibility promise that adding operations
 * does not bump the protocol version.
 */

const OP_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

describe('the operation set', () => {
  it('still speaks protocol version 1', () => {
    // Appending operations is backwards compatible in both directions: an
    // unknown operation is already a typed `invalid-request` on each side.
    // Bumping the version here would strand every helper built for PR-003.
    expect(HELPER_PROTOCOL_VERSION).toBe(1);
  });

  it('keeps the PR-003 operations unchanged', () => {
    expect(HELPER_OPERATIONS.health).toBe(healthOperation);
    expect(HELPER_OPERATIONS.echo).toBe(echoOperation);
  });

  it('names every operation in a form the message schema accepts', () => {
    for (const name of HELPER_OPERATION_NAMES) {
      expect(name, name).toMatch(OP_NAME_PATTERN);
      expect(name.length).toBeLessThanOrEqual(HELPER_OP_NAME_MAX_LENGTH);
    }
  });

  it('has no duplicate operation names', () => {
    expect(new Set(HELPER_OPERATION_NAMES).size).toBe(HELPER_OPERATION_NAMES.length);
  });

  it('exposes the PR-011 operations', () => {
    expect(HELPER_OPERATION_NAMES).toEqual(
      expect.arrayContaining([
        'permissions.status',
        'permissions.snapshot',
        'permissions.request',
        'permissions.open-settings',
        'permissions.attribution',
        'windows.list',
        'windows.get',
      ]),
    );
  });

  it('attaches binary to nothing but echo and the capture stream', () => {
    // PR-011 asserted "nothing but echo" and said capture frames would arrive
    // in PR-012. They have: `capture.pull` answers with a frame's encoded
    // pixels in the binary body. Its *request* still carries none, and every
    // other operation still carries none in either direction — a binary body
    // on a permission or window response remains a protocol violation.
    for (const operation of Object.values(HELPER_OPERATIONS)) {
      if (operation.name === 'echo') {
        continue;
      }
      expect(operation.requestBinary, operation.name).toBe(false);
      expect(operation.responseBinary, operation.name).toBe(operation.name === 'capture.pull');
    }
  });

  it('exposes the PR-012 capture operations', () => {
    expect(HELPER_OPERATION_NAMES).toEqual(
      expect.arrayContaining(['capture.start', 'capture.stop', 'capture.pull']),
    );
  });
});

describe('permission schemas', () => {
  const probe = {
    kind: 'microphone',
    state: 'restricted',
    canRequest: false,
    api: 'av-authorization',
    raw: '1',
    restrictedRepresentable: true,
    requiresRelaunch: false,
  };

  it('accepts a well-formed probe', () => {
    expect(permissionProbeSchema.parse(probe)).toEqual(probe);
  });

  it('rejects a state outside the contract rather than coercing it', () => {
    expect(permissionProbeSchema.safeParse({ ...probe, state: 'maybe' }).success).toBe(false);
  });

  it('rejects an unknown permission kind', () => {
    expect(permissionProbeSchema.safeParse({ ...probe, kind: 'camera' }).success).toBe(false);
  });

  it('rejects extra fields, so a helper cannot smuggle data past the contract', () => {
    expect(permissionProbeSchema.safeParse({ ...probe, extra: 1 }).success).toBe(false);
  });

  it('requires a snapshot to cover every permission kind', () => {
    const probes = PERMISSION_KINDS.map((kind) => ({ ...probe, kind }));
    expect(permissionSnapshotOperation.response.safeParse({ probes }).success).toBe(true);
    expect(
      permissionSnapshotOperation.response.safeParse({ probes: probes.slice(1) }).success,
    ).toBe(false);
  });

  it('can express every one of the four states', () => {
    for (const state of PERMISSION_STATES) {
      expect(permissionProbeSchema.safeParse({ ...probe, state }).success, state).toBe(true);
    }
  });
});

describe('attribution schema', () => {
  const evidence = {
    helperPid: 4321,
    parentPid: 1234,
    helperExecutablePath: '/Applications/Pilot.app/Contents/MacOS/PilotHelper',
    helperBundleIdentifier: null,
    enclosingAppBundlePath: '/Applications/Pilot.app',
    enclosingAppBundleIdentifier: 'com.pilot.app',
    responsibleProcessPid: 1234,
    responsibleProcessQueried: true,
    mainBundleIsApp: false,
  };

  it('accepts complete evidence', () => {
    expect(attributionEvidenceSchema.parse(evidence)).toEqual(evidence);
  });

  it('requires nulls rather than omissions for unavailable facts', () => {
    // Absent and unavailable must not be the same thing: a missing responsible
    // pid has to read as "could not determine", never as zero or as absent.
    const { responsibleProcessPid: _omitted, ...withoutPid } = evidence;
    expect(attributionEvidenceSchema.safeParse(withoutPid).success).toBe(false);
    expect(
      attributionEvidenceSchema.safeParse({ ...evidence, responsibleProcessPid: null }).success,
    ).toBe(true);
  });

  it('requires the host to state a pid it expects to be credited', () => {
    const expected = { bundleIdentifier: 'com.pilot.app', bundlePath: '/Applications/Pilot.app' };
    expect(permissionAttributionOperation.request.safeParse({ expected }).success).toBe(false);
    expect(
      permissionAttributionOperation.request.safeParse({ expected: { ...expected, hostPid: 1 } })
        .success,
    ).toBe(true);
  });
});

describe('window schemas', () => {
  const window = {
    windowNumber: 42,
    ownerPid: 501,
    applicationName: 'Safari',
    applicationBundleId: 'com.apple.Safari',
    title: 'Billing Settings',
    titleAvailable: true,
    bounds: { x: 100, y: 80, width: 1200, height: 800 },
    displayNumber: 1,
    isOnScreen: true,
    layer: 0,
  };

  it('accepts a well-formed window', () => {
    expect(nativeWindowSchema.parse(window)).toEqual(window);
  });

  it('accepts a negative window origin, for a display left of the primary', () => {
    expect(
      nativeWindowSchema.safeParse({
        ...window,
        bounds: { x: -1600, y: -40, width: 1000, height: 700 },
      }).success,
    ).toBe(true);
  });

  it('rejects a negative width, which is not a window', () => {
    expect(
      nativeWindowSchema.safeParse({
        ...window,
        bounds: { x: 0, y: 0, width: -1, height: 700 },
      }).success,
    ).toBe(false);
  });

  it('rejects a negative window number', () => {
    expect(nativeWindowSchema.safeParse({ ...window, windowNumber: -1 }).success).toBe(false);
  });

  it('keeps a withheld title distinguishable from an empty one', () => {
    expect(
      nativeWindowSchema.parse({ ...window, title: null, titleAvailable: false }).titleAvailable,
    ).toBe(false);
    expect(nativeWindowSchema.parse({ ...window, title: '' }).titleAvailable).toBe(true);
  });

  it('bounds a snapshot so a runaway desktop cannot exhaust the frame ceiling', () => {
    const many = Array.from({ length: MAX_ENUMERATED_WINDOWS + 1 }, (_unused, index) => ({
      ...window,
      windowNumber: index,
    }));
    expect(
      windowSnapshotSchema.safeParse({
        windows: many,
        displays: [],
        screenLocked: false,
        titlesWithheld: false,
        capturedAt: 0,
      }).success,
    ).toBe(false);
  });

  it('lets windows.list be called with no arguments', () => {
    expect(windowListOperation.request.safeParse({}).success).toBe(true);
    expect(windowListOperation.request.safeParse({ includeAllLayers: true }).success).toBe(true);
  });
});
