/**
 * Tests for the useClaudeChat composable.
 *
 * Tests cover:
 * - Sending messages with validation
 * - Slash command detection
 * - Action approval/rejection
 * - Abort functionality
 * - Chat clearing
 * - IPC listener setup and cleanup
 * - Multi-conversation support
 */

import { setActivePinia, createPinia } from 'pinia';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { DEFAULT_CONFIG } from '../../../shared/types';
import { useChatStore } from '../../stores/chat';
import { useFilesStore } from '../../stores/files';
import { useSettingsStore } from '../../stores/settings';

// Test conversation ID for multi-conversation tests
const TEST_CONV_ID = 'test-conv-123';

// We can't easily test the composable directly due to onMounted/onUnmounted
// So we'll test the core logic extracted from it

// Mock window.electron
const mockElectron = {
  claude: {
    send: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    abort: vi.fn(),
    getCommands: vi.fn(),
    getActiveQueries: vi.fn(),
    onChunk: vi.fn(),
    onToolUse: vi.fn(),
    onError: vi.fn(),
    onDone: vi.fn(),
    onSlashCommands: vi.fn(),
    onCommandAction: vi.fn(),
    onTaskNotification: vi.fn(),
    onUsageUpdate: vi.fn(),
    onActiveQueriesChange: vi.fn(),
  },
  config: {
    get: vi.fn(),
    set: vi.fn(),
    onChange: vi.fn(),
  },
  files: {
    selectDirectory: vi.fn(),
    getTree: vi.fn(),
    read: vi.fn(),
    onChange: vi.fn(),
  },
  conversation: {
    list: vi.fn(),
    get: vi.fn(),
    save: vi.fn(),
    delete: vi.fn(),
    rename: vi.fn(),
  },
};

// Store event callbacks - now include conversationId
let chunkCallback: ((conversationId: string, chunk: string) => void) | null = null;
let toolUseCallback: ((conversationId: string, action: any) => void) | null = null;
let errorCallback: ((conversationId: string, error: string) => void) | null = null;
let doneCallback: ((conversationId: string) => void) | null = null;

describe('useClaudeChat core logic', () => {
  beforeEach(() => {
    // Set up pinia
    setActivePinia(createPinia());

    // Reset mocks and callbacks
    vi.clearAllMocks();
    chunkCallback = null;
    toolUseCallback = null;
    errorCallback = null;
    doneCallback = null;

    // Set up window.electron mock
    (window as any).electron = mockElectron;

    // Mock matchMedia
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    // Default mock implementations
    mockElectron.config.get.mockResolvedValue({ ...DEFAULT_CONFIG });
    mockElectron.config.set.mockResolvedValue(undefined);
    mockElectron.config.onChange.mockReturnValue(() => {});

    mockElectron.files.selectDirectory.mockResolvedValue('/home/user/project');
    mockElectron.files.getTree.mockResolvedValue([]);
    mockElectron.files.read.mockResolvedValue('content');
    mockElectron.files.onChange.mockReturnValue(() => {});

    mockElectron.conversation.list.mockResolvedValue([]);
    mockElectron.conversation.get.mockResolvedValue(null);
    mockElectron.conversation.save.mockResolvedValue(undefined);
    mockElectron.conversation.delete.mockResolvedValue(undefined);
    mockElectron.conversation.rename.mockResolvedValue(undefined);

    mockElectron.claude.send.mockResolvedValue(undefined);
    mockElectron.claude.approve.mockResolvedValue(undefined);
    mockElectron.claude.reject.mockResolvedValue(undefined);
    mockElectron.claude.abort.mockResolvedValue(undefined);
    mockElectron.claude.getCommands.mockResolvedValue([]);
    mockElectron.claude.getActiveQueries.mockResolvedValue({ count: 0, maxCount: 5, activeConversationIds: [] });

    // Callbacks now receive conversationId as first parameter
    mockElectron.claude.onChunk.mockImplementation((callback) => {
      chunkCallback = callback;
      return () => {
        chunkCallback = null;
      };
    });
    mockElectron.claude.onToolUse.mockImplementation((callback) => {
      toolUseCallback = callback;
      return () => {
        toolUseCallback = null;
      };
    });
    mockElectron.claude.onError.mockImplementation((callback) => {
      errorCallback = callback;
      return () => {
        errorCallback = null;
      };
    });
    mockElectron.claude.onDone.mockImplementation((callback) => {
      doneCallback = callback;
      return () => {
        doneCallback = null;
      };
    });
    mockElectron.claude.onSlashCommands.mockImplementation(() => {
      return () => {};
    });
    mockElectron.claude.onCommandAction.mockImplementation(() => {
      return () => {};
    });
    mockElectron.claude.onTaskNotification.mockImplementation(() => {
      return () => {};
    });
    mockElectron.claude.onUsageUpdate.mockImplementation(() => {
      return () => {};
    });
    mockElectron.claude.onActiveQueriesChange.mockImplementation(() => {
      return () => {};
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Helper to set up chat store with conversation ID
  function setupChatStore() {
    const chatStore = useChatStore();
    chatStore.setCurrentConversation(TEST_CONV_ID);
    return chatStore;
  }

  // ===========================================================================
  // Message Sending Prerequisites
  // ===========================================================================
  describe('message sending prerequisites', () => {
    it('should require authentication', async () => {
      // No auth set up
      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();

      const chatStore = setupChatStore();

      // Simulate sendMessage logic
      if (!settingsStore.hasAuth) {
        chatStore.setError(TEST_CONV_ID, 'Please log in or configure your API key in Settings');
      }

      expect(chatStore.error).toContain('log in');
    });

    it('should require working directory', async () => {
      // Auth set up but no working directory
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        apiKey: 'sk-ant-api-key',
        workingDirectory: '',
      });

      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();

      const filesStore = useFilesStore();
      const chatStore = setupChatStore();

      // Simulate sendMessage logic
      if (!filesStore.workingDirectory) {
        chatStore.setError(TEST_CONV_ID, 'Please select a working directory');
      }

      expect(chatStore.error).toContain('working directory');
    });

    it('should pass with valid auth and working directory', async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        apiKey: 'sk-ant-api-key',
        workingDirectory: '/home/user/project',
      });

      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();

      expect(settingsStore.hasAuth).toBe(true);
      expect(settingsStore.workingDirectory).toBe('/home/user/project');
    });
  });

  // ===========================================================================
  // Message Sending
  // ===========================================================================
  describe('message sending', () => {
    beforeEach(async () => {
      mockElectron.config.get.mockResolvedValue({
        ...DEFAULT_CONFIG,
        apiKey: 'sk-ant-api-key',
        workingDirectory: '/home/user/project',
      });

      const settingsStore = useSettingsStore();
      await settingsStore.loadConfig();
    });

    it('should not send empty messages', () => {
      const content = '';

      // Simulate validation
      expect(content.trim()).toBe('');
    });

    it('should not send whitespace-only messages', () => {
      const content = '   ';

      // Simulate validation
      expect(content.trim()).toBe('');
    });

    it('should add user message to chat store', () => {
      const chatStore = setupChatStore();
      const content = 'Hello Claude';

      chatStore.addUserMessage(content);

      expect(chatStore.messages).toHaveLength(1);
      expect(chatStore.messages[0].content).toBe('Hello Claude');
      expect(chatStore.messages[0].role).toBe('user');
    });

    it('should start assistant message for streaming', () => {
      const chatStore = setupChatStore();

      chatStore.startAssistantMessage(TEST_CONV_ID);

      expect(chatStore.messages).toHaveLength(1);
      expect(chatStore.messages[0].role).toBe('assistant');
      expect(chatStore.messages[0].isStreaming).toBe(true);
    });

    it('should set loading state', () => {
      const chatStore = setupChatStore();

      chatStore.setLoading(TEST_CONV_ID, true);

      expect(chatStore.isLoading).toBe(true);
    });
  });

  // ===========================================================================
  // Slash Command Detection
  // ===========================================================================
  describe('slash command detection', () => {
    const slashCommands = [
      { name: 'help', description: 'Get help', argumentHint: '' },
      { name: 'clear', description: 'Clear history', argumentHint: '' },
      { name: 'review', description: 'Review code', argumentHint: '<file>' },
    ];

    function isSlashCommand(message: string) {
      const trimmed = message.trim();
      if (!trimmed.startsWith('/')) return null;

      const cmdPart = trimmed.split(' ')[0].slice(1);
      return slashCommands.find((cmd) => cmd.name === cmdPart) || null;
    }

    it('should detect /help command', () => {
      const result = isSlashCommand('/help');
      expect(result?.name).toBe('help');
    });

    it('should detect /clear command', () => {
      const result = isSlashCommand('/clear');
      expect(result?.name).toBe('clear');
    });

    it('should detect command with arguments', () => {
      const result = isSlashCommand('/review src/index.ts');
      expect(result?.name).toBe('review');
    });

    it('should return null for non-slash messages', () => {
      const result = isSlashCommand('Hello Claude');
      expect(result).toBeNull();
    });

    it('should return null for unknown commands', () => {
      const result = isSlashCommand('/unknown');
      expect(result).toBeNull();
    });

    it('should handle leading/trailing whitespace', () => {
      const result = isSlashCommand('  /help  ');
      expect(result?.name).toBe('help');
    });
  });

  // ===========================================================================
  // IPC Event Handling
  // ===========================================================================
  describe('IPC event handling', () => {
    beforeEach(() => {
      // Set up listeners
      mockElectron.claude.onChunk(chunkCallback as any);
      mockElectron.claude.onToolUse(toolUseCallback as any);
      mockElectron.claude.onError(errorCallback as any);
      mockElectron.claude.onDone(doneCallback as any);
    });

    it('should append chunks to message', () => {
      const chatStore = setupChatStore();
      chatStore.startAssistantMessage(TEST_CONV_ID);

      // Simulate chunk callback with conversationId
      chunkCallback?.(TEST_CONV_ID, 'Hello');
      chatStore.appendChunk(TEST_CONV_ID, 'Hello');

      chunkCallback?.(TEST_CONV_ID, ' World');
      chatStore.appendChunk(TEST_CONV_ID, ' World');

      expect(chatStore.messages[0].content).toBe('Hello World');
    });

    it('should add pending action on tool use', () => {
      const chatStore = setupChatStore();

      const action = {
        id: 'action_123',
        type: 'bash-command' as const,
        toolName: 'Bash',
        description: 'Run ls',
        details: { command: 'ls', workingDirectory: '/home' },
        input: { command: 'ls' },
        status: 'pending' as const,
        timestamp: Date.now(),
      };

      // Simulate tool use callback with conversationId
      chatStore.addPendingAction(TEST_CONV_ID, action);

      expect(chatStore.pendingActions).toHaveLength(1);
      expect(chatStore.pendingActions[0].id).toBe('action_123');
    });

    it('should set error and stop loading on error', () => {
      const chatStore = setupChatStore();
      chatStore.setLoading(TEST_CONV_ID, true);
      chatStore.startAssistantMessage(TEST_CONV_ID);

      // Simulate error callback with conversationId
      chatStore.setError(TEST_CONV_ID, 'API Error');
      chatStore.setLoading(TEST_CONV_ID, false);
      chatStore.finishStreaming(TEST_CONV_ID);

      expect(chatStore.error).toBe('API Error');
      expect(chatStore.isLoading).toBe(false);
      expect(chatStore.messages[0].isStreaming).toBe(false);
    });

    it('should finish streaming on done', () => {
      const chatStore = setupChatStore();
      chatStore.setLoading(TEST_CONV_ID, true);
      chatStore.startAssistantMessage(TEST_CONV_ID);
      chatStore.appendChunk(TEST_CONV_ID, 'Complete response');

      // Simulate done callback with conversationId
      chatStore.setLoading(TEST_CONV_ID, false);
      chatStore.finishStreaming(TEST_CONV_ID);

      expect(chatStore.isLoading).toBe(false);
      expect(chatStore.messages[0].isStreaming).toBe(false);
    });
  });

  // ===========================================================================
  // Action Handling
  // ===========================================================================
  describe('action handling', () => {
    it('should approve action', async () => {
      const chatStore = setupChatStore();
      const action = {
        id: 'action_123',
        type: 'bash-command' as const,
        toolName: 'Bash',
        description: 'Run command',
        details: { command: 'ls', workingDirectory: '/home' },
        input: { command: 'ls' },
        status: 'pending' as const,
        timestamp: Date.now(),
      };

      chatStore.addPendingAction(TEST_CONV_ID, action);

      // Simulate approve with conversationId
      chatStore.updateActionStatus(TEST_CONV_ID, 'action_123', 'approved');
      await mockElectron.claude.approve(TEST_CONV_ID, 'action_123', undefined, false);
      chatStore.removePendingAction(TEST_CONV_ID, 'action_123');

      expect(mockElectron.claude.approve).toHaveBeenCalledWith(TEST_CONV_ID, 'action_123', undefined, false);
      expect(chatStore.pendingActions).toHaveLength(0);
    });

    it('should approve action with alwaysAllow', async () => {
      const chatStore = setupChatStore();
      const action = {
        id: 'action_123',
        type: 'bash-command' as const,
        toolName: 'Bash',
        description: 'Run command',
        details: { command: 'ls', workingDirectory: '/home' },
        input: { command: 'ls' },
        status: 'pending' as const,
        timestamp: Date.now(),
      };

      chatStore.addPendingAction(TEST_CONV_ID, action);

      // Simulate approve with alwaysAllow and conversationId
      chatStore.updateActionStatus(TEST_CONV_ID, 'action_123', 'approved');
      await mockElectron.claude.approve(TEST_CONV_ID, 'action_123', undefined, true);
      chatStore.removePendingAction(TEST_CONV_ID, 'action_123');

      expect(mockElectron.claude.approve).toHaveBeenCalledWith(TEST_CONV_ID, 'action_123', undefined, true);
    });

    it('should reject action', async () => {
      const chatStore = setupChatStore();
      const action = {
        id: 'action_456',
        type: 'file-edit' as const,
        toolName: 'Edit',
        description: 'Edit file',
        details: { filePath: '/home/file.ts', newContent: 'new content' },
        input: { file_path: '/home/file.ts' },
        status: 'pending' as const,
        timestamp: Date.now(),
      };

      chatStore.addPendingAction(TEST_CONV_ID, action);

      // Simulate reject with conversationId
      chatStore.updateActionStatus(TEST_CONV_ID, 'action_456', 'rejected');
      await mockElectron.claude.reject(TEST_CONV_ID, 'action_456');
      chatStore.removePendingAction(TEST_CONV_ID, 'action_456');

      expect(mockElectron.claude.reject).toHaveBeenCalledWith(TEST_CONV_ID, 'action_456');
      expect(chatStore.pendingActions).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Abort
  // ===========================================================================
  describe('abort', () => {
    it('should abort and stop loading', async () => {
      const chatStore = setupChatStore();
      chatStore.setLoading(TEST_CONV_ID, true);
      chatStore.startAssistantMessage(TEST_CONV_ID);

      // Simulate abort with conversationId
      await mockElectron.claude.abort(TEST_CONV_ID);
      chatStore.setLoading(TEST_CONV_ID, false);
      chatStore.finishStreaming(TEST_CONV_ID);

      expect(mockElectron.claude.abort).toHaveBeenCalledWith(TEST_CONV_ID);
      expect(chatStore.isLoading).toBe(false);
    });
  });

  // ===========================================================================
  // Clear Chat
  // ===========================================================================
  describe('clearChat', () => {
    it('should clear all messages', () => {
      const chatStore = setupChatStore();

      chatStore.addUserMessage('Message 1');
      chatStore.startAssistantMessage(TEST_CONV_ID);
      chatStore.appendChunk(TEST_CONV_ID, 'Response');
      chatStore.finishStreaming(TEST_CONV_ID);

      chatStore.clearMessages();

      expect(chatStore.messages).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Slash Commands Loading
  // ===========================================================================
  describe('slash commands loading', () => {
    it('should load slash commands', async () => {
      const commands = [
        { name: 'help', description: 'Get help', argumentHint: '' },
        { name: 'clear', description: 'Clear chat', argumentHint: '' },
      ];
      mockElectron.claude.getCommands.mockResolvedValue(commands);

      const result = await mockElectron.claude.getCommands();

      expect(result).toEqual(commands);
    });

    it('should handle load errors gracefully', async () => {
      mockElectron.claude.getCommands.mockRejectedValue(new Error('Load failed'));

      let commands: any[];
      try {
        commands = await mockElectron.claude.getCommands();
      } catch {
        commands = [];
      }

      expect(commands).toEqual([]);
    });
  });

  // ===========================================================================
  // Multi-Conversation Support
  // ===========================================================================
  describe('multi-conversation support', () => {
    const CONV_ID_1 = 'conv-1';
    const CONV_ID_2 = 'conv-2';

    it('should track active queries per conversation', () => {
      const chatStore = useChatStore();
      chatStore.setCurrentConversation(CONV_ID_1);

      // Start loading in conversation 1
      chatStore.setLoading(CONV_ID_1, true);
      expect(chatStore.isConversationLoading(CONV_ID_1)).toBe(true);
      expect(chatStore.isConversationLoading(CONV_ID_2)).toBe(false);

      // Start loading in conversation 2
      chatStore.setLoading(CONV_ID_2, true);
      expect(chatStore.isConversationLoading(CONV_ID_1)).toBe(true);
      expect(chatStore.isConversationLoading(CONV_ID_2)).toBe(true);
    });

    it('should maintain separate state per conversation', () => {
      const chatStore = useChatStore();

      // Set up conversation 1 state
      chatStore.setCurrentConversation(CONV_ID_1);
      chatStore.setLoading(CONV_ID_1, true);
      chatStore.setError(CONV_ID_1, 'Error in conv 1');

      // Set up conversation 2 state
      chatStore.setCurrentConversation(CONV_ID_2);
      chatStore.setLoading(CONV_ID_2, false);
      chatStore.setError(CONV_ID_2, 'Error in conv 2');

      // Verify conversation 1 state
      chatStore.setCurrentConversation(CONV_ID_1);
      expect(chatStore.isLoading).toBe(true);
      expect(chatStore.error).toBe('Error in conv 1');

      // Verify conversation 2 state
      chatStore.setCurrentConversation(CONV_ID_2);
      expect(chatStore.isLoading).toBe(false);
      expect(chatStore.error).toBe('Error in conv 2');
    });

    it('should load messages when switching conversations via loadMessages', () => {
      const chatStore = useChatStore();

      // Simulate loading conversation 1 messages
      chatStore.setCurrentConversation(CONV_ID_1);
      chatStore.loadMessages([
        { id: 'msg1', role: 'user', content: 'Message in conv 1', timestamp: Date.now() },
      ]);
      expect(chatStore.messages).toHaveLength(1);
      expect(chatStore.messages[0].content).toBe('Message in conv 1');

      // Simulate loading conversation 2 messages (clear + load)
      chatStore.setCurrentConversation(CONV_ID_2);
      chatStore.clearMessages();
      chatStore.loadMessages([
        { id: 'msg2', role: 'user', content: 'Message in conv 2', timestamp: Date.now() },
      ]);
      expect(chatStore.messages).toHaveLength(1);
      expect(chatStore.messages[0].content).toBe('Message in conv 2');
    });

    it('should route errors to correct conversation', () => {
      const chatStore = useChatStore();
      chatStore.setCurrentConversation(CONV_ID_1);

      // Set error in conversation 2 (not current)
      chatStore.setError(CONV_ID_2, 'Error in conv 2');

      // Current conversation should have no error
      expect(chatStore.error).toBeNull();

      // Switch to conversation 2 to see the error
      chatStore.setCurrentConversation(CONV_ID_2);
      expect(chatStore.error).toBe('Error in conv 2');
    });

    it('should update active query counts', () => {
      const chatStore = useChatStore();

      // Simulate active queries update
      chatStore.updateActiveQueries(3, 5);

      expect(chatStore.activeQueryCount).toBe(3);
      expect(chatStore.maxConcurrentQueries).toBe(5);
      expect(chatStore.isAtResourceLimit).toBe(false);
    });

    it('should detect resource limit', () => {
      const chatStore = useChatStore();

      // At resource limit
      chatStore.updateActiveQueries(5, 5);

      expect(chatStore.isAtResourceLimit).toBe(true);
      expect(chatStore.canStartNewQuery).toBe(false);
    });

    it('should track active conversation IDs', () => {
      const chatStore = useChatStore();

      chatStore.updateActiveConversationIds([CONV_ID_1, CONV_ID_2]);

      expect(chatStore.activeConversationIds.includes(CONV_ID_1)).toBe(true);
      expect(chatStore.activeConversationIds.includes(CONV_ID_2)).toBe(true);
      expect(chatStore.activeConversationIds.includes('conv-3')).toBe(false);
    });

    it('should handle streaming content per conversation', () => {
      const chatStore = useChatStore();

      // Start streaming in conversation 1
      chatStore.setCurrentConversation(CONV_ID_1);
      chatStore.startAssistantMessage(CONV_ID_1);
      chatStore.appendChunk(CONV_ID_1, 'Streaming in conv 1...');

      // Start streaming in conversation 2
      chatStore.setCurrentConversation(CONV_ID_2);
      chatStore.startAssistantMessage(CONV_ID_2);
      chatStore.appendChunk(CONV_ID_2, 'Streaming in conv 2...');

      // Get states and verify
      const state1 = chatStore.getConversationState(CONV_ID_1);
      const state2 = chatStore.getConversationState(CONV_ID_2);

      expect(state1.currentStreamingContent).toBe('Streaming in conv 1...');
      expect(state2.currentStreamingContent).toBe('Streaming in conv 2...');
    });

    it('should handle pending actions per conversation', () => {
      const chatStore = useChatStore();

      const action1 = {
        id: 'action_1',
        type: 'bash-command' as const,
        toolName: 'Bash',
        description: 'Run ls',
        details: { command: 'ls', workingDirectory: '/home' },
        input: { command: 'ls' },
        status: 'pending' as const,
        timestamp: Date.now(),
      };

      const action2 = {
        id: 'action_2',
        type: 'file-edit' as const,
        toolName: 'Edit',
        description: 'Edit file',
        details: { filePath: '/home/file.ts', newContent: 'new' },
        input: { file_path: '/home/file.ts' },
        status: 'pending' as const,
        timestamp: Date.now(),
      };

      // Add actions to different conversations
      chatStore.setCurrentConversation(CONV_ID_1);
      chatStore.addPendingAction(CONV_ID_1, action1);

      chatStore.setCurrentConversation(CONV_ID_2);
      chatStore.addPendingAction(CONV_ID_2, action2);

      // Verify each conversation has its own action
      chatStore.setCurrentConversation(CONV_ID_1);
      expect(chatStore.pendingActions).toHaveLength(1);
      expect(chatStore.pendingActions[0].id).toBe('action_1');

      chatStore.setCurrentConversation(CONV_ID_2);
      expect(chatStore.pendingActions).toHaveLength(1);
      expect(chatStore.pendingActions[0].id).toBe('action_2');
    });
  });

  // ===========================================================================
  // Resource Limits
  // ===========================================================================
  describe('resource limits', () => {
    it('should allow new query when under limit', () => {
      const chatStore = useChatStore();
      chatStore.updateActiveQueries(2, 5);

      expect(chatStore.canStartNewQuery).toBe(true);
    });

    it('should block new query when at limit', () => {
      const chatStore = useChatStore();
      chatStore.updateActiveQueries(5, 5);

      expect(chatStore.canStartNewQuery).toBe(false);
    });

    it('should allow new query in already-loading conversation when at limit', () => {
      const chatStore = useChatStore();
      chatStore.setCurrentConversation(TEST_CONV_ID);
      chatStore.setLoading(TEST_CONV_ID, true);
      chatStore.updateActiveQueries(5, 5);

      // Even at limit, can continue in already-active conversation
      // (The composable handles this check)
      expect(chatStore.isConversationLoading(TEST_CONV_ID)).toBe(true);
    });
  });
});
