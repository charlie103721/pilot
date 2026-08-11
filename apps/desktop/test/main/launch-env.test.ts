import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LAUNCH_ENV_ALLOWED,
  LAUNCH_ENV_FILE,
  applyLaunchEnv,
  parseLaunchEnv,
} from '../../src/main/launch-env.js';

/**
 * The launch environment file (PR-042).
 *
 * This exists because of one measured fact: a packaged Pilot started from
 * Finder has NO `PILOT_*` variables, so `PILOT_MODEL_PROFILE`,
 * `PILOT_LOCAL_BASE_URL` and every other provider selector are unreachable and
 * the app silently falls all the way through to the faux development provider.
 * The properties below are what keep the fix from becoming its own problem.
 */

const directories: string[] = [];

function stage(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'pilot-launch-env-'));
  directories.push(directory);
  writeFileSync(join(directory, LAUNCH_ENV_FILE), contents);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('the launch environment file', () => {
  it('is absent without being a problem', () => {
    const env: Record<string, string | undefined> = {};
    const result = applyLaunchEnv({ userDataPath: '/nowhere/at/all' }, env);
    expect(result.present).toBe(false);
    expect(result.problems).toEqual([]);
    expect(env).toEqual({});
  });

  it('fills in the selectors a Finder launch cannot supply', () => {
    const directory = stage(
      [
        '# comment',
        '',
        'PILOT_MODEL_PROFILE=codex',
        'PILOT_LOCAL_BASE_URL=http://127.0.0.1:1234/v1',
        '',
      ].join('\n'),
    );
    const env: Record<string, string | undefined> = {};
    const result = applyLaunchEnv({ userDataPath: directory }, env);

    expect(result.applied).toEqual(['PILOT_MODEL_PROFILE', 'PILOT_LOCAL_BASE_URL']);
    expect(env['PILOT_MODEL_PROFILE']).toBe('codex');
    expect(env['PILOT_LOCAL_BASE_URL']).toBe('http://127.0.0.1:1234/v1');
  });

  it('never overrides a real environment, so `pnpm dev` and the demos are unaffected', () => {
    const directory = stage('PILOT_MODEL_PROFILE=codex\n');
    const env: Record<string, string | undefined> = { PILOT_MODEL_PROFILE: 'api-key' };
    const result = applyLaunchEnv({ userDataPath: directory }, env);

    expect(env['PILOT_MODEL_PROFILE']).toBe('api-key');
    expect(result.applied).toEqual([]);
    expect(result.refused[0]?.reason).toContain('already set in the real environment');
  });

  it('refuses a credential, and says why rather than dropping it silently', () => {
    const directory = stage('PILOT_API_KEY=sk-live-must-not-be-applied\n');
    const env: Record<string, string | undefined> = {};
    const result = applyLaunchEnv({ userDataPath: directory }, env);

    expect(env['PILOT_API_KEY']).toBeUndefined();
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([
      { name: 'PILOT_API_KEY', reason: expect.stringContaining('plaintext file') },
    ]);
    // The refusal must not carry the secret it refused.
    expect(JSON.stringify(result)).not.toContain('sk-live-must-not-be-applied');
  });

  it('carries no fixture switch, so a shipped app cannot be flipped onto the fakes', () => {
    for (const name of [
      'PILOT_PLATFORM',
      'PILOT_HELPER_STUB_PATH',
      'PILOT_PERMISSION_FIXTURE',
      'PILOT_HOTKEY_FIXTURE',
      'PILOT_MODEL_FIXTURE',
      'PILOT_OPEN_PANEL_ON_START',
    ]) {
      expect(LAUNCH_ENV_ALLOWED).not.toContain(name);
    }
    const directory = stage('PILOT_PLATFORM=fakes\n');
    const env: Record<string, string | undefined> = {};
    applyLaunchEnv({ userDataPath: directory }, env);
    expect(env['PILOT_PLATFORM']).toBeUndefined();
  });

  it('reports a malformed line instead of silently ignoring the whole file', () => {
    const directory = stage(['this is not an assignment', 'PILOT_LOG_LEVEL=debug', ''].join('\n'));
    const env: Record<string, string | undefined> = {};
    const result = applyLaunchEnv({ userDataPath: directory }, env);

    expect(result.problems).toEqual(['line 1: not a NAME=value assignment']);
    // …and the rest of the file still applies.
    expect(env['PILOT_LOG_LEVEL']).toBe('debug');
  });

  it('strips one layer of quotes and keeps everything inside them', () => {
    const directory = stage(
      [
        'PILOT_LOCAL_MODEL="qwen2.5vl:7b"',
        "PILOT_CODEX_MODEL='gpt-5.5'",
        'PILOT_LOG_LEVEL=  debug  ',
        '',
      ].join('\n'),
    );
    const env: Record<string, string | undefined> = {};
    applyLaunchEnv({ userDataPath: directory }, env);

    expect(env['PILOT_LOCAL_MODEL']).toBe('qwen2.5vl:7b');
    expect(env['PILOT_CODEX_MODEL']).toBe('gpt-5.5');
    expect(env['PILOT_LOG_LEVEL']).toBe('debug');
  });

  it('lets the first of two assignments win, in the parse and in the mutation alike', () => {
    const directory = stage(['PILOT_LOG_LEVEL=debug', 'PILOT_LOG_LEVEL=info', ''].join('\n'));
    const env: Record<string, string | undefined> = {};
    const result = applyLaunchEnv({ userDataPath: directory }, env);

    expect(env['PILOT_LOG_LEVEL']).toBe('debug');
    expect(result.applied).toEqual(['PILOT_LOG_LEVEL']);
    expect(result.refused[0]?.reason).toContain('earlier line');
  });

  it('accepts `export NAME=value`, because that is what people paste', () => {
    const parsed = parseLaunchEnv('export PILOT_MODEL_PROFILE=codex\n', {});
    expect(parsed.applied).toEqual(['PILOT_MODEL_PROFILE']);
  });

  it('survives an unreadable file rather than stopping the launch', () => {
    const result = applyLaunchEnv(
      {
        userDataPath: '/somewhere',
        read: () => {
          throw new Error('EACCES');
        },
      },
      {},
    );
    expect(result.present).toBe(false);
  });
});
