/**
 * PR-013 demo: pointer sampling, normalised geometry, AX hit testing, the
 * secure-field flag, the outside-window rule and the degraded mode.
 *
 * ```sh
 * pnpm build                                                   # runs against dist/
 * pnpm --filter @pilot/platform-mac demo:accessibility         # Node stub (Linux and macOS)
 * PILOT_HELPER_BINARY=… pnpm --filter @pilot/platform-mac demo:accessibility   # Swift helper (macOS)
 * ```
 *
 * **What implementation.md asks for and what this is.** The stated demo is
 * "point across a real window and display aligned element metadata". A real
 * window, a real pointer and a real accessibility tree need a Mac, and there is
 * not one here (runbook amendment 8). So against the Node stub this drives a
 * *scripted* pointer path across a scripted window and prints, for each
 * position, exactly which target was selected and why — the host half end to
 * end, over the real framed protocol. It prints which target it selected on its
 * first line, matching the PR-003 and PR-011 demos.
 *
 * On a Mac with the Swift helper built, the same command runs against the real
 * pointer and the real accessibility tree, and becomes the demo
 * implementation.md describes.
 */

import { fileURLToPath } from 'node:url';
import {
  MacAccessibilityAdapter,
  PointerSampler,
  SECURE_FIELD_DISCLOSURE,
  helperBinaryCandidates,
  resolveHelperBinary,
  NativeHelperTransport,
  type HelperTransportOptions,
} from '@pilot/platform-mac';
import type { AccessibilityGroundingTarget, PointerGroundingSample } from '@pilot/platform';
import type { WindowGeometry } from '@pilot/shared';

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const STUB_PATH = fileURLToPath(new URL('./support/helper-stub.ts', import.meta.url));

// A 1200x800 pt Safari window at (100, 80) on a 2x Retina display …
const RETINA: WindowGeometry = {
  windowId: 'mac-window-42' as WindowGeometry['windowId'],
  displayId: 'mac-display-1' as WindowGeometry['displayId'],
  bounds: { x: 100, y: 80, width: 1200, height: 800 },
  scaleFactor: 2,
  captureSize: { width: 2400, height: 1600 },
};

// … and a 1000x700 pt TextEdit window on a 1x display whose origin is negative.
const SECONDARY: WindowGeometry = {
  windowId: 'mac-window-77' as WindowGeometry['windowId'],
  displayId: 'mac-display-2' as WindowGeometry['displayId'],
  bounds: { x: -1600, y: 40, width: 1000, height: 700 },
  scaleFactor: 1,
  captureSize: { width: 1000, height: 700 },
};

const SAFARI_PID = 501;
const TEXTEDIT_PID = 502;
const OTHER_APP_PID = 999;

const RETINA_TARGET: AccessibilityGroundingTarget = { geometry: RETINA, ownerPid: SAFARI_PID };
const SECONDARY_TARGET: AccessibilityGroundingTarget = {
  geometry: SECONDARY,
  ownerPid: TEXTEDIT_PID,
};

const ELEMENTS = [
  {
    bounds: { x: 700, y: 480, width: 60, height: 30 },
    role: 'AXButton',
    subrole: null,
    label: 'Auto Renew',
    value: 'on',
    ownerPid: SAFARI_PID,
  },
  {
    bounds: { x: 400, y: 300, width: 220, height: 24 },
    role: 'AXTextField',
    subrole: 'AXSecureTextField',
    label: 'Password',
    value: 'hunter2',
    ownerPid: SAFARI_PID,
  },
  {
    bounds: { x: 900, y: 500, width: 200, height: 100 },
    role: 'AXStaticText',
    subrole: null,
    label: 'Message from Bob',
    value: 'see you at six',
    ownerPid: OTHER_APP_PID,
  },
  {
    bounds: { x: -1500, y: 140, width: 300, height: 40 },
    role: 'AXTextArea',
    subrole: null,
    label: 'Draft',
    value: 'dear sir',
    ownerPid: TEXTEDIT_PID,
  },
];

/** A pointer path that walks across the Retina window and off it. */
const PATH = [
  { x: 730, y: 495 }, // the Auto Renew button
  { x: 500, y: 310 }, // the password field
  { x: 960, y: 540 }, // inside the window, but another app's surface is on top
  { x: 200, y: 700 }, // inside the window, nothing under the pointer
  { x: 50, y: 480 }, // outside the window, to its left
  { x: -1400, y: 150 }, // over the other window entirely, on the other display
];

interface Target {
  readonly label: string;
  readonly usingStub: boolean;
  readonly options: HelperTransportOptions;
}

function chooseTarget(stub: Record<string, unknown>): Target {
  try {
    const binary = resolveHelperBinary();
    return {
      label: `Swift helper (${binary.source}: ${binary.path}) — real pointer, real accessibility tree`,
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

function describe(sample: PointerGroundingSample): string {
  const { normalizedPoint, screenPoint, capturedPixelPoint } = sample.pointer;
  const position =
    `screen ${screenPoint.x.toFixed(0)},${screenPoint.y.toFixed(0)}  ` +
    `normalised ${normalizedPoint.x.toFixed(3)},${normalizedPoint.y.toFixed(3)}  ` +
    `capture px ${(capturedPixelPoint?.x ?? 0).toFixed(0)},${(capturedPixelPoint?.y ?? 0).toFixed(0)}`;
  const target =
    sample.target === null
      ? `no target (${sample.targetOutcome})`
      : `${sample.target.role ?? '?'} — "${sample.target.label ?? ''}"` +
        (sample.target.value === undefined ? '' : ` value="${sample.target.value}"`) +
        (sample.target.isSecure ? '  [SECURE: value withheld]' : '');
  return `${position}\n      selected: ${target}`;
}

interface WalkOptions {
  readonly includeValues?: boolean;
  readonly scopeToOwningApplication?: boolean;
  readonly axTrusted?: boolean;
}

async function walk(
  label: string,
  target: AccessibilityGroundingTarget,
  options: WalkOptions = {},
): Promise<void> {
  const first = PATH[0] ?? { x: 0, y: 0 };
  const chosen = chooseTarget({
    // The stub hands out the next scripted position on every
    // `accessibility.sample`, and `availability()` costs one. Repeating the
    // first entry pays for it, so the walk below starts where it says it does.
    pointerScript: [first, ...PATH],
    axElements: ELEMENTS,
    ...(options.axTrusted === false ? { axTrusted: false } : {}),
  });
  const transport = new NativeHelperTransport({ ...chosen.options, restart: { enabled: false } });
  await transport.start();
  let tick = 0;
  const adapter = new MacAccessibilityAdapter({
    transport,
    clock: () => tick * 40,
    ...(options.includeValues === true ? { includeElementValues: true } : {}),
    ...(options.scopeToOwningApplication === false ? { scopeToOwningApplication: false } : {}),
  });
  say(`\n${label}`);
  const availability = await adapter.availability();
  say(
    `   accessibility: trusted=${String(availability.trusted)} hitTesting=${String(availability.hitTesting)} degraded=${String(availability.degraded)}`,
  );
  for (let index = 0; index < PATH.length; index += 1) {
    tick = index;
    const sample = await adapter.ground(target);
    const point = PATH[index];
    say(`   ${String(index + 1)}. pointer at ${String(point?.x)},${String(point?.y)}`);
    say(`      ${describe(sample)}`);
  }
  await transport.stop();
}

async function main(): Promise<void> {
  const chosen = chooseTarget({ pointerScript: PATH, axElements: ELEMENTS });
  say(`helper target: ${chosen.label}`);
  if (chosen.usingStub) {
    say(
      `searched: ${helperBinaryCandidates()
        .map((candidate) => candidate.path)
        .join(', ')}`,
    );
    say('NOTE: nothing under native/ has ever been compiled. This is the host half only.');
    say('NOTE: the pointer path below is scripted. No real pointer has been read.');
  }

  say('\n0. the window being observed');
  say(
    `   ${RETINA.windowId}  ${String(RETINA.bounds.width)}x${String(RETINA.bounds.height)} pt at ` +
      `${String(RETINA.bounds.x)},${String(RETINA.bounds.y)}  @${String(RETINA.scaleFactor)}x  ` +
      `capture ${String(RETINA.captureSize.width)}x${String(RETINA.captureSize.height)} px`,
  );
  say(
    `   ${SECONDARY.windowId}  ${String(SECONDARY.bounds.width)}x${String(SECONDARY.bounds.height)} pt at ` +
      `${String(SECONDARY.bounds.x)},${String(SECONDARY.bounds.y)}  @${String(SECONDARY.scaleFactor)}x  ` +
      `capture ${String(SECONDARY.captureSize.width)}x${String(SECONDARY.captureSize.height)} px  (display origin is negative)`,
  );

  await walk(
    '1. pointer walk over the Retina window, values NOT requested (the default)',
    RETINA_TARGET,
  );

  await walk(
    '2. the same walk with element values opted in — the secure field still withholds its value',
    RETINA_TARGET,
    { includeValues: true },
  );

  await walk(
    '3. the same walk with hit-test scoping turned off — step 3 now returns another\n' +
      "   application's element, and the host rejects it as foreign-application",
    RETINA_TARGET,
    { scopeToOwningApplication: false },
  );

  await walk(
    '4. the same walk grounded against the OTHER window — every position but the last is outside it',
    SECONDARY_TARGET,
  );

  await walk(
    '5. accessibility denied — degraded mode keeps the position, drops the element',
    RETINA_TARGET,
    { axTrusted: false },
  );

  say('\n6. ~30 Hz sampling with coalescing');
  const samplerTarget = chooseTarget({
    // Six ticks over three distinct positions: the sampler must emit three.
    pointerScript: [
      { x: 730, y: 495 },
      { x: 730, y: 495 },
      { x: 730, y: 495 },
      { x: 500, y: 310 },
      { x: 500, y: 310 },
      { x: 50, y: 480 },
    ],
    axElements: ELEMENTS,
  });
  const transport = new NativeHelperTransport({
    ...samplerTarget.options,
    restart: { enabled: false },
  });
  await transport.start();
  let now = 0;
  const adapter = new MacAccessibilityAdapter({ transport, clock: () => now });
  const sampler = new PointerSampler({
    source: adapter,
    target: () => RETINA_TARGET,
    clock: () => now,
    coalesceIntervalMs: 40,
  });
  const off = sampler.subscribe((sample) => {
    say(`   emitted at t=${String(sample.at)}ms  ${describe(sample).split('\n')[1]?.trim() ?? ''}`);
  });
  for (let tick = 0; tick < 6; tick += 1) {
    now = tick * 40;
    await sampler.sampleOnce();
  }
  off();
  const metrics = sampler.metrics();
  say(
    `   sampled=${String(metrics.sampled)} emitted=${String(metrics.emitted)} ` +
      `coalescedByInterval=${String(metrics.coalescedByInterval)} coalescedByEquality=${String(metrics.coalescedByEquality)} ` +
      `outsideWindow=${String(metrics.outsideWindow)} degraded=${String(metrics.degraded)}`,
  );
  sampler.dispose();
  await transport.stop();

  say('\n7. the guarantee, stated');
  say(`   ${SECURE_FIELD_DISCLOSURE}`);

  if (chosen.usingStub) {
    say('\nNot demonstrated here (needs a Mac): a real pointer, a real accessibility tree,');
    say('whether AXSecureTextField actually appears where this assumes, and whether');
    say('native/ compiles at all.');
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`demo failed: ${String(error)}\n`);
  process.exitCode = 1;
});
