import type { ObserveScreenRequest, ScreenObservation, ScreenStatus } from '@pilot/shared';

/**
 * Screen context service (system-design §5), verbatim.
 *
 * Producer: `packages/observation` (PR-019). Consumer: `packages/agent-runtime`
 * (PR-021, the `observe_screen` tool). This is the only way the agent runtime
 * may reach screen state; it never touches capture or accessibility adapters.
 *
 * `observe` rejects with a `PilotError` carrying a user-explainable code
 * (`observation-paused`, `permission-denied`, `scene-mismatch`,
 * `protected-content`, `rate-limited`, `cancelled`, …) rather than returning a
 * partial observation. It must honour `signal`.
 */
export interface ScreenContextService {
  status(): ScreenStatus;
  observe(request: ObserveScreenRequest, signal?: AbortSignal): Promise<ScreenObservation>;
  clear(): void;
}
