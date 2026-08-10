import {
  buildGroundedPointer,
  createCounterIdSource,
  createIdFactory,
  normalizedToScreen,
  type CapturedFrame,
  type NormalizedPoint,
  type ObservedWindow,
  type WindowGeometry,
} from '@pilot/shared';
import type { WindowEvent } from '@pilot/platform';
import {
  FAKE_EPOCH_MS,
  FIXTURE_ACCESSIBILITY_NODE,
  FIXTURE_GEOMETRY_RETINA,
  FIXTURE_WINDOW_RETINA,
  FakeAccessibilityAdapter,
  FakeObservationAdapter,
  FakeWindowAdapter,
  createFakeClock,
  createFixtureFrameBytes,
} from '@pilot/platform/fakes';
import type { AdjustableClock } from './clock.js';
import { ObservationCore } from './observation-core.js';
import { ObservationSession, type FrameIngestOutcome } from './observation-session.js';
import type { PointerSampleInput } from './pointer-timeline.js';
import type { SceneSignalsPatch, SceneTransition } from './scene-tracker.js';
import type { FrameIngestResult, PointerIngestResult } from './observation-core.js';

/**
 * Recorded observation fixtures.
 *
 * A recorded session is a deterministic script: frames at the policy sample
 * rate, pointer samples at ~30 Hz, a couple of scene changes, and a "question
 * moment" to anchor against. Downstream lanes (PR-016…PR-019) replay these
 * instead of capturing anything, and the demo in `demo.ts` prints what the
 * core selected for the question moment.
 *
 * The window, geometry and byte generator are reused from
 * `@pilot/platform/fakes` so a fixture frame carries the same identities here
 * as it does in every other package.
 */

export interface RecordedScenePatch {
  readonly at: number;
  readonly patch: SceneSignalsPatch;
}

/** A window lifecycle event at a recorded moment (PR-016). */
export interface RecordedWindowEvent {
  readonly at: number;
  readonly event: WindowEvent;
  /** Human label for the demo. */
  readonly label: string;
}

/**
 * A stretch of the session during which the window shows one thing (PR-016).
 *
 * Frames inside an epoch differ only in their tail — the way an entropy-coded
 * frame differs when a small region near the bottom repaints. A new epoch
 * replaces everything after `carryOver` of the payload, which is what a real
 * encoder produces when the visible content changes: the bit stream
 * desynchronises from the first changed block onwards.
 */
export interface RecordedContentEpoch {
  readonly at: number;
  readonly label: string;
  /**
   * Fraction of the previous epoch's payload that survives, in `[0, 1)`. Low
   * values are a big visual change; values close to 1 model the change the
   * fingerprint rule is blind to.
   */
  readonly carryOver: number;
}

export interface RecordedObservationFixture {
  readonly window: ObservedWindow;
  readonly geometry: WindowGeometry;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly frames: readonly CapturedFrame[];
  readonly pointerSamples: readonly PointerSampleInput[];
  readonly scenePatches: readonly RecordedScenePatch[];
  /** Scripted window lifecycle events; empty unless the fixture asked for them. */
  readonly windowEvents: readonly RecordedWindowEvent[];
  /** Scripted content epochs; empty unless the fixture asked for them. */
  readonly contentEpochs: readonly RecordedContentEpoch[];
  /** End of the simulated utterance — the moment a question anchors to. */
  readonly questionAt: number;
  /** Start of the simulated utterance, for pointer-path queries. */
  readonly utteranceStartedAt: number;
}

export interface RecordedObservationFixtureOptions {
  readonly window?: ObservedWindow;
  readonly geometry?: WindowGeometry;
  readonly startedAt?: number;
  readonly durationMs?: number;
  /** Capture rate; defaults to the policy sample rate of 3 FPS. */
  readonly frameFps?: number;
  /** Pointer rate before coalescing; defaults to 30 Hz. */
  readonly pointerHz?: number;
  /** Payload size per frame. Small by default so tests stay fast. */
  readonly frameByteLength?: number;
  /** Replaces the default scene patches. */
  readonly scenePatches?: readonly RecordedScenePatch[];
  /** Window lifecycle events to script. */
  readonly windowEvents?: readonly RecordedWindowEvent[];
  /**
   * Content epochs to script. When given, frame payloads are generated from
   * the epoch model above instead of the PR-004 per-frame byte generator, so
   * the content fingerprint has something realistic to judge.
   */
  readonly contentEpochs?: readonly RecordedContentEpoch[];
  /**
   * Fraction of each frame's payload that differs from the epoch baseline —
   * the encoder noise a fingerprint must tolerate. Default 0.06.
   */
  readonly frameNoiseFraction?: number;
  /** First normalised pointer position. Default `{x: 0.2, y: 0.25}`. */
  readonly pointerFrom?: NormalizedPoint;
  /** Last normalised pointer position. Default `{x: 0.6, y: 0.6}`. */
  readonly pointerTo?: NormalizedPoint;
  /**
   * Moment the pointer reaches `pointerTo` and dwells there. Defaults to the
   * end of the session, i.e. a constant drag with no dwell.
   */
  readonly pointerSettleAt?: number;
}

/**
 * Deterministic pseudo-random bytes. A fixed seed makes every fixture payload
 * reproducible across processes without pulling in a PRNG dependency.
 */
function seededBytes(seed: number, length: number, into?: Uint8Array, offset = 0): Uint8Array {
  const bytes = into ?? new Uint8Array(length);
  let state = (seed * 2654435761) >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[offset + index] = (state >>> 24) & 0xff;
  }
  return bytes;
}

/**
 * Payload for one frame of a scripted content session: the epoch baseline with
 * a per-frame noise tail.
 */
function contentFrameBytes(
  epochBaselines: readonly Uint8Array[],
  epochIndex: number,
  frameIndex: number,
  noiseFraction: number,
): Uint8Array {
  const baseline = epochBaselines[epochIndex] ?? new Uint8Array(0);
  const bytes = Uint8Array.from(baseline);
  const noise = Math.min(bytes.length, Math.round(bytes.length * noiseFraction));
  if (noise > 0) {
    seededBytes(0x51ed + epochIndex * 977 + frameIndex, noise, bytes, bytes.length - noise);
  }
  return bytes;
}

function epochBaselines(
  epochs: readonly RecordedContentEpoch[],
  byteLength: number,
): readonly Uint8Array[] {
  const baselines: Uint8Array[] = [];
  epochs.forEach((epoch, index) => {
    const previous = baselines[index - 1];
    const carried =
      previous === undefined
        ? 0
        : Math.round(byteLength * Math.min(Math.max(epoch.carryOver, 0), 1));
    const bytes = new Uint8Array(byteLength);
    if (previous !== undefined && carried > 0) {
      bytes.set(previous.subarray(0, carried), 0);
    }
    seededBytes(0xc0de + index * 7919, byteLength - carried, bytes, carried);
    baselines.push(bytes);
  });
  return baselines;
}

/**
 * Builds one recorded session. Every timestamp is derived from `startedAt`, so
 * two calls with the same options produce byte-identical fixtures.
 */
export function createRecordedObservationFixture(
  options: RecordedObservationFixtureOptions = {},
): RecordedObservationFixture {
  const window = options.window ?? FIXTURE_WINDOW_RETINA;
  const geometry = options.geometry ?? FIXTURE_GEOMETRY_RETINA;
  const startedAt = options.startedAt ?? FAKE_EPOCH_MS;
  const durationMs = options.durationMs ?? 4000;
  const frameFps = options.frameFps ?? 3;
  const pointerHz = options.pointerHz ?? 30;
  const frameByteLength = options.frameByteLength ?? 4096;
  const contentEpochs = options.contentEpochs ?? [];
  const noiseFraction = options.frameNoiseFraction ?? 0.06;
  const baselines = epochBaselines(contentEpochs, frameByteLength);

  const ids = createIdFactory(createCounterIdSource());
  const frameCount = Math.floor((durationMs * frameFps) / 1000) + 1;
  const frames: CapturedFrame[] = Array.from({ length: frameCount }, (_unused, index) => {
    const capturedAt = startedAt + Math.round((index * 1000) / frameFps);
    const epochIndex = contentEpochs.reduce(
      (current, epoch, position) => (capturedAt >= epoch.at ? position : current),
      0,
    );
    return {
      frameId: ids.frame(),
      windowId: window.windowId,
      capturedAt,
      size: geometry.captureSize,
      scaleFactor: geometry.scaleFactor,
      encoding: 'jpeg' as const,
      bytes:
        contentEpochs.length === 0
          ? createFixtureFrameBytes(index, frameByteLength)
          : contentFrameBytes(baselines, epochIndex, index, noiseFraction),
    };
  });

  const pointerFrom = options.pointerFrom ?? { x: 0.2, y: 0.25 };
  const pointerTo = options.pointerTo ?? { x: 0.6, y: 0.6 };
  const pointerSettleAt = options.pointerSettleAt ?? startedAt + durationMs;
  const pointerCount = Math.floor((durationMs * pointerHz) / 1000) + 1;
  const pointerSamples: PointerSampleInput[] = Array.from(
    { length: pointerCount },
    (_unused, index) => {
      const at = startedAt + Math.round((index * 1000) / pointerHz);
      // A straight diagonal drag across the window, ending on the fixture's
      // accessibility target so the anchor lookup has something to point at.
      // The pointer dwells there once it arrives.
      const travel = Math.max(1, pointerSettleAt - startedAt);
      const progress = pointerCount === 1 ? 0 : Math.min(1, (at - startedAt) / travel);
      const screenPoint = normalizedToScreen(
        {
          x: pointerFrom.x + progress * (pointerTo.x - pointerFrom.x),
          y: pointerFrom.y + progress * (pointerTo.y - pointerFrom.y),
        },
        geometry,
      );
      return {
        at,
        windowId: window.windowId,
        pointer: buildGroundedPointer(
          screenPoint,
          geometry,
          progress > 0.9 ? FIXTURE_ACCESSIBILITY_NODE : undefined,
        ),
      };
    },
  );

  const scenePatches: readonly RecordedScenePatch[] = options.scenePatches ?? [
    { at: startedAt + 1500, patch: { contentFingerprint: 'content-b' } },
    {
      at: startedAt + 2500,
      patch: {
        geometry: { ...geometry, bounds: { ...geometry.bounds, x: geometry.bounds.x + 40 } },
      },
    },
    { at: startedAt + 3000, patch: { accessibilityRootId: 'ax-root-2' } },
  ];

  return {
    window,
    geometry,
    startedAt,
    durationMs,
    frames,
    pointerSamples,
    scenePatches,
    windowEvents: options.windowEvents ?? [],
    contentEpochs,
    utteranceStartedAt: startedAt + 2000,
    questionAt: startedAt + 3200,
  };
}

export interface ReplayEvent {
  readonly at: number;
  readonly kind: 'frame' | 'pointer' | 'scene';
  readonly result: FrameIngestResult | PointerIngestResult | SceneTransition;
}

export interface ReplayOptions {
  /** Stop after this timestamp. Defaults to the end of the fixture. */
  readonly until?: number;
  /** Select the window before replaying. Default `true`. */
  readonly select?: boolean;
}

export interface ReplayReport {
  readonly events: readonly ReplayEvent[];
  readonly admittedFrames: number;
  readonly rejectedFrames: number;
  readonly admittedPointerSamples: number;
  readonly coalescedPointerSamples: number;
  readonly sceneTransitions: readonly SceneTransition[];
}

/**
 * Replays a recorded fixture into a core, driving the injected clock so age
 * bounds and coalescing behave exactly as they would live. Nothing here is
 * asynchronous: the whole session is deterministic.
 */
export function replayRecordedFixture(
  core: ObservationCore,
  fixture: RecordedObservationFixture,
  clock: AdjustableClock,
  options: ReplayOptions = {},
): ReplayReport {
  const until = options.until ?? fixture.startedAt + fixture.durationMs;
  const events: ReplayEvent[] = [];
  const sceneTransitions: SceneTransition[] = [];

  const advanceTo = (at: number): void => {
    const delta = at - clock.now();
    if (delta > 0) {
      clock.advance(delta);
    }
  };

  if (options.select !== false) {
    advanceTo(fixture.startedAt);
    const transition = core.selectWindow({
      window: fixture.window,
      geometry: fixture.geometry,
      accessibilityRootId: 'ax-root-1',
      contentFingerprint: 'content-a',
    });
    sceneTransitions.push(transition);
    events.push({ at: fixture.startedAt, kind: 'scene', result: transition });
  }

  interface Step {
    readonly at: number;
    readonly kind: ReplayEvent['kind'];
    readonly run: () => ReplayEvent;
  }
  const steps: Step[] = [
    ...fixture.scenePatches.map((patch) => ({
      at: patch.at,
      kind: 'scene' as const,
      run: (): ReplayEvent => ({
        at: patch.at,
        kind: 'scene' as const,
        result: core.updateScene(patch.patch),
      }),
    })),
    ...fixture.frames.map((frame) => ({
      at: frame.capturedAt,
      kind: 'frame' as const,
      run: (): ReplayEvent => ({
        at: frame.capturedAt,
        kind: 'frame' as const,
        result: core.ingestFrame(frame),
      }),
    })),
    ...fixture.pointerSamples.map((sample) => ({
      at: sample.at,
      kind: 'pointer' as const,
      run: (): ReplayEvent => ({
        at: sample.at,
        kind: 'pointer' as const,
        result: core.ingestPointer(sample),
      }),
    })),
  ];

  // Scene first, then frame, then pointer at equal timestamps, so a frame is
  // always stamped with the revision in force at its own moment.
  const kindOrder: Record<ReplayEvent['kind'], number> = { scene: 0, frame: 1, pointer: 2 };
  const ordered = [...steps].sort((a, b) => a.at - b.at || kindOrder[a.kind] - kindOrder[b.kind]);

  let admittedFrames = 0;
  let rejectedFrames = 0;
  let admittedPointerSamples = 0;
  let coalescedPointerSamples = 0;

  for (const step of ordered) {
    if (step.at > until) {
      break;
    }
    advanceTo(step.at);
    const event = step.run();
    events.push(event);
    if (event.kind === 'frame') {
      const result = event.result as FrameIngestResult;
      if (result.admitted) {
        admittedFrames += 1;
      } else {
        rejectedFrames += 1;
      }
    } else if (event.kind === 'pointer') {
      const result = event.result as PointerIngestResult;
      if (result.admitted) {
        admittedPointerSamples += 1;
        if (result.coalesced) {
          coalescedPointerSamples += 1;
        }
      }
    } else {
      sceneTransitions.push(event.result as SceneTransition);
    }
  }

  return {
    events,
    admittedFrames,
    rejectedFrames,
    admittedPointerSamples,
    coalescedPointerSamples,
    sceneTransitions,
  };
}

// ---------------------------------------------------------------------------
// PR-016: platform-event replay
// ---------------------------------------------------------------------------

/** Title the scripted window takes when the confirmation sheet opens. */
export const SCENE_FIXTURE_SECOND_TITLE = 'Billing Settings — Confirm renewal';

/**
 * The PR-016 preset: the same recorded session, scripted with content epochs
 * and window lifecycle events so the scene revision moves for the reasons the
 * design names rather than through hand-written patches.
 *
 * The third epoch is deliberately a change the fingerprint rule *cannot* see —
 * a single toggle flipping. The demo prints it as such.
 */
export function createSceneLineageFixture(
  options: RecordedObservationFixtureOptions = {},
): RecordedObservationFixture {
  const startedAt = options.startedAt ?? FAKE_EPOCH_MS;
  const window = options.window ?? FIXTURE_WINDOW_RETINA;
  const geometry = options.geometry ?? FIXTURE_GEOMETRY_RETINA;
  const movedWindow: ObservedWindow = {
    ...window,
    title: SCENE_FIXTURE_SECOND_TITLE,
  };
  return createRecordedObservationFixture({
    ...options,
    startedAt,
    window,
    geometry,
    scenePatches: [],
    // Large enough that one content-defined chunk is well under a percent of
    // the payload: at 4 KiB the fingerprint's resolution is coarser than the
    // encoder noise it has to tolerate.
    frameByteLength: options.frameByteLength ?? 32 * 1024,
    frameNoiseFraction: options.frameNoiseFraction ?? 0.04,
    // Ends on the fixture accessibility node so the fake hit test finds it,
    // and dwells there before the utterance ends — the user points, then asks.
    pointerFrom: { x: 0.2, y: 0.25 },
    pointerTo: { x: 0.525, y: 0.51875 },
    pointerSettleAt: options.pointerSettleAt ?? startedAt + 2900,
    contentEpochs: [
      { at: startedAt, label: 'billing settings page', carryOver: 0 },
      { at: startedAt + 1667, label: 'renewal confirmation sheet opens', carryOver: 0.2 },
      { at: startedAt + 3000, label: 'auto-renew toggle flips off', carryOver: 0.97 },
    ],
    windowEvents: [
      {
        at: startedAt + 2333,
        label: 'window title changes',
        event: { type: 'window-changed', window: movedWindow },
      },
      {
        at: startedAt + 2667,
        label: 'window moves 40 px right',
        event: {
          type: 'window-changed',
          window: {
            ...movedWindow,
            bounds: { ...movedWindow.bounds, x: movedWindow.bounds.x + 40 },
          },
        },
      },
    ],
  });
}

export interface ReplayAdapters {
  readonly observation: FakeObservationAdapter;
  readonly accessibility: FakeAccessibilityAdapter;
  readonly windows: FakeWindowAdapter;
}

export interface SessionReplayHarness {
  readonly clock: AdjustableClock;
  readonly core: ObservationCore;
  readonly session: ObservationSession;
  readonly adapters: ReplayAdapters;
  /** Every scene transition the session produced, in order. */
  readonly transitions: SceneTransition[];
  /** Every frame outcome the session produced, in order. */
  readonly frameOutcomes: FrameIngestOutcome[];
}

/**
 * Builds a core, a session and the PR-001 platform fakes wired together, all
 * on one fake clock. This is the deterministic harness PR-016 tests and the
 * demo replay against.
 */
export function createSessionReplayHarness(
  fixture: RecordedObservationFixture,
): SessionReplayHarness {
  const clock = createFakeClock(fixture.startedAt);
  const core = new ObservationCore({ clock, ids: createIdFactory(createCounterIdSource()) });
  const adapters: ReplayAdapters = {
    observation: new FakeObservationAdapter({ frames: fixture.frames }),
    accessibility: new FakeAccessibilityAdapter(),
    windows: new FakeWindowAdapter(),
  };
  const transitions: SceneTransition[] = [];
  const frameOutcomes: FrameIngestOutcome[] = [];
  const session = new ObservationSession({
    core,
    clock,
    observation: adapters.observation,
    accessibility: adapters.accessibility,
    windows: adapters.windows,
    onSceneTransition: (transition) => transitions.push(transition),
    onFrame: (outcome) => frameOutcomes.push(outcome),
  });
  return { clock, core, session, adapters, transitions, frameOutcomes };
}

export interface AdapterReplayEvent {
  readonly at: number;
  readonly kind: 'window' | 'frame' | 'pointer';
  readonly label: string;
}

export interface AdapterReplayReport {
  readonly events: readonly AdapterReplayEvent[];
  readonly admittedFrames: number;
  readonly rejectedFrames: number;
  readonly pointerSamples: number;
  /** Frames whose own content minted a new fingerprint. */
  readonly contentRevisions: number;
  readonly frameOutcomes: readonly FrameIngestOutcome[];
}

export interface AdapterReplayOptions {
  /** Stop after this timestamp. Defaults to the end of the fixture. */
  readonly until?: number;
  /** Start the session before replaying. Default `true`. */
  readonly start?: boolean;
}

/**
 * Replays a recorded fixture **through the platform adapters**: window events
 * go through `WindowAdapter.subscribe`, frames through
 * `ObservationAdapter.subscribe`, and pointer samples are pulled from
 * `AccessibilityAdapter` exactly as the real session will pull them.
 *
 * Ordering at equal timestamps is window → frame → pointer, so a frame is
 * always judged against the scene in force at its own moment.
 */
export async function replayFixtureThroughAdapters(
  harness: SessionReplayHarness,
  fixture: RecordedObservationFixture,
  options: AdapterReplayOptions = {},
): Promise<AdapterReplayReport> {
  const until = options.until ?? fixture.startedAt + fixture.durationMs;
  const events: AdapterReplayEvent[] = [];
  const { clock, session, adapters, frameOutcomes } = harness;

  const advanceTo = (at: number): void => {
    const delta = at - clock.now();
    if (delta > 0) {
      clock.advance(delta);
    }
  };

  if (options.start !== false) {
    advanceTo(fixture.startedAt);
    await session.start({
      window: fixture.window,
      geometry: fixture.geometry,
      accessibilityRootId: 'ax-root-1',
    });
  }

  interface Step {
    readonly at: number;
    readonly kind: AdapterReplayEvent['kind'];
    readonly run: () => Promise<AdapterReplayEvent>;
  }

  const steps: Step[] = [
    ...fixture.windowEvents.map((entry) => ({
      at: entry.at,
      kind: 'window' as const,
      run: async (): Promise<AdapterReplayEvent> => {
        applyWindowEvent(adapters.windows, entry.event);
        return { at: entry.at, kind: 'window' as const, label: entry.label };
      },
    })),
    ...fixture.frames.map((frame) => ({
      at: frame.capturedAt,
      kind: 'frame' as const,
      run: async (): Promise<AdapterReplayEvent> => {
        const before = frameOutcomes.length;
        adapters.observation.emitNext();
        const outcome = frameOutcomes[before];
        return {
          at: frame.capturedAt,
          kind: 'frame' as const,
          label: outcome?.ingest.admitted === true ? 'frame admitted' : 'frame rejected',
        };
      },
    })),
    ...fixture.pointerSamples.map((sample) => ({
      at: sample.at,
      kind: 'pointer' as const,
      run: async (): Promise<AdapterReplayEvent> => {
        adapters.accessibility.setPointer(sample.pointer.screenPoint);
        await session.samplePointer(sample.at);
        return { at: sample.at, kind: 'pointer' as const, label: 'pointer sampled' };
      },
    })),
  ];

  const kindOrder: Record<AdapterReplayEvent['kind'], number> = { window: 0, frame: 1, pointer: 2 };
  const ordered = [...steps].sort((a, b) => a.at - b.at || kindOrder[a.kind] - kindOrder[b.kind]);

  for (const step of ordered) {
    if (step.at > until) {
      break;
    }
    advanceTo(step.at);
    events.push(await step.run());
  }

  const metrics = session.metrics();
  return {
    events,
    admittedFrames: metrics.framesIngested,
    rejectedFrames: metrics.framesRejected,
    pointerSamples: metrics.pointerSamples,
    contentRevisions: metrics.contentRevisions,
    frameOutcomes,
  };
}

function applyWindowEvent(windows: FakeWindowAdapter, event: WindowEvent): void {
  switch (event.type) {
    case 'window-changed':
      windows.replaceWindow(event.window);
      return;
    case 'window-closed':
      windows.closeWindow(event.windowId);
      return;
    case 'screen-locked':
      windows.lockScreen();
      return;
    case 'screen-unlocked':
      windows.unlockScreen();
      return;
    case 'window-list-changed':
      windows.notifyWindowListChanged();
      return;
  }
}
