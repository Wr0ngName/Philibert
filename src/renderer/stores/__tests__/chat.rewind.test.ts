/**
 * Rewind bookkeeping in the chat store.
 *
 * Two operations, both easy to get subtly wrong and both destructive if they
 * are:
 *
 *   - labelUserTurn pairs the uuid a turn was sent under with the message it
 *     belongs to. Pair it with the wrong message and a rewind restores the
 *     wrong turn — it writes files, so that is not recoverable from the app.
 *   - truncateAfterUserTurn drops the turns a conversation rewind discarded.
 *     Drop one too few and the view shows history the model no longer has;
 *     one too many and the user loses a turn that still exists.
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

describe('truncateAfterUserTurn', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  function seed() {
    const store = useChatStore();
    store.setCurrentConversation(CONV);
    store.labelUserTurn(CONV, store.addUserMessage('turn one').id, 'uuid-1');
    store.addAssistantMessage('answer one');
    store.labelUserTurn(CONV, store.addUserMessage('turn two').id, 'uuid-2');
    store.addAssistantMessage('answer two');
    return store;
  }

  it('removes the target turn and everything after it', () => {
    // resumeSessionAt resumes *at* that prompt, so the prompt is about to be
    // replayed rather than kept.
    const store = seed();

    store.truncateAfterUserTurn(CONV, 'uuid-2');

    expect(store.messages.map((m) => m.content)).toEqual(['turn one', 'answer one']);
  });

  it('can rewind to the very first turn, leaving nothing', () => {
    const store = seed();

    store.truncateAfterUserTurn(CONV, 'uuid-1');

    expect(store.messages).toEqual([]);
  });

  it('leaves the transcript alone for an unknown id', () => {
    // Better to show too much than to delete turns on a bad id.
    const store = seed();

    store.truncateAfterUserTurn(CONV, 'uuid-nope');

    expect(store.messages).toHaveLength(4);
  });

  it('leaves the transcript alone for a conversation it does not track', () => {
    const store = seed();

    store.truncateAfterUserTurn('other-conversation', 'uuid-2');

    expect(store.messages).toHaveLength(4);
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
