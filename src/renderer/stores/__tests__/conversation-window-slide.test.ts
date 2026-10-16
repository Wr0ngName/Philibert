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

  /**
   * Every message in the conversation, counted once: what is on screen, plus
   * what is not, either side of it.
   *
   * It adds up because the three are disjoint — which is the invariant this
   * file exists to hold. While a turn could be stitched onto the end of the
   * window AND counted among the messages after it, this sum double-counted
   * and no honest version of it existed.
   */
  function accountedTotal(): number {
    return chatStore.messages.length
      + chatStore.olderMessageCount
      + chatStore.newerMessageCount;
  }

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
   * The invariant: what is on screen is one unbroken range of the
   * conversation. Everything else in this file is a way of trying to break
   * it.
   */
  function expectContiguous(): void {
    const numbers = chatStore.messages
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
    expect(accountedTotal()).toBe(TOTAL);
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

  describe('a turn arriving while the window falls short of the end', () => {
    beforeEach(async () => {
      let pages = 0;
      while (chatStore.newerMessageCount === 0 && pages < 10) {
        await readBack();
        pages += 1;
      }
      expect(chatStore.newerMessageCount).toBeGreaterThan(0);
    });

    it('keeps it out of the window rather than stitching it onto the end', () => {
      // The window ends hundreds of messages before the conversation does.
      // Appending an arrival to it would put message 4000 directly after
      // message 1500 — a list claiming to be a stretch of the conversation
      // while being nothing of the kind. It is held apart instead.
      chatStore.addMessage(message(TOTAL));

      expectContiguous();
      expect(chatStore.messages.some((m) => m.id === `msg_${TOTAL}`)).toBe(false);
      expect(chatStore.detachedTurnFor(CONV)?.map((m) => m.id)).toEqual([`msg_${TOTAL}`]);
    });

    it('counts it as something to come back to', () => {
      const newerBefore = chatStore.newerMessageCount;

      chatStore.addMessage(message(TOTAL));

      expect(chatStore.newerMessageCount).toBe(newerBefore + 1);
      expect(accountedTotal()).toBe(TOTAL + 1);
    });

    it('writes it, even though it is not in the window', async () => {
      chatStore.addMessage(message(TOTAL));
      await store.saveCurrentConversation();
      await settle();

      const saved = onDisk(CONV);
      expect(saved?.messages).toHaveLength(TOTAL + 1);
      expect(saved?.messages.at(-1)?.id).toBe(`msg_${TOTAL}`);
      // And nothing the window forgot was lost with it: the write carried
      // only the turn, and an upsert never shortens the file.
      expect(saved?.messages[0].id).toBe('msg_0');
      expect(saved?.messages[TOTAL - 1].id).toBe(`msg_${TOTAL - 1}`);
    });

    it('stops holding it once it is stored', async () => {
      chatStore.addMessage(message(TOTAL));
      expect(chatStore.detachedTurnFor(CONV)).not.toBeNull();
      const newerBefore = chatStore.newerMessageCount;

      await store.saveCurrentConversation();
      await settle();

      // Stored, so it is simply what follows the window now.
      expect(chatStore.detachedTurnFor(CONV)).toBeNull();
      expect(chatStore.newerMessageCount).toBe(newerBefore);
      expect(accountedTotal()).toBe(TOTAL + 1);
    });

    it('reaches it by reading forward, with nothing skipped', async () => {
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
      const ids = chatStore.messages.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('reaches it by jumping to the end, even before it is stored', async () => {
      chatStore.addMessage(message(TOTAL));

      expect(await store.jumpToLatest()).toBe(true);
      await settle();

      expect(chatStore.messages.at(-1)?.id).toBe(`msg_${TOTAL}`);
      expect(chatStore.newerMessageCount).toBe(0);
      expect(chatStore.detachedTurnFor(CONV)).toBeNull();
      expect(chatStore.messages.length).toBeLessThanOrEqual(WINDOW_MAX);
      expectContiguous();
    });

    it('puts it back on the end when the window catches up', async () => {
      // Reading forward all the way is the other way the two meet: the
      // window reaches the end of what is stored, and what was held apart
      // from it is exactly what comes next.
      chatStore.addMessage(message(TOTAL));
      const detached = chatStore.detachedTurnFor(CONV)?.length ?? 0;
      expect(detached).toBe(1);

      let guard = 0;
      while (chatStore.newerMessageCount > 0 && guard < 20) {
        await readForward();
        guard += 1;
      }

      expect(chatStore.detachedTurnFor(CONV)).toBeNull();
      expect(chatStore.messages.at(-1)?.id).toBe(`msg_${TOTAL}`);
      expectContiguous();
    });

    it('shows a turn that streamed in while the view was away', async () => {
      // A background turn: written while the reader is elsewhere in the
      // conversation, so none of it is on screen, and all of it has to be
      // there when they come back — with no spinner left running on it.
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

    it('comes back to the end of the conversation, all of it accounted for', async () => {
      // Leaving and returning. A conversation whose window falls short of the
      // end keeps no buffer — its turn is in `detachedTurn`, which outlives
      // the switch — so coming back reads the window afresh and lands at the
      // end, like opening it does. What must not happen is the thing that
      // did: the buffer restored as though it were the whole conversation,
      // with `newerCount` dropped to 0, so a window stopping hundreds of
      // messages short of the end was treated as the end — nothing said
      // otherwise and the badge that was the only way back was gone.
      const total = accountedTotal();

      chatStore.beginMessageBuffer(CONV);
      chatStore.addMessage(message(TOTAL));
      await store.saveCurrentConversation();
      await settle();

      await store.loadConversation('conv-elsewhere');
      await settle();
      await store.loadConversation(CONV);
      await settle();

      expect(accountedTotal()).toBe(total + 1);
      expectContiguous();
      // At the end, with the turn that ran while the view was away on it.
      expect(chatStore.messages.at(-1)?.id).toBe(`msg_${TOTAL}`);
      expect(chatStore.newerMessageCount).toBe(0);
      // And the whole conversation is still behind it, not lost.
      expect(chatStore.olderMessageCount).toBe(total + 1 - chatStore.messages.length);
    });

    it('keeps a turn that failed to be written', async () => {
      // A write that does not land must not take the turn with it. The window
      // was already stored, so there is nothing to retain there — the turn is
      // what is unwritten, and it stays held until a write succeeds.
      chatStore.addMessage(message(TOTAL));
      chatStore.retainUnsavedMessages(CONV, [...chatStore.messages]);

      expect(chatStore.detachedTurnFor(CONV)?.map((m) => m.id)).toEqual([`msg_${TOTAL}`]);
      // Still counted as something the reader has yet to see.
      expect(accountedTotal()).toBe(TOTAL + 1);

      // And a later write does store it.
      await store.saveCurrentConversation();
      await settle();
      expect(onDisk(CONV)?.messages.at(-1)?.id).toBe(`msg_${TOTAL}`);
      expect(chatStore.detachedTurnFor(CONV)).toBeNull();
    });

    it('stays one range however hard the window is trimmed', async () => {
      // The trim after a save drops the oldest messages, and it knows nothing
      // about turns held apart from the window. Whatever it drops, what is on
      // screen is still one unbroken range and everything is still counted.
      for (let n = 0; n < 5; n += 1) chatStore.addMessage(message(TOTAL + n));
      const total = accountedTotal();

      const dropped = chatStore.trimWindow(CONV, 10);

      expect(dropped).toBeGreaterThan(0);
      expect(chatStore.messages).toHaveLength(10);
      expectContiguous();
      expect(accountedTotal()).toBe(total);
    });
  });
});
