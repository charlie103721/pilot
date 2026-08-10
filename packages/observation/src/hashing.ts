/**
 * Small non-cryptographic hashes shared by the scene tracker and the content
 * fingerprinter.
 *
 * Nothing here is a security primitive. These hashes only have to be stable
 * across processes and cheap enough to run on every captured frame.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a, 32-bit, over a string's UTF-16 code units. */
export function fnv1a32(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * FNV-1a, 32-bit, over a byte range. Returns the raw number so callers can
 * keep sets of chunk hashes without allocating strings.
 */
export function fnv1a32Bytes(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = start; index < end; index += 1) {
    hash ^= bytes[index] ?? 0;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** Folds one more value into a running 32-bit FNV-1a state. */
export function mixNumber(hash: number, value: number): number {
  let next = hash;
  let remaining = Math.trunc(value);
  for (let byte = 0; byte < 6; byte += 1) {
    next ^= remaining & 0xff;
    next = Math.imul(next, FNV_PRIME) >>> 0;
    remaining = Math.floor(remaining / 256);
  }
  return next >>> 0;
}

export function toHex32(hash: number): string {
  return (hash >>> 0).toString(16).padStart(8, '0');
}
