import { describe, expect, it } from 'vitest';
import { FAKE_EPOCH_MS } from '@pilot/platform/fakes';
import { segmentSpeech, takeSpeakablePhrases } from '@pilot/interaction';

/**
 * PR-026 — the segmentation rule, as a table.
 *
 * system-design §7 says completed sentence fragments enter TTS; these tests fix
 * what "completed" means, case by case, including every case the rule
 * deliberately refuses to split.
 */

interface Case {
  readonly name: string;
  readonly buffer: string;
  readonly phrases: readonly string[];
  readonly remainder: string;
}

const SPLITS: readonly Case[] = [
  {
    name: 'a finished sentence followed by a space',
    buffer: 'That is the Auto Renew toggle. It renews',
    phrases: ['That is the Auto Renew toggle.'],
    remainder: 'It renews',
  },
  {
    name: 'question and exclamation marks',
    buffer: 'Is it on? Yes! Really?! Now what',
    phrases: ['Is it on?', 'Yes!', 'Really?!'],
    remainder: 'Now what',
  },
  {
    name: 'a closing quote after the terminator',
    buffer: 'She said "what is this?" and left. Then',
    phrases: ['She said "what is this?"', 'and left.'],
    remainder: 'Then',
  },
  {
    name: 'a newline, with no punctuation at all',
    buffer: 'Two things\nOpen Billing\n',
    phrases: ['Two things', 'Open Billing'],
    remainder: '',
  },
  {
    name: 'a lettered list, one marker per line',
    buffer: 'a) Open Billing\nb. Find the toggle\n',
    phrases: ['a) Open Billing', 'b. Find the toggle'],
    remainder: '',
  },
  {
    name: 'CJK terminators, which carry no trailing space',
    buffer: '这是自动续订开关。它每月续订。还有',
    phrases: ['这是自动续订开关。', '它每月续订。'],
    remainder: '还有',
  },
  {
    name: 'several sentences in one delta',
    buffer: 'One. Two. Three. ',
    phrases: ['One.', 'Two.', 'Three.'],
    remainder: '',
  },
];

const NON_SPLITS: readonly Case[] = [
  {
    name: 'a decimal',
    buffer: 'The timeout is 1.5 seconds',
    phrases: [],
    remainder: 'The timeout is 1.5 seconds',
  },
  {
    name: 'a dotted identifier',
    buffer: 'Look in config.json for the key',
    phrases: [],
    remainder: 'Look in config.json for the key',
  },
  {
    name: 'a dotted path with several segments',
    buffer: 'It is in packages/interaction/src/table.ts near the top',
    phrases: [],
    remainder: 'It is in packages/interaction/src/table.ts near the top',
  },
  {
    name: 'an abbreviation',
    buffer: 'Dr. Chen changed it',
    phrases: [],
    remainder: 'Dr. Chen changed it',
  },
  {
    name: 'a multi-dot abbreviation',
    buffer: 'That is fine, e.g. for a slow network',
    phrases: [],
    remainder: 'That is fine, e.g. for a slow network',
  },
  {
    name: 'initials',
    buffer: 'Written by J. R. R. Tolkien and friends',
    phrases: [],
    remainder: 'Written by J. R. R. Tolkien and friends',
  },
  {
    name: 'a numbered list marker',
    buffer: '1. Open Billing and find the toggle',
    phrases: [],
    remainder: '1. Open Billing and find the toggle',
  },
  {
    name: 'a roman-numeral list marker',
    buffer: 'iv. Confirm the change',
    phrases: [],
    remainder: 'iv. Confirm the change',
  },
  {
    name: 'an ellipsis',
    buffer: 'Wait... let me check that again',
    phrases: [],
    remainder: 'Wait... let me check that again',
  },
  {
    name: 'a unicode ellipsis inside a sentence',
    buffer: 'Hmm… let me look again',
    phrases: [],
    remainder: 'Hmm… let me look again',
  },
  {
    name: 'a terminator at the very end of the buffer, which is still ambiguous',
    buffer: 'Open config.',
    phrases: [],
    remainder: 'Open config.',
  },
  {
    name: 'text that never terminates at all',
    buffer: 'It looks like the Auto Renew toggle but I cannot be certain',
    phrases: [],
    remainder: 'It looks like the Auto Renew toggle but I cannot be certain',
  },
];

describe('segmentSpeech splits', () => {
  for (const row of SPLITS) {
    it(row.name, () => {
      expect(segmentSpeech(row.buffer)).toEqual({
        phrases: row.phrases,
        remainder: row.remainder,
      });
    });
  }
});

describe('segmentSpeech deliberately does not split', () => {
  for (const row of NON_SPLITS) {
    it(row.name, () => {
      expect(segmentSpeech(row.buffer)).toEqual({
        phrases: row.phrases,
        remainder: row.remainder,
      });
    });
  }
});

describe('segmentSpeech is streaming-safe', () => {
  /**
   * The property that matters most: feeding a text one character at a time must
   * produce the same phrases as feeding it all at once. A rule that depended on
   * how the provider happened to chop the stream would be untestable in
   * production.
   */
  const TEXTS = [
    'Dr. Chen set the timeout to 1.5 seconds in config.json. That is fine, e.g. for a slow network. ',
    'Two things:\n1. Open Billing.\n2. Turn off Auto Renew.\n',
    'Is it on? Yes! Wait... no. ',
  ];

  for (const [index, text] of TEXTS.entries()) {
    it(`is independent of delta boundaries (${String(index)})`, () => {
      const whole = segmentSpeech(text);
      const streamed: string[] = [];
      let buffer = '';
      for (const char of text) {
        buffer += char;
        const step = segmentSpeech(buffer);
        streamed.push(...step.phrases);
        buffer = step.remainder;
      }
      expect(streamed).toEqual(whole.phrases);
      expect(buffer).toEqual(whole.remainder);
    });
  }

  it('never invents or loses letters', () => {
    const text = 'One. Two? Three! Four';
    const { phrases, remainder } = segmentSpeech(text);
    const letters = (value: string): string => value.replace(/[^\p{L}\p{N}]/gu, '');
    expect(letters([...phrases, remainder].join(''))).toBe(letters(text));
  });
});

describe('takeSpeakablePhrases releases the tail', () => {
  const NOW = FAKE_EPOCH_MS;

  it('holds an unterminated tail while the stream is open', () => {
    const flush = takeSpeakablePhrases('It looks like the toggle', {
      now: NOW,
      pendingSince: null,
      phraseTimeoutMs: 1_000,
    });
    expect(flush.phrases).toEqual([]);
    expect(flush.remainder).toBe('It looks like the toggle');
    expect(flush.pendingSince).toBe(NOW);
    expect(flush.tailRelease).toBe('none');
  });

  it('releases the tail when the stream ends, however it looks', () => {
    const flush = takeSpeakablePhrases('It looks like the toggle', {
      now: NOW,
      pendingSince: NOW - 10,
      phraseTimeoutMs: 1_000,
      final: true,
    });
    expect(flush.phrases).toEqual(['It looks like the toggle']);
    expect(flush.remainder).toBe('');
    expect(flush.pendingSince).toBeNull();
    expect(flush.tailRelease).toBe('stream-end');
  });

  it('releases a tail that has waited longer than the phrase timeout', () => {
    const flush = takeSpeakablePhrases('Checking the billing page', {
      now: NOW + 1_000,
      pendingSince: NOW,
      phraseTimeoutMs: 1_000,
    });
    expect(flush.phrases).toEqual(['Checking the billing page']);
    expect(flush.tailRelease).toBe('timeout');
  });

  it('does not release a tail that has not waited long enough', () => {
    const flush = takeSpeakablePhrases('Checking the billing page', {
      now: NOW + 999,
      pendingSince: NOW,
      phraseTimeoutMs: 1_000,
    });
    expect(flush.phrases).toEqual([]);
    expect(flush.tailRelease).toBe('none');
    // The wait keeps running from where it started, not from this call.
    expect(flush.pendingSince).toBe(NOW);
  });

  it('restarts the wait for a tail left behind by a completed sentence', () => {
    const flush = takeSpeakablePhrases('All done. And then', {
      now: NOW + 5_000,
      pendingSince: NOW,
      phraseTimeoutMs: 1_000,
    });
    expect(flush.phrases).toEqual(['All done.']);
    expect(flush.remainder).toBe('And then');
    expect(flush.pendingSince).toBe(NOW + 5_000);
  });

  it('has nothing to release when the answer is empty', () => {
    const flush = takeSpeakablePhrases('   ', {
      now: NOW,
      pendingSince: NOW - 10_000,
      phraseTimeoutMs: 1_000,
      final: true,
    });
    expect(flush.phrases).toEqual([]);
    expect(flush.pendingSince).toBeNull();
  });
});
