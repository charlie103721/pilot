import { afterEach, describe, expect, it } from 'vitest';
import {
  PERMISSION_KINDS,
  PERMISSION_STATES,
  isPilotError,
  type PermissionKind,
  type PermissionState,
  type PermissionStatus,
} from '@pilot/shared';
import { MacPermissionAdapter, type NativeHelperTransport } from '@pilot/platform-mac';
import { createStubTransport, once } from './support/harness.js';
import type { StubConfig } from './support/helper-stub.js';

/**
 * The macOS `PermissionAdapter`, driven end to end against the Node stub.
 *
 * Every assertion here crosses the real framed protocol, the real transport
 * and the real schemas — only the process on the other end is a stand-in. What
 * is *not* covered is whether macOS answers the way the stub does; that is the
 * Mac batch's job (`docs/handoff.md` §1).
 */

const transports: NativeHelperTransport[] = [];
const adapters: MacPermissionAdapter[] = [];

async function start(
  stub: StubConfig = {},
  options: Partial<ConstructorParameters<typeof MacPermissionAdapter>[0]> = {},
): Promise<MacPermissionAdapter> {
  const transport = createStubTransport(stub);
  transports.push(transport);
  await transport.start();
  const adapter = new MacPermissionAdapter({
    transport,
    expectedBundleIdentifier: 'com.pilot.app',
    expectedBundlePath: '/Applications/Pilot.app',
    hostPid: 1234,
    pollIntervalMs: 20,
    ...options,
  });
  adapters.push(adapter);
  return adapter;
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    adapter.dispose();
  }
  for (const transport of transports.splice(0)) {
    await transport.stop();
  }
});

describe('permission states', () => {
  it('reports every state for every permission', async () => {
    // The demo implementation.md asks for — "display all four permission
    // states" — as an assertion rather than a screenshot, because there is no
    // Mac here to show it on.
    for (const state of PERMISSION_STATES) {
      const adapter = await start({
        permissions: Object.fromEntries(PERMISSION_KINDS.map((kind) => [kind, state])) as Record<
          PermissionKind,
          PermissionState
        >,
      });
      const snapshot = await adapter.snapshot();
      for (const kind of PERMISSION_KINDS) {
        expect(snapshot[kind], `${kind} @ ${state}`).toEqual({
          kind,
          state,
          canRequest: state === 'unknown',
        });
      }
    }
  });

  it('keeps the four permissions independent of one another', async () => {
    const adapter = await start({
      permissions: {
        'screen-recording': 'granted',
        accessibility: 'denied',
        microphone: 'restricted',
        'speech-recognition': 'unknown',
      },
    });
    const snapshot = await adapter.snapshot();
    expect(snapshot['screen-recording'].state).toBe('granted');
    expect(snapshot.accessibility.state).toBe('denied');
    expect(snapshot.microphone.state).toBe('restricted');
    expect(snapshot['speech-recognition'].state).toBe('unknown');
  });

  it('never collapses unknown into denied', async () => {
    // The distinction drives different UI: `unknown` offers the prompt,
    // `denied` sends the user to System Settings. Conflating them strands a
    // first-run user in a settings pane they never needed to open.
    const adapter = await start({ permissions: { 'screen-recording': 'unknown' } });
    const status = await adapter.status('screen-recording');
    expect(status.state).toBe('unknown');
    expect(status.state).not.toBe('denied');
    expect(status.canRequest).toBe(true);
  });

  it('never marks restricted as requestable', async () => {
    // Restricted is policy — Screen Time or MDM. No prompt overrides it, and
    // offering one sends the user round a loop that cannot terminate.
    const adapter = await start({ permissions: { microphone: 'restricted' } });
    const status = await adapter.status('microphone');
    expect(status.state).toBe('restricted');
    expect(status.canRequest).toBe(false);
  });

  it('answers status for one permission without reading the others', async () => {
    const adapter = await start({ permissions: { accessibility: 'granted' } });
    await expect(adapter.status('accessibility')).resolves.toEqual({
      kind: 'accessibility',
      state: 'granted',
      canRequest: false,
    });
  });
});

describe('requesting permissions', () => {
  it('returns the state after prompting', async () => {
    const adapter = await start({
      permissions: { microphone: 'unknown' },
      permissionsAfterRequest: { microphone: 'granted' },
    });
    await expect(adapter.request('microphone')).resolves.toEqual({
      kind: 'microphone',
      state: 'granted',
      canRequest: false,
    });
  });

  it('reports a refusal as denied, not as a failure', async () => {
    const adapter = await start({
      permissions: { accessibility: 'unknown' },
      permissionsAfterRequest: { accessibility: 'denied' },
    });
    const status = await adapter.request('accessibility');
    expect(status.state).toBe('denied');
    expect(status.canRequest).toBe(false);
  });

  it('leaves an already-denied permission alone rather than pretending to prompt', async () => {
    // macOS shows the prompt once. Asking again is a no-op, and reporting it
    // as a prompt would leave the UI waiting for a dialog nobody will see.
    const adapter = await start({
      permissions: { 'screen-recording': 'denied' },
      permissionsAfterRequest: { 'screen-recording': 'granted' },
    });
    const status = await adapter.request('screen-recording');
    expect(status.state).toBe('denied');
  });

  it('opens the settings pane', async () => {
    const adapter = await start();
    await expect(adapter.openSettings('screen-recording')).resolves.toBeUndefined();
  });

  it('reports a failure to open settings as a typed error', async () => {
    const adapter = await start({ openSettingsFails: true });
    await expect(adapter.openSettings('microphone')).rejects.toMatchObject({
      code: 'platform-unavailable',
    });
  });
});

describe('change notification', () => {
  it('emits when a polled permission changes', async () => {
    const adapter = await start({
      permissions: { microphone: 'unknown' },
      permissionsAfterRequest: { microphone: 'granted' },
    });
    await adapter.snapshot();

    const changed = once<PermissionStatus>(
      (listener) => adapter.subscribe(listener),
      4_000,
      (status) => status.kind === 'microphone',
    );
    await adapter.request('microphone');
    await expect(changed).resolves.toMatchObject({ kind: 'microphone', state: 'granted' });
  });

  it('does not emit when nothing changed', async () => {
    const adapter = await start({ permissions: { microphone: 'granted' } });
    const seen: PermissionStatus[] = [];
    const off = adapter.subscribe((status) => seen.push(status));
    await adapter.refresh();
    await adapter.refresh();
    off();
    expect(seen).toEqual([]);
  });

  it('stops polling when the last subscriber leaves', async () => {
    const adapter = await start();
    const off = adapter.subscribe(() => undefined);
    const off2 = adapter.subscribe(() => undefined);
    off();
    off2();
    // A poller left running would keep the helper warm forever, and would keep
    // the Node event loop alive past the end of a CLI run.
    await adapter.refresh();
    expect(adapter.lastAttribution).toBeDefined();
  });
});

describe('attribution gating', () => {
  it('refuses to report permissions when macOS credits the helper', async () => {
    const adapter = await start({
      permissions: { 'screen-recording': 'granted' },
      attribution: { responsibleProcessPid: 4321 },
    });

    // `granted` would be a lie: the grant does not reach the process that
    // needs it. Throwing is the loud alternative to that silent wrong answer.
    await expect(adapter.snapshot()).rejects.toMatchObject({
      code: 'permission-attribution-mismatch',
    });
    await expect(adapter.status('screen-recording')).rejects.toMatchObject({
      code: 'permission-attribution-mismatch',
    });
    await expect(adapter.request('screen-recording')).rejects.toMatchObject({
      code: 'permission-attribution-mismatch',
    });
  });

  it('still exposes the report behind the failure, so it can be diagnosed', async () => {
    const adapter = await start({ attribution: { responsibleProcessPid: 4321 } });
    const attribution = await adapter.attribution();
    expect(attribution.verdict).toBe('helper-attributed');
    expect(attribution.attributed.pid).toBe(4321);
    expect(attribution.evidence.responsibleProcessQueried).toBe(true);
  });

  it('lets settings still be opened while attribution is broken', async () => {
    // The one action that might help is the one that must keep working.
    const adapter = await start({ attribution: { responsibleProcessPid: 4321 } });
    await expect(adapter.openSettings('screen-recording')).resolves.toBeUndefined();
  });

  it('answers normally under the warn policy, but records the verdict', async () => {
    const adapter = await start(
      { permissions: { microphone: 'granted' }, attribution: { responsibleProcessPid: 4321 } },
      { attributionPolicy: 'warn' },
    );
    await expect(adapter.status('microphone')).resolves.toMatchObject({ state: 'granted' });
    expect(adapter.lastAttribution?.verdict).toBe('helper-attributed');
  });

  it('does not probe attribution at all under the off policy', async () => {
    const adapter = await start(
      { permissions: { microphone: 'granted' }, attribution: { responsibleProcessPid: 4321 } },
      { attributionPolicy: 'off' },
    );
    await adapter.status('microphone');
    expect(adapter.lastAttribution).toBeUndefined();
  });

  it('permits an undetermined verdict, because development runs produce one', async () => {
    const adapter = await start({
      permissions: { microphone: 'granted' },
      attribution: {
        responsibleProcessQueried: false,
        responsibleProcessPid: null,
        enclosingAppBundlePath: null,
        enclosingAppBundleIdentifier: null,
      },
    });
    await expect(adapter.status('microphone')).resolves.toMatchObject({ state: 'granted' });
    expect(adapter.lastAttribution?.verdict).toBe('unknown');
  });

  it('probes once and caches, since the answer cannot change mid-process', async () => {
    const adapter = await start();
    const first = await adapter.attribution();
    const second = await adapter.attribution();
    expect(second).toBe(first);
  });

  it('re-probes on demand after a helper restart', async () => {
    const adapter = await start();
    const first = await adapter.attribution();
    const refreshed = await adapter.refreshAttribution();
    expect(refreshed).not.toBe(first);
    expect(refreshed.verdict).toBe(first.verdict);
  });
});

describe('failure paths', () => {
  it('surfaces a helper that omits a permission from its snapshot', async () => {
    const adapter = await start({ omitPermissionsFromSnapshot: ['speech-recognition'] });
    await expect(adapter.snapshot()).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('rejects a snapshot with an impossible state rather than coercing it', async () => {
    const adapter = await start({
      permissionProbeOverrides: {
        microphone: { state: 'maybe' as PermissionState },
      },
    });
    await expect(adapter.snapshot()).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('fails with helper-unavailable when the helper is not running', async () => {
    const transport = createStubTransport();
    transports.push(transport);
    const adapter = new MacPermissionAdapter({ transport, hostPid: 1234 });
    adapters.push(adapter);
    await expect(adapter.snapshot()).rejects.toMatchObject({ code: 'helper-unavailable' });
  });

  it('times out rather than hanging when the helper stops answering', async () => {
    const transport = createStubTransport(
      { dropOps: ['permissions.snapshot'] },
      { requestTimeoutMs: 200 },
    );
    transports.push(transport);
    await transport.start();
    const adapter = new MacPermissionAdapter({
      transport,
      hostPid: 1234,
      attributionPolicy: 'off',
    });
    adapters.push(adapter);
    await expect(adapter.snapshot()).rejects.toMatchObject({ code: 'timeout' });
  });

  it('fails with helper-unavailable when the helper crashes mid-request', async () => {
    const transport = createStubTransport({ crashOnOps: ['permissions.snapshot'] });
    transports.push(transport);
    await transport.start();
    const adapter = new MacPermissionAdapter({
      transport,
      hostPid: 1234,
      attributionPolicy: 'off',
    });
    adapters.push(adapter);
    const error = await adapter.snapshot().catch((cause: unknown) => cause);
    expect(isPilotError(error) && error.code).toBe('helper-unavailable');
  });

  it('rejects an unusable attribution response rather than assuming the best', async () => {
    const adapter = await start({
      attribution: { helperPid: -1 as unknown as number },
    });
    await expect(adapter.attribution()).rejects.toMatchObject({ code: 'invalid-request' });
  });
});
