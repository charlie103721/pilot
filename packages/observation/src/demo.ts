import { createCounterIdSource, createIdFactory, isSceneObserved } from '@pilot/shared';
import { createFakeClock } from '@pilot/platform/fakes';
import { ObservationCore } from './observation-core.js';
import { createRecordedObservationFixture, replayRecordedFixture } from './fixtures.js';
import { toScreenStatusBuffer } from './frame-ring.js';

/**
 * PR-004 demo: "feed recorded fixtures and inspect selected frame and buffer
 * statistics".
 *
 *     pnpm build && pnpm --filter @pilot/observation demo
 *
 * Everything is driven by a fake clock, so the output is byte-identical on
 * every run and on every machine.
 */

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

const heading = (text: string): void => {
  out();
  out(text);
  out('-'.repeat(text.length));
};

function main(): void {
  const clock = createFakeClock();
  const fixture = createRecordedObservationFixture();
  const core = new ObservationCore({
    clock,
    ids: createIdFactory(createCounterIdSource()),
  });

  heading('1. Recorded fixture');
  out(`window            ${fixture.window.applicationName} — "${fixture.window.title}"`);
  out(`started at        ${String(fixture.startedAt)}`);
  out(`duration          ${String(fixture.durationMs)} ms`);
  out(`frames recorded   ${String(fixture.frames.length)} (3 FPS)`);
  out(`pointer samples   ${String(fixture.pointerSamples.length)} (30 Hz, pre-coalescing)`);
  out(`utterance window  ${String(fixture.utteranceStartedAt)} … ${String(fixture.questionAt)}`);

  const report = replayRecordedFixture(core, fixture, clock);

  heading('2. Replay');
  out(`frames admitted   ${String(report.admittedFrames)}`);
  out(`frames rejected   ${String(report.rejectedFrames)} (aged out of the 3 s ring on arrival)`);
  out(`pointer admitted  ${String(report.admittedPointerSamples)}`);
  out(`pointer coalesced ${String(report.coalescedPointerSamples)}`);

  heading('3. Scene transitions');
  for (const transition of report.sceneTransitions) {
    if (transition.kind === 'started') {
      out(
        `started   scene=${transition.scene.sceneId} revision=0 fp=${transition.scene.fingerprint}`,
      );
    } else if (transition.kind === 'revised') {
      out(
        `revised   revision=${String(transition.scene.revision)} changed=[${transition.changes.join(', ')}] fp=${transition.scene.fingerprint}`,
      );
    } else if (transition.kind === 'unchanged') {
      out(`unchanged revision=${String(transition.scene.revision)}`);
    } else if (transition.kind === 'ended') {
      out(`ended     reason=${transition.reason}`);
    } else {
      out('idle');
    }
  }

  heading('4. Buffer statistics at the question moment');
  const status = core.status();
  const buffer = toScreenStatusBuffer(status.buffer);
  out(`frames retained   ${String(buffer.frameCount)} (bound: ${String(core.frames.maxFrames)})`);
  out(
    `bytes retained    ${String(buffer.byteCount)} (bound: ${String(core.frames.maxBytes)} = 16 MiB)`,
  );
  out(`oldest frame at   ${String(buffer.oldestFrameAt)}`);
  out(`newest frame at   ${String(buffer.newestFrameAt)}`);
  out(
    `ring span         ${String((buffer.newestFrameAt ?? 0) - (buffer.oldestFrameAt ?? 0))} ms (bound: ${String(core.frames.maxAgeMs)} ms)`,
  );
  out(`pointer samples   ${String(status.pointer.sampleCount)}`);
  out(
    `scene             ${status.scene?.sceneId ?? 'none'} revision ${String(status.scene?.revision ?? -1)}`,
  );

  heading('5. Selected frame for the question moment');
  const selection = core.selectFrame(fixture.questionAt);
  if (selection.found) {
    out(`requested at      ${String(fixture.questionAt)}`);
    out(`selected frame    ${selection.record.frame.frameId}`);
    out(`captured at       ${String(selection.record.capturedAt)}`);
    out(`skew              ${String(selection.skewMs)} ms (negative = before the question)`);
    out(`scene revision    ${String(selection.record.sceneRevision)}`);
    out(
      `payload           ${String(selection.record.byteLength)} bytes, ${selection.record.frame.encoding}`,
    );
  } else {
    out(`no frame: ${selection.reason}`);
  }

  const before = core.selectFrame(fixture.questionAt, { direction: 'at-or-before' });
  const after = core.selectFrame(fixture.questionAt, { direction: 'at-or-after' });
  out(
    `before/after      ${before.found ? String(before.record.capturedAt) : before.reason} / ${after.found ? String(after.record.capturedAt) : after.reason}`,
  );

  const pointer = core.selectPointer(fixture.questionAt);
  if (pointer.found) {
    const point = pointer.sample.pointer.normalizedPoint;
    out(
      `pointer at        (${point.x.toFixed(3)}, ${point.y.toFixed(3)}) inside=${String(pointer.sample.insideWindow)} skew=${String(pointer.skewMs)} ms`,
    );
    out(`pointer target    ${pointer.sample.pointer.accessibilityTarget?.label ?? 'none'}`);
  } else {
    out(`no pointer sample: ${pointer.reason}`);
  }
  out(
    `pointer path      ${String(core.pointerPath(fixture.utteranceStartedAt, fixture.questionAt).length)} samples during the utterance`,
  );

  heading('6. Queries with no usable frame are explicit');
  const longGone = fixture.startedAt - 10_000;
  const stale = core.selectFrame(longGone);
  out(
    `10 s before start found=${String(stale.found)}${stale.found ? '' : ` reason=${stale.reason} nearest=${String(stale.nearestDistanceMs)} ms`}`,
  );
  const aheadOnly = core.selectFrame(fixture.startedAt + 9000, { direction: 'at-or-after' });
  out(
    `after the session found=${String(aheadOnly.found)}${aheadOnly.found ? '' : ` reason=${aheadOnly.reason}`}`,
  );
  try {
    core.requireFrame(longGone);
  } catch (error) {
    const pilotError = error as { code?: string; message?: string };
    out(`requireFrame      throws ${String(pilotError.code)}: ${String(pilotError.message)}`);
  }

  heading('7. Observation marking');
  const observedBefore = status.scene === null ? false : isSceneObserved(status.scene);
  const observed = core.markObserved();
  out(`before markObserved  ${String(observedBefore)}`);
  out(`after markObserved   ${String(observed === null ? false : isSceneObserved(observed))}`);

  heading('8. Deterministic clear (pause / lock / window loss / shutdown)');
  const cleared = core.clear('screen-locked');
  out(`reason            ${cleared.reason}`);
  out(`frames dropped    ${String(cleared.frames.count)} (${String(cleared.frames.bytes)} bytes)`);
  out(`pointer dropped   ${String(cleared.pointerSamples)}`);
  out(`scene dropped     ${cleared.scene?.sceneId ?? 'none'}`);
  const afterClear = core.status();
  out(`frames retained   ${String(afterClear.buffer.frameCount)}`);
  out(`bytes retained    ${String(afterClear.buffer.byteCount)}`);
  out(`pointer retained  ${String(afterClear.pointer.sampleCount)}`);
  out(`scene retained    ${afterClear.scene === null ? 'none' : 'LEAKED'}`);
  out(`core.isEmpty()    ${String(core.isEmpty())}`);
  const afterClearSelection = core.selectFrame(fixture.questionAt);
  out(
    `select after clear found=${String(afterClearSelection.found)}${afterClearSelection.found ? '' : ` reason=${afterClearSelection.reason}`}`,
  );

  heading('9. Lifetime metrics (content-free)');
  const metrics = core.metrics();
  out(`frames admitted   ${String(metrics.frames.admitted)}`);
  out(`evicted by age    ${String(metrics.frames.evictedByAge)}`);
  out(`evicted by bytes  ${String(metrics.frames.evictedByBytes)}`);
  out(`peak frames       ${String(metrics.frames.peakFrameCount)}`);
  out(`peak bytes        ${String(metrics.frames.peakByteCount)}`);
  out(`pointer coalesced ${String(metrics.pointer.coalesced)}`);
  out(`peak pointer      ${String(metrics.pointer.peakSampleCount)}`);
  out(`clears            ${String(metrics.clears)}`);
  out();
}

main();
