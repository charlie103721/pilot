/**
 * PR-026 — deciding when a streamed fragment is speakable.
 *
 * system-design §7: "Completed sentence fragments enter TTS." The agent streams
 * an answer a few characters at a time, so something has to decide, on every
 * delta, which prefix of the buffer is a finished sentence and which is a torso
 * that must keep waiting. That decision is this module, and it is a pure
 * function of the accumulated text: no clock, no state, no I/O, so the machine
 * can call it inside a transition and a test can call it directly.
 *
 * ## The rule
 *
 * A phrase ends at:
 *
 * - a newline — a list item or paragraph break is a stronger boundary than any
 *   punctuation, and speaking across it runs two ideas together; or
 * - a CJK full stop (`。`, `！`, `？`), which is not followed by a space; or
 * - a run of `.`, `!` or `?`, optionally followed by closing quotes or
 *   brackets, **followed by whitespace**.
 *
 * The "followed by whitespace" clause is the whole trick. During streaming, a
 * terminator at the *end* of the buffer is ambiguous — `config.` may be the
 * first half of `config.json`, and `1.` may be the first half of `1.5`. Waiting
 * for the separator that proves the sentence ended costs one delta and removes
 * an entire class of wrong splits. Nothing is lost by waiting, because the tail
 * is always released when the stream ends (see `takeSpeakablePhrases`).
 *
 * ## What it deliberately does not split
 *
 * | Case | Example | Why |
 * | --- | --- | --- |
 * | Decimals | `1.5 seconds` | the dot is followed by a digit, not whitespace |
 * | Identifiers and paths | `config.json is empty` | same rule; no whitespace after the dot |
 * | Version-ish text at the buffer end | `…in pilot.` | a terminator at the end of the buffer is never a boundary while the stream is open |
 * | Abbreviations | `Dr. Smith`, `e.g. this one` | the token ending at the dot is in {@link DEFAULT_ABBREVIATIONS} |
 * | Initials | `J. R. R. Tolkien` | a single capital letter plus a dot |
 * | List markers | `1. First`, `a) Second` | a short marker at the start of the phrase |
 * | Ellipses | `Wait... let me look` | a multi-character run of dots reads as continuation, not an ending |
 * | Punctuation-only fragments | `1.` | a phrase with no letter in it is not worth speaking |
 *
 * `?!` and `!?` *are* boundaries: only `.` is ambiguous, so a mixed run keeps
 * its terminating force.
 */

/** Sentence terminators that need a following space to count. */
const AMBIGUOUS_TERMINATORS = new Set(['.', '!', '?']);

/** Terminators that end a sentence on their own (CJK punctuation carries the space). */
const HARD_TERMINATORS = new Set(['。', '！', '？', '؟', '۔']);

/** Closing marks allowed between the terminator and the whitespace. */
const CLOSERS = new Set(['"', "'", '”', '’', '»', ')', ']', '}', '›']);

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v', ' ']);

/**
 * Tokens that end in a dot without ending a sentence.
 *
 * Lower-cased, and matched against the whole whitespace-delimited token
 * including its dots, so `e.g.` is one entry rather than a rule about `g`.
 */
export const DEFAULT_ABBREVIATIONS: ReadonlySet<string> = new Set([
  'a.m.',
  'al.',
  'approx.',
  'apt.',
  'assn.',
  'ave.',
  'ca.',
  'cf.',
  'ch.',
  'co.',
  'col.',
  'corp.',
  'dept.',
  'dr.',
  'e.g.',
  'ed.',
  'eds.',
  'esp.',
  'est.',
  'etc.',
  'ex.',
  'fig.',
  'figs.',
  'ft.',
  'gen.',
  'i.e.',
  'inc.',
  'jr.',
  'lb.',
  'lt.',
  'ltd.',
  'max.',
  'min.',
  'mr.',
  'mrs.',
  'ms.',
  'mt.',
  'no.',
  'nos.',
  'p.m.',
  'pp.',
  'prof.',
  'rev.',
  'sec.',
  'sgt.',
  'sr.',
  'st.',
  'u.k.',
  'u.s.',
  'v.',
  'vol.',
  'vs.',
]);

export interface SegmentationOptions {
  /** Override the abbreviation table (a locale or product vocabulary may differ). */
  readonly abbreviations?: ReadonlySet<string>;
}

export interface Segmentation {
  /** Complete, speakable phrases in stream order. Trimmed, never empty strings. */
  readonly phrases: readonly string[];
  /** Everything after the last boundary. May be `''`. */
  readonly remainder: string;
}

function isWhitespace(char: string): boolean {
  return WHITESPACE.has(char);
}

/** A phrase nobody would want to hear on its own: no letters at all. */
function hasSpeakableContent(text: string): boolean {
  return /\p{L}/u.test(text);
}

/**
 * The whitespace-delimited token that ends at `end` (exclusive), searching back
 * no further than the start of the current phrase.
 */
function tokenEndingAt(buffer: string, phraseStart: number, end: number): string {
  let start = end;
  while (start > phraseStart && !isWhitespace(buffer[start - 1]!)) {
    start -= 1;
  }
  return buffer.slice(start, end);
}

/** True when only whitespace separates the token from the start of its phrase. */
function isAtPhraseStart(buffer: string, phraseStart: number, tokenStart: number): boolean {
  for (let index = phraseStart; index < tokenStart; index += 1) {
    if (!isWhitespace(buffer[index]!)) {
      return false;
    }
  }
  return true;
}

const INITIAL = /^\p{Lu}\.$/u;
const LIST_MARKER = /^\(?(?:\d{1,3}|[a-z]{1,2}|[ivxlcdm]{1,5})[.)]$/iu;

/**
 * Is this dot the end of a sentence, or part of the token it sits on?
 *
 * Called only when the dot is already known to be followed by whitespace, so
 * decimals and dotted identifiers never reach it.
 */
function isSentenceEndingDot(
  buffer: string,
  phraseStart: number,
  terminatorEnd: number,
  abbreviations: ReadonlySet<string>,
): boolean {
  const token = tokenEndingAt(buffer, phraseStart, terminatorEnd);
  if (abbreviations.has(token.toLowerCase())) {
    return false;
  }
  if (INITIAL.test(token)) {
    return false;
  }
  if (
    LIST_MARKER.test(token) &&
    isAtPhraseStart(buffer, phraseStart, terminatorEnd - token.length)
  ) {
    return false;
  }
  return true;
}

/**
 * Split `buffer` into finished phrases plus the unfinished tail.
 *
 * Pure and total: `phrases.join(' ') + remainder` is the same content the
 * caller passed in, modulo collapsed boundary whitespace.
 */
export function segmentSpeech(buffer: string, options: SegmentationOptions = {}): Segmentation {
  const abbreviations = options.abbreviations ?? DEFAULT_ABBREVIATIONS;
  const phrases: string[] = [];
  let phraseStart = 0;
  let index = 0;

  const emit = (end: number): void => {
    const phrase = buffer.slice(phraseStart, end).trim();
    if (phrase !== '') {
      phrases.push(phrase);
    }
    phraseStart = end;
  };

  while (index < buffer.length) {
    const char = buffer[index]!;

    if (char === '\n') {
      emit(index);
      phraseStart = index + 1;
      index += 1;
      continue;
    }

    if (HARD_TERMINATORS.has(char)) {
      emit(index + 1);
      index += 1;
      continue;
    }

    if (!AMBIGUOUS_TERMINATORS.has(char)) {
      index += 1;
      continue;
    }

    let runEnd = index;
    while (runEnd < buffer.length && AMBIGUOUS_TERMINATORS.has(buffer[runEnd]!)) {
      runEnd += 1;
    }
    let boundary = runEnd;
    while (boundary < buffer.length && CLOSERS.has(buffer[boundary]!)) {
      boundary += 1;
    }

    // Not yet proven to be a boundary: either more text is still arriving
    // (`config.` before `json`) or the terminator sits inside a token (`1.5`).
    if (boundary >= buffer.length || !isWhitespace(buffer[boundary]!)) {
      index = runEnd;
      continue;
    }

    const run = buffer.slice(index, runEnd);
    // `...` and `. . .` read as continuation; `?!` still ends the sentence.
    if (run.length > 1 && !run.includes('!') && !run.includes('?')) {
      index = runEnd;
      continue;
    }
    if (char === '.' && !isSentenceEndingDot(buffer, phraseStart, runEnd, abbreviations)) {
      index = runEnd;
      continue;
    }
    if (!hasSpeakableContent(buffer.slice(phraseStart, boundary))) {
      index = runEnd;
      continue;
    }

    emit(boundary);
    index = boundary;
  }

  return { phrases, remainder: buffer.slice(phraseStart).trimStart() };
}

// ---------------------------------------------------------------------------
// Flush policy
// ---------------------------------------------------------------------------

/** system-design §17 budgets "time to first spoken sentence"; this bounds it. */
export const DEFAULT_PHRASE_TIMEOUT_MS = 1_200;

/** Why a fragment without a terminator was released to TTS anyway. */
export type TailRelease =
  /** Nothing was released early; the tail is still waiting. */
  | 'none'
  /** It had been waiting `phraseTimeoutMs` and the answer kept growing past it. */
  | 'timeout'
  /** The run ended. Nothing else is coming, so nothing may be left behind. */
  | 'stream-end';

export interface PhraseFlushOptions extends SegmentationOptions {
  /** Injected clock reading. Never `Date.now()`. */
  readonly now: number;
  /** When the current tail started waiting, or `null` when there was none. */
  readonly pendingSince: number | null;
  readonly phraseTimeoutMs?: number;
  /** The run has ended: release everything. */
  readonly final?: boolean;
}

export interface PhraseFlush {
  readonly phrases: readonly string[];
  readonly remainder: string;
  /** `pendingSince` for the next call. `null` when nothing is waiting. */
  readonly pendingSince: number | null;
  readonly tailRelease: TailRelease;
}

/**
 * Segment `buffer`, then decide whether the leftover tail should be spoken too.
 *
 * Two guarantees, in the order they matter:
 *
 * 1. **No tail is ever lost.** `final: true` releases whatever remains, so a
 *    stream that stops mid-sentence — no full stop, no newline, nothing — still
 *    reaches TTS. This is the case `docs/implementation.md` names for PR-026.
 * 2. **No tail waits forever behind a stalling model.** Once a fragment has
 *    been pending for `phraseTimeoutMs`, the next delta releases it instead of
 *    appending to it, so a model that emits a clause, pauses, and continues
 *    does not silently postpone the first thing it had to say.
 *
 * The timeout is measured against the injected clock reading in `now`, so it is
 * exactly as deterministic as the machine that calls it.
 */
export function takeSpeakablePhrases(buffer: string, options: PhraseFlushOptions): PhraseFlush {
  const timeout = options.phraseTimeoutMs ?? DEFAULT_PHRASE_TIMEOUT_MS;
  const segmented = segmentSpeech(
    buffer,
    options.abbreviations === undefined ? {} : { abbreviations: options.abbreviations },
  );
  const phrases = [...segmented.phrases];
  let remainder = segmented.remainder;
  let tailRelease: TailRelease = 'none';

  const tail = remainder.trim();
  if (tail !== '') {
    const overdue =
      phrases.length === 0 &&
      options.pendingSince !== null &&
      options.now - options.pendingSince >= timeout;
    if (options.final === true) {
      tailRelease = 'stream-end';
    } else if (overdue) {
      tailRelease = 'timeout';
    }
    if (tailRelease !== 'none') {
      phrases.push(tail);
      remainder = '';
    }
  }

  let pendingSince: number | null;
  if (remainder.trim() === '') {
    pendingSince = null;
  } else if (phrases.length > 0 || options.pendingSince === null) {
    // A brand-new tail, or one that only exists because everything before it
    // was just spoken: its wait starts now.
    pendingSince = options.now;
  } else {
    pendingSince = options.pendingSince;
  }

  return { phrases, remainder, pendingSince, tailRelease };
}
