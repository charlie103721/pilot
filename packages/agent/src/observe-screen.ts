import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@earendil-works/pi-ai';
import type { ScreenContextService } from '@pilot/platform';
import {
  isPointerInsideWindow,
  observeScreenRequestSchema,
  type ScreenObservation,
} from '@pilot/shared';

/**
 * `observe_screen` as a Pi tool (system-design §9).
 *
 * VERIFIED shape of a Pi tool (`@earendil-works/pi-agent-core`
 * `dist/types.d.ts`, `interface AgentTool`):
 *   `{ name, label, description, parameters: TSchema, execute(toolCallId,
 *      params, signal?, onUpdate?): Promise<AgentToolResult<TDetails>> }`
 * Pi validates `params` against `parameters` before calling `execute`, and
 * converts a thrown error into an error tool result — tools must throw rather
 * than encode failure in `content`.
 *
 * VERIFIED image-result shape: an image is returned as a content block
 * `{ type: "image", data: <base64 without a data: prefix>, mimeType }`, and
 * lands on the transcript as a `toolResult` message whose `content` is
 * `(TextContent | ImageContent)[]`.
 *
 * PR-021 owns the production version. This one exists so the spike can prove
 * the round trip end to end against a faux provider.
 */

export const OBSERVE_SCREEN_TOOL_NAME = 'observe_screen';

export const observeScreenParameters = Type.Object(
  {
    view: Type.Union([Type.Literal('pointer'), Type.Literal('window'), Type.Literal('both')], {
      description:
        'pointer = crop around what the user is pointing at; window = the whole selected window; both = one of each.',
    }),
    moment: Type.Union(
      [Type.Literal('question'), Type.Literal('current'), Type.Literal('before-and-after')],
      {
        description:
          'question = the frame closest to when the user asked; current = a fresh capture; before-and-after = both, for comparisons.',
      },
    ),
  },
  { additionalProperties: false },
);

export type ObserveScreenParameters = Static<typeof observeScreenParameters>;

/** Details Pi carries on the tool-result message for UI and audit. Never sent to the model. */
export interface ObserveScreenDetails {
  readonly observationId: string;
  readonly sceneId: string;
  readonly sceneRevision: number;
  readonly capturedAt: number;
  readonly imageCount: number;
}

/**
 * Text the model reads alongside the pixels.
 *
 * mvp-01 §8: when the pointer fell outside the selected window the model must
 * be told so rather than handed an invented target.
 */
export function describeObservation(observation: ScreenObservation): string {
  const lines: string[] = [
    `Window: ${observation.windowTitle}`,
    `Scene ${observation.sceneId} revision ${String(observation.sceneRevision)}`,
  ];
  const inside = isPointerInsideWindow({
    screenPoint: { x: 0, y: 0 },
    normalizedPoint: observation.pointer,
  });
  if (!inside) {
    lines.push('Pointer: outside the selected window. Do not guess what it is over.');
  } else {
    lines.push(
      `Pointer: ${observation.pointer.x.toFixed(3)}, ${observation.pointer.y.toFixed(3)} (window-relative)`,
    );
    const target = observation.target;
    if (target !== undefined) {
      const parts = [target.role, target.label].filter((part) => part !== undefined);
      lines.push(
        `Element under pointer: ${parts.length > 0 ? parts.join(' — ') : 'unlabelled'}${
          target.isSecure ? ' (secure field, contents withheld)' : ''
        }`,
      );
    }
  }
  lines.push(
    observation.images.length === 0
      ? 'No image is attached to this observation.'
      : `Attached images: ${observation.images.map((image) => image.purpose).join(', ')}.`,
  );
  return lines.join('\n');
}

export interface ObserveScreenToolOptions {
  readonly screenContext: ScreenContextService;
  /** Called after each successful observation, e.g. to record scene metadata. */
  readonly onObservation?: (observation: ScreenObservation) => void;
}

export function createObserveScreenTool(
  options: ObserveScreenToolOptions,
): AgentTool<typeof observeScreenParameters, ObserveScreenDetails> {
  return {
    name: OBSERVE_SCREEN_TOOL_NAME,
    label: 'Look at the screen',
    description:
      'Look at the window the user selected. Call this whenever answering depends on what is ' +
      'currently visible, or when your last observation may be stale. Returns a short text ' +
      'description plus one or more images.',
    parameters: observeScreenParameters,
    async execute(
      _toolCallId: string,
      params: ObserveScreenParameters,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<ObserveScreenDetails>> {
      // Re-parse: Pi validates against the TypeBox schema, Pilot validates
      // against its own contract so the two cannot drift silently.
      const request = observeScreenRequestSchema.parse(params);
      const observation = await options.screenContext.observe(request, signal);
      options.onObservation?.(observation);
      return {
        content: [
          { type: 'text', text: describeObservation(observation) },
          ...observation.images.map((image) => ({
            type: 'image' as const,
            data: image.base64,
            mimeType: image.mimeType,
          })),
        ],
        details: {
          observationId: observation.observationId,
          sceneId: observation.sceneId,
          sceneRevision: observation.sceneRevision,
          capturedAt: observation.capturedAt,
          imageCount: observation.images.length,
        },
      };
    },
  };
}
