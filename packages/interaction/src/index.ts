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
 * PR-024 adds the question envelope on top: `PilotQuestionEnvelopeFactory`
 * turns an accepted utterance plus the recorded pointer timeline into the
 * text-and-metadata envelope of system-design §8, anchored by §6.
 *
 * PR-025 binds the machine's speech effects to `SpeechInputAdapter`:
 * `SpeechInputBinding` turns `start`/`stop`/`cancel-listening` into adapter
 * calls and adapter callbacks back into machine events, enforcing "exactly one
 * active utterance" (§15) at the adapter layer as well as in the machine, and
 * making the typed fallback of §16 reach the same submission path as speech.
 *
 * What it deliberately does not own: sentence buffering into TTS (PR-026), the
 * end-to-end interruption integration (PR-027), and real STT/TTS (PR-014). Each
 * of those is a port with a fake behind it.
 */
export * from './inputs.js';
export * from './effects.js';
export * from './rejection.js';
export * from './context.js';
export * from './table.js';
export * from './machine.js';
export * from './ports.js';
export * from './speech-binding.js';
export * from './envelope.js';
export * from './recordings.js';
export * from './fakes.js';
export * from './controller.js';
