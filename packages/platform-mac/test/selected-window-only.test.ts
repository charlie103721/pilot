import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The privacy invariant, checked mechanically.
 *
 * system-design §14 requires selected-window capture filters and forbids
 * silently widening to a display; PR-021's `observe_screen` description tells
 * the model in as many words that "Pilot never captures the whole display as a
 * substitute". A code path that could produce a display-wide frame is a privacy
 * breach, not a bug — and it is exactly the kind of thing that arrives later as
 * a well-meaning fallback for a window that could not be found.
 *
 * `SCContentFilter` cannot be executed on this machine (runbook amendment 8),
 * so the guarantee is checked the one way it can be: by reading the sources.
 * These assertions are deliberately blunt. If a future change needs a different
 * filter, the test should fail and the change should be argued for, not
 * silently allowed.
 */

const NATIVE_SOURCES = fileURLToPath(new URL('../native/Sources/', import.meta.url));
const HOST_SOURCES = fileURLToPath(new URL('../src/', import.meta.url));

async function readTree(root: string, extension: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.name.endsWith(extension)) {
        files.set(path, await readFile(path, 'utf8'));
      }
    }
  };
  await walk(root);
  return files;
}

/** Strips `//` comments so prose about a forbidden API is not mistaken for one. */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      return index === -1 ? line : line.slice(0, index);
    })
    .join('\n');
}

describe('the capture filter targets one window', () => {
  it('constructs exactly one SCContentFilter, from the selected window', async () => {
    const swift = await readTree(NATIVE_SOURCES, '.swift');
    const constructions: string[] = [];

    for (const [path, source] of swift) {
      for (const line of withoutComments(source).split('\n')) {
        if (line.includes('SCContentFilter(')) {
          constructions.push(`${path}: ${line.trim()}`);
        }
      }
    }

    expect(constructions).toHaveLength(1);
    expect(constructions[0]).toContain('SCContentFilter(desktopIndependentWindow: window)');
  });

  it('never constructs a display-wide or application-wide filter', async () => {
    const swift = await readTree(NATIVE_SOURCES, '.swift');
    // Every other `SCContentFilter` initialiser, by its argument label. Each
    // one can produce pixels from outside the selected window.
    const forbidden = [
      'SCContentFilter(display:',
      'SCContentFilter(desktopIndependentWindow: content',
      'excludingWindows:',
      'includingWindows:',
      'excludingApplications:',
      'includingApplications:',
    ];

    for (const [path, source] of swift) {
      const code = withoutComments(source);
      for (const pattern of forbidden) {
        expect(`${path}: ${String(code.includes(pattern))}`).toBe(`${path}: false`);
      }
    }
  });

  it('selects the window by exact id, with no first-match fallback', async () => {
    const engine = await readFile(
      join(NATIVE_SOURCES, 'PilotHelperCore/CaptureEngine.swift'),
      'utf8',
    );
    const code = withoutComments(engine);

    expect(code).toContain('candidate.windowID == wanted');
    // `content.windows.first` would answer with an arbitrary window that looks
    // exactly like the right one — the shape PR-011 called out in
    // `WindowEnumerator.window(number:)`.
    expect(code).not.toContain('content.windows.first');
    expect(code).not.toContain('.displays.first');
  });

  it('has no display in the capture protocol at all', async () => {
    const ops = await readFile(join(HOST_SOURCES, 'protocol/capture-ops.ts'), 'utf8');
    const request = ops.slice(ops.indexOf('captureStartOperation'));

    // Nothing in `capture.start` can name a display, so no host bug can ask
    // for one and no helper change can quietly accept one.
    expect(request).not.toMatch(/displayNumber|displayId|SCDisplay/);
    expect(ops).toContain('windowNumber');
  });

  it('sends only the selected window number, derived from the selection', async () => {
    const adapter = await readFile(
      join(HOST_SOURCES, 'capture/mac-observation-adapter.ts'),
      'utf8',
    );

    // One call site below the imports, and its window number comes from the
    // resolved selection rather than from anything the helper reported.
    const body = adapter.slice(adapter.lastIndexOf("} from '"));
    const starts = body.split('\n').filter((line) => line.includes('captureStartOperation'));
    expect(starts).toHaveLength(1);
    expect(body).toContain('windowNumber: resolved.windowNumber');
  });
});
