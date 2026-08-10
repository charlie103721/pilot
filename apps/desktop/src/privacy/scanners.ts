/**
 * The byte scanners the privacy audit reads artefacts with (PR-041).
 *
 * Separate from the audit itself for one reason: **a scanner that has quietly
 * stopped matching is the worst failure mode this PR has.** An audit whose
 * regular expression no longer fires reports "no image bytes on disk" for ever,
 * looks exactly like an audit that checked, and is worse than no audit at all
 * because it reads as assurance.
 *
 * So every scanner here is a small, named, exported predicate over raw bytes,
 * and {@link runScannerSelfTest} runs all of them against a **positive control**
 * that deliberately contains every pattern and a **negative control** that
 * deliberately contains none. The audit runs that self-test first and refuses to
 * report anything if it fails; `test/privacy/scanners.test.ts` runs it again and
 * pins each scanner against its own planted sample.
 *
 * Everything is matched on `latin1`, never `utf8`: a SQLite page, a JPEG or a
 * WAV chunk is not text, and `utf8` decoding silently replaces every byte above
 * 0x7f with U+FFFD — which would destroy exactly the byte sequences these look
 * for.
 */

/** One thing an artefact must not contain. */
export interface ByteScanner {
  readonly id: string;
  /** What a hit would mean, in the audit's own words. */
  readonly label: string;
  /** Which §13 column this belongs to. */
  readonly kind: 'image' | 'audio' | 'payload';
  find(bytes: Buffer): boolean;
}

function includesBytes(bytes: Buffer, needle: readonly number[]): boolean {
  return bytes.includes(Buffer.from(needle));
}

/**
 * A base64 run long enough to be a payload rather than an identifier.
 *
 * 120 characters is `flow-demo.ts`'s number and is kept deliberately: a UUID, a
 * scene id and a SHA-256 digest are all shorter, and a single 8×8 PNG is longer.
 */
export const BASE64_PAYLOAD_RUN = /[A-Za-z0-9+/]{120,}={0,2}/;

/**
 * A `data:` URI **anywhere** in the text, not only at the start of a value.
 *
 * `@pilot/shared`'s redactor anchors its own `DATA_URI_PATTERN` with `^`,
 * because it is asking "is this whole value a payload". An audit is asking a
 * different question — "is there a payload in here at all" — and a data URI
 * pasted into the middle of a sentence, a provider error or a stack trace is
 * exactly the shape that slips past the anchored one.
 */
export const EMBEDDED_DATA_URI = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i;

export const BYTE_SCANNERS: readonly ByteScanner[] = [
  {
    id: 'png',
    label: 'a PNG image header (\\x89PNG\\r\\n)',
    kind: 'image',
    find: (bytes) => includesBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
  },
  {
    id: 'jpeg',
    label: 'a JPEG start-of-image marker (\\xff\\xd8\\xff)',
    kind: 'image',
    find: (bytes) => includesBytes(bytes, [0xff, 0xd8, 0xff]),
  },
  {
    id: 'gif',
    label: 'a GIF header (GIF87a/GIF89a)',
    kind: 'image',
    find: (bytes) => bytes.includes(Buffer.from('GIF87a')) || bytes.includes(Buffer.from('GIF89a')),
  },
  {
    id: 'tiff-heic',
    label: 'a HEIC/TIFF container header (ftypheic, II*\\0)',
    kind: 'image',
    find: (bytes) =>
      bytes.includes(Buffer.from('ftypheic')) || includesBytes(bytes, [0x49, 0x49, 0x2a, 0x00]),
  },
  {
    id: 'wav',
    label: 'a RIFF/WAVE audio container',
    kind: 'audio',
    find: (bytes) => bytes.includes(Buffer.from('RIFF')) && bytes.includes(Buffer.from('WAVE')),
  },
  {
    id: 'caf',
    label: 'a Core Audio Format header (caff), which is what macOS records into',
    kind: 'audio',
    find: (bytes) => includesBytes(bytes, [0x63, 0x61, 0x66, 0x66, 0x00, 0x01]),
  },
  {
    id: 'm4a',
    label: 'an MPEG-4 audio container (ftypM4A)',
    kind: 'audio',
    find: (bytes) => bytes.includes(Buffer.from('ftypM4A')),
  },
  {
    id: 'ogg',
    label: 'an Ogg audio container (OggS)',
    kind: 'audio',
    find: (bytes) => includesBytes(bytes, [0x4f, 0x67, 0x67, 0x53, 0x00]),
  },
  {
    id: 'data-uri',
    label: 'a base64 data: URI, anywhere in the bytes rather than only at the start',
    kind: 'payload',
    find: (bytes) => EMBEDDED_DATA_URI.test(bytes.toString('latin1')),
  },
  {
    id: 'base64-run',
    label: 'an unbroken base64 run of 120 characters or more',
    kind: 'payload',
    find: (bytes) => BASE64_PAYLOAD_RUN.test(bytes.toString('latin1')),
  },
];

/**
 * Bytes that contain every pattern above. Built rather than checked in as a
 * fixture, so it cannot drift away from the list it is a control for.
 */
export function positiveControl(): Buffer {
  return Buffer.concat([
    Buffer.from('pilot privacy audit positive control\n'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from('GIF89a'),
    Buffer.from('ftypheic'),
    Buffer.from([0x49, 0x49, 0x2a, 0x00]),
    Buffer.from('RIFF....WAVEfmt '),
    Buffer.from([0x63, 0x61, 0x66, 0x66, 0x00, 0x01]),
    Buffer.from('ftypM4A '),
    Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00]),
    Buffer.from('… answered about data:image/png;base64,iVBORw0KGgo= and then stopped.'),
    Buffer.from(`payload=${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5'.repeat(3)}`),
  ]);
}

/** Bytes that contain none of them. Prose, ids and short tokens only. */
export function negativeControl(): Buffer {
  return Buffer.from(
    'scene-17/revision-4 observationId=obs-000123 windowTitle="Billing Settings" ' +
      'retention clear event=pause clearedFrames=3 lineageReset=false ' +
      'the user was pointing at the Auto Renew toggle.',
  );
}

export interface ScannerSelfTest {
  readonly id: string;
  readonly label: string;
  /** Did it fire on the control that contains its pattern? */
  readonly detectedOnPositive: boolean;
  /** Did it stay silent on the control that does not? */
  readonly silentOnNegative: boolean;
  readonly ok: boolean;
}

/**
 * Proves every scanner still works, before any of them is believed.
 *
 * A scanner that misses the positive control cannot report a clean artefact
 * honestly; a scanner that fires on the negative control would make every
 * artefact look dirty and would be switched off by the next person to read the
 * output. Both are failures of the audit itself, not of the product.
 */
export function runScannerSelfTest(): readonly ScannerSelfTest[] {
  const positive = positiveControl();
  const negative = negativeControl();
  return BYTE_SCANNERS.map((scanner) => {
    const detectedOnPositive = scanner.find(positive);
    const silentOnNegative = !scanner.find(negative);
    return {
      id: scanner.id,
      label: scanner.label,
      detectedOnPositive,
      silentOnNegative,
      ok: detectedOnPositive && silentOnNegative,
    };
  });
}

/** One artefact that was read, and everything found in it. */
export interface ArtefactScan {
  readonly path: string;
  readonly bytes: number;
  /** Scanner ids that fired. Empty is the only acceptable answer. */
  readonly hits: readonly string[];
  /** Named needles that were found — canaries, secrets, quoted words. */
  readonly needles: readonly string[];
}

/** Runs every scanner, plus the caller's own needles, over one artefact. */
export function scanArtefact(
  path: string,
  bytes: Buffer,
  needles: readonly (readonly [string, string])[] = [],
): ArtefactScan {
  return {
    path,
    bytes: bytes.length,
    hits: BYTE_SCANNERS.filter((scanner) => scanner.find(bytes)).map((scanner) => scanner.id),
    needles: needles
      .filter(([, needle]) => bytes.includes(Buffer.from(needle, 'latin1')))
      .map(([label]) => label),
  };
}

/** True when nothing at all was found in any of them. */
export function scansAreClean(scans: readonly ArtefactScan[]): boolean {
  return scans.every((scan) => scan.hits.length === 0 && scan.needles.length === 0);
}

/** Everything found, as one line per artefact that had anything in it. */
export function describeScanHits(scans: readonly ArtefactScan[]): readonly string[] {
  return scans
    .filter((scan) => scan.hits.length > 0 || scan.needles.length > 0)
    .map(
      (scan) =>
        `${scan.path}: ${[...scan.hits, ...scan.needles.map((needle) => `needle:${needle}`)].join(', ')}`,
    );
}
