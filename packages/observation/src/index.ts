/**
 * `@pilot/observation` — the observation core (system-design §6).
 *
 * Owner lane E3. This package holds observation *state* and nothing else:
 *
 * - {@link FrameRing} — bounded, memory-only frame ring (age + bytes + count).
 * - {@link PointerTimeline} — ~30 Hz pointer samples with coalescing.
 * - {@link SceneTracker} — scene identity and revision.
 * - {@link ObservationCore} — the three above plus one deterministic clear.
 * - Recorded fixtures for downstream lanes and the demo.
 *
 * Screen policy enforcement (PR-017), image processing (PR-018) and the
 * `ScreenContextService` facade (PR-019) build on this and are deliberately
 * absent. Frames arrive through the `ObservationAdapter` contract from
 * `@pilot/platform`; this package never captures anything itself.
 */
export * from './clock.js';
export * from './frame-ring.js';
export * from './pointer-timeline.js';
export * from './scene-tracker.js';
export * from './observation-core.js';
export * from './fixtures.js';
