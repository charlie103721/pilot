/**
 * macOS platform package.
 *
 * PR-003 delivered the transport: the framed stdio protocol shared with the
 * embedded Swift helper, and the supervision that keeps that helper alive.
 * PR-011 adds the first two adapters built on it — permissions (with parent
 * bundle attribution validation) and window enumeration with lifecycle events.
 * PR-014 adds speech: Apple Speech transcription with an on-device preference
 * and a renderable privacy disclosure, and `AVSpeechSynthesizer` playback with
 * prompt interruption. Capture and Accessibility grounding arrive in PR-012
 * and PR-013, push-to-talk in PR-015.
 *
 * **Nothing under `native/` has ever been compiled** (runbook amendment 8).
 * The TypeScript here is exercised end to end against `test/support/
 * helper-stub.ts`; the Swift is not.
 */
export * from './helper-binary.js';
export * from './polling.js';
export * from './protocol/frame.js';
export * from './protocol/messages.js';
export * from './protocol/operation-kit.js';
export * from './protocol/operations.js';
export * from './protocol/permission-ops.js';
export * from './protocol/speech-ops.js';
export * from './protocol/window-ops.js';
export * from './permissions/attribution.js';
export * from './permissions/mac-permission-adapter.js';
export * from './speech/disclosure.js';
export * from './speech/errors.js';
export * from './speech/mac-speech-input-adapter.js';
export * from './speech/mac-speech-output-adapter.js';
export * from './transport/channel.js';
export * from './transport/emitter.js';
export * from './transport/helper-transport.js';
export * from './windows/mac-window-adapter.js';
export * from './windows/window-diff.js';
export * from './windows/window-model.js';
