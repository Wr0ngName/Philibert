/**
 * Streamed text must not be silently dropped.
 *
 * Distinct from every stuck-spinner fix: those were about the UI not learning
 * that a turn had ENDED. This is the opposite — the turn is running, text is
 * arriving, and it stops appearing.
 *
 * `startAssistantMessage` adds its message through `messageSink`, which
 * returns null for a conversation that is neither on screen nor buffering —
 * but it records `streamingMessageId` either way. So the message never exists
 * while the store believes it is streaming into it, and every `appendChunk`
 * after that updates nothing: the text accumulates only in
 * `currentStreamingContent`, which nothing renders.
 *
 * The realistic trigger is a chunk arriving after the buffer was released —
 * `endMessageBuffer` runs on turn end, and output can still arrive afterwards
 * (a background task's poll escalating into real model work, which the
 * appendChunk comment itself describes, or a turn that ended early).
 */

import { setActivePinia, createPinia } from 'pinia';
import { describe, it, expect, beforeEach } from 'vitest';

import { useChatStore } from '../chat';

const RUNNING = 'conv-running';
const VIEWED = 'conv-viewed';

describe('streamed text with nowhere to go', () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useChatStore();
  });

  /**
   * A turn ends in RUNNING while the user is looking at VIEWED, so the buffer
   * is released — then more output arrives for RUNNING.
   */
  function turnEndedOffScreen(): void {
    store.setCurrentConversation(RUNNING);
    store.addUserMessage('do the thing');
    store.startAssistantMessage(RUNNING);
    store.beginMessageBuffer(RUNNING);
    store.setCurrentConversation(VIEWED);
    store.loadMessages([]);
    // Turn end: the buffer is released, as onDone does.
    store.endMessageBuffer(RUNNING);
  }

  it('keeps text that arrives after the buffer was released', () => {
    turnEndedOffScreen();

    store.appendChunk(RUNNING, 'text the user never saw');

    // It has to be SOMEWHERE recoverable, not only in the streaming scratch
    // value that nothing renders and no save reads.
    const buffered = store.getBufferedMessages(RUNNING) ?? [];
    const text = buffered.map((m) => m.content).join('');
    expect(text).toContain('text the user never saw');
  });

  it('does not claim to be streaming into a message that does not exist', () => {
    turnEndedOffScreen();

    store.appendChunk(RUNNING, 'more output');

    const state = store.getConversationState(RUNNING);
    const buffered = store.getBufferedMessages(RUNNING) ?? [];
    if (state.streamingMessageId) {
      // If a streaming target is named, it must be a message that is really
      // there — otherwise every later chunk updates nothing.
      expect(buffered.some((m) => m.id === state.streamingMessageId)).toBe(true);
    }
  });

  it('keeps the conversation on screen unaffected', () => {
    turnEndedOffScreen();

    store.appendChunk(RUNNING, 'background output');

    // VIEWED is what the user is looking at; another conversation's turn must
    // not write into it.
    expect(store.messages).toHaveLength(0);
  });

  it('still streams normally into the conversation on screen', () => {
    // The ordinary path must be untouched.
    store.setCurrentConversation(RUNNING);
    store.addUserMessage('hello');
    store.startAssistantMessage(RUNNING);
    store.beginMessageBuffer(RUNNING);

    store.appendChunk(RUNNING, 'answer ');
    store.appendChunk(RUNNING, 'text');

    const last = store.messages[store.messages.length - 1];
    expect(last.content).toBe('answer text');
  });

  it('still streams into the buffer of a conversation off screen', () => {
    store.setCurrentConversation(RUNNING);
    store.addUserMessage('hello');
    store.startAssistantMessage(RUNNING);
    store.beginMessageBuffer(RUNNING);
    store.setCurrentConversation(VIEWED);
    store.loadMessages([]);

    store.appendChunk(RUNNING, 'arrives while away');

    const buffered = store.getBufferedMessages(RUNNING) ?? [];
    expect(buffered.map((m) => m.content).join('')).toContain('arrives while away');
  });
});
