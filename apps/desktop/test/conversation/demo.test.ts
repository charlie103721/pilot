import { describe, expect, it } from 'vitest';
import { INTERACTION_STATES } from '@pilot/shared';
import { runConversationDemo } from '../../src/conversation/demo.js';

/**
 * The demo `docs/implementation.md` requires for PR-010: "replay a
 * fixture-driven conversation and ring-buffer telemetry".
 *
 * Asserted here as well as printed, so `pnpm demo:conversation` cannot rot
 * unnoticed between the merges that stop reading it.
 */

describe('conversation demo', () => {
  it('renders every interaction state', async () => {
    const result = await runConversationDemo();

    for (const state of INTERACTION_STATES) {
      expect(result.states).toContain(state);
    }
  });

  it('walks the four fixture conversations and the ring buffer', async () => {
    const result = await runConversationDemo();
    const text = result.lines.join('\n');

    for (const heading of [
      'a spoken question, answered',
      'the same question, typed',
      'interrupted mid-answer',
      'speech recognition fails',
      'developer diagnostics',
      'privacy check',
    ]) {
      expect(text).toContain(heading);
    }
  });

  it('shows the text box available in `error`', async () => {
    const result = await runConversationDemo();
    const line = result.lines.find((entry) => entry.trim().startsWith('error '));

    // The row for the `error` state in the first table. If it ever reads
    // "unavailable", the documented STT fallback is gone from the app.
    expect(line).toContain('available');
    expect(line).not.toContain('unavailable');
  });

  it('measures the §17 timings and prints them with units', async () => {
    const text = (await runConversationDemo()).lines.join('\n');

    expect(text).toMatch(/Speech to text\s+\d+\s+\d/);
    expect(text).toMatch(/Time to first token\s+\d+\s+\d+ ms/);
    expect(text).toMatch(/Time to first spoken sentence\s+\d+\s+\d+ ms/);
    expect(text).toMatch(/Image bytes\s+\d+\s+[\d.]+ KiB/);
  });

  it('finds no word of the conversation in any measured value', async () => {
    const result = await runConversationDemo();

    expect(result.conversationWords.length).toBeGreaterThan(10);
    const leaked = result.conversationWords.filter((word) =>
      new RegExp(`\\b${word}\\b`, 'i').test(result.diagnosticsText),
    );
    expect(leaked).toEqual([]);
    expect(result.lines.join('\n')).toContain('PASS');
  });
});
