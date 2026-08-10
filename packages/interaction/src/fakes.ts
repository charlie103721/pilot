import {
  PilotError,
  asSceneId,
  createCounterIdSource,
  createIdFactory,
  questionEnvelopeSchema,
  type ConversationId,
  type IdFactory,
  type ModelProfile,
  type ObservationId,
  type ObservedWindow,
  type QuestionEnvelope,
  type RunId,
  type SceneState,
  type ToolCallId,
} from '@pilot/shared';
import type { AgentEvent, AgentRunHandle, AgentSession, InterruptMode } from '@pilot/platform';
import { Emitter, FIXTURE_MODEL_PROFILE } from '@pilot/platform/fakes';
import type {
  ObservationControlPort,
  PointerAnchorQuery,
  PointerAnchorSample,
  PointerAnchorSelection,
  QuestionAnchorSource,
  QuestionEnvelopeFactory,
  QuestionEnvelopeRequest,
} from './ports.js';
import type { CancelScheduled, Scheduler } from './scheduler.js';

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

export interface RecordingObservationPortOptions {
  /**
   * Hold every `observe()` open until `release()` is called (PR-027).
   *
   * A user-requested observation is the slowest thing the effect queue can be
   * asked to wait for, so it is also the sharpest test of whether an
   * interruption waits behind it. `false` (the default) keeps PR-006's
   * instantly-resolving behaviour.
   */
  readonly manual?: boolean;
}

/** Records the capture lifecycle the machine asks for. */
export class RecordingObservationPort implements ObservationControlPort {
  readonly calls: ObservationPortCall[] = [];
  /** Signals handed to `observe()`, in call order. PR-027 aborts these. */
  readonly signals: (AbortSignal | undefined)[] = [];
  readonly #manual: boolean;
  #release: (() => void) | null = null;
  #capturing = false;

  constructor(options: RecordingObservationPortOptions = {}) {
    this.#manual = options.manual ?? false;
  }

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

  async observe(observationId: ObservationId, signal?: AbortSignal): Promise<void> {
    this.calls.push({ type: 'observe', observationId });
    this.signals.push(signal);
    if (!this.#manual) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#release = resolve;
      // A real capture stops as soon as it is told to (system-design §15). It
      // resolves rather than throwing: the controller must not treat the
      // cancellation it asked for as a failure whichever shape it takes.
      signal?.addEventListener('abort', () => {
        this.#release = null;
        resolve();
      });
    });
  }

  /** Test control: let a held observation finish normally. */
  release(): void {
    const release = this.#release;
    this.#release = null;
    release?.();
  }

  /** True while an observation is being held open. */
  get observing(): boolean {
    return this.#release !== null;
  }

  /** Was the signal for the nth `observe()` call aborted? */
  aborted(index = this.signals.length - 1): boolean {
    return this.signals[index]?.aborted === true;
  }

  get capturing(): boolean {
    return this.#capturing;
  }

  get callTypes(): readonly ObservationPortCall['type'][] {
    return this.calls.map((call) => call.type);
  }
}

// ---------------------------------------------------------------------------
// PR-027 fakes
// ---------------------------------------------------------------------------

/**
 * A {@link Scheduler} that fires only when a test says so.
 *
 * This is the whole reason the phrase-timeout wake-up could be added without
 * giving up the lane's determinism: production passes
 * `createTimeoutScheduler()`, tests and demos pass this, and nothing anywhere
 * waits on real time.
 */
export class ManualScheduler implements Scheduler {
  readonly #entries = new Map<number, { delayMs: number; callback: () => void }>();
  #nextId = 0;

  schedule(delayMs: number, callback: () => void): CancelScheduled {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#entries.set(id, { delayMs, callback });
    return () => {
      this.#entries.delete(id);
    };
  }

  /** Number of callbacks waiting. */
  get pending(): number {
    return this.#entries.size;
  }

  /** The delay the oldest waiting callback was armed with, or `null`. */
  get nextDelayMs(): number | null {
    const first = [...this.#entries.values()][0];
    return first?.delayMs ?? null;
  }

  /**
   * Fire every currently-waiting callback, oldest first.
   *
   * Callbacks armed *by* these callbacks are not fired: one call, one round, so
   * a test that arms a chain sees each step.
   */
  fire(): number {
    const due = [...this.#entries.entries()];
    for (const [id] of due) {
      this.#entries.delete(id);
    }
    for (const [, entry] of due) {
      entry.callback();
    }
    return due.length;
  }
}

interface InterruptibleRun {
  readonly runId: RunId;
  /** The signal the agent loop hands to a tool. `Agent.abort()` fires it. */
  readonly abort: AbortController;
  readonly resolve: () => void;
  toolCallId: ToolCallId | null;
}

export interface InterruptibleAgentSessionOptions {
  readonly conversationId: ConversationId;
  readonly profile?: ModelProfile;
  /** Text the run streams once the tool call finishes. */
  readonly deltas?: readonly string[];
  readonly idFactory?: IdFactory;
}

/**
 * An `AgentSession` that models how a *real* run is cancelled (PR-027).
 *
 * `FakeAgentSession` in `@pilot/platform/fakes` is scripted and stops on
 * request, which is all PR-006 needed; it does not model the thing PR-027 has
 * to prove, which is that a cancellation reaches work that is *already running
 * on the other side of the boundary*. This one mirrors the two paths
 * `PiAgentSession` (PR-020) actually exposes, and nothing else:
 *
 *  - `interrupt('abort')` → `Agent.abort()`, which aborts the signal the agent
 *    loop handed to the tool. `createObserveScreenTool` (PR-021) checks that
 *    signal before the capture, passes it to `ScreenContextService.observe`,
 *    and discards a result that arrives after it — so aborting it here is
 *    exactly what "the abort reaches `observe_screen`" means.
 *  - `interrupt('steer')` → `Agent.steer(message)`, which injects a user
 *    message and leaves the run — and its tool call — running.
 *  - the `AbortSignal` passed to `submit()` → also `Agent.abort()`, which is
 *    the only cancellation available in the window before a run id exists.
 *
 * Deterministic: the tool call is advanced by `finishTool()`, the answer by
 * `stream()`/`complete()`. No timers.
 */
export class InterruptibleAgentSession implements AgentSession {
  readonly conversationId: ConversationId;
  readonly profile: ModelProfile;

  readonly #emitter = new Emitter<AgentEvent>();
  readonly #ids: IdFactory;
  readonly #deltas: readonly string[];

  readonly submitted: QuestionEnvelope[] = [];
  readonly interrupts: { mode: InterruptMode; detail: string }[] = [];
  readonly steers: string[] = [];
  disposed = false;

  #run: InterruptibleRun | null = null;
  /** Kept after the run ends so a test can ask whether its signal fired. */
  #last: InterruptibleRun | null = null;

  constructor(options: InterruptibleAgentSessionOptions) {
    this.conversationId = options.conversationId;
    this.profile = options.profile ?? FIXTURE_MODEL_PROFILE;
    this.#ids = options.idFactory ?? createIdFactory(createCounterIdSource());
    this.#deltas = options.deltas ?? ['That is the Auto Renew toggle.'];
  }

  subscribe = this.#emitter.subscribe;

  async submit(envelope: QuestionEnvelope, signal?: AbortSignal): Promise<AgentRunHandle> {
    if (signal?.aborted === true) {
      // Same shape as `PiAgentSession`: a question cancelled before the run
      // began never becomes a run at all.
      throw new PilotError('cancelled', 'Agent run cancelled before it started');
    }
    if (this.#run !== null) {
      throw new PilotError('run-already-active', 'A run is already active for this conversation');
    }
    this.submitted.push(envelope);

    const runId = this.#ids.run();
    const abort = new AbortController();
    let resolve: () => void = () => undefined;
    const completed = new Promise<void>((resolveCompleted) => {
      resolve = resolveCompleted;
    });
    this.#run = { runId, abort, resolve, toolCallId: null };
    this.#last = this.#run;
    signal?.addEventListener('abort', () => {
      this.abort('cancelled by the caller');
    });
    this.#emitter.emit({ type: 'run-started', runId, utteranceId: envelope.utteranceId });
    return { runId, completed };
  }

  /** The model calls `observe_screen`; the tool now holds the run's signal. */
  startTool(toolName = 'observe_screen'): ToolCallId {
    const run = this.#required();
    const toolCallId = this.#ids.toolCall();
    run.toolCallId = toolCallId;
    this.#emitter.emit({ type: 'tool-started', runId: run.runId, toolCallId, toolName });
    return toolCallId;
  }

  finishTool(toolName = 'observe_screen'): void {
    const run = this.#required();
    const toolCallId = run.toolCallId;
    if (toolCallId === null) {
      throw new Error('no tool call is in flight');
    }
    run.toolCallId = null;
    this.#emitter.emit({ type: 'tool-succeeded', runId: run.runId, toolCallId, toolName });
  }

  stream(text: string): void {
    this.#emitter.emit({ type: 'text-delta', runId: this.#required().runId, text });
  }

  /** Finish the run normally — even if it was aborted, which is the point. */
  complete(text?: string): void {
    const run = this.#required();
    this.#run = null;
    this.#emitter.emit({
      type: 'run-completed',
      runId: run.runId,
      text: text ?? this.#deltas.join(''),
    });
    run.resolve();
  }

  /**
   * Test control: a completion that was already on its way when the run was
   * aborted. A provider does not stop mid-sentence because Pilot stopped
   * listening, and `docs/pi-notes.md` records that Pi reports an abort as a
   * final assistant message rather than a distinct event — so "the run
   * completes after it was aborted" is the normal case, not a pathological one.
   */
  lateComplete(text: string): void {
    const run = this.#last;
    if (run === null) {
      throw new Error('no run has been started');
    }
    this.#emitter.emit({ type: 'run-completed', runId: run.runId, text });
  }

  /** Test control: a text delta from a run that has already been abandoned. */
  lateDelta(text: string): void {
    const run = this.#last;
    if (run === null) {
      throw new Error('no run has been started');
    }
    this.#emitter.emit({ type: 'text-delta', runId: run.runId, text });
  }

  async interrupt(mode: InterruptMode, detail: string): Promise<void> {
    this.interrupts.push({ mode, detail });
    if (this.#run === null) {
      return;
    }
    if (mode === 'abort') {
      this.abort(detail);
      return;
    }
    // Verified Pi behaviour: `steer` injects a message and the run continues.
    this.steers.push(detail);
  }

  /** `Agent.abort()`: the run's signal fires, the tool sees it, the run ends. */
  abort(reason: string): void {
    const run = this.#run;
    if (run === null) {
      return;
    }
    this.#run = null;
    run.abort.abort();
    this.#emitter.emit({ type: 'run-aborted', runId: run.runId, reason });
    run.resolve();
  }

  async dispose(): Promise<void> {
    this.abort('session disposed');
    this.disposed = true;
  }

  /**
   * True once the signal the agent loop handed to its tool has been aborted —
   * the signal `observe_screen` is required to respect (system-design §15).
   */
  get runAborted(): boolean {
    return this.#last?.abort.signal.aborted === true;
  }

  get activeRunId(): RunId | null {
    return this.#run?.runId ?? null;
  }

  get toolInFlight(): boolean {
    return this.#run !== null && this.#run.toolCallId !== null;
  }

  #required(): InterruptibleRun {
    const run = this.#run;
    if (run === null) {
      throw new Error('no run is active');
    }
    return run;
  }
}
