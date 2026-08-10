/**
 * macOS platform package.
 *
 * PR-003 delivered the transport: the framed stdio protocol shared with the
 * embedded Swift helper, and the supervision that keeps that helper alive.
 * PR-011 adds the first two adapters built on it — permissions (with parent
 * bundle attribution validation) and window enumeration with lifecycle events.
 * PR-015 adds the third: the global push-to-talk hotkey, a configurable
 * `CGEventTap` that hears the key while Pilot is not focused, and the only
 * subsystem for which the helper pushes unsolicited events. Capture,
 * Accessibility grounding and speech arrive in PR-012…PR-014.
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
export * from './protocol/hotkey-ops.js';
export * from './hotkey/coalescer.js';
export * from './hotkey/mac-hotkey-adapter.js';
export * from './permissions/attribution.js';
export * from './permissions/mac-permission-adapter.js';
export * from './transport/channel.js';
export * from './transport/emitter.js';
export * from './transport/helper-transport.js';
export * from './windows/mac-window-adapter.js';
export * from './windows/window-diff.js';
export * from './windows/window-model.js';
