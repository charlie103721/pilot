/**
 * Minimal `Buffer` stand-in for Chromium-side bundles.
 *
 * `@pilot/shared` measures encoded envelope sizes with `Buffer.byteLength`.
 * That is the only member either Chromium-side bundle can reach, and
 * `TextEncoder` gives the identical UTF-8 byte count. Anything else on `Buffer`
 * is intentionally absent: main-process work does not belong in the renderer,
 * and a missing member should fail loudly rather than half-work.
 */
const encoder = new TextEncoder();

export const Buffer = {
  byteLength(value: string): number {
    return encoder.encode(value).length;
  },
};
