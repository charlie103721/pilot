import {
  nullLogger,
  type AccessibilityNode,
  type Logger,
  type QuestionEnvelope,
  type SceneState,
  type UtteranceId,
  type WindowId,
} from '@pilot/shared';
import {
  DEFAULT_MAX_ANCHOR_SKEW_MS,
  PilotQuestionEnvelopeFactory,
  type PointerAnchorQuery,
  type PointerAnchorSample,
  type PointerAnchorSelection,
  type QuestionAnchorSource,
  type QuestionEnvelopeFactory,
  type QuestionEnvelopeRequest,
} from '@pilot/interaction';
import {
  screenContextAnchor,
  type MutableScreenContextInputs,
  type ObservationCore,
  type QuestionAnchor,
  type QuestionAnchorFailure,
  type ScreenContextAnchor,
} from '@pilot/observation';

/**
 * The question anchor, wired (PR-031).
 *
 * This is the one fake boundary PR-031 replaces. Before it,
 * `createInteractionRuntime` defaulted to `FakeQuestionAnchorSource` — an empty
 * recording — so every envelope was `grounding: 'pointer-unknown'`, and
 * `ScreenContextInputs.anchor` was never set at all, so PR-019's facade read
 * every observation as "a model-initiated look at now". After it, pointing at
 * something and asking about it in words is one question:
 *
 * ```text
 *   pointer poller (30 Hz)          ObservationRuntime.samplePointer
 *     → MacAccessibilityAdapter.groundFast
 *       → ObservationCore.ingestPointer        the pointer timeline
 *       → PointerTargetLog.note                the element, when inside
 *   submit-text
 *     → submit-question effect                 @pilot/interaction
 *       → QuestionEnvelopeFactory.create       ← this file decorates it
 *         → PilotQuestionEnvelopeFactory        the §8 envelope (unchanged)
 *         → ObservationCore.anchorQuestion      the §6 grounding point
 *         → MutableScreenContextInputs.setAnchor
 *   observe_screen / Look now
 *     → PilotScreenContextService.observe
 *       → moment: 'question'   → the frame at the anchor, not the newest
 *       → view: 'pointer'      → the crop around the anchor
 *       → target               → the element under the anchor
 * ```
 *
 * ## The two rules that are load-bearing rather than tidy
 *
 * 1. **Outside the window, nothing is identified.** PR-013 refuses to issue the
 *    hit test (`shouldHitTest`), `groundPointer` discards an element supplied
 *    anyway, and PR-024's envelope summarises no target for a
 *    `pointer-outside-window` grounding. This file is the fourth place the same
 *    rule has to hold, and the first where getting it wrong would put a *label
 *    read off another application's window* into a model prompt: the anchor's
 *    `target` is populated **only** when the anchoring sample was inside the
 *    selected window. {@link PointerTargetLog} refuses to retain anything else,
 *    so there is nothing to leak even if this call site were wrong.
 * 2. **The two anchors agree.** The envelope's pointer (system-design §8) and
 *    the facade's anchor (§6) are resolved from the same timeline, at the same
 *    instant, under the same skew bound. Left to their defaults they would not
 *    be: `PilotQuestionEnvelopeFactory` refuses a sample more than
 *    {@link DEFAULT_MAX_ANCHOR_SKEW_MS} from utterance end, while
 *    `resolveQuestionAnchor` falls back to the pointer timeline's whole 30 s
 *    retention window. An envelope reading `pointer: unknown` beside a crop
 *    taken around a pointer from twenty seconds ago is the worst of both.
 *
 * ## Clock discipline
 *
 * Nothing here reads a clock. Both timestamps come from the machine's own
 * injected clock, stamped on the `submit-question` effect at transition time
 * and carried on {@link QuestionEnvelopeRequest}.
 */

// ---------------------------------------------------------------------------
// The adapter (runbook follow-up 3)
// ---------------------------------------------------------------------------

/**
 * `QuestionAnchorSource` over the real `ObservationCore`.
 *
 * PR-024 declared this port on the interaction side because no contract exposed
 * scene-plus-pointer-by-instant/interval to that lane, and predicted the
 * adapter would be the identity function. It is nearly that — and the "nearly"
 * is the whole reason the adapter exists rather than the interface being
 * widened. Two things do not pass straight through:
 *
 * - **`scene-mismatch`.** `PointerTimeline.select` has a fourth failure reason
 *   the port does not: samples exist, but all of them belong to a scene that is
 *   not the current one. It maps onto `no-sample-in-direction`, which is what
 *   the envelope factory turns into `pointer-unknown` — the honest answer, and
 *   the one that keeps a pointer recorded for a *previous window selection*
 *   from ever grounding this question. (`PilotQuestionEnvelopeFactory` also
 *   checks `sample.windowId` itself, so this is the second of two independent
 *   defences, not the only one.)
 * - **The scene scope.** `core.selectPointer` defaults every query to the
 *   current scene. The port's contract says nothing about scenes, so the
 *   default is what a caller written against the port would expect *and* is
 *   stricter than it asks for.
 *
 * Everything else is structural: `PointerSample` is a `PointerAnchorSample`
 * plus a `sceneId`, and `PointerSelection` is a `PointerAnchorSelection` plus
 * that one reason.
 */
export function createObservationAnchorSource(core: ObservationCore): QuestionAnchorSource {
  return {
    scene(): SceneState | null {
      return core.scene;
    },
    pointerAt(at: number, query: PointerAnchorQuery = {}): PointerAnchorSelection {
      const selection = core.selectPointer(at, {
        ...(query.direction === undefined ? {} : { direction: query.direction }),
        ...(query.maxSkewMs === undefined ? {} : { maxSkewMs: query.maxSkewMs }),
      });
      if (selection.found) {
        return {
          found: true,
          sample: selection.sample,
          skewMs: selection.skewMs,
          distanceMs: selection.distanceMs,
        };
      }
      return {
        found: false,
        reason: selection.reason === 'scene-mismatch' ? 'no-sample-in-direction' : selection.reason,
        nearestDistanceMs: selection.nearestDistanceMs,
        sampleCount: selection.sampleCount,
      };
    },
    pointerBetween(from: number, to: number): readonly PointerAnchorSample[] {
      return core.pointerPath(from, to);
    },
  };
}

// ---------------------------------------------------------------------------
// The elements under the pointer
// ---------------------------------------------------------------------------

/** One accessibility element, as it was under the pointer at one instant. */
export interface PointerTargetRecord {
  readonly at: number;
  readonly windowId: WindowId;
  readonly node: AccessibilityNode;
}

export interface PointerTargetLogOptions {
  /**
   * Hard ceiling, matching `DEFAULT_POINTER_MAX_SAMPLES`. The timeline evicts
   * by age and this evicts by count, so the log can hold a record whose sample
   * has already aged out — harmless, because a lookup is by exact instant and
   * an aged-out sample can never be an anchor.
   */
  readonly maxRecords?: number;
}

/**
 * What was under the pointer, retained beside the pointer timeline.
 *
 * The timeline keeps a `GroundedPointer`, whose `accessibilityTarget` is a
 * *summary*: role, label, and normalised bounds, with any secure value already
 * dropped. The facade needs the platform's own `AccessibilityNode` instead,
 * because §10's redaction step reads two fields the summary does not carry —
 * `isSecure` and screen-point `bounds` — and an anchor that handed over the
 * summary would quietly disable the masking of a password field under the
 * user's own pointer. So the node is kept here, keyed by the instant of the
 * sample it belongs to.
 *
 * **Only elements inside the selected window are retained.** Not as a filter
 * applied on the way out — nothing outside the window is ever written down, so
 * there is no record of another application's UI to leak, in this process or in
 * a heap dump. It is memory-only and it is dropped by the retention guard with
 * the frame ring (system-design §13): a role and a label read off a screen are
 * screen content, and they go when the pixels do.
 */
export class PointerTargetLog {
  readonly #maxRecords: number;
  #records: PointerTargetRecord[] = [];
  #clears = 0;

  constructor(options: PointerTargetLogOptions = {}) {
    this.#maxRecords = Math.max(1, options.maxRecords ?? 4096);
  }

  get size(): number {
    return this.#records.length;
  }

  get clears(): number {
    return this.#clears;
  }

  /**
   * Records the element under one pointer sample.
   *
   * `insideWindow: false` and `node: null` are both no-ops rather than errors:
   * a sample outside the window has nothing to record by contract, and a
   * platform that reports no element (degraded accessibility, an empty region,
   * a foreign application) has nothing to record in fact.
   */
  note(sample: {
    readonly at: number;
    readonly windowId: WindowId;
    readonly insideWindow: boolean;
    readonly node: AccessibilityNode | null;
  }): boolean {
    if (!sample.insideWindow || sample.node === null) {
      return false;
    }
    this.#records.push({ at: sample.at, windowId: sample.windowId, node: sample.node });
    while (this.#records.length > this.#maxRecords) {
      this.#records.shift();
    }
    return true;
  }

  /**
   * The element recorded for exactly this sample, or `null`.
   *
   * Exact-instant, never nearest: the anchor is a specific pointer sample, and
   * answering with a neighbour's element would describe something the user was
   * pointing at a moment earlier or later. "No element" is a supported answer
   * all the way to the model (`targetAvailability: 'none'`).
   */
  at(instant: number, windowId: WindowId): AccessibilityNode | null {
    for (let index = this.#records.length - 1; index >= 0; index -= 1) {
      const record = this.#records[index];
      if (record !== undefined && record.at === instant && record.windowId === windowId) {
        return record.node;
      }
    }
    return null;
  }

  /** Dropped with the frame ring; see the class comment. */
  clear(): { readonly recordCount: number } {
    const dropped = { recordCount: this.#records.length };
    this.#records = [];
    this.#clears += 1;
    return dropped;
  }
}

// ---------------------------------------------------------------------------
// Anchoring at submission
// ---------------------------------------------------------------------------

/** Why a question could not be anchored. Never a failure — see the note. */
export type QuestionAnchorSkip =
  | QuestionAnchorFailure
  /** The scene belongs to a window other than the one the machine has selected. */
  | 'window-mismatch';

/** What was anchored, content-free apart from the element's own role. */
export interface AnchoredQuestion {
  readonly utteranceId: UtteranceId;
  readonly anchor: ScreenContextAnchor;
  readonly at: number;
  readonly skewMs: number;
  readonly insideWindow: boolean;
  readonly targetRole: string | null;
  readonly sceneId: SceneState['sceneId'];
  readonly sceneRevision: number;
  readonly sceneChangedDuringUtterance: boolean;
}

export interface QuestionAnchorRuntimeOptions {
  readonly core: ObservationCore;
  readonly inputs: MutableScreenContextInputs;
  readonly targets: PointerTargetLog;
  /**
   * Shared with `PilotQuestionEnvelopeFactory` so §8's pointer and §6's anchor
   * cannot disagree about which samples are close enough. See the file comment.
   */
  readonly maxAnchorSkewMs?: number;
  readonly logger?: Logger;
}

export interface QuestionAnchorRuntime {
  /** What `createInteractionRuntime({ envelopes })` takes. */
  readonly envelopes: QuestionEnvelopeFactory;
  /** The port PR-024 declared; supplied here for a caller that wants it alone. */
  readonly anchors: QuestionAnchorSource;
  /**
   * The anchor resolved for the most recent submission, or `null` when that
   * submission could not be anchored. A *record*, so it survives the withdrawal
   * below — the diagnostics and the demo want to know what the last question
   * was grounded on after it has been answered.
   */
  lastAnchor(): AnchoredQuestion | null;
  /** Why the most recent submission was *not* anchored, when it was not. */
  lastSkip(): QuestionAnchorSkip | null;
  /** What the facade would use right now: the live anchor, or `null`. */
  active(): ScreenContextAnchor | null;
  /**
   * Drops the anchor once the machine is no longer waiting for a question.
   *
   * `MutableScreenContextInputs.setAnchor` says "cleared when the question is
   * answered", and it matters: `moment: 'current'` still reads the anchor for
   * its pointer, its `requestedScene` and its element, so a "Look now" pressed
   * after an answer would otherwise be grounded on the *previous* question's
   * pointer and told to check a scene reference nobody asked about.
   */
  noteActiveUtterance(utteranceId: UtteranceId | null): void;
  /** Drops the anchor and the retained elements together (system-design §13). */
  clear(): void;
}

export function createQuestionAnchorRuntime(
  options: QuestionAnchorRuntimeOptions,
): QuestionAnchorRuntime {
  const logger = (options.logger ?? nullLogger).child('anchor');
  const maxSkewMs = options.maxAnchorSkewMs ?? DEFAULT_MAX_ANCHOR_SKEW_MS;
  const anchors = createObservationAnchorSource(options.core);
  const delegate = new PilotQuestionEnvelopeFactory({ anchors, maxAnchorSkewMs: maxSkewMs });

  let lastAnchor: AnchoredQuestion | null = null;
  let lastSkip: QuestionAnchorSkip | null = null;

  /** A submission that could not be anchored: nothing live, and a reason. */
  const skip = (reason: QuestionAnchorSkip): void => {
    options.inputs.setAnchor(null);
    lastAnchor = null;
    lastSkip = reason;
  };

  /** Withdraw the live anchor, keeping the record of what it was. */
  const withdraw = (): void => {
    options.inputs.setAnchor(null);
  };

  /**
   * Resolves the §6 grounding point for one submission and hands it to the
   * facade. Never throws: a question that cannot be anchored is still a
   * question, and system-design §16 keeps the text box the way out of every
   * degraded state. The envelope already says so in words —
   * `grounding: 'pointer-unknown'` with a note — and the facade reads a `null`
   * anchor as "a look at now", which is what an unanchored question is.
   */
  const applyAnchor = (request: QuestionEnvelopeRequest): void => {
    const selected = request.selectedWindow;
    if (selected === null) {
      skip('no-scene');
      return;
    }
    const resolved = options.core.anchorQuestion(
      {
        // A typed question has no push-to-talk interval; the machine stamps
        // `utteranceStartedAt` when the composer's text was first entered, and
        // a clock that only moves forward still cannot promise the two are
        // ordered when a question is submitted in the same millisecond.
        startedAt: Math.min(request.utteranceStartedAt, request.askedAt),
        endedAt: request.askedAt,
        utteranceId: request.utteranceId,
      },
      { maxSkewMs },
    );
    if (!resolved.ok) {
      skip(resolved.reason);
      logger.debug('question not anchored', {
        utteranceId: request.utteranceId,
        reason: resolved.reason,
      });
      return;
    }

    const anchor: QuestionAnchor = resolved.anchor;
    if (anchor.scene.windowId !== selected.windowId) {
      // The scene moved on between the machine's selection and this submission.
      // Anchoring anyway would ground the question on a window the user is not
      // looking at, which is the failure §10 step 3 exists to refuse — better
      // to arrive there with no anchor than with a confidently wrong one.
      skip('window-mismatch');
      logger.debug('question not anchored', {
        utteranceId: request.utteranceId,
        reason: 'window-mismatch',
      });
      return;
    }

    // Defence 4. Outside the selected window, whatever is under the pointer
    // belongs to a window Pilot is not observing: no element is looked up, and
    // the log holds none to look up.
    //
    // Defence 5 (PR-044, system-design §16). Accessibility refused means *no*
    // element may be named, wherever the pointer is. The log can still hold one
    // — it was sampled while the permission was granted, and a mid-session
    // revocation does not reach back into the ring — so a lookup that only
    // checked `insideWindow` would hand `screenContextAnchor` an element read
    // under a permission the user has since taken away, and the crop the model
    // receives would arrive labelled with it. The envelope enforces the same
    // rule independently; this is the half that keeps it out of the *tool
    // result*.
    const target =
      anchor.insideWindow && request.accessibilityGrounding !== 'unavailable'
        ? options.targets.at(anchor.at, anchor.scene.windowId)
        : null;

    const screenAnchor = screenContextAnchor(anchor, target ?? undefined);
    options.inputs.setAnchor(screenAnchor);
    lastSkip = null;
    lastAnchor = {
      utteranceId: request.utteranceId,
      anchor: screenAnchor,
      at: anchor.at,
      skewMs: anchor.skewMs,
      insideWindow: anchor.insideWindow,
      targetRole: target?.role ?? null,
      sceneId: anchor.sceneId,
      sceneRevision: anchor.sceneRevision,
      sceneChangedDuringUtterance: anchor.sceneChangedDuringUtterance,
    };
    logger.debug('question anchored', {
      utteranceId: request.utteranceId,
      sceneId: anchor.sceneId,
      sceneRevision: anchor.sceneRevision,
      skewMs: anchor.skewMs,
      insideWindow: anchor.insideWindow,
      // A role is a control *kind* ("AXButton"), never its label or its value.
      targetRole: target?.role ?? null,
    });
  };

  const envelopes: QuestionEnvelopeFactory = {
    async create(request: QuestionEnvelopeRequest): Promise<QuestionEnvelope> {
      const envelope = await delegate.create(request);
      // After the envelope, before the submission. `submit-question` awaits
      // this call and only then hands the envelope to the agent, so the anchor
      // is in place before the model can possibly ask to look.
      applyAnchor(request);
      return envelope;
    },
  };

  return {
    envelopes,
    anchors,
    lastAnchor: () => lastAnchor,
    lastSkip: () => lastSkip,
    active: () => options.inputs.anchor(),
    noteActiveUtterance: (utteranceId: UtteranceId | null): void => {
      if (utteranceId === null) {
        withdraw();
      }
    },
    clear: (): void => {
      withdraw();
      options.targets.clear();
    },
  };
}
