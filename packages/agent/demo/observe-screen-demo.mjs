/* eslint-disable no-console */
/**
 * PR-005 demo (implementation.md: "send a text prompt and execute a fake
 * `observe_screen` tool call through Pi").
 *
 * Requires a build first, because it imports the compiled package:
 *
 *   pnpm build && node packages/agent/demo/observe-screen-demo.mjs
 *
 * No network and no credentials: the model is Pi's built-in faux provider.
 * The demo prints the Pilot event stream, then proves the two halves of the
 * retention story — pixels in the live model context, no pixels on disk.
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  SqliteSessionRepository,
  createNodeSqliteFactory,
} from '@earendil-works/pi-session-backend-sqlite-node';
import {
  PiAgentSession,
  buildSystemPrompt,
  createDurableTranscriptSink,
  createObserveScreenTool,
} from '../dist/index.js';

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const faux = fauxProvider({
  provider: 'pilot-faux',
  models: [{ id: 'faux-vision', input: ['text', 'image'] }],
});
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage([fauxToolCall('observe_screen', { view: 'pointer', moment: 'question' })], {
    stopReason: 'toolUse',
  }),
  fauxAssistantMessage('That switch turns on automatic renewal for your plan.', {
    stopReason: 'stop',
  }),
]);

const SELECTED_WINDOW = {
  windowId: 'window-billing',
  displayId: 'display-primary',
  title: 'Billing settings',
  applicationName: 'Safari',
  bounds: { x: 100, y: 80, width: 1200, height: 800 },
  scaleFactor: 2,
  isOnScreen: true,
};

const screenContext = {
  // PR-021: `observe_screen` reads this to enforce "selected window only".
  status: () => ({
    enabled: true,
    paused: false,
    selectedWindow: SELECTED_WINDOW,
    scene: {
      sceneId: 'scene-17',
      revision: 4,
      windowId: SELECTED_WINDOW.windowId,
      windowTitle: SELECTED_WINDOW.title,
      fingerprint: 'fingerprint-17',
      updatedAt: Date.now(),
    },
    permissions: { screenRecording: 'granted', accessibility: 'granted' },
    buffer: { frameCount: 9, byteCount: 576, oldestFrameAt: 0, newestFrameAt: 0 },
    lastError: null,
  }),
  clear: () => undefined,
  observe: async (request) => {
    console.log(`  [screen] observe(${JSON.stringify(request)})`);
    return {
      observationId: 'obs-1',
      sceneId: 'scene-17',
      sceneRevision: 4,
      capturedAt: Date.now(),
      windowTitle: 'Billing settings',
      pointer: { x: 0.42, y: 0.61 },
      target: { role: 'switch', label: 'Auto Renew', isSecure: false },
      images: [{ mimeType: 'image/png', base64: PNG_1PX, purpose: 'pointer' }],
    };
  },
};

const directory = await mkdtemp(join(tmpdir(), 'pilot-demo-'));
const env = new NodeExecutionEnv({ cwd: directory });
const repo = new SqliteSessionRepository({
  env,
  sqlite: createNodeSqliteFactory(),
  databasePath: join(directory, 'sessions.db'),
});
const piSession = await repo.create({ cwd: directory });

const session = new PiAgentSession({
  conversationId: 'conv-demo',
  profile: {
    id: 'profile-demo',
    provider: 'pilot-faux',
    model: 'faux-vision',
    authMode: 'local',
    baseUrl: 'http://localhost:0',
    supportsVision: true,
    supportsTools: true,
    isRemote: false,
  },
  models,
  model: faux.getModel(),
  systemPrompt: buildSystemPrompt(),
  tools: [createObserveScreenTool({ screenContext })],
  transcript: createDurableTranscriptSink(piSession),
});

console.log('--- Pilot agent events ---');
session.subscribe((event) => {
  const extra =
    event.type === 'text-delta'
      ? JSON.stringify(event.text)
      : 'toolName' in event
        ? event.toolName
        : 'text' in event
          ? JSON.stringify(event.text)
          : '';
  console.log(`  ${event.type} ${extra}`);
});

const run = await session.submit({
  utteranceId: 'utt-1',
  transcript: 'What does this switch do?',
  conversationId: 'conv-demo',
  scene: { id: 'scene-17', revision: 4, windowTitle: 'Billing settings', lastObservedRevision: 3 },
  pointer: {
    normalizedX: 0.42,
    normalizedY: 0.61,
    targetRole: 'switch',
    targetLabel: 'Auto Renew',
  },
});
await run.completed;
await session.dispose();
await repo.close();

console.log('\n--- Retention check ---');
const liveContext = JSON.stringify(session.messages);
console.log(`  image bytes in live model context : ${liveContext.includes(PNG_1PX)}`);

let onDisk = false;
for (const file of await readdir(directory)) {
  const bytes = await readFile(join(directory, file));
  if (bytes.includes(Buffer.from(PNG_1PX))) {
    onDisk = true;
  }
}
console.log(`  image bytes anywhere on disk      : ${onDisk}`);
console.log(`  session database                  : ${join(directory, 'sessions.db')}`);
