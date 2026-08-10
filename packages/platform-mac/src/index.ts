/**
 * macOS platform package.
 *
 * PR-003 delivered the transport: the framed stdio protocol shared with the
 * embedded Swift helper, and the supervision that keeps that helper alive.
 * PR-011 adds the first two adapters built on it — permissions (with parent
 * bundle attribution validation) and window enumeration with lifecycle events.
 * Capture, Accessibility grounding, speech and push-to-talk arrive in
 * PR-012…PR-015.
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
export * from './protocol/window-ops.js';
export * from './permissions/attribution.js';
export * from './permissions/mac-permission-adapter.js';
export * from './transport/channel.js';
export * from './transport/emitter.js';
export * from './transport/helper-transport.js';
export * from './windows/mac-window-adapter.js';
export * from './windows/window-diff.js';
export * from './windows/window-model.js';
