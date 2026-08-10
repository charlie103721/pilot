import {
  asSceneId,
  questionEnvelopeSchema,
  type ObservationId,
  type ObservedWindow,
  type QuestionEnvelope,
  type SceneState,
} from '@pilot/shared';
import type {
  ObservationControlPort,
  PointerAnchorQuery,
  PointerAnchorSample,
  PointerAnchorSelection,
  QuestionAnchorSource,
  QuestionEnvelopeFactory,
  QuestionEnvelopeRequest,
} from './ports.js';

/**
 * Fakes for the two ports PR-006 does not own.
 *
 * Deterministic and synchronous, like every other fake in the repo: no timers,
 * no randomness, no I/O. They exist so the machine and the controller run
 * standalone; PR-024 and PR-019/PR-030 replace them behind the same contract.
 */

export interface FakeQuestionEnvelopeFactoryOptions {
  /** Scene revision reported in the envelope. Defaults to 1. */
  readonly revision?: number;
  readonly pointer?: { readonly normalizedX: number; readonly normalizedY: number };
  readonly targetRole?: string;
  readonly targetLabel?: string;
}

/**
 * Minimal stand-in for PR-024.
 *
 * It carries text and cheap metadata only — never image bytes — and validates
 * itself against `questionEnvelopeSchema` so the fake cannot drift from the
 * contract the real builder must satisfy.
 */
export class FakeQuestionEnvelopeFactory implements QuestionEnvelopeFactory {
  readonly requests: QuestionEnvelopeRequest[] = [];
  readonly #options: FakeQuestionEnvelopeFactoryOptions;

  constructor(options: FakeQuestionEnvelopeFactoryOptions = {}) {
    this.#options = options;
  }

  async create(request: QuestionEnvelopeRequest): Promise<QuestionEnvelope> {
    this.requests.push(request);
    const window: ObservedWindow | null = request.selectedWindow;
    const pointer = this.#options.pointer ?? { normalizedX: 0.5, normalizedY: 0.5 };
    return questionEnvelopeSchema.parse({
      utteranceId: request.utteranceId,
      transcript: request.transcript,
      conversationId: request.conversationId,
      scene: {
        id: asSceneId(window === null ? 'scene-none' : `scene-${window.windowId}`),
        revision: this.#options.revision ?? 1,
        windowTitle: window?.title ?? '',
      },
      pointer: {
        normalizedX: pointer.normalizedX,
        normalizedY: pointer.normalizedY,
        ...(this.#options.targetRole === undefined ? {} : { targetRole: this.#options.targetRole }),
        ...(this.#options.targetLabel === undefined
          ? {}
          : { targetLabel: this.#options.targetLabel }),
      },
    });
  }
}

export interface FakeQuestionAnchorSourceOptions {
  readonly scene?: SceneState | null;
  /** Recorded pointer samples, oldest first. See `./recordings.ts`. */
  readonly samples?: readonly PointerAnchorSample[];
  /** Default tolerance when a query does not give one. */
  readonly maxSkewMs?: number;
}

/**
 * A {@link QuestionAnchorSource} over a recorded pointer timeline.
 *
 * Selection semantics are copied from `PointerTimeline.select` in
 * `@pilot/observation` — nearest sample, ties resolving to the earlier one — so
 * the envelope PR-024 builds against a recording is the envelope it will build
 * against the live timeline. Nothing here retains, or can retain, a frame.
 */
export class FakeQuestionAnchorSource implements QuestionAnchorSource {
  readonly #scene: SceneState | null;
  readonly #samples: readonly PointerAnchorSample[];
  readonly #maxSkewMs: number;

  constructor(options: FakeQuestionAnchorSourceOptions = {}) {
    this.#scene = options.scene ?? null;
    this.#samples = options.samples ?? [];
    this.#maxSkewMs = options.maxSkewMs ?? Number.POSITIVE_INFINITY;
  }

  scene(): SceneState | null {
    return this.#scene;
  }

  pointerAt(at: number, query: PointerAnchorQuery = {}): PointerAnchorSelection {
    const direction = query.direction ?? 'any';
    const maxSkewMs = query.maxSkewMs ?? this.#maxSkewMs;

    let best: PointerAnchorSample | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const sample of this.#samples) {
      if (direction === 'at-or-before' && sample.at > at) {
        continue;
      }
      if (direction === 'at-or-after' && sample.at < at) {
        continue;
      }
      const distance = Math.abs(sample.at - at);
      if (distance < bestDistance) {
        best = sample;
        bestDistance = distance;
      }
    }

    if (best === undefined) {
      return {
        found: false,
        reason: this.#samples.length === 0 ? 'empty' : 'no-sample-in-direction',
        nearestDistanceMs: null,
        sampleCount: this.#samples.length,
      };
    }
    if (bestDistance > maxSkewMs) {
      return {
        found: false,
        reason: 'out-of-range',
        nearestDistanceMs: bestDistance,
        sampleCount: this.#samples.length,
      };
    }
    return { found: true, sample: best, skewMs: best.at - at, distanceMs: bestDistance };
  }

  pointerBetween(from: number, to: number): readonly PointerAnchorSample[] {
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    return this.#samples.filter((sample) => sample.at >= start && sample.at <= end);
  }
}

export type ObservationPortCall =
  | { readonly type: 'start'; readonly window: ObservedWindow }
  | { readonly type: 'stop' }
  | { readonly type: 'clear' }
  | { readonly type: 'observe'; readonly observationId: ObservationId };

/** Records the capture lifecycle the machine asks for. */
export class RecordingObservationPort implements ObservationControlPort {
  readonly calls: ObservationPortCall[] = [];
  #capturing = false;

  async start(window: ObservedWindow): Promise<void> {
    this.calls.push({ type: 'start', window });
    this.#capturing = true;
  }

  async stop(): Promise<void> {
    this.calls.push({ type: 'stop' });
    this.#capturing = false;
  }

  async clear(): Promise<void> {
    this.calls.push({ type: 'clear' });
  }

  async observe(observationId: ObservationId): Promise<void> {
    this.calls.push({ type: 'observe', observationId });
  }

  get capturing(): boolean {
    return this.#capturing;
  }

  get callTypes(): readonly ObservationPortCall['type'][] {
    return this.calls.map((call) => call.type);
  }
}
