import { nullLogger, toPilotError, type Logger, type SpeechId } from '@pilot/shared';
import type {
  SpeechOutputAdapter,
  SpeechOutputEvent,
  SpeechOutputRequest,
  Unsubscribe,
} from '@pilot/platform';

/**
 * Spoken response, wired (PR-033) — runbook follow-ups 5, 15, 24 and 25.
 *
 * This is the one fake boundary PR-033 replaces: **speech output**.
 * `createSilentSpeechOutputAdapter` is gone; what the interaction controller
 * holds is `MacSpeechOutputAdapter` (PR-014) over `AVSpeechSynthesizer` in the
 * native helper. Nothing changes inside `@pilot/interaction`: PR-026's
 * `SpeechOutputBinding` already owns the queue, the ordering and the difference
 * between "this chunk finished" and "the answer finished", and the whole of the
 * change there is *which adapter instance is handed in* — exactly as PR-032
 * found on the input side.
 *
 * This file is the other half, and it exists for one reason.
 *
 * ## §16: a failure of the voice must never cost the answer
 *
 * system-design §16 says "TTS fails → continue showing streamed text". The
 * interaction table takes `speech-failed` to `error`, and `teardown()` on that
 * row emits `interrupt-run` — so a synthesiser that fails on chunk 2 of an
 * answer that is still streaming **aborts the model run**, and the rest of the
 * answer never arrives. That is not "continue showing streamed text"; it is
 * losing the reply because the speaker broke.
 *
 * So this seam guarantees, in one sentence: **no `error` ever leaves it.**
 *
 * | what the synthesiser did | what the machine is told |
 * | --- | --- |
 * | `started` / `finished` / `stopped` | the same event, with the same id |
 * | `error` for a chunk | `finished` for that chunk — the chunk is silent, the stream continues |
 * | `speak()` rejected (dead helper, no voice) | `started` then `finished` for that chunk |
 * | there is no synthesiser at all (no helper) | `started` then `finished` for every chunk |
 *
 * A silenced chunk is counted and logged ({@link SpeechOutputRuntimeStats}),
 * never swallowed — the delivery rule is "explicit failure states", and the
 * failure here is *audible silence*, not a broken turn. The answer keeps
 * streaming into the panel, the turn completes, and the machine rests exactly
 * where it would have rested had every word been spoken.
 *
 * The last row is what replaces `createSilentSpeechOutputAdapter` (follow-up
 * 24). It is deliberately not a second implementation of the port: it is the
 * degraded mode of the real one, so a build with no helper takes the same code
 * path as a Mac whose synthesiser has no voice installed.
 *
 * ## The chunk identifiers are echoed, not invented (follow-up 5)
 *
 * PR-026 speaks one answer as several adapter utterances named
 * `<speechId>#<n>`, and `SpeechOutputBinding` matches every callback against
 * the chunk in flight; an adapter that reported the *stream* id, or an id of its
 * own, would have every callback discarded as `unknown-chunk` and the answer
 * would never report completion. Nothing in this file rewrites an identifier:
 * every event carries the `speechId` of the request that produced it, and the
 * synthesised events above use the id the failing request carried. That is the
 * property `speech-runtime.test.ts` reads off the wire rather than off a
 * comment.
 *
 * ## Stopping (follow-up 15, §17)
 *
 * `stop()` never throws and never waits: an interruption that landed before the
 * first chunk reached the synthesiser is a no-op, and so is a stop for a chunk
 * that finished microseconds ago. Throwing there would turn an interruption
 * into `failure` and then into `error` — the same shape of bug as above, one
 * layer down. The round trip is measured ({@link SpeechOutputRuntimeStats.lastStopMs})
 * because §17 budgets TTS interruption below 300 ms.
 *
 * ## No clock in the library
 *
 * The only reading of time is the stop measurement, and its clock is injected
 * and defaulted at the composition root — the same rule `main/voice-runtime.ts`
 * follows.
 */

/** What the synthesiser did, in counts. Never content. */
export interface SpeechOutputRuntimeStats {
  /**
   * Chunks a real synthesiser accepted.
   *
   * Not the same as "spoken": a chunk can be accepted and then fail, in which
   * case it is counted here *and* in {@link SpeechOutputRuntimeStats.silenced}.
   * Only a person in the room can count what was audible.
   */
  readonly accepted: number;
  /**
   * Chunks that produced no sound: the synthesiser refused them, failed them,
   * or there was none. Each one is logged with its reason.
   */
  readonly silenced: number;
  readonly stops: number;
  /** Round trip of the last `stop()`, in milliseconds (§17 budgets 300). */
  readonly lastStopMs: number | null;
}

export interface SpeechOutputRuntimeOptions {
  /**
   * The platform's synthesiser, or `null` on a build with no helper.
   *
   * `null` is not an error and not a fake: it is the degraded mode described
   * above, and it is what a Linux `pnpm dev` runs on.
   */
  readonly adapter?: SpeechOutputAdapter | null;
  /** Awaited by {@link SpeechOutputRuntime.dispose} when this runtime owns it. */
  readonly dispose?: () => Promise<void>;
  /**
   * Reads the §17 stop measurement. Defaulted at the composition root, exactly
   * as `createVoiceRuntime` defaults its own.
   */
  readonly clock?: () => number;
  readonly logger?: Logger;
}

export interface SpeechOutputRuntime {
  /** What `createInteractionRuntime({ speechOutput })` takes. */
  readonly speechOutput: SpeechOutputAdapter;
  /** True when a real synthesiser is behind it. */
  readonly real: boolean;
  /**
   * Whether the platform reported a usable voice. `null` until
   * {@link SpeechOutputRuntime.start} has asked.
   */
  available(): boolean | null;
  /** Voice identifiers the platform reported, once asked. */
  voices(): readonly string[];
  stats(): SpeechOutputRuntimeStats;
  /**
   * Asks the platform whether it can speak at all.
   *
   * Never throws: a Mac with no voice installed, and a helper that cannot be
   * reached, are both answers rather than failures — they mean the answer is
   * read rather than heard, which §16 already requires the app to survive.
   */
  start(): Promise<{ readonly available: boolean; readonly voices: readonly string[] }>;
  /**
   * Stops the sound and releases the synthesiser.
   *
   * Disposed **before** the controller (`main/index.ts`), so quitting silences
   * audio at the first moment rather than after the interaction teardown has
   * drained. Every call after it is a no-op, which is what makes the
   * controller's own teardown safe on a disposed adapter.
   */
  dispose(): Promise<void>;
}

export function createSpeechOutputRuntime(
  options: SpeechOutputRuntimeOptions = {},
): SpeechOutputRuntime {
  const logger = (options.logger ?? nullLogger).child('speech-out');
  const now = options.clock ?? ((): number => Date.now());
  const adapter = options.adapter ?? null;

  const listeners = new Set<(event: SpeechOutputEvent) => void>();
  /** Chunks this seam is completing itself, because the platform will not. */
  const silenced = new Set<SpeechId>();
  let voiceList: readonly string[] = [];
  let availability: boolean | null = null;
  let disposed = false;

  const stats = { accepted: 0, silenced: 0, stops: 0, lastStopMs: null as number | null };

  const emit = (event: SpeechOutputEvent): void => {
    for (const listener of [...listeners]) {
      listener(event);
    }
  };

  /**
   * Completes a chunk with no sound.
   *
   * `started` then `finished`, on the next microtask — the shape a synthesiser
   * with nothing to say has, and the shape the machine's `speaking` row expects,
   * so a build with no voice takes the same path through the table as one with.
   */
  const silence = (speechId: SpeechId, reason: string, detail?: string): void => {
    stats.silenced += 1;
    logger.warn('an answer chunk was not spoken; the text is still on screen', {
      reason,
      ...(detail === undefined ? {} : { detail }),
    });
    silenced.add(speechId);
    emit({ type: 'started', speechId });
    queueMicrotask(() => {
      if (silenced.delete(speechId)) {
        emit({ type: 'finished', speechId });
      }
    });
  };

  // Inbound. The one rewrite is `error` → `finished`: see the class comment.
  // Everything else is forwarded with the identifier the platform reported,
  // which is the per-chunk identifier PR-026 handed it (follow-up 5).
  const offAdapter: Unsubscribe | null =
    adapter === null
      ? null
      : adapter.subscribe((event) => {
          if (disposed) {
            return;
          }
          if (event.type !== 'error') {
            emit(event);
            return;
          }
          stats.silenced += 1;
          logger.warn('the synthesiser failed a chunk; the answer keeps its text (§16)', {
            code: toPilotError(event.error).code,
          });
          emit({ type: 'finished', speechId: event.speechId });
        });

  const speechOutput: SpeechOutputAdapter = {
    async availability(): Promise<{
      readonly available: boolean;
      readonly voices: readonly string[];
    }> {
      if (adapter === null || disposed) {
        return { available: false, voices: [] };
      }
      return adapter.availability();
    },

    async speak(request: SpeechOutputRequest): Promise<void> {
      if (adapter === null || disposed || availability === false) {
        silence(
          request.speechId,
          adapter === null ? 'no-synthesiser' : disposed ? 'disposed' : 'no-voice-installed',
        );
        return;
      }
      try {
        await adapter.speak(request);
        stats.accepted += 1;
      } catch (cause) {
        // The one place a rejection is turned into silence rather than into a
        // machine failure. `SpeechOutputBinding` would report it as a
        // stream-level `error`, and the table would abort the run that is still
        // writing the answer.
        silence(request.speechId, 'speak-failed', toPilotError(cause).code);
      }
    },

    async stop(speechId?: SpeechId): Promise<void> {
      const startedAt = now();
      stats.stops += 1;
      // A chunk this seam was completing itself. Retracting it here is what
      // makes an interruption of a silent answer behave like an interruption of
      // a spoken one.
      for (const pending of [...silenced]) {
        if (speechId === undefined || pending === speechId) {
          silenced.delete(pending);
          emit({ type: 'stopped', speechId: pending });
        }
      }
      if (adapter !== null && !disposed) {
        try {
          await adapter.stop(speechId);
        } catch (cause) {
          // Follow-up 15: a stop for a stream the synthesiser never started is
          // a no-op. A platform that disagrees must not turn an interruption
          // into an error state — §17 asks for silence in under 300 ms, and an
          // exception here would arrive as `failure` and then as `error`.
          logger.debug('the synthesiser refused a stop; treating it as a no-op', {
            code: toPilotError(cause).code,
          });
        }
      }
      stats.lastStopMs = now() - startedAt;
    },

    subscribe: (listener: (event: SpeechOutputEvent) => void): Unsubscribe => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    speechOutput,
    real: adapter !== null,
    available: () => availability,
    voices: () => voiceList,
    stats: () => ({ ...stats }),

    async start(): Promise<{ readonly available: boolean; readonly voices: readonly string[] }> {
      if (adapter === null) {
        availability = false;
        logger.info('no synthesiser on this build; answers are read, not heard', {});
        return { available: false, voices: [] };
      }
      try {
        const reported = await adapter.availability();
        availability = reported.available;
        voiceList = reported.voices;
        if (reported.available) {
          logger.info('speech output is wired to the interaction controller', {
            voices: reported.voices.length,
          });
        } else {
          // §16 again, at startup rather than mid-answer: a Mac with no voice
          // installed reads its answers instead of speaking them.
          logger.warn('the platform reports no speech voice; answers will be text only', {});
        }
        return reported;
      } catch (cause) {
        // Not latched to silence: a probe that could not be answered is not the
        // same claim as "there is no voice", and every `speak` degrades on its
        // own anyway.
        logger.warn('could not read speech-output availability', {
          code: toPilotError(cause).code,
        });
        return { available: false, voices: [] };
      }
    },

    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      offAdapter?.();
      silenced.clear();
      listeners.clear();
      if (options.dispose !== undefined) {
        await options.dispose().catch((cause: unknown) => {
          logger.debug('could not dispose the synthesiser', { code: toPilotError(cause).code });
          return undefined;
        });
      }
    },
  };
}
