import { deflate, inflate, constants as zlibConstants } from 'node:zlib';
import { decode as decodeJpegPayload, encode as encodeJpegPayload } from 'jpeg-js';
import {
  PilotError,
  type FrameEncoding,
  type ObservationImage,
  type PixelSize,
} from '@pilot/shared';
import { createPixelBuffer, pixelBufferFrom, type PixelBuffer } from './pixel-buffer.js';

/**
 * Frame codecs (PR-018).
 *
 * ## Why there is no native image dependency here
 *
 * `docs/handoff.md` §5 records **`sharp` prebuilds inside packaged Electron
 * (arm64)** as an open risk, and PR-018 is the PR that would have taken it on.
 * It does not. The codecs below are:
 *
 * - **PNG** — Node's own `node:zlib`. Native C, already in the runtime, nothing
 *   to prebuild, and *asynchronous*: `zlib.deflate` runs on the libuv thread
 *   pool, so the process that hosts the pipeline never blocks on it
 *   (system-design §17, mvp-01 §10 "the encoder must run off the Electron
 *   renderer and must not block UI updates").
 * - **JPEG** — `jpeg-js@0.4.4`: pure JavaScript, BSD-3-Clause, zero
 *   dependencies, no binaries and no install scripts. It bundles and packages
 *   like any other JS file on every architecture.
 * - **BGRA** — a channel swap; no codec at all.
 *
 * The tradeoff, stated plainly: **pure-JS JPEG is slow.** Measured on the Linux
 * development machine, a 1440×900 frame costs ~130–250 ms to *decode* and
 * ~100–190 ms to *encode* in `jpeg-js`, against a 150 ms budget for the whole
 * observation (§17), while the same image costs ~4 ms to decode and ~5–15 ms to
 * encode as PNG through `zlib`. `sharp` would be roughly an order of magnitude
 * faster than `jpeg-js` and would also make the arm64 prebuild risk real. The
 * pipeline is therefore built to *avoid the JPEG path* rather than to make it
 * fast — see `image-processor.ts` for the pass-through and encoding-selection
 * rules — and {@link FrameCodec} is an interface so a WASM or native codec can
 * be injected later without touching a single caller.
 *
 * ## What the seam is for
 *
 * If PR-043 shows the pure-JS decode is the latency the user feels, the fix is
 * to pass a different {@link FrameCodec} into `PilotImageProcessor`. The
 * cheapest fix of all costs nothing here: **have capture hand over `bgra` or
 * `png` frames** (PR-012). That removes the JPEG decode *and* the double-JPEG
 * generation loss in one move.
 */

export type EncodedMimeType = ObservationImage['mimeType'];

export interface FrameCodec {
  /** Decodes an encoded (or raw `bgra`) payload into RGBA pixels. */
  decode(bytes: Uint8Array, encoding: FrameEncoding, declaredSize: PixelSize): Promise<PixelBuffer>;
  /** Reads the real pixel size out of an encoded payload's header, if it can. */
  probe(bytes: Uint8Array, encoding: FrameEncoding): PixelSize | null;
  encodeJpeg(pixels: PixelBuffer, quality: number): Promise<Uint8Array>;
  encodePng(pixels: PixelBuffer): Promise<Uint8Array>;
}

/**
 * Decompression-bomb guards. A frame that claims 400 megapixels is not a frame
 * Pilot has any business decoding, whatever the accessibility tree says.
 */
export const MAX_DECODED_MEGAPIXELS = 64;
export const MAX_DECODE_MEMORY_MB = 512;

function codecError(message: string, cause?: unknown): PilotError {
  return new PilotError('capture-failed', message, {
    userMessage: 'Pilot could not read the captured image.',
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

// ---------------------------------------------------------------------------
// zlib, promisified
// ---------------------------------------------------------------------------

async function deflateAsync(bytes: Uint8Array, level: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    deflate(bytes, { level, strategy: zlibConstants.Z_DEFAULT_STRATEGY }, (error, result) => {
      if (error) {
        reject(codecError(`PNG compression failed: ${error.message}`, error));
        return;
      }
      resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
    });
  });
}

async function inflateAsync(bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    inflate(bytes, (error, result) => {
      if (error) {
        reject(codecError(`PNG decompression failed: ${error.message}`, error));
        return;
      }
      resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
    });
  });
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** Deflate level for PNG output. 6 is zlib's default; see the note in `encodePng`. */
export const DEFAULT_PNG_DEFLATE_LEVEL = 6;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ (bytes[index] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(payload.length + 12);
  writeUint32(chunk, 0, payload.length);
  for (let index = 0; index < 4; index += 1) {
    chunk[4 + index] = type.charCodeAt(index);
  }
  chunk.set(payload, 8);
  writeUint32(chunk, payload.length + 8, crc32(chunk.subarray(4, payload.length + 8)));
  return chunk;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

/**
 * Bytes between scored samples when picking a scanline filter.
 *
 * The minimum-sum-of-absolute-differences rule (PNG spec §12.8) is a heuristic,
 * so estimating its sums from a quarter of the bytes picks the same filter
 * almost always and costs a quarter as much. On a 1440×960 frame this is the
 * difference between roughly 120 ms and roughly 30 ms of filtering, which
 * matters against a 150 ms budget for the whole observation.
 *
 * Indexing below is deliberately unchecked (`as number`): every index is
 * derived from the buffer's own length, and `noUncheckedIndexedAccess`'s `?? 0`
 * costs a branch on each of some tens of millions of reads.
 */
const FILTER_SCORE_STRIDE = 4;

/** Filters one scanline with each candidate and keeps the cheapest. */
function filterScanline(
  raw: Uint8Array,
  previous: Uint8Array,
  bpp: number,
  into: Uint8Array,
  atOffset: number,
): void {
  const length = raw.length;
  let scoreNone = 0;
  let scoreSub = 0;
  let scoreUp = 0;
  let scorePaeth = 0;

  for (let index = 0; index < length; index += FILTER_SCORE_STRIDE) {
    const value = raw[index] as number;
    const left = index >= bpp ? (raw[index - bpp] as number) : 0;
    const up = previous[index] as number;
    const upLeft = index >= bpp ? (previous[index - bpp] as number) : 0;
    scoreNone += value < 128 ? value : 256 - value;
    const sub = (value - left) & 0xff;
    scoreSub += sub < 128 ? sub : 256 - sub;
    const above = (value - up) & 0xff;
    scoreUp += above < 128 ? above : 256 - above;
    const predicted = (value - paeth(left, up, upLeft)) & 0xff;
    scorePaeth += predicted < 128 ? predicted : 256 - predicted;
  }

  let filter = 0;
  let best = scoreNone;
  if (scoreSub < best) {
    best = scoreSub;
    filter = 1;
  }
  if (scoreUp < best) {
    best = scoreUp;
    filter = 2;
  }
  if (scorePaeth < best) {
    filter = 4;
  }

  into[atOffset] = filter;
  const target = atOffset + 1;
  switch (filter) {
    case 0:
      into.set(raw, target);
      return;
    case 1:
      for (let index = 0; index < bpp && index < length; index += 1) {
        into[target + index] = raw[index] as number;
      }
      for (let index = bpp; index < length; index += 1) {
        into[target + index] = ((raw[index] as number) - (raw[index - bpp] as number)) & 0xff;
      }
      return;
    case 2:
      for (let index = 0; index < length; index += 1) {
        into[target + index] = ((raw[index] as number) - (previous[index] as number)) & 0xff;
      }
      return;
    default:
      for (let index = 0; index < length; index += 1) {
        const left = index >= bpp ? (raw[index - bpp] as number) : 0;
        const upLeft = index >= bpp ? (previous[index - bpp] as number) : 0;
        into[target + index] =
          ((raw[index] as number) - paeth(left, previous[index] as number, upLeft)) & 0xff;
      }
  }
}

/**
 * Encodes RGBA pixels as a PNG.
 *
 * Emits colour type 2 (RGB) when every pixel is opaque, which every image this
 * pipeline produces is: it saves a quarter of the pre-compression bytes and
 * compresses better, because a constant alpha channel is still a channel the
 * filters have to step over.
 */
export async function encodePng(
  pixels: PixelBuffer,
  options: { readonly level?: number; readonly opaque?: boolean } = {},
): Promise<Uint8Array> {
  const level = options.level ?? DEFAULT_PNG_DEFLATE_LEVEL;
  const opaque = options.opaque ?? isOpaque(pixels);
  const channels = opaque ? 3 : 4;
  const colorType = opaque ? 2 : 6;
  const stride = pixels.width * channels;

  const filtered = new Uint8Array((stride + 1) * pixels.height);
  let previous = new Uint8Array(stride);
  let row = new Uint8Array(stride);

  const data = pixels.data;
  for (let y = 0; y < pixels.height; y += 1) {
    let source = y * pixels.width * 4;
    let at = 0;
    for (let x = 0; x < pixels.width; x += 1) {
      row[at] = data[source] as number;
      row[at + 1] = data[source + 1] as number;
      row[at + 2] = data[source + 2] as number;
      if (!opaque) {
        row[at + 3] = data[source + 3] as number;
      }
      at += channels;
      source += 4;
    }
    filterScanline(row, previous, channels, filtered, y * (stride + 1));
    const swap = previous;
    previous = row;
    row = swap;
  }

  const idat = await deflateAsync(filtered, level);

  const ihdr = new Uint8Array(13);
  writeUint32(ihdr, 0, pixels.width);
  writeUint32(ihdr, 4, pixels.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const chunks = [
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function isOpaque(pixels: PixelBuffer): boolean {
  for (let index = 3; index < pixels.data.length; index += 4) {
    if ((pixels.data[index] ?? 255) !== 255) {
      return false;
    }
  }
  return true;
}

interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly interlace: number;
}

function readPngHeader(bytes: Uint8Array): PngHeader {
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      throw codecError('Payload is not a PNG (bad signature)');
    }
  }
  return {
    width: readUint32(bytes, 16),
    height: readUint32(bytes, 20),
    bitDepth: bytes[24] ?? 0,
    colorType: bytes[25] ?? 0,
    interlace: bytes[28] ?? 0,
  };
}

const PNG_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decodes the PNG subset a screen capture produces: 8-bit, non-interlaced,
 * greyscale / RGB / palette / greyscale+alpha / RGBA.
 *
 * Anything else — 16-bit channels, Adam7 interlacing — raises a typed error
 * rather than guessing. An explicit failure is a delivery rule; a picture
 * decoded wrongly is worse than no picture.
 */
export async function decodePng(bytes: Uint8Array): Promise<PixelBuffer> {
  const header = readPngHeader(bytes);
  if (header.bitDepth !== 8) {
    throw codecError(`Unsupported PNG bit depth ${String(header.bitDepth)}; Pilot handles 8-bit`);
  }
  if (header.interlace !== 0) {
    throw codecError('Unsupported interlaced PNG; Pilot handles non-interlaced images');
  }
  const channels = PNG_CHANNELS[header.colorType];
  if (channels === undefined) {
    throw codecError(`Unsupported PNG colour type ${String(header.colorType)}`);
  }
  guardPixelCount(header.width, header.height);

  const idatParts: Uint8Array[] = [];
  let palette: Uint8Array | null = null;
  let paletteAlpha: Uint8Array | null = null;
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    const from = offset + 8;
    if (type === 'IDAT') {
      idatParts.push(bytes.subarray(from, from + length));
    } else if (type === 'PLTE') {
      palette = bytes.subarray(from, from + length);
    } else if (type === 'tRNS') {
      paletteAlpha = bytes.subarray(from, from + length);
    } else if (type === 'IEND') {
      break;
    }
    offset = from + length + 4;
  }
  if (idatParts.length === 0) {
    throw codecError('PNG carries no image data');
  }

  const compressedLength = idatParts.reduce((sum, part) => sum + part.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let at = 0;
  for (const part of idatParts) {
    compressed.set(part, at);
    at += part.length;
  }
  const raw = await inflateAsync(compressed);

  const stride = header.width * channels;
  const expected = (stride + 1) * header.height;
  if (raw.length < expected) {
    throw codecError(`PNG image data is ${String(raw.length)} B, expected ${String(expected)} B`);
  }

  // Unfilter into a contiguous scanline buffer. The filter is chosen per row,
  // so the switch is hoisted out of the per-byte loop: leaving it inside costs
  // roughly five times as much on a full-size frame.
  const lines = new Uint8Array(stride * header.height);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    const source = y * (stride + 1) + 1;
    const target = y * stride;
    const above = target - stride;
    switch (filter) {
      case 0:
        for (let index = 0; index < stride; index += 1) {
          lines[target + index] = raw[source + index] as number;
        }
        break;
      case 1:
        for (let index = 0; index < stride; index += 1) {
          const left = index >= channels ? (lines[target + index - channels] as number) : 0;
          lines[target + index] = ((raw[source + index] as number) + left) & 0xff;
        }
        break;
      case 2:
        for (let index = 0; index < stride; index += 1) {
          const up = y > 0 ? (lines[above + index] as number) : 0;
          lines[target + index] = ((raw[source + index] as number) + up) & 0xff;
        }
        break;
      case 3:
        for (let index = 0; index < stride; index += 1) {
          const left = index >= channels ? (lines[target + index - channels] as number) : 0;
          const up = y > 0 ? (lines[above + index] as number) : 0;
          lines[target + index] = ((raw[source + index] as number) + ((left + up) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let index = 0; index < stride; index += 1) {
          const left = index >= channels ? (lines[target + index - channels] as number) : 0;
          const up = y > 0 ? (lines[above + index] as number) : 0;
          const upLeft =
            y > 0 && index >= channels ? (lines[above + index - channels] as number) : 0;
          lines[target + index] =
            ((raw[source + index] as number) + paeth(left, up, upLeft)) & 0xff;
        }
        break;
      default:
        throw codecError(`Unsupported PNG filter ${String(filter)}`);
    }
  }

  const out = createPixelBuffer(header.width, header.height);
  const rgba = out.data;
  const pixelCount = header.width * header.height;
  switch (header.colorType) {
    case 0:
      for (let pixel = 0, index = 0; pixel < pixelCount; pixel += 1, index += 4) {
        const value = lines[pixel] as number;
        rgba[index] = value;
        rgba[index + 1] = value;
        rgba[index + 2] = value;
        rgba[index + 3] = 255;
      }
      break;
    case 2:
      for (let pixel = 0, index = 0, source = 0; pixel < pixelCount; pixel += 1) {
        rgba[index] = lines[source] as number;
        rgba[index + 1] = lines[source + 1] as number;
        rgba[index + 2] = lines[source + 2] as number;
        rgba[index + 3] = 255;
        index += 4;
        source += 3;
      }
      break;
    case 3:
      for (let pixel = 0, index = 0; pixel < pixelCount; pixel += 1, index += 4) {
        const entry = lines[pixel] as number;
        rgba[index] = palette?.[entry * 3] ?? 0;
        rgba[index + 1] = palette?.[entry * 3 + 1] ?? 0;
        rgba[index + 2] = palette?.[entry * 3 + 2] ?? 0;
        rgba[index + 3] = paletteAlpha?.[entry] ?? 255;
      }
      break;
    case 4:
      for (let pixel = 0, index = 0, source = 0; pixel < pixelCount; pixel += 1) {
        const value = lines[source] as number;
        rgba[index] = value;
        rgba[index + 1] = value;
        rgba[index + 2] = value;
        rgba[index + 3] = lines[source + 1] as number;
        index += 4;
        source += 2;
      }
      break;
    default:
      rgba.set(lines.subarray(0, pixelCount * 4));
  }
  return out;
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

/** mvp-01 §10 states quality as a fraction; `jpeg-js` wants 1–100. */
export function toJpegQualityPercent(quality: number): number {
  return Math.min(100, Math.max(1, Math.round(quality * 100)));
}

export function encodeJpeg(pixels: PixelBuffer, quality: number): Uint8Array {
  const encoded = encodeJpegPayload(
    { width: pixels.width, height: pixels.height, data: pixels.data },
    toJpegQualityPercent(quality),
  );
  return new Uint8Array(encoded.data.buffer, encoded.data.byteOffset, encoded.data.byteLength);
}

export function decodeJpeg(bytes: Uint8Array): PixelBuffer {
  try {
    const decoded = decodeJpegPayload(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: true,
      maxResolutionInMP: MAX_DECODED_MEGAPIXELS,
      maxMemoryUsageInMB: MAX_DECODE_MEMORY_MB,
    });
    guardPixelCount(decoded.width, decoded.height);
    return pixelBufferFrom(decoded.width, decoded.height, decoded.data);
  } catch (error) {
    if (error instanceof PilotError) {
      throw error;
    }
    throw codecError(
      `JPEG decode failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

// ---------------------------------------------------------------------------
// BGRA
// ---------------------------------------------------------------------------

/** ScreenCaptureKit's native layout: 4 bytes per pixel, blue first. */
export function decodeBgra(bytes: Uint8Array, size: PixelSize): PixelBuffer {
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  guardPixelCount(width, height);
  const expected = width * height * 4;
  if (bytes.byteLength < expected) {
    throw codecError(
      `BGRA payload is ${String(bytes.byteLength)} B, expected ${String(expected)} B for ${String(width)}×${String(height)}`,
    );
  }
  const out = createPixelBuffer(width, height);
  const rgba = out.data;
  for (let index = 0; index < expected; index += 4) {
    rgba[index] = bytes[index + 2] as number;
    rgba[index + 1] = bytes[index + 1] as number;
    rgba[index + 2] = bytes[index] as number;
    rgba[index + 3] = bytes[index + 3] as number;
  }
  return out;
}

function guardPixelCount(width: number, height: number): void {
  const megapixels = (width * height) / 1_000_000;
  if (!Number.isFinite(megapixels) || megapixels > MAX_DECODED_MEGAPIXELS) {
    throw codecError(
      `Refusing to decode a ${megapixels.toFixed(1)} MP image; the ceiling is ${String(MAX_DECODED_MEGAPIXELS)} MP`,
    );
  }
}

// ---------------------------------------------------------------------------
// Header probes
// ---------------------------------------------------------------------------

const JPEG_SOF_MARKERS: ReadonlySet<number> = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * Real pixel size from an encoded payload's own header.
 *
 * `CapturedFrame.size` is what the *adapter said*. Before any byte is passed
 * through to the model unchanged, the pipeline checks the payload agrees;
 * otherwise it would report a size it never verified and could hand out an
 * image larger than the policy's edge bound.
 */
export function probeEncodedSize(bytes: Uint8Array, encoding: FrameEncoding): PixelSize | null {
  if (encoding === 'png') {
    if (bytes.length < 24) {
      return null;
    }
    for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
      if (bytes[index] !== PNG_SIGNATURE[index]) {
        return null;
      }
    }
    return { width: readUint32(bytes, 16), height: readUint32(bytes, 20) };
  }
  if (encoding !== 'jpeg') {
    return null;
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    if (JPEG_SOF_MARKERS.has(marker)) {
      return {
        height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
        width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0),
      };
    }
    if (length < 2) {
      return null;
    }
    offset += 2 + length;
  }
  return null;
}

export function mimeTypeForEncoding(encoding: FrameEncoding): EncodedMimeType | null {
  if (encoding === 'jpeg') {
    return 'image/jpeg';
  }
  if (encoding === 'png') {
    return 'image/png';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The default codec
// ---------------------------------------------------------------------------

export interface DefaultFrameCodecOptions {
  /** zlib deflate level for PNG output. */
  readonly pngLevel?: number;
}

/**
 * The codec Pilot ships: `zlib` for PNG, `jpeg-js` for JPEG, a swap for BGRA.
 * Stateless, so one instance can serve every observation.
 */
export function createDefaultFrameCodec(options: DefaultFrameCodecOptions = {}): FrameCodec {
  const pngLevel = options.pngLevel ?? DEFAULT_PNG_DEFLATE_LEVEL;
  return {
    async decode(bytes, encoding, declaredSize) {
      switch (encoding) {
        case 'png':
          return decodePng(bytes);
        case 'bgra':
          return decodeBgra(bytes, declaredSize);
        case 'jpeg':
          return decodeJpeg(bytes);
      }
    },
    probe(bytes, encoding) {
      return probeEncodedSize(bytes, encoding);
    },
    async encodeJpeg(pixels, quality) {
      return encodeJpeg(pixels, quality);
    },
    async encodePng(pixels) {
      return encodePng(pixels, { level: pngLevel });
    },
  };
}
