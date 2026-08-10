import { asSpeechId, type SpeechId, type UtteranceId } from '@pilot/shared';
import type { SpeechOutputAdapter, SpeechOutputEvent, Unsubscribe } from '@pilot/platform';
import {
  DiagnosticLog,
  type SpeechChunkDiscardReason,
  type SpeechOutputCallIgnoredReason,
  type SpeechOutputDiscardReason,
  type VoiceDiagnostic,
} from './voice-diagnostics.js';

/**
 * PR-026 — the speech-output binding, symmetric to PR-025's `SpeechInputBinding`.
 *
 * The machine returns `speak` and `stop-speech` as **data**; this is the only
 * place they become `SpeechOutputAdapter` calls, and the only place synthesiser
 * callbacks become machine events.
 *
 * ## What it is for
 *
 * A streamed answer is spoken as several chunks, but system-design §15 says a
 * *TTS stream* has one identifier. The binding is what makes those two facts
 * compatible: it owns one live stream, keyed by the machine's `SpeechId`, and
 * turns it into an ordered sequence of adapter utterances named
 * `<speechId>#<sequence>`. The machine therefore never learns that its answer
 * was cut into pieces — it sees one `speech-started` and one `speech-finished`
 * for the whole answer, which is exactly what its `speaking` row expects.
 *
 * Three properties fall out of that ownership, and each is a bug that a real
 * synthesiser produces:
 *
 * 1. **Order is not the adapter's business.** Exactly one chunk is in flight;
 *    the next is only handed over when the previous one completes. Chunk 4
 *    cannot overtake chunk 3 however the platform schedules its queue.
 *
 * 2. **Completion is the stream's, not the chunk's.** A synthesiser that
 *    reports `finished` for chunk 1 is *not* saying the answer is over, and
 *    forwarding that would end the turn mid-sentence. `speech-finished` is
 *    emitted only when the queue is empty **and** the machine has said no more
 *    chunks are coming (`final`). A completion that arrives twice, or for a
 *    chunk that already ended, is discarded with a diagnostic — PR-025 found
 *    exactly this class of bug on the input side, where a synthesiser finishing
 *    early dumped a successful question into the error state.
 *
 * 3. **Teardown is idempotent.** Stopping a stream that is already stopped, or
 *    speaking into one that was superseded, is recorded and not performed.
 *    A `speak` effect that was queued before an interruption cannot reach the
 *    adapter afterwards, which is what makes "a late chunk from a superseded
 *    run is never spoken" true below the machine as well as inside it.
 *
 * No clock and no timers: the binding advances only when the machine asks it to
 * or the adapter calls back.
 */

export interface SpeechChunk {
  readonly speechId: SpeechId;
  readonly utteranceId: UtteranceId;
  readonly text: string;
  /** Position within the stream. Defaults to the binding's own counter. */
  readonly sequence?: number;
  /** No further chunks will be appended to this stream. */
  readonly final?: boolean;
}

export interface SpeechOutputBindingOptions {
  readonly speechOutput: SpeechOutputAdapter;
  /** Stream-level events, already proven to belong to the live stream. */
  readonly onEvent: (event: SpeechOutputEvent) => void;
  /** Everything that was dropped. Never silent (`implementation.md` delivery rules). */
  readonly onDiagnostic?: (diagnostic: VoiceDiagnostic) => void;
  readonly diagnosticLimit?: number;
  readonly voice?: string;
  readonly rate?: number;
}

/** The adapter-level identifier for one chunk of a stream. */
export function speechChunkId(speechId: SpeechId, sequence: number): SpeechId {
  return asSpeechId(`${speechId}#${String(sequence)}`);
}

interface QueuedChunk {
  readonly sequence: number;
  readonly text: string;
}

interface SpeechStream {
  readonly speechId: SpeechId;
  readonly utteranceId: UtteranceId;
  readonly queue: QueuedChunk[];
  nextSequence: number;
  /** Set once the machine says the answer is complete. */
  final: boolean;
  /** Terminal streams never speak again, whatever the adapter or machine says. */
  retired: boolean;
  retiredBecause: SpeechChunkDiscardReason | null;
  startedReported: boolean;
  spokenChunks: number;
  current: { readonly sequence: number; readonly chunkId: SpeechId } | null;
  /** This binding asked the adapter to stop; the resulting callback is ours. */
  stopping: boolean;
}

export class SpeechOutputBinding {
  readonly #adapter: SpeechOutputAdapter;
  readonly #onEvent: (event: SpeechOutputEvent) => void;
  readonly #log: DiagnosticLog;
  readonly #voice: string | undefined;
  readonly #rate: number | undefined;
  readonly #unsubscribe: Unsubscribe;

  /** Streams the binding has seen, so a late chunk can be explained. */
  readonly #history = new Map<SpeechId, SpeechStream>();
  /**
   * Streams stopped before they ever opened (PR-027).
   *
   * The machine emits `stop-speech` the instant it is interrupted, but the
   * `speak` effect that would have opened that stream may still be sitting in
   * the controller's effect queue — the window between `run-completed` and the
   * first `speech-started`. Remembering the identifier is what makes the stop
   * win that race: the chunk arrives, finds its stream already dead, and is
   * discarded instead of starting an answer the user has interrupted.
   */
  readonly #stoppedBeforeOpen = new Set<SpeechId>();
  #live: SpeechStream | null = null;
  #pending: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(options: SpeechOutputBindingOptions) {
    this.#adapter = options.speechOutput;
    this.#onEvent = options.onEvent;
    this.#log = new DiagnosticLog({
      ...(options.diagnosticLimit === undefined ? {} : { limit: options.diagnosticLimit }),
      onDiagnostic: options.onDiagnostic,
    });
    this.#voice = options.voice;
    this.#rate = options.rate;
    this.#unsubscribe = this.#adapter.subscribe((event) => {
      this.#receive(event);
    });
  }

  /** The one speech stream whose chunks and callbacks are honoured, or `null`. */
  get liveSpeechId(): SpeechId | null {
    return this.#live !== null && !this.#live.retired ? this.#live.speechId : null;
  }

  /** Chunks accepted but not yet handed to the synthesiser. PR-027 clears these. */
  get pendingChunkCount(): number {
    return this.#live === null || this.#live.retired ? 0 : this.#live.queue.length;
  }

  /** Chunks the synthesiser has finished, in the live stream. */
  get spokenChunkCount(): number {
    return this.#live?.spokenChunks ?? 0;
  }

  get speaking(): boolean {
    return this.#live !== null && !this.#live.retired && this.#live.current !== null;
  }

  get diagnostics(): readonly VoiceDiagnostic[] {
    return this.#log.entries;
  }

  get discardedCount(): number {
    return this.#log.total;
  }

  // -- effects --------------------------------------------------------------

  /**
   * The `speak` effect: append one chunk to a stream.
   *
   * Resolves once the chunk is queued and, when the synthesiser was idle, once
   * it has actually been handed over — but never waits for it to be *spoken*.
   * Blocking the machine's effect queue on audio playback would make an
   * interruption wait for the sentence it is interrupting.
   */
  async speak(chunk: SpeechChunk): Promise<void> {
    if (this.#disposed) {
      this.#discardChunk(chunk, 0, 'disposed');
      return;
    }

    const stream = this.#openStream(chunk);
    if (stream === null) {
      return;
    }

    const text = chunk.text.trim();
    const sequence = chunk.sequence ?? stream.nextSequence;
    if (text === '') {
      // A close marker: the run ended with nothing left unspoken. It carries no
      // audio, only the fact that the stream is complete.
      if (chunk.final !== true) {
        this.#ignoredCall('speak', chunk.speechId, 'nothing-to-say');
        return;
      }
    } else {
      stream.queue.push({ sequence, text });
      stream.nextSequence = Math.max(stream.nextSequence, sequence + 1);
    }
    if (chunk.final === true) {
      stream.final = true;
    }
    await this.#pump();
  }

  /**
   * The `stop-speech` effect. `null` means "stop whatever is speaking".
   *
   * Idempotent: a stop for a stream that already ended is recorded, not
   * performed, so a teardown that races the synthesiser's own completion cannot
   * turn a finished answer into an adapter error.
   */
  async stop(speechId: SpeechId | null): Promise<void> {
    const stream = this.#live;
    if (stream === null || stream.retired || (speechId !== null && stream.speechId !== speechId)) {
      // Nothing to stop *yet*. The identifier is remembered anyway, because the
      // first chunk of this stream may still be queued behind other effects;
      // see `#stoppedBeforeOpen`. `null` ("stop whatever is speaking") has no
      // identifier to remember, and the machine only sends it when it has none.
      const reason = this.#callReason(speechId);
      if (speechId !== null) {
        this.#stoppedBeforeOpen.add(speechId);
      }
      this.#ignoredCall('stop', speechId, reason);
      return;
    }
    await this.#stopStream(stream, 'stopped');
  }

  /** Release the synthesiser and go silent. */
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribe();
    const stream = this.#live;
    if (stream !== null && !stream.retired) {
      await this.#stopStream(stream, 'disposed');
    }
    await this.#pending.catch(() => undefined);
  }

  /** Resolves once every queued chunk hand-off has run. */
  async settled(): Promise<void> {
    let previous: Promise<void>;
    do {
      previous = this.#pending;
      await previous.catch(() => undefined);
    } while (previous !== this.#pending);
  }

  // -- stream lifecycle -----------------------------------------------------

  #openStream(chunk: SpeechChunk): SpeechStream | null {
    const live = this.#live;
    if (live !== null && live.speechId === chunk.speechId) {
      if (live.retired) {
        this.#discardChunk(chunk, live.spokenChunks, live.retiredBecause ?? 'already-finished');
        return null;
      }
      if (live.final) {
        // The machine already closed this stream. Anything after that belongs
        // to a run whose answer is complete.
        this.#discardChunk(chunk, live.spokenChunks, 'already-finished');
        return null;
      }
      return live;
    }

    const known = this.#history.get(chunk.speechId);
    if (known !== undefined) {
      this.#discardChunk(chunk, known.spokenChunks, known.retiredBecause ?? 'already-finished');
      return null;
    }

    if (this.#stoppedBeforeOpen.has(chunk.speechId)) {
      // The interruption arrived while this chunk was still queued. It is not
      // opening a stream now.
      this.#discardChunk(chunk, 0, 'stopped');
      return null;
    }

    if (live !== null && !live.retired) {
      // A new stream while one is running. The machine clears `activeSpeechId`
      // before minting another, so this only happens when something skipped the
      // teardown; the old stream loses, exactly as `SpeechInputBinding.start`
      // cancels a previous utterance rather than double-booking the microphone.
      void this.#stopStream(live, 'superseded');
    }

    const stream: SpeechStream = {
      speechId: chunk.speechId,
      utteranceId: chunk.utteranceId,
      queue: [],
      nextSequence: 0,
      final: false,
      retired: false,
      retiredBecause: null,
      startedReported: false,
      spokenChunks: 0,
      current: null,
      stopping: false,
    };
    this.#live = stream;
    this.#history.set(stream.speechId, stream);
    return stream;
  }

  async #stopStream(stream: SpeechStream, reason: SpeechChunkDiscardReason): Promise<void> {
    const dropped = stream.queue.splice(0, stream.queue.length);
    for (const chunk of dropped) {
      this.#report({
        kind: 'discarded-chunk',
        speechId: stream.speechId,
        utteranceId: stream.utteranceId,
        sequence: chunk.sequence,
        characters: chunk.text.length,
        reason,
      });
    }
    const inFlight = stream.current;
    stream.stopping = true;
    this.#retire(stream, reason);
    if (inFlight !== null) {
      await this.#adapter.stop(inFlight.chunkId);
    }
    // When nothing was in flight the stop still took effect — the queue is
    // cleared and the stream retired — so there is nothing to call and nothing
    // to report.
  }

  #retire(stream: SpeechStream, reason: SpeechChunkDiscardReason): void {
    stream.retired = true;
    stream.retiredBecause = reason;
    stream.current = null;
  }

  // -- the pump -------------------------------------------------------------

  #pump(): Promise<void> {
    this.#pending = this.#pending.then(() => this.#drain());
    return this.#pending;
  }

  async #drain(): Promise<void> {
    const stream = this.#live;
    if (stream === null || stream.retired || stream.current !== null) {
      return;
    }
    const next = stream.queue.shift();
    if (next === undefined) {
      this.#completeIfDrained(stream);
      return;
    }
    const chunkId = speechChunkId(stream.speechId, next.sequence);
    // Set before the call: the fake — and AVSpeechSynthesizer — may report
    // `started` synchronously from inside `speak()`.
    stream.current = { sequence: next.sequence, chunkId };
    try {
      await this.#adapter.speak({
        speechId: chunkId,
        text: next.text,
        ...(this.#voice === undefined ? {} : { voice: this.#voice }),
        ...(this.#rate === undefined ? {} : { rate: this.#rate }),
      });
    } catch (cause) {
      this.#retire(stream, 'already-failed');
      this.#onEvent({
        type: 'error',
        speechId: stream.speechId,
        error: cause instanceof Error ? cause : new Error(String(cause)),
      });
    }
  }

  /** The stream is over only when it is both drained and closed. */
  #completeIfDrained(stream: SpeechStream): void {
    if (stream.retired || stream.current !== null || stream.queue.length > 0 || !stream.final) {
      return;
    }
    this.#retire(stream, 'already-finished');
    this.#onEvent({ type: 'finished', speechId: stream.speechId });
  }

  // -- inbound --------------------------------------------------------------

  #receive(event: SpeechOutputEvent): void {
    const stream = this.#live;
    if (this.#disposed) {
      this.#discardEvent(event, 'disposed');
      return;
    }
    if (stream === null) {
      this.#discardEvent(event, 'no-live-stream');
      return;
    }
    if (stream.current === null || stream.current.chunkId !== event.speechId) {
      this.#discardEvent(event, this.#eventReason(stream, event.speechId));
      return;
    }

    switch (event.type) {
      case 'started':
        // One `speech-started` per stream: later chunks are the same answer
        // continuing, and the machine is already in `speaking`.
        if (!stream.startedReported) {
          stream.startedReported = true;
          this.#onEvent({ type: 'started', speechId: stream.speechId });
        }
        return;
      case 'finished':
        stream.current = null;
        stream.spokenChunks += 1;
        if (stream.queue.length > 0) {
          void this.#pump();
          return;
        }
        this.#completeIfDrained(stream);
        return;
      case 'stopped':
        this.#retire(stream, 'stopped');
        this.#onEvent({ type: 'stopped', speechId: stream.speechId });
        return;
      case 'error':
        this.#retire(stream, 'already-failed');
        this.#onEvent({ type: 'error', speechId: stream.speechId, error: event.error });
        return;
    }
  }

  // -- bookkeeping ----------------------------------------------------------

  #eventReason(stream: SpeechStream, speechId: SpeechId): SpeechOutputDiscardReason {
    if (stream.stopping && speechId.startsWith(`${stream.speechId}#`)) {
      // The callback for a stop this binding asked for. The machine left
      // `speaking` when it emitted the effect, so telling it again would only
      // produce a stale rejection.
      return 'self-initiated';
    }
    if (stream.retired) {
      return stream.retiredBecause ?? 'already-finished';
    }
    // A callback naming a chunk of the live stream that is no longer in flight
    // is a duplicate or an out-of-order completion; anything else is a stranger.
    return speechId.startsWith(`${stream.speechId}#`) ? 'stale-chunk' : 'unknown-chunk';
  }

  #callReason(speechId: SpeechId | null): SpeechOutputCallIgnoredReason {
    if (this.#disposed) {
      return 'disposed';
    }
    if (speechId === null) {
      return 'no-live-stream';
    }
    if (this.#stoppedBeforeOpen.has(speechId)) {
      return 'stopped';
    }
    const known = this.#history.get(speechId);
    if (known === undefined) {
      return 'no-live-stream';
    }
    return known.retiredBecause === null ? 'no-live-stream' : known.retiredBecause;
  }

  #discardChunk(chunk: SpeechChunk, sequence: number, reason: SpeechChunkDiscardReason): void {
    this.#report({
      kind: 'discarded-chunk',
      speechId: chunk.speechId,
      utteranceId: chunk.utteranceId,
      sequence: chunk.sequence ?? sequence,
      characters: chunk.text.trim().length,
      reason,
    });
  }

  #discardEvent(event: SpeechOutputEvent, reason: SpeechOutputDiscardReason): void {
    this.#report({
      kind: 'discarded-speech-event',
      event: event.type,
      speechId: event.speechId,
      reason,
    });
  }

  #ignoredCall(
    call: 'speak' | 'stop',
    speechId: SpeechId | null,
    reason: SpeechOutputCallIgnoredReason,
  ): void {
    this.#report({ kind: 'ignored-speech-call', call, speechId, reason });
  }

  #report(diagnostic: VoiceDiagnostic): void {
    this.#log.report(diagnostic);
  }
}
