/**
 * A turn the CLI starts in a discussion that is not on screen.
 *
 * Reported as "the older discussion got wiped, only the last few messages
 * remain". The file was intact — 25,140 messages, never shortened — and the
 * log showed what happened instead. While the user worked in another
 * discussion, a background task finished in the older one and the CLI
 * answered it there, a turn nobody sent. That turn was collected in a buffer
 * started EMPTY, since there was no list on screen to seed it from. Coming
 * back, `loadConversation` prefers a buffer to the file — a buffer is meant
 * to be the window plus everything since — so the discussion opened on that
 * turn alone, 20 messages, with nothing above them to scroll back to.
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
import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';
import { useSettingsStore } from '../settings';

import { startRealStack, settle, onDisk, unmountApp } from './support/real-stack';

const OLD = 'conv-old';
const OTHER = 'conv-other';
const HISTORY = 30;

describe('a turn the CLI starts in a discussion that is not on screen', () => {
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

    // The other discussion exists, and the old one has its history on disk.
    await write(OTHER, [message('other_0', 'user')]);
    await write(OLD, Array.from({ length: HISTORY }, (_, n) => message(`old_${n}`, n % 2 ? 'assistant' : 'user')));

    // The user is in the other discussion.
    expect(await store.switchConversation(OTHER)).toBe(true);
    await settle();
  });

  afterEach(() => {
    unmountApp();
  });

  function message(id: string, role: ChatMessage['role']): ChatMessage {
    return { id, role, content: id, timestamp: 1000 };
  }

  /** Put a discussion on disk the way the app does: on screen, then saved. */
  async function write(id: string, messages: ChatMessage[]): Promise<void> {
    store.currentConversationId = id;
    chatStore.setCurrentConversation(id);
    chatStore.loadMessages([]);
    chatStore.messages.push(...messages);
    expect(await store.saveCurrentConversation()).toBe(true);
    await settle();
  }

  /** The CLI answering a background task in OLD, as useClaudeChat wires it. */
  function backgroundTurn(reply: string): void {
    chatStore.setLoading(OLD, true);
    chatStore.beginMessageBuffer(OLD);
    chatStore.startAssistantMessage(OLD);
    chatStore.appendChunk(OLD, reply);
  }

  it('opens on its history with the turn after it, not on the turn alone', async () => {
    backgroundTurn('the task finished');

    expect(await store.switchConversation(OLD)).toBe(true);
    await settle();

    const ids = chatStore.messages.map((m) => m.content);
    expect(ids.slice(0, HISTORY)).toEqual(Array.from({ length: HISTORY }, (_, n) => `old_${n}`));
    expect(ids.at(-1)).toBe('the task finished');
    expect(chatStore.messages).toHaveLength(HISTORY + 1);
  });

  it('keeps writing the turn where it belongs once the discussion is back on screen', async () => {
    backgroundTurn('the task ');
    await store.switchConversation(OLD);
    await settle();

    chatStore.appendChunk(OLD, 'finished');
    chatStore.finishStreaming(OLD);
    chatStore.setLoading(OLD, false);
    expect(await store.saveCurrentConversation()).toBe(true);
    await settle();

    const stored = onDisk(OLD)?.messages ?? [];
    expect(stored).toHaveLength(HISTORY + 1);
    expect(stored.at(-1)?.content).toBe('the task finished');
    expect(chatStore.messages.at(-1)?.content).toBe('the task finished');
  });

  it('writes the turn after the history when it ends off screen', async () => {
    backgroundTurn('the task finished');
    chatStore.finishStreaming(OLD);
    chatStore.setLoading(OLD, false);

    // What onDone does for a discussion that is not on screen.
    const unwritten = chatStore.unwrittenMessagesFor(OLD) ?? [];
    expect(await store.saveConversation(OLD, unwritten)).toBe(true);
    await settle();

    const stored = onDisk(OLD)?.messages ?? [];
    expect(stored).toHaveLength(HISTORY + 1);
    expect(stored.at(-1)?.content).toBe('the task finished');

    // And coming back afterwards shows all of it.
    await store.switchConversation(OLD);
    await settle();
    expect(chatStore.messages).toHaveLength(HISTORY + 1);
    expect(chatStore.messages[0].content).toBe('old_0');
  });
});
