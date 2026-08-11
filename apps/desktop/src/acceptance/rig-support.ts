import { encodePng, renderSyntheticScreen } from '@pilot/observation';
import {
  asFrameId,
  MVP_SCREEN_POLICY,
  type CapturedFrame,
  type ObservedWindow,
  type PixelSize,
} from '@pilot/shared';
import { AX_ELEMENTS } from '../observation/ask-demo.js';
import {
  createObservationRig,
  DEMO_WINDOWS,
  type ObservationRig,
  type ObservationRigOptions,
} from '../observation/observe-rig.js';

/**
 * Shared scaffolding for PR-043's acceptance suite.
 *
 * Everything here is about the *two display scales*. `docs/mvp-01-point-ask-hear.md`
 * §19 asks for the acceptance tests to pass "on at least one standard-DPI and
 * one Retina/display-scaled setup", and until this PR every walkthrough in the
 * repository ran at one scale — `DEMO_DISPLAYS` is a single 2× display and
 * `ask-demo.ts`'s `buildScreenshot` hardcodes `scaleFactor: 2`. The 1× path
 * through `packages/shared/src/geometry.ts` has unit tests and has never been
 * exercised by the assembled application.
 *
 * The one substitution is the same one every walkthrough since PR-028 has made:
 * the stub's own capture frames are deterministic bytes that do not decode
 * (runbook cross-lane issue 11), so a decodable *synthetic* screenshot is
 * pushed through `ObservationSession.ingestFrame` — the entry point
 * `MacObservationAdapter`'s frames arrive on. Unlike the earlier walkthroughs,
 * the frame here is built at **exactly the size Pilot asked the platform for**,
 * so `GroundedPointer.capturedPixelPoint` (computed from `WindowGeometry.captureSize`,
 * which comes from `capture.start`) and the crop rectangle (computed from the
 * ingested frame's own size) are talking about the same image. A 1280×800 stand-in
 * against a 1440×960 request — which is what `pnpm demo:ask` pushes — makes every
 * pixel coordinate below off by 12%, which is fine for a walkthrough and useless
 * for a grounding measurement.
 */

export const GRANTED = {
  'screen-recording': 'granted',
  accessibility: 'granted',
  microphone: 'granted',
  'speech-recognition': 'granted',
} as const;

/** The selected window the stub describes: `DEMO_WINDOWS[0]`, Safari. */
export const WINDOW_BOUNDS = { x: 100, y: 80, width: 1200, height: 800 } as const;

/**
 * The synthetic screen's Auto Renew toggle and password field, in normalised
 * window coordinates.
 *
 * Copied from `packages/observation/src/image-fixtures.ts` rather than exported
 * from it, for the reason that file gives for its own fixtures: a constant
 * shared with the code under test cannot catch a drift between them. If
 * `renderSyntheticScreen` moves the toggle, the crop-containment cases below
 * start failing, which is the correct outcome — the picture and the claim about
 * the picture would have diverged.
 */
export const SYNTHETIC_TOGGLE = { x: 0.54, y: 0.42, width: 0.055, height: 0.035 } as const;
export const SYNTHETIC_PASSWORD_FIELD = {
  x: 0.34,
  y: 0.62,
  width: 0.26,
  height: 0.05,
} as const;

function screenRectOf(normalized: { x: number; y: number; width: number; height: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: Math.round(WINDOW_BOUNDS.x + normalized.x * WINDOW_BOUNDS.width),
    y: Math.round(WINDOW_BOUNDS.y + normalized.y * WINDOW_BOUNDS.height),
    width: Math.round(normalized.width * WINDOW_BOUNDS.width),
    height: Math.round(normalized.height * WINDOW_BOUNDS.height),
  };
}

/** The centre of a normalised region, as a screen point. */
export function screenPointAt(normalized: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number } {
  return {
    x: Math.round(WINDOW_BOUNDS.x + (normalized.x + normalized.width / 2) * WINDOW_BOUNDS.width),
    y: Math.round(WINDOW_BOUNDS.y + (normalized.y + normalized.height / 2) * WINDOW_BOUNDS.height),
  };
}

/**
 * `ask-demo.ts`'s four elements plus a **secure** one over the synthetic
 * screen's password field.
 *
 * PR-013 classifies `AXSecureTextField` as secure and the §10 pipeline masks
 * it; nothing in the assembled application has ever put the *anchor's own*
 * element on a secure field, so "the crop the model receives has the password
 * masked" has never been read off a real observation. Case G-28 is that read.
 * It is a separate list rather than an addition to `AX_ELEMENTS` so `pnpm
 * demo:ask`'s recorded output is untouched.
 */
export const ACCEPTANCE_AX_ELEMENTS = [
  ...AX_ELEMENTS,
  {
    bounds: screenRectOf(SYNTHETIC_PASSWORD_FIELD),
    role: 'AXSecureTextField',
    label: 'Password',
    value: 'hunter2-should-never-appear',
    ownerPid: 501,
  },
] as const;

/** One display, at the scale under test. */
export function desktopAt(scaleFactor: number): Record<string, unknown> {
  return {
    windows: DEMO_WINDOWS,
    displays: [
      {
        displayNumber: 1,
        bounds: { x: 0, y: 0, width: 1728, height: 1117 },
        scaleFactor,
        isPrimary: true,
      },
    ],
  };
}

/**
 * The pixel size Pilot asks `capture.start` for at a given scale.
 *
 * Window points × the display's backing scale, reduced to `fullFrameMaxEdge`.
 * Stated here so the suite can push a frame of exactly that size; it is
 * *checked* against the `capture.start` the wire actually carried, so a change
 * in the adapter's sizing shows up as a failing case rather than as a silently
 * wrong coordinate.
 */
export function expectedCaptureSize(scaleFactor: number): PixelSize {
  const requested = {
    width: WINDOW_BOUNDS.width * scaleFactor,
    height: WINDOW_BOUNDS.height * scaleFactor,
  };
  const longest = Math.max(requested.width, requested.height);
  if (longest <= MVP_SCREEN_POLICY.fullFrameMaxEdge) {
    return requested;
  }
  const factor = MVP_SCREEN_POLICY.fullFrameMaxEdge / longest;
  return {
    width: Math.round(requested.width * factor),
    height: Math.round(requested.height * factor),
  };
}

/** A decodable synthetic screenshot at an arbitrary size and scale. */
export async function buildFrame(
  window: ObservedWindow,
  options: {
    readonly id: string;
    readonly capturedAt: number;
    readonly size: PixelSize;
    readonly scaleFactor: number;
    readonly toggleOn?: boolean;
  },
): Promise<CapturedFrame> {
  const screen = renderSyntheticScreen({
    size: options.size,
    ...(options.toggleOn === undefined ? {} : { toggleOn: options.toggleOn }),
  });
  return {
    frameId: asFrameId(options.id),
    windowId: window.windowId,
    capturedAt: options.capturedAt,
    size: options.size,
    scaleFactor: options.scaleFactor,
    encoding: 'png',
    bytes: await encodePng(screen.pixels),
  };
}

export interface AcceptanceRig {
  readonly rig: ObservationRig;
  readonly window: ObservedWindow;
  readonly scaleFactor: number;
  readonly captureSize: PixelSize;
  /** The width/height `capture.start` actually carried, for the check above. */
  readonly requestedCaptureSize: PixelSize | null;
}

/**
 * Builds a rig, grants everything, selects the Safari window and reads back
 * what Pilot asked the platform to capture.
 *
 * One rig per case, deliberately. §10 rate-limits observations to two per
 * second and the frame ring is bounded to three, so a suite that reused one rig
 * across thirty cases would be spending its time sleeping and would make every
 * case depend on the one before it. A rig costs about half a second.
 */
export async function openAcceptanceRig(options: {
  readonly scaleFactor: number;
  readonly stub?: Record<string, unknown>;
  readonly select?: boolean;
  readonly rig?: Partial<ObservationRigOptions>;
}): Promise<AcceptanceRig> {
  const scaleFactor = options.scaleFactor;
  const rig = await createObservationRig({
    stub: {
      permissions: GRANTED,
      desktop: desktopAt(scaleFactor),
      captureFrameBytes: 3_072,
      captureScaleFactor: scaleFactor,
      axElements: ACCEPTANCE_AX_ELEMENTS,
      ...options.stub,
    },
    recordRequests: true,
    // This suite owns the ring: it pushes decodable screenshots, and a stub
    // frame — which is not a decodable image — landing between one of them and
    // the question anchored on it would turn `moment: 'question'` into a decode
    // failure. See `ObservationRigOptions.capturePollIntervalMs`.
    capturePollIntervalMs: 3_600_000,
    ...options.rig,
  });
  await rig.permissions.refresh();
  await rig.observation.refreshAttribution();
  const window = await rig.firstWindow();
  if (options.select !== false) {
    await rig.windows.act({ type: 'select', windowId: window.windowId });
    await rig.controller.settled();
  }
  const start = rig.wire.find((call) => call.op === 'capture.start');
  const requestedCaptureSize =
    start === undefined
      ? null
      : {
          width: Number(start.payload['width']),
          height: Number(start.payload['height']),
        };
  return {
    rig,
    window,
    scaleFactor,
    captureSize: expectedCaptureSize(scaleFactor),
    requestedCaptureSize,
  };
}

/** Everything the provider was told, as a single string, for absence checks. */
export function everythingSent(requests: readonly string[]): string {
  return JSON.stringify(requests);
}

/** A run of base64 long enough to be a payload rather than an identifier. */
export const BASE64_RUN = /[A-Za-z0-9+/]{120,}={0,2}/;

export function frameIdFor(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(4, '0')}`;
}
