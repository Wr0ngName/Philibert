/**
 * Regression tests for the turn spinner outliving its turn.
 *
 * The spinner is driven by `group.messages.some(m => m.isStreaming)`, but
 * finishStreaming only ever cleared the single message tracked in
 * state.streamingMessageId. Any other message left streaming pinned the
 * spinner permanently — the turn was over, isLoading was false, and it kept
 * spinning anyway.
 */

import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach } from 'vitest';

import type { ChatMessage } from '@shared/types';

import { useChatStore } from '../chat';

const CONV = 'conv-1';

function streamingCount(messages: ChatMessage[]): number {
  return messages.filter((m) => m.isStreaming).length;
}

describe('chat store — streaming flag lifecycle', () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useChatStore();
    store.currentConversationId = CONV;
  });

  it('clears the streaming flag on every message, not just the tracked one', () => {
    const first = store.startAssistantMessage(CONV);
    // A second message ends up streaming without being the tracked one — e.g.
    // a turn that never completed before the next one began.
    store.addMessage({
      id: 'orphan-1',
      role: 'assistant',
      content: 'partial',
      timestamp: Date.now(),
      isStreaming: true,
    });
    expect(streamingCount(store.messages)).toBe(2);

    store.finishStreaming(CONV);

    expect(streamingCount(store.messages)).toBe(0);
    expect(store.messages.find((m) => m.id === first.id)?.isStreaming).toBe(false);
  });

  it('does not orphan the previous message when a new turn starts', () => {
    store.startAssistantMessage(CONV);
    store.appendChunk(CONV, 'first turn text');

    // Next turn begins without the previous one having finished.
    store.startAssistantMessage(CONV);

    // Only the newly started message may be streaming.
    expect(streamingCount(store.messages)).toBe(1);
    store.finishStreaming(CONV);
    expect(streamingCount(store.messages)).toBe(0);
  });

  it('leaves nothing streaming after a normal turn', () => {
    store.startAssistantMessage(CONV);
    store.appendChunk(CONV, 'hello');
    store.finishStreaming(CONV);

    expect(streamingCount(store.messages)).toBe(0);
  });

  // A conversation persisted mid-turn keeps isStreaming: true on disk.
  it('never restores a persisted streaming flag', () => {
    store.loadMessages([
      { id: 'm1', role: 'user', content: 'hi', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'partial', timestamp: 2, isStreaming: true },
    ]);

    expect(streamingCount(store.messages)).toBe(0);
  });
});
