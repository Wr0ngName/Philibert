import { describe, expect, it } from 'vitest';

import { TITLE_STORED_LENGTH, titleFromMessages } from '../conversation-title';

const user = (content: string) => ({ role: 'user' as const, content });

describe('titleFromMessages', () => {
  it('is the first message the person sent, whole', () => {
    const first = 'Look through the logs of the last three days and tell me what failed and why';
    expect(titleFromMessages([{ role: 'assistant', content: 'Hello' }, user(first), user('later')])).toBe(first);
  });

  it('puts a message on one line', () => {
    expect(titleFromMessages([user('  Fix the build\n\n  then\trun the tests  ')])).toBe('Fix the build then run the tests');
  });

  it('keeps no more of a pasted log than any list could show', () => {
    const title = titleFromMessages([user('x'.repeat(5000))]);
    expect(title).toBe(`${'x'.repeat(TITLE_STORED_LENGTH - 1)}…`);
    expect(titleFromMessages([user('x'.repeat(TITLE_STORED_LENGTH))])).toBe('x'.repeat(TITLE_STORED_LENGTH));
  });

  it('gives none before anything is said', () => {
    expect(titleFromMessages([])).toBeUndefined();
    expect(titleFromMessages([user('   \n ')])).toBeUndefined();
  });
});
