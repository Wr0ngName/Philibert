/**
 * Where a note from Claude Code lands in the turn it arrives in — the model a
 * session starts on comes after the reply was started, empty, and before its
 * first word.
 *
 * Put after that empty reply, the note left the reply above it, written
 * there, with the turn's activity row under the note: two empty replies
 * around the note on screen, the text then filling the first.
 */

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { useChatStore } from '../chat';

const CONVERSATION = 'conv-notes';
const NOTE = 'Model: Opus 5.5 (chosen by Claude Code — no model pinned)';

let chat: ReturnType<typeof useChatStore>;

/** The discussion as on screen: role, text, and whether it is being written. */
function transcript(): string[] {
  return chat.messages.map((message) => `${message.role}${message.isStreaming ? '*' : ''}: ${message.content}`);
}

beforeEach(() => {
  setActivePinia(createPinia());
  chat = useChatStore();
  chat.setCurrentConversation(CONVERSATION);
  chat.loadMessages([{ id: 'question', role: 'user', content: 'Hello', timestamp: 1 }], 0);
});

describe('a note from Claude Code', () => {
  it('arriving before the reply\'s first word, goes above the reply, which is then written below it', () => {
    chat.startAssistantMessage(CONVERSATION);
    const arrivals = chat.arrivalCount(CONVERSATION);

    chat.addSystemMessage(NOTE);
    chat.appendChunk(CONVERSATION, 'Hi, I am Claude.');

    expect(transcript()).toEqual(['user: Hello', `system: ${NOTE}`, 'assistant*: Hi, I am Claude.']);
    expect(chat.arrivalCount(CONVERSATION)).toBe(arrivals + 1);
  });

  it('arriving once the reply is under way, closes what was written, and the rest is written below it', () => {
    chat.startAssistantMessage(CONVERSATION);
    chat.appendChunk(CONVERSATION, 'Before the note.');

    chat.addSystemMessage('Conversation compacted');
    chat.appendChunk(CONVERSATION, 'After it.');

    expect(transcript()).toEqual(['user: Hello', 'assistant: Before the note.', 'system: Conversation compacted', 'assistant*: After it.']);
  });

  it('arriving between turns, ends the discussion', () => {
    chat.addSystemMessage(NOTE);

    expect(transcript()).toEqual(['user: Hello', `system: ${NOTE}`]);
  });
});
