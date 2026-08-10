import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  shouldCompact as piShouldCompact,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ImageContent, Message, TextContent } from '@earendil-works/pi-ai';
import { MVP_SCREEN_CONTEXT_POLICY, type QuestionEnvelope, type ScreenPolicy } from '@pilot/shared';
import { isFailedToolDetails } from './tool-result.js';
import {
  OBSERVE_SCREEN_TOOL_NAME,
  type ObserveScreenFailure,
  type ObserveScreenFailureDetails,
} from './observe-screen.js';
import {
  planVisualContext,
  readObserveScreenSuccess,
  sanitiseRecordText,
  type ObservationSummaryLookup,
  type VisualContextOptions,
} from './visual-context.js';

/**
 * Compaction orchestration (system-design §11).
 *
 * PR-022a bounded the *images* the model carries. This file bounds the
 * *conversation*: it decides when history has to be folded into a summary, does
 * the folding, and hands the result to Pi through the same `transformContext`
 * hook — so the provider sees a compacted context while `agent.state.messages`
 * and the durable record keep every original message, byte for byte.
 *
 * WHY ALL OF THIS IS PILOT'S OWN CODE
 * -----------------------------------
 * `docs/pi-notes.md` §2.7 and §6.5, verified against pinned Pi 0.84.1:
 *
 *  - `AgentHarness.compact` — the orchestrator this would otherwise be — is an
 *    unimplemented stub that rejects with `HarnessNotImplemented`.
 *  - `prepareCompaction` / `compact` operate on session `Entry[]`, not on the
 *    `AgentMessage[]` an `Agent` actually holds, and `compact` needs a live
 *    provider call.
 *  - None of §11's three triggers exist in Pi. `shouldCompact()` implements a
 *    *different* rule — reserve-token headroom against the context window — so
 *    it is used here as one extra input, reported separately, never as the rule.
 *
 * WHAT IS BORROWED FROM PI
 * ------------------------
 * `estimateTokens(message)` (pure, local, character heuristic) and
 * `shouldCompact(tokens, window, settings)` (pure, local). Nothing else; in
 * particular {@link estimateActiveContext} deliberately does **not** call
 * `estimateContextTokens`, because that function prefers the provider `usage`
 * reported on the last assistant message — which describes the *previous*
 * request, and which the faux provider reports as a fixed handful of tokens.
 * A trigger that reads §11's "estimated model context usage" has to estimate
 * the request Pilot is about to send, not the one it already sent.
 *
 * TWO THINGS THIS FILE DOES NOT DO
 * --------------------------------
 *  - It never mutates the transcript. {@link CompactionController.apply} builds
 *    a new array for the provider; `session.messages` is untouched.
 *  - It never persists anything. PR-023 owns the `Agent ↔ Session` bridge;
 *    {@link CompactionController.state} is the read-only handle it needs.
 */

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Injected clock. Library code in this repo never calls `Date.now()` directly;
 * {@link SYSTEM_NOW} is the single adapter that does, so a test or the demo can
 * make the summary message's timestamp deterministic.
 */
export type NowFn = () => number;

/** The only place in this module that reads wall-clock time. */
export const SYSTEM_NOW: NowFn = () => Date.now();

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * The three §11 triggers, plus the one extra input Pi supplies.
 *
 * `provider-headroom` is Pi's `shouldCompact()` — reserve-token headroom
 * against the context window. It is **not** one of §11's conditions; it is
 * reported alongside them so a very small context window still compacts before
 * the provider refuses the request.
 */
export const COMPACTION_TRIGGERS = [
  'new-observations',
  'context-usage',
  'window-changed',
  'provider-headroom',
] as const;

export type CompactionTrigger = (typeof COMPACTION_TRIGGERS)[number];

/** How an image block is charged against the context window. */
export interface ImageTokenCost {
  /** Fixed cost per image, whatever its size. */
  readonly perImage: number;
  /** Decoded bytes per additional token. */
  readonly bytesPerToken: number;
}

/**
 * Image accounting, and why it is Pilot's rather than Pi's.
 *
 * Pi charges a flat 4800 characters (1200 tokens) for *every* image block
 * regardless of size (`ESTIMATED_IMAGE_CHARS` in
 * `pi-agent-core/dist/harness/compaction/compaction.js`). For Pilot that is
 * wrong in a way that matters: a 640px pointer crop would be charged the same
 * as a full 1440px frame, so a run of crops could trip the 60% trigger while a
 * run of frames under-reports.
 *
 * These constants are linear in count *and* bytes, which makes the aggregate
 * exact from the two numbers PR-022a's {@link planVisualContext} already
 * publishes (`kept.images`, `kept.bytes`) — no per-image walk, no duplicated
 * pruning rule. Calibration: a ~120 KB full frame costs 1024 tokens (close to
 * Pi's flat charge, and to the ~1280 tokens a 1200×800 screenshot costs a real
 * vision model), while an ~18 KB pointer crop costs 208.
 */
export const DEFAULT_IMAGE_TOKEN_COST: ImageTokenCost = {
  perImage: 64,
  bytesPerToken: 128,
};

export interface CompactionPolicy {
  /**
   * §11: "Four new visual observations since the previous compaction."
   * Counted as distinct `observe_screen` observations, not image blocks — one
   * observation can contribute a frame and a crop.
   */
  readonly newObservations: number;
  /** §11: "Estimated model context usage exceeds 60%." */
  readonly contextUsageFraction: number;
  /**
   * §11: "Last 6–10 text turns" stay in active context. Compaction never cuts
   * into them, so a trigger can fire and correctly do nothing.
   */
  readonly keepRecentTurns: number;
  /** How an image block is charged. See {@link DEFAULT_IMAGE_TOKEN_COST}. */
  readonly imageTokenCost: ImageTokenCost;
  /** Longest any single quoted fragment may be inside a summary. */
  readonly maxFragmentChars: number;
  /** Most items kept per summary section. Older items are dropped, and said so. */
  readonly maxItemsPerSection: number;
}

/** §11's numbers, verbatim. */
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  newObservations: 4,
  contextUsageFraction: 0.6,
  keepRecentTurns: 6,
  imageTokenCost: DEFAULT_IMAGE_TOKEN_COST,
  maxFragmentChars: 200,
  maxItemsPerSection: 8,
};

// ---------------------------------------------------------------------------
// Reading the transcript
// ---------------------------------------------------------------------------

type ContentBlock = TextContent | ImageContent;

function hasBlockContent(message: AgentMessage): message is Extract<
  Message,
  { content: ContentBlock[] }
> & {
  content: ContentBlock[];
} {
  return 'content' in message && Array.isArray(message.content);
}

function isUserMessage(message: AgentMessage): boolean {
  return 'role' in message && message.role === 'user';
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return 'role' in message && message.role === 'assistant';
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * Reads the failure `details` PR-021 puts on a failed `observe_screen` result.
 *
 * Mirrors PR-022a's {@link readObserveScreenSuccess} and is defensive for the
 * same reason: details survive a JSON round trip, and a message from another
 * tool or another Pilot version must fall through to `undefined`.
 */
export function readObserveScreenFailure(
  message: AgentMessage,
): ObserveScreenFailureDetails | undefined {
  if (!('role' in message) || message.role !== 'toolResult') {
    return undefined;
  }
  const details: unknown = (message as { details?: unknown }).details;
  if (!isFailedToolDetails(details)) {
    return undefined;
  }
  const candidate = details as Partial<ObserveScreenFailureDetails>;
  if (candidate.tool !== OBSERVE_SCREEN_TOOL_NAME || typeof candidate.failure !== 'string') {
    return undefined;
  }
  return candidate as ObserveScreenFailureDetails;
}

/**
 * Indices where a user-visible turn starts.
 *
 * A turn starts at a `user` message; everything after it — the assistant turn,
 * its tool calls and their results — belongs to that turn. Compaction only ever
 * cuts on one of these, so a summary can never split a tool call from its
 * result (the same invariant Pi's `findTurnStartIndex` maintains over session
 * entries, restated for the `AgentMessage[]` an `Agent` actually holds).
 */
export function findTurnStarts(messages: readonly AgentMessage[]): number[] {
  const starts: number[] = [];
  messages.forEach((message, index) => {
    if (isUserMessage(message)) {
      starts.push(index);
    }
  });
  return starts;
}

/** Distinct `observe_screen` observations in a slice of the transcript. */
export function countVisualObservations(messages: readonly AgentMessage[], fromIndex = 0): number {
  const seen = new Set<string>();
  for (let index = Math.max(0, fromIndex); index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    const details = readObserveScreenSuccess(message);
    if (details !== undefined) {
      seen.add(details.observationId);
    }
  }
  return seen.size;
}

/**
 * Scene identity is window identity.
 *
 * VERIFIED in `packages/observation/src/scene-tracker.ts`: `sceneId` "changes
 * only when the *selection* changes" — content, geometry and title changes move
 * the *revision* instead. So a change of `sceneId` between two observations is
 * exactly "the selected window changed", with no extra plumbing from the
 * observation lane.
 */
export interface WindowChange {
  readonly changed: boolean;
  /** The window whose visual detail is now stale, if any. */
  readonly staleSceneId?: string;
  readonly currentSceneId?: string;
}

export function detectWindowChange(
  messages: readonly AgentMessage[],
  options: { readonly fromIndex?: number; readonly currentSceneId?: string } = {},
): WindowChange {
  const fromIndex = Math.max(0, options.fromIndex ?? 0);
  const scenes: string[] = [];
  for (let index = fromIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    const details = readObserveScreenSuccess(message);
    if (details !== undefined) {
      scenes.push(details.sceneId);
    }
  }
  if (scenes.length === 0) {
    return {
      changed: false,
      ...(options.currentSceneId === undefined ? {} : { currentSceneId: options.currentSceneId }),
    };
  }
  // The current window is whatever the caller says it is (an envelope knows
  // before any new observation has been taken); otherwise the newest
  // observation's.
  const current = options.currentSceneId ?? scenes[scenes.length - 1];
  const stale = scenes.find((sceneId) => sceneId !== current);
  if (stale === undefined || current === undefined) {
    return { changed: false, ...(current === undefined ? {} : { currentSceneId: current }) };
  }
  return { changed: true, staleSceneId: stale, currentSceneId: current };
}

// ---------------------------------------------------------------------------
// Context size
// ---------------------------------------------------------------------------

export interface ActiveContextEstimate {
  /** Text tokens plus image tokens. */
  readonly tokens: number;
  readonly textTokens: number;
  readonly imageTokens: number;
  readonly images: number;
  readonly imageBytes: number;
  readonly contextWindow: number;
  /** `tokens / contextWindow`, clamped at 0 for a nonsensical window. */
  readonly fraction: number;
}

/** Replaces image blocks with empty text so Pi's heuristic charges them nothing. */
function blankImages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (!hasBlockContent(message)) {
      return message;
    }
    let changed = false;
    const content = message.content.map((block): ContentBlock => {
      if (block.type !== 'image') {
        return block;
      }
      changed = true;
      return { type: 'text', text: '' };
    });
    return changed ? ({ ...message, content } as AgentMessage) : message;
  });
}

/**
 * Estimates what one provider request costs, for §11's "context usage exceeds
 * 60%" trigger.
 *
 * Hand it the **provider-facing** context — after compaction has folded and
 * after PR-022a has pruned — because that is what the model receives and it is
 * what makes the trigger self-limiting: once history is a summary, usage drops
 * and the trigger stops firing.
 *
 * Text and images are counted separately and by different rules: text through
 * Pi's own `estimateTokens` over every message, images through
 * {@link ImageTokenCost} applied to the counts PR-022a's
 * {@link planVisualContext} publishes. Note the asymmetry that follows from
 * reusing PR-022a's rule rather than restating it: the image half reports what
 * the §10 budget would *keep*, so handing this function an un-pruned list
 * under-reports its images on purpose — the provider was never going to see
 * them.
 *
 * Total by construction. It runs inside a Pi event handler and, indirectly,
 * inside `transformContext`; a malformed message must not be able to take a run
 * down. (Pi's own `estimateTokens` throws on a `toolResult` whose `content` is
 * not iterable, which is exactly the shape a half-decoded persisted message
 * has.)
 */
export function estimateActiveContext(
  messages: readonly AgentMessage[],
  options: {
    readonly contextWindow: number;
    readonly imageTokenCost?: ImageTokenCost;
    readonly policy?: ScreenPolicy;
    readonly summaryFor?: ObservationSummaryLookup;
  },
): ActiveContextEstimate {
  const cost = options.imageTokenCost ?? DEFAULT_IMAGE_TOKEN_COST;
  const visual: VisualContextOptions = {
    policy: options.policy ?? MVP_SCREEN_CONTEXT_POLICY,
    ...(options.summaryFor === undefined ? {} : { summaryFor: options.summaryFor }),
  };
  const kept = planVisualContext(messages, visual).kept;
  let textTokens = 0;
  for (const message of blankImages(messages)) {
    try {
      textTokens += estimateTokens(message);
    } catch {
      // A message Pi's heuristic cannot read contributes nothing rather than
      // aborting the estimate. Under-counting one message only delays a
      // compaction; throwing would fail the turn.
    }
  }
  const imageTokens =
    kept.images * cost.perImage + Math.ceil(kept.bytes / Math.max(1, cost.bytesPerToken));
  const tokens = textTokens + imageTokens;
  const contextWindow = Math.max(0, options.contextWindow);
  return {
    tokens,
    textTokens,
    imageTokens,
    images: kept.images,
    imageBytes: kept.bytes,
    contextWindow,
    fraction: contextWindow > 0 ? tokens / contextWindow : 0,
  };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface CompactionDecision {
  readonly compact: boolean;
  /** Every trigger that fired, in {@link COMPACTION_TRIGGERS} order. */
  readonly triggers: readonly CompactionTrigger[];
  readonly newObservations: number;
  readonly usage: ActiveContextEstimate;
  readonly windowChange: WindowChange;
}

export interface CompactionTriggerInput {
  /** The whole transcript, unmodified. */
  readonly messages: readonly AgentMessage[];
  /** Provider-facing context: compaction applied, then pruning. */
  readonly activeContext: readonly AgentMessage[];
  readonly contextWindow: number;
  /** Total observations counted at the previous compaction. */
  readonly observationsAtLastCompaction: number;
  /** Index of the first message not yet folded into a summary. */
  readonly boundaryIndex: number;
  /** Scene the user is on now, from the newest question envelope. */
  readonly currentSceneId?: string;
  readonly policy?: CompactionPolicy;
  readonly screenPolicy?: ScreenPolicy;
  readonly summaryFor?: ObservationSummaryLookup;
}

/**
 * All three §11 triggers, evaluated independently, plus Pi's `shouldCompact`.
 *
 * Independent on purpose: each is reported whether or not the others fired, so
 * a caller (and the demo) can see *which* condition drove a compaction rather
 * than only that one did.
 */
export function evaluateCompaction(input: CompactionTriggerInput): CompactionDecision {
  const policy = input.policy ?? DEFAULT_COMPACTION_POLICY;
  const usage = estimateActiveContext(input.activeContext, {
    contextWindow: input.contextWindow,
    imageTokenCost: policy.imageTokenCost,
    ...(input.screenPolicy === undefined ? {} : { policy: input.screenPolicy }),
    ...(input.summaryFor === undefined ? {} : { summaryFor: input.summaryFor }),
  });
  const observations = countVisualObservations(input.messages);
  const newObservations = Math.max(0, observations - input.observationsAtLastCompaction);
  const windowChange = detectWindowChange(input.messages, {
    fromIndex: input.boundaryIndex,
    ...(input.currentSceneId === undefined ? {} : { currentSceneId: input.currentSceneId }),
  });

  const triggers: CompactionTrigger[] = [];
  if (newObservations >= policy.newObservations) {
    triggers.push('new-observations');
  }
  if (usage.contextWindow > 0 && usage.fraction > policy.contextUsageFraction) {
    triggers.push('context-usage');
  }
  if (windowChange.changed) {
    triggers.push('window-changed');
  }
  // Pi's rule, and the one case where it must be ignored. `shouldCompact` is
  // `tokens > contextWindow - reserveTokens` with a *fixed* 16384-token
  // reserve, so for any window at or below that reserve the right-hand side is
  // zero or negative and the rule degenerates to "always compact" — which is
  // not a signal, it is noise, and it would drive a compaction on every single
  // turn of a small local model (`docs/pi-notes.md` §9.3 sizes those at 32k, but
  // 8k and 16k are common). Consulted only where it can say something.
  if (
    usage.contextWindow > DEFAULT_COMPACTION_SETTINGS.reserveTokens &&
    piShouldCompact(usage.tokens, usage.contextWindow, DEFAULT_COMPACTION_SETTINGS)
  ) {
    triggers.push('provider-headroom');
  }

  return { compact: triggers.length > 0, triggers, newObservations, usage, windowChange };
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

/**
 * What `summariseObservation` (PR-022a) writes when the pointer was over a
 * secure field. Compaction promotes that to a safety-relevant fact, so the
 * coupling is named here and pinned by a test rather than left implicit.
 */
export const SECURE_FIELD_MARKER = 'secure field';

/** Observation failures that say something about privacy or permissions. */
const SAFETY_RELEVANT_FAILURES: Readonly<Record<ObserveScreenFailure, string | undefined>> = {
  'permission-denied':
    'Pilot was refused a screen capture because macOS Screen Recording permission was not granted.',
  'protected-content': 'An application blocked screen capture, so Pilot never saw that window.',
  'screen-locked': 'The screen was locked, so nothing could be captured.',
  'policy-rejected':
    "Pilot's own screen policy refused an observation, so less of the screen was sent than the model asked for.",
  'observation-paused': 'Screen observation was paused, so nothing was captured.',
  'no-window-selected': 'No window was selected, and Pilot never captures the whole display.',
  'window-lost': undefined,
  'blank-capture': undefined,
  'scene-changed': undefined,
  cancelled: undefined,
  unavailable: undefined,
};

/**
 * Structured, *extractive* summary.
 *
 * Every field is quoted or derived from the transcript. Nothing here is
 * generated by a model, which is deliberate: `docs/pi-notes.md` §11 records that
 * Pi's `compact()` needs a live provider call and that its summary quality is
 * untested, and §11's requirement — preserve goals, decisions, named UI
 * elements, unresolved questions and safety-relevant facts, and never claim an
 * old screen description is current — is a requirement a generative summariser
 * can silently violate. An extractive summariser cannot invent a screen it
 * never saw.
 */
export interface CompactionSummary {
  /** 1 for the first compaction of a conversation, then 2, 3, … */
  readonly generation: number;
  /** Transcript messages folded into this summary, counted from index 0. */
  readonly coveredMessages: number;
  readonly goals: readonly string[];
  readonly decisions: readonly string[];
  readonly namedElements: readonly string[];
  readonly screens: readonly string[];
  readonly unresolved: readonly string[];
  readonly safety: readonly string[];
  /** Every scene this summary carries a screen record for. */
  readonly observedScenes: readonly string[];
  /** How many items were dropped from each section to keep the summary bounded. */
  readonly omitted: number;
  /**
   * Where the screen had moved to when this summary was written, when that is a
   * window none of {@link observedScenes} describes.
   *
   * Same rule as PR-022a's `ObservationRecord.supersededBy`, and the same
   * reason: naming a scene the conversation has already left is the strongest
   * available proof that the records above are history. It is deliberately
   * absent when the screen has *not* moved on — "the screen has since moved to
   * scene-17" while the records are also scene-17 would be a false statement,
   * which is precisely the defect §11 is guarding against.
   */
  readonly supersededBy?: SceneStampFacts;
  /** The rendered text. This is what the model sees. */
  readonly text: string;
}

/** Scene identity, as a summary stamps it. */
export interface SceneStampFacts {
  readonly sceneId: string;
  readonly sceneRevision: number;
}

/** One question, as the session recorded it at submit time. */
export interface QuestionRecord {
  readonly utteranceId: string;
  /** Index the user message occupies in `agent.state.messages`. */
  readonly messageIndex: number;
  readonly transcript: string;
  readonly sceneId: string;
  readonly sceneRevision: number;
  readonly windowTitle: string;
  readonly targetRole?: string;
  readonly targetLabel?: string;
}

export function toQuestionRecord(envelope: QuestionEnvelope, messageIndex: number): QuestionRecord {
  return {
    utteranceId: envelope.utteranceId,
    messageIndex,
    transcript: envelope.transcript,
    sceneId: envelope.scene.id,
    sceneRevision: envelope.scene.revision,
    windowTitle: envelope.scene.windowTitle,
    ...(envelope.pointer.targetRole === undefined
      ? {}
      : { targetRole: envelope.pointer.targetRole }),
    ...(envelope.pointer.targetLabel === undefined
      ? {}
      : { targetLabel: envelope.pointer.targetLabel }),
  };
}

export interface BuildSummaryInput {
  readonly messages: readonly AgentMessage[];
  /** Fold `[from, to)`. `from` is the previous summary's boundary. */
  readonly from: number;
  readonly to: number;
  readonly generation: number;
  readonly previous?: CompactionSummary;
  readonly questions?: readonly QuestionRecord[];
  readonly summaryFor?: ObservationSummaryLookup;
  /** Where the screen is now, from the newest question envelope. */
  readonly currentScene?: SceneStampFacts;
  readonly policy?: CompactionPolicy;
}

/** Quote a fragment so it cannot restructure the record around it (§14). */
function quote(text: string, maxChars: number): string {
  return `“${sanitiseRecordText(text, maxChars)}”`;
}

function tail<T>(items: readonly T[], limit: number): { kept: T[]; dropped: number } {
  if (items.length <= limit) {
    return { kept: [...items], dropped: 0 };
  }
  return { kept: items.slice(items.length - limit), dropped: items.length - limit };
}

/**
 * The prefix every verbatim quotation carries.
 *
 * Load-bearing for the truthfulness proof: these two prefixes are the *only*
 * lines of a summary whose wording Pilot does not control, so the test that
 * hunts for present-tense screen claims strips them and checks everything else.
 * A quotation that carried a present-tense claim would still be attributed to a
 * past turn by its prefix and disclaimed by the header and trailer.
 */
export const SUMMARY_QUOTE_PREFIXES = {
  goal: '- The user asked, earlier in this conversation: ',
  decision: '- Pilot answered, earlier in this conversation: ',
} as const;

const STALENESS_CLAUSE = 'not a description of the screen now';

export function buildCompactionSummary(input: BuildSummaryInput): CompactionSummary {
  const policy = input.policy ?? DEFAULT_COMPACTION_POLICY;
  const from = Math.max(0, input.from);
  const to = Math.max(from, Math.min(input.to, input.messages.length));
  const previous = input.previous;
  const fragment = policy.maxFragmentChars;

  const goals: string[] = [...(previous?.goals ?? [])];
  const decisions: string[] = [...(previous?.decisions ?? [])];
  const namedElements: string[] = [...(previous?.namedElements ?? [])];
  const screens: string[] = [...(previous?.screens ?? [])];
  const unresolved: string[] = [...(previous?.unresolved ?? [])];
  const safety: string[] = [...(previous?.safety ?? [])];
  const observedScenes = new Set<string>(previous?.observedScenes ?? []);

  // --- goals and named elements, from the recorded envelopes ---------------
  const questions = (input.questions ?? []).filter(
    (question) => question.messageIndex >= from && question.messageIndex < to,
  );
  for (const question of questions) {
    goals.push(quote(question.transcript, fragment));
    const label = question.targetLabel;
    const role = question.targetRole;
    const window = sanitiseRecordText(question.windowTitle, 80);
    if (label !== undefined || role !== undefined) {
      const element = [
        label === undefined ? undefined : `“${sanitiseRecordText(label, 60)}”`,
        role === undefined ? undefined : sanitiseRecordText(role, 40),
      ]
        .filter((part): part is string => part !== undefined)
        .join(' ');
      namedElements.push(`the ${element}, in the window “${window}”`);
    } else {
      namedElements.push(`the window “${window}”`);
    }
  }

  // --- decisions and unresolved questions, from the transcript -------------
  //
  // A turn is resolved when its last assistant message stopped normally with
  // something to say. An aborted run, a provider failure and an empty answer
  // are all "the user asked and did not get an answer", which §11 wants carried
  // forward rather than quietly dropped.
  const turnStarts = findTurnStarts(input.messages);
  for (const [ordinal, start] of turnStarts.entries()) {
    if (start < from || start >= to) {
      continue;
    }
    const end = turnStarts[ordinal + 1] ?? input.messages.length;
    let answer: AssistantMessage | undefined;
    for (let index = Math.min(end, to) - 1; index >= start; index -= 1) {
      const message = input.messages[index];
      if (message !== undefined && isAssistantMessage(message)) {
        answer = message;
        break;
      }
    }
    const text = answer === undefined ? '' : assistantText(answer);
    const stopped = answer?.stopReason;
    if (text.length > 0 && stopped !== 'aborted' && stopped !== 'error') {
      decisions.push(quote(text, fragment));
      continue;
    }
    const asked = input.messages[start];
    const question = questions.find((candidate) => candidate.messageIndex === start);
    const what =
      question !== undefined
        ? quote(question.transcript, 120)
        : asked !== undefined && hasBlockContent(asked)
          ? quote(firstText(asked.content), 120)
          : '“(question not recorded)”';
    const why =
      stopped === 'aborted'
        ? 'the run was interrupted before Pilot answered'
        : stopped === 'error'
          ? 'the provider request failed before Pilot answered'
          : 'Pilot produced no answer';
    unresolved.push(`The user asked ${what} and ${why}.`);
  }

  // --- screens and safety-relevant facts, from the observation results -----
  for (let index = from; index < to; index += 1) {
    const message = input.messages[index];
    if (message === undefined) {
      continue;
    }
    const observed = readObserveScreenSuccess(message);
    if (observed !== undefined) {
      const sentence = input.summaryFor?.(observed);
      const stamp = `${observed.sceneId}/revision-${String(observed.sceneRevision)}`;
      observedScenes.add(observed.sceneId);
      screens.push(
        `${stamp}: ${sentence === undefined ? 'No description of that frame was recorded.' : sanitiseRecordText(sentence, fragment)} This is a past record of ${observed.sceneId} at revision ${String(observed.sceneRevision)}, ${STALENESS_CLAUSE}.`,
      );
      if (sentence !== undefined && sentence.includes(SECURE_FIELD_MARKER)) {
        safety.push(
          `At ${stamp} the pointer was over a secure field; its label and contents were withheld and are not in this summary.`,
        );
      }
      continue;
    }
    const failed = readObserveScreenFailure(message);
    if (failed !== undefined) {
      const fact = SAFETY_RELEVANT_FAILURES[failed.failure as ObserveScreenFailure];
      if (fact !== undefined) {
        safety.push(fact);
      }
    }
  }

  const limit = policy.maxItemsPerSection;
  const sections = {
    goals: tail(dedupe(goals), limit),
    decisions: tail(dedupe(decisions), limit),
    namedElements: tail(dedupe(namedElements), limit),
    screens: tail(dedupe(screens), limit),
    unresolved: tail(dedupe(unresolved), limit),
    safety: tail(dedupe(safety), limit),
  };
  const omitted = Object.values(sections).reduce((total, section) => total + section.dropped, 0);

  const current = input.currentScene;
  const superseded = current !== undefined && !observedScenes.has(current.sceneId);
  const summary: Omit<CompactionSummary, 'text'> = {
    generation: input.generation,
    coveredMessages: to,
    goals: sections.goals.kept,
    decisions: sections.decisions.kept,
    namedElements: sections.namedElements.kept,
    screens: sections.screens.kept,
    unresolved: sections.unresolved.kept,
    safety: sections.safety.kept,
    observedScenes: [...observedScenes],
    omitted,
    ...(superseded && current !== undefined ? { supersededBy: current } : {}),
  };
  return { ...summary, text: renderCompactionSummary(summary) };
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function firstText(content: readonly ContentBlock[]): string {
  for (const block of content) {
    if (block.type === 'text' && block.text.length > 0) {
      return block.text;
    }
  }
  return '';
}

/**
 * Renders the summary the model reads.
 *
 * The wording bar is PR-022a's `renderObservationRecord`, at a larger blast
 * radius: a compaction summary outlives far more of the conversation than one
 * replacement record, so a present-tense reading of it would misdescribe the
 * screen for the rest of the session. It therefore carries the same staleness
 * clause in three places — the header, once per screen record, and the trailer
 * — plus a standing instruction to re-observe.
 *
 * Structure, in Pilot's own voice apart from two quotation prefixes:
 *
 * ```text
 * [Conversation summary 1 — Pilot's own record of the first 12 messages …
 *
 * What the user asked for:
 * - The user asked, earlier in this conversation: “…”
 * …
 * None of the screen descriptions above describes the screen now. …]
 * ```
 */
export function renderCompactionSummary(summary: Omit<CompactionSummary, 'text'>): string {
  const lines: string[] = [];
  lines.push(
    `[Conversation summary ${String(summary.generation)} — Pilot's own record of the first ${String(summary.coveredMessages)} messages of this conversation, which have been compacted out of the active context. It is Pilot's record, not something the user said, and every screen description in it is a past record, ${STALENESS_CLAUSE}.`,
  );

  const section = (heading: string, items: readonly string[], bulletsAreQuotes?: string): void => {
    if (items.length === 0) {
      return;
    }
    lines.push('');
    lines.push(heading);
    for (const item of items) {
      lines.push(bulletsAreQuotes === undefined ? `- ${item}` : `${bulletsAreQuotes}${item}`);
    }
  };

  section('What the user asked for:', summary.goals, SUMMARY_QUOTE_PREFIXES.goal);
  section('What Pilot answered:', summary.decisions, SUMMARY_QUOTE_PREFIXES.decision);
  section('Interface elements this conversation referred to by name:', summary.namedElements);
  section(`Screens that were observed (past records, ${STALENESS_CLAUSE}):`, summary.screens);
  section('Questions that were left unresolved:', summary.unresolved);
  section('Safety-relevant facts:', summary.safety);

  if (summary.omitted > 0) {
    lines.push('');
    lines.push(
      `(${String(summary.omitted)} older items were dropped from the lists above to keep this summary bounded.)`,
    );
  }

  const moved = summary.supersededBy;
  const since =
    moved === undefined
      ? ''
      : `; the screen has since moved to ${sanitiseRecordText(moved.sceneId, 60)}/revision-${String(moved.sceneRevision)}`;
  lines.push('');
  lines.push(
    `None of the screen descriptions above describes the screen now. They are records of what was on screen when each observation was taken${since}. Call ${OBSERVE_SCREEN_TOOL_NAME} before answering anything about what is on screen now.]`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export interface CompactionState {
  readonly generation: number;
  /** First transcript message *not* folded into {@link summary}. */
  readonly boundaryIndex: number;
  readonly summary: CompactionSummary | undefined;
  /** Total observations counted when the last compaction ran. */
  readonly observationsAtLastCompaction: number;
  /**
   * Timestamp carried by the summary message `apply()` injects (PR-023).
   *
   * Optional and additive. It exists so a restored session rebuilds the exact
   * same provider-facing message rather than one with a fresh clock reading —
   * "reproduce the pre-restart context exactly" is a byte-level claim, and a
   * timestamp is part of the message.
   */
  readonly summaryTimestamp?: number;
  /**
   * Question records for turns after {@link boundaryIndex} (PR-023).
   *
   * Optional and additive. Not needed to reproduce the current context; needed
   * so the *next* compaction after a restart can still quote the user's own
   * words for turns that were live when the process died.
   */
  readonly questions?: readonly QuestionRecord[];
}

/**
 * Compaction state as a restart hands it back (PR-023).
 *
 * `boundaryIndex` indexes the **unmodified** transcript — compaction never
 * writes to `agent.state.messages` — so the transcript and the summary restore
 * independently and the index still means what it meant.
 */
export interface RestoredCompaction {
  readonly generation: number;
  readonly boundaryIndex: number;
  readonly summary: CompactionSummary;
  readonly observationsAtLastCompaction?: number;
  readonly summaryTimestamp?: number;
  readonly questions?: readonly QuestionRecord[];
}

export type CompactionOutcome =
  /** No trigger fired. */
  | { readonly kind: 'not-needed'; readonly decision: CompactionDecision }
  /**
   * A trigger fired but there was nothing older than the retained tail, so §11's
   * "last 6–10 text turns" won and nothing was folded. Deliberately not an
   * error: the correct response to "the window changed" three turns into a
   * conversation is to do nothing.
   */
  | { readonly kind: 'nothing-to-compact'; readonly decision: CompactionDecision }
  | {
      readonly kind: 'compacted';
      readonly decision: CompactionDecision;
      readonly summary: CompactionSummary;
      readonly tokensBefore: number;
      readonly tokensAfter: number;
    };

export interface CompactionControllerOptions {
  readonly contextWindow: number;
  readonly policy?: CompactionPolicy;
  /** The §10 image policy, shared with PR-022a's pruner. */
  readonly screenPolicy?: ScreenPolicy;
  /** Past-tense observation summaries. See `createObservationNotebook`. */
  readonly summaryFor?: ObservationSummaryLookup;
  /** Injected clock for the summary message's timestamp. */
  readonly now?: NowFn;
  /**
   * Applied to the folded context before triggers are evaluated, so "context
   * usage" measures what the provider would really receive. The session passes
   * PR-022a's pruner; the default is identity, which only over-estimates.
   */
  readonly prune?: (messages: readonly AgentMessage[]) => AgentMessage[];
  /**
   * Compaction state read back from durable storage (PR-023).
   *
   * The controller starts at that generation and boundary and rebuilds the
   * summary message from the persisted text, so the first provider request
   * after a restart is the one the last request before it would have been.
   */
  readonly restore?: RestoredCompaction;
}

export interface CompactionController {
  /** Record a question at the index its user message will occupy. */
  noteQuestion(envelope: QuestionEnvelope, messageIndex: number): void;
  /** Fold history if any §11 trigger fires. Safe to call on every turn boundary. */
  maybeCompact(messages: readonly AgentMessage[]): CompactionOutcome;
  /** Evaluate the triggers without acting. */
  evaluate(messages: readonly AgentMessage[]): CompactionDecision;
  /**
   * The provider-facing message list: history replaced by the summary, tail
   * intact. Never mutates its input, and is total — Pi's `transformContext`
   * contract forbids throwing.
   */
  apply(messages: readonly AgentMessage[]): AgentMessage[];
  readonly state: CompactionState;
  /**
   * The most recent {@link maybeCompact} result, including the triggers that
   * were evaluated and the estimate they were evaluated against.
   *
   * Diagnostics: PR-010's panel and the demo need to be able to say *why* a
   * compaction happened — or why one did not — and `context-compacted` carries
   * only the summary text.
   */
  readonly lastOutcome: CompactionOutcome | undefined;
  /**
   * Forget everything (PR-023, "clear conversation").
   *
   * Returns the controller to generation 0 with no summary and no recorded
   * questions, which is the only honest state once the transcript those
   * records quote has been deleted.
   */
  reset(): void;
}

const MAX_QUESTION_RECORDS = 512;

export function createCompactionController(
  options: CompactionControllerOptions,
): CompactionController {
  const policy = options.policy ?? DEFAULT_COMPACTION_POLICY;
  const now = options.now ?? SYSTEM_NOW;
  const prune = options.prune ?? ((messages: readonly AgentMessage[]) => [...messages]);

  let generation = 0;
  let boundaryIndex = 0;
  let summary: CompactionSummary | undefined;
  let summaryMessage: AgentMessage | undefined;
  let summaryTimestamp: number | undefined;
  let observationsAtLastCompaction = 0;
  let currentScene: SceneStampFacts | undefined;
  /** Transcript length at the last `nothing-to-compact`, to avoid re-deciding. */
  let gaveUpAt = -1;
  let lastOutcome: CompactionOutcome | undefined;
  const questions: QuestionRecord[] = [];

  /** Whose voice the folded history speaks in. Shared by fold and restore. */
  const renderSummaryMessage = (text: string, timestamp: number): AgentMessage => ({
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp,
  });

  if (options.restore !== undefined) {
    const restored = options.restore;
    generation = restored.generation;
    boundaryIndex = restored.boundaryIndex;
    summary = restored.summary;
    summaryTimestamp = restored.summaryTimestamp ?? now();
    summaryMessage = renderSummaryMessage(restored.summary.text, summaryTimestamp);
    observationsAtLastCompaction = restored.observationsAtLastCompaction ?? 0;
    questions.push(...(restored.questions ?? []));
  }

  const activeContextFor = (messages: readonly AgentMessage[]): AgentMessage[] =>
    prune(applyTo(messages));

  function applyTo(messages: readonly AgentMessage[]): AgentMessage[] {
    if (summaryMessage === undefined || boundaryIndex <= 0 || boundaryIndex > messages.length) {
      return [...messages];
    }
    return [summaryMessage, ...messages.slice(boundaryIndex)];
  }

  function decide(messages: readonly AgentMessage[]): CompactionDecision {
    return evaluateCompaction({
      messages,
      activeContext: activeContextFor(messages),
      contextWindow: options.contextWindow,
      observationsAtLastCompaction,
      boundaryIndex,
      policy,
      ...(currentScene === undefined ? {} : { currentSceneId: currentScene.sceneId }),
      ...(options.screenPolicy === undefined ? {} : { screenPolicy: options.screenPolicy }),
      ...(options.summaryFor === undefined ? {} : { summaryFor: options.summaryFor }),
    });
  }

  /**
   * Never lets a malformed message stop the run.
   *
   * The controller runs inside Pi's event handler, and `transformContext` calls
   * `apply`. A decision that throws would either fail a turn or leave the next
   * provider request with a context nobody chose. "Do not compact" is always a
   * safe answer; pruning still bounds the images.
   */
  function decideSafely(messages: readonly AgentMessage[]): CompactionDecision {
    try {
      return decide(messages);
    } catch {
      return {
        compact: false,
        triggers: [],
        newObservations: 0,
        usage: {
          tokens: 0,
          textTokens: 0,
          imageTokens: 0,
          images: 0,
          imageBytes: 0,
          contextWindow: Math.max(0, options.contextWindow),
          fraction: 0,
        },
        windowChange: { changed: false },
      };
    }
  }

  return {
    noteQuestion(envelope: QuestionEnvelope, messageIndex: number): void {
      currentScene = { sceneId: envelope.scene.id, sceneRevision: envelope.scene.revision };
      questions.push(toQuestionRecord(envelope, messageIndex));
      if (questions.length > MAX_QUESTION_RECORDS) {
        questions.splice(0, questions.length - MAX_QUESTION_RECORDS);
      }
    },

    evaluate: decideSafely,

    maybeCompact(messages: readonly AgentMessage[]): CompactionOutcome {
      lastOutcome = compactNow(messages);
      return lastOutcome;
    },

    apply(messages: readonly AgentMessage[]): AgentMessage[] {
      try {
        return applyTo(messages);
      } catch {
        return [...messages];
      }
    },

    get state(): CompactionState {
      return {
        generation,
        boundaryIndex,
        summary,
        observationsAtLastCompaction,
        ...(summaryTimestamp === undefined ? {} : { summaryTimestamp }),
        questions: [...questions],
      };
    },

    get lastOutcome(): CompactionOutcome | undefined {
      return lastOutcome;
    },

    reset(): void {
      generation = 0;
      boundaryIndex = 0;
      summary = undefined;
      summaryMessage = undefined;
      summaryTimestamp = undefined;
      observationsAtLastCompaction = 0;
      currentScene = undefined;
      gaveUpAt = -1;
      lastOutcome = undefined;
      questions.length = 0;
    },
  };

  function compactNow(messages: readonly AgentMessage[]): CompactionOutcome {
    const decision = decideSafely(messages);
    if (!decision.compact) {
      return { kind: 'not-needed', decision };
    }
    if (messages.length <= gaveUpAt) {
      return { kind: 'nothing-to-compact', decision };
    }
    const turnStarts = findTurnStarts(messages);
    const cut =
      turnStarts.length > policy.keepRecentTurns
        ? (turnStarts[turnStarts.length - policy.keepRecentTurns] ?? 0)
        : 0;
    if (cut <= boundaryIndex) {
      gaveUpAt = messages.length;
      return { kind: 'nothing-to-compact', decision };
    }

    const tokensBefore = decision.usage.tokens;
    let next: CompactionSummary;
    try {
      next = buildCompactionSummary({
        messages,
        from: boundaryIndex,
        to: cut,
        generation: generation + 1,
        policy,
        questions,
        ...(summary === undefined ? {} : { previous: summary }),
        ...(options.summaryFor === undefined ? {} : { summaryFor: options.summaryFor }),
        ...(currentScene === undefined ? {} : { currentScene }),
      });
    } catch {
      // A summary that could not be built is not folded. Nothing has moved:
      // the boundary, the generation and the previous summary are untouched,
      // so the next turn simply sees the full history again.
      gaveUpAt = messages.length;
      return { kind: 'nothing-to-compact', decision };
    }
    generation += 1;
    summary = next;
    boundaryIndex = cut;
    observationsAtLastCompaction = countVisualObservations(messages);
    gaveUpAt = -1;
    // A plain `user` message, and not Pi's own `CompactionSummaryMessage`.
    // VERIFIED trap: `Agent`'s default `convertToLlm` keeps only
    // `user | assistant | toolResult` (`pi-agent-core/dist/agent.js`), so a
    // `compactionSummary` message inserted through `transformContext` is
    // silently dropped and the model never sees the summary at all. The rich
    // converter that understands it lives in `harness/messages.js` and is not
    // exported from the package index. The header says whose voice this is.
    summaryTimestamp = now();
    summaryMessage = renderSummaryMessage(next.text, summaryTimestamp);
    const tokensAfter = estimateActiveContext(activeContextFor(messages), {
      contextWindow: options.contextWindow,
      imageTokenCost: policy.imageTokenCost,
      ...(options.screenPolicy === undefined ? {} : { policy: options.screenPolicy }),
      ...(options.summaryFor === undefined ? {} : { summaryFor: options.summaryFor }),
    }).tokens;
    // Records already folded into the summary text are no longer needed.
    const firstKept = questions.findIndex((question) => question.messageIndex >= cut);
    questions.splice(0, firstKept === -1 ? questions.length : firstKept);
    return { kind: 'compacted', decision, summary: next, tokensBefore, tokensAfter };
  }
}
