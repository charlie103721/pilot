import { describe, expect, it } from 'vitest';
import {
  buildGroundedPointer,
  createCounterIdSource,
  createIdFactory,
  isPilotError,
  normalizedToScreen,
  questionEnvelopeSchema,
  asConversationId,
  asUtteranceId,
} from '@pilot/shared';
import {
  createFakeClock,
  FAKE_EPOCH_MS,
  FIXTURE_ACCESSIBILITY_NODE,
  FIXTURE_GEOMETRY_RETINA,
  FIXTURE_SECURE_NODE,
  FIXTURE_WINDOW_RETINA,
  FIXTURE_WINDOW_SECONDARY,
} from '@pilot/platform/fakes';
import { ObservationCore } from '../src/observation-core.js';
import {
  resolveQuestionAnchor,
  requireQuestionAnchor,
  toEnvelopePointer,
  toEnvelopeScene,
} from '../src/question-anchor.js';

/**
 * system-design §6: "The initial grounding point is the pointer location at
 * utterance end."
 */

const UTTERANCE_START = FAKE_EPOCH_MS + 1000;
const UTTERANCE_END = FAKE_EPOCH_MS + 2000;

function subject() {
  const clock = createFakeClock();
  const core = new ObservationCore({ clock, ids: createIdFactory(createCounterIdSource()) });
  return { clock, core };
}

function samplePointer(
  core: ObservationCore,
  at: number,
  normalized: { x: number; y: number },
  target?: typeof FIXTURE_ACCESSIBILITY_NODE,
): void {
  core.ingestPointer({
    at,
    windowId: FIXTURE_WINDOW_RETINA.windowId,
    pointer: buildGroundedPointer(
      normalizedToScreen(normalized, FIXTURE_GEOMETRY_RETINA),
      FIXTURE_GEOMETRY_RETINA,
      target,
    ),
  });
}

/** Pointer moving over one element, then settling on another before the end. */
function seeded() {
  const { core, clock } = subject();
  core.selectWindow({ window: FIXTURE_WINDOW_RETINA, geometry: FIXTURE_GEOMETRY_RETINA });
  for (let at = FAKE_EPOCH_MS; at <= UTTERANCE_END; at += 100) {
    const settled = at >= UTTERANCE_START + 500;
    samplePointer(
      core,
      at,
      { x: settled ? 0.5 : 0.2, y: settled ? 0.5 : 0.2 },
      settled ? FIXTURE_ACCESSIBILITY_NODE : undefined,
    );
    clock.advance(100);
  }
  return { core, clock };
}

describe('question anchor', () => {
  it('anchors to the pointer sample at utterance end', () => {
    const { core } = seeded();
    const result = resolveQuestionAnchor(core, {
      startedAt: UTTERANCE_START,
      endedAt: UTTERANCE_END,
      utteranceId: asUtteranceId('utt-1'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('unreachable');
    }
    const { anchor } = result;
    expect(anchor.at).toBe(UTTERANCE_END);
    expect(anchor.skewMs).toBe(0);
    expect(anchor.afterUtterance).toBe(false);
    expect(anchor.utteranceId).toBe('utt-1');
    expect(anchor.insideWindow).toBe(true);
    expect(anchor.target?.label).toBe('Auto Renew');
    expect(anchor.sceneId).toBe(core.scene?.sceneId);
  });

  it('records the path, the target changes and the revisions during the utterance', () => {
    const { core } = seeded();
    core.updateScene({ contentFingerprint: 'later' });
    const anchor = requireQuestionAnchor(core, {
      startedAt: UTTERANCE_START,
      endedAt: UTTERANCE_END,
    });
    expect(anchor.path.map((sample) => sample.at)).toContain(UTTERANCE_START);
    expect(anchor.path).toHaveLength(11);
    // One change: no target, then the checkbox.
    expect(anchor.targetChanges).toBe(1);
    expect(anchor.sceneRevisions).toStrictEqual([0]);
    expect(anchor.sceneChangedDuringUtterance).toBe(false);
  });

  it('reports when the scene was revised while the user was speaking', () => {
    const { core, clock } = subject();
    core.selectWindow({ window: FIXTURE_WINDOW_RETINA, geometry: FIXTURE_GEOMETRY_RETINA });
    samplePointer(core, UTTERANCE_START, { x: 0.3, y: 0.3 });
    clock.advance(1000);
    core.updateScene({ contentFingerprint: 'changed-mid-utterance' });
    samplePointer(core, UTTERANCE_END, { x: 0.5, y: 0.5 }, FIXTURE_ACCESSIBILITY_NODE);

    const anchor = requireQuestionAnchor(core, {
      startedAt: UTTERANCE_START,
      endedAt: UTTERANCE_END,
    });
    expect(anchor.sceneRevisions).toStrictEqual([0, 1]);
    expect(anchor.sceneChangedDuringUtterance).toBe(true);
  });

  it('prefers a sample at or before the end, and says so when it has to look later', () => {
    const { core, clock } = subject();
    core.selectWindow({ window: FIXTURE_WINDOW_RETINA, geometry: FIXTURE_GEOMETRY_RETINA });
    clock.advance(3000);
    samplePointer(core, UTTERANCE_END + 500, { x: 0.4, y: 0.4 });

    const result = resolveQuestionAnchor(core, {
      startedAt: UTTERANCE_START,
      endedAt: UTTERANCE_END,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('unreachable');
    }
    expect(result.anchor.afterUtterance).toBe(true);
    expect(result.anchor.skewMs).toBe(500);
  });

  it('reports a pointer outside the window instead of inventing a target', () => {
    const { core } = subject();
    core.selectWindow({ window: FIXTURE_WINDOW_RETINA, geometry: FIXTURE_GEOMETRY_RETINA });
    samplePointer(core, UTTERANCE_END, { x: 1.4, y: 0.5 });
    const anchor = requireQuestionAnchor(core, {
      startedAt: UTTERANCE_START,
      endedAt: UTTERANCE_END,
    });
    expect(anchor.insideWindow).toBe(false);
    expect(anchor.target).toBeNull();
  });

  it('refuses to ground when nothing is selected or nothing was recorded', () => {
    const { core } = subject();
    expect(
      resolveQuestionAnchor(core, { startedAt: UTTERANCE_START, endedAt: UTTERANCE_END }),
    ).toMatchObject({ ok: false, reason: 'no-scene' });

    core.selectWindow({ window: FIXTURE_WINDOW_RETINA, geometry: FIXTURE_GEOMETRY_RETINA });
    expect(
      resolveQuestionAnchor(core, { startedAt: UTTERANCE_START, endedAt: UTTERANCE_END }),
    ).toMatchObject({ ok: false, reason: 'no-pointer-sample' });

    try {
      requireQuestionAnchor(core, { startedAt: UTTERANCE_START, endedAt: UTTERANCE_END });
      throw new Error('expected a throw');
    } catch (error) {
      if (!isPilotError(error)) {
        throw error;
      }
      expect(error.code).toBe('frame-unavailable');
      expect(error.userMessage).toContain('where you were pointing');
    }
  });

  it('refuses a sample further from the utterance than the caller allows', () => {
    const { core } = seeded();
    expect(
      resolveQuestionAnchor(
        core,
        { startedAt: UTTERANCE_START, endedAt: UTTERANCE_END + 10_000 },
        { maxSkewMs: 100 },
      ),
    ).toMatchObject({ ok: false, reason: 'pointer-out-of-range' });
  });

  it('never grounds on a pointer sample from a previous window selection', () => {
    const { core } = seeded();
    core.selectWindow(FIXTURE_WINDOW_SECONDARY);
    expect(
      resolveQuestionAnchor(core, { startedAt: UTTERANCE_START, endedAt: UTTERANCE_END }),
    ).toMatchObject({ ok: false, reason: 'no-pointer-sample' });
  });
});

describe('question envelope projection', () => {
  it('produces scene and pointer halves the shared contract accepts', () => {
    const { core } = seeded();
    core.markObserved();
    const anchor = requireQuestionAnchor(core, {
      startedAt: UTTERANCE_START,
      endedAt: UTTERANCE_END,
    });
    const envelope = questionEnvelopeSchema.parse({
      utteranceId: asUtteranceId('utt-42'),
      transcript: 'what does this toggle do?',
      conversationId: asConversationId('conv-1'),
      scene: toEnvelopeScene(anchor),
      pointer: toEnvelopePointer(anchor),
    });
    expect(envelope.scene).toMatchObject({
      id: anchor.sceneId,
      revision: 0,
      lastObservedRevision: 0,
      windowTitle: 'Billing Settings',
    });
    expect(envelope.pointer).toStrictEqual({
      normalizedX: 0.5,
      normalizedY: 0.5,
      targetRole: 'AXCheckBox',
      targetLabel: 'Auto Renew',
    });
  });

  it('never carries the value of a secure field into the envelope', () => {
    const { core } = subject();
    core.selectWindow({ window: FIXTURE_WINDOW_RETINA, geometry: FIXTURE_GEOMETRY_RETINA });
    samplePointer(core, UTTERANCE_END, { x: 0.4, y: 0.7 }, FIXTURE_SECURE_NODE);
    const anchor = requireQuestionAnchor(core, {
      startedAt: UTTERANCE_START,
      endedAt: UTTERANCE_END,
    });
    expect(anchor.target?.label).toBe('Password');
    expect(anchor.target?.value).toBeUndefined();
    expect(JSON.stringify(toEnvelopePointer(anchor))).not.toContain('hunter2');
  });
});
