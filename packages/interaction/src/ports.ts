import type {
  ConversationId,
  GroundedPointer,
  ObservationId,
  ObservedWindow,
  QuestionEnvelope,
  SceneState,
  UtteranceId,
  WindowId,
} from '@pilot/shared';

/**
 * Boundaries PR-006 deliberately does not implement.
 *
 * The state machine decides *when* a question is built and *when* the screen is
 * observed; it never decides *what* goes into the envelope or how a frame is
 * chosen. Those belong to PR-024 (question envelope) and PR-019/PR-030 (screen
 * context). Both are expressed here as ports so the machine runs standalone
 * against the fakes in `./fakes.ts` and the real implementations drop in
 * without touching the table.
 */

export interface QuestionEnvelopeRequest {
  readonly utteranceId: UtteranceId;
  readonly conversationId: ConversationId;
  readonly transcript: string;
  readonly selectedWindow: ObservedWindow | null;
  /** Push-to-talk down, or the moment a typed question was started (§6). */
  readonly utteranceStartedAt: number;
  /**
   * Utterance end — **the grounding instant** (system-design §6: "the initial
   * grounding point is the pointer location at utterance end").
   */
  readonly askedAt: number;
}

/** PR-024 implements this; `FakeQuestionEnvelopeFactory` stands in for tests. */
export interface QuestionEnvelopeFactory {
  create(request: QuestionEnvelopeRequest): Promise<QuestionEnvelope>;
}

// ---------------------------------------------------------------------------
// Anchor source (PR-024)
// ---------------------------------------------------------------------------

/**
 * One recorded pointer position.
 *
 * Structurally identical to `PointerSample` in `@pilot/observation`, which owns
 * the timeline (PR-004/PR-016). It is restated here, over `@pilot/shared` types
 * only, so the interaction lane never imports observation internals: the
 * adapter that PR-031 writes is the identity function.
 */
export interface PointerAnchorSample {
  readonly at: number;
  readonly windowId: WindowId;
  readonly pointer: GroundedPointer;
  /** Recorded by the timeline. Re-derived from geometry when they disagree. */
  readonly insideWindow: boolean;
  /** Scene revision in force at sample time, when the owner stamped one. */
  readonly sceneRevision: number | null;
}

export type PointerAnchorDirection = 'any' | 'at-or-before' | 'at-or-after';

export interface PointerAnchorQuery {
  readonly direction?: PointerAnchorDirection;
  /** Refuse a sample further than this from the requested instant. */
  readonly maxSkewMs?: number;
}

export type PointerAnchorFailure = 'empty' | 'out-of-range' | 'no-sample-in-direction';

export type PointerAnchorSelection =
  | {
      readonly found: true;
      readonly sample: PointerAnchorSample;
      /** `sample.at - requestedAt`. Negative means the sample is older. */
      readonly skewMs: number;
      readonly distanceMs: number;
    }
  | {
      readonly found: false;
      readonly reason: PointerAnchorFailure;
      readonly nearestDistanceMs: number | null;
      readonly sampleCount: number;
    };

/**
 * The interaction lane's read-only view of observation state.
 *
 * Question anchoring needs two things the observation lane already owns: the
 * current scene, and a pointer timeline that can be queried **by instant** (the
 * grounding point at utterance end) and **by interval** (what happened during
 * the utterance). Nothing here can carry a frame, an image or any byte payload
 * — the types make that unrepresentable.
 *
 * Every method is synchronous and pure: no clock, no I/O, so an envelope built
 * from a recorded timeline is reproducible.
 */
export interface QuestionAnchorSource {
  /** Scene in force now, or `null` when nothing is being observed. */
  scene(): SceneState | null;
  /** Pointer sample nearest an instant. Never invents one. */
  pointerAt(at: number, query?: PointerAnchorQuery): PointerAnchorSelection;
  /** Pointer path over an inclusive interval; empty, never `undefined`. */
  pointerBetween(from: number, to: number): readonly PointerAnchorSample[];
}

/**
 * Capture lifecycle the machine drives. PR-025 wires this to the real
 * `ObservationAdapter` / `ScreenContextService`; PR-030 makes `observe()`
 * perform a real "Look now".
 */
export interface ObservationControlPort {
  start(window: ObservedWindow): Promise<void>;
  stop(): Promise<void>;
  /** Drop every retained frame (system-design §11). */
  clear(): Promise<void>;
  /** User-requested observation. Resolves when the observation is done. */
  observe(observationId: ObservationId): Promise<void>;
}
