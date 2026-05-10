/**
 * Comprehensive tests for the conversations store.
 *
 * Tests cover:
 * - Conversation lifecycle (create, load, save, delete)
 * - Conversation list management
 * - Integration with chat store (message loading/saving)
 * - Auto-save behavior (watcher triggers)
 * - Working directory synchronization
 * - Title generation from messages
 * - Error handling and recovery
 * - Edge cases (concurrent operations, large conversations)
 */

import { setActivePinia, createPinia } from 'pinia';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import type { Conversation, ChatMessage, BashCommandAction } from '@shared/types';

import { useChatStore } from '../chat';
import { useConversationsStore } from '../conversations';

// Helper to create valid BashCommandAction
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

// Mock logger
vi.mock('../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock settings store - provides workingDirectory for save operations
vi.mock('../settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../settings')>();
  return {
    ...actual,
    useSettingsStore: () => ({
      workingDirectory: '/home/user/project',
      setWorkingDirectory: vi.fn(),
    }),
  };
});

// Mock CONSTANTS
vi.mock('../../constants/app', () => ({
  CONSTANTS: {
    CONVERSATION: {
      TITLE_MAX_LENGTH: 50,
      TITLE_TRUNCATE_LENGTH: 47,
    },
    MESSAGES: {
      MAX_COUNT: 100,
    },
  },
}));

// Mock window.electron
const mockElectron = {
  conversation: {
    list: vi.fn(),
    get: vi.fn(),
    save: vi.fn(),
    delete: vi.fn(),
  },
  config: {
    get: vi.fn(),
    set: vi.fn(),
    onChange: vi.fn(() => () => {}),
  },
};

// Set up the mock before tests
vi.stubGlobal('window', { electron: mockElectron });

describe('useConversationsStore', () => {
  let store: ReturnType<typeof useConversationsStore>;
  let chatStore: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();

    // Setup default mock returns
    mockElectron.conversation.list.mockResolvedValue([]);
    mockElectron.conversation.get.mockResolvedValue(null);
    mockElectron.conversation.save.mockResolvedValue(undefined);
    mockElectron.conversation.delete.mockResolvedValue(undefined);
    mockElectron.config.get.mockResolvedValue({
      workingDirectory: '/home/user/project',
      apiKey: '',
      oauthToken: '',
      authMethod: 'none',
      recentProjects: [],
      theme: 'system',
      fontSize: 14,
      autoApproveReads: true,
      lastConversationId: '',
    });
    mockElectron.config.set.mockResolvedValue(undefined);

    // Initialize stores
    store = useConversationsStore();
    chatStore = useChatStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
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

    it('should not be initialized', () => {
      // Private state, but we can check behavior
      // Before initialize(), auto-save watchers should not trigger
      expect(store.currentConversationId).toBeNull();
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

      it('should be true when conversations exist', () => {
        store.conversations = [
          { id: '1', title: 'Test', workingDirectory: '', messages: [], createdAt: 1000, updatedAt: 1000 },
        ];
        expect(store.hasConversations).toBe(true);
      });
    });

    describe('currentConversation', () => {
      it('should be null when no ID set', () => {
        expect(store.currentConversation).toBeNull();
      });

      it('should return current conversation when ID matches', () => {
        store.conversations = [
          { id: '1', title: 'Test', workingDirectory: '', messages: [], createdAt: 1000, updatedAt: 1000 },
          { id: '2', title: 'Another', workingDirectory: '', messages: [], createdAt: 2000, updatedAt: 2000 },
        ];
        store.currentConversationId = '2';
        expect(store.currentConversation?.id).toBe('2');
        expect(store.currentConversation?.title).toBe('Another');
      });

      it('should return null when ID does not match any conversation', () => {
        store.conversations = [
          { id: '1', title: 'Test', workingDirectory: '', messages: [], createdAt: 1000, updatedAt: 1000 },
        ];
        store.currentConversationId = 'non-existent';
        expect(store.currentConversation).toBeNull();
      });
    });

    describe('sortedConversations', () => {
      it('should sort by updatedAt descending (newest first)', () => {
        store.conversations = [
          { id: '1', title: 'Old', workingDirectory: '', messages: [], createdAt: 1000, updatedAt: 1000 },
          { id: '2', title: 'New', workingDirectory: '', messages: [], createdAt: 2000, updatedAt: 3000 },
          { id: '3', title: 'Mid', workingDirectory: '', messages: [], createdAt: 1500, updatedAt: 2000 },
        ];
        expect(store.sortedConversations[0].id).toBe('2');
        expect(store.sortedConversations[1].id).toBe('3');
        expect(store.sortedConversations[2].id).toBe('1');
      });

      it('should not mutate original array', () => {
        store.conversations = [
          { id: '1', title: 'Old', workingDirectory: '', messages: [], createdAt: 1000, updatedAt: 1000 },
          { id: '2', title: 'New', workingDirectory: '', messages: [], createdAt: 2000, updatedAt: 3000 },
        ];
        const original = [...store.conversations];
        const sorted = store.sortedConversations;
        expect(store.conversations[0].id).toBe(original[0].id);
        expect(sorted).not.toBe(store.conversations);
      });

      it('should return empty array when no conversations', () => {
        expect(store.sortedConversations).toEqual([]);
      });

      it('should handle single conversation', () => {
        store.conversations = [
          { id: '1', title: 'Only', workingDirectory: '', messages: [], createdAt: 1000, updatedAt: 1000 },
        ];
        expect(store.sortedConversations).toHaveLength(1);
        expect(store.sortedConversations[0].id).toBe('1');
      });
    });
  });

  // ===========================================================================
  // loadConversationList
  // ===========================================================================
  describe('loadConversationList', () => {
    it('should load conversations from API', async () => {
      const conversations: Conversation[] = [
        { id: 'conv_1', title: 'First', workingDirectory: '/home', messages: [], createdAt: 1000, updatedAt: 2000 },
        { id: 'conv_2', title: 'Second', workingDirectory: '/home', messages: [], createdAt: 2000, updatedAt: 3000 },
      ];
      mockElectron.conversation.list.mockResolvedValue(conversations);

      await store.loadConversationList();

      expect(mockElectron.conversation.list).toHaveBeenCalled();
      expect(store.conversations).toHaveLength(2);
      expect(store.isLoading).toBe(false);
    });

    it('should set isLoading during operation', async () => {
      let resolvePromise: () => void;
      mockElectron.conversation.list.mockImplementation(() =>
        new Promise((resolve) => { resolvePromise = () => resolve([]); })
      );

      const loadPromise = store.loadConversationList();
      expect(store.isLoading).toBe(true);

      resolvePromise!();
      await loadPromise;
      expect(store.isLoading).toBe(false);
    });

    it('should handle errors and set error state', async () => {
      mockElectron.conversation.list.mockRejectedValue(new Error('Network error'));

      await store.loadConversationList();

      expect(store.error).toBe('Failed to load conversations');
      expect(store.isLoading).toBe(false);
    });

    it('should clear error on successful load', async () => {
      store.error = 'Previous error';
      mockElectron.conversation.list.mockResolvedValue([]);

      await store.loadConversationList();

      expect(store.error).toBeNull();
    });

    it('should handle empty list', async () => {
      mockElectron.conversation.list.mockResolvedValue([]);

      await store.loadConversationList();

      expect(store.conversations).toEqual([]);
      expect(store.hasConversations).toBe(false);
    });

    it('should replace existing conversations', async () => {
      store.conversations = [
        { id: 'old', title: 'Old', workingDirectory: '', messages: [], createdAt: 1, updatedAt: 1 },
      ];

      mockElectron.conversation.list.mockResolvedValue([
        { id: 'new', title: 'New', workingDirectory: '', messages: [], createdAt: 2, updatedAt: 2 },
      ]);

      await store.loadConversationList();

      expect(store.conversations).toHaveLength(1);
      expect(store.conversations[0].id).toBe('new');
    });
  });

  // ===========================================================================
  // loadConversation
  // ===========================================================================
  describe('loadConversation', () => {
    it('should load a conversation and update chat store', async () => {
      const conversation: Conversation = {
        id: 'conv_1',
        title: 'Test',
        workingDirectory: '/home/user/project',
        messages: [
          { id: 'msg_1', role: 'user', content: 'Hello', timestamp: 1000 },
          { id: 'msg_2', role: 'assistant', content: 'Hi there!', timestamp: 2000 },
        ],
        createdAt: 1000,
        updatedAt: 2000,
      };
      mockElectron.conversation.get.mockResolvedValue(conversation);

      const result = await store.loadConversation('conv_1');

      expect(result).toBe(true);
      expect(store.currentConversationId).toBe('conv_1');
      expect(chatStore.messages).toHaveLength(2);
      expect(chatStore.messages[0].content).toBe('Hello');
      expect(chatStore.messages[1].content).toBe('Hi there!');
    });

    it('should return false if conversation not found', async () => {
      mockElectron.conversation.get.mockResolvedValue(null);

      const result = await store.loadConversation('nonexistent');

      expect(result).toBe(false);
      expect(store.error).toBe('Conversation not found');
    });

    it('should add conversation to list if not present', async () => {
      const conversation: Conversation = {
        id: 'conv_new',
        title: 'New',
        workingDirectory: '/home',
        messages: [],
        createdAt: 1000,
        updatedAt: 2000,
      };
      mockElectron.conversation.get.mockResolvedValue(conversation);

      expect(store.conversations).toHaveLength(0);

      await store.loadConversation('conv_new');

      expect(store.conversations).toHaveLength(1);
      expect(store.conversations[0].id).toBe('conv_new');
    });

    it('should update existing conversation in list', async () => {
      store.conversations = [
        { id: 'conv_1', title: 'Old Title', workingDirectory: '', messages: [], createdAt: 1000, updatedAt: 1000 },
      ];

      const updatedConversation: Conversation = {
        id: 'conv_1',
        title: 'New Title',
        workingDirectory: '/home',
        messages: [{ id: 'msg', role: 'user', content: 'Test', timestamp: 1000 }],
        createdAt: 1000,
        updatedAt: 2000,
      };
      mockElectron.conversation.get.mockResolvedValue(updatedConversation);

      await store.loadConversation('conv_1');

      expect(store.conversations).toHaveLength(1);
      expect(store.conversations[0].title).toBe('New Title');
    });

    it('should set isLoading during operation', async () => {
      let resolvePromise: (conv: Conversation) => void;
      mockElectron.conversation.get.mockImplementation(() =>
        new Promise((resolve) => { resolvePromise = resolve; })
      );

      const loadPromise = store.loadConversation('conv_1');
      expect(store.isLoading).toBe(true);

      resolvePromise!({ id: 'conv_1', title: 'Test', workingDirectory: '', messages: [], createdAt: 1, updatedAt: 1 });
      await loadPromise;
      expect(store.isLoading).toBe(false);
    });

    it('should handle API errors', async () => {
      mockElectron.conversation.get.mockRejectedValue(new Error('API Error'));

      const result = await store.loadConversation('conv_1');

      expect(result).toBe(false);
      expect(store.error).toBe('Failed to load conversation');
    });

    it('should persist the loaded conversation ID to config', async () => {
      const conversation: Conversation = {
        id: 'conv_persist',
        title: 'Persist Test',
        workingDirectory: '/home/user/project',
        messages: [],
        createdAt: 1000,
        updatedAt: 2000,
      };
      mockElectron.conversation.get.mockResolvedValue(conversation);

      await store.loadConversation('conv_persist');

      expect(mockElectron.config.set).toHaveBeenCalledWith({ lastConversationId: 'conv_persist' });
    });

    it('should handle large conversation history', async () => {
      const messages: ChatMessage[] = Array.from({ length: 50 }, (_, i) => ({
        id: `msg_${i}`,
        role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `Message ${i}`,
        timestamp: i * 1000,
      }));

      const conversation: Conversation = {
        id: 'conv_large',
        title: 'Large',
        workingDirectory: '/home',
        messages,
        createdAt: 1000,
        updatedAt: 50000,
      };
      mockElectron.conversation.get.mockResolvedValue(conversation);

      await store.loadConversation('conv_large');

      expect(chatStore.messages).toHaveLength(50);
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

    it('should persist the new conversation ID to config', () => {
      const id = store.createNewConversation();
      expect(mockElectron.config.set).toHaveBeenCalledWith({ lastConversationId: id });
    });
  });

  // ===========================================================================
  // saveCurrentConversation
  // ===========================================================================
  describe('saveCurrentConversation', () => {
    it('should save conversation with current messages', async () => {
      store.currentConversationId = 'conv_1';
      chatStore.setCurrentConversation('conv_1');
      chatStore.addUserMessage('Hello');
      chatStore.startAssistantMessage('conv_1');
      chatStore.appendChunk('conv_1', 'Hi there!');
      chatStore.finishStreaming('conv_1');

      await store.saveCurrentConversation();

      expect(mockElectron.conversation.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'conv_1',
          messages: expect.arrayContaining([
            expect.objectContaining({ role: 'user', content: 'Hello' }),
            expect.objectContaining({ role: 'assistant', content: 'Hi there!' }),
          ]),
        })
      );
    });

    it('should not save if no current conversation', async () => {
      store.currentConversationId = null;
      chatStore.addUserMessage('Hello');

      await store.saveCurrentConversation();

      expect(mockElectron.conversation.save).not.toHaveBeenCalled();
    });

    it('should not save if no messages', async () => {
      store.currentConversationId = 'conv_1';

      await store.saveCurrentConversation();

      expect(mockElectron.conversation.save).not.toHaveBeenCalled();
    });

    it('should set isSaving during operation', async () => {
      store.currentConversationId = 'conv_1';
      chatStore.addUserMessage('Hello');

      let resolvePromise: () => void;
      mockElectron.conversation.save.mockImplementation(() =>
        new Promise((resolve) => { resolvePromise = () => resolve(undefined); })
      );

      const savePromise = store.saveCurrentConversation();
      expect(store.isSaving).toBe(true);

      resolvePromise!();
      await savePromise;
      expect(store.isSaving).toBe(false);
    });

    it('should generate title from first user message', async () => {
      store.currentConversationId = 'conv_1';
      chatStore.addUserMessage('How do I fix this bug?');

      await store.saveCurrentConversation();

      expect(mockElectron.conversation.save).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'How do I fix this bug?',
        })
      );
    });

    it('should truncate long titles', async () => {
      store.currentConversationId = 'conv_1';
      const longMessage = 'This is a very long message that should be truncated because it exceeds the maximum title length';
      chatStore.addUserMessage(longMessage);

      await store.saveCurrentConversation();

      const savedConversation = mockElectron.conversation.save.mock.calls[0][0];
      expect(savedConversation.title.length).toBeLessThanOrEqual(50);
      expect(savedConversation.title).toContain('...');
    });

    it('should update conversation in list', async () => {
      store.conversations = [
        { id: 'conv_1', title: 'Old', workingDirectory: '', messages: [], createdAt: 1000, updatedAt: 1000 },
      ];
      store.currentConversationId = 'conv_1';
      chatStore.addUserMessage('New message');

      await store.saveCurrentConversation();

      expect(store.conversations[0].title).toBe('New message');
    });

    it('should add conversation to list if not present', async () => {
      store.currentConversationId = 'conv_new';
      chatStore.addUserMessage('Hello');

      await store.saveCurrentConversation();

      expect(store.conversations.some((c: { id: string }) => c.id === 'conv_new')).toBe(true);
    });

    it('should handle save errors', async () => {
      store.currentConversationId = 'conv_1';
      chatStore.addUserMessage('Hello');
      mockElectron.conversation.save.mockRejectedValue(new Error('Save failed'));

      await store.saveCurrentConversation();

      // Error message now includes the actual error details for better debugging
      expect(store.error).toBe('Failed to save conversation: Save failed');
      expect(store.isSaving).toBe(false);
    });
  });

  // ===========================================================================
  // deleteConversation
  // ===========================================================================
  describe('deleteConversation', () => {
    it('should delete a conversation', async () => {
      store.conversations = [
        { id: 'conv_1', title: 'Test', workingDirectory: '', messages: [], createdAt: 1000, updatedAt: 2000 },
      ];

      await store.deleteConversation('conv_1');

      expect(mockElectron.conversation.delete).toHaveBeenCalledWith('conv_1');
      expect(store.conversations).toHaveLength(0);
    });

    it('should create new conversation if deleting current', async () => {
      store.conversations = [
        { id: 'conv_1', title: 'Test', workingDirectory: '', messages: [], createdAt: 1000, updatedAt: 2000 },
      ];
      store.currentConversationId = 'conv_1';

      await store.deleteConversation('conv_1');

      expect(store.currentConversationId).not.toBe('conv_1');
      expect(store.currentConversationId).toMatch(/^conv_/);
    });

    it('should not affect current conversation when deleting different one', async () => {
      store.conversations = [
        { id: 'conv_1', title: 'Current', workingDirectory: '', messages: [], createdAt: 1000, updatedAt: 2000 },
        { id: 'conv_2', title: 'Other', workingDirectory: '', messages: [], createdAt: 2000, updatedAt: 3000 },
      ];
      store.currentConversationId = 'conv_1';

      await store.deleteConversation('conv_2');

      expect(store.currentConversationId).toBe('conv_1');
      expect(store.conversations).toHaveLength(1);
    });

    it('should handle delete errors', async () => {
      store.conversations = [
        { id: 'conv_1', title: 'Test', workingDirectory: '', messages: [], createdAt: 1000, updatedAt: 2000 },
      ];
      mockElectron.conversation.delete.mockRejectedValue(new Error('Delete failed'));

      await store.deleteConversation('conv_1');

      expect(store.error).toBe('Failed to delete conversation');
    });

    it('should handle deleting non-existent conversation gracefully', async () => {
      store.conversations = [
        { id: 'conv_1', title: 'Test', workingDirectory: '', messages: [], createdAt: 1000, updatedAt: 2000 },
      ];

      await store.deleteConversation('non_existent');

      // Should call API but not affect local list
      expect(mockElectron.conversation.delete).toHaveBeenCalledWith('non_existent');
      expect(store.conversations).toHaveLength(1);
    });
  });

  // ===========================================================================
  // initialize
  // ===========================================================================
  describe('initialize', () => {
    it('should load conversation list', async () => {
      mockElectron.conversation.list.mockResolvedValue([
        { id: 'conv_1', title: 'Test', workingDirectory: '', messages: [], createdAt: 1000, updatedAt: 2000 },
      ]);

      await store.initialize();

      expect(mockElectron.conversation.list).toHaveBeenCalled();
    });

    it('should create initial conversation if none exists', async () => {
      mockElectron.config.get.mockResolvedValue({ lastConversationId: '' });

      await store.initialize();

      expect(store.currentConversationId).toMatch(/^conv_/);
    });

    it('should not create new conversation if one already exists', async () => {
      store.currentConversationId = 'existing_conv';

      await store.initialize();

      expect(store.currentConversationId).toBe('existing_conv');
    });

    it('should restore last active conversation on startup', async () => {
      const savedConversation: Conversation = {
        id: 'conv_saved',
        title: 'Saved',
        workingDirectory: '/home/user/project',
        messages: [{ id: 'msg_1', role: 'user', content: 'Hello', timestamp: 1000 }],
        createdAt: 1000,
        updatedAt: 2000,
      };
      mockElectron.conversation.list.mockResolvedValue([
        { id: 'conv_saved', title: 'Saved', workingDirectory: '/home/user/project', messages: [], createdAt: 1000, updatedAt: 2000 },
      ]);
      mockElectron.conversation.get.mockResolvedValue(savedConversation);
      mockElectron.config.get.mockResolvedValue({ lastConversationId: 'conv_saved' });

      await store.initialize();

      expect(store.currentConversationId).toBe('conv_saved');
      expect(mockElectron.conversation.get).toHaveBeenCalledWith('conv_saved');
    });

    it('should create new conversation if last conversation not found in list', async () => {
      mockElectron.conversation.list.mockResolvedValue([]);
      mockElectron.config.get.mockResolvedValue({ lastConversationId: 'conv_missing' });

      await store.initialize();

      // Fallback: conversation not in list, so a new one is created
      expect(store.currentConversationId).toMatch(/^conv_/);
      expect(store.currentConversationId).not.toBe('conv_missing');
    });

    it('should create new conversation if config.get fails', async () => {
      mockElectron.conversation.list.mockResolvedValue([]);
      mockElectron.config.get.mockRejectedValue(new Error('Config read error'));

      await store.initialize();

      expect(store.currentConversationId).toMatch(/^conv_/);
    });
  });

  // ===========================================================================
  // cleanup
  // ===========================================================================
  describe('cleanup', () => {
    it('should save current conversation on cleanup', async () => {
      store.currentConversationId = 'conv_1';
      chatStore.addUserMessage('Test message');
      await store.initialize(); // Enable auto-save

      store.cleanup();

      // saveCurrentConversation is called
      expect(mockElectron.conversation.save).toHaveBeenCalled();
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
    it('should handle complete conversation workflow', async () => {
      // 1. Initialize store
      mockElectron.conversation.list.mockResolvedValue([]);
      await store.initialize();

      expect(store.currentConversationId).not.toBeNull();
      const convId = store.currentConversationId!;

      // 2. Add messages
      chatStore.setCurrentConversation(convId);
      chatStore.addUserMessage('Hello');
      chatStore.startAssistantMessage(convId);
      chatStore.appendChunk(convId, 'Hi there!');
      chatStore.finishStreaming(convId);

      // 3. Save conversation
      await store.saveCurrentConversation();

      expect(mockElectron.conversation.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: convId,
          messages: expect.arrayContaining([
            expect.objectContaining({ content: 'Hello' }),
            expect.objectContaining({ content: 'Hi there!' }),
          ]),
        })
      );
    });

    it('should handle switching between conversations', async () => {
      // Setup existing conversations
      const conv1: Conversation = {
        id: 'conv_1',
        title: 'First',
        workingDirectory: '/project1',
        messages: [{ id: 'msg_1', role: 'user', content: 'First message', timestamp: 1000 }],
        createdAt: 1000,
        updatedAt: 2000,
      };
      const conv2: Conversation = {
        id: 'conv_2',
        title: 'Second',
        workingDirectory: '/project2',
        messages: [{ id: 'msg_2', role: 'user', content: 'Second message', timestamp: 2000 }],
        createdAt: 2000,
        updatedAt: 3000,
      };

      mockElectron.conversation.get.mockImplementation((id) =>
        Promise.resolve(id === 'conv_1' ? conv1 : id === 'conv_2' ? conv2 : null)
      );

      // Load first conversation
      await store.loadConversation('conv_1');
      expect(chatStore.messages[0].content).toBe('First message');

      // Switch to second conversation
      await store.loadConversation('conv_2');
      expect(chatStore.messages[0].content).toBe('Second message');
      expect(store.currentConversationId).toBe('conv_2');
    });

    it('should handle creating new conversation while having existing ones', async () => {
      store.conversations = [
        { id: 'conv_1', title: 'Existing', workingDirectory: '', messages: [], createdAt: 1000, updatedAt: 2000 },
      ];
      store.currentConversationId = 'conv_1';
      chatStore.addUserMessage('Existing message');

      const newId = store.createNewConversation();

      expect(newId).not.toBe('conv_1');
      expect(store.currentConversationId).toBe(newId);
      expect(chatStore.messages).toHaveLength(0);
    });

    it('should handle rapid conversation operations', async () => {
      // Create multiple conversations rapidly
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(store.createNewConversation());
      }

      // All IDs should be unique
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(5);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================
  describe('edge cases', () => {
    it('should handle conversation with empty title', async () => {
      store.currentConversationId = 'conv_1';
      chatStore.setCurrentConversation('conv_1');
      // Only assistant message, no user message for title
      chatStore.startAssistantMessage('conv_1');
      chatStore.appendChunk('conv_1', 'Response');
      chatStore.finishStreaming('conv_1');

      await store.saveCurrentConversation();

      const savedConversation = mockElectron.conversation.save.mock.calls[0][0];
      expect(savedConversation.title).toBe('New Conversation');
    });

    it('should handle unicode in conversation title', async () => {
      store.currentConversationId = 'conv_1';
      chatStore.addUserMessage('你好世界 🌍 How are you?');

      await store.saveCurrentConversation();

      const savedConversation = mockElectron.conversation.save.mock.calls[0][0];
      expect(savedConversation.title).toBe('你好世界 🌍 How are you?');
    });

    it('should handle conversation with many messages', async () => {
      store.currentConversationId = 'conv_1';
      chatStore.setCurrentConversation('conv_1');

      // Add 50 message pairs
      for (let i = 0; i < 50; i++) {
        chatStore.addUserMessage(`Question ${i}`);
        chatStore.startAssistantMessage('conv_1');
        chatStore.appendChunk('conv_1', `Answer ${i}`);
        chatStore.finishStreaming('conv_1');
      }

      await store.saveCurrentConversation();

      const savedConversation = mockElectron.conversation.save.mock.calls[0][0];
      expect(savedConversation.messages.length).toBe(100);
    });

    it('should preserve conversation timestamps on update', async () => {
      store.conversations = [
        { id: 'conv_1', title: 'Test', workingDirectory: '', messages: [], createdAt: 1000, updatedAt: 2000 },
      ];
      store.currentConversationId = 'conv_1';
      chatStore.addUserMessage('New message');

      await store.saveCurrentConversation();

      const savedConversation = mockElectron.conversation.save.mock.calls[0][0];
      expect(savedConversation.createdAt).toBe(1000); // Preserved
      expect(savedConversation.updatedAt).toBeGreaterThan(2000); // Updated
    });
  });
});
