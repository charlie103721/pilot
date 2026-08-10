import {
  createIdFactory,
  createRandomIdSource,
  type ConversationId,
  type IdFactory,
  type IdSource,
  type InteractionState,
  type ObservedWindow,
  type PermissionKind,
  type PermissionSnapshot,
} from '@pilot/shared';
import type { PilotViewState } from '@pilot/platform';
import type { InteractionEffect } from './effects.js';
import type { InteractionInput } from './inputs.js';
import {
  REQUIRED_PERMISSIONS,
  createInteractionContext,
  toViewState,
  type InteractionContext,
} from './context.js';
import {
  isStaleRejection,
  rejectionError,
  type InteractionRejection,
  type TransitionRejectionReason,
} from './rejection.js';
import { lookupRule, resolveTarget, type TransitionEnv } from './table.js';

/** Injected time source. `FakeClock` from `@pilot/platform/fakes` satisfies it. */
export interface Clock {
  now(): number;
}

export type TransitionOutcome =
  | {
      readonly kind: 'accepted';
      readonly from: InteractionState;
      readonly to: InteractionState;
      readonly input: InteractionInput;
      readonly effects: readonly InteractionEffect[];
      readonly context: InteractionContext;
    }
  | {
      readonly kind: 'rejected';
      readonly from: InteractionState;
      readonly input: InteractionInput;
      readonly rejection: InteractionRejection;
      readonly context: InteractionContext;
    };

export interface InteractionMachineOptions {
  readonly clock: Clock;
  /** Deterministic in tests (`createCounterIdSource()`), random in production. */
  readonly idSource?: IdSource;
  readonly ids?: IdFactory;
  readonly conversationId?: ConversationId;
  readonly permissions?: PermissionSnapshot | null;
  readonly windows?: readonly ObservedWindow[];
  readonly selectedWindow?: ObservedWindow | null;
  readonly requiredPermissions?: readonly PermissionKind[];
}

/**
 * Identity check, applied before the transition table.
 *
 * system-design §15: "Results from stale window selections, scene IDs, or
 * utterance IDs are discarded." Because this runs first, a superseded result
 * can never reach a transition rule, and therefore can never produce an effect
 * — which is what makes "late events from the old run cannot resurface output"
 * a property of the machine rather than a habit of its callers.
 */
export function staleReason(
  context: InteractionContext,
  input: InteractionInput,
): TransitionRejectionReason | null {
  switch (input.type) {
    case 'transcript-partial':
    case 'transcript-failed':
      return input.utteranceId === context.activeUtteranceId ? null : 'stale-utterance';
    case 'transcript-final':
      if (input.utteranceId !== context.activeUtteranceId) {
        return 'stale-utterance';
      }
      return context.finalizedUtteranceId === input.utteranceId ? 'duplicate-transcript' : null;
    case 'run-started':
      return input.utteranceId === context.activeUtteranceId ? null : 'stale-utterance';
    case 'run-text-delta':
    case 'tool-started':
    case 'tool-finished':
    case 'run-completed':
    case 'run-aborted':
    case 'run-failed':
      return input.runId === context.activeRunId ? null : 'stale-run';
    case 'speech-started':
    case 'speech-finished':
    case 'speech-stopped':
    case 'speech-failed':
      return input.speechId === context.activeSpeechId ? null : 'stale-speech';
    case 'observation-finished':
      return input.observationId === context.activeObservationId ? null : 'stale-observation';
    case 'window-closed':
      return input.windowId === context.selectedWindow?.windowId ? null : 'stale-window';
    default:
      return null;
  }
}

/**
 * The interaction state machine.
 *
 * Pure and synchronous: `send()` applies one input and returns what happened,
 * including the effects the caller must perform. It owns no adapters, no
 * timers and no ambient time or randomness — the clock and the identifier
 * source are injected, so a whole conversation replays identically.
 */
export class InteractionMachine {
  readonly #clock: Clock;
  readonly #ids: IdFactory;
  readonly #required: readonly PermissionKind[];
  #context: InteractionContext;

  constructor(options: InteractionMachineOptions) {
    this.#clock = options.clock;
    this.#ids = options.ids ?? createIdFactory(options.idSource ?? createRandomIdSource());
    this.#required = options.requiredPermissions ?? REQUIRED_PERMISSIONS;
    this.#context = createInteractionContext({
      conversationId: options.conversationId ?? this.#ids.conversation(),
      now: this.#clock.now(),
      permissions: options.permissions ?? null,
      ...(options.windows === undefined ? {} : { windows: options.windows }),
      ...(options.selectedWindow === undefined ? {} : { selectedWindow: options.selectedWindow }),
    });
  }

  get context(): InteractionContext {
    return this.#context;
  }

  get state(): InteractionState {
    return this.#context.state;
  }

  get viewState(): PilotViewState {
    return toViewState(this.#context);
  }

  get requiredPermissions(): readonly PermissionKind[] {
    return this.#required;
  }

  send(input: InteractionInput): TransitionOutcome {
    const from = this.#context.state;

    const stale = staleReason(this.#context, input);
    if (stale !== null) {
      return this.#reject(stale, from, input);
    }

    const rule = lookupRule(from, input.type);
    if (rule.kind === 'reject') {
      return this.#reject(rule.reason, from, input);
    }

    const env: TransitionEnv = {
      ids: this.#ids,
      now: this.#clock.now(),
      required: this.#required,
    };
    const application = rule.apply(this.#context, input, env);
    if (application === undefined) {
      // A rule was asked about an input it does not model. Never silent.
      return this.#reject('illegal-transition', from, input);
    }
    if ('reject' in application) {
      return this.#reject(application.reject, from, input);
    }

    const patched: InteractionContext = { ...this.#context, ...application.patch };
    const to = resolveTarget(application.to, patched, this.#required);
    this.#context = { ...patched, state: to, updatedAt: env.now };

    return {
      kind: 'accepted',
      from,
      to,
      input,
      effects: application.effects ?? [],
      context: this.#context,
    };
  }

  #reject(
    reason: TransitionRejectionReason,
    from: InteractionState,
    input: InteractionInput,
  ): TransitionOutcome {
    const at = this.#clock.now();
    const error = rejectionError(reason, from, input.type);
    // A discarded stale result is hygiene, not a user-facing failure, so it is
    // reported through the outcome and the rejection stream but never written
    // to `lastError`. Everything else the user can see and act on.
    this.#context = isStaleRejection(reason)
      ? { ...this.#context, updatedAt: at }
      : { ...this.#context, lastError: error.toJSON(), updatedAt: at };
    return {
      kind: 'rejected',
      from,
      input,
      rejection: { reason, from, input: input.type, at, error },
      context: this.#context,
    };
  }
}
