import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REDACTION_OPTIONS,
  REDACTED_URL_USERINFO,
  redactUrlCredentials,
  redactValue,
  scrubUrlCredentials,
} from '../src/index.js';

/**
 * `scrubUrlCredentials`, pinned (PR-041).
 *
 * The log redactor next door matches on the **key name**. That is a false
 * negative generator in both directions: runbook cross-lane issue 25 is the
 * side where it eats evidence, and this is the other side — a secret inside a
 * value, under a key name none of its patterns match, which it cannot see at
 * all. PR-041's audit found one live instance (a local endpoint's base URL) and
 * this is the fix it uses. The tests below are as much about what it must NOT
 * touch as about what it must.
 */

describe('scrubUrlCredentials', () => {
  it('replaces user information wherever a URL appears in a string', () => {
    expect(scrubUrlCredentials('http://pilot:s3cr3t@127.0.0.1:11434/v1')).toBe(
      `http://${REDACTED_URL_USERINFO}@127.0.0.1:11434/v1`,
    );
    expect(
      scrubUrlCredentials(
        'GET http://u:p@host:9/v1/models failed: cannot be constructed from http://u:p@host:9/v1/models',
      ),
    ).toBe(
      `GET http://${REDACTED_URL_USERINFO}@host:9/v1/models failed: cannot be constructed from http://${REDACTED_URL_USERINFO}@host:9/v1/models`,
    );
  });

  it('takes a user name without a password too', () => {
    expect(scrubUrlCredentials('https://token@api.example.com/v1')).toBe(
      `https://${REDACTED_URL_USERINFO}@api.example.com/v1`,
    );
  });

  it('leaves an ordinary URL exactly as it was, character for character', () => {
    for (const url of [
      'http://127.0.0.1:11434/v1',
      'https://api.example.com/v1/chat/completions?model=gpt-5.5',
      'http://localhost:8080',
    ]) {
      expect(scrubUrlCredentials(url)).toBe(url);
      expect(redactUrlCredentials(url)).toBe(url);
    }
  });

  it('does not mistake an @ after a path or in an address for user information', () => {
    // `[^/\s@]+` cannot cross a `/`, so a query value and a mail address are
    // both left alone. A scrubber that mangled either would be turned off.
    expect(scrubUrlCredentials('https://api.example.com/users?who=a@b.com')).toBe(
      'https://api.example.com/users?who=a@b.com',
    );
    expect(scrubUrlCredentials('write to someone@example.com')).toBe(
      'write to someone@example.com',
    );
    expect(scrubUrlCredentials('mailto:someone@example.com')).toBe('mailto:someone@example.com');
  });

  it('returns a string that is not a URL unchanged', () => {
    // The one diagnosis that quotes the address is "this did not parse as a
    // URL", and it needs the address.
    expect(scrubUrlCredentials('localhost:11434')).toBe('localhost:11434');
    expect(scrubUrlCredentials('')).toBe('');
  });

  it('catches what the name-keyed log redactor cannot', () => {
    // The regression this exists for: neither key name is a redaction pattern
    // and neither value is long or base64 enough to trip the value rules.
    const leaked = {
      endpoint: 'http://pilot:s3cr3t@127.0.0.1:11434/v1',
      line: 'model qwen2.5vl at http://pilot:s3cr3t@127.0.0.1:11434/v1 · vision probed ok',
    };
    const redacted = redactValue(leaked, DEFAULT_REDACTION_OPTIONS);
    expect(redacted.redactedPaths).toEqual([]);
    expect(JSON.stringify(redacted.value)).toContain('s3cr3t');

    const scrubbed = {
      endpoint: scrubUrlCredentials(leaked.endpoint),
      line: scrubUrlCredentials(leaked.line),
    };
    expect(JSON.stringify(scrubbed)).not.toContain('s3cr3t');
  });
});
