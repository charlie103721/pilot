import type {
  ConversationId,
  ObservationId,
  ObservedWindow,
  QuestionEnvelope,
  UtteranceId,
} from '@pilot/shared';

/**
 * Boundaries PR-006 deliberately does not implement.
 *
 * The state machine decides *when* a question is built and *when* the screen is
 * observed; it never decides *what* goes into the envelope or how a frame is
 * chosen. Those belong to PR-024 (question envelope) and PR-019/PR-030 (screen
 * context). Both are expressed here as ports so the machine runs standalone
 * against the fakes in `./fakes.ts` and the real implementations drop in
 * without touching the table.
 */

export interface QuestionEnvelopeRequest {
  readonly utteranceId: UtteranceId;
  readonly conversationId: ConversationId;
  readonly transcript: string;
  readonly selectedWindow: ObservedWindow | null;
}

/** PR-024 replaces the fake implementation of this. */
export interface QuestionEnvelopeFactory {
  create(request: QuestionEnvelopeRequest): Promise<QuestionEnvelope>;
}

/**
 * Capture lifecycle the machine drives. PR-025 wires this to the real
 * `ObservationAdapter` / `ScreenContextService`; PR-030 makes `observe()`
 * perform a real "Look now".
 */
export interface ObservationControlPort {
  start(window: ObservedWindow): Promise<void>;
  stop(): Promise<void>;
  /** Drop every retained frame (system-design §11). */
  clear(): Promise<void>;
  /** User-requested observation. Resolves when the observation is done. */
  observe(observationId: ObservationId): Promise<void>;
}
