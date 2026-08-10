/**
 * Deterministic, fixture-driven fakes for all five boundaries named in
 * `docs/implementation.md` PR-001 — platform, observation, agent, speech and
 * interaction — plus the `ScreenContextService` PR-021 builds against.
 *
 * Every fake implements the same public interface as the real implementation
 * will (delivery rule: "use fakes only behind the same public contract"). None
 * of them uses timers, randomness, the filesystem or the network: a fake only
 * moves when a test tells it to.
 */
export * from './support.js';
export * from './fixtures.js';
export * from './platform.js';
export * from './hotkey.js';
export * from './observation.js';
export * from './speech.js';
export * from './screen-context.js';
export * from './agent.js';
export * from './interaction.js';
