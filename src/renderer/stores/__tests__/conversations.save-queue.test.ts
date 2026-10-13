/**
 * Saves must not be dropped.
 *
 * Reported as messages disappearing, "like if they are not persisted". They
 * were not: a save requested while another was in flight returned straight
 * away and did nothing, and nothing ever retried it.
 *
 * What makes that lossy rather than merely redundant is that the payload is
 * snapshotted synchronously — `buildConversationPayload` deep-clones the
 * message array through JSON — so the save already running carries the
 * messages as they were when IT started and can never include anything newer.
 * Drop the second request and everything written since the first snapshot
 * exists only in memory, until the message list is replaced by a conversation
 * switch or the window closes.
 *
 * Saves run at the end of every turn and immediately before a switch, so "a
 * save is already in flight" is the normal state at exactly the moment the
 * list is about to be replaced.
 */

import { setActivePinia, createPinia } from 'pinia';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { ChatMessage, Conversation } from '@shared/types';

import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../settings')>();
  return {
    ...actual,
    useSettingsStore: () => ({
      workingDirectory: '/home/user/project',
      executionMode: 'sdk',
      setWorkingDirectory: vi.fn(),
    }),
  };
});

vi.mock('../../constants/app', () => ({
  CONSTANTS: {
    CONVERSATION: {
      TITLE_MAX_LENGTH: 50,
      TITLE_TRUNCATE_LENGTH: 47,
      SAVE_TIMEOUT_MS: 10_000,
    },
    MESSAGES: { MAX_COUNT: 100 },
  },
}));

const CONV = 'conv-save-queue';

/** Saves captured at the boundary, with the deferred control over each one. */
interface CapturedSave {
  conversation: Conversation;
  release: () => void;
}

const saves: CapturedSave[] = [];

const mockElectron = {
  conversation: {
    list: vi.fn(),
    get: vi.fn(),
    save: vi.fn(),
    delete: vi.fn(),
  },
  config: { get: vi.fn(), set: vi.fn(), onChange: vi.fn(() => () => {}) },
  claude: { clearSessionPermissions: vi.fn() },
};

vi.stubGlobal('window', { electron: mockElectron });

/** Every message id persisted by any save, in the order the saves landed. */
function persistedIds(): string[][] {
  return saves.map((save) => save.conversation.messages.map((m) => m.id));
}

function message(id: string): ChatMessage {
  return { id, role: 'user', content: `content ${id}`, timestamp: Date.now() };
}

/** Let promise callbacks run without advancing to a save completing. */
async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe('concurrent saves', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let chatStore: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    saves.length = 0;

    mockElectron.conversation.list.mockResolvedValue([]);
    mockElectron.conversation.get.mockResolvedValue(null);
    mockElectron.conversation.delete.mockResolvedValue(undefined);
    mockElectron.config.get.mockResolvedValue({ workingDirectory: '/home/user/project' });
    mockElectron.config.set.mockResolvedValue(undefined);

    // Each save hangs until the test releases it, so "a save is in flight"
    // is something the test controls rather than races.
    mockElectron.conversation.save.mockImplementation((conversation: Conversation) => {
      return new Promise<void>((resolve) => {
        saves.push({ conversation, release: () => resolve() });
      });
    });

    store = useConversationsStore();
    chatStore = useChatStore();

    store.currentConversationId = CONV;
    chatStore.currentConversationId = CONV;
  });

  it('persists messages added while an earlier save was in flight', async () => {
    chatStore.messages.push(message('m1'));
    const first = store.saveCurrentConversation();
    await tick();
    expect(saves).toHaveLength(1);
    expect(saves[0].conversation.messages.map((m) => m.id)).toEqual(['m1']);

    // Arrives while the first save is still in flight. The snapshot above
    // cannot contain it — it was cloned before this existed.
    chatStore.messages.push(message('m2'));

    const second = store.saveCurrentConversation();
    await tick();

    saves[0].release();
    await first;
    await tick();
    saves.at(-1)?.release();
    await second;
    await tick();

    // The defect: the second request returned false without writing, so m2
    // was never persisted by anything.
    expect(persistedIds().some((ids) => ids.includes('m2'))).toBe(true);
  });

  it('persists the newest state, not a stale snapshot', async () => {
    chatStore.messages.push(message('m1'));
    const first = store.saveCurrentConversation();
    await tick();

    chatStore.messages.push(message('m2'));
    chatStore.messages.push(message('m3'));
    const second = store.saveCurrentConversation();
    await tick();

    saves[0].release();
    await first;
    await tick();
    saves.at(-1)?.release();
    await second;
    await tick();

    // Whatever the last write was, it must describe the conversation as it
    // actually stands. A save that persists a prefix is the data loss.
    expect(persistedIds().at(-1)).toEqual(['m1', 'm2', 'm3']);
  });

  it('coalesces a burst of requests rather than writing once per request', async () => {
    // Turn end, autosave and a switch can all ask within the same tick. They
    // must not each queue a write — one write covering the final state is both
    // correct and what the previous guard was trying to achieve.
    chatStore.messages.push(message('m1'));
    const first = store.saveCurrentConversation();
    await tick();

    chatStore.messages.push(message('m2'));
    const burst = [
      store.saveCurrentConversation(),
      store.saveCurrentConversation(),
      store.saveCurrentConversation(),
    ];
    await tick();

    saves[0].release();
    await first;
    await tick();
    saves.at(-1)?.release();
    await Promise.all(burst);
    await tick();

    expect(saves).toHaveLength(2);
    expect(persistedIds().at(-1)).toEqual(['m1', 'm2']);
  });

  it('does not resolve a queued save before it has been written', async () => {
    // `switchConversation` awaits the save and then replaces the message list.
    // If the promise resolves early, the switch discards the messages before
    // they reach disk — which is the loss this is all about.
    chatStore.messages.push(message('m1'));
    const first = store.saveCurrentConversation();
    await tick();

    chatStore.messages.push(message('m2'));
    let secondSettled = false;
    const second = store.saveCurrentConversation().then((result) => {
      secondSettled = true;
      return result;
    });
    await tick();

    expect(secondSettled).toBe(false);

    saves[0].release();
    await first;
    await tick();
    expect(saves).toHaveLength(2);
    saves[1].release();
    await second;

    expect(secondSettled).toBe(true);
  });

  it('keeps saving after one save fails', async () => {
    // A rejected write must not leave the queue wedged, or every later save
    // is silently dropped for the rest of the session.
    mockElectron.conversation.save.mockRejectedValueOnce(new Error('disk full'));

    chatStore.messages.push(message('m1'));
    expect(await store.saveCurrentConversation()).toBe(false);

    chatStore.messages.push(message('m2'));
    const next = store.saveCurrentConversation();
    await tick();
    saves.at(-1)?.release();

    expect(await next).toBe(true);
    expect(persistedIds().at(-1)).toEqual(['m1', 'm2']);
  });

  it('still refuses to save with nothing to save', async () => {
    expect(await store.saveCurrentConversation()).toBe(false);
    expect(saves).toHaveLength(0);
  });
});
