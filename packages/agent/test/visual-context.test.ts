import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  PINNED_PI_VERSIONS,
  countImageBlocks,
  findPinnedVersionDrift,
  isLoopbackBaseUrl,
  pruneVisualContext,
  renderObservationPlaceholder,
} from '../src/index.js';
import { PNG_1PX_BASE64 } from './support.js';

const image = (): AgentMessage => ({
  role: 'toolResult',
  toolCallId: 'tc',
  toolName: 'observe_screen',
  content: [
    { type: 'text', text: 'observation' },
    { type: 'image', data: PNG_1PX_BASE64, mimeType: 'image/png' },
  ],
  isError: false,
  timestamp: 1,
});

const text = (body: string): AgentMessage => ({ role: 'user', content: body, timestamp: 1 });

describe('pruneVisualContext', () => {
  it('keeps the N newest images and replaces the rest', () => {
    const messages = [image(), text('a'), image(), text('b'), image()];
    expect(countImageBlocks(messages)).toBe(3);

    const pruned = pruneVisualContext(messages, { keepMostRecent: 1 });

    expect(countImageBlocks(pruned)).toBe(1);
    expect(countImageBlocks(messages)).toBe(3); // input untouched
    expect(JSON.stringify(pruned.at(-1))).toContain(PNG_1PX_BASE64);
    expect(JSON.stringify(pruned[0])).not.toContain(PNG_1PX_BASE64);
  });

  it('is a no-op when the budget is not exceeded', () => {
    const messages = [image(), text('a')];
    expect(countImageBlocks(pruneVisualContext(messages, { keepMostRecent: 4 }))).toBe(1);
  });

  it('can replace an image with a truthful, scene-tagged record', () => {
    const pruned = pruneVisualContext([image(), image()], {
      keepMostRecent: 1,
      placeholderFor: () =>
        renderObservationPlaceholder({
          sceneId: 'scene-17',
          sceneRevision: 4,
          summary: 'The user was viewing the billing settings page.',
        }),
    });
    expect(JSON.stringify(pruned[0])).toContain(
      '[Observation scene-17/revision-4 removed. The user was viewing the billing settings page.]',
    );
  });
});

describe('isLoopbackBaseUrl', () => {
  it.each([
    ['http://localhost:11434/v1', true],
    ['http://127.0.0.1:8080/v1', true],
    ['https://api.openai.com/v1', false],
    ['not a url', false],
  ])('%s -> %s', (url, expected) => {
    expect(isLoopbackBaseUrl(url)).toBe(expected);
  });
});

describe('pinned versions', () => {
  it('matches what is actually installed', async () => {
    // `import(pkg + '/package.json')` is blocked by pi-ai's exports map and
    // `require.resolve` cannot see its ESM-only entry, so read the manifests
    // pnpm linked into this package's own node_modules.
    const packageRoot = fileURLToPath(new URL('..', import.meta.url));
    const installed: Record<string, string> = {};
    for (const name of Object.keys(PINNED_PI_VERSIONS)) {
      const manifestPath = join(packageRoot, 'node_modules', name, 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string };
      installed[name] = manifest.version;
    }
    expect(findPinnedVersionDrift(installed)).toEqual([]);
  });
});
