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
 * - {@link ImageProcessor} — the image-pipeline seam, plus a deterministic fake.
 * - {@link PilotImageProcessor} — §10 step 5: redact, crop, annotate, resize and
 *   encode, with cancellation and no native image dependency (PR-018).
 * - {@link createDefaultFrameCodec} — PNG through `node:zlib`, JPEG through
 *   `jpeg-js`, BGRA through a channel swap; injectable, so a faster codec can
 *   be substituted without touching a caller.
 * - Recorded fixtures for downstream lanes and the demos, and synthetic
 *   *screenshots* that really encode and decode ({@link renderSyntheticScreen}).
 *
 * - {@link PilotScreenContextService} — the `ScreenContextService` of
 *   system-design §5: `question` / `current` / `before-and-after` selection,
 *   lineage validation, an abortable fresh capture, typed errors from PR-017's
 *   rule table and compact content-free metadata (PR-019).
 *
 * Frames arrive through the `ObservationAdapter` contract from
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
export * from './screen-policy.js';
export * from './observation-rate.js';
export * from './retention.js';
export * from './secure-content.js';
export * from './image-pipeline.js';
export * from './pixel-buffer.js';
export * from './image-codec.js';
export * from './image-processor.js';
export * from './image-fixtures.js';
export * from './policy-enforcer.js';
export * from './screen-context.js';
export * from './fixtures.js';
