/**
 * The list's end-of-discussion line saying when Claude was last heard from:
 * where it is left out, and the date it gains once its day is over.
 *
 * Real list, real stores, real sources. What goes through the whole app — the
 * events that move it, the save and the restart — is in
 * stores/__tests__/last-received.roundtrip.test.ts.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { ChatMessage } from '@shared/types';

import { useChatStore } from '../../../stores/chat';
import { lastReceivedInTranscript, lastReceivedLine } from '../../../utils/last-received';
import MessageList from '../MessageList.vue';
import { heldListSource } from '../message-list-source';

const NOW = new Date(2026, 10, 12, 23, 30).getTime();
const MINUTE = 60 * 1000;

const ANSWERED: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'build the feature', timestamp: NOW - 10 * MINUTE },
  { id: 'a1', role: 'assistant', content: 'Done.', timestamp: NOW - 9 * MINUTE },
];

let chat: ReturnType<typeof useChatStore>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  setActivePinia(createPinia());
  chat = useChatStore();
  chat.setCurrentConversation('conv-1');
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function line(wrapper: ReturnType<typeof mount>): string | null {
  const found = wrapper.find('.last-received');
  return found.exists() ? found.text() : null;
}

describe("the list's last-received line", () => {
  it('ends the discussion when Claude was heard from in it', () => {
    chat.loadMessages(ANSWERED);
    chat.noteReceived('conv-1', NOW - 5 * MINUTE);
    const wrapper = mount(MessageList, { attachTo: document.body });

    expect(line(wrapper)).toBe(lastReceivedLine(NOW - 5 * MINUTE, NOW, 0));
    wrapper.unmount();
  });

  it('is left out where the list stops short of the end of the discussion', () => {
    // Newer messages unloaded while reading back: the end of the list is the
    // middle of the discussion, not where the last arrival was.
    chat.loadMessages(ANSWERED, 0, 40);
    chat.noteReceived('conv-1', NOW - 5 * MINUTE);
    const wrapper = mount(MessageList, { attachTo: document.body });

    expect(line(wrapper)).toBeNull();
    wrapper.unmount();
  });

  it("ends an agent's transcript with when the agent was last heard from, not the discussion", () => {
    chat.noteReceived('conv-1', NOW - 2 * MINUTE);
    const source = heldListSource(() => ({
      key: 'agent-1', conversationId: 'conv-1', messages: ANSWERED, isLoading: false, workingDirectory: '',
      lastReceivedAt: lastReceivedInTranscript(ANSWERED),
    }));
    const wrapper = mount(MessageList, { props: { source }, attachTo: document.body });

    expect(line(wrapper)).toBe(lastReceivedLine(NOW - 9 * MINUTE, NOW, 0));
    wrapper.unmount();
  });

  it("is left out of an agent's transcript while the agent runs, as in a running discussion", () => {
    const source = heldListSource(() => ({
      key: 'agent-1', conversationId: 'conv-1', messages: ANSWERED, isLoading: true, workingDirectory: '',
      lastReceivedAt: lastReceivedInTranscript(ANSWERED),
    }));
    const wrapper = mount(MessageList, { props: { source }, attachTo: document.body });

    expect(line(wrapper)).toBeNull();
    wrapper.unmount();
  });

  it('adds the date once its day is over, with the window left open', async () => {
    chat.loadMessages(ANSWERED);
    chat.noteReceived('conv-1', NOW - 5 * MINUTE);
    const wrapper = mount(MessageList, { attachTo: document.body });
    const today = line(wrapper);

    // Past midnight: the same moment, now yesterday's.
    const afterMidnight = NOW + 31 * MINUTE;
    vi.setSystemTime(afterMidnight);
    vi.advanceTimersByTime(31 * MINUTE);
    await wrapper.vm.$nextTick();

    expect(line(wrapper)).toBe(lastReceivedLine(NOW - 5 * MINUTE, afterMidnight, 0));
    expect(line(wrapper)).not.toBe(today);
    wrapper.unmount();
  });
});

describe('noteReceived', () => {
  it('only ever moves the time forward', () => {
    chat.noteReceived('conv-1', NOW);
    // The saved time restored on opening, older than what this run heard.
    chat.noteReceived('conv-1', NOW - MINUTE);
    expect(chat.lastReceivedFor('conv-1')).toBe(NOW);

    chat.noteReceived('conv-1', NOW + MINUTE);
    expect(chat.lastReceivedFor('conv-1')).toBe(NOW + MINUTE);
  });

  it('is null for a conversation nothing has arrived in', () => {
    expect(chat.lastReceivedFor('conv-2')).toBeNull();
  });
});

describe("when an agent was last heard from, by its transcript", () => {
  const call = (id: string, at: number, completedAt?: number): ChatMessage => ({
    id, role: 'assistant', content: '', timestamp: at,
    toolUse: { actionId: id, toolName: 'Bash', description: 'Run', status: completedAt ? 'executed' : 'approved', ...(completedAt && { completedAt }) },
  });

  it("is a call's result coming back, after the call", () => {
    expect(lastReceivedInTranscript([ANSWERED[0], call('c1', NOW - 8 * MINUTE, NOW - 3 * MINUTE)])).toBe(NOW - 3 * MINUTE);
  });

  it('is the call itself while it runs', () => {
    expect(lastReceivedInTranscript([ANSWERED[0], call('c1', NOW - 8 * MINUTE)])).toBe(NOW - 8 * MINUTE);
  });

  it('is never what the agent was sent: its prompt, or a message written to it later', () => {
    const sentLater: ChatMessage = { id: 'u2', role: 'user', content: 'also check X', timestamp: NOW - MINUTE };
    expect(lastReceivedInTranscript([...ANSWERED, sentLater])).toBe(NOW - 9 * MINUTE);
    expect(lastReceivedInTranscript([ANSWERED[0]])).toBeNull();
  });
});
