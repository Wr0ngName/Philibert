/**
 * Rewind bookkeeping in the chat store.
 *
 * Two operations, both easy to get subtly wrong and both destructive if they
 * are:
 *
 *   - recordUserTurnUuid pairs Claude Code's transcript id with the message it
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

describe('recordUserTurnUuid', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('labels the newest user message', () => {
    const store = useChatStore();
    store.setCurrentConversation(CONV);
    store.addUserMessage('first');
    store.addUserMessage('second');

    store.recordUserTurnUuid(CONV, 'uuid-2');

    const users = store.messages.filter((m) => m.role === 'user');
    expect(users[0].turnUuid).toBeUndefined();
    expect(users[1].turnUuid).toBe('uuid-2');
  });

  it('labels each turn as it arrives', () => {
    const store = useChatStore();
    store.setCurrentConversation(CONV);

    store.addUserMessage('first');
    store.recordUserTurnUuid(CONV, 'uuid-1');
    store.addUserMessage('second');
    store.recordUserTurnUuid(CONV, 'uuid-2');

    expect(store.messages.filter((m) => m.role === 'user').map((m) => m.turnUuid)).toEqual([
      'uuid-1',
      'uuid-2',
    ]);
  });

  it('ignores a second id for a turn already labelled', () => {
    // The CLI can echo more than one user message per turn — tool results come
    // back the same way. Overwriting would retarget a turn the user may already
    // have selected in the rewind dialog.
    const store = useChatStore();
    store.setCurrentConversation(CONV);
    store.addUserMessage('only');

    store.recordUserTurnUuid(CONV, 'uuid-1');
    store.recordUserTurnUuid(CONV, 'uuid-stray');

    expect(store.messages[0].turnUuid).toBe('uuid-1');
  });

  it('skips over assistant messages to reach the user turn', () => {
    const store = useChatStore();
    store.setCurrentConversation(CONV);
    store.addUserMessage('prompt');
    store.addAssistantMessage('answer');

    store.recordUserTurnUuid(CONV, 'uuid-1');

    expect(store.messages.find((m) => m.role === 'user')?.turnUuid).toBe('uuid-1');
    expect(store.messages.find((m) => m.role === 'assistant')?.turnUuid).toBeUndefined();
  });

  it('does nothing when there is no user message yet', () => {
    const store = useChatStore();
    store.setCurrentConversation(CONV);
    store.addAssistantMessage('unprompted');

    expect(() => store.recordUserTurnUuid(CONV, 'uuid-1')).not.toThrow();
    expect(store.messages[0].turnUuid).toBeUndefined();
  });

  it('does nothing for a conversation that is neither on screen nor buffered', () => {
    const store = useChatStore();
    store.setCurrentConversation(CONV);
    store.addUserMessage('prompt');

    store.recordUserTurnUuid('some-other-conversation', 'uuid-x');

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
    store.addUserMessage('turn one');
    store.recordUserTurnUuid(CONV, 'uuid-1');
    store.addAssistantMessage('answer one');
    store.addUserMessage('turn two');
    store.recordUserTurnUuid(CONV, 'uuid-2');
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
