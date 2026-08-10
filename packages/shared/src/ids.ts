import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Branded identifier types.
 *
 * Every identifier is a `string` at runtime, so any value declared here still
 * satisfies the plain `string` fields used in `docs/system-design.md`. The
 * brand exists so a `SceneId` cannot be passed where an `ObservationId` is
 * expected. Values arriving over IPC must be parsed with the matching schema
 * rather than cast.
 */

export const ID_MAX_LENGTH = 200;

const rawId = z.string().min(1).max(ID_MAX_LENGTH);

export const conversationIdSchema = rawId.brand<'ConversationId'>();
export const utteranceIdSchema = rawId.brand<'UtteranceId'>();
export const sceneIdSchema = rawId.brand<'SceneId'>();
export const observationIdSchema = rawId.brand<'ObservationId'>();
export const frameIdSchema = rawId.brand<'FrameId'>();
export const windowIdSchema = rawId.brand<'WindowId'>();
export const displayIdSchema = rawId.brand<'DisplayId'>();
export const runIdSchema = rawId.brand<'RunId'>();
export const toolCallIdSchema = rawId.brand<'ToolCallId'>();
export const speechIdSchema = rawId.brand<'SpeechId'>();
export const requestIdSchema = rawId.brand<'RequestId'>();
export const modelProfileIdSchema = rawId.brand<'ModelProfileId'>();
export const credentialRefSchema = rawId.brand<'CredentialRef'>();

export type ConversationId = z.infer<typeof conversationIdSchema>;
export type UtteranceId = z.infer<typeof utteranceIdSchema>;
export type SceneId = z.infer<typeof sceneIdSchema>;
export type ObservationId = z.infer<typeof observationIdSchema>;
export type FrameId = z.infer<typeof frameIdSchema>;
export type WindowId = z.infer<typeof windowIdSchema>;
export type DisplayId = z.infer<typeof displayIdSchema>;
export type RunId = z.infer<typeof runIdSchema>;
export type ToolCallId = z.infer<typeof toolCallIdSchema>;
export type SpeechId = z.infer<typeof speechIdSchema>;
export type RequestId = z.infer<typeof requestIdSchema>;
export type ModelProfileId = z.infer<typeof modelProfileIdSchema>;
export type CredentialRef = z.infer<typeof credentialRefSchema>;

/** Any branded identifier defined by this module. */
export type PilotId =
  | ConversationId
  | UtteranceId
  | SceneId
  | ObservationId
  | FrameId
  | WindowId
  | DisplayId
  | RunId
  | ToolCallId
  | SpeechId
  | RequestId
  | ModelProfileId
  | CredentialRef;

export const asConversationId = (value: string): ConversationId =>
  conversationIdSchema.parse(value);
export const asUtteranceId = (value: string): UtteranceId => utteranceIdSchema.parse(value);
export const asSceneId = (value: string): SceneId => sceneIdSchema.parse(value);
export const asObservationId = (value: string): ObservationId => observationIdSchema.parse(value);
export const asFrameId = (value: string): FrameId => frameIdSchema.parse(value);
export const asWindowId = (value: string): WindowId => windowIdSchema.parse(value);
export const asDisplayId = (value: string): DisplayId => displayIdSchema.parse(value);
export const asRunId = (value: string): RunId => runIdSchema.parse(value);
export const asToolCallId = (value: string): ToolCallId => toolCallIdSchema.parse(value);
export const asSpeechId = (value: string): SpeechId => speechIdSchema.parse(value);
export const asRequestId = (value: string): RequestId => requestIdSchema.parse(value);
export const asModelProfileId = (value: string): ModelProfileId =>
  modelProfileIdSchema.parse(value);
export const asCredentialRef = (value: string): CredentialRef => credentialRefSchema.parse(value);

/**
 * Source of raw identifier strings. Production code uses the random source;
 * fakes and tests use the counter source so runs are reproducible.
 */
export interface IdSource {
  next(prefix: string): string;
}

export function createRandomIdSource(): IdSource {
  return {
    next(prefix: string): string {
      return `${prefix}-${randomUUID()}`;
    },
  };
}

export function createCounterIdSource(start = 0): IdSource {
  const counters = new Map<string, number>();
  return {
    next(prefix: string): string {
      const nextValue = (counters.get(prefix) ?? start) + 1;
      counters.set(prefix, nextValue);
      return `${prefix}-${String(nextValue).padStart(6, '0')}`;
    },
  };
}

export interface IdFactory {
  conversation(): ConversationId;
  utterance(): UtteranceId;
  scene(): SceneId;
  observation(): ObservationId;
  frame(): FrameId;
  run(): RunId;
  toolCall(): ToolCallId;
  speech(): SpeechId;
  request(): RequestId;
}

export function createIdFactory(source: IdSource = createRandomIdSource()): IdFactory {
  return {
    conversation: () => asConversationId(source.next('conv')),
    utterance: () => asUtteranceId(source.next('utt')),
    scene: () => asSceneId(source.next('scene')),
    observation: () => asObservationId(source.next('obs')),
    frame: () => asFrameId(source.next('frame')),
    run: () => asRunId(source.next('run')),
    toolCall: () => asToolCallId(source.next('tool')),
    speech: () => asSpeechId(source.next('speech')),
    request: () => asRequestId(source.next('req')),
  };
}
