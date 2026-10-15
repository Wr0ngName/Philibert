/**
 * The conversations store, against real persistence.
 *
 * Covers the conversation lifecycle (create, load, save, delete), the list,
 * the chat-store integration, titles, session ids, working directories, error
 * handling and the edge cases around all of it.
 *
 * It used to run against a hand-written fake of `window.electron.conversation`
 * and assert that the store had called it. That can only ever confirm the test
 * calls its own fake: it cannot see whether a message was stored, whether a
 * title reached the file, or whether a save shortened a conversation — and
 * every data-loss defect this app has shipped lived in exactly those gaps.
 *
 * So here the store writes through the real preload into the real
 * main-process ConversationService, and the assertions read the stored JSON.
 * Only Electron and the filesystem are faked, both being outside this
 * codebase; the fake disk can be made slow, unreadable or unwritable, which is
 * what the error cases use. See support/real-stack.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { Conversation, ChatMessage, BashCommandAction } from '@shared/types';

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

import {
  startRealStack, settle, onDisk, disk, files, releaseReads, releaseWrites,
  storedConfig, unmountApp,
} from './support/real-stack';

const DIR = '/home/user/project';

/** A valid BashCommandAction. */
function createBashAction(overrides: Partial<BashCommandAction> & { id: string }): BashCommandAction {
  return {
    type: 'bash-command',
    toolName: 'Bash',
    description: 'Run command',
    input: {},
    status: 'pending',
    timestamp: Date.now(),
    details: { command: 'ls', workingDirectory: '/tmp' },
    ...overrides,
  };
}

function message(id: string, content: string, role: ChatMessage['role'] = 'user'): ChatMessage {
  return { id, role, content, timestamp: 1000 };
}

/** Write a conversation straight to the fake disk, as a previous run would. */
function seed(conversation: Partial<Conversation> & { id: string }): Conversation {
  const full: Conversation = {
    title: 'Seeded',
    workingDirectory: DIR,
    messages: [],
    createdAt: 1000,
    updatedAt: 2000,
    ...conversation,
  };
  files.set(`/conversations/${full.id}.json`, JSON.stringify(full));
  return full;
}

describe('useConversationsStore', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let chatStore: ReturnType<typeof useChatStore>;

  beforeEach(async () => {
    await startRealStack({
      ConversationService: ConversationService as unknown as new () => never,
      setupConversationIPC: setupConversationIPC as unknown as (service: never) => void,
      workingDirectory: DIR,
    });

    store = useConversationsStore();
    chatStore = useChatStore();
    const settings = useSettingsStore();
    settings.config.workingDirectory = DIR;
    settings.config.apiKey = 'test-key';
  });

  afterEach(() => {
    unmountApp();
  });

  // ===========================================================================
  // Initial State
  // ===========================================================================
  describe('initial state', () => {
    it('should have empty conversations', () => {
      expect(store.conversations).toEqual([]);
    });

    it('should have no current conversation', () => {
      expect(store.currentConversationId).toBeNull();
    });

    it('should not be loading', () => {
      expect(store.isLoading).toBe(false);
    });

    it('should not be saving', () => {
      expect(store.isSaving).toBe(false);
    });

    it('should have no error', () => {
      expect(store.error).toBeNull();
    });
  });

  // ===========================================================================
  // Getters
  // ===========================================================================
  describe('getters', () => {
    describe('hasConversations', () => {
      it('should be false when empty', () => {
        expect(store.hasConversations).toBe(false);
      });

      it('should be true when conversations exist', async () => {
        seed({ id: '1', title: 'Test' });
        await store.loadConversationList();

        expect(store.hasConversations).toBe(true);
      });
    });

    describe('currentConversation', () => {
      it('should be null when no ID set', () => {
        expect(store.currentConversation).toBeNull();
      });

      it('should return current conversation when ID matches', async () => {
        seed({ id: '1', title: 'Test', updatedAt: 1000 });
        seed({ id: '2', title: 'Another', updatedAt: 2000 });
        await store.loadConversationList();

        store.currentConversationId = '2';

        expect(store.currentConversation?.id).toBe('2');
        expect(store.currentConversation?.title).toBe('Another');
      });

      it('should return null when ID does not match any conversation', async () => {
        seed({ id: '1', title: 'Test' });
        await store.loadConversationList();

        store.currentConversationId = 'non-existent';

        expect(store.currentConversation).toBeNull();
      });
    });

    describe('sortedConversations', () => {
      it('should sort by updatedAt descending (newest first)', async () => {
        seed({ id: '1', title: 'Old', updatedAt: 1000 });
        seed({ id: '2', title: 'New', updatedAt: 3000 });
        seed({ id: '3', title: 'Mid', updatedAt: 2000 });
        await store.loadConversationList();

        expect(store.sortedConversations.map((c) => c.id)).toEqual(['2', '3', '1']);
      });

      it('should not mutate original array', async () => {
        seed({ id: '1', title: 'Old', updatedAt: 1000 });
        seed({ id: '2', title: 'New', updatedAt: 3000 });
        await store.loadConversationList();

        const firstBefore = store.conversations[0].id;
        const sorted = store.sortedConversations;

        expect(store.conversations[0].id).toBe(firstBefore);
        expect(sorted).not.toBe(store.conversations);
      });

      it('should return empty array when no conversations', () => {
        expect(store.sortedConversations).toEqual([]);
      });

      it('should handle single conversation', async () => {
        seed({ id: '1', title: 'Only' });
        await store.loadConversationList();

        expect(store.sortedConversations).toHaveLength(1);
        expect(store.sortedConversations[0].id).toBe('1');
      });
    });
  });

  // ===========================================================================
  // loadConversationList
  // ===========================================================================
  describe('loadConversationList', () => {
    it('should load conversations from disk', async () => {
      seed({ id: 'conv_1', title: 'First', updatedAt: 2000 });
      seed({ id: 'conv_2', title: 'Second', updatedAt: 3000 });

      await store.loadConversationList();

      expect(store.conversations).toHaveLength(2);
      expect(store.isLoading).toBe(false);
    });

    it('should set isLoading during operation', async () => {
      seed({ id: 'conv_1', title: 'First' });
      disk.holdReads = true;

      const loadPromise = store.loadConversationList();
      await settle(2);
      expect(store.isLoading).toBe(true);

      await releaseReads();
      await loadPromise;
      expect(store.isLoading).toBe(false);
    });

    it('shows an unreadable directory as no conversations, not as an error', async () => {
      // Deliberate, and worth knowing: ConversationService.list() catches its
      // own read failures and returns an empty array, so nothing downstream
      // can tell "no conversations" from "the directory could not be read".
      // Nothing is written on this path, so it cannot destroy anything — but
      // it does mean a disk problem is reported as an empty history.
      seed({ id: 'conv_1', title: 'Exists' });
      disk.failReads = true;

      await store.loadConversationList();

      expect(store.conversations).toEqual([]);
      expect(store.error).toBeNull();
      expect(store.isLoading).toBe(false);
    });

    it('should clear error on successful load', async () => {
      store.error = 'Previous error';

      await store.loadConversationList();

      expect(store.error).toBeNull();
    });

    it('should handle empty list', async () => {
      await store.loadConversationList();

      expect(store.conversations).toEqual([]);
      expect(store.hasConversations).toBe(false);
    });

    it('should replace existing conversations', async () => {
      seed({ id: 'old', title: 'Old' });
      await store.loadConversationList();
      expect(store.conversations[0].id).toBe('old');

      files.clear();
      seed({ id: 'new', title: 'New' });

      await store.loadConversationList();

      expect(store.conversations).toHaveLength(1);
      expect(store.conversations[0].id).toBe('new');
    });

    it('should not carry messages in the list', async () => {
      // The list is metadata only — holding every conversation's messages is
      // exactly the memory growth the window exists to avoid.
      seed({
        id: 'conv_1',
        title: 'With messages',
        messages: [message('m1', 'hello'), message('m2', 'there')],
      });

      await store.loadConversationList();

      expect(store.conversations[0].messages).toEqual([]);
    });
  });

  // ===========================================================================
  // loadConversation
  // ===========================================================================
  describe('loadConversation', () => {
    it('should load a conversation and update chat store', async () => {
      seed({
        id: 'conv_1',
        title: 'Test',
        messages: [message('msg_1', 'Hello'), message('msg_2', 'Hi there!', 'assistant')],
      });

      const result = await store.loadConversation('conv_1');

      expect(result).toBe(true);
      expect(store.currentConversationId).toBe('conv_1');
      expect(chatStore.messages.map((m) => m.content)).toEqual(['Hello', 'Hi there!']);
    });

    it('should return false if conversation not found', async () => {
      const result = await store.loadConversation('nonexistent');

      expect(result).toBe(false);
      expect(store.error).toBe('Conversation not found');
    });

    it('should add conversation to list if not present', async () => {
      seed({ id: 'conv_new', title: 'New' });
      expect(store.conversations).toHaveLength(0);

      await store.loadConversation('conv_new');

      expect(store.conversations).toHaveLength(1);
      expect(store.conversations[0].id).toBe('conv_new');
    });

    it('should update existing conversation in list', async () => {
      seed({ id: 'conv_1', title: 'Old Title' });
      await store.loadConversationList();

      seed({ id: 'conv_1', title: 'New Title', messages: [message('msg', 'Test')] });

      await store.loadConversation('conv_1');

      expect(store.conversations).toHaveLength(1);
      expect(store.conversations[0].title).toBe('New Title');
    });

    it('should set isLoading during operation', async () => {
      seed({ id: 'conv_1', title: 'Test' });
      disk.holdReads = true;

      const loadPromise = store.loadConversation('conv_1');
      await settle(2);
      expect(store.isLoading).toBe(true);

      await releaseReads();
      await loadPromise;
      expect(store.isLoading).toBe(false);
    });

    it('should handle read errors', async () => {
      seed({ id: 'conv_1', title: 'Test' });
      disk.failReads = true;

      const result = await store.loadConversation('conv_1');

      expect(result).toBe(false);
      expect(store.error).toBe('Failed to load conversation');
    });

    it('should persist the loaded conversation ID to config', async () => {
      seed({ id: 'conv_persist', title: 'Persist Test' });

      await store.loadConversation('conv_persist');
      await settle();

      expect(storedConfig.lastConversationId).toBe('conv_persist');
    });

    it('should load a long history as a window, not in full', async () => {
      // The point of the window: 2,000 stored messages must not become 2,000
      // messages in memory. ~1.8 KB each, so an unbounded list is tens of
      // megabytes for one conversation and grows for as long as the app runs.
      const messages = Array.from({ length: 2000 }, (_, i) =>
        message(`msg_${i}`, `Message ${i}`, i % 2 === 0 ? 'user' : 'assistant'),
      );
      seed({ id: 'conv_large', title: 'Large', messages });

      await store.loadConversation('conv_large');

      expect(chatStore.messages).toHaveLength(500);
      expect(chatStore.olderMessageCount).toBe(1500);
      // The tail, which is what the user is looking at.
      expect(chatStore.messages.at(-1)?.content).toBe('Message 1999');
    });

    it('should load a short history in full, with nothing older', async () => {
      seed({
        id: 'conv_short',
        title: 'Short',
        messages: [message('m1', 'one'), message('m2', 'two')],
      });

      await store.loadConversation('conv_short');

      expect(chatStore.messages).toHaveLength(2);
      expect(chatStore.olderMessageCount).toBe(0);
    });
  });

  // ===========================================================================
  // loadEarlierMessages
  // ===========================================================================
  describe('loadEarlierMessages', () => {
    /** 1,200 stored messages: a window plus pages behind it. */
    async function seedLong(): Promise<void> {
      const messages = Array.from({ length: 1200 }, (_, i) => message(`msg_${i}`, `Message ${i}`));
      seed({ id: 'conv_long', title: 'Long', messages });
      await store.loadConversation('conv_long');
    }

    it('puts the previous page in front of the window', async () => {
      await seedLong();
      expect(chatStore.messages[0].content).toBe('Message 700');

      const loaded = await store.loadEarlierMessages();

      expect(loaded).toBe(500);
      expect(chatStore.messages).toHaveLength(1000);
      expect(chatStore.messages[0].content).toBe('Message 200');
      expect(chatStore.olderMessageCount).toBe(200);
    });

    it('reaches the start of the conversation', async () => {
      await seedLong();

      await store.loadEarlierMessages();
      await store.loadEarlierMessages();

      expect(chatStore.messages).toHaveLength(1200);
      expect(chatStore.messages[0].content).toBe('Message 0');
      expect(chatStore.olderMessageCount).toBe(0);
    });

    it('does nothing when there is nothing older', async () => {
      seed({ id: 'conv_short', title: 'Short', messages: [message('m1', 'one')] });
      await store.loadConversation('conv_short');

      expect(await store.loadEarlierMessages()).toBe(0);
      expect(chatStore.messages).toHaveLength(1);
    });

    it('does not duplicate messages already held', async () => {
      await seedLong();
      await store.loadEarlierMessages();

      const ids = chatStore.messages.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('reports a failure without losing what is on screen', async () => {
      await seedLong();
      const before = chatStore.messages.length;
      disk.failReads = true;

      expect(await store.loadEarlierMessages()).toBe(0);

      expect(chatStore.messages).toHaveLength(before);
      expect(store.error).toBe('Could not load earlier messages');
    });
  });

  // ===========================================================================
  // createNewConversation
  // ===========================================================================
  describe('createNewConversation', () => {
    it('should create a new conversation with unique ID', () => {
      const id1 = store.createNewConversation();
      const id2 = store.createNewConversation();

      expect(id1).toMatch(/^conv_/);
      expect(id2).toMatch(/^conv_/);
      expect(id1).not.toBe(id2);
    });

    it('should set as current conversation', () => {
      const id = store.createNewConversation();
      expect(store.currentConversationId).toBe(id);
    });

    it('should clear chat messages', () => {
      const convId = 'test-conv';
      chatStore.setCurrentConversation(convId);
      chatStore.addUserMessage('Test');
      chatStore.startAssistantMessage(convId);
      chatStore.appendChunk(convId, 'Response');

      store.createNewConversation();

      expect(chatStore.messages).toEqual([]);
    });

    it('should clear pending actions in chat store', () => {
      const convId = 'test-conv';
      chatStore.setCurrentConversation(convId);
      chatStore.addPendingAction(convId, createBashAction({ id: 'action-1' }));

      store.createNewConversation();

      expect(chatStore.pendingActions).toEqual([]);
    });

    it('should return the new conversation ID', () => {
      const id = store.createNewConversation();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('should persist the new conversation ID to config', async () => {
      const id = store.createNewConversation();
      await settle();

      expect(storedConfig.lastConversationId).toBe(id);
    });

    it('should not lose the previous conversation it was looking at', async () => {
      // Creating a conversation replaces the message list, so the one being
      // left has to be written first.
      store.currentConversationId = 'conv_leaving';
      chatStore.setCurrentConversation('conv_leaving');
      chatStore.addUserMessage('do not lose me');
      await store.saveCurrentConversation();

      store.createNewConversation();
      await settle();

      expect(onDisk('conv_leaving')?.messages.map((m) => m.content)).toEqual(['do not lose me']);
    });
  });

  // ===========================================================================
  // saveCurrentConversation
  // ===========================================================================
  describe('saveCurrentConversation', () => {
    beforeEach(() => {
      store.currentConversationId = 'conv_1';
      chatStore.setCurrentConversation('conv_1');
    });

    it('should store the current messages', async () => {
      chatStore.addUserMessage('Hello');
      chatStore.startAssistantMessage('conv_1');
      chatStore.appendChunk('conv_1', 'Hi there!');
      chatStore.finishStreaming('conv_1');

      await store.saveCurrentConversation();

      const stored = onDisk('conv_1');
      expect(stored?.id).toBe('conv_1');
      expect(stored?.messages.map((m) => [m.role, m.content])).toEqual([
        ['user', 'Hello'],
        ['assistant', 'Hi there!'],
      ]);
    });

    it('should not save if no current conversation', async () => {
      store.currentConversationId = null;
      chatStore.addUserMessage('Hello');

      await store.saveCurrentConversation();

      expect(disk.writes).toBe(0);
    });

    it('should not save if no messages', async () => {
      await store.saveCurrentConversation();

      expect(disk.writes).toBe(0);
    });

    it('should set isSaving during operation', async () => {
      chatStore.addUserMessage('Hello');
      disk.holdWrites = true;

      const savePromise = store.saveCurrentConversation();
      await settle(2);
      expect(store.isSaving).toBe(true);

      await releaseWrites();
      await savePromise;
      expect(store.isSaving).toBe(false);
    });

    it('should generate title from first user message', async () => {
      chatStore.addUserMessage('How do I fix this bug?');

      await store.saveCurrentConversation();

      expect(onDisk('conv_1')?.title).toBe('How do I fix this bug?');
    });

    it('should truncate long titles', async () => {
      chatStore.addUserMessage(
        'This is a very long message that should be truncated because it exceeds the maximum title length',
      );

      await store.saveCurrentConversation();

      const title = onDisk('conv_1')?.title ?? '';
      expect(title.length).toBeLessThanOrEqual(50);
      expect(title).toContain('...');
    });

    it('should update conversation in list', async () => {
      seed({ id: 'conv_1', title: 'Old' });
      await store.loadConversationList();

      chatStore.addUserMessage('New message');
      await store.saveCurrentConversation();

      expect(store.conversations[0].title).toBe('New message');
    });

    it('should add conversation to list if not present', async () => {
      store.currentConversationId = 'conv_new';
      chatStore.setCurrentConversation('conv_new');
      chatStore.addUserMessage('Hello');

      await store.saveCurrentConversation();

      expect(store.conversations.some((c) => c.id === 'conv_new')).toBe(true);
    });

    it('should handle save errors', async () => {
      chatStore.addUserMessage('Hello');
      disk.failWrites = true;

      await store.saveCurrentConversation();

      expect(store.error).toMatch(/^Failed to save conversation: /);
      expect(store.isSaving).toBe(false);
    });

    it('does not replace a conversation it failed to read', async () => {
      // The danger in a write that merges: it builds on what was read. A read
      // error used to come back as "no such conversation", so an unreadable
      // file was treated as new and the next write replaced a history it had
      // only failed to read. It now fails instead, leaving the file alone.
      seed({
        id: 'conv_1',
        title: 'Precious',
        messages: [message('old_1', 'keep me'), message('old_2', 'and me')],
      });
      const before = files.get('/conversations/conv_1.json');

      chatStore.addUserMessage('new message');
      disk.failReads = true;

      await store.saveCurrentConversation();

      expect(store.error).toMatch(/^Failed to save conversation: /);
      expect(files.get('/conversations/conv_1.json')).toBe(before);
    });

    it('should not shorten a stored conversation it only holds part of', async () => {
      // The invariant the window rests on. A write carries the messages in
      // memory, and memory may hold only the tail.
      const messages = Array.from({ length: 700 }, (_, i) => message(`msg_${i}`, `Message ${i}`));
      seed({ id: 'conv_windowed', title: 'Windowed', messages });
      await store.loadConversation('conv_windowed');
      expect(chatStore.messages).toHaveLength(500);

      chatStore.addUserMessage('a new one');
      await store.saveCurrentConversation();

      const stored = onDisk('conv_windowed');
      expect(stored?.messages).toHaveLength(701);
      expect(stored?.messages[0].content).toBe('Message 0');
      expect(stored?.messages.at(-1)?.content).toBe('a new one');
    });
  });

  // ===========================================================================
  // deleteConversation
  // ===========================================================================
  describe('deleteConversation', () => {
    it('should delete a conversation', async () => {
      seed({ id: 'conv_1', title: 'Test' });
      await store.loadConversationList();

      await store.deleteConversation('conv_1');

      expect(onDisk('conv_1')).toBeNull();
      expect(store.conversations).toHaveLength(0);
    });

    it('should create new conversation if deleting current', async () => {
      seed({ id: 'conv_1', title: 'Test' });
      await store.loadConversationList();
      store.currentConversationId = 'conv_1';

      await store.deleteConversation('conv_1');

      expect(store.currentConversationId).not.toBe('conv_1');
      expect(store.currentConversationId).toMatch(/^conv_/);
    });

    it('should not affect current conversation when deleting different one', async () => {
      seed({ id: 'conv_1', title: 'Current' });
      seed({ id: 'conv_2', title: 'Other' });
      await store.loadConversationList();
      store.currentConversationId = 'conv_1';

      await store.deleteConversation('conv_2');

      expect(store.currentConversationId).toBe('conv_1');
      expect(store.conversations).toHaveLength(1);
      expect(onDisk('conv_1')).not.toBeNull();
    });

    it('should handle delete errors', async () => {
      seed({ id: 'conv_1', title: 'Test' });
      await store.loadConversationList();
      disk.failUnlink = true;

      await store.deleteConversation('conv_1');

      expect(store.error).toBe('Failed to delete conversation');
      // And the conversation is still there, rather than being dropped from
      // the list as though the delete had worked.
      expect(onDisk('conv_1')).not.toBeNull();
    });

    it('should handle deleting non-existent conversation gracefully', async () => {
      seed({ id: 'conv_1', title: 'Test' });
      await store.loadConversationList();

      await store.deleteConversation('non_existent');

      expect(store.conversations).toHaveLength(1);
      expect(store.error).toBeNull();
    });
  });

  // ===========================================================================
  // initialize
  // ===========================================================================
  describe('initialize', () => {
    it('should load the conversation list', async () => {
      seed({ id: 'conv_1', title: 'Test' });

      await store.initialize();

      expect(store.conversations.some((c) => c.id === 'conv_1')).toBe(true);
    });

    it('should create initial conversation if none exists', async () => {
      await store.initialize();

      expect(store.currentConversationId).toMatch(/^conv_/);
    });

    it('should not create new conversation if one already exists', async () => {
      store.currentConversationId = 'existing_conv';

      await store.initialize();

      expect(store.currentConversationId).toBe('existing_conv');
    });

    it('should restore last active conversation on startup', async () => {
      seed({
        id: 'conv_saved',
        title: 'Saved',
        messages: [message('msg_1', 'Hello')],
      });
      storedConfig.lastConversationId = 'conv_saved';

      await store.initialize();

      expect(store.currentConversationId).toBe('conv_saved');
      expect(chatStore.messages.map((m) => m.content)).toEqual(['Hello']);
    });

    it('should create new conversation if last conversation not found', async () => {
      storedConfig.lastConversationId = 'conv_missing';

      await store.initialize();

      expect(store.currentConversationId).toMatch(/^conv_/);
      expect(store.currentConversationId).not.toBe('conv_missing');
    });

    it('should create new conversation if the list cannot be read', async () => {
      disk.failReads = true;

      await store.initialize();

      expect(store.currentConversationId).toMatch(/^conv_/);
    });
  });

  // ===========================================================================
  // cleanup
  // ===========================================================================
  describe('cleanup', () => {
    it('should store the current conversation on cleanup', async () => {
      await store.initialize();
      const id = store.currentConversationId!;
      chatStore.setCurrentConversation(id);
      chatStore.addUserMessage('Test message');

      await store.cleanup();
      await settle();

      expect(onDisk(id)?.messages.map((m) => m.content)).toEqual(['Test message']);
    });
  });

  // ===========================================================================
  // Error handling
  // ===========================================================================
  describe('clearError', () => {
    it('should clear error', () => {
      store.error = 'Some error';
      store.clearError();
      expect(store.error).toBeNull();
    });

    it('should be safe to call when no error', () => {
      store.clearError();
      expect(store.error).toBeNull();
    });
  });

  // ===========================================================================
  // Integration Scenarios
  // ===========================================================================
  describe('integration scenarios', () => {
    it('should handle a complete conversation workflow', async () => {
      await store.initialize();
      expect(store.currentConversationId).not.toBeNull();
      const convId = store.currentConversationId!;

      chatStore.setCurrentConversation(convId);
      chatStore.addUserMessage('Hello');
      chatStore.startAssistantMessage(convId);
      chatStore.appendChunk(convId, 'Hi there!');
      chatStore.finishStreaming(convId);

      await store.saveCurrentConversation();

      expect(onDisk(convId)?.messages.map((m) => m.content)).toEqual(['Hello', 'Hi there!']);
    });

    it('should handle switching between conversations', async () => {
      seed({ id: 'conv_1', title: 'First', messages: [message('msg_1', 'First message')] });
      seed({ id: 'conv_2', title: 'Second', messages: [message('msg_2', 'Second message')] });

      await store.loadConversation('conv_1');
      expect(chatStore.messages[0].content).toBe('First message');

      await store.loadConversation('conv_2');
      expect(chatStore.messages[0].content).toBe('Second message');
      expect(store.currentConversationId).toBe('conv_2');
    });

    it('should keep both conversations intact across a switch', async () => {
      seed({ id: 'conv_1', title: 'First', messages: [message('msg_1', 'First message')] });
      seed({ id: 'conv_2', title: 'Second', messages: [message('msg_2', 'Second message')] });

      await store.loadConversation('conv_1');
      chatStore.addUserMessage('added to the first');
      await store.switchConversation('conv_2');
      await settle();

      expect(onDisk('conv_1')?.messages.map((m) => m.content))
        .toEqual(['First message', 'added to the first']);
      expect(onDisk('conv_2')?.messages.map((m) => m.content)).toEqual(['Second message']);
    });

    it('should handle creating a new conversation while having existing ones', async () => {
      seed({ id: 'conv_1', title: 'Existing' });
      await store.loadConversationList();
      store.currentConversationId = 'conv_1';
      chatStore.setCurrentConversation('conv_1');
      chatStore.addUserMessage('Existing message');

      const newId = store.createNewConversation();

      expect(newId).not.toBe('conv_1');
      expect(store.currentConversationId).toBe(newId);
      expect(chatStore.messages).toHaveLength(0);
    });

    it('should handle rapid conversation creation', () => {
      const ids = Array.from({ length: 5 }, () => store.createNewConversation());

      expect(new Set(ids).size).toBe(5);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================
  describe('edge cases', () => {
    beforeEach(() => {
      store.currentConversationId = 'conv_1';
      chatStore.setCurrentConversation('conv_1');
    });

    it('should handle a conversation with no user message to title it', async () => {
      chatStore.startAssistantMessage('conv_1');
      chatStore.appendChunk('conv_1', 'Response');
      chatStore.finishStreaming('conv_1');

      await store.saveCurrentConversation();

      expect(onDisk('conv_1')?.title).toBe('New Conversation');
    });

    it('should handle unicode in a conversation title', async () => {
      chatStore.addUserMessage('你好世界 🌍 How are you?');

      await store.saveCurrentConversation();

      expect(onDisk('conv_1')?.title).toBe('你好世界 🌍 How are you?');
    });

    it('should store a conversation with many messages', async () => {
      for (let i = 0; i < 50; i++) {
        chatStore.addUserMessage(`Question ${i}`);
        chatStore.startAssistantMessage('conv_1');
        chatStore.appendChunk('conv_1', `Answer ${i}`);
        chatStore.finishStreaming('conv_1');
      }

      await store.saveCurrentConversation();

      expect(onDisk('conv_1')?.messages).toHaveLength(100);
    });

    it('should preserve conversation timestamps on update', async () => {
      seed({ id: 'conv_1', title: 'Test', createdAt: 1000, updatedAt: 2000 });
      await store.loadConversationList();

      chatStore.addUserMessage('New message');
      await store.saveCurrentConversation();

      const stored = onDisk('conv_1');
      expect(stored?.createdAt).toBe(1000);
      expect(stored?.updatedAt).toBeGreaterThan(2000);
    });
  });

  // ===========================================================================
  // SDK Session ID Management
  // ===========================================================================
  describe('SDK session ID management', () => {
    describe('setSdkSessionId / getSdkSessionId', () => {
      it('should store and retrieve a session ID', () => {
        store.setSdkSessionId('conv_1', 'session-abc-123');
        expect(store.getSdkSessionId('conv_1')).toBe('session-abc-123');
      });

      it('should return undefined for unknown conversation', () => {
        expect(store.getSdkSessionId('nonexistent')).toBeUndefined();
      });

      it('should overwrite existing session ID', () => {
        store.setSdkSessionId('conv_1', 'session-old');
        store.setSdkSessionId('conv_1', 'session-new');
        expect(store.getSdkSessionId('conv_1')).toBe('session-new');
      });

      it('should store independent session IDs for different conversations', () => {
        store.setSdkSessionId('conv_1', 'session-aaa');
        store.setSdkSessionId('conv_2', 'session-bbb');
        expect(store.getSdkSessionId('conv_1')).toBe('session-aaa');
        expect(store.getSdkSessionId('conv_2')).toBe('session-bbb');
      });
    });

    describe('clearSdkSessionId', () => {
      it('should remove session ID from map', () => {
        store.setSdkSessionId('conv_1', 'session-abc');
        store.clearSdkSessionId('conv_1');
        expect(store.getSdkSessionId('conv_1')).toBeUndefined();
      });

      it('should not affect other conversations', () => {
        store.setSdkSessionId('conv_1', 'session-aaa');
        store.setSdkSessionId('conv_2', 'session-bbb');
        store.clearSdkSessionId('conv_1');
        expect(store.getSdkSessionId('conv_2')).toBe('session-bbb');
      });

      it('should handle clearing non-existent ID gracefully', () => {
        expect(() => store.clearSdkSessionId('nonexistent')).not.toThrow();
      });
    });

    describe('clearCurrentSdkSessionId', () => {
      it('should clear session ID for current conversation', () => {
        store.currentConversationId = 'conv_1';
        store.setSdkSessionId('conv_1', 'session-abc');
        store.clearCurrentSdkSessionId();
        expect(store.getSdkSessionId('conv_1')).toBeUndefined();
      });

      it('should do nothing when no current conversation', () => {
        store.setSdkSessionId('conv_1', 'session-abc');
        store.currentConversationId = null;
        store.clearCurrentSdkSessionId();
        expect(store.getSdkSessionId('conv_1')).toBe('session-abc');
      });
    });

    describe('currentConversationHasSession', () => {
      it('should return true when current conversation has session', () => {
        store.currentConversationId = 'conv_1';
        store.setSdkSessionId('conv_1', 'session-abc');
        expect(store.currentConversationHasSession()).toBe(true);
      });

      it('should return false when current conversation has no session', () => {
        store.currentConversationId = 'conv_1';
        expect(store.currentConversationHasSession()).toBe(false);
      });

      it('should return false when no current conversation', () => {
        store.currentConversationId = null;
        expect(store.currentConversationHasSession()).toBe(false);
      });
    });

    describe('loadConversation restores session ID', () => {
      it('should restore sdkSessionId from the stored conversation', async () => {
        seed({
          id: 'conv_with_session',
          title: 'Has Session',
          messages: [message('msg_1', 'Hello')],
          sdkSessionId: 'persisted-session-id-12345',
        });

        await store.loadConversation('conv_with_session');

        expect(store.getSdkSessionId('conv_with_session')).toBe('persisted-session-id-12345');
      });

      it('should NOT set session ID when the conversation has none', async () => {
        seed({ id: 'conv_no_session', title: 'No Session' });

        await store.loadConversation('conv_no_session');

        expect(store.getSdkSessionId('conv_no_session')).toBeUndefined();
      });

      it('should overwrite a stale in-memory session ID when loading', async () => {
        store.setSdkSessionId('conv_1', 'stale-session');
        seed({ id: 'conv_1', title: 'Updated', sdkSessionId: 'fresh-session-from-disk' });

        await store.loadConversation('conv_1');

        expect(store.getSdkSessionId('conv_1')).toBe('fresh-session-from-disk');
      });
    });

    describe('saveCurrentConversation includes session ID', () => {
      it('should store sdkSessionId when set', async () => {
        store.currentConversationId = 'conv_1';
        chatStore.setCurrentConversation('conv_1');
        chatStore.addUserMessage('Hello');
        store.setSdkSessionId('conv_1', 'save-me-session');

        await store.saveCurrentConversation();

        expect(onDisk('conv_1')?.sdkSessionId).toBe('save-me-session');
      });

      it('should store no sdkSessionId when none is set', async () => {
        store.currentConversationId = 'conv_1';
        chatStore.setCurrentConversation('conv_1');
        chatStore.addUserMessage('Hello');

        await store.saveCurrentConversation();

        expect(onDisk('conv_1')?.sdkSessionId).toBeUndefined();
      });
    });

    describe('conversation switching preserves session IDs', () => {
      it('should preserve session IDs when switching between conversations', async () => {
        seed({ id: 'conv_1', title: 'First', sdkSessionId: 'session-conv-1' });
        seed({ id: 'conv_2', title: 'Second', sdkSessionId: 'session-conv-2' });

        await store.loadConversation('conv_1');
        expect(store.getSdkSessionId('conv_1')).toBe('session-conv-1');

        await store.loadConversation('conv_2');
        expect(store.getSdkSessionId('conv_2')).toBe('session-conv-2');
        expect(store.getSdkSessionId('conv_1')).toBe('session-conv-1');
      });
    });

    describe('getConversationWorkingDirectory', () => {
      it('should return the stored CWD for a loaded conversation', async () => {
        seed({ id: 'conv_cwd', title: 'CWD Test', workingDirectory: '/home/user/projectA' });

        await store.loadConversation('conv_cwd');

        expect(store.getConversationWorkingDirectory('conv_cwd')).toBe('/home/user/projectA');
      });

      it('should return undefined for unknown conversation', () => {
        expect(store.getConversationWorkingDirectory('nonexistent')).toBeUndefined();
      });

      it("should return each conversation's own CWD, not a global one", async () => {
        seed({ id: 'conv_a', title: 'Project A', workingDirectory: '/home/user/projectA' });
        seed({ id: 'conv_b', title: 'Project B', workingDirectory: '/home/user/projectB' });

        await store.loadConversation('conv_a');
        await store.loadConversation('conv_b');

        expect(store.getConversationWorkingDirectory('conv_a')).toBe('/home/user/projectA');
        expect(store.getConversationWorkingDirectory('conv_b')).toBe('/home/user/projectB');
      });
    });

    describe('save preserves the original conversation CWD', () => {
      it('should keep the original CWD when re-saving a session-bound conversation', async () => {
        seed({
          id: 'conv_preserve',
          title: 'Preserve CWD',
          workingDirectory: '/home/user/original-project',
          messages: [message('msg_1', 'Hello')],
          sdkSessionId: 'session-preserve',
        });

        await store.loadConversation('conv_preserve');
        chatStore.addUserMessage('Follow-up message');
        await store.saveCurrentConversation();

        expect(onDisk('conv_preserve')?.workingDirectory).toBe('/home/user/original-project');
      });
    });

    describe('session ID round-trip (save then load)', () => {
      it('should survive a save and a load', async () => {
        store.currentConversationId = 'conv_roundtrip';
        chatStore.setCurrentConversation('conv_roundtrip');
        chatStore.addUserMessage('Test message');
        store.setSdkSessionId('conv_roundtrip', 'roundtrip-session');

        await store.saveCurrentConversation();
        expect(onDisk('conv_roundtrip')?.sdkSessionId).toBe('roundtrip-session');

        store.clearSdkSessionId('conv_roundtrip');
        await store.loadConversation('conv_roundtrip');

        expect(store.getSdkSessionId('conv_roundtrip')).toBe('roundtrip-session');
      });
    });
  });
});
