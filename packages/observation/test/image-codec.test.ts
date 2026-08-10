import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { PilotError } from '@pilot/shared';
import {
  createDefaultFrameCodec,
  decodeBgra,
  decodeJpeg,
  decodePng,
  encodeJpeg,
  encodePng,
  mimeTypeForEncoding,
  probeEncodedSize,
  toJpegQualityPercent,
} from '../src/image-codec.js';
import { createPixelBuffer, fillRect, type PixelBuffer } from '../src/pixel-buffer.js';
import { renderSyntheticScreen, toBgraBytes } from '../src/image-fixtures.js';

/**
 * PR-018 codecs.
 *
 * The point of these tests is that the pipeline's inputs and outputs are *real*
 * images: a PNG this package writes is a PNG this package (and anything else)
 * can read back byte for byte, and a JPEG it writes decodes to the picture it
 * was given. Everything above them — redaction ordering, crop clamping, the
 * budget — rests on that being true rather than assumed.
 */

function gradient(width: number, height: number, alpha = 255): PixelBuffer {
  const buffer = createPixelBuffer(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      buffer.data[at] = (x * 7) & 0xff;
      buffer.data[at + 1] = (y * 11) & 0xff;
      buffer.data[at + 2] = (x + y) & 0xff;
      buffer.data[at + 3] = alpha;
    }
  }
  return buffer;
}

describe('PNG codec', () => {
  it('round-trips opaque pixels exactly', async () => {
    const source = gradient(61, 37);
    const decoded = await decodePng(await encodePng(source));
    expect(decoded.width).toBe(61);
    expect(decoded.height).toBe(37);
    expect(Array.from(decoded.data)).toStrictEqual(Array.from(source.data));
  });

  it('round-trips translucent pixels exactly, keeping the alpha channel', async () => {
    const source = gradient(23, 19, 128);
    const encoded = await encodePng(source);
    // Colour type 6 (RGBA) rather than 2 (RGB): byte 25 of a PNG is the type.
    expect(encoded[25]).toBe(6);
    const decoded = await decodePng(encoded);
    expect(Array.from(decoded.data)).toStrictEqual(Array.from(source.data));
  });

  it('drops the alpha channel when every pixel is opaque', async () => {
    const encoded = await encodePng(gradient(16, 16));
    expect(encoded[25]).toBe(2);
  });

  it('round-trips a full synthetic screenshot', async () => {
    const screen = renderSyntheticScreen({ size: { width: 320, height: 200 } });
    const decoded = await decodePng(await encodePng(screen.pixels));
    expect(Array.from(decoded.data)).toStrictEqual(Array.from(screen.pixels.data));
  });

  it('refuses an interlaced PNG rather than guessing', async () => {
    const encoded = await encodePng(gradient(8, 8));
    const tampered = Uint8Array.from(encoded);
    tampered[28] = 1; // interlace method
    await expect(decodePng(tampered)).rejects.toThrowError(/interlaced/i);
  });

  it('refuses a 16-bit PNG rather than guessing', async () => {
    const encoded = await encodePng(gradient(8, 8));
    const tampered = Uint8Array.from(encoded);
    tampered[24] = 16; // bit depth
    await expect(decodePng(tampered)).rejects.toThrowError(/bit depth/i);
  });

  it('refuses a payload that is not a PNG', async () => {
    await expect(decodePng(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9))).rejects.toThrowError(
      /not a PNG/i,
    );
  });

  it('decodes a greyscale PNG written by hand', async () => {
    // Colour type 0, two pixels: black then white, filter 0.
    const ihdr = new Uint8Array([0, 0, 0, 2, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
    const idat = deflateSync(Uint8Array.of(0, 0, 255));
    const png = buildPng(ihdr, new Uint8Array(idat));
    const decoded = await decodePng(png);
    expect(Array.from(decoded.data)).toStrictEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });
});

describe('JPEG codec', () => {
  it('maps the policy quality fraction onto the encoder scale', () => {
    expect(toJpegQualityPercent(0.75)).toBe(75);
    expect(toJpegQualityPercent(1)).toBe(100);
    expect(toJpegQualityPercent(0)).toBe(1);
  });

  it('round-trips a flat image closely enough to recognise it', () => {
    const source = createPixelBuffer(64, 64);
    fillRect(source, { x: 0, y: 0, width: 64, height: 64 }, { r: 240, g: 20, b: 30, a: 255 });
    const decoded = decodeJpeg(encodeJpeg(source, 0.9));
    expect(decoded.width).toBe(64);
    expect(decoded.height).toBe(64);
    expect(decoded.data[0]).toBeGreaterThan(220);
    expect(decoded.data[1]).toBeLessThan(60);
    expect(decoded.data[3]).toBe(255);
  });

  it('reports a corrupt payload as a typed capture failure', () => {
    expect(() => decodeJpeg(Uint8Array.of(0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01))).toThrowError(
      PilotError,
    );
  });
});

describe('BGRA', () => {
  it('swaps channels back into RGBA', () => {
    const screen = renderSyntheticScreen({ size: { width: 48, height: 32 } });
    const decoded = decodeBgra(toBgraBytes(screen.pixels), { width: 48, height: 32 });
    expect(Array.from(decoded.data)).toStrictEqual(Array.from(screen.pixels.data));
  });

  it('refuses a payload shorter than the declared size', () => {
    expect(() => decodeBgra(new Uint8Array(16), { width: 10, height: 10 })).toThrowError(
      /expected 400 B/,
    );
  });
});

describe('header probes', () => {
  it('reads the real size out of a PNG', async () => {
    const encoded = await encodePng(gradient(37, 21));
    expect(probeEncodedSize(encoded, 'png')).toStrictEqual({ width: 37, height: 21 });
  });

  it('reads the real size out of a JPEG', () => {
    const encoded = encodeJpeg(gradient(48, 32), 0.75);
    expect(probeEncodedSize(encoded, 'jpeg')).toStrictEqual({ width: 48, height: 32 });
  });

  it('returns null for raw BGRA and for a payload that is not an image', () => {
    expect(probeEncodedSize(new Uint8Array(64), 'bgra')).toBeNull();
    expect(probeEncodedSize(Uint8Array.of(1, 2, 3), 'jpeg')).toBeNull();
    expect(probeEncodedSize(Uint8Array.of(1, 2, 3), 'png')).toBeNull();
  });

  it('maps frame encodings onto the two MIME types system-design §9 allows', () => {
    expect(mimeTypeForEncoding('jpeg')).toBe('image/jpeg');
    expect(mimeTypeForEncoding('png')).toBe('image/png');
    expect(mimeTypeForEncoding('bgra')).toBeNull();
  });
});

describe('the default codec', () => {
  it('decodes all three frame encodings to identical pixels', async () => {
    const codec = createDefaultFrameCodec();
    const screen = renderSyntheticScreen({ size: { width: 96, height: 64 } });
    const size = { width: 96, height: 64 };

    const fromPng = await codec.decode(await encodePng(screen.pixels), 'png', size);
    const fromBgra = await codec.decode(toBgraBytes(screen.pixels), 'bgra', size);
    expect(Array.from(fromPng.data)).toStrictEqual(Array.from(screen.pixels.data));
    expect(Array.from(fromBgra.data)).toStrictEqual(Array.from(screen.pixels.data));

    const fromJpeg = await codec.decode(encodeJpeg(screen.pixels, 0.95), 'jpeg', size);
    expect(fromJpeg.width).toBe(96);
    expect(fromJpeg.height).toBe(64);
  });

  it('refuses to decode an image above the megapixel ceiling', () => {
    expect(() => decodeBgra(new Uint8Array(4), { width: 20_000, height: 20_000 })).toThrowError(
      /MP/,
    );
  });
});

function buildPng(ihdr: Uint8Array, idat: Uint8Array): Uint8Array {
  const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const chunk = (type: string, payload: Uint8Array): Uint8Array => {
    const out = new Uint8Array(payload.length + 12);
    const view = new DataView(out.buffer);
    view.setUint32(0, payload.length);
    for (let index = 0; index < 4; index += 1) {
      out[4 + index] = type.charCodeAt(index);
    }
    out.set(payload, 8);
    view.setUint32(payload.length + 8, crc32(out.subarray(4, payload.length + 8)));
    return out;
  };
  const parts = [
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
