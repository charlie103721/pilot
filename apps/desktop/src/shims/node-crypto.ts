/**
 * Browser-side stand-in for `node:crypto`.
 *
 * `@pilot/shared` imports `randomUUID` at module scope for its id factory. Both
 * the renderer and the sandboxed preload run in Chromium processes with no Node
 * built-ins — a sandboxed preload has no `require('node:crypto')` at all — so
 * the bundler rewrites that import to this module. `crypto.randomUUID` is the
 * same primitive with the same guarantees, so nothing is weakened.
 */
export function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
  return globalThis.crypto.randomUUID();
}
