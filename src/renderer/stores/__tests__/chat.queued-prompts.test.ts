/**
 * Prompts held in the store while a turn runs.
 *
 * The queue is per conversation and is not part of the transcript: these
 * prompts have not been sent, so they must not appear in the messages the
 * conversation saves, and they must not leak between conversations.
 */

import { setActivePinia, createPinia } from 'pinia';
import { describe, it, expect, beforeEach } from 'vitest';

import { useChatStore } from '../chat';

const CONV_A = 'conv-a';
const CONV_B = 'conv-b';

describe('queued prompts', () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useChatStore();
  });

  it('queues a prompt for a conversation', () => {
    const queued = store.queuePrompt(CONV_A, 'do the thing');

    expect(queued).not.toBeNull();
    expect(queued?.content).toBe('do the thing');
    expect(store.getConversationState(CONV_A).queuedPrompts).toHaveLength(1);
  });

  it('trims the content it stores', () => {
    const queued = store.queuePrompt(CONV_A, '  padded  ');
    expect(queued?.content).toBe('padded');
  });

  it('refuses an empty prompt', () => {
    // Otherwise the queue could hold an entry sendMessage would later refuse,
    // which the user would then have to clear by hand.
    expect(store.queuePrompt(CONV_A, '   ')).toBeNull();
    expect(store.getConversationState(CONV_A).queuedPrompts).toHaveLength(0);
  });

  it('gives each queued prompt a distinct id', () => {
    // The remove button addresses them by id, so duplicates would delete the
    // wrong entry — and the same text being queued twice is entirely normal.
    const first = store.queuePrompt(CONV_A, 'same text');
    const second = store.queuePrompt(CONV_A, 'same text');
    expect(first?.id).not.toBe(second?.id);
  });

  it('keeps queues separate per conversation', () => {
    store.queuePrompt(CONV_A, 'for a');
    store.queuePrompt(CONV_B, 'for b');

    expect(store.getConversationState(CONV_A).queuedPrompts[0].content).toBe('for a');
    expect(store.getConversationState(CONV_B).queuedPrompts[0].content).toBe('for b');
  });

  it('exposes the current conversation s queue', () => {
    store.setCurrentConversation(CONV_A);
    store.queuePrompt(CONV_A, 'mine');
    store.queuePrompt(CONV_B, 'not mine');

    expect(store.queuedPrompts.map((p) => p.content)).toEqual(['mine']);
  });

  it('takes prompts oldest first', () => {
    store.queuePrompt(CONV_A, 'first');
    store.queuePrompt(CONV_A, 'second');

    expect(store.takeNextQueuedPrompt(CONV_A)?.content).toBe('first');
    expect(store.takeNextQueuedPrompt(CONV_A)?.content).toBe('second');
    expect(store.takeNextQueuedPrompt(CONV_A)).toBeNull();
  });

  it('takes nothing from a conversation it has never seen', () => {
    expect(store.takeNextQueuedPrompt('conv-unknown')).toBeNull();
  });

  it('removes one queued prompt by id', () => {
    const first = store.queuePrompt(CONV_A, 'first');
    store.queuePrompt(CONV_A, 'second');

    store.removeQueuedPrompt(CONV_A, first!.id);

    expect(store.getConversationState(CONV_A).queuedPrompts.map((p) => p.content)).toEqual([
      'second',
    ]);
  });

  it('ignores a removal for an id that is not queued', () => {
    store.queuePrompt(CONV_A, 'kept');
    store.removeQueuedPrompt(CONV_A, 'queued-nonexistent');
    expect(store.getConversationState(CONV_A).queuedPrompts).toHaveLength(1);
  });

  it('clears a conversation s queue', () => {
    store.queuePrompt(CONV_A, 'one');
    store.queuePrompt(CONV_A, 'two');

    store.clearQueuedPrompts(CONV_A);

    expect(store.getConversationState(CONV_A).queuedPrompts).toHaveLength(0);
  });

  it('puts a refused prompt back at the front', () => {
    // A send that never started a turn must not lose what the user wrote, and
    // must not reorder what they wrote after it.
    const taken = store.queuePrompt(CONV_A, 'first');
    store.queuePrompt(CONV_A, 'second');
    store.takeNextQueuedPrompt(CONV_A);

    store.restoreQueuedPrompt(CONV_A, taken!);

    expect(store.getConversationState(CONV_A).queuedPrompts.map((p) => p.content)).toEqual([
      'first',
      'second',
    ]);
  });

  it('keeps queued prompts out of the transcript', () => {
    // They have not been sent. A queued prompt in `messages` would be saved
    // and would show the user asking something they never asked.
    store.setCurrentConversation(CONV_A);
    store.queuePrompt(CONV_A, 'not asked yet');

    expect(store.messages).toHaveLength(0);
  });

  it('drops the queue when the conversation state is cleared', () => {
    store.queuePrompt(CONV_A, 'one');
    store.clearConversationState(CONV_A);
    expect(store.getConversationState(CONV_A).queuedPrompts).toHaveLength(0);
  });
});
