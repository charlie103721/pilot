/**
 * `@pilot/observation` — the observation core (system-design §6).
 *
 * Owner lane E3. This package holds observation *state* and nothing else:
 *
 * - {@link FrameRing} — bounded, memory-only frame ring (age + bytes + count).
 * - {@link PointerTimeline} — ~30 Hz pointer samples with coalescing.
 * - {@link SceneTracker} — scene identity and revision.
 * - {@link ObservationCore} — the three above plus one deterministic clear.
 * - {@link SceneLineage} — scene episodes, their revisions, and the check that
 *   refuses a superseded scene (PR-016).
 * - {@link ContentFingerprinter} — the "meaningful visual change" rule that
 *   feeds the content component of a scene revision (PR-016).
 * - {@link ObservationSession} — platform event ingest: frames, pointer and
 *   window lifecycle (PR-016).
 * - {@link resolveQuestionAnchor} — the grounding point for an utterance
 *   (PR-016).
 * - {@link DEFAULT_SCREEN_CONTEXT_POLICY} — the §10 screen policy as data, and
 *   {@link ScreenPolicyEnforcer}, which runs its seven-step execution order
 *   (PR-017).
 * - {@link RetentionGuard} — clear-on-pause/lock/window-loss/shutdown with a
 *   post-condition (PR-017).
 * - {@link ObservationRateLimiter} — the clock-driven observation rate limit.
 * - {@link ImageProcessor} — the PR-018 seam, plus a deterministic fake.
 * - Recorded fixtures for downstream lanes and the demos.
 *
 * Image processing (PR-018) and the `ScreenContextService` facade (PR-019)
 * build on this and are deliberately absent. Frames arrive through the
 * `ObservationAdapter` contract from `@pilot/platform`; this package never
 * captures anything itself.
 */
export * from './clock.js';
export * from './hashing.js';
export * from './frame-ring.js';
export * from './pointer-timeline.js';
export * from './scene-tracker.js';
export * from './scene-lineage.js';
export * from './content-fingerprint.js';
export * from './observation-core.js';
export * from './question-anchor.js';
export * from './observation-session.js';
export * from './screen-policy.js';
export * from './observation-rate.js';
export * from './retention.js';
export * from './secure-content.js';
export * from './image-pipeline.js';
export * from './policy-enforcer.js';
export * from './fixtures.js';
