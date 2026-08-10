import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { HELPER_EXECUTABLE_NAME } from '@pilot/platform-mac';

/**
 * The helper's filename is written down in four places that must agree, in
 * three languages, none of which can see the others:
 *
 *  1. `native/Package.swift` — the SwiftPM product, which fixes the filename
 *     SwiftPM writes into `.build/<config>/`.
 *  2. `scripts/build-helper.js` — asks SwiftPM for that product by name, looks
 *     for that filename, and stages it under `Resources/helper/`.
 *  3. `scripts/verify-bundle.js` — checks the packaged bundle contains it.
 *  4. `HELPER_EXECUTABLE_NAME` — the runtime resolver that has to find the
 *     file inside the bundle, and therefore the source of truth.
 *
 * They did not agree. The packaging lane used `pilot-helper` and the platform
 * lane used `PilotHelper`, so `swift build --product pilot-helper` failed with
 * "no product named", and had it succeeded it would have staged the binary
 * under a name the app does not look for. Neither could be noticed until a Mac
 * ran the packaging path, because on Linux the native build is skipped by
 * design and a placeholder is staged under whatever name the script chose.
 *
 * This test is the cheap check that stands in for that Mac: it reads the other
 * three sources as text and compares them to the resolver's constant.
 */

const repoRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const appRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

const read = (...segments: readonly string[]): string => readFileSync(join(...segments), 'utf8');

describe('the helper executable name', () => {
  it('is what the SwiftPM package declares as an executable product', () => {
    const manifest = read(repoRoot, 'packages', 'platform-mac', 'native', 'Package.swift');
    expect(manifest).toContain(`.executable(name: "${HELPER_EXECUTABLE_NAME}"`);
  });

  it('is what the build hook builds and stages', () => {
    const script = read(appRoot, 'scripts', 'build-helper.js');
    expect(script).toContain(`const HELPER_NAME = '${HELPER_EXECUTABLE_NAME}';`);
  });

  it('is what the bundle check looks for', () => {
    const script = read(appRoot, 'scripts', 'verify-bundle.js');
    expect(script).toContain(`helper/${HELPER_EXECUTABLE_NAME}`);
  });

  it('is not the name the packaging lane used to use', () => {
    // Named explicitly so a revert reads as a deliberate choice rather than a
    // typo, and so grepping the old name finds this explanation.
    expect(HELPER_EXECUTABLE_NAME).not.toBe('pilot-helper');
  });
});
