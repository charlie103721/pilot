import { PilotError, type SpeechId, type UtteranceId } from '@pilot/shared';
import type {
  SpeechInputAdapter,
  SpeechInputAvailability,
  SpeechInputEvent,
  SpeechInputRequest,
  SpeechOutputAdapter,
  SpeechOutputEvent,
  SpeechOutputRequest,
} from '../adapters.js';
import { Emitter } from './support.js';

export interface FakeUtteranceScript {
  /** Partial transcripts emitted, in order, when the utterance is stopped. */
  readonly partials?: readonly string[];
  readonly final: string;
  /** When set, an `error` event is emitted instead of `final`. */
  readonly failWith?: string;
}

export const DEFAULT_UTTERANCE_SCRIPT: readonly FakeUtteranceScript[] = [
  { partials: ['what', 'what is'], final: 'What is this?' },
  { partials: ['and what'], final: 'And what happens if I turn it off?' },
];

export interface FakeSpeechInputAdapterOptions {
  readonly script?: readonly FakeUtteranceScript[];
  readonly availability?: SpeechInputAvailability;
}

/**
 * Deterministic `SpeechInputAdapter`.
 *
 * `start()` only records the request; every transcript event is emitted
 * synchronously from `stop()`, using the next entry of the fixture script.
 * `cancel()` emits nothing, which is what the interaction lane needs in order
 * to test stale-utterance rejection.
 */
export class FakeSpeechInputAdapter implements SpeechInputAdapter {
  readonly #emitter = new Emitter<SpeechInputEvent>();
  readonly #script: readonly FakeUtteranceScript[];
  readonly #availability: SpeechInputAvailability;
  #scriptCursor = 0;

  readonly started: SpeechInputRequest[] = [];
  readonly stopped: UtteranceId[] = [];
  readonly cancelled: UtteranceId[] = [];
  #active: UtteranceId | null = null;

  constructor(options: FakeSpeechInputAdapterOptions = {}) {
    this.#script = options.script ?? DEFAULT_UTTERANCE_SCRIPT;
    this.#availability = options.availability ?? {
      available: true,
      onDevice: true,
      locale: 'en-US',
    };
  }

  subscribe = this.#emitter.subscribe;

  async availability(): Promise<SpeechInputAvailability> {
    return this.#availability;
  }

  async start(request: SpeechInputRequest): Promise<void> {
    if (!this.#availability.available) {
      throw new PilotError('speech-unavailable', 'Speech recognition is unavailable', {
        userMessage: 'Speech recognition is not available. Use text input instead.',
      });
    }
    if (request.requireOnDevice && !this.#availability.onDevice) {
      throw new PilotError('speech-unavailable', 'On-device recognition is unavailable', {
        userMessage: 'On-device speech recognition is not available on this Mac.',
      });
    }
    if (this.#active !== null) {
      throw new PilotError('speech-input-failed', 'Another utterance is already recording', {
        userMessage: 'Pilot is already listening.',
      });
    }
    this.#active = request.utteranceId;
    this.started.push(request);
  }

  async stop(utteranceId: UtteranceId): Promise<void> {
    if (this.#active !== utteranceId) {
      throw new PilotError('speech-input-failed', 'Utterance is not recording', {
        userMessage: 'Pilot lost track of that question.',
        details: { utteranceId },
      });
    }
    this.#active = null;
    this.stopped.push(utteranceId);

    const entry = this.#script[this.#scriptCursor % Math.max(this.#script.length, 1)];
    this.#scriptCursor += 1;
    if (entry === undefined) {
      this.#emitter.emit({
        type: 'error',
        utteranceId,
        error: new Error('No fixture transcript configured'),
      });
      return;
    }
    for (const partial of entry.partials ?? []) {
      this.#emitter.emit({ type: 'partial', utteranceId, transcript: partial });
    }
    if (entry.failWith !== undefined) {
      this.#emitter.emit({ type: 'error', utteranceId, error: new Error(entry.failWith) });
      return;
    }
    this.#emitter.emit({ type: 'final', utteranceId, transcript: entry.final });
  }

  async cancel(utteranceId: UtteranceId): Promise<void> {
    this.cancelled.push(utteranceId);
    if (this.#active === utteranceId) {
      this.#active = null;
    }
  }

  /** Test control: emit a late `final` for an utterance that already ended. */
  emitLateFinal(utteranceId: UtteranceId, transcript: string): void {
    this.#emitter.emit({ type: 'final', utteranceId, transcript });
  }

  /**
   * Test control: emit a partial without ending the utterance.
   *
   * The scripted path only speaks on `stop()`; a real recogniser streams
   * hypotheses while the key is still held, and PR-025 has to bind that.
   */
  emitPartial(utteranceId: UtteranceId, transcript: string): void {
    this.#emitter.emit({ type: 'partial', utteranceId, transcript });
  }

  /**
   * Test control: fail an utterance mid-flight, the way a recogniser that loses
   * the audio session does (system-design §16, "STT fails").
   */
  emitError(utteranceId: UtteranceId, message: string): void {
    if (this.#active === utteranceId) {
      this.#active = null;
    }
    this.#emitter.emit({ type: 'error', utteranceId, error: new Error(message) });
  }

  get activeUtteranceId(): UtteranceId | null {
    return this.#active;
  }
}

export interface FakeSpeechOutputAdapterOptions {
  readonly voices?: readonly string[];
  readonly available?: boolean;
}

/**
 * Deterministic `SpeechOutputAdapter`.
 *
 * `speak()` emits `started` and leaves the utterance active; a test calls
 * `finish()` to complete it or `stop()` to interrupt it. That is what the
 * interruption tests in PR-027 need.
 */
export class FakeSpeechOutputAdapter implements SpeechOutputAdapter {
  readonly #emitter = new Emitter<SpeechOutputEvent>();
  readonly #voices: readonly string[];
  readonly #available: boolean;

  readonly spoken: SpeechOutputRequest[] = [];
  readonly stopCalls: (SpeechId | undefined)[] = [];
  #active: SpeechId | null = null;

  constructor(options: FakeSpeechOutputAdapterOptions = {}) {
    this.#voices = options.voices ?? ['fake-voice'];
    this.#available = options.available ?? true;
  }

  subscribe = this.#emitter.subscribe;

  async availability(): Promise<{ available: boolean; voices: readonly string[] }> {
    return { available: this.#available, voices: this.#voices };
  }

  async speak(request: SpeechOutputRequest): Promise<void> {
    if (!this.#available) {
      throw new PilotError('speech-output-failed', 'Speech synthesis is unavailable', {
        userMessage: 'Pilot cannot speak on this Mac. The answer is shown as text.',
      });
    }
    this.spoken.push(request);
    this.#active = request.speechId;
    this.#emitter.emit({ type: 'started', speechId: request.speechId });
  }

  async stop(speechId?: SpeechId): Promise<void> {
    this.stopCalls.push(speechId);
    const target = speechId ?? this.#active;
    if (target !== null && target !== undefined && this.#active === target) {
      this.#active = null;
      this.#emitter.emit({ type: 'stopped', speechId: target });
    }
  }

  /** Test control: complete the active utterance. */
  finish(): void {
    if (this.#active === null) {
      return;
    }
    const speechId = this.#active;
    this.#active = null;
    this.#emitter.emit({ type: 'finished', speechId });
  }

  get activeSpeechId(): SpeechId | null {
    return this.#active;
  }

  get spokenText(): string {
    return this.spoken.map((request) => request.text).join(' ');
  }
}
