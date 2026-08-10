/**
 * PR-011 demo: permissions in every state, parent-bundle attribution, window
 * enumeration and the window lifecycle.
 *
 * ```sh
 * pnpm build                                                  # runs against dist/
 * pnpm --filter @pilot/platform-mac demo:permissions          # Node stub (Linux and macOS)
 * PILOT_HELPER_BINARY=… pnpm --filter @pilot/platform-mac demo:permissions   # Swift helper (macOS)
 * ```
 *
 * **What implementation.md asks for and what this is.** The stated demo is
 * "list real windows and display all four permission states". Real windows and
 * real TCC states need a Mac and there is not one here (runbook amendment 8),
 * so against the Node stub this demonstrates the *host* half end to end: the
 * framed protocol, the schemas, the attribution verdict table and the
 * lifecycle diff, with a scripted desktop standing in for a real one. It
 * prints which target it selected on its first line — matching PR-003 — so
 * there is never any doubt about which of the two just ran.
 *
 * On a Mac with the Swift helper built, the same command runs against the real
 * window server and real TCC and the demo becomes the one implementation.md
 * describes.
 */

import { fileURLToPath } from 'node:url';
import {
  MacPermissionAdapter,
  MacWindowAdapter,
  NativeHelperTransport,
  evaluateAttribution,
  helperBinaryCandidates,
  resolveHelperBinary,
  type HelperTransportOptions,
} from '@pilot/platform-mac';
import { PERMISSION_KINDS, type PermissionState } from '@pilot/shared';
import type { WindowEvent } from '@pilot/platform';

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const STUB_PATH = fileURLToPath(new URL('./support/helper-stub.ts', import.meta.url));

const DISPLAYS = [
  {
    displayNumber: 1,
    bounds: { x: 0, y: 0, width: 1728, height: 1117 },
    scaleFactor: 2,
    isPrimary: true,
  },
  {
    displayNumber: 2,
    bounds: { x: -1920, y: -120, width: 1920, height: 1080 },
    scaleFactor: 1,
    isPrimary: false,
  },
];

const safari = (overrides: Record<string, unknown> = {}) => ({
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
  ...overrides,
});

const textEdit = {
  windowNumber: 77,
  ownerPid: 502,
  applicationName: 'TextEdit',
  applicationBundleId: 'com.apple.TextEdit',
  title: 'Untitled.txt',
  titleAvailable: true,
  bounds: { x: -1600, y: 40, width: 1000, height: 700 },
  displayNumber: 2,
  isOnScreen: true,
  layer: 0,
};

/**
 * A scripted desktop, one entry per `windows.list`: two windows, then Safari
 * retitled, then Safari moved and resized, then TextEdit closed, then the
 * screen locked.
 */
const DESKTOP_SCRIPT = [
  { windows: [safari(), textEdit], displays: DISPLAYS, screenLocked: false },
  { windows: [safari({ title: 'Invoices' }), textEdit], displays: DISPLAYS, screenLocked: false },
  {
    windows: [
      safari({ title: 'Invoices', bounds: { x: 400, y: 200, width: 900, height: 600 } }),
      textEdit,
    ],
    displays: DISPLAYS,
    screenLocked: false,
  },
  {
    windows: [safari({ title: 'Invoices', bounds: { x: 400, y: 200, width: 900, height: 600 } })],
    displays: DISPLAYS,
    screenLocked: false,
  },
  {
    windows: [safari({ title: 'Invoices', bounds: { x: 400, y: 200, width: 900, height: 600 } })],
    displays: DISPLAYS,
    screenLocked: true,
  },
];

const STATE_SCRIPT: PermissionState[] = ['unknown', 'denied', 'restricted', 'granted'];

interface Target {
  readonly label: string;
  readonly usingStub: boolean;
  readonly options: HelperTransportOptions;
}

function chooseTarget(stub: Record<string, unknown>): Target {
  try {
    const binary = resolveHelperBinary();
    return {
      label: `Swift helper (${binary.source}: ${binary.path}) — real TCC, real window server`,
      usingStub: false,
      options: { command: binary.path },
    };
  } catch {
    return {
      label: 'Node stub (no Swift helper built; see the README for the Mac steps)',
      usingStub: true,
      options: {
        command: process.execPath,
        args: [STUB_PATH],
        env: { ...process.env, PILOT_HELPER_STUB: JSON.stringify(stub) },
      },
    };
  }
}

function describeEvent(event: WindowEvent): string {
  switch (event.type) {
    case 'window-list-changed': {
      const appeared = (event.appeared ?? []).map((window) => window.title).join(', ');
      const disappeared = (event.disappeared ?? []).join(', ');
      const parts: string[] = [];
      if (appeared !== '') {
        parts.push(`appeared=[${appeared}]`);
      }
      if (disappeared !== '') {
        parts.push(`disappeared=[${disappeared}]`);
      }
      return `window-list-changed ${parts.join(' ')}`;
    }
    case 'window-changed':
      return `window-changed ${event.window.windowId} changes=[${(event.changes ?? []).join(', ')}] title="${event.window.title}"`;
    case 'window-closed':
      return `window-closed ${event.windowId}`;
    default:
      return event.type;
  }
}

async function section1Permissions(): Promise<void> {
  say('\n1. all four permissions × all four states');
  for (const state of STATE_SCRIPT) {
    const target = chooseTarget({
      permissions: Object.fromEntries(PERMISSION_KINDS.map((kind) => [kind, state])),
    });
    const transport = new NativeHelperTransport({ ...target.options, restart: { enabled: false } });
    await transport.start();
    const permissions = new MacPermissionAdapter({
      transport,
      expectedBundleIdentifier: 'com.pilot.app',
      expectedBundlePath: '/Applications/Pilot.app',
      hostPid: 1234,
      attributionPolicy: target.usingStub ? 'enforce' : 'warn',
    });
    const snapshot = await permissions.snapshot();
    const row = PERMISSION_KINDS.map(
      (kind) => `${kind}=${snapshot[kind].state}${snapshot[kind].canRequest ? '(askable)' : ''}`,
    ).join('  ');
    say(`   ${row}`);
    permissions.dispose();
    await transport.stop();
    if (!target.usingStub) {
      // Against real TCC there is one true answer, not a script.
      break;
    }
  }
}

async function main(): Promise<void> {
  const target = chooseTarget({ desktopScript: DESKTOP_SCRIPT });
  say(`helper target: ${target.label}`);
  if (target.usingStub) {
    say(
      `searched: ${helperBinaryCandidates()
        .map((candidate) => candidate.path)
        .join(', ')}`,
    );
    say('NOTE: nothing under native/ has ever been compiled. This is the host half only.');
  }

  await section1Permissions();

  const transport = new NativeHelperTransport({ ...target.options, restart: { enabled: false } });
  await transport.start();

  const permissions = new MacPermissionAdapter({
    transport,
    expectedBundleIdentifier: 'com.pilot.app',
    expectedBundlePath: '/Applications/Pilot.app',
    hostPid: 1234,
    attributionPolicy: 'warn',
  });
  const windows = new MacWindowAdapter({ transport, pollIntervalMs: 600_000 });

  say('\n2. parent-bundle attribution');
  const attribution = await permissions.attribution();
  say(`   verdict=${attribution.verdict} confidence=${attribution.confidence}`);
  say(`   reason=${attribution.reason}`);
  say(
    `   expected=${attribution.expected.bundleIdentifier ?? 'none'} (pid ${String(attribution.expected.pid)})` +
      `  attributed=${attribution.attributed.bundleIdentifier ?? 'none'} (pid ${String(attribution.attributed.pid)})`,
  );

  say('\n3. the verdict table, evaluated on synthetic evidence');
  const base = {
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
  const expected = {
    bundleIdentifier: 'com.pilot.app',
    bundlePath: '/Applications/Pilot.app',
    hostPid: 1234,
  };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['macOS credits the app', {}],
    ['macOS credits the helper', { responsibleProcessPid: 4321 }],
    ['macOS credits a third process', { responsibleProcessPid: 9999 }],
    [
      'helper has its own bundle id',
      {
        responsibleProcessQueried: false,
        responsibleProcessPid: null,
        helperBundleIdentifier: 'com.pilot.app.helper',
      },
    ],
    [
      'helper is not in any bundle',
      {
        responsibleProcessQueried: false,
        responsibleProcessPid: null,
        enclosingAppBundlePath: null,
        enclosingAppBundleIdentifier: null,
      },
    ],
  ];
  for (const [label, overrides] of cases) {
    const verdict = evaluateAttribution({
      evidence: { ...base, ...overrides } as typeof base,
      expected,
      checkedAt: 0,
    });
    say(`   ${label.padEnd(32)} -> ${verdict.verdict} (${verdict.confidence})`);
  }

  say('\n4. window enumeration');
  const listed = await windows.list();
  for (const window of listed) {
    say(
      `   ${window.windowId}  ${window.applicationName} — "${window.title}"  ` +
        `${String(window.bounds.width)}×${String(window.bounds.height)} @${String(window.scaleFactor)}x  ${window.displayId}`,
    );
  }
  const first = listed[0];
  if (first !== undefined) {
    const geometry = await windows.geometry(first.windowId);
    say(
      `   geometry(${first.windowId}) captureSize=${String(geometry?.captureSize.width)}×${String(geometry?.captureSize.height)}`,
    );
  }

  say('\n5. window lifecycle (scripted desktop; each tick is one windows.list)');
  const off = windows.subscribe((event) => {
    say(`   ${describeEvent(event)}`);
  });
  for (let tick = 0; tick < DESKTOP_SCRIPT.length; tick += 1) {
    await windows.refresh();
  }
  off();

  say('\n6. window id stability');
  const selected = listed[0]?.windowId;
  const stillThere = selected === undefined ? null : await windows.get(selected);
  say(
    `   selected ${String(selected)} survived retitle + move + resize: ${String(stillThere !== null)}`,
  );
  say(
    '   the id is a pure function of the CGWindowID, so a helper restart re-derives it unchanged',
  );

  say('\n7. failure states');
  try {
    await permissions.status('microphone' as never);
    say('   status(microphone) -> ok');
  } catch (error) {
    say(`   status(microphone) -> ${(error as { code?: string }).code ?? 'unknown'}`);
  }
  say(`   get(unknown-platform-id) -> ${String(await windows.get('window-retina' as never))}`);

  say('\n8. stop');
  permissions.dispose();
  windows.dispose();
  await transport.stop();
  say(`   state=${transport.state}`);

  if (target.usingStub) {
    say('\nNot demonstrated here (needs a Mac): real TCC answers, real window titles,');
    say('the real attribution verdict, and whether native/ compiles at all.');
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`demo failed: ${String(error)}\n`);
  process.exitCode = 1;
});
