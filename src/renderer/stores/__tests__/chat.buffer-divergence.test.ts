/**
 * The background buffer must stay in step with the list on screen.
 *
 * A turn starts, the buffer is created, and from then on every update for
 * that conversation is written through `messageSink` — which returns the
 * on-screen list while the conversation is the one being viewed, and the
 * buffer only once it is not. So anything added while it was on screen landed
 * in `messages` and never in the buffer.
 *
 * That matters because the buffer is authoritative twice over: `loadConversation`
 * prefers it to the saved file when switching back ("they're more up-to-date
 * than the saved file"), and the turn's own completion saves it over that file.
 * A buffer missing the first half of a turn therefore makes those messages
 * vanish from the screen on switching back, and then deletes them from disk.
 */

import { setActivePinia, createPinia } from 'pinia';
import { describe, it, expect, beforeEach } from 'vitest';

import { useChatStore } from '../chat';

const A = 'conv-a';
const B = 'conv-b';

describe('background buffer and the on-screen list', () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useChatStore();
  });

  /** A turn begins in A, with A on screen — what `sendMessage` does. */
  function startTurnInA(): void {
    store.setCurrentConversation(A);
    store.addUserMessage('do the thing');
    store.startAssistantMessage(A);
    store.setLoading(A, true);
    store.beginMessageBuffer(A);
  }

  /** Leave A for B, the way `loadConversation` does it. */
  function switchToB(): void {
    store.setCurrentConversation(B);
    store.loadMessages([]);
  }

  it('keeps messages added while the conversation was on screen', () => {
    startTurnInA();

    // Claude calls a tool while the user is watching. This goes through the
    // sink, which returns the on-screen list because A is current.
    store.startAssistantMessage(A);

    switchToB();

    const buffered = store.getBufferedMessages(A);
    expect(buffered).not.toBeNull();
    // Three: the user's prompt, the first assistant message, and the one
    // added while A was on screen.
    expect(buffered).toHaveLength(3);
  });

  it('keeps collecting into the same history once the conversation is off screen', () => {
    startTurnInA();
    store.startAssistantMessage(A);
    switchToB();

    // The turn carries on in the background.
    store.startAssistantMessage(A);

    expect(store.getBufferedMessages(A)).toHaveLength(4);
  });

  it('does not let the background turn write into the conversation on screen', () => {
    startTurnInA();
    switchToB();

    store.startAssistantMessage(A);

    // B is what the user is looking at; A's turn must not appear in it.
    expect(store.messages).toHaveLength(0);
  });

  it('survives switching back and away again', () => {
    startTurnInA();
    store.startAssistantMessage(A);
    switchToB();
    store.startAssistantMessage(A);

    // Back to A mid-turn. loadConversation prefers the buffer, cloning it.
    store.setCurrentConversation(A);
    store.loadMessages(JSON.parse(JSON.stringify(store.getBufferedMessages(A))));
    expect(store.messages).toHaveLength(4);

    // More of the turn, now with A on screen again.
    store.startAssistantMessage(A);
    expect(store.messages).toHaveLength(5);

    // Away once more: the buffer has to carry all five, not the four it had
    // when it was last detached.
    switchToB();
    expect(store.getBufferedMessages(A)).toHaveLength(5);
  });

  it('releases the buffer when the turn ends', () => {
    startTurnInA();
    store.endMessageBuffer(A);
    expect(store.getBufferedMessages(A)).toBeNull();
  });

  it('leaves the on-screen list intact when the buffer is released', () => {
    // The buffer and the on-screen list are the same array while the
    // conversation is current, so releasing one must not empty the other.
    startTurnInA();
    const before = store.messages.length;

    store.endMessageBuffer(A);

    expect(store.messages).toHaveLength(before);
  });
});
