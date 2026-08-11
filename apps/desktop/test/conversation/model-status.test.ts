import { describe, expect, it } from 'vitest';
import {
  asModelProfileId,
  createJsonSink,
  createLogger,
  type LogRecord,
  type ModelProfile,
} from '@pilot/shared';
import { FakeInteractionController } from '@pilot/platform/fakes';
import {
  describeModelStatus,
  describeModelStatusLine,
  FAUX_MODEL_HEADLINE,
} from '../../src/conversation/model-status.js';
import { buildConversationView } from '../../src/conversation/view-model.js';
import { buildObservationView } from '../../src/observation/view-model.js';
import { buildPermissionOnboardingView } from '../../src/permissions/view-model.js';
import {
  conversationGateStateSchema,
  modelStatusSchema,
  MODEL_PROFILE_KINDS,
  type ConversationGateState,
  type ModelProfileKind,
  type ModelStatusView,
} from '../../src/ipc/schemas.js';

/**
 * Which model Pilot is talking to (runbook follow-ups 46 and 33, hazard 28).
 *
 * Four profiles, one row, and one property that outranks all of it: **nothing
 * here may carry a credential**, in any form, ever. `@pilot/shared`'s redactor
 * matches on key *name* — it has eaten four real fields (hazard 25) and cannot
 * see a secret in a value (follow-up 42) — so this file proves the absence two
 * ways rather than trusting it: by putting a credential-bearing base URL
 * through every profile and searching every string, and by logging the whole
 * object and asserting `redactedPaths` is empty.
 */

const LAUNCH_FILE = '/Users/someone/Library/Application Support/Pilot/pilot.env';

/** Pi's faux provider profile, verbatim from `createDevelopmentModelSource`. */
const FAUX_PROFILE: ModelProfile = {
  id: asModelProfileId('profile-faux'),
  provider: 'pilot-faux',
  model: 'faux-vision',
  authMode: 'local',
  baseUrl: 'http://localhost:0',
  supportsVision: true,
  supportsTools: true,
  isRemote: false,
};

const CODEX_PROFILE: ModelProfile = {
  id: asModelProfileId('codex:gpt-5.3-codex'),
  provider: 'openai-codex',
  model: 'gpt-5.3-codex',
  authMode: 'subscription',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  supportsVision: true,
  supportsTools: true,
  isRemote: true,
};

const API_KEY_PROFILE: ModelProfile = {
  id: asModelProfileId('api-key:recorded-vendor:recorded-vision-pro'),
  provider: 'recorded-vendor',
  model: 'recorded-vision-pro',
  authMode: 'api-key',
  baseUrl: 'https://api.recorded-vendor.example/v1',
  supportsVision: true,
  supportsTools: true,
  isRemote: true,
};

const LOCAL_PROFILE: ModelProfile = {
  id: asModelProfileId('local:llama-vision'),
  provider: 'local',
  model: 'llama-vision',
  authMode: 'local',
  baseUrl: 'http://localhost:11434/v1',
  supportsVision: true,
  supportsTools: true,
  isRemote: false,
};

const PROFILES: Readonly<Record<ModelProfileKind, ModelProfile>> = {
  codex: CODEX_PROFILE,
  'api-key': API_KEY_PROFILE,
  local: LOCAL_PROFILE,
  development: FAUX_PROFILE,
};

function statusFor(kind: ModelProfileKind, blockedReason: string | null = null): ModelStatusView {
  // Through the schema every time: a field the IPC contract does not know about
  // never reaches the panel, so a test that skipped this would prove nothing.
  return modelStatusSchema.parse(
    describeModelStatus({
      kind,
      profile: PROFILES[kind],
      blockedReason,
      launchFile: LAUNCH_FILE,
    }),
  );
}

const BASE_GATE: ConversationGateState = {
  telemetry: { samples: [], capacity: 128, recorded: 0, dropped: 0 },
  diagnosticsVisible: false,
  pushToTalk: null,
  disclosure: null,
  fixture: null,
  demoFixtures: false,
  modelDisclosure: null,
  modelStatus: null,
};

/** The panel's own input, built the way `App.tsx` builds it. */
function viewFor(status: ModelStatusView | null) {
  const controller = new FakeInteractionController();
  const view = controller.snapshot();
  const permissions = buildPermissionOnboardingView({
    snapshot: null,
    pending: [],
    checkedAt: null,
    settings: { available: false, platform: 'linux', reason: 'not a Mac' },
    lastError: null,
    fixture: null,
  });
  const observation = buildObservationView({
    gate: {
      windows: [],
      listedAt: null,
      listing: false,
      notice: null,
      lastError: null,
      demoEvents: false,
    },
    view,
    permissions,
  });
  return buildConversationView({
    view,
    gate: conversationGateStateSchema.parse({ ...BASE_GATE, modelStatus: status }),
    observation,
  });
}

describe('the model profile in force', () => {
  it('names the development stand-in as NOT A REAL MODEL, unmistakably', () => {
    const status = statusFor('development');

    expect(status.realModel).toBe(false);
    expect(status.severity).toBe('critical');
    expect(status.headline).toBe('NOT A REAL MODEL — answers are placeholder text');
    expect(status.detail).toBe(
      'No model provider is configured, so Pilot is answering with a built-in stand-in. ' +
        'It is not a language model, it never sees your screen, and nothing it says about ' +
        'your screen is true.',
    );
    // Not "local": there is no model at `http://localhost:0`, and calling it
    // local would be true about the address and misleading about everything else.
    expect(status.localityLabel).toBe('Nothing is sent anywhere: there is no model to send it to.');
    expect(status.destination).toBe('nowhere');
    expect(status.sendsScreenOffDevice).toBe(false);
    expect(status.profileLabel).toBe('Development stand-in');
    expect(status.modelLabel).toBe('pilot-faux/faux-vision');
  });

  it('tells the user how to reach a real model, and only in ways the launch file allows', () => {
    const status = statusFor('development');
    expect(status.remedy).toBe(
      'To use a real model, put PILOT_MODEL_PROFILE=codex (a ChatGPT subscription) or ' +
        'PILOT_LOCAL_BASE_URL=http://localhost:11434/v1 (your own model server) in ' +
        `${LAUNCH_FILE} and restart Pilot. An API key cannot go in that file: start Pilot ` +
        'once from a terminal with PILOT_API_KEY set and Pilot seals it in the keychain.',
    );
    // `LAUNCH_ENV_ALLOWED` carries neither of these, so neither may be offered
    // as something to put in the file.
    expect(status.remedy).not.toContain('PILOT_API_KEY=');
    expect(status.remedy).not.toContain('PILOT_MODEL_FIXTURE');
  });

  it('names the ChatGPT subscription, and that the screen leaves the Mac', () => {
    const status = statusFor('codex');
    expect(status.realModel).toBe(true);
    expect(status.headline).toBe('Answering with your ChatGPT subscription');
    expect(status.profileLabel).toBe('ChatGPT subscription');
    expect(status.sendsScreenOffDevice).toBe(true);
    expect(status.severity).toBe('attention');
    expect(status.destination).toBe('chatgpt.com');
    expect(status.localityLabel).toBe('Remote model — screen images are sent to chatgpt.com');
    expect(status.detail).toBe(
      'Questions and screen images go to openai-codex/gpt-5.3-codex using your ChatGPT sign-in. ' +
        'Screen images leave this Mac and are sent to chatgpt.com for ' +
        'openai-codex/gpt-5.3-codex.',
    );
    expect(status.remedy).toBeNull();
  });

  it('names the API-key profile without naming the key', () => {
    const status = statusFor('api-key');
    expect(status.headline).toBe('Answering with your own API key');
    expect(status.profileLabel).toBe('Your own API key');
    expect(status.sendsScreenOffDevice).toBe(true);
    expect(status.destination).toBe('api.recorded-vendor.example');
    expect(status.detail).toBe(
      'Questions and screen images go to recorded-vendor/recorded-vision-pro using the API key ' +
        'you configured. Screen images leave this Mac and are sent to ' +
        'api.recorded-vendor.example for recorded-vendor/recorded-vision-pro.',
    );
  });

  it('names a local endpoint and says the screen stays here', () => {
    const status = statusFor('local');
    expect(status.headline).toBe('Answering with your own local model');
    expect(status.profileLabel).toBe('Your own local endpoint');
    expect(status.sendsScreenOffDevice).toBe(false);
    expect(status.severity).toBe('normal');
    expect(status.localityLabel).toBe('Local model on this Mac (localhost)');
    expect(status.detail).toBe(
      'Questions and screen images go to local/llama-vision on the endpoint you configured. ' +
        'Screen images stay on this Mac. local/llama-vision is served from localhost.',
    );
  });

  it('fails closed when the stored locality flag and the base URL disagree', () => {
    // `describeEndpoint`'s rule, reached through this surface: a profile that
    // *claims* local while pointing at the network is treated as remote, so the
    // panel errs only towards "your screen leaves this machine".
    const status = modelStatusSchema.parse(
      describeModelStatus({
        kind: 'local',
        profile: { ...LOCAL_PROFILE, baseUrl: 'http://192.168.1.40:11434/v1', isRemote: false },
        launchFile: LAUNCH_FILE,
      }),
    );
    expect(status.sendsScreenOffDevice).toBe(true);
    expect(status.severity).toBe('attention');
    expect(status.localityLabel).toContain('Remote model');
    expect(status.detail).toContain('the base URL says otherwise');
  });

  it('stops claiming the present tense when the profile cannot answer', () => {
    const status = statusFor('codex', 'Pilot is not signed in to ChatGPT.');
    expect(status.headline).toBe('ChatGPT subscription — Pilot cannot answer questions yet');
    expect(status.blockedReason).toBe('Pilot is not signed in to ChatGPT.');
    expect(status.detail.startsWith('Pilot is not signed in to ChatGPT.')).toBe(true);
    expect(status.severity).toBe('attention');
    // Still says where the screen would go: a profile that cannot answer today
    // is still the one configured for tomorrow.
    expect(status.detail).toContain('sent to chatgpt.com');
  });

  it('is exhaustive over the profiles main/index.ts can choose', () => {
    for (const kind of MODEL_PROFILE_KINDS) {
      const status = statusFor(kind);
      expect(status.profile).toBe(kind);
      expect(status.headline.length).toBeGreaterThan(0);
      expect(status.realModel).toBe(kind !== 'development');
    }
    expect(MODEL_PROFILE_KINDS).toHaveLength(4);
  });

  it('summarises itself in one line for a log or a smoke check', () => {
    expect(describeModelStatusLine(statusFor('development'))).toBe(
      'NOT A REAL MODEL · development · pilot-faux/faux-vision · on this Mac',
    );
    expect(describeModelStatusLine(statusFor('codex'))).toBe(
      'real · codex · openai-codex/gpt-5.3-codex · REMOTE',
    );
  });
});

describe('no credential can reach the model row', () => {
  /** Every string a `ModelStatusView` carries, flattened. */
  const strings = (status: ModelStatusView): string[] =>
    Object.values(status).filter((value): value is string => typeof value === 'string');

  it('strips user information from a base URL, in every profile', () => {
    // Follow-up 42's shape: `https://user:token@host/v1` is a credential wearing
    // an address's clothes, and it arrives here on `ModelProfile.baseUrl`.
    const secret = 'sk-must-never-be-rendered';
    for (const kind of MODEL_PROFILE_KINDS) {
      const status = modelStatusSchema.parse(
        describeModelStatus({
          kind,
          profile: { ...PROFILES[kind], baseUrl: `https://pilot:${secret}@endpoint.example/v1` },
          launchFile: LAUNCH_FILE,
        }),
      );
      for (const value of strings(status)) {
        expect(value).not.toContain(secret);
        expect(value).not.toContain('pilot:');
      }
    }
  });

  it('strips user information a failure message quotes back at Pilot', () => {
    // Node's own `fetch` refuses a URL carrying credentials by quoting the whole
    // URL, and that text becomes a `PilotError.userMessage` and then
    // `blockedReason`. PR-041 found this reaching the durable transcript.
    const status = modelStatusSchema.parse(
      describeModelStatus({
        kind: 'local',
        profile: LOCAL_PROFILE,
        blockedReason:
          'Pilot could not reach http://user:hunter2@localhost:11434/v1 — is the server running?',
        launchFile: LAUNCH_FILE,
      }),
    );
    for (const value of strings(status)) {
      expect(value).not.toContain('hunter2');
    }
    expect(status.blockedReason).toContain('http://***@localhost:11434/v1');
  });

  it('logs whole, because no field name trips the redactor (hazard 25)', () => {
    // The trap that ate three fields of the product's own `retention clear`
    // line. A `[redacted:credential]` where the model name should be would make
    // the one line a bug report carries unreadable — and, worse, would look
    // exactly like a line that had carried a secret.
    const records: LogRecord[] = [];
    const logger = createLogger({
      scope: 'test',
      sink: { write: (record) => records.push(record) },
    });
    for (const kind of MODEL_PROFILE_KINDS) {
      logger.info('model status', { ...statusFor(kind) });
    }

    expect(records).toHaveLength(MODEL_PROFILE_KINDS.length);
    for (const record of records) {
      expect(record.redactedPaths).toEqual([]);
    }
    const faux = records[MODEL_PROFILE_KINDS.indexOf('development')];
    expect(faux?.fields['headline']).toBe(FAUX_MODEL_HEADLINE);
    expect(faux?.fields['modelLabel']).toBe('pilot-faux/faux-vision');
    // And it survives being serialised, which is what actually reaches stderr.
    let line = '';
    const sink = createJsonSink((emitted) => {
      line = emitted;
    });
    sink.write(records[0] as LogRecord);
    expect(line).not.toContain('[redacted');
  });

  it('has no field that could hold one in the first place', () => {
    // The structural half of the argument: the shape is closed, so a future
    // edit cannot quietly add `apiKey` to it and reach the renderer.
    const status = statusFor('api-key');
    expect(Object.keys(status).sort()).toEqual([
      'blockedReason',
      'destination',
      'detail',
      'headline',
      'localityLabel',
      'modelLabel',
      'profile',
      'profileLabel',
      'realModel',
      'remedy',
      'sendsScreenOffDevice',
      'severity',
    ]);
    expect(() =>
      modelStatusSchema.parse({ ...status, apiKey: 'sk-live-should-not-parse' }),
    ).toThrow();
  });
});

describe('the conversation view carries it to the panel', () => {
  it('passes every profile through unchanged', () => {
    for (const kind of MODEL_PROFILE_KINDS) {
      const status = statusFor(kind);
      expect(viewFor(status).modelStatus).toEqual(status);
    }
  });

  it('is null only before the main process has answered', () => {
    expect(viewFor(null).modelStatus).toBeNull();
  });

  it('does not disturb PR-038’s disclosure, which is a different question', () => {
    const view = viewFor(statusFor('api-key'));
    expect(view.modelDisclosure).toBeNull();
    expect(view.modelStatus?.profile).toBe('api-key');
  });
});
