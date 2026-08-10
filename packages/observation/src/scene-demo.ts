import { isSceneObserved, type CapturedFrame, type SceneId } from '@pilot/shared';
import { FIXTURE_GEOMETRY_SECONDARY, FIXTURE_WINDOW_SECONDARY } from '@pilot/platform/fakes';
import {
  createSceneLineageFixture,
  createSessionReplayHarness,
  replayFixtureThroughAdapters,
} from './fixtures.js';
import { toEnvelopePointer, toEnvelopeScene } from './question-anchor.js';
import type { SceneTransition } from './scene-tracker.js';
import type { SceneEpisode } from './scene-lineage.js';

/**
 * PR-016 demo: "replay recorded events and inspect scene/revision transitions".
 *
 *     pnpm build && pnpm --filter @pilot/observation demo:scene
 *
 * The whole run is driven by the PR-001 platform fakes on a fake clock, so the
 * output is byte-identical on every machine and every run.
 */

export interface SceneDemoResult {
  readonly lines: readonly string[];
  readonly transitions: readonly SceneTransition[];
  readonly episodes: readonly SceneEpisode[];
  /** Revision ladder as `revision:changes` strings. */
  readonly ladder: readonly string[];
}

function describe(transition: SceneTransition): string {
  switch (transition.kind) {
    case 'started':
      return `started   scene=${transition.scene.sceneId} revision=0 window="${transition.scene.windowTitle}"`;
    case 'revised':
      return `revised   revision=${String(transition.scene.revision)} changed=[${transition.changes.join(', ')}] title="${transition.scene.windowTitle}"`;
    case 'unchanged':
      return `unchanged revision=${String(transition.scene.revision)}`;
    case 'ended':
      return `ended     scene=${transition.previous.sceneId} reason=${transition.reason}`;
    case 'idle':
      return 'idle';
  }
}

export async function runSceneTimelineDemo(): Promise<SceneDemoResult> {
  const lines: string[] = [];
  const out = (line = ''): void => {
    lines.push(line);
  };
  const heading = (text: string): void => {
    out();
    out(text);
    out('-'.repeat(text.length));
  };

  const fixture = createSceneLineageFixture();
  const harness = createSessionReplayHarness(fixture);
  const { clock, core, session, adapters, transitions, frameOutcomes } = harness;
  const relative = (at: number): string => `+${String(at - fixture.startedAt)} ms`;

  heading('1. Recorded session');
  out(`window            ${fixture.window.applicationName} — "${fixture.window.title}"`);
  out(`duration          ${String(fixture.durationMs)} ms`);
  out(
    `frames            ${String(fixture.frames.length)} at 3 FPS, ${String(fixture.frames[0]?.bytes.byteLength ?? 0)} B each`,
  );
  out(`pointer samples   ${String(fixture.pointerSamples.length)} at 30 Hz (pre-coalescing)`);
  for (const epoch of fixture.contentEpochs) {
    out(
      `content epoch     ${relative(epoch.at).padEnd(10)} ${epoch.label} (carries over ${String(Math.round(epoch.carryOver * 100))}% of the payload)`,
    );
  }
  for (const event of fixture.windowEvents) {
    out(`window event      ${relative(event.at).padEnd(10)} ${event.label} (${event.event.type})`);
  }
  out(
    `utterance         ${relative(fixture.utteranceStartedAt)} … ${relative(fixture.questionAt)}`,
  );

  const report = await replayFixtureThroughAdapters(harness, fixture);

  heading('2. Replay through the platform adapters');
  out('frames arrive through ObservationAdapter.subscribe, pointer positions are');
  out('pulled from AccessibilityAdapter, window lifecycle from WindowAdapter.subscribe.');
  out(`frames admitted   ${String(report.admittedFrames)}`);
  out(`frames rejected   ${String(report.rejectedFrames)}`);
  out(`pointer samples   ${String(report.pointerSamples)} recorded`);
  out(
    `window events     ${String(session.metrics().windowEvents)} (${String(session.metrics().ignoredWindowEvents)} not for the selected window)`,
  );

  heading('3. Content fingerprint decisions (one per frame)');
  out(`threshold         ${session.fingerprinter.threshold.toFixed(2)} of the encoded payload`);
  fixture.frames.forEach((frame, index) => {
    const outcome = frameOutcomes[index];
    const update = outcome?.fingerprint;
    if (update === undefined || update === null) {
      return;
    }
    const verdict = update.changed ? 'NEW REVISION' : 'noise, ignored';
    out(
      `${relative(frame.capturedAt).padEnd(10)} ratio=${update.changeRatio.toFixed(3)} chunks=${String(update.chunkCount).padStart(3)} ${update.reason.padEnd(16)} ${verdict}`,
    );
  });
  out();
  out('The frame at +3000 ms is the scripted "auto-renew toggle flips off": 3% of');
  out('the payload. The rule cannot see it — a small-area, high-meaning change is');
  out('its documented blind spot, and the accessibility root and window title are');
  out('separate revision components precisely because this one is weak.');

  heading('4. Scene revision ladder');
  const ladder: string[] = [];
  for (const transition of transitions) {
    out(describe(transition));
    if (transition.kind === 'revised') {
      ladder.push(`${String(transition.scene.revision)}:${transition.changes.join('+')}`);
    }
  }
  const scene = core.scene;
  out(
    `current           scene=${scene?.sceneId ?? 'none'} revision=${String(scene?.revision ?? -1)} fingerprint=${scene?.fingerprint ?? 'none'}`,
  );

  heading('5. Question anchor (pointer at utterance end)');
  const anchor = core.requireAnchor({
    startedAt: fixture.utteranceStartedAt,
    endedAt: fixture.questionAt,
  });
  const point = anchor.pointer.normalizedPoint;
  out(
    `utterance         ${relative(anchor.utteranceStartedAt)} … ${relative(anchor.utteranceEndedAt)}`,
  );
  out(`anchor sample     ${relative(anchor.at)} (skew ${String(anchor.skewMs)} ms)`);
  out(
    `pointer           (${point.x.toFixed(3)}, ${point.y.toFixed(3)}) inside window=${String(anchor.insideWindow)}`,
  );
  out(`target            ${anchor.target?.role ?? 'none'} "${anchor.target?.label ?? ''}"`);
  out(
    `path              ${String(anchor.path.length)} samples, ${String(anchor.targetChanges)} target change(s)`,
  );
  out(
    `scene revisions   [${anchor.sceneRevisions.join(', ')}] during the utterance (changed=${String(anchor.sceneChangedDuringUtterance)})`,
  );
  const envelopeScene = toEnvelopeScene(anchor);
  const envelopePointer = toEnvelopePointer(anchor);
  out(
    `envelope scene    id=${envelopeScene.id} revision=${String(envelopeScene.revision)} title="${envelopeScene.windowTitle}"`,
  );
  out(
    `envelope pointer  x=${envelopePointer.normalizedX.toFixed(3)} y=${envelopePointer.normalizedY.toFixed(3)} role=${envelopePointer.targetRole ?? 'none'} label=${envelopePointer.targetLabel ?? 'none'}`,
  );

  const observedScene = core.markObserved();
  out(
    `after markObserved  the model has seen this revision: ${String(observedScene === null ? false : isSceneObserved(observedScene))}`,
  );

  const staleSceneId: SceneId = anchor.sceneId;
  const staleRevision = anchor.sceneRevision;

  heading('6. Window lifecycle');
  adapters.windows.lockScreen();
  out(`screen-locked     state=${session.state} buffers empty=${String(core.isEmpty())}`);
  adapters.windows.unlockScreen();
  out(`screen-unlocked   state=${session.state} (never resumes silently)`);
  clock.advance(500);
  await session.resume();
  const resumed = core.scene;
  out(
    `resume()          scene=${resumed?.sceneId ?? 'none'} revision=${String(resumed?.revision ?? -1)} — a lock ends the scene, so this is a new one`,
  );

  const freshFrame: CapturedFrame = {
    ...(fixture.frames[0] as CapturedFrame),
    capturedAt: clock.now(),
  };
  session.ingestFrame(freshFrame);
  await session.samplePointer();
  out(
    `fresh frame       admitted at ${relative(freshFrame.capturedAt)} into the new scene, with one pointer sample`,
  );

  heading('7. Window-change invalidation');
  clock.advance(500);
  await session.start({
    window: FIXTURE_WINDOW_SECONDARY,
    geometry: FIXTURE_GEOMETRY_SECONDARY,
    accessibilityRootId: 'ax-root-secondary',
  });
  const switched = core.scene;
  out(
    `select ${FIXTURE_WINDOW_SECONDARY.applicationName.padEnd(10)} scene=${switched?.sceneId ?? 'none'} revision=0 — the buffers were cleared on the switch`,
  );

  const foreign: CapturedFrame = {
    ...(fixture.frames[1] as CapturedFrame),
    capturedAt: clock.now(),
  };
  const foreignOutcome = session.ingestFrame(foreign);
  out(
    `old-window frame  admitted=${String(foreignOutcome.ingest.admitted)}${foreignOutcome.ingest.admitted ? '' : ` reason=${foreignOutcome.ingest.reason}`}`,
  );

  const secondaryFrame: CapturedFrame = {
    ...(fixture.frames[2] as CapturedFrame),
    windowId: FIXTURE_WINDOW_SECONDARY.windowId,
    capturedAt: clock.now(),
  };
  session.ingestFrame(secondaryFrame);
  await session.samplePointer();
  out(`new-window frame  admitted at ${relative(secondaryFrame.capturedAt)}`);

  out();
  out('A caller still holding an earlier scene asks for a moment the ring now has:');
  for (const [label, sceneRef] of [
    ['pre-lock scene  ', staleSceneId],
    ['pre-switch scene', resumed?.sceneId ?? staleSceneId],
  ] as const) {
    const frameSelection = core.selectFrame(clock.now(), { scene: sceneRef });
    const pointerSelection = core.selectPointer(clock.now(), { scene: sceneRef });
    out(
      `${label}  selectFrame=${frameSelection.found ? 'FOUND' : frameSelection.reason} selectPointer=${pointerSelection.found ? 'FOUND' : pointerSelection.reason} check=${core.checkScene({ sceneId: sceneRef }).status}`,
    );
  }
  out(
    `held revision     scene=${staleSceneId} revision=${String(staleRevision)} → ${core.checkScene({ sceneId: staleSceneId, revision: staleRevision }).status}`,
  );
  out(
    `current scene     ${core.checkScene({ sceneId: switched?.sceneId ?? staleSceneId }).status}`,
  );
  try {
    core.requireFrame(clock.now(), { scene: staleSceneId });
  } catch (error) {
    const pilotError = error as { code?: string; userMessage?: string };
    out(`requireFrame      throws ${String(pilotError.code)}: ${String(pilotError.userMessage)}`);
  }

  heading('8. Selected window closes');
  adapters.windows.closeWindow(FIXTURE_WINDOW_SECONDARY.windowId);
  out(`window-closed     state=${session.state} scene=${core.scene === null ? 'none' : 'LEAKED'}`);
  out(`buffers           empty=${String(core.isEmpty())}`);

  heading('9. Scene lineage');
  const episodes = core.lineage.episodes();
  for (const episode of episodes) {
    const ended =
      episode.end === null ? 'open' : `${episode.end.reason} (${episode.end.detail ?? '—'})`;
    out(
      `${episode.sceneId}  window=${episode.windowId} revisions=0…${String(episode.latestRevision)} end=${ended}`,
    );
    out(`  previous=${episode.previousSceneId ?? 'none'} title="${episode.windowTitle}"`);
  }
  out(`chain             ${core.lineage.chain().join(' ← ')}`);
  out();

  return { lines, transitions: [...transitions], episodes, ladder };
}
