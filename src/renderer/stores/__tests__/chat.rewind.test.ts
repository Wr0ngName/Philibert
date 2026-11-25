/**
 * Rewind bookkeeping in the chat store.
 *
 * Two operations, both easy to get subtly wrong and both destructive if they
 * are:
 *
 *   - labelUserTurn pairs the uuid a turn was sent under with the message it
 *     belongs to. Pair it with the wrong message and a rewind restores the
 *     wrong turn — it writes files, so that is not recoverable from the app.
 *   - markRewound marks the turns a conversation rewind went back over. Mark
 *     one too few and the view shows as Claude's what it no longer has; one
 *     too many and a turn that still exists looks gone.
 */

import { setActivePinia, createPinia } from 'pinia';
import { describe, it, expect, beforeEach } from 'vitest';

import { useChatStore } from '../chat';

const CONV = 'conv-rewind';

describe('labelUserTurn', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('labels the message it names, not the newest one', () => {
    // The send resolves after its message was added, and a prompt sent into
    // the running turn can join the list in between. That prompt has no
    // checkpoint of its own (it is folded into the turn), so labelling "the
    // newest user message" would give it this turn's id.
    const store = useChatStore();
    store.setCurrentConversation(CONV);
    const sent = store.addUserMessage('started the turn');
    store.addUserMessage('sent into the turn');

    store.labelUserTurn(CONV, sent.id, 'uuid-1');

    expect(store.messages.filter((m) => m.role === 'user').map((m) => m.turnUuid)).toEqual([
      'uuid-1',
      undefined,
    ]);
  });

  it('labels each turn with its own id', () => {
    const store = useChatStore();
    store.setCurrentConversation(CONV);

    const first = store.addUserMessage('first');
    store.labelUserTurn(CONV, first.id, 'uuid-1');
    const second = store.addUserMessage('second');
    store.labelUserTurn(CONV, second.id, 'uuid-2');

    expect(store.messages.filter((m) => m.role === 'user').map((m) => m.turnUuid)).toEqual([
      'uuid-1',
      'uuid-2',
    ]);
  });

  it('never labels an assistant message', () => {
    const store = useChatStore();
    store.setCurrentConversation(CONV);
    const answer = store.addAssistantMessage('unprompted');

    store.labelUserTurn(CONV, answer.id, 'uuid-1');

    expect(store.messages[0].turnUuid).toBeUndefined();
  });

  it('does nothing for a message that is not there', () => {
    const store = useChatStore();
    store.setCurrentConversation(CONV);
    store.addUserMessage('prompt');

    expect(() => store.labelUserTurn(CONV, 'msg-gone', 'uuid-1')).not.toThrow();
    expect(store.messages[0].turnUuid).toBeUndefined();
  });

  it('does nothing for a conversation that is neither on screen nor buffered', () => {
    const store = useChatStore();
    store.setCurrentConversation(CONV);
    const prompt = store.addUserMessage('prompt');

    store.labelUserTurn('some-other-conversation', prompt.id, 'uuid-x');

    expect(store.messages[0].turnUuid).toBeUndefined();
  });
});

describe('markRewound', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  const RECORD = { at: 5000, files: { changed: ['a.ts'], insertions: 2, deletions: 1 } };

  function seed() {
    const store = useChatStore();
    store.setCurrentConversation(CONV);
    store.labelUserTurn(CONV, store.addUserMessage('turn one').id, 'uuid-1');
    store.addAssistantMessage('answer one');
    store.labelUserTurn(CONV, store.addUserMessage('turn two').id, 'uuid-2');
    store.addAssistantMessage('answer two');
    return store;
  }

  const marks = (store: ReturnType<typeof useChatStore>) => store.messages.map((m) => [m.content, m.rewoundAt]);

  it('marks the target turn and everything after it, keeping them, the turn with what the rewind did', () => {
    // The session resumes before that prompt: it goes, with all after it.
    const store = seed();

    expect(store.markRewound(CONV, 'uuid-2', RECORD)).toBe(true);

    expect(marks(store)).toEqual([['turn one', undefined], ['answer one', undefined], ['turn two', 5000], ['answer two', 5000]]);
    expect(store.messages[2].rewind).toEqual(RECORD);
    expect(store.messages.filter((m) => m.rewind)).toHaveLength(1);
    // Said to the next write, for the stored messages past the window.
    expect(store.pendingRewoundFor(CONV)).toEqual({ fromId: store.messages[2].id, at: 5000 });
  });

  it('can rewind to the very first turn, marking everything', () => {
    const store = seed();

    store.markRewound(CONV, 'uuid-1', RECORD);

    expect(store.messages.every((m) => m.rewoundAt === 5000)).toBe(true);
  });

  it('keeps the time a message was first rewound away, rewound again from further back', () => {
    const store = seed();
    store.markRewound(CONV, 'uuid-2', RECORD);

    store.markRewound(CONV, 'uuid-1', { at: 9000 });

    expect(marks(store)).toEqual([['turn one', 9000], ['answer one', 9000], ['turn two', 5000], ['answer two', 5000]]);
    expect(store.messages[2].rewind).toEqual(RECORD);
    expect(store.messages[0].rewind).toEqual({ at: 9000 });
  });

  it('is never a turn rewound away already: Claude Code no longer has it', () => {
    const store = seed();
    store.markRewound(CONV, 'uuid-1', RECORD);

    expect(store.markRewound(CONV, 'uuid-2', { at: 9000 })).toBe(false);
    expect(store.messages[2].rewind).toBeUndefined();
  });

  it('leaves the transcript alone for an unknown id', () => {
    // Better to show too much as Claude's than to grey turns on a bad id.
    const store = seed();

    expect(store.markRewound(CONV, 'uuid-nope', RECORD)).toBe(false);

    expect(store.messages.every((m) => m.rewoundAt === undefined)).toBe(true);
    expect(store.pendingRewoundFor(CONV)).toBeNull();
  });

  it('leaves the transcript alone for a conversation it does not track', () => {
    const store = seed();

    expect(store.markRewound('other-conversation', 'uuid-2', RECORD)).toBe(false);

    expect(store.messages.every((m) => m.rewoundAt === undefined)).toBe(true);
  });
});

describe('addAssistantMessage', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('adds a finished message that is not streaming', () => {
    // A GUI-handled command answers in full. Marking it as streaming would
    // leave the turn spinner running with nothing to finish it.
    const store = useChatStore();
    store.setCurrentConversation(CONV);

    const message = store.addAssistantMessage('## Status\n\nAll good.');

    expect(message.role).toBe('assistant');
    expect(message.isStreaming).toBeUndefined();
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].content).toContain('All good.');
  });
});
