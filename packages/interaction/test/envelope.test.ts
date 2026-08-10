import { describe, expect, it } from 'vitest';
import {
  PilotError,
  asConversationId,
  asSceneId,
  asUtteranceId,
  asWindowId,
  buildGroundedPointer,
  envelopePointerInsideWindow,
  envelopePointerKnown,
  normalizedToScreen,
  questionEnvelopeSchema,
  UNKNOWN_SCENE_ID,
  type ObservedWindow,
  type QuestionEnvelope,
  type SceneState,
} from '@pilot/shared';
import {
  FIXTURE_ACCESSIBILITY_NODE,
  FIXTURE_GEOMETRY_RETINA,
  FIXTURE_SECURE_NODE,
  FIXTURE_WINDOW_RETINA,
  FIXTURE_WINDOW_SECONDARY,
} from '@pilot/platform/fakes';
import {
  FakeQuestionAnchorSource,
  MAX_ANCHOR_TEXT_CHARS,
  PilotQuestionEnvelopeFactory,
  RECORDED_NO_ACCESSIBILITY_TARGET,
  RECORDED_NO_POINTER_SAMPLES,
  RECORDED_NO_SELECTED_WINDOW,
  RECORDED_POINTER_OUTSIDE_WINDOW,
  RECORDED_POINTER_TOO_OLD,
  RECORDED_POINT_AND_ASK,
  RECORDED_SCENE_REVISED_MID_UTTERANCE,
  RECORDED_SECURE_FIELD,
  RECORDED_STALE_LAST_OBSERVED_REVISION,
  RECORDED_UTTERANCES,
  RECORDING_UTTERANCE_ENDED_AT,
  RECORDING_UTTERANCE_STARTED_AT,
  assertNoImageBytes,
  recordPointerPath,
  renderAnchoredQuestionEnvelope,
  type PointerAnchorSample,
  type QuestionEnvelopeFactoryOptions,
  type RecordedUtterance,
} from '@pilot/interaction';

/**
 * PR-024. `docs/implementation.md` asks for envelopes built from recorded
 * pointer timelines, so every case here replays a recording rather than
 * hand-writing coordinates: an "outside the window" sample is outside because
 * the geometry module says so.
 */

const CONVERSATION_ID = asConversationId('conv-envelope-test');

function build(
  recorded: RecordedUtterance,
  options: Partial<QuestionEnvelopeFactoryOptions> = {},
): QuestionEnvelope {
  const factory = new PilotQuestionEnvelopeFactory({
    anchors: new FakeQuestionAnchorSource({ scene: recorded.scene, samples: recorded.samples }),
    ...options,
  });
  return factory.build({
    utteranceId: asUtteranceId(`utt-${recorded.name}`),
    conversationId: CONVERSATION_ID,
    transcript: recorded.transcript,
    selectedWindow: recorded.window,
    utteranceStartedAt: recorded.utteranceStartedAt,
    askedAt: recorded.askedAt,
  });
}

function anchorOf(envelope: QuestionEnvelope) {
  const anchor = envelope.anchor;
  if (anchor === undefined) {
    throw new Error('expected an anchor');
  }
  return anchor;
}

describe('question envelope shape', () => {
  it('matches the system-design §8 contract for every recording', () => {
    for (const recorded of RECORDED_UTTERANCES) {
      const envelope = build(recorded);
      expect(() => questionEnvelopeSchema.parse(envelope)).not.toThrow();
      expect(envelope.conversationId).toBe(CONVERSATION_ID);
      expect(envelope.transcript).toBe(recorded.transcript);
    }
  });

  it('carries the scene id, revision and window title of the selected window', () => {
    const envelope = build(RECORDED_POINT_AND_ASK);
    expect(envelope.scene).toEqual({
      id: 'scene-recorded',
      revision: 4,
      lastObservedRevision: 4,
      windowTitle: FIXTURE_WINDOW_RETINA.title,
    });
  });

  it('is reproducible: the same recording builds the same envelope twice', () => {
    expect(build(RECORDED_POINT_AND_ASK)).toEqual(build(RECORDED_POINT_AND_ASK));
  });
});

describe('anchoring rule (system-design §6)', () => {
  it('grounds on the pointer position at utterance end, not the path average', () => {
    const envelope = build(RECORDED_POINT_AND_ASK);
    const anchor = anchorOf(envelope);
    const last = RECORDED_POINT_AND_ASK.samples.at(-1);

    expect(anchor.grounding).toBe('pointer-in-window');
    expect(anchor.pointerSampledAt).toBe(RECORDING_UTTERANCE_ENDED_AT);
    expect(anchor.pointerSkewMs).toBe(0);
    expect(envelope.pointer.normalizedX).toBeCloseTo(last?.pointer.normalizedPoint.x ?? -1, 10);
    expect(envelope.pointer.normalizedY).toBeCloseTo(last?.pointer.normalizedPoint.y ?? -1, 10);
    // The path started at 0.2/0.25; grounding on it would have produced that.
    expect(envelope.pointer.normalizedX).not.toBeCloseTo(0.2, 3);
  });

  it('prefers the last sample at or before utterance end over a later one', () => {
    // Samples continue past the utterance: the user moved on after speaking.
    const samples = recordPointerPath({
      durationMs: 3_000,
      from: { x: 0.3, y: 0.3 },
      to: { x: 0.9, y: 0.9 },
      target: FIXTURE_ACCESSIBILITY_NODE,
      targetFrom: 0,
    });
    const envelope = build({ ...RECORDED_POINT_AND_ASK, samples });
    const anchor = anchorOf(envelope);

    expect(anchor.pointerSampledAt).toBeLessThanOrEqual(RECORDING_UTTERANCE_ENDED_AT);
    expect(anchor.pointerSkewMs).toBeLessThanOrEqual(0);
  });

  it('records the utterance interval and how many samples it covered', () => {
    const anchor = anchorOf(build(RECORDED_POINT_AND_ASK));
    expect(anchor.utteranceStartedAt).toBe(RECORDING_UTTERANCE_STARTED_AT);
    expect(anchor.utteranceEndedAt).toBe(RECORDING_UTTERANCE_ENDED_AT);
    expect(anchor.pointerSampleCount).toBe(RECORDED_POINT_AND_ASK.samples.length);
  });

  it('ignores samples recorded for a window that is no longer selected', () => {
    const samples = recordPointerPath({
      window: FIXTURE_WINDOW_SECONDARY,
      geometry: FIXTURE_GEOMETRY_RETINA,
      target: FIXTURE_ACCESSIBILITY_NODE,
      targetFrom: 0,
    });
    const anchor = anchorOf(build({ ...RECORDED_POINT_AND_ASK, samples }));

    expect(anchor.grounding).toBe('pointer-unknown');
    expect(anchor.pointerSampleCount).toBe(0);
    expect(anchor.note).toMatch(/previously selected window/u);
  });

  it('reports the pointer as unknown when nothing is close enough', () => {
    const anchor = anchorOf(build(RECORDED_POINTER_TOO_OLD));
    expect(anchor.grounding).toBe('pointer-unknown');
    expect(anchor.pointerSampledAt).toBeUndefined();
    expect(anchor.note).toMatch(/nearest was \d+ms away/u);
  });
});

describe('pointer outside the selected window', () => {
  it('says so in a typed field instead of leaving it to be inferred', () => {
    const envelope = build(RECORDED_POINTER_OUTSIDE_WINDOW);
    const anchor = anchorOf(envelope);

    expect(anchor.grounding).toBe('pointer-outside-window');
    expect(envelopePointerKnown(envelope)).toBe(true);
    expect(envelopePointerInsideWindow(envelope)).toBe(false);
    expect(anchor.note).toMatch(/not over the selected window/u);
  });

  it('keeps the true coordinates rather than clamping them into the window', () => {
    const envelope = build(RECORDED_POINTER_OUTSIDE_WINDOW);
    expect(envelope.pointer.normalizedX).toBeGreaterThan(1);
  });

  it('never identifies an element under a pointer outside the window', () => {
    // The recording deliberately reports an accessibility node throughout.
    const outside = RECORDED_POINTER_OUTSIDE_WINDOW.samples.at(-1);
    expect(outside?.pointer.accessibilityTarget).toBeDefined();

    const envelope = build(RECORDED_POINTER_OUTSIDE_WINDOW);
    expect(envelope.pointer.targetRole).toBeUndefined();
    expect(envelope.pointer.targetLabel).toBeUndefined();
    expect(anchorOf(envelope).target).toBeUndefined();
    expect(anchorOf(envelope).targetAvailability).toBe('none');
  });

  it('records that the pointer crossed the window border mid-utterance', () => {
    expect(anchorOf(build(RECORDED_POINTER_OUTSIDE_WINDOW)).pointerCrossedWindowBorder).toBe(true);
    expect(anchorOf(build(RECORDED_POINT_AND_ASK)).pointerCrossedWindowBorder).toBe(false);
  });

  it('reports no position at all — not a coordinate — when none was recorded', () => {
    const envelope = build(RECORDED_NO_POINTER_SAMPLES);
    const anchor = anchorOf(envelope);

    expect(anchor.grounding).toBe('pointer-unknown');
    expect(envelopePointerKnown(envelope)).toBe(false);
    expect(envelopePointerInsideWindow(envelope)).toBe(false);
    expect(anchor.pointerSampledAt).toBeUndefined();
    expect(anchor.pointerSkewMs).toBeUndefined();
  });

  it('distinguishes "no window selected" from "pointer unknown"', () => {
    const envelope = build(RECORDED_NO_SELECTED_WINDOW);
    const anchor = anchorOf(envelope);

    expect(anchor.grounding).toBe('no-selected-window');
    expect(envelopePointerKnown(envelope)).toBe(false);
    expect(envelope.scene.id).toBe(UNKNOWN_SCENE_ID);
    expect(envelope.scene.revision).toBe(0);
    expect(envelope.scene.lastObservedRevision).toBeUndefined();
    expect(envelope.scene.windowTitle).toBe('');
    expect(anchor.observationStale).toBe(true);
  });
});

describe('accessibility summary', () => {
  it('summarises role and label, compactly', () => {
    const envelope = build(RECORDED_POINT_AND_ASK);
    expect(envelope.pointer.targetRole).toBe(FIXTURE_ACCESSIBILITY_NODE.role);
    expect(envelope.pointer.targetLabel).toBe(FIXTURE_ACCESSIBILITY_NODE.label);
    expect(anchorOf(envelope).target).toEqual({ role: 'AXCheckBox', label: 'Auto Renew' });
    expect(anchorOf(envelope).targetAvailability).toBe('reported');
  });

  it('says "none" explicitly when the platform reported no element', () => {
    const envelope = build(RECORDED_NO_ACCESSIBILITY_TARGET);
    const anchor = anchorOf(envelope);

    expect(anchor.grounding).toBe('pointer-in-window');
    expect(anchor.targetAvailability).toBe('none');
    expect(anchor.target).toBeUndefined();
    expect(envelope.pointer.targetRole).toBeUndefined();
    expect(envelope.pointer.targetLabel).toBeUndefined();
    expect(anchor.note).toMatch(/No accessibility element/u);
  });

  it('never copies the element value, secure or not', () => {
    const secure = build(RECORDED_SECURE_FIELD);
    const ordinary = build(RECORDED_POINT_AND_ASK);

    expect(JSON.stringify(secure)).not.toContain(FIXTURE_SECURE_NODE.value ?? 'hunter2');
    expect(JSON.stringify(ordinary)).not.toContain(FIXTURE_ACCESSIBILITY_NODE.value ?? 'off');
    // The role and label of a secure field are still safe metadata.
    expect(secure.pointer.targetRole).toBe('AXTextField');
    expect(secure.pointer.targetLabel).toBe('Password');
  });

  it('truncates a pathological label instead of forwarding it whole', () => {
    const samples = recordPointerPath({
      target: { ...FIXTURE_ACCESSIBILITY_NODE, label: 'x'.repeat(5_000) },
      targetFrom: 0,
    });
    const envelope = build({ ...RECORDED_POINT_AND_ASK, samples });
    expect(envelope.pointer.targetLabel?.length).toBe(MAX_ANCHOR_TEXT_CHARS);
    expect(envelope.pointer.targetLabel?.endsWith('…')).toBe(true);
  });
});

describe('scene revision', () => {
  it('reports a scene revised while the user was still speaking', () => {
    const anchor = anchorOf(build(RECORDED_SCENE_REVISED_MID_UTTERANCE));
    expect(anchor.sceneRevisedDuringUtterance).toBe(true);
    expect(anchor.sceneRevisionAtUtteranceStart).toBe(4);
    expect(build(RECORDED_SCENE_REVISED_MID_UTTERANCE).scene.revision).toBe(6);
  });

  it('does not claim a revision when the scene held still', () => {
    expect(anchorOf(build(RECORDED_POINT_AND_ASK)).sceneRevisedDuringUtterance).toBe(false);
  });

  it('flags a stale lastObservedRevision', () => {
    const envelope = build(RECORDED_STALE_LAST_OBSERVED_REVISION);
    expect(envelope.scene.revision).toBe(7);
    expect(envelope.scene.lastObservedRevision).toBe(2);
    expect(anchorOf(envelope).observationStale).toBe(true);
  });

  it('treats a never-observed scene as stale and omits lastObservedRevision', () => {
    const scene: SceneState = {
      sceneId: asSceneId('scene-fresh'),
      revision: 1,
      windowId: FIXTURE_WINDOW_RETINA.windowId,
      windowTitle: FIXTURE_WINDOW_RETINA.title,
      fingerprint: 'fingerprint-fresh',
      updatedAt: RECORDING_UTTERANCE_STARTED_AT,
    };
    const envelope = build({ ...RECORDED_POINT_AND_ASK, scene });

    expect(envelope.scene.lastObservedRevision).toBeUndefined();
    expect(anchorOf(envelope).observationStale).toBe(true);
  });

  it('ignores a scene that belongs to a different window', () => {
    const otherWindow: ObservedWindow = FIXTURE_WINDOW_SECONDARY;
    const scene: SceneState = {
      sceneId: asSceneId('scene-other'),
      revision: 9,
      windowId: otherWindow.windowId,
      windowTitle: otherWindow.title,
      fingerprint: 'fingerprint-other',
      lastObservedRevision: 9,
      updatedAt: RECORDING_UTTERANCE_STARTED_AT,
    };
    const envelope = build({ ...RECORDED_POINT_AND_ASK, scene });

    expect(envelope.scene.id).toBe(UNKNOWN_SCENE_ID);
    // The window title still comes from the selection, which is not in doubt.
    expect(envelope.scene.windowTitle).toBe(FIXTURE_WINDOW_RETINA.title);
    expect(anchorOf(envelope).observationStale).toBe(true);
  });
});

describe('no image bytes, ever', () => {
  it('contains only string, number and boolean leaves', () => {
    const leafTypes = new Set<string>();
    const walk = (value: unknown): void => {
      if (value === undefined) {
        return;
      }
      if (typeof value === 'object' && value !== null) {
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
        for (const child of Object.values(value as Record<string, unknown>)) {
          walk(child);
        }
        return;
      }
      leafTypes.add(typeof value);
    };
    for (const recorded of RECORDED_UTTERANCES) {
      walk(build(recorded));
    }
    expect([...leafTypes].sort()).toEqual(['boolean', 'number', 'string']);
  });

  it('stays far below one frame in size', () => {
    for (const recorded of RECORDED_UTTERANCES) {
      const bytes = Buffer.byteLength(JSON.stringify(build(recorded)), 'utf8');
      expect(bytes).toBeLessThan(4_096);
    }
  });

  it('cannot be built from an anchor source that smuggles bytes in', () => {
    // A hostile source: the port has no image type, so the only way to try is
    // to hide bytes in a text field. The schema and the guard both refuse.
    const geometry = FIXTURE_GEOMETRY_RETINA;
    const hostile: PointerAnchorSample = {
      at: RECORDING_UTTERANCE_ENDED_AT,
      windowId: FIXTURE_WINDOW_RETINA.windowId,
      pointer: buildGroundedPointer(
        normalizedToScreen({ x: 0.5, y: 0.5 }, geometry),
        geometry,
        // A base64 JPEG masquerading as an accessibility label.
        { ...FIXTURE_ACCESSIBILITY_NODE, label: `/9j/${'A'.repeat(4_000)}` },
      ),
      insideWindow: true,
      sceneRevision: 4,
    };
    const envelope = build({ ...RECORDED_POINT_AND_ASK, samples: [hostile] });

    expect(envelope.pointer.targetLabel?.length).toBe(MAX_ANCHOR_TEXT_CHARS);
    expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThan(1_024);
  });

  it('refuses a data URI or a raw byte array outright', () => {
    expect(() => {
      assertNoImageBytes({ transcript: 'data:image/png;base64,iVBORw0KGgo=' });
    }).toThrow(PilotError);
    expect(() => {
      assertNoImageBytes({ frame: new Uint8Array([0xff, 0xd8, 0xff]) });
    }).toThrow(/raw bytes/u);
    expect(() => {
      assertNoImageBytes({ frame: Buffer.from('hello') });
    }).toThrow(/raw bytes/u);
    expect(() => {
      assertNoImageBytes({ blob: 'A'.repeat(512) });
    }).toThrow(/encoded blob/u);
    expect(() => {
      assertNoImageBytes({ scene: { id: 'scene-1', revision: 4 } });
    }).not.toThrow();
  });

  it('refuses an envelope over the size ceiling', () => {
    expect(() => {
      assertNoImageBytes({ transcript: 'word '.repeat(20_000) });
    }).toThrow(/size ceiling/u);
  });

  it('rejects image bytes at the schema level, before the guard runs', () => {
    const parsed = questionEnvelopeSchema.safeParse({
      utteranceId: 'utt-1',
      transcript: 'what is this?',
      conversationId: 'conv-1',
      scene: { id: 'scene-1', revision: 1, windowTitle: 'Billing' },
      pointer: { normalizedX: 0.5, normalizedY: 0.5 },
      images: [{ mimeType: 'image/png', base64: 'iVBORw0KGgo=' }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('transcript handling', () => {
  it('passes the question through untouched', () => {
    const envelope = build({
      ...RECORDED_POINT_AND_ASK,
      transcript: '  What is  this?  ',
    });
    expect(envelope.transcript).toBe('  What is  this?  ');
  });

  it('truncates only a runaway transcript, and says it did', () => {
    const envelope = build(
      { ...RECORDED_POINT_AND_ASK, transcript: 'a'.repeat(200) },
      { maxTranscriptChars: 50 },
    );
    expect(envelope.transcript).toBe(`${'a'.repeat(50)}… [truncated]`);
  });
});

describe('anchor source contract', () => {
  it('resolves ties to the earlier sample, like the observation timeline', () => {
    const source = new FakeQuestionAnchorSource({
      samples: recordPointerPath({ hz: 10, durationMs: 1_000 }),
    });
    const at = RECORDING_UTTERANCE_STARTED_AT + 550;
    const selection = source.pointerAt(at);
    expect(selection.found).toBe(true);
    if (selection.found) {
      expect(selection.sample.at).toBe(RECORDING_UTTERANCE_STARTED_AT + 500);
    }
  });

  it('reports an empty timeline instead of returning a fabricated sample', () => {
    const selection = new FakeQuestionAnchorSource().pointerAt(0);
    expect(selection).toEqual({
      found: false,
      reason: 'empty',
      nearestDistanceMs: null,
      sampleCount: 0,
    });
  });

  it('returns an inclusive interval', () => {
    const samples = recordPointerPath({ hz: 10, durationMs: 1_000 });
    const source = new FakeQuestionAnchorSource({ samples });
    const path = source.pointerBetween(
      RECORDING_UTTERANCE_STARTED_AT,
      RECORDING_UTTERANCE_STARTED_AT + 300,
    );
    expect(path).toHaveLength(4);
    expect(path.at(-1)?.at).toBe(RECORDING_UTTERANCE_STARTED_AT + 300);
  });

  it('does not expose any way to hand over a frame', () => {
    const source: Record<string, unknown> = new FakeQuestionAnchorSource() as never;
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(source) as object).sort();
    expect(surface).toEqual(['constructor', 'pointerAt', 'pointerBetween', 'scene']);
  });
});

describe('rendering for the model', () => {
  it('names the element under the pointer', () => {
    const text = renderAnchoredQuestionEnvelope(build(RECORDED_POINT_AND_ASK));
    expect(text).toContain('What is this?');
    expect(text).toContain('pointer target: AXCheckBox — Auto Renew');
    expect(text).toContain('inside the selected window');
  });

  it('tells the model the pointer was outside the window', () => {
    const text = renderAnchoredQuestionEnvelope(build(RECORDED_POINTER_OUTSIDE_WINDOW));
    expect(text).toContain('outside the selected window');
    expect(text).not.toContain('pointer target:');
  });

  it('never renders the sentinel as a position', () => {
    for (const recorded of [RECORDED_NO_POINTER_SAMPLES, RECORDED_NO_SELECTED_WINDOW]) {
      const text = renderAnchoredQuestionEnvelope(build(recorded));
      expect(text).not.toContain('-1.000');
      expect(text).toMatch(/pointer: (unknown|not applicable)/u);
    }
  });

  it('flags a mid-utterance revision and a stale observation', () => {
    expect(renderAnchoredQuestionEnvelope(build(RECORDED_SCENE_REVISED_MID_UTTERANCE))).toContain(
      'the window changed while the question was being asked',
    );
    expect(renderAnchoredQuestionEnvelope(build(RECORDED_STALE_LAST_OBSERVED_REVISION))).toContain(
      'you have not observed this revision',
    );
  });

  it('renders an envelope with no anchor at all', () => {
    const legacy = questionEnvelopeSchema.parse({
      utteranceId: 'utt-legacy',
      transcript: 'what is this?',
      conversationId: 'conv-legacy',
      scene: { id: 'scene-1', revision: 1, windowTitle: 'Billing' },
      pointer: { normalizedX: 0.5, normalizedY: 0.5 },
    });
    expect(renderAnchoredQuestionEnvelope(legacy)).toContain('pointer: 0.500, 0.500');
  });
});

describe('window selection edge cases', () => {
  it('falls back to the selected window title when no scene is tracked', () => {
    const envelope = build({ ...RECORDED_POINT_AND_ASK, scene: null });
    expect(envelope.scene.id).toBe(UNKNOWN_SCENE_ID);
    expect(envelope.scene.windowTitle).toBe(FIXTURE_WINDOW_RETINA.title);
    // A pointer is still recorded, so the question is still grounded.
    expect(anchorOf(envelope).grounding).toBe('pointer-in-window');
  });

  it('truncates an absurd window title', () => {
    const window: ObservedWindow = {
      ...FIXTURE_WINDOW_RETINA,
      windowId: asWindowId('window-long-title'),
      title: 'T'.repeat(1_000),
    };
    const envelope = build({
      ...RECORDED_POINT_AND_ASK,
      window,
      scene: null,
      samples: [],
    });
    expect(envelope.scene.windowTitle.length).toBe(MAX_ANCHOR_TEXT_CHARS);
  });
});
