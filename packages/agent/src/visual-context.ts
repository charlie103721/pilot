import type { ImageContent, Message, TextContent } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

/**
 * Visual context transformation (system-design §11).
 *
 * Two distinct jobs, both of which Pilot has to do itself because Pi does
 * neither automatically:
 *
 *  1. {@link pruneVisualContext} — what the *model* sees. Wired into Pi as
 *     `AgentOptions.transformContext`, which runs on every provider request
 *     and does not mutate the agent transcript. VERIFIED: with a faux
 *     provider, the context handed to the provider contained the replacement
 *     text while `agent.state.messages` still held the original image block.
 *
 *  2. {@link stripImageBlocks} — what *disk* sees. Applied before
 *     `Session.appendMessage`. VERIFIED necessary: Pi's session storage JSON
 *     -serializes the message verbatim, base64 and all.
 */

/** A message content block, as Pi models them. */
type ContentBlock = TextContent | ImageContent;

/** Text that replaces an image block once it is no longer the active frame. */
export interface ObservationPlaceholder {
  readonly sceneId: string;
  readonly sceneRevision: number;
  /** One-line truthful summary. Must not claim the old screen is still current. */
  readonly summary: string;
}

/** Renders the replacement record from system-design §11, verbatim in shape. */
export function renderObservationPlaceholder(placeholder: ObservationPlaceholder): string {
  return `[Observation ${placeholder.sceneId}/revision-${String(placeholder.sceneRevision)} removed. ${placeholder.summary}]`;
}

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

export interface PruneOptions {
  /**
   * How many image blocks to keep, counted from the end of the transcript.
   * system-design §11 wants "latest relevant full frame" plus "latest relevant
   * pointer crop", and a second frame only for an active comparison.
   */
  readonly keepMostRecent: number;
  /** Placeholder text for each replaced image. Defaults to a generic record. */
  readonly placeholderFor?: (message: AgentMessage, index: number) => string;
}

const DEFAULT_PLACEHOLDER = '[Earlier screen observation removed. It may no longer be current.]';

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

  const placeholderFor = options.placeholderFor ?? (() => DEFAULT_PLACEHOLDER);

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
