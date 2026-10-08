/**
 * Which directory a conversation is saved as running in.
 *
 * A conversation is pinned to the directory its session was created in,
 * because the CLI keys session files by a CWD-derived path
 * (~/.claude/projects/<slugified-cwd>/<session-id>.jsonl) and a resume under a
 * different directory would not find them.
 *
 * The pin used to be unconditional (`existingConv?.workingDirectory || ...`),
 * so a conversation whose session had gone kept claiming its old directory
 * while actually running in the newly selected one — storage and execution
 * disagreeing, with the UI showing the change as though it had applied.
 */

import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ChatMessage, Conversation } from '../../../shared/types';

const OLD_DIR = '/home/user/old-project';
const NEW_DIR = '/home/user/new-project';
const CONV = 'conv-1';

const saved: Conversation[] = [];

vi.mock('../settings', () => ({
  useSettingsStore: () => ({ workingDirectory: NEW_DIR, setWorkingDirectory: vi.fn() }),
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  saved.length = 0;
  setActivePinia(createPinia());
  Object.defineProperty(window, 'electron', {
    value: {
      conversation: {
        save: vi.fn(async (conversation: Conversation) => { saved.push(conversation); return true; }),
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        delete: vi.fn(async () => true),
        search: vi.fn(async () => []),
      },
    },
    configurable: true,
    writable: true,
  });
});

function message(content: string): ChatMessage {
  return { id: 'm1', role: 'user', content, timestamp: Date.now() } as ChatMessage;
}

/** Seed a conversation already stored against the old directory. */
async function seedExisting(store: Awaited<ReturnType<typeof loadStore>>): Promise<void> {
  store.conversations.push({
    id: CONV,
    title: 'Existing',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workingDirectory: OLD_DIR,
  } as Conversation);
}

async function loadStore() {
  const { useConversationsStore } = await import('../conversations');
  return useConversationsStore();
}

describe('conversation working directory', () => {
  it('re-pins to the current directory when there is no session', async () => {
    // Nothing to lose: with no session there are no session files keyed to the
    // old path, so the directory the user chose is the one that applies.
    const store = await loadStore();
    await seedExisting(store);

    await store.saveConversation(CONV, [message('hello')]);

    expect(saved).toHaveLength(1);
    expect(saved[0].workingDirectory).toBe(NEW_DIR);
  });

  it('keeps the pinned directory once a session exists', async () => {
    // Moving it would orphan the session files and silently lose the context.
    const store = await loadStore();
    await seedExisting(store);
    store.setSdkSessionId(CONV, 'session-abc');

    await store.saveConversation(CONV, [message('hello')]);

    expect(saved).toHaveLength(1);
    expect(saved[0].workingDirectory).toBe(OLD_DIR);
  });

  it('reports the pinned directory for a session-bound conversation', async () => {
    const store = await loadStore();
    await seedExisting(store);
    store.setSdkSessionId(CONV, 'session-abc');

    expect(store.getConversationWorkingDirectory(CONV)).toBe(OLD_DIR);
  });

  it('reports a session only once one has been recorded', async () => {
    // This is the gate the UI notice keys off, so it has to be exact.
    const store = await loadStore();
    await seedExisting(store);
    store.currentConversationId = CONV;

    expect(store.currentConversationHasSession()).toBe(false);
    store.setSdkSessionId(CONV, 'session-abc');
    expect(store.currentConversationHasSession()).toBe(true);
  });
});
