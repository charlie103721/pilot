import {
  PilotError,
  type CaptureOptions,
  type CapturedFrame,
  type ObservedWindow,
} from '@pilot/shared';
import type { ObservationAdapter } from '../adapters.js';
import { Emitter, throwIfAborted } from './support.js';
import { createFixtureFrames } from './fixtures.js';

export interface FakeObservationAdapterOptions {
  /** Frames handed out, in order, by `emitNext()` and `captureFresh()`. */
  readonly frames?: readonly CapturedFrame[];
  /** When true, `captureFresh()` reports protected content instead of a frame. */
  readonly protectedContent?: boolean;
}

/**
 * Deterministic `ObservationAdapter`.
 *
 * Nothing happens on a timer: a test calls `emitNext()` or `emitAll()` to push
 * fixture frames to subscribers. `captureFresh()` consumes from the same
 * fixture sequence, so the frame a test expects is the frame it gets.
 */
export class FakeObservationAdapter implements ObservationAdapter {
  readonly #emitter = new Emitter<CapturedFrame>();
  readonly #frames: readonly CapturedFrame[];
  #cursor = 0;
  #freshCursor = 0;

  started = false;
  startCount = 0;
  stopCount = 0;
  freshCaptureCount = 0;
  startedWith: { window: ObservedWindow; options: CaptureOptions } | null = null;
  protectedContent: boolean;

  constructor(options: FakeObservationAdapterOptions = {}) {
    this.#frames = options.frames ?? createFixtureFrames();
    this.protectedContent = options.protectedContent ?? false;
  }

  subscribe = (listener: (frame: CapturedFrame) => void): (() => void) =>
    this.#emitter.subscribe(listener);

  async start(window: ObservedWindow, options: CaptureOptions): Promise<void> {
    this.started = true;
    this.startCount += 1;
    this.startedWith = { window, options };
  }

  async stop(): Promise<void> {
    if (this.started) {
      this.stopCount += 1;
    }
    this.started = false;
    this.#cursor = 0;
    this.#freshCursor = 0;
  }

  async captureFresh(signal?: AbortSignal): Promise<CapturedFrame> {
    throwIfAborted(signal, 'Fresh capture');
    if (!this.started) {
      throw new PilotError('observation-disabled', 'Capture is not running', {
        userMessage: 'Pilot is not observing a window right now.',
      });
    }
    if (this.protectedContent) {
      throw new PilotError('protected-content', 'The window blocks screen capture', {
        userMessage: 'This application prevents Pilot from seeing its window.',
      });
    }
    const frame = this.#frames[this.#freshCursor % this.#frames.length];
    if (frame === undefined) {
      throw new PilotError('frame-unavailable', 'No fixture frames are configured', {
        userMessage: 'Pilot could not capture the window.',
      });
    }
    this.#freshCursor += 1;
    this.freshCaptureCount += 1;
    return frame;
  }

  /** Test control: push the next fixture frame to subscribers. */
  emitNext(): CapturedFrame {
    const frame = this.#frames[this.#cursor];
    if (frame === undefined) {
      throw new PilotError('frame-unavailable', 'Fixture frames are exhausted', {
        userMessage: 'Pilot could not capture the window.',
      });
    }
    this.#cursor += 1;
    this.#emitter.emit(frame);
    return frame;
  }

  /** Test control: push every remaining fixture frame. */
  emitAll(): readonly CapturedFrame[] {
    const emitted: CapturedFrame[] = [];
    while (this.#cursor < this.#frames.length) {
      emitted.push(this.emitNext());
    }
    return emitted;
  }

  get remainingFrames(): number {
    return this.#frames.length - this.#cursor;
  }
}
