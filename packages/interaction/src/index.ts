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
 * PR-026 adds the response and TTS buffer: `segmentSpeech` decides when a
 * streamed fragment is speakable, the machine drains completed sentences into
 * `speak` effects under one stream id, and `SpeechOutputBinding` plays them in
 * order and reports one completion for the whole answer.
 *
 * PR-027 closes the loop with interruption and cancellation (system-design
 * §15): cancellation effects are performed on their own queue so stopping
 * speech never waits for work in front of it (§17, under 300 ms), every
 * question submission and screen observation carries an `AbortSignal` that is
 * fired the moment Pilot stops waiting for it, and a stalled answer can be
 * woken by an injected `Scheduler` — the only delay in the lane, and still not
 * a timer the machine owns.
 *
 * What it deliberately does not own: real STT/TTS (PR-014) and the cross-process
 * wiring to a live Pi session (PR-035). Each of those is a port with a fake
 * behind it.
 */
export * from './inputs.js';
export * from './effects.js';
export * from './rejection.js';
export * from './context.js';
export * from './segmentation.js';
export * from './scheduler.js';
export * from './table.js';
export * from './machine.js';
export * from './ports.js';
export * from './voice-diagnostics.js';
export * from './speech-binding.js';
export * from './speech-output-binding.js';
export * from './envelope.js';
export * from './recordings.js';
export * from './fakes.js';
export * from './controller.js';
