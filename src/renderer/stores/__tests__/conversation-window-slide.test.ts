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

import { mount } from '@vue/test-utils';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { IPC_CHANNELS, type ChatMessage, type Conversation } from '@shared/types';

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
import ChatWindow from '../../components/chat/ChatWindow.vue';
import ConversationSearch from '../../components/chat/ConversationSearch.vue';
import { CONSTANTS } from '../../constants/app';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';


import {
  startRealStack, settle, onDisk, files, unmountApp, mountApp, emitIpc, disk,
  releaseReads,
} from './support/real-stack';

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

    // A real second conversation to switch to. Without one on disk,
    // `loadConversation` fails and leaves the user where they were — so a
    // test that "switches away" switches nowhere, and the on-screen save path
    // quietly handles what was meant to exercise the background one. Two
    // tests here passed that way before this existed.
    files.set('/conversations/conv-elsewhere.json', JSON.stringify({
      id: 'conv-elsewhere',
      title: 'Somewhere else',
      messages: [{ id: 'other_0', role: 'user', content: 'elsewhere', timestamp: 1 }],
      createdAt: 1,
      updatedAt: 1,
      workingDirectory: '/home/user/project',
    } satisfies Conversation));

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
    if (loaded > 0 && anchor) await store.slideWindowAround(CONV, anchor);
    return loaded;
  }

  /** Read forward one page, anchored where the reader is: the bottom edge. */
  async function readForward(): Promise<number> {
    const anchor = chatStore.messages.at(-1)?.id;
    const loaded = await store.loadNewerMessages();
    await settle();
    if (loaded > 0 && anchor) await store.slideWindowAround(CONV, anchor);
    return loaded;
  }

  /**
   * The invariant: what is on screen is one unbroken range of the
   * conversation. Everything else in this file is a way of trying to break
   * it.
   */
  function expectContiguous(): void {
    const ids = chatStore.messages.map((m) => m.id);
    // The fixture numbers the stored conversation; a turn that really ran
    // carries generated ids. Those are legitimate, and they can only be at
    // the END — a live turn in the middle of the stored history would mean
    // the window had been stitched together out of order, so that is asserted
    // too rather than filtered away.
    const stored = ids.filter((id) => /^msg_\d+$/.test(id));
    const live = ids.filter((id) => !/^msg_\d+$/.test(id));
    expect(ids).toEqual([...stored, ...live]);

    const numbers = stored.map((id) => Number(id.replace('msg_', '')));
    const expected = Array.from(
      { length: numbers.length },
      (_unused, i) => numbers[0] + i,
    );
    expect(numbers).toEqual(expected);
  }

  /**
   * Read back until the newest messages have been unloaded, and say so if
   * that never happens.
   *
   * Stops the moment a page fails to arrive rather than grinding to a page
   * bound. The bound version was not wrong, it was expensive: with the tail
   * bookkeeping broken the premise never becomes true, so every test in the
   * block below ran ten page loads instead of three — each one a read and a
   * parse of the whole stored conversation through the real service — and the
   * suite went from seconds to over seven minutes. A premise that cannot be
   * met should fail on the first page, not the tenth.
   */
  async function readBackUntilTailUnloads(): Promise<number> {
    let pages = 0;
    while (chatStore.newerMessageCount === 0) {
      const olderBefore = chatStore.olderMessageCount;
      const loaded = await readBack();
      pages += 1;
      expect(loaded, `page ${pages} of history did not arrive`).toBeGreaterThan(0);
      expect(chatStore.olderMessageCount, `page ${pages} did not advance the window`)
        .toBeLessThan(olderBefore);
      expect(chatStore.messages.length).toBeLessThanOrEqual(WINDOW_MAX);
      // Three pages, by arithmetic: the window opens at WINDOW_SIZE and each
      // page adds WINDOW_SIZE, so the third is the one that takes the held
      // list past WINDOW_MAX and makes it slide. A fourth is slack for the
      // constants moving; ten was slack for nothing, and cost nine page
      // loads per test whenever the bookkeeping was broken.
      expect(pages, 'the tail never unloaded').toBeLessThanOrEqual(4);
    }
    return pages;
  }

  it('opens a long conversation as a window of its end', () => {
    expect(chatStore.messages).toHaveLength(WINDOW_SIZE);
    expect(chatStore.olderMessageCount).toBe(TOTAL - WINDOW_SIZE);
    expect(chatStore.newerMessageCount).toBe(0);
    expect(heldRange()).toEqual({ first: TOTAL - WINDOW_SIZE, last: TOTAL - 1 });
  });

  it('unloads the tail once reading back fills the window', async () => {
    expect(await readBackUntilTailUnloads()).toBeGreaterThan(0);

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

  describe('a stored conversation with a message id twice in it', () => {
    /**
     * The conversation is a JSON file on disk. A duplicate id in it is not a
     * state this app sets out to create, but it is a state the app can be
     * handed — a file edited by hand, a restore from a partial copy, a bug
     * elsewhere that shipped once — and paging must not then show the same
     * message twice. The window is supposed to be one unbroken range; a
     * duplicate makes it one unbroken range with a repeat in it, and the
     * repeat travels into the save.
     */
    beforeEach(async () => {
      const stored = onDisk(CONV)!;
      // Duplicate a message that sits in the page BEFORE the opening window,
      // so reading back is what pulls it in.
      const dupedAt = TOTAL - WINDOW_SIZE - 10;
      const messages = [...stored.messages];
      messages[dupedAt] = { ...messages[dupedAt], id: messages[dupedAt + 1].id };
      files.set(`/conversations/${CONV}.json`, JSON.stringify({ ...stored, messages }));

      chatStore.loadMessages([]);
      await store.loadConversation(CONV);
      await settle();
    });

    it('does not hold the same message twice when reading back', async () => {
      expect(await store.loadEarlierMessages()).toBeGreaterThan(0);
      await settle();

      const ids = chatStore.messages.map((m) => m.id);
      expect(new Set(ids).size, 'a message is held twice').toBe(ids.length);
    });

    it('does not hold the same message twice when reading forward', async () => {
      await readBackUntilTailUnloads();
      let guard = 0;
      while (chatStore.newerMessageCount > 0 && guard < 30) {
        await readForward();
        guard += 1;
        const ids = chatStore.messages.map((m) => m.id);
        expect(new Set(ids).size, 'a message is held twice').toBe(ids.length);
      }
    });
  });

  describe('a page that arrives after the window has moved', () => {
    /**
     * A page is requested against the window as it is NOW: the id at the edge
     * is the anchor, and the read is asynchronous. By the time it comes back
     * the window may be a different stretch of the conversation altogether —
     * the reader pressed "jump to latest", or reopened the conversation — and
     * applying the page then puts messages from one part of the conversation
     * on the end of another.
     *
     * Only a conversation switch was guarded. Same conversation, different
     * window, was not.
     */
    it('discards a page of history once the view has jumped to the end', async () => {
      await readBackUntilTailUnloads();
      const anchor = chatStore.messages[0].id;

      // Ask for the page, and hold the read so it is genuinely in flight.
      disk.holdReads = true;
      const inFlight = store.loadEarlierMessages();
      await settle();

      // Meanwhile the reader goes back to the end of the conversation.
      disk.holdReads = false;
      expect(await store.jumpToLatest()).toBe(true);
      await settle();
      const atTheEnd = chatStore.messages.map((m) => m.id);
      expect(chatStore.messages[0].id).not.toBe(anchor);

      // Now the page lands.
      disk.holdReads = false;
      await releaseReads();
      await inFlight;
      await settle();

      // It changed nothing: the window is still the end of the conversation.
      expect(chatStore.messages.map((m) => m.id)).toEqual(atTheEnd);
      expectContiguous();
      expect(accountedTotal()).toBe(TOTAL);
    });

    it('discards a page of the tail once the view has jumped to the end', async () => {
      await readBackUntilTailUnloads();
      const anchor = chatStore.messages.at(-1)?.id;

      disk.holdReads = true;
      const inFlight = store.loadNewerMessages();
      await settle();

      disk.holdReads = false;
      expect(await store.jumpToLatest()).toBe(true);
      await settle();
      const atTheEnd = chatStore.messages.map((m) => m.id);
      expect(chatStore.messages.at(-1)?.id).not.toBe(anchor);

      await releaseReads();
      await inFlight;
      await settle();

      expect(chatStore.messages.map((m) => m.id)).toEqual(atTheEnd);
      expectContiguous();
      expect(accountedTotal()).toBe(TOTAL);
    });
  });

  describe('rewinding a conversation that is held as a window', () => {
    /**
     * A rewind drops a user turn and everything after it, and has to say so
     * explicitly because a write cannot shorten the stored conversation on its
     * own. Both halves of that are dangerous with a window: the turn is found
     * in a list that may not be the window, and "everything before the turn"
     * is a thing the renderer may not be holding.
     */
    function userTurn(n: number, uuid: string): ChatMessage {
      return { ...message(n), role: 'user', turnUuid: uuid };
    }

    it('keeps the history the window is not holding', async () => {
      // Rewinding to the oldest turn ON SCREEN is not rewinding to the start
      // of the conversation. The survivor was taken as "the message before it
      // in memory", and at the top of a window there is none — which asked
      // for the whole conversation to be truncated, thousands of stored
      // messages included.
      const uuid = 'turn-at-the-top';
      chatStore.messages[0] = userTurn(
        Number(chatStore.messages[0].id.replace('msg_', '')), uuid,
      );
      const firstHeld = chatStore.messages[0].id;
      const rewoundNumber = Number(firstHeld.replace('msg_', ''));
      // Taken before the save, because the save legitimately changes it: the
      // window is refilled once the rewind lands, which moves messages from
      // the older count back onto the screen.
      const storedBeforeTheWindow = chatStore.olderMessageCount;
      expect(storedBeforeTheWindow).toBe(rewoundNumber);

      chatStore.truncateAfterUserTurn(CONV, uuid);
      await store.saveCurrentConversation();
      await settle();

      const saved = onDisk(CONV);
      // Everything before the window survives, and the rewound turn is gone.
      expect(saved?.messages.length).toBe(storedBeforeTheWindow);
      expect(saved?.messages[0].id).toBe('msg_0');
      expect(saved?.messages.some((m) => m.id === firstHeld)).toBe(false);
    });

    it('discards a turn held apart from the window too', async () => {
      // A rewind means "forget everything after this point", and a turn that
      // arrived while the window fell short of the end is after every message
      // in the window by definition. So it goes as well — otherwise the write
      // that carries the rewind also carries that turn, putting the messages
      // the rewind was told to forget straight back on the end of the file,
      // and the badge goes on offering a jump to them.
      //
      // A turn is unwritten from the moment it arrives until a write lands,
      // which is the state wanted here. Reaching it by failing a write would
      // say the same thing and cost the retry machinery — a pending save with
      // a thirty-second timeout outlives the test that started it and slows
      // every one after it. That path has its own test.
      await readBackUntilTailUnloads();
      chatStore.addMessage(message(TOTAL));
      // The premise: the turn really is held, and really is not on disk.
      expect(chatStore.detachedTurnFor(CONV)?.map((m) => m.id)).toEqual([`msg_${TOTAL}`]);
      expect(onDisk(CONV)?.messages.some((m) => m.id === `msg_${TOTAL}`)).toBe(false);

      const at = 100;
      const uuid = 'rewind-with-a-turn-pending';
      const n = Number(chatStore.messages[at].id.replace('msg_', ''));
      chatStore.messages[at] = userTurn(n, uuid);
      const rewound = chatStore.messages[at].id;

      chatStore.truncateAfterUserTurn(CONV, uuid);
      await store.saveCurrentConversation();
      await settle();

      // Gone from memory, and never written.
      expect(chatStore.detachedTurnFor(CONV)).toBeNull();
      const ids = onDisk(CONV)?.messages.map((m) => m.id) ?? [];
      expect(ids).not.toContain(`msg_${TOTAL}`);
      expect(ids).not.toContain(rewound);
      expect(ids.at(-1)).toBe(`msg_${n - 1}`);
      // And nothing is left claiming there is more to come back to.
      expect(chatStore.newerMessageCount).toBe(0);
    });

    it('persists a rewind that empties the window, even on the way out', async () => {
      // Rewinding the oldest turn on screen leaves nothing on screen, and the
      // save on the way out of a conversation was guarded on there being
      // something on screen to save. So the rewind went nowhere: the file
      // kept every message, and the next visit showed them all again.
      const uuid = 'turn-at-the-very-top';
      const n = Number(chatStore.messages[0].id.replace('msg_', ''));
      chatStore.messages[0] = userTurn(n, uuid);
      const rewound = chatStore.messages[0].id;

      chatStore.truncateAfterUserTurn(CONV, uuid);
      expect(chatStore.messages).toHaveLength(0);

      // Leave without saving by hand; switching away is the flush point.
      await store.switchConversation('conv-elsewhere');
      await settle();

      const ids = onDisk(CONV)?.messages.map((m) => m.id) ?? [];
      expect(ids).not.toContain(rewound);
      expect(ids.at(-1)).toBe(`msg_${n - 1}`);
      expect(ids).toHaveLength(n);
    });

    it('leaves the conversation readable after a rewind empties the window', async () => {
      // Rewinding the oldest turn ON SCREEN is not rewinding to the start of
      // the conversation: thousands of messages can still be stored in front
      // of it. The window is empty afterwards, and a page of history is
      // fetched against the id at the top of the window — so with no window
      // there is no anchor, and nothing can be loaded. The transcript shows
      // the empty state while the file holds thousands of messages.
      const uuid = 'turn-at-the-very-top';
      const n = Number(chatStore.messages[0].id.replace('msg_', ''));
      chatStore.messages[0] = userTurn(n, uuid);

      chatStore.truncateAfterUserTurn(CONV, uuid);
      await store.saveCurrentConversation();
      await settle();

      // The file kept everything before the rewind point.
      expect(onDisk(CONV)?.messages).toHaveLength(n);

      // And the user can see it: something is on screen, and the accounting
      // adds up against what is stored.
      expect(chatStore.messages.length).toBeGreaterThan(0);
      expect(accountedTotal()).toBe(n);
      expectContiguous();
      expect(chatStore.messages.at(-1)?.id).toBe(`msg_${n - 1}`);
    });

    it('cuts the file at the turn itself, not one message early', async () => {
      // The exact boundary, because being one out either way is invisible in
      // the transcript and permanent in the file: one short and the rewound
      // turn survives on disk and comes back; one long and the turn BEFORE it
      // is destroyed. Rewinding from the middle of the window, so there is a
      // predecessor to get wrong.
      const at = 200;
      const uuid = 'turn-in-the-middle';
      const n = Number(chatStore.messages[at].id.replace('msg_', ''));
      chatStore.messages[at] = userTurn(n, uuid);
      const predecessor = chatStore.messages[at - 1].id;
      const rewound = chatStore.messages[at].id;

      // What the write asks for, not only what the file ends up as. Asking to
      // cut one message early is invisible in the file: the over-truncated
      // message is still in the window being upserted, so the same write puts
      // it straight back. The contract is what has to be right.
      const asked: (string | undefined)[] = [];
      const original = window.electron.conversation.update;
      (window.electron.conversation as { update: typeof original }).update = async (u) => {
        asked.push(u.truncateFromId);
        return original(u);
      };

      chatStore.truncateAfterUserTurn(CONV, uuid);
      await store.saveCurrentConversation();
      await settle();

      (window.electron.conversation as { update: typeof original }).update = original;

      expect(asked).toEqual([rewound]);

      const saved = onDisk(CONV);
      const ids = saved?.messages.map((m) => m.id) ?? [];
      // The message before the rewound turn is the newest thing left.
      expect(ids.at(-1)).toBe(predecessor);
      expect(ids).not.toContain(rewound);
      // And exactly that much survived: everything up to and including it.
      expect(ids).toHaveLength(chatStore.olderMessageCount + at);
    });

    it('rewinds the transcript, not a turn held apart from it', async () => {
      // With a turn collected apart from the window, the list a rewind
      // searches must still be the transcript. Searching the detached turn
      // finds nothing and silently rewinds nothing at all.
      await readBackUntilTailUnloads();
      chatStore.addMessage(message(TOTAL));
      expect(chatStore.detachedTurnFor(CONV)).not.toBeNull();

      const uuid = 'turn-in-the-window';
      const at = chatStore.messages.length - 3;
      const n = Number(chatStore.messages[at].id.replace('msg_', ''));
      chatStore.messages[at] = userTurn(n, uuid);

      const heldBefore = chatStore.messages.length;
      chatStore.truncateAfterUserTurn(CONV, uuid);

      // The transcript really lost those turns.
      expect(chatStore.messages.length).toBe(heldBefore - 3);
      expect(chatStore.messages.some((m) => m.turnUuid === uuid)).toBe(false);
    });
  });

  describe('a turn arriving while the window falls short of the end', () => {
    beforeEach(async () => {
      await readBackUntilTailUnloads();
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

    it('never absorbs a turn into another conversation transcript', async () => {
      // The on-screen list belongs to whatever is on screen. Absorbing a
      // different conversation's turn into it would append that turn to the
      // wrong transcript — and the next save would write it there, putting
      // one conversation's messages inside another's file.
      chatStore.addMessage(message(TOTAL));
      expect(chatStore.detachedTurnFor(CONV)).not.toBeNull();

      await store.loadConversation('conv-elsewhere');
      await settle();
      const elsewhere = chatStore.messages.map((m) => m.id);
      expect(elsewhere).not.toHaveLength(0);

      chatStore.absorbDetachedTurn(CONV);

      // The transcript on screen is untouched, and the turn is still held
      // against the conversation it belongs to.
      expect(chatStore.messages.map((m) => m.id)).toEqual(elsewhere);
      expect(chatStore.detachedTurnFor(CONV)?.map((m) => m.id)).toEqual([`msg_${TOTAL}`]);
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

    it('does not leave the finished turn marked as still streaming', async () => {
      // The spinner is driven by a message's own isStreaming flag, and the
      // flag is cleared by walking the list the turn was written to. Walking
      // the window instead leaves a turn collected apart from it marked live
      // forever — and the write stores it that way, so reopening the
      // conversation shows a spinner for a turn that finished long ago.
      //
      // Asserted on the stored message and on the held turn, NOT on the list
      // after a reload: `loadMessages` strips the flag on the way in, which is
      // exactly why the first version of this test passed with the bug in.
      chatStore.startAssistantMessage(CONV);
      chatStore.appendChunk(CONV, 'an answer');
      chatStore.finishStreaming(CONV);

      expect(chatStore.detachedTurnFor(CONV)?.some((m) => m.isStreaming)).toBe(false);

      await store.saveCurrentConversation();
      await settle();

      expect(onDisk(CONV)?.messages.at(-1)?.content).toBe('an answer');
      expect(onDisk(CONV)?.messages.some((m) => m.isStreaming)).toBe(false);
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

    it('writes a turn that finished while the user was in another conversation', async () => {
      // The real turn-completion path, driven by the real IPC event through
      // the real useClaudeChat handlers — because that path decides what to
      // write for a conversation the user has left, and it decided it by
      // asking for a background buffer. A conversation whose window falls
      // short of the end keeps no buffer, so the answer was "nothing": the
      // whole turn was dropped on the floor with nothing logged and nothing
      // to say it had happened.
      mountApp(ChatWindow);
      await settle();

      chatStore.setLoading(CONV, true);
      chatStore.beginMessageBuffer(CONV);
      chatStore.startAssistantMessage(CONV);
      chatStore.appendChunk(CONV, 'the background answer');

      // The user walks away to another conversation, and THEN the turn ends.
      await store.loadConversation('conv-elsewhere');
      await settle();
      emitIpc(IPC_CHANNELS.CLAUDE_DONE, CONV);
      await settle();

      const saved = onDisk(CONV);
      expect(saved?.messages).toHaveLength(TOTAL + 1);
      expect(saved?.messages.at(-1)?.content).toBe('the background answer');
      // And it did not shorten the conversation to do it.
      expect(saved?.messages[0].id).toBe('msg_0');
    }, 15_000);
    // ^ mounts the whole app, drives real IPC and reads a 4,000-message
    // conversation several times: measured at ~2.1s on an idle machine, and
    // this suite runs in CI on a shared runner, so the 5s default leaves too
    // little headroom. Seven times the measurement — not a number picked to
    // make red go away, which is what 30s was: it came from a "flaky under
    // load" reading taken while three orphaned test workers of my own were
    // starving the machine.

    it('shows a turn that is still running when the user comes back to it', async () => {
      // Coming back mid-turn. `loadConversation` prefers whatever the
      // conversation is holding in memory to the saved file, because it is
      // more up to date — and it asked for the background buffer, which a
      // conversation whose window falls short of the end does not have. So
      // the reader came back to a window read fresh off disk with the turn
      // they were waiting on nowhere in it.
      mountApp(ChatWindow);
      await settle();

      chatStore.setLoading(CONV, true);
      chatStore.startAssistantMessage(CONV);
      chatStore.appendChunk(CONV, 'still writing');

      await store.loadConversation('conv-elsewhere');
      await settle();
      await store.loadConversation(CONV);
      await settle();

      expect(chatStore.messages.at(-1)?.content).toBe('still writing');
      expectContiguous();
      // Nothing is claimed to be missing after it, because nothing is.
      expect(chatStore.newerMessageCount).toBe(0);
    }, 15_000);
    // ^ mounts the whole app, drives real IPC and reads a 4,000-message
    // conversation several times: measured at ~2.1s on an idle machine, and
    // this suite runs in CI on a shared runner, so the 5s default leaves too
    // little headroom. Seven times the measurement — not a number picked to
    // make red go away, which is what 30s was: it came from a "flaky under
    // load" reading taken while three orphaned test workers of my own were
    // starving the machine.

    it('writes a turn still in flight when the app closes', async () => {
      // Closing the app is the other end of the same question: a turn that
      // never got to finish must still reach disk. Only conversations with a
      // background buffer were flushed, and a conversation whose window falls
      // short of the end has none — so its turn died with the process.
      mountApp(ChatWindow);
      await settle();

      chatStore.setLoading(CONV, true);
      chatStore.startAssistantMessage(CONV);
      chatStore.appendChunk(CONV, 'half an answer');

      // Away from it, so the on-screen save cannot be what rescues this.
      await store.loadConversation('conv-elsewhere');
      await settle();
      await store.cleanup();
      await settle();

      const saved = onDisk(CONV);
      expect(saved?.messages.at(-1)?.content).toBe('half an answer');
      expect(saved?.messages).toHaveLength(TOTAL + 1);
    }, 15_000);
    // ^ mounts the whole app, drives real IPC and reads a 4,000-message
    // conversation several times: measured at ~2.1s on an idle machine, and
    // this suite runs in CI on a shared runner, so the 5s default leaves too
    // little headroom. Seven times the measurement — not a number picked to
    // make red go away, which is what 30s was: it came from a "flaky under
    // load" reading taken while three orphaned test workers of my own were
    // starving the machine.

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

  // =========================================================================
  // A turn still running when the window has to let go of its end
  // =========================================================================
  //
  // Reading back, or opening a search hit, unloads the newest messages. While
  // a turn is writing into them that used to be refused outright — so the
  // window simply grew past its bound for as long as the turn ran — and the
  // obvious alternative, replacing the window, takes away the list the turn's
  // chunks and tool results look their messages up in. Both are tried here,
  // with the turn kept writing throughout, and judged by what reaches the
  // disk.
  describe('a turn still running when the window has to let go of its end', () => {
    beforeEach(async () => {
      mountApp(ChatWindow);
      await settle();
    });

    /** Start a turn the way sendMessage does, in its order. */
    function startTurn(prompt: string): void {
      chatStore.addUserMessage(prompt);
      chatStore.startAssistantMessage(CONV);
      chatStore.setLoading(CONV, true);
      chatStore.beginMessageBuffer(CONV);
    }

    function toolCall(blockId: string): void {
      chatStore.addAutoToolUseMessage(CONV, {
        toolUseBlockId: blockId, toolName: 'Read', input: {}, description: `read ${blockId}`,
      });
    }

    function toolResult(blockId: string): void {
      chatStore.updateToolUseResult(CONV, { toolUseBlockId: blockId, outputFile: `/out/${blockId}` });
    }

    async function endTurn(): Promise<void> {
      emitIpc(IPC_CHANNELS.CLAUDE_DONE, CONV);
      await settle(30);
    }

    /** The messages a turn really produced, as opposed to the fixture's. */
    function turnMessages(list: ChatMessage[]): ChatMessage[] {
      return list.filter((m) => !/^msg_\d+$/.test(m.id));
    }

    /** Everything the turn said, in order, across however many messages. */
    function turnText(list: ChatMessage[]): string {
      return turnMessages(list)
        .filter((m) => m.role === 'assistant' && !m.toolUse)
        .map((m) => m.content)
        .join('');
    }

    /** What is stored, checked for the things that must never happen. */
    function stored(): ChatMessage[] {
      const saved = onDisk(CONV)?.messages ?? [];
      const ids = saved.map((m) => m.id);
      expect(new Set(ids).size, 'a message is stored twice').toBe(ids.length);
      expect(saved[0]?.id, 'the file was shortened').toBe('msg_0');
      return saved;
    }

    it('keeps the window bounded when the reader reads back during the turn', async () => {
      startTurn('a question');
      chatStore.appendChunk(CONV, 'a ');
      // Scrolled away from the end, as the list reports. Left pinned, the
      // save made before holding the turn apart trims the window to its
      // newest messages by itself — which kept it small without the slide
      // ever letting go of the end, and hid a slide that never did.
      chatStore.setTailPinned(CONV, false);

      for (let page = 0; page < 4; page += 1) {
        expect(await readBack(), `page ${page} of history did not arrive`).toBeGreaterThan(0);
        expect(chatStore.messages.length).toBeLessThanOrEqual(WINDOW_MAX);
        expectContiguous();
        chatStore.appendChunk(CONV, `${page} `);
      }
      toolCall('tb-read-back');
      toolResult('tb-read-back');
      chatStore.appendChunk(CONV, 'end');
      expect(chatStore.newerMessageCount, 'the tail was never let go of').toBeGreaterThan(0);

      await endTurn();

      const saved = stored();
      expect(turnText(saved)).toBe('a 0 1 2 3 end');
      expect(saved.find((m) => m.toolUse?.toolUseBlockId === 'tb-read-back')?.toolUse?.outputFile)
        .toBe('/out/tb-read-back');
      expect(accountedTotal()).toBe(saved.length);
    }, 20_000);

    it('opens a search hit far back during the turn without holding more than a window', async () => {
      startTurn('a question');
      chatStore.appendChunk(CONV, 'before ');

      expect(await store.revealMessage(CONV, 'msg_100')).toBe(true);

      expect(chatStore.messages.some((m) => m.id === 'msg_100')).toBe(true);
      expect(chatStore.messages.length).toBeLessThanOrEqual(WINDOW_SIZE + 1);
      expectContiguous();
      // The turn is off screen, so none of it is in the window — and none of
      // it is unaccounted for either.
      expect(turnMessages(chatStore.messages).filter((m) => m.role === 'assistant')).toHaveLength(0);
      expect(accountedTotal()).toBe(TOTAL + 1 + (chatStore.detachedTurnFor(CONV)?.length ?? 0));

      chatStore.appendChunk(CONV, 'after ');
      toolCall('tb-search');
      toolResult('tb-search');
      chatStore.appendChunk(CONV, 'done');
      await endTurn();

      const saved = stored();
      expect(turnText(saved)).toBe('before after done');
      expect(saved.find((m) => m.toolUse?.toolUseBlockId === 'tb-search')?.toolUse?.outputFile)
        .toBe('/out/tb-search');
      expect(accountedTotal()).toBe(saved.length);
      expect(chatStore.detachedTurnFor(CONV)).toBeNull();

      // And reading forward comes back through all of it, the turn once.
      let guard = 0;
      while (chatStore.newerMessageCount > 0 && guard < 20) {
        await readForward();
        guard += 1;
        expectContiguous();
      }
      expect(chatStore.newerMessageCount).toBe(0);
      expect(turnText(chatStore.messages)).toBe('before after done');
      const ids = chatStore.messages.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }, 20_000);

    it('keeps every part of a turn that streams while the user is in another conversation', async () => {
      // The turn is held apart from the window, and switching away saves it
      // mid-turn. That save used to stop holding it — while it was still being
      // written — so everything it said afterwards had nowhere to go.
      await readBackUntilTailUnloads();
      startTurn('a question');
      chatStore.appendChunk(CONV, 'one ');

      expect(await store.switchConversation('conv-elsewhere')).toBe(true);
      await settle();
      chatStore.appendChunk(CONV, 'two ');
      toolCall('tb-away');
      toolResult('tb-away');
      chatStore.appendChunk(CONV, 'three');

      expect(await store.switchConversation(CONV)).toBe(true);
      await settle();
      await endTurn();

      const saved = stored();
      expect(turnText(saved)).toBe('one two three');
      expect(saved.find((m) => m.toolUse?.toolUseBlockId === 'tb-away')?.toolUse?.outputFile)
        .toBe('/out/tb-away');
    }, 20_000);

    it('changes nothing when the save it needs first does not land', async () => {
      startTurn('a question');
      chatStore.appendChunk(CONV, 'kept ');
      const before = chatStore.messages.map((m) => m.id);

      // Every attempt: the service retries a failed write, so failing one
      // write is not a failed save.
      disk.failWrites = true;
      expect(await store.revealMessage(CONV, 'msg_100')).toBe(false);

      expect(chatStore.messages.map((m) => m.id)).toEqual(before);
      expect(chatStore.detachedTurnFor(CONV)).toBeNull();
      // Told why, in the save's own words rather than a guess at them.
      expect(store.error).toMatch(/Failed to save conversation/);
      disk.failWrites = false;
      chatStore.appendChunk(CONV, 'still');
      await endTurn();
      expect(turnText(stored())).toBe('kept still');
    }, 20_000);

    it('shows the live turn, not a stale stored copy of it, on jumping back to the end', async () => {
      // Opening the hit stored the turn as far as it had got. Jumping back to
      // the end reads that copy off disk — and it is behind what is in memory.
      startTurn('a question');
      chatStore.appendChunk(CONV, 'a');
      expect(await store.revealMessage(CONV, 'msg_100')).toBe(true);
      chatStore.appendChunk(CONV, 'b');

      expect(await store.jumpToLatest()).toBe(true);
      await settle();

      expect(turnText(chatStore.messages)).toBe('ab');
      const ids = chatStore.messages.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(chatStore.newerMessageCount).toBe(0);

      chatStore.appendChunk(CONV, 'c');
      expect(turnText(chatStore.messages)).toBe('abc');
      await endTurn();
      expect(turnText(stored())).toBe('abc');
    }, 20_000);

    /**
     * Hold back the answer to one IPC read until the test lets it through.
     * The read itself happens at once, against the disk as it is then; only
     * its delivery waits — which is IPC latency, and the window in which the
     * conversation changes under a read already made.
     */
    function delayDelivery(method: 'getAround' | 'getNewer'): () => void {
      const api = window.electron.conversation as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      const original = api[method];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      api[method] = async (...args: unknown[]) => {
        const answer = await original(...args);
        await gate;
        return answer;
      };
      return () => {
        api[method] = original;
        release();
      };
    }

    it('re-reads the stretch around a hit when the turn ends while it is in flight', async () => {
      startTurn('a question');
      chatStore.appendChunk(CONV, 'x');
      expect(await store.revealMessage(CONV, 'msg_100')).toBe(true);
      expect(chatStore.detachedTurnFor(CONV)).not.toBeNull();

      // Read while the turn is held; delivered after it has ended and been
      // stored — so its count stops short of messages that are now stored.
      const deliver = delayDelivery('getAround');
      const opening = store.revealMessage(CONV, 'msg_3000');
      await settle(20);
      await endTurn();
      expect(chatStore.detachedTurnFor(CONV)).toBeNull();
      deliver();
      expect(await opening).toBe(true);
      await settle(20);

      const saved = stored();
      expectContiguous();
      expect(chatStore.messages.some((m) => m.id === 'msg_3000')).toBe(true);
      expect(accountedTotal()).toBe(saved.length);
    }, 20_000);

    it('discards a page of the tail when the turn ends while it is in flight', async () => {
      startTurn('a question');
      chatStore.appendChunk(CONV, 'y');
      // Outside the window the conversation opened with, so it is replaced and
      // the turn held apart; close enough to the end that a page reaches it.
      expect(await store.revealMessage(CONV, `msg_${TOTAL - 700}`)).toBe(true);
      expect(chatStore.detachedTurnFor(CONV)).not.toBeNull();

      const deliver = delayDelivery('getNewer');
      const reading = store.loadNewerMessages();
      await settle(20);
      await endTurn();
      deliver();
      await reading;
      await settle(20);

      const saved = stored();
      expectContiguous();
      expect(accountedTotal()).toBe(saved.length);
      // And the next page comes back through all of it, the turn once.
      let guard = 0;
      while (chatStore.newerMessageCount > 0 && guard < 10) {
        await readForward();
        guard += 1;
      }
      expect(chatStore.newerMessageCount).toBe(0);
      expect(turnText(chatStore.messages)).toBe('y');
      expect(accountedTotal()).toBe(saved.length);
    }, 20_000);

    it('never shows a held turn twice while reading forward through a long one', async () => {
      // A turn long enough that a page boundary falls inside the part of it
      // the save stored. A page running into it would put stale copies of
      // held messages in the window, alongside the held ones.
      startTurn('a long question');
      for (let n = 0; n < WINDOW_SIZE + 100; n += 1) toolCall(`tb-fwd-${n}`);
      chatStore.appendChunk(CONV, 'long');
      expect(await store.revealMessage(CONV, `msg_${TOTAL - 700}`)).toBe(true);
      const heldIds = new Set(chatStore.detachedTurnFor(CONV)!.map((m) => m.id));

      let guard = 0;
      while (chatStore.newerMessageCount > 0 && guard < 10) {
        await readForward();
        guard += 1;
        const held = chatStore.detachedTurnFor(CONV) ?? [];
        const both = chatStore.messages.filter((m) => held.some((h) => h.id === m.id));
        expect(both, 'a held message is also in the window').toEqual([]);
        expectContiguous();
      }
      expect(chatStore.newerMessageCount).toBe(0);
      const ids = chatStore.messages.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((id) => heldIds.has(id))).toHaveLength(heldIds.size);
    }, 20_000);

    it('stays accounted for when the turn ends while the save before opening a hit is held up', async () => {
      startTurn('a question');
      chatStore.appendChunk(CONV, 'x');

      disk.holdReads = true;
      const opening = store.revealMessage(CONV, 'msg_100');
      await settle();
      emitIpc(IPC_CHANNELS.CLAUDE_DONE, CONV);
      await settle();
      await releaseReads();
      await opening;
      await settle(30);

      const saved = stored();
      expect(turnText(saved)).toBe('x');
      expectContiguous();
      expect(accountedTotal()).toBe(saved.length);
      const ids = [...chatStore.messages, ...(chatStore.detachedTurnFor(CONV) ?? [])].map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }, 20_000);

    it('keeps a turn that came back on screen mid-turn writable after leaving again', async () => {
      // Held apart, then pulled back onto the end of the window by jumping
      // there while still running. Back in the window, it needs the window's
      // buffer again — without one, leaving the conversation a second time
      // left it nowhere to write.
      startTurn('a question');
      chatStore.appendChunk(CONV, 'one ');
      expect(await store.revealMessage(CONV, 'msg_100')).toBe(true);
      expect(await store.jumpToLatest()).toBe(true);
      await settle();
      chatStore.appendChunk(CONV, 'two ');

      expect(await store.switchConversation('conv-elsewhere')).toBe(true);
      await settle();
      chatStore.appendChunk(CONV, 'three ');
      toolCall('tb-again');
      toolResult('tb-again');
      chatStore.appendChunk(CONV, 'four');
      expect(await store.switchConversation(CONV)).toBe(true);
      await settle();
      await endTurn();

      const saved = stored();
      expect(turnText(saved)).toBe('one two three four');
      expect(saved.find((m) => m.toolUse?.toolUseBlockId === 'tb-again')?.toolUse?.outputFile)
        .toBe('/out/tb-again');
    }, 20_000);

    it('can hold a turn apart again after it started off screen and was brought back', async () => {
      // Started while the reader was far back, so held from its first chunk
      // and marked against the window it started from. Jumping to the end
      // puts it on screen — next to messages that window never held — and
      // opening a hit afterwards has to find where it starts all the same.
      chatStore.setTailPinned(CONV, false);
      await readBackUntilTailUnloads();
      startTurn('asked from far back');
      chatStore.appendChunk(CONV, 'one ');
      expect(chatStore.detachedTurnFor(CONV)).not.toBeNull();

      expect(await store.jumpToLatest()).toBe(true);
      await settle();
      chatStore.appendChunk(CONV, 'two ');

      expect(await store.revealMessage(CONV, 'msg_100')).toBe(true);
      expect(chatStore.detachedTurnFor(CONV)?.some((m) => m.role === 'assistant')).toBe(true);
      expectContiguous();
      chatStore.appendChunk(CONV, 'three');
      await endTurn();
      expect(turnText(stored())).toBe('one two three');
    }, 20_000);

    it('knows where the turn starts when it is marked loading before its first message', async () => {
      // The other order: loading set, then the first message started. The
      // turn must still be told apart from the history before it.
      chatStore.addUserMessage('a question');
      chatStore.setLoading(CONV, true);
      chatStore.beginMessageBuffer(CONV);
      chatStore.startAssistantMessage(CONV);
      chatStore.appendChunk(CONV, 'first ');

      expect(await store.revealMessage(CONV, 'msg_100')).toBe(true);
      expect(chatStore.detachedTurnFor(CONV)?.[0]?.role).toBe('assistant');
      expectContiguous();

      chatStore.appendChunk(CONV, 'second');
      await endTurn();
      expect(turnText(stored())).toBe('first second');
    }, 20_000);

    it('holds apart a turn that opened with a tool call', async () => {
      // The commonest opening of all. The turn's empty first message is
      // removed when the tool call arrives, so a turn marked by its first
      // message was marked by a message that no longer existed — and could
      // not be held apart at all.
      startTurn('a question');
      toolCall('tb-first');
      toolResult('tb-first');
      chatStore.appendChunk(CONV, 'then words');

      expect(await store.revealMessage(CONV, 'msg_100')).toBe(true);
      expect(chatStore.detachedTurnFor(CONV)?.[0]?.toolUse?.toolUseBlockId).toBe('tb-first');
      expectContiguous();

      chatStore.appendChunk(CONV, ' and more');
      await endTurn();
      const saved = stored();
      expect(turnText(saved)).toBe('then words and more');
      expect(saved.find((m) => m.toolUse?.toolUseBlockId === 'tb-first')?.toolUse?.outputFile)
        .toBe('/out/tb-first');
    }, 20_000);

    it('lets a long turn\'s first tool call still receive its result after a save trims the window', async () => {
      // At the end, so the save after a write trims the window back to its
      // newest messages — and a turn longer than that reaches back past
      // them. Its first tool call is still waiting on a result, found by
      // looking in the window.
      startTurn('a long question');
      for (let n = 0; n < WINDOW_MAX; n += 1) toolCall(`tb-cap-${n}`);
      expect(await store.saveCurrentConversation()).toBe(true);
      await settle();

      expect(chatStore.messages.some((m) => m.toolUse?.toolUseBlockId === 'tb-cap-0')).toBe(true);
      toolResult('tb-cap-0');
      await endTurn();
      expect(stored().find((m) => m.toolUse?.toolUseBlockId === 'tb-cap-0')?.toolUse?.outputFile)
        .toBe('/out/tb-cap-0');
    }, 20_000);

    it('brings a held turn back when nothing stored lies between it and the window', async () => {
      // The window ends exactly where the held turn begins, so a page read
      // forward comes back empty. That empty page is still the end of what
      // is stored — and so the moment the turn goes back on screen.
      startTurn('a question');
      chatStore.appendChunk(CONV, 'held ');
      expect(await store.saveCurrentConversation()).toBe(true);
      expect(chatStore.detachLiveTurn(CONV)).toBe(true);
      expect(chatStore.newerMessageCount).toBeGreaterThan(0);

      await readForward();

      expect(chatStore.newerMessageCount).toBe(0);
      expect(chatStore.detachedTurnFor(CONV)).toBeNull();
      expect(turnText(chatStore.messages)).toBe('held ');
      chatStore.appendChunk(CONV, 'back');
      await endTurn();
      expect(turnText(stored())).toBe('held back');
    }, 20_000);

    it('leaves a running turn on screen while the reader is reading it', async () => {
      // A turn long enough to fill the window on its own, read from inside.
      // Its end is what the reader is looking at; holding it apart would take
      // it off the screen under them.
      startTurn('a long question');
      for (let n = 0; n < WINDOW_MAX; n += 1) toolCall(`tb-long-${n}`);
      chatStore.appendChunk(CONV, 'reading');
      const inside = chatStore.messages.find((m) => m.toolUse?.toolUseBlockId === 'tb-long-100')!;
      // Scrolled up into it, as the list reports when the view leaves the end.
      chatStore.setTailPinned(CONV, false);

      await store.slideWindowAround(CONV, inside.id);

      expect(chatStore.detachedTurnFor(CONV)).toBeNull();
      expect(chatStore.messages.some((m) => m.id === inside.id)).toBe(true);
      expect(chatStore.messages.some((m) => m.isStreaming)).toBe(true);
      chatStore.appendChunk(CONV, ' on');
      await endTurn();
      expect(turnText(stored())).toBe('reading on');
    }, 20_000);

    it('puts the held turn back on screen when the stretch around a hit reaches it', async () => {
      startTurn('a question');
      chatStore.appendChunk(CONV, 'near ');
      expect(await store.revealMessage(CONV, 'msg_100')).toBe(true);

      // Close enough to the end that the stretch runs up to the held turn.
      expect(await store.revealMessage(CONV, `msg_${TOTAL - 50}`)).toBe(true);

      expect(chatStore.newerMessageCount).toBe(0);
      expect(chatStore.detachedTurnFor(CONV)).toBeNull();
      expect(turnText(chatStore.messages)).toBe('near ');
      expectContiguous();
      chatStore.appendChunk(CONV, 'end');
      await endTurn();
      expect(turnText(stored())).toBe('near end');
    }, 20_000);

    it('opens a search hit inside the running turn by going back to the end', async () => {
      // Stored in part by the save that held it apart, so search can find it
      // — but the stretch around it is read only up to the held turn.
      startTurn('a question');
      chatStore.appendChunk(CONV, 'findable');
      expect(await store.revealMessage(CONV, 'msg_100')).toBe(true);
      const inTurn = chatStore.detachedTurnFor(CONV)!.find((m) => m.role === 'assistant')!;

      expect(await store.revealMessage(CONV, inTurn.id)).toBe(true);

      expect(chatStore.messages.some((m) => m.id === inTurn.id)).toBe(true);
      expect(chatStore.newerMessageCount).toBe(0);
      expectContiguous();
      chatStore.appendChunk(CONV, ' still');
      await endTurn();
      expect(turnText(stored())).toBe('findable still');
    }, 20_000);

    it('holds apart a turn that starts while the stretch around a hit is being read', async () => {
      disk.holdReads = true;
      const opening = store.revealMessage(CONV, 'msg_100');
      await settle();

      startTurn('asked meanwhile');
      chatStore.appendChunk(CONV, 'live');
      await releaseReads();
      expect(await opening).toBe(true);
      await settle(20);

      expect(chatStore.messages.some((m) => m.id === 'msg_100')).toBe(true);
      expectContiguous();
      chatStore.appendChunk(CONV, ' more');
      await endTurn();
      expect(turnText(stored())).toBe('live more');
    }, 20_000);

    it('opens a search hit with no turn running, accounted to the message', async () => {
      expect(await store.revealMessage(CONV, 'msg_100')).toBe(true);

      expectContiguous();
      expect(chatStore.messages.some((m) => m.id === 'msg_100')).toBe(true);
      expect(chatStore.messages.length).toBeLessThanOrEqual(WINDOW_SIZE + 1);
      expect(accountedTotal()).toBe(TOTAL);
    });

    it('leaves a window that already holds the hit alone, without writing', async () => {
      const before = chatStore.messages.map((m) => m.id);
      const writes = disk.writes;

      expect(await store.revealMessage(CONV, `msg_${TOTAL - 5}`)).toBe(true);

      expect(chatStore.messages.map((m) => m.id)).toEqual(before);
      expect(disk.writes).toBe(writes);
    });

    it('changes nothing for a hit that is no longer stored', async () => {
      const before = chatStore.messages.map((m) => m.id);

      expect(await store.revealMessage(CONV, 'msg_gone')).toBe(false);

      expect(chatStore.messages.map((m) => m.id)).toEqual(before);
    });
  });

  // =========================================================================
  // Opening a search hit, the way the user does
  // =========================================================================
  //
  // The search modal itself, against the real search in the main process.
  // Clicking a hit outside the loaded window did nothing at all: nothing
  // loaded the stretch it was in, and the scroll was requested before the
  // conversation had even been switched to.
  describe('opening a search hit from the search box', () => {
    let search: ReturnType<typeof mount> | null = null;

    afterEach(() => {
      search?.unmount();
      search = null;
    });

    /** Search, wait out the debounce, and click the hit for `messageId`. */
    async function openHit(query: string, scope: 'current' | 'all', messageId: string): Promise<void> {
      search = mount(ConversationSearch, { props: { open: true }, attachTo: document.body });
      await settle();
      if (scope === 'all') {
        const all = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
          .find((b) => /all/i.test(b.textContent ?? ''));
        all?.click();
      }
      const input = document.body.querySelector<HTMLInputElement>('input')!;
      input.value = query;
      input.dispatchEvent(new Event('input'));
      // The search is debounced on a real timer.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await settle(20);

      const number = messageId.replace('msg_', '');
      const hit = [...document.body.querySelectorAll<HTMLButtonElement>('li button')]
        .find((b) => new RegExp(`message ${number}(?!\\d)`).test(b.textContent ?? ''));
      expect(hit, `no search result for ${messageId}`).toBeDefined();
      hit!.click();
      // Done when the scroll is requested — the last step, and only taken
      // once the hit is loaded. Waited for rather than counted in ticks: a
      // switch, a save and a read of a 4,000-message file take as many as
      // they take, and a fixed count failed one run in a few.
      await vi.waitFor(() => expect(chatStore.pendingScrollMessageId).toBe(messageId), {
        timeout: 5_000,
      });
    }

    it('loads the stretch around a hit that is not loaded, then asks to scroll to it', async () => {
      expect(chatStore.messages.some((m) => m.id === 'msg_123')).toBe(false);

      await openHit('message 123', 'current', 'msg_123');

      expect(chatStore.messages.some((m) => m.id === 'msg_123')).toBe(true);
      expect(chatStore.messages.length).toBeLessThanOrEqual(WINDOW_SIZE + 1);
      expect(chatStore.pendingScrollMessageId).toBe('msg_123');
      expectContiguous();
      expect(accountedTotal()).toBe(TOTAL);
    }, 20_000);

    it('switches to the hit conversation first, then loads, then asks to scroll', async () => {
      expect(await store.switchConversation('conv-elsewhere')).toBe(true);
      await settle();

      await openHit('message 123', 'all', 'msg_123');

      expect(store.currentConversationId).toBe(CONV);
      expect(chatStore.messages.some((m) => m.id === 'msg_123')).toBe(true);
      expect(chatStore.pendingScrollMessageId).toBe('msg_123');
      expectContiguous();
    }, 20_000);
  });
});
