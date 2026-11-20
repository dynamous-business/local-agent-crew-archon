import { describe, expect, test } from 'bun:test';
import { composeBatchReply } from './batch-reply';

describe('composeBatchReply', () => {
  test('returns empty string for empty array', () => {
    expect(composeBatchReply([])).toBe('');
  });

  test.each([
    [['This is a regular message.'], 'This is a regular message.'],
    [['  Regular text with leading spaces.  '], 'Regular text with leading spaces.'],
    [['', '   ', 'Actual content here.', ''], 'Actual content here.'],
    [
      ['Here is the example:', '    print("hello")\n    print("bye")'],
      'Here is the example:\n\n---\n\n    print("hello")\n    print("bye")',
    ],
  ])('joins retained text with a separator, dropping blank blocks: %j', (messages, expected) => {
    expect(composeBatchReply(messages)).toBe(expected);
  });

  test('merges continuation chunks into one block before joining', () => {
    expect(
      composeBatchReply([
        { text: 'Intro' },
        { text: ' continued', continuesPreviousBlock: true },
        { text: '\n\nTail', continuesPreviousBlock: true },
        { text: 'Next block' },
      ])
    ).toBe('Intro continued\n\nTail\n\n---\n\nNext block');
  });

  test('preserves model prose that starts with a tool-indicator emoji', () => {
    // A non-emoji block alongside them rules out the all-filtered fallback: any
    // emoji-based filtering would silently drop the two paragraphs that start with emoji.
    const result = composeBatchReply([
      '📝 Notes: the retry is flaky.',
      'The answer is 42.',
      '🔍 Findings: nothing else to fix.',
    ]);
    expect(result).toBe(
      '📝 Notes: the retry is flaky.\n\n---\n\nThe answer is 42.\n\n---\n\n🔍 Findings: nothing else to fix.'
    );
  });
});
