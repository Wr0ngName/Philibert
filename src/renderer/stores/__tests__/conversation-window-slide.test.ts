/**
 * Reading back through a long conversation, and reading forward again.
 *
 * The window slides: paging back loads history at the front and unloads the
 * tail behind it, so the held list stays bounded however far back the reader
 * goes. Unloading the tail is the part with teeth — it means the loaded list
 * is no longer the end of the conversation, and everything that assumed it
 * was has to cope:
 *
 *  - a message arriving while the tail is unloaded must not be stitched onto
 *    the loaded list as though it followed it, and must still be saved;
 *  - paging forward has to come back through the messages that were unloaded,
 *    not skip them;
 *  - nothing may shorten the file, ever.
 *
 * Through the real stores, the real preload, the real IPC handlers and the
 * real ConversationService. Only Electron and the filesystem are faked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { ChatMessage, Conversation } from '@shared/types';

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

import { startRealStack, settle, onDisk, files, unmountApp } from './support/real-stack';

const CONV = 'conv-long';
const TOTAL = 4000;
const { WINDOW_SIZE, WINDOW_MAX } = CONSTANTS.CONVERSATION;

function message(n: number): ChatMessage {
  return {
    id: `msg_${n}`,
    role: n % 2 ? 'assistant' : 'user',
    content: `message ${n}`,
    timestamp: 1000 + n,
  };
}

describe('sliding the window through a long conversation', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let chatStore: ReturnType<typeof useChatStore>;

  beforeEach(async () => {
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
      setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
    });

    // A long conversation already on disk, rather than one talked into
    // existence: this is about opening something that has been going for a
    // while, which is when the window is a window at all.
    const conversation: Conversation = {
      id: CONV,
      title: 'A long conversation',
      messages: Array.from({ length: TOTAL }, (_unused, n) => message(n)),
      createdAt: 1000,
      updatedAt: 1000 + TOTAL,
      workingDirectory: '/home/user/project',
    };
    files.set(`/conversations/${CONV}.json`, JSON.stringify(conversation));

    store = useConversationsStore();
    chatStore = useChatStore();
    const settings = useSettingsStore();
    settings.config.workingDirectory = '/home/user/project';
    settings.config.apiKey = 'test-key';
    await store.loadConversationList();
    await settle();

    await store.loadConversation(CONV);
    await settle();
  });

  afterEach(() => {
    unmountApp();
  });

  /** Where the loaded window sits in the conversation, by message number. */
  function heldRange(): { first: number; last: number } {
    const number = (id: string | undefined) => Number((id ?? '').replace('msg_', ''));
    return {
      first: number(chatStore.messages[0]?.id),
      last: number(chatStore.messages.at(-1)?.id),
    };
  }

  /**
   * Read back one page and slide the window the way the message list does.
   *
   * The anchor is the message that was at the top of the window before the
   * page arrived, because that is where the reader is: the page is fetched
   * when the view reaches the top of what is loaded, and the list holds the
   * content still, so the row under the viewport afterwards is the one that
   * used to be first.
   *
   * It matters more than it looks. Anchoring on the middle of the window
   * instead — which is what this helper did first — made reading back go
   * round in circles: the band kept 500 rows above the middle, so every page
   * loaded was dropped again on the same call and the window oscillated
   * between the same two states forever.
   */
  async function readBack(): Promise<number> {
    const anchor = chatStore.messages[0]?.id;
    const loaded = await store.loadEarlierMessages();
    await settle();
    if (loaded > 0 && anchor && chatStore.messages.length > WINDOW_MAX) {
      chatStore.trimWindowAround(CONV, anchor, WINDOW_SIZE, WINDOW_SIZE);
    }
    return loaded;
  }

  /** Read forward one page, anchored where the reader is: the bottom edge. */
  async function readForward(): Promise<number> {
    const anchor = chatStore.messages.at(-1)?.id;
    const loaded = await store.loadNewerMessages();
    await settle();
    if (loaded > 0 && anchor && chatStore.messages.length > WINDOW_MAX) {
      chatStore.trimWindowAround(CONV, anchor, WINDOW_SIZE, WINDOW_SIZE);
    }
    return loaded;
  }

  /**
   * What is on screen is one unbroken stretch of the conversation.
   *
   * Asserted on `contiguousMessages`, which is what the message list renders:
   * the held list can legitimately carry a turn that arrived after the tail
   * was unloaded, and that turn belongs at the end of the conversation rather
   * than after the message it happens to sit behind in memory.
   */
  function expectContiguous(): void {
    const numbers = chatStore.contiguousMessages
      .map((m) => Number(m.id.replace('msg_', '')));
    const expected = Array.from(
      { length: numbers.length },
      (_unused, i) => numbers[0] + i,
    );
    expect(numbers).toEqual(expected);
  }

  it('opens a long conversation as a window of its end', () => {
    expect(chatStore.messages).toHaveLength(WINDOW_SIZE);
    expect(chatStore.olderMessageCount).toBe(TOTAL - WINDOW_SIZE);
    expect(chatStore.newerMessageCount).toBe(0);
    expect(heldRange()).toEqual({ first: TOTAL - WINDOW_SIZE, last: TOTAL - 1 });
  });

  it('unloads the tail once reading back fills the window', async () => {
    let pages = 0;
    while (chatStore.newerMessageCount === 0 && pages < 10) {
      expect(await readBack()).toBeGreaterThan(0);
      pages += 1;
      expect(chatStore.messages.length).toBeLessThanOrEqual(WINDOW_MAX);
    }

    expect(chatStore.newerMessageCount).toBeGreaterThan(0);
    expectContiguous();
    // Everything is still accounted for.
    expect(chatStore.messages.length
      + chatStore.olderMessageCount
      + chatStore.newerMessageCount).toBe(TOTAL);
  });

  it('reads forward through what it unloaded, rather than past it', async () => {
    while (chatStore.newerMessageCount === 0) await readBack();
    const { last } = heldRange();

    expect(await readForward()).toBeGreaterThan(0);
    expectContiguous();
    // The next page continues from where the window ended.
    expect(heldRange().first).toBeLessThanOrEqual(last + 1);
    expect(heldRange().last).toBeGreaterThan(last);
  });

  it('reads all the way back and all the way forward again', async () => {
    let guard = 0;
    while (chatStore.olderMessageCount > 0 && guard < 20) {
      await readBack();
      guard += 1;
      expectContiguous();
      expect(chatStore.messages.length).toBeLessThanOrEqual(WINDOW_MAX);
    }
    expect(heldRange().first).toBe(0);

    guard = 0;
    while (chatStore.newerMessageCount > 0 && guard < 20) {
      await readForward();
      guard += 1;
      expectContiguous();
      expect(chatStore.messages.length).toBeLessThanOrEqual(WINDOW_MAX);
    }
    expect(heldRange().last).toBe(TOTAL - 1);
    expect(chatStore.newerMessageCount).toBe(0);
  });

  describe('a message arriving while the tail is unloaded', () => {
    beforeEach(async () => {
      let pages = 0;
      while (chatStore.newerMessageCount === 0 && pages < 10) {
        await readBack();
        pages += 1;
      }
      expect(chatStore.newerMessageCount).toBeGreaterThan(0);
    });

    it('does not pretend the new message follows the loaded window', async () => {
      // The window ends hundreds of messages before the end of the
      // conversation. Pushing an arrival onto it would put message 4000
      // directly after message 1500 — a list that claims to be a stretch of
      // the conversation while being nothing of the kind, and the hole never
      // closes: the next page forward is fetched from the last held id, which
      // is now the new message, so everything in between becomes unreachable
      // without reopening the conversation.
      chatStore.addMessage(message(TOTAL));

      expectContiguous();
      // Held, so it is saved and nothing is lost — but not shown, because
      // what comes before it is not on screen.
      expect(chatStore.messages.some((m) => m.id === `msg_${TOTAL}`)).toBe(true);
      expect(chatStore.contiguousMessages.some((m) => m.id === `msg_${TOTAL}`))
        .toBe(false);
    });

    it('counts the new message as something to come back to', () => {
      const newerBefore = chatStore.newerMessageCount;

      chatStore.addMessage(message(TOTAL));

      expect(chatStore.newerMessageCount).toBe(newerBefore + 1);
    });

    it('saves the new message even though it is not on screen', async () => {
      chatStore.addMessage(message(TOTAL));
      await store.saveCurrentConversation();
      await settle();

      const saved = onDisk(CONV);
      expect(saved?.messages).toHaveLength(TOTAL + 1);
      expect(saved?.messages.at(-1)?.id).toBe(`msg_${TOTAL}`);
      // And nothing the window forgot was lost with it.
      expect(saved?.messages[0].id).toBe('msg_0');
    });

    it('reaches the new message by reading forward, with nothing skipped', async () => {
      chatStore.addMessage(message(TOTAL));
      await store.saveCurrentConversation();
      await settle();

      let guard = 0;
      while (chatStore.newerMessageCount > 0 && guard < 20) {
        await readForward();
        guard += 1;
        expectContiguous();
      }

      expect(chatStore.messages.at(-1)?.id).toBe(`msg_${TOTAL}`);
      expect(chatStore.newerMessageCount).toBe(0);
    });

    it('reaches it by jumping to the end too', async () => {
      chatStore.addMessage(message(TOTAL));
      await store.saveCurrentConversation();
      await settle();

      expect(await store.jumpToLatest()).toBe(true);
      await settle();

      expect(chatStore.messages.at(-1)?.id).toBe(`msg_${TOTAL}`);
      expect(chatStore.newerMessageCount).toBe(0);
      expect(chatStore.messages.length).toBeLessThanOrEqual(WINDOW_MAX);
      expectContiguous();
    });

    it('shows a turn that streamed in while the view was away', async () => {
      // A background turn: it is written while the reader is elsewhere in the
      // conversation, so none of it is on screen, and all of it has to be
      // there when they come back.
      chatStore.startAssistantMessage(CONV);
      chatStore.appendChunk(CONV, 'first half. ');
      chatStore.appendChunk(CONV, 'second half.');
      chatStore.finishStreaming(CONV);
      await store.saveCurrentConversation();
      await settle();

      expect(await store.jumpToLatest()).toBe(true);
      await settle();

      const last = chatStore.messages.at(-1);
      expect(last?.content).toBe('first half. second half.');
      expect(last?.isStreaming).toBeFalsy();
      expect(onDisk(CONV)?.messages.at(-1)?.content).toBe('first half. second half.');
    });
  });
});
