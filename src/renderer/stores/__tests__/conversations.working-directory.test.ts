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
 *
 * Asserted against what is actually on disk, through the real store, the real
 * preload and the real main-process ConversationService. It used to assert
 * against a hand-written fake of our own `window.electron.conversation`, which
 * can only ever confirm that the store called the function the test wrote —
 * not that a conversation is stored against the right directory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { ChatMessage, Conversation } from '@shared/types';

const OLD_DIR = '/home/user/old-project';
const NEW_DIR = '/home/user/new-project';
const CONV = 'conv-1';

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

// Imported after the mocks; importing the preload is what exposes the API.
import { ConversationService } from '../../../main/services/ConversationService';
import '../../../preload/preload';
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import { startRealStack, onDisk, settle, files, unmountApp } from './support/real-stack';

let store: ReturnType<typeof useConversationsStore>;

beforeEach(async () => {
  await startRealStack({
    ConversationService: ConversationService as unknown as new () => never,
    workingDirectory: NEW_DIR,
  });

  store = useConversationsStore();
  useChatStore();
  const settings = useSettingsStore();
  settings.config.workingDirectory = NEW_DIR;
  settings.config.apiKey = 'test-key';

  await store.loadConversationList();
  await settle();
});

afterEach(() => {
  unmountApp();
});

function message(content: string): ChatMessage {
  return { id: `m-${content}`, role: 'user', content, timestamp: Date.now() };
}

/** A conversation already stored against the old directory. */
async function seedExisting(): Promise<void> {
  const stored: Conversation = {
    id: CONV,
    title: 'Existing',
    messages: [message('earlier')],
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
    workingDirectory: OLD_DIR,
  };
  files.set(`/conversations/${CONV}.json`, JSON.stringify(stored));
  await store.loadConversationList();
  await settle();
}

describe('conversation working directory', () => {
  it('re-pins to the current directory when there is no session', async () => {
    // Nothing to lose: with no session there are no session files keyed to the
    // old path, so the directory the user chose is the one that applies.
    await seedExisting();

    await store.saveConversation(CONV, [message('hello')]);
    await settle();

    expect(onDisk(CONV)?.workingDirectory).toBe(NEW_DIR);
  });

  it('keeps the pinned directory once a session exists', async () => {
    // Moving it would orphan the session files and silently lose the context.
    await seedExisting();
    store.setSdkSessionId(CONV, 'session-abc');

    await store.saveConversation(CONV, [message('hello')]);
    await settle();

    expect(onDisk(CONV)?.workingDirectory).toBe(OLD_DIR);
  });

  it('does not lose the stored history when it re-pins', async () => {
    // The write carries only what the renderer holds, so a conversation
    // saved with one message must not come back with one message.
    await seedExisting();

    await store.saveConversation(CONV, [message('hello')]);
    await settle();

    expect(onDisk(CONV)?.messages.map((m) => m.content)).toEqual(['earlier', 'hello']);
  });

  it('reports the pinned directory for a session-bound conversation', async () => {
    await seedExisting();
    store.setSdkSessionId(CONV, 'session-abc');

    expect(store.getConversationWorkingDirectory(CONV)).toBe(OLD_DIR);
  });

  it('reports a session only once one has been recorded', async () => {
    // This is the gate the UI notice keys off, so it has to be exact.
    await seedExisting();
    store.currentConversationId = CONV;

    expect(store.currentConversationHasSession()).toBe(false);
    store.setSdkSessionId(CONV, 'session-abc');
    expect(store.currentConversationHasSession()).toBe(true);
  });
});
