/**
 * Which messages left for a running agent it has read: those its transcript
 * holds, as a message to it, from no earlier than they were sent.
 */

import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@shared/types';

import { type MessageToAgent, unreadMessagesToAgent } from '../agent-messages';

const SENT_AT = 1_000_000;

function sent(id: string, content: string, sentAt = SENT_AT): MessageToAgent {
  return { id, agentId: 'agent-1', content, sentAt };
}

function read(content: string, timestamp = SENT_AT + 5_000, role: ChatMessage['role'] = 'user'): ChatMessage {
  return { id: `${role}-${content}-${timestamp}`, role, content, timestamp };
}

const ids = (messages: MessageToAgent[]) => messages.map((message) => message.id);

describe('messages left for an agent', () => {
  it('are unread until its transcript holds them', () => {
    expect(ids(unreadMessagesToAgent([sent('a', 'Also check X')], [read('Its prompt', SENT_AT - 60_000)]))).toEqual(['a']);
  });

  it('are read once it does, the text as sent', () => {
    expect(unreadMessagesToAgent([sent('a', 'Also check X')], [read('Also check X')])).toEqual([]);
  });

  it('are not read by what the agent itself wrote', () => {
    expect(ids(unreadMessagesToAgent([sent('a', 'Also check X')], [read('Also check X', SENT_AT + 5_000, 'assistant')]))).toEqual(['a']);
  });

  it('are not read by the same text sent to it before', () => {
    expect(ids(unreadMessagesToAgent([sent('a', 'Go on')], [read('Go on', SENT_AT - 60_000)]))).toEqual(['a']);
  });

  it('are read by a reading stamped just before the app saw the call', () => {
    expect(unreadMessagesToAgent([sent('a', 'Go on')], [read('Go on', SENT_AT - 500)])).toEqual([]);
  });

  it('sent twice with the same text, are read one reading each', () => {
    expect(ids(unreadMessagesToAgent([sent('a', 'Go on'), sent('b', 'Go on', SENT_AT + 1)], [read('Go on')]))).toEqual(['b']);
  });

  it('are listed oldest first', () => {
    expect(ids(unreadMessagesToAgent([sent('b', 'Second', SENT_AT + 1), sent('a', 'First')], []))).toEqual(['a', 'b']);
  });
});
