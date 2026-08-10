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
 * - Recorded fixtures for downstream lanes and the demos.
 *
 * Screen policy enforcement (PR-017), image processing (PR-018) and the
 * `ScreenContextService` facade (PR-019) build on this and are deliberately
 * absent. Frames arrive through the `ObservationAdapter` contract from
 * `@pilot/platform`; this package never captures anything itself.
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
export * from './fixtures.js';
