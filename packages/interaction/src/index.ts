/**
 * `@pilot/interaction` — the voice interaction state machine (PR-006).
 *
 * `docs/system-design.md` §7 draws the loop and §15 fixes the concurrency
 * rules; `docs/mvp-01-point-ask-hear.md` §7 fixes the state names. This package
 * turns both into one pure, table-driven machine plus a thin controller that
 * performs its effects.
 *
 * What it owns: states, commands, events, the transition table, utterance
 * identity, stale-result rejection and interruption.
 *
 * What it deliberately does not own: envelope construction (PR-024), the
 * push-to-talk/STT wiring (PR-025), sentence buffering into TTS (PR-026), the
 * end-to-end interruption integration (PR-027), and real STT/TTS (PR-014).
 * Each of those is a port with a fake behind it.
 */
export * from './inputs.js';
export * from './effects.js';
export * from './rejection.js';
export * from './context.js';
export * from './table.js';
export * from './machine.js';
export * from './ports.js';
export * from './fakes.js';
export * from './controller.js';
