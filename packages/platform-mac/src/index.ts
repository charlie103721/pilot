/**
 * macOS platform package.
 *
 * PR-003 delivers the transport only: the framed stdio protocol shared with
 * the embedded Swift helper, and the supervision that keeps that helper alive.
 * Screen capture, Accessibility, permissions and speech arrive from PR-011
 * onward and will be built on top of these primitives.
 */
export * from './helper-binary.js';
export * from './protocol/frame.js';
export * from './protocol/messages.js';
export * from './protocol/operations.js';
export * from './transport/channel.js';
export * from './transport/emitter.js';
export * from './transport/helper-transport.js';
