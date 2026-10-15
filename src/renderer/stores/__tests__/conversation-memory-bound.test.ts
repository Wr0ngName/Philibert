/**
 * Does a long conversation stop growing in memory?
 *
 * It did not. Nothing capped the loaded message list — `addMessageTo` is a
 * bare `push`, and no constant in the app bounded it — so a conversation grew
 * for as long as the app ran, and every conversation ever opened stayed in
 * memory with it. Measured on a realistic mix (user text, assistant text, and
 * tool-use messages carrying file contents and patches) it costs ~1.8 KB a
 * message: ~21 MB for 12,000 messages, with the save allocating twice that
 * again on top, at the end of every turn.
 *
 * The fix has two halves and both are asserted here, because either alone is
 * useless or dangerous:
 *
 *  - the window: only the most recent messages are held, and the rest are
 *    fetched a page at a time;
 *  - the upsert: a write adds and replaces by id and never shortens the
 *    stored conversation, so forgetting part of it in memory cannot shorten
 *    the file. Trimming without that is the data-loss bug this app has
 *    already shipped once.
 *
 * Through the real stores, the real preload, the real IPC handlers and the
 * real ConversationService. Only Electron and the filesystem are faked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { ChatMessage } from '@shared/types';

vi.mock('node:fs', async () => (await import('./support/real-stack')).fakeFsModule());
vi.mock('electron', async () => (await import('./support/real-stack')).fakeElectronModule());
vi.mock('../../../main/utils/paths', () => ({
  getConversationsPath: () => '/conversations',
  isPathWithin: () => true,
}));
vi.mock('../../../main/utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));
vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { setupConversationIPC } from '../../../main/ipc/conversations';
import { ConversationService } from '../../../main/services/ConversationService';
import '../../../preload/preload';
import { CONSTANTS } from '../../constants/app';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import { startRealStack, settle, onDisk, unmountApp } from './support/real-stack';

const CONV = 'conv-growing';
const { WINDOW_SIZE, WINDOW_MAX } = CONSTANTS.CONVERSATION;

describe('a conversation that keeps growing', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let chatStore: ReturnType<typeof useChatStore>;

  beforeEach(async () => {
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
      setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    });

    store = useConversationsStore();
    chatStore = useChatStore();
    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';
    await store.loadConversationList();
    await settle();

    store.currentConversationId = CONV;
    chatStore.setCurrentConversation(CONV);
    sent = 0;
  });

  afterEach(() => {
    unmountApp();
  });

  function message(n: number): ChatMessage {
    return { id: `msg_${n}`, role: n % 2 ? 'assistant' : 'user', content: `message ${n}`, timestamp: 1000 + n };
  }

  /**
   * Talk for `turns` turns, saving at the end of each, as the app does.
   * `perTurn` messages a turn, which is what a turn with tool calls looks
   * like.
   *
   * Numbering continues across calls, so a second stretch of talking adds new
   * messages rather than re-sending the ids of the first — which an upsert
   * would (correctly) treat as edits, leaving the file unchanged while memory
   * grew. Returns the total sent so far.
   */
  let sent = 0;
  async function talk(turns: number, perTurn = 20): Promise<number> {
    for (let turn = 0; turn < turns; turn += 1) {
      for (let i = 0; i < perTurn; i += 1) {
        chatStore.messages.push(message(sent));
        sent += 1;
      }
      await store.saveCurrentConversation();
      await settle();
    }
    return sent;
  }

  it('stops growing in memory, while the file keeps everything', async () => {
    const total = await talk(120); // 2,400 messages

    expect(total).toBe(2400);
    // The whole point: the list on screen is bounded no matter how long the
    // conversation gets.
    expect(chatStore.messages.length).toBeLessThanOrEqual(WINDOW_MAX);
    // And nothing was lost by that.
    expect(onDisk(CONV)?.messages).toHaveLength(total);
    expect(onDisk(CONV)?.messages[0].id).toBe('msg_0');
    expect(onDisk(CONV)?.messages.at(-1)?.id).toBe(`msg_${total - 1}`);
  });

  it('keeps the newest messages, and accounts for the rest', async () => {
    const total = await talk(120);

    // What the user is looking at is the end of the conversation.
    expect(chatStore.messages.at(-1)?.id).toBe(`msg_${total - 1}`);
    // And the count of what is no longer held matches what was dropped.
    expect(chatStore.olderMessageCount + chatStore.messages.length).toBe(total);
  });

  it('trims only down to the window, and only once past the slack', async () => {
    // The slack matters: trimming at exactly the window size would trim on
    // every single save, including in the middle of a long turn.
    await talk(30); // 600 messages — past WINDOW_SIZE, under WINDOW_MAX
    expect(chatStore.messages).toHaveLength(600);
    expect(chatStore.olderMessageCount).toBe(0);

    await talk(60); // 1,800 total
    expect(chatStore.messages.length).toBeGreaterThanOrEqual(WINDOW_SIZE);
    expect(chatStore.messages.length).toBeLessThanOrEqual(WINDOW_MAX);
  });

  it('can still read back everything it forgot', async () => {
    const total = await talk(120);
    const held = chatStore.messages.length;

    // Page back to the beginning.
    let guard = 0;
    while (chatStore.olderMessageCount > 0 && guard < 20) {
      await store.loadEarlierMessages();
      guard += 1;
    }

    expect(chatStore.messages).toHaveLength(total);
    expect(chatStore.messages[0].id).toBe('msg_0');
    expect(chatStore.messages.length).toBeGreaterThan(held);
    // In order, with nothing repeated.
    const ids = chatStore.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(Array.from({ length: total }, (_, i) => `msg_${i}`));
  });

  it('leaves the window alone while the user is reading history', async () => {
    // Trimming removes rows above the viewport. At the tail that is invisible;
    // to someone scrolled back it would yank the page forward by the height of
    // everything dropped. The message list reports where the view is (asserted
    // against real scrolling in the browser suite); this is the store acting
    // on it.
    await talk(120);
    const held = chatStore.messages.length;

    chatStore.setTailPinned(CONV, false);
    await talk(20);

    expect(chatStore.messages.length).toBeGreaterThan(held);
    expect(chatStore.olderMessageCount + chatStore.messages.length)
      .toBe(onDisk(CONV)?.messages.length);
  });

  it('trims again once the view returns to the tail', async () => {
    await talk(120);
    chatStore.setTailPinned(CONV, false);
    await talk(40);
    const whileReading = chatStore.messages.length;
    expect(whileReading).toBeGreaterThan(WINDOW_MAX);

    chatStore.setTailPinned(CONV, true);
    await talk(1);

    expect(chatStore.messages.length).toBeLessThanOrEqual(WINDOW_MAX);
  });

  it('trims a conversation that is not on screen regardless', async () => {
    // Nothing is displaying it, so there is no view to disturb — and a
    // background turn is exactly where an untrimmed window would otherwise
    // sit forgotten.
    await talk(60);
    const buffered = [...chatStore.messages];
    chatStore.beginMessageBuffer(CONV);
    chatStore.setTailPinned(CONV, false);
    // Leave it: the buffer becomes its own copy, and the screen shows another.
    chatStore.setCurrentConversation('conv-elsewhere');
    chatStore.loadMessages([]);
    store.currentConversationId = 'conv-elsewhere';

    // A background turn ends and is written.
    const more = buffered.length;
    for (let i = 0; i < 1200; i += 1) {
      chatStore.getBufferedMessages(CONV)?.push(message(sent));
      sent += 1;
    }
    await store.saveConversation(CONV, chatStore.getBufferedMessages(CONV) ?? []);
    await settle();

    expect(chatStore.getBufferedMessages(CONV)?.length ?? 0).toBeLessThanOrEqual(WINDOW_MAX);
    expect(onDisk(CONV)?.messages.length).toBe(more + 1200);
  });

  it('does not trim away a turn that is still arriving', async () => {
    // A streaming message is being written into. Dropping it would strand
    // the text still to come.
    await talk(100); // 2,000 messages, so the next save would trim

    chatStore.startAssistantMessage(CONV);
    chatStore.appendChunk(CONV, 'still writing');
    const streamingId = chatStore.messages.at(-1)?.id;

    await store.saveCurrentConversation();
    await settle();

    expect(chatStore.messages.some((m) => m.id === streamingId)).toBe(true);
    expect(chatStore.messages.at(-1)?.content).toBe('still writing');
  });

  it('holds a bounded list after reopening a long conversation', async () => {
    const total = await talk(120);

    // Reopen it, as a restart or a switch back would.
    chatStore.loadMessages([]);
    await store.loadConversation(CONV);
    await settle();

    expect(chatStore.messages).toHaveLength(WINDOW_SIZE);
    expect(chatStore.olderMessageCount).toBe(total - WINDOW_SIZE);
    expect(chatStore.messages.at(-1)?.id).toBe(`msg_${total - 1}`);
  });

  it('costs a bounded amount per save, not the whole conversation', async () => {
    // The save used to carry the entire message list: a JSON round-trip to
    // strip reactivity, then another copy across IPC — ~42 MB of allocation
    // for a 12,000-message conversation, at the end of every turn. It now
    // carries the window.
    await talk(120);

    const sizes: number[] = [];
    const original = window.electron.conversation.update;
    (window.electron.conversation as { update: typeof original }).update = async (update) => {
      sizes.push(update.upsert.length);
      return original(update);
    };

    chatStore.messages.push(message(9999));
    await store.saveCurrentConversation();
    await settle();

    (window.electron.conversation as { update: typeof original }).update = original;

    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toBeLessThanOrEqual(WINDOW_MAX);
  });
});
