import type { ImageContent, Message, TextContent } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  MVP_SCREEN_CONTEXT_POLICY,
  isInsideWindow,
  type ObservationImage,
  type ScreenObservation,
  type ScreenPolicy,
} from '@pilot/shared';
import {
  OBSERVE_SCREEN_TOOL_NAME,
  base64ByteLength,
  type ObserveScreenSuccessDetails,
} from './observe-screen.js';

/**
 * Visual context transformation (system-design §10, §11).
 *
 * Three distinct jobs, all of which Pilot has to do itself because Pi does none
 * of them automatically:
 *
 *  1. {@link pruneVisualContext} / {@link pruneVisualContextByPolicy} — what the
 *     *model* sees. Wired into Pi as `AgentOptions.transformContext`, which runs
 *     on every provider request and does not mutate the agent transcript.
 *     VERIFIED: with a faux provider, the context handed to the provider
 *     contained the replacement text while `agent.state.messages` still held the
 *     original image block.
 *
 *  2. {@link renderObservationRecord} — what the model is told *instead* of a
 *     dropped frame. §11 is explicit that a replacement record "must not claim
 *     that an old screen description remains current", so the record is
 *     past-tense, scene-stamped, and carries an explicit negation.
 *
 *  3. {@link stripImageBlocks} — what *disk* sees. Applied before
 *     `Session.appendMessage`. VERIFIED necessary: Pi's session storage JSON
 *     -serializes the message verbatim, base64 and all.
 *
 * Nothing here mutates its input. The durable record and `session.messages`
 * keep their content; only the provider-facing context is transformed.
 */

/** A message content block, as Pi models them. */
type ContentBlock = TextContent | ImageContent;

/** What an image in active context is for (`ObservationImage['purpose']`). */
export type ObservationImagePurpose = ObservationImage['purpose'];

/**
 * The two independent budgets of system-design §11.
 *
 * `frame` covers whole-window frames — `window` in ordinary use, `before` and
 * `after` during a comparison. `pointerCrop` covers the crop around what the
 * user is pointing at. They are separate so that a run of pointer crops cannot
 * crowd out the full frame, nor a run of full frames the crop: §11 asks for
 * "latest relevant full frame" *and* "latest relevant pointer crop", which a
 * single "keep the N newest images" rule cannot express.
 */
export type VisualBudget = 'frame' | 'pointerCrop';

const BUDGET_FOR_PURPOSE: Readonly<Record<ObservationImagePurpose, VisualBudget>> = {
  window: 'frame',
  before: 'frame',
  after: 'frame',
  pointer: 'pointerCrop',
};

/** Purposes that only ever appear as the two halves of a comparison. */
const COMPARISON_PURPOSES: ReadonlySet<ObservationImagePurpose> = new Set<ObservationImagePurpose>([
  'before',
  'after',
]);

// ---------------------------------------------------------------------------
// Replacement records (§11)
// ---------------------------------------------------------------------------

/** Scene identity as it appears in a replacement record. */
export interface SceneStamp {
  readonly sceneId: string;
  readonly sceneRevision: number;
}

/** Text that replaces an image block once it is no longer the active frame. */
export interface ObservationPlaceholder extends SceneStamp {
  /** One-line truthful summary. Must not claim the old screen is still current. */
  readonly summary: string;
}

/**
 * The replacement record §11 specifies, plus the truthfulness guard §11
 * demands.
 *
 * `summary` describes what *was* on screen. `supersededBy` names the scene the
 * screen has since moved to, when that is known and different — which is the
 * strongest available proof to the model that the record is history.
 */
export interface ObservationRecord extends ObservationPlaceholder {
  readonly supersededBy?: SceneStamp;
  /**
   * Which image was dropped, in the model's vocabulary. One observation can
   * contribute several blocks — a full frame and a pointer crop, or the two
   * halves of a comparison — and without this they would be replaced by several
   * copies of one identical sentence, which reads as a bug and tells the model
   * nothing about what it has lost.
   */
  readonly view?: string;
}

/** How each purpose is named in a replacement record. */
const VIEW_LABEL: Readonly<Record<ObservationImagePurpose, string>> = {
  window: 'full frame',
  pointer: 'pointer crop',
  before: 'comparison frame, before',
  after: 'comparison frame, after',
};

function stamp(scene: SceneStamp): string {
  return `${scene.sceneId}/revision-${String(scene.sceneRevision)}`;
}

/**
 * Renders the compact replacement record from system-design §11.
 *
 * Shape, verbatim from the spec:
 *
 * ```text
 * [Observation scene-17/revision-4 removed. The user was viewing the billing
 * settings page and pointing at the Auto Renew toggle.]
 * ```
 *
 * plus a mandatory closing clause the spec's prose requires but its example
 * elides: "This is a past record of scene-17 at revision 4, not a description of
 * the screen now." §11's rule is that a record "must not claim that an old
 * screen description remains current", and the failure mode it guards against is
 * a model reading a stale summary as present fact and confidently describing a
 * screen that changed ten turns ago. A tense alone is too weak a signal, so the
 * record states the negation outright and stamps the scene it belongs to. When
 * the current scene is known and different, the record says where the screen has
 * gone instead — a record that names a revision the conversation has already
 * moved past cannot be read as the present.
 *
 * The summary is caller-supplied and may be screen-derived, so it is sanitised
 * ({@link sanitiseRecordText}) before it is embedded: untrusted screen text must
 * not be able to forge or close a record of its own (§14).
 */
export function renderObservationRecord(record: ObservationRecord): string {
  const here =
    record.view === undefined
      ? stamp(record)
      : `${stamp(record)} (${sanitiseRecordText(record.view, 40)})`;
  const summary = sanitiseRecordText(record.summary, MAX_SUMMARY_LENGTH);
  const tail =
    record.supersededBy === undefined
      ? `This is a past record of ${record.sceneId} at revision ${String(record.sceneRevision)}, not a description of the screen now.`
      : `This is a past record of ${record.sceneId} at revision ${String(record.sceneRevision)}, not a description of the screen now; the screen has since moved to ${stamp(record.supersededBy)}.`;
  return `[Observation ${here} removed. ${summary} ${tail}]`;
}

/**
 * The bare §11 record shape, without the truthfulness clause.
 *
 * Kept for source compatibility with PR-005 callers. Prefer
 * {@link renderObservationRecord}: this function trusts the caller's summary
 * completely, and a present-tense summary passed here reaches the model as one.
 * The pruner does not use it.
 *
 * @deprecated Use {@link renderObservationRecord}.
 */
export function renderObservationPlaceholder(placeholder: ObservationPlaceholder): string {
  return `[Observation ${stamp(placeholder)} removed. ${placeholder.summary}]`;
}

/** Used when an image block has no `observe_screen` lineage to stamp. */
export const UNATTRIBUTED_IMAGE_RECORD =
  '[Earlier image removed from context. It is a past record, not a description of the screen now.]';

/** Used when nothing was recorded about what an observation showed. */
export const UNDESCRIBED_OBSERVATION_SUMMARY = 'No description of that frame was recorded.';

const MAX_SUMMARY_LENGTH = 240;

/**
 * Makes screen-derived text safe to embed in a replacement record.
 *
 * Screen content is untrusted (§14) and a record is *not* fenced — it is Pilot's
 * own voice, so anything quoted inside it must not be able to end the record or
 * start a forged one. Square brackets become parentheses, quotes are flattened,
 * every control character and newline collapses to a single space, and the
 * result is length-capped. Nothing is hidden: the text still reads, it just
 * cannot restructure the message around it.
 */
export function sanitiseRecordText(text: string, maxLength = MAX_SUMMARY_LENGTH): string {
  const flattened = text
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[\u0000-\u001F\u007F]+/gu, ' ')
    .replaceAll('[', '(')
    .replaceAll(']', ')')
    .replaceAll('"', "'")
    .replaceAll(/\s+/gu, ' ')
    .trim();
  if (flattened.length === 0) {
    return UNDESCRIBED_OBSERVATION_SUMMARY;
  }
  return flattened.length <= maxLength ? flattened : `${flattened.slice(0, maxLength - 1).trim()}…`;
}

/**
 * A past-tense, one-line description of what an observation showed.
 *
 * Deliberately past tense from the first word: this string outlives the frame it
 * describes, and every consumer of it is a record of something that is over.
 * Screen-derived fragments (window title, accessibility label) are sanitised
 * here rather than at render time so the sanitised form is what gets stored.
 */
export function summariseObservation(observation: ScreenObservation): string {
  const title = sanitiseRecordText(observation.windowTitle, 80);
  // Curly quotes deliberately: {@link sanitiseRecordText} flattens straight
  // ones, so a straight-quoted title would come out of the renderer looking
  // like a mistake rather than a quotation.
  const head = `The user was viewing the window “${title}”`;
  if (!isInsideWindow(observation.pointer)) {
    return `${head}; the pointer was outside that window.`;
  }
  const target = observation.target;
  if (target === undefined) {
    return `${head}.`;
  }
  if (target.isSecure) {
    return `${head} and pointing at a secure field (label and contents withheld).`;
  }
  const label = target.label === undefined ? undefined : sanitiseRecordText(target.label, 60);
  const role = target.role === undefined ? undefined : sanitiseRecordText(target.role, 40);
  if (label !== undefined && role !== undefined) {
    return `${head} and pointing at the ${label} ${role}.`;
  }
  if (label !== undefined) {
    return `${head} and pointing at ${label}.`;
  }
  if (role !== undefined) {
    return `${head} and pointing at a ${role}.`;
  }
  return `${head} and pointing inside it.`;
}

/**
 * Remembers what each observation showed, so a pruned frame can be replaced by
 * a record that says something true instead of a generic apology.
 *
 * Wire it to the tool: `createObserveScreenTool({ onObservation: notebook.note })`
 * and `new PiAgentSession({ visualContext: { summaryFor: notebook.summaryFor } })`.
 *
 * Text only, bounded, memory-only. It holds no image bytes, so it is safe to
 * keep for the life of a conversation; the bound exists so a very long
 * conversation cannot grow it without limit.
 */
export interface ObservationNotebook {
  /** Record what an observation showed, at the moment it was taken. */
  note(observation: ScreenObservation): void;
  /** The recorded summary for a tool result's details, if still remembered. */
  summaryFor(details: ObserveScreenSuccessDetails): string | undefined;
  /** How many observations are remembered. */
  readonly size: number;
}

export const DEFAULT_OBSERVATION_NOTEBOOK_LIMIT = 128;

export function createObservationNotebook(
  options: { readonly limit?: number } = {},
): ObservationNotebook {
  const limit = Math.max(1, options.limit ?? DEFAULT_OBSERVATION_NOTEBOOK_LIMIT);
  const notes = new Map<string, string>();
  return {
    note(observation: ScreenObservation): void {
      notes.delete(observation.observationId);
      notes.set(observation.observationId, summariseObservation(observation));
      while (notes.size > limit) {
        const oldest = notes.keys().next();
        if (oldest.done === true) {
          break;
        }
        notes.delete(oldest.value);
      }
    },
    summaryFor(details: ObserveScreenSuccessDetails): string | undefined {
      return notes.get(details.observationId);
    },
    get size(): number {
      return notes.size;
    },
  };
}

/** Looks up the past-tense summary for an observation that is being pruned. */
export type ObservationSummaryLookup = (details: ObserveScreenSuccessDetails) => string | undefined;

// ---------------------------------------------------------------------------
// Reading the transcript
// ---------------------------------------------------------------------------

function hasBlockContent(message: AgentMessage): message is Extract<
  Message,
  { content: ContentBlock[] }
> & {
  content: ContentBlock[];
} {
  return 'content' in message && Array.isArray(message.content);
}

function isImageBlock(block: unknown): block is ImageContent {
  return (
    typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'image'
  );
}

/**
 * Reads the `observe_screen` success details PR-021 puts on every tool-result
 * message.
 *
 * This is the whole reason pruning can be purpose-aware: `details.purposes` is
 * parallel to the image blocks in `content`, so the pruner never has to guess
 * what a frame is from its pixels, its position, or its byte size. Deliberately
 * defensive — details survive a JSON round trip through persistence, and a
 * message from another tool, another Pilot version, or a failed observation must
 * fall through to `undefined` rather than be half-read.
 */
export function readObserveScreenSuccess(
  message: AgentMessage,
): ObserveScreenSuccessDetails | undefined {
  if (!('role' in message) || message.role !== 'toolResult') {
    return undefined;
  }
  const details: unknown = (message as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) {
    return undefined;
  }
  const candidate = details as Partial<ObserveScreenSuccessDetails>;
  if (candidate.tool !== OBSERVE_SCREEN_TOOL_NAME || candidate.outcome !== 'observed') {
    return undefined;
  }
  if (
    typeof candidate.observationId !== 'string' ||
    typeof candidate.sceneId !== 'string' ||
    typeof candidate.sceneRevision !== 'number' ||
    !Array.isArray(candidate.purposes)
  ) {
    return undefined;
  }
  return candidate as ObserveScreenSuccessDetails;
}

interface ImageSlot {
  readonly messageIndex: number;
  readonly blockIndex: number;
  readonly purpose: ObservationImagePurpose | undefined;
  readonly budget: VisualBudget;
  readonly bytes: number;
  readonly observation: ObserveScreenSuccessDetails | undefined;
}

/**
 * True for a text block this module wrote in place of an image.
 *
 * Needed for one non-obvious reason: `details.purposes` is parallel to the
 * *original* image blocks, so counting "the n-th image in this message" breaks
 * the moment one of them has already become a record — the surviving pointer
 * crop would be read as `purposes[0]`, the full frame. Counting records as
 * occupied slots keeps the alignment, which also makes pruning idempotent: a
 * context that has already been pruned prunes to itself.
 *
 * Safe to detect by prefix: every record starts with `[Observation ` or is the
 * unattributed constant, and {@link sanitiseRecordText} rewrites `[` inside any
 * screen-derived text, so no quoted screen content can imitate one.
 */
function isObservationRecordBlock(block: ContentBlock): boolean {
  return (
    block.type === 'text' &&
    (block.text.startsWith('[Observation ') || block.text === UNATTRIBUTED_IMAGE_RECORD)
  );
}

function collectImageSlots(messages: readonly AgentMessage[]): ImageSlot[] {
  const slots: ImageSlot[] = [];
  messages.forEach((message, messageIndex) => {
    if (!hasBlockContent(message)) {
      return;
    }
    const observation = readObserveScreenSuccess(message);
    let imageOrdinal = 0;
    message.content.forEach((block, blockIndex) => {
      if (!isImageBlock(block)) {
        if (isObservationRecordBlock(block)) {
          imageOrdinal += 1;
        }
        return;
      }
      const purpose = observation?.purposes[imageOrdinal];
      imageOrdinal += 1;
      slots.push({
        messageIndex,
        blockIndex,
        ...(purpose === undefined ? { purpose: undefined } : { purpose }),
        // An image with no lineage cannot be shown to be a crop, so it is
        // budgeted as a full frame. Conservative on purpose: the failure mode of
        // guessing "crop" is an unbounded pile of full frames in context.
        budget: purpose === undefined ? 'frame' : BUDGET_FOR_PURPOSE[purpose],
        bytes: base64ByteLength(block.data),
        observation,
      });
    });
  });
  return slots;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface VisualContextStats {
  readonly images: number;
  /** Approximate decoded byte total of the image blocks. Never the bytes. */
  readonly bytes: number;
  readonly frames: number;
  readonly pointerCrops: number;
  readonly byPurpose: Readonly<Record<ObservationImagePurpose | 'unattributed', number>>;
}

function emptyStats(): {
  images: number;
  bytes: number;
  frames: number;
  pointerCrops: number;
  byPurpose: Record<ObservationImagePurpose | 'unattributed', number>;
} {
  return {
    images: 0,
    bytes: 0,
    frames: 0,
    pointerCrops: 0,
    byPurpose: { window: 0, pointer: 0, before: 0, after: 0, unattributed: 0 },
  };
}

function statsOf(slots: readonly ImageSlot[]): VisualContextStats {
  const stats = emptyStats();
  for (const slot of slots) {
    stats.images += 1;
    stats.bytes += slot.bytes;
    if (slot.budget === 'frame') {
      stats.frames += 1;
    } else {
      stats.pointerCrops += 1;
    }
    stats.byPurpose[slot.purpose ?? 'unattributed'] += 1;
  }
  return stats;
}

/**
 * Counts and sizes the image blocks in a message list.
 *
 * Run it over the provider-visible context to see what the model actually
 * carries; run it over `session.messages` to see what the transcript kept. The
 * gap between the two is the entire point of this module.
 */
export function summariseVisualContext(messages: readonly AgentMessage[]): VisualContextStats {
  return statsOf(collectImageSlots(messages));
}

/** Number of image blocks across a message list. Used by tests and telemetry. */
export function countImageBlocks(messages: readonly AgentMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (!hasBlockContent(message)) {
      continue;
    }
    for (const block of message.content) {
      if (isImageBlock(block)) {
        count += 1;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface VisualContextOptions {
  /** Defaults to {@link MVP_SCREEN_CONTEXT_POLICY}. */
  readonly policy?: ScreenPolicy;
  /** Past-tense summaries for pruned observations. See {@link createObservationNotebook}. */
  readonly summaryFor?: ObservationSummaryLookup;
  /**
   * Optional cap on the *total* number of image blocks kept, applied after the
   * per-purpose limits. Only useful for shrinking further than the policy; it
   * can never raise a per-purpose limit.
   */
  readonly maxTotalImages?: number;
}

export interface VisualContextPlan {
  /** How many images each budget was allowed to keep for this context. */
  readonly limits: { readonly frames: number; readonly pointerCrops: number };
  /**
   * True when the newest full frame in context is half of a `before-and-after`
   * observation. This is the only condition under which a second full frame is
   * allowed to survive (§10, §11).
   */
  readonly comparisonActive: boolean;
  readonly kept: VisualContextStats;
  readonly removed: VisualContextStats;
  /** The replacement records that would be written, oldest first. */
  readonly records: readonly string[];
}

interface Decision {
  readonly slots: readonly ImageSlot[];
  readonly keep: readonly boolean[];
  readonly comparisonActive: boolean;
  readonly frameLimit: number;
  readonly pointerCropLimit: number;
  readonly records: readonly (string | undefined)[];
}

function latestScene(slots: readonly ImageSlot[]): SceneStamp | undefined {
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    const observation = slots[index]?.observation;
    if (observation !== undefined) {
      return { sceneId: observation.sceneId, sceneRevision: observation.sceneRevision };
    }
  }
  return undefined;
}

function recordFor(
  slot: ImageSlot,
  current: SceneStamp | undefined,
  summaryFor: ObservationSummaryLookup | undefined,
): string {
  const observation = slot.observation;
  if (observation === undefined) {
    return UNATTRIBUTED_IMAGE_RECORD;
  }
  const superseded =
    current !== undefined &&
    (current.sceneId !== observation.sceneId ||
      current.sceneRevision !== observation.sceneRevision);
  return renderObservationRecord({
    sceneId: observation.sceneId,
    sceneRevision: observation.sceneRevision,
    summary: summaryFor?.(observation) ?? UNDESCRIBED_OBSERVATION_SUMMARY,
    ...(slot.purpose === undefined ? {} : { view: VIEW_LABEL[slot.purpose] }),
    ...(superseded && current !== undefined ? { supersededBy: current } : {}),
  });
}

function decide(messages: readonly AgentMessage[], options: VisualContextOptions): Decision {
  const policy = options.policy ?? MVP_SCREEN_CONTEXT_POLICY;
  const active = policy.activeContext;
  const slots = collectImageSlots(messages);

  // "A second frame only for an active comparison." The comparison is active
  // while the newest frame in context is one half of a `before-and-after`
  // observation; the moment an ordinary observation lands on top of it, the
  // budget closes back to one frame and the comparison's frames are pruned.
  const newestFrame = [...slots].reverse().find((slot) => slot.budget === 'frame');
  const comparisonActive =
    newestFrame?.purpose !== undefined && COMPARISON_PURPOSES.has(newestFrame.purpose);

  const frameLimit = Math.max(
    0,
    comparisonActive
      ? Math.max(active.maxFullFrames, active.maxComparisonFrames)
      : active.maxFullFrames,
  );
  const pointerCropLimit = Math.max(0, active.maxPointerCrops);

  const keep = new Array<boolean>(slots.length).fill(false);
  let frames = 0;
  let crops = 0;
  let total = 0;
  const totalLimit = options.maxTotalImages ?? Number.POSITIVE_INFINITY;

  // Newest first: §11 keeps the *latest* relevant frame and the *latest*
  // relevant crop, so recency is the tie-break inside each budget.
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    const slot = slots[index];
    if (slot === undefined || total >= totalLimit) {
      continue;
    }
    if (slot.budget === 'frame' ? frames < frameLimit : crops < pointerCropLimit) {
      keep[index] = true;
      total += 1;
      if (slot.budget === 'frame') {
        frames += 1;
      } else {
        crops += 1;
      }
    }
  }

  const current = latestScene(slots);
  const records = slots.map((slot, index) =>
    keep[index] === true ? undefined : recordFor(slot, current, options.summaryFor),
  );

  return { slots, keep, comparisonActive, frameLimit, pointerCropLimit, records };
}

/**
 * What {@link pruneVisualContextByPolicy} would do, without doing it.
 *
 * Exposed so the demo, diagnostics and PR-022b's compaction trigger can read
 * the active image count and byte total per turn without duplicating the rules.
 */
export function planVisualContext(
  messages: readonly AgentMessage[],
  options: VisualContextOptions = {},
): VisualContextPlan {
  const decision = decide(messages, options);
  const kept: ImageSlot[] = [];
  const removed: ImageSlot[] = [];
  decision.slots.forEach((slot, index) => {
    (decision.keep[index] === true ? kept : removed).push(slot);
  });
  return {
    limits: { frames: decision.frameLimit, pointerCrops: decision.pointerCropLimit },
    comparisonActive: decision.comparisonActive,
    kept: statsOf(kept),
    removed: statsOf(removed),
    records: decision.records.filter((record): record is string => record !== undefined),
  };
}

/**
 * Enforces the §10/§11 active-context image limits, per purpose.
 *
 * Keeps the latest full frame and the latest pointer crop, plus a second full
 * frame while a comparison is active, and replaces every other image block with
 * the §11 replacement record. Pure: returns new messages and never mutates the
 * input, which is what makes it safe as `transformContext` — the transcript and
 * the durable record keep their pixels.
 *
 * Total by construction, and defensively total again: Pi's contract is that
 * `transformContext` "must not throw or reject", and a throw here would take the
 * whole run down. The fallback is the older count-based pruner, which is a
 * strictly simpler code path with no lineage reading in it.
 */
export function pruneVisualContextByPolicy(
  messages: readonly AgentMessage[],
  options: VisualContextOptions = {},
): AgentMessage[] {
  try {
    const decision = decide(messages, options);
    if (decision.keep.every((keep) => keep)) {
      return [...messages];
    }
    const replacements = new Map<number, Map<number, string>>();
    decision.slots.forEach((slot, index) => {
      const record = decision.records[index];
      if (decision.keep[index] === true || record === undefined) {
        return;
      }
      const perMessage = replacements.get(slot.messageIndex) ?? new Map<number, string>();
      perMessage.set(slot.blockIndex, record);
      replacements.set(slot.messageIndex, perMessage);
    });

    return messages.map((message, messageIndex) => {
      const perMessage = replacements.get(messageIndex);
      if (perMessage === undefined || !hasBlockContent(message)) {
        return message;
      }
      const content = message.content.map((block, blockIndex): ContentBlock => {
        const record = perMessage.get(blockIndex);
        return record === undefined ? block : { type: 'text', text: record };
      });
      return { ...message, content } as AgentMessage;
    });
  } catch {
    const active = (options.policy ?? MVP_SCREEN_CONTEXT_POLICY).activeContext;
    return pruneVisualContext(messages, {
      keepMostRecent: active.maxFullFrames + active.maxPointerCrops,
    });
  }
}

export interface PruneOptions {
  /**
   * How many image blocks to keep, counted from the end of the transcript.
   * system-design §11 wants "latest relevant full frame" plus "latest relevant
   * pointer crop", and a second frame only for an active comparison — which a
   * single count cannot express. Prefer {@link pruneVisualContextByPolicy};
   * this remains as the last-resort fallback and for callers that genuinely
   * only want a count.
   */
  readonly keepMostRecent: number;
  /** Placeholder text for each replaced image. Defaults to a generic record. */
  readonly placeholderFor?: (message: AgentMessage, index: number) => string;
}

/**
 * Replaces all but the `keepMostRecent` newest image blocks with text.
 *
 * Pure: returns new messages and never mutates the input. Contract from Pi:
 * `transformContext` "must not throw or reject" — this function cannot.
 */
export function pruneVisualContext(
  messages: readonly AgentMessage[],
  options: PruneOptions,
): AgentMessage[] {
  const keep = Math.max(0, options.keepMostRecent);
  const total = countImageBlocks(messages);
  let remainingToReplace = Math.max(0, total - keep);
  if (remainingToReplace === 0) {
    return [...messages];
  }

  const placeholderFor = options.placeholderFor ?? (() => UNATTRIBUTED_IMAGE_RECORD);

  return messages.map((message, index) => {
    if (remainingToReplace === 0 || !hasBlockContent(message)) {
      return message;
    }
    let changed = false;
    const content = message.content.map((block): ContentBlock => {
      if (remainingToReplace > 0 && isImageBlock(block)) {
        remainingToReplace -= 1;
        changed = true;
        return { type: 'text', text: placeholderFor(message, index) };
      }
      return block;
    });
    return changed ? ({ ...message, content } as AgentMessage) : message;
  });
}

/**
 * Removes image payloads from a message so it is safe to persist.
 *
 * Every image block becomes a text block naming the mime type and byte length
 * — enough for an audit trail, with no pixels. This is the only thing standing
 * between a screenshot and the session database.
 */
export function stripImageBlocks(message: AgentMessage): AgentMessage {
  if (!hasBlockContent(message)) {
    return message;
  }
  let changed = false;
  const content = message.content.map((block): ContentBlock => {
    if (!isImageBlock(block)) {
      return block;
    }
    changed = true;
    return {
      type: 'text',
      text: `[image withheld: ${block.mimeType}, ${String(block.data.length)} base64 chars]`,
    };
  });
  return changed ? ({ ...message, content } as AgentMessage) : message;
}

/** True when a message still carries raw image bytes. */
export function containsImageBytes(message: AgentMessage): boolean {
  return hasBlockContent(message) && message.content.some(isImageBlock);
}
