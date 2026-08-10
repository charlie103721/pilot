import type { z } from 'zod';

/**
 * The shape of one helper operation, and the constructor for it.
 *
 * PR-003 defined these inside `operations.ts`. PR-011 moved them here
 * unchanged so the per-feature operation modules (`permission-ops.ts`,
 * `window-ops.ts`) can build on them without importing the registry that
 * collects them — which would be a cycle. `operations.ts` re-exports
 * everything below, so every PR-003 import path still resolves.
 */

export interface HelperOperation<Request, Response> {
  readonly name: string;
  readonly request: z.ZodType<Request>;
  readonly response: z.ZodType<Response>;
  /** Whether a request for this operation may attach a binary payload. */
  readonly requestBinary: boolean;
  /** Whether a response for this operation may attach a binary payload. */
  readonly responseBinary: boolean;
}

export function defineHelperOperation<Request, Response>(
  operation: HelperOperation<Request, Response>,
): HelperOperation<Request, Response> {
  return operation;
}

export type HelperOperationRequest<O> = O extends HelperOperation<infer R, unknown> ? R : never;
export type HelperOperationResponse<O> = O extends HelperOperation<unknown, infer R> ? R : never;
