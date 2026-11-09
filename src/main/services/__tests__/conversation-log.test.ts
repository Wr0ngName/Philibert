/**
 * A discussion's messages as an append-only log: what its lines play back
 * to, and what a write needs to know of it without its messages.
 */

import { describe, it, expect } from 'vitest';

import type { ChatMessage } from '../../../shared/types';
import { appendBatch, compactedLog, recordLine, replay, TranscriptState, type LogRecord } from '../conversation-log';

const msg = (id: string, content = `content ${id}`, role: ChatMessage['role'] = 'user'): ChatMessage => ({
  id, role, content, timestamp: 1,
});

/** A log of these records, appended in one batch each. */
const log = (...batches: LogRecord[][]) => batches.map((batch) => appendBatch(batch.map(recordLine))).join('');

describe('replay', () => {
  it('plays puts in order, a repeated id replacing where it stands', () => {
    const { messages } = replay(log([{ put: msg('a') }, { put: msg('b') }], [{ put: msg('a', 'edited') }, { put: msg('c') }]));

    expect(messages).toEqual([msg('a', 'edited'), msg('b'), msg('c')]);
  });

  it('cuts at a message and drops everything after it', () => {
    const { messages } = replay(log([{ put: msg('a') }, { put: msg('b') }, { put: msg('c') }], [{ cut: 'b' }, { put: msg('d') }]));

    expect(messages.map((m) => m.id)).toEqual(['a', 'd']);
  });

  it('ignores a cut at a message it does not have', () => {
    const { messages } = replay(log([{ put: msg('a') }], [{ cut: 'gone' }]));

    expect(messages.map((m) => m.id)).toEqual(['a']);
  });

  it('skips the unfinished line of a stopped write, and keeps every line after it', () => {
    // A batch starts on a line of its own, so the next one is whole even
    // though the stopped one never wrote its line end.
    const text = `${log([{ put: msg('a') }])}{"put":{"id":"b","con${log([{ put: msg('c') }])}`;

    const { messages, damaged } = replay(text);

    expect(messages.map((m) => m.id)).toEqual(['a', 'c']);
    expect(damaged).toBe(1);
  });

  it('counts a line that is JSON but no record as damage, not as a message', () => {
    const { messages, damaged } = replay('{"something":"else"}\n{"put":{"no":"id"}}\n');

    expect(messages).toEqual([]);
    expect(damaged).toBe(2);
  });

  it('is nothing for an empty file', () => {
    expect(replay('')).toMatchObject({ messages: [], damaged: 0 });
  });

  it('plays a retried batch over the start of itself to the same messages', () => {
    // A write retried after it failed part-way appends its whole batch again.
    const batch: LogRecord[] = [{ cut: 'b' }, { put: msg('x') }, { put: msg('y') }];
    const first = log([{ put: msg('a') }, { put: msg('b') }, { put: msg('c') }]);
    const stoppedPart = `\n${recordLine(batch[0])}\n${recordLine(batch[1]).slice(0, 10)}`;

    expect(replay(first + stoppedPart + log(batch)).messages).toEqual(replay(first + log(batch)).messages);
  });
});

describe('TranscriptState', () => {
  it('tells a message that changed from one stored as it is', () => {
    const state = new TranscriptState();
    expect(state.put(msg('a'), recordLine({ put: msg('a') }))).toBe('added');

    expect(state.put(msg('a'), recordLine({ put: msg('a') }))).toBe('unchanged');
    expect(state.put(msg('a', 'edited'), recordLine({ put: msg('a', 'edited') }))).toBe('changed');
  });

  it('knows the title the first user message gives', () => {
    const state = new TranscriptState();
    state.put(msg('a', 'an answer', 'assistant'), recordLine({ put: msg('a', 'an answer', 'assistant') }));
    expect(state.firstUserTitle).toBeUndefined();

    state.put(msg('q', 'the question'), recordLine({ put: msg('q', 'the question') }));
    state.put(msg('q2', 'a later question'), recordLine({ put: msg('q2', 'a later question') }));

    expect(state.firstUserTitle).toBe('the question');
  });

  it('forgets the title when a cut removes the first user message', () => {
    const state = new TranscriptState();
    state.put(msg('q', 'the question'), recordLine({ put: msg('q', 'the question') }));

    state.cut('q');

    expect(state.firstUserTitle).toBeUndefined();
    expect(state.size).toBe(0);
  });

  it('does not know the title of a later message that became the first user message', () => {
    // Its content is not kept here: the details keep the title they had.
    const state = new TranscriptState();
    state.put(msg('q', 'the question'), recordLine({ put: msg('q', 'the question') }));
    state.put(msg('q2', 'a later question'), recordLine({ put: msg('q2', 'a later question') }));

    const asAnswer = msg('q', 'the question', 'assistant');
    state.put(asAnswer, recordLine({ put: asAnswer }));

    expect(state.firstUserTitle).toBeUndefined();
    // And a message added later does not take its place.
    state.put(msg('q3', 'newest'), recordLine({ put: msg('q3', 'newest') }));
    expect(state.firstUserTitle).toBeUndefined();
  });
});

describe('compactedLog', () => {
  it('is one put per message, playing back to the same messages', () => {
    const messages = [msg('a'), msg('b', 'x', 'assistant')];

    const { text, state } = compactedLog(messages);

    expect(text.split('\n').filter(Boolean)).toHaveLength(2);
    expect(replay(text).messages).toEqual(messages);
    expect(state.records).toBe(2);
    expect(state.firstUserTitle).toBe('content a');
  });

  it('is an empty file for no message', () => {
    expect(compactedLog([]).text).toBe('');
  });
});
