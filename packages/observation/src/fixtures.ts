import {
  buildGroundedPointer,
  createCounterIdSource,
  createIdFactory,
  normalizedToScreen,
  type CapturedFrame,
  type ObservedWindow,
  type WindowGeometry,
} from '@pilot/shared';
import {
  FAKE_EPOCH_MS,
  FIXTURE_ACCESSIBILITY_NODE,
  FIXTURE_GEOMETRY_RETINA,
  FIXTURE_WINDOW_RETINA,
  createFixtureFrameBytes,
} from '@pilot/platform/fakes';
import type { AdjustableClock } from './clock.js';
import type { ObservationCore } from './observation-core.js';
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

export interface RecordedObservationFixture {
  readonly window: ObservedWindow;
  readonly geometry: WindowGeometry;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly frames: readonly CapturedFrame[];
  readonly pointerSamples: readonly PointerSampleInput[];
  readonly scenePatches: readonly RecordedScenePatch[];
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

  const ids = createIdFactory(createCounterIdSource());
  const frameCount = Math.floor((durationMs * frameFps) / 1000) + 1;
  const frames: CapturedFrame[] = Array.from({ length: frameCount }, (_unused, index) => ({
    frameId: ids.frame(),
    windowId: window.windowId,
    capturedAt: startedAt + Math.round((index * 1000) / frameFps),
    size: geometry.captureSize,
    scaleFactor: geometry.scaleFactor,
    encoding: 'jpeg' as const,
    bytes: createFixtureFrameBytes(index, frameByteLength),
  }));

  const pointerCount = Math.floor((durationMs * pointerHz) / 1000) + 1;
  const pointerSamples: PointerSampleInput[] = Array.from(
    { length: pointerCount },
    (_unused, index) => {
      // A straight diagonal drag across the window, ending on the fixture's
      // accessibility target so the anchor lookup has something to point at.
      const progress = pointerCount === 1 ? 0 : index / (pointerCount - 1);
      const screenPoint = normalizedToScreen(
        { x: 0.2 + progress * 0.4, y: 0.25 + progress * 0.35 },
        geometry,
      );
      return {
        at: startedAt + Math.round((index * 1000) / pointerHz),
        windowId: window.windowId,
        pointer: buildGroundedPointer(
          screenPoint,
          geometry,
          progress > 0.9 ? FIXTURE_ACCESSIBILITY_NODE : undefined,
        ),
      };
    },
  );

  const scenePatches: RecordedScenePatch[] = [
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
