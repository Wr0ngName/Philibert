/**
 * Comprehensive tests for the chat store.
 *
 * Tests cover:
 * - Message management (add, append, stream, clear, load)
 * - Pending actions lifecycle (add, remove, update status)
 * - Loading and error state management
 * - Message limit enforcement (MAX_COUNT)
 * - Getters accuracy (hasMessages, hasPendingActions, lastMessage)
 * - Edge cases (unicode, long messages, rapid appends, empty content)
 * - Integration scenarios (full conversation flow, tool approval flow)
 *
 * Updated for multi-conversation support - methods now require conversationId
 */

import { setActivePinia, createPinia } from 'pinia';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { ChatMessage, PendingAction, BashCommandAction, FileEditAction } from '@shared/types';

import { useChatStore } from '../chat';

// Test conversation ID used throughout tests
const TEST_CONV_ID = 'test-conv-123';

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

// Helper to create valid FileEditAction
function createFileEditAction(overrides: Partial<FileEditAction> & { id: string }): FileEditAction {
  return {
    type: 'file-edit',
    toolName: 'Edit',
    description: 'Edit file',
    input: {},
    status: 'pending',
    timestamp: Date.now(),
    details: { filePath: '/tmp/test.txt', newContent: 'content' },
    ...overrides,
  };
}

// Mock CONSTANTS with testable values
vi.mock('../../constants/app', () => ({
  CONSTANTS: {
    MESSAGES: {
      MAX_COUNT: 100,
    },
  },
}));

describe('useChatStore', () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useChatStore();
    // Set current conversation for tests
    store.setCurrentConversation(TEST_CONV_ID);
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Initial State
  // ===========================================================================
  describe('initial state', () => {
    it('should have empty messages', () => {
      expect(store.messages).toEqual([]);
    });

    it('should have empty pending actions', () => {
      expect(store.pendingActions).toEqual([]);
    });

    it('should not be loading', () => {
      expect(store.isLoading).toBe(false);
    });

    it('should have no error', () => {
      expect(store.error).toBeNull();
    });

    it('should have empty currentStreamingContent', () => {
      expect(store.currentStreamingContent).toBe('');
    });
  });

  // ===========================================================================
  // Getters
  // ===========================================================================
  describe('getters', () => {
    describe('hasMessages', () => {
      it('should be false when empty', () => {
        expect(store.hasMessages).toBe(false);
      });

      it('should be true when messages exist', () => {
        store.addUserMessage('Hello');
        expect(store.hasMessages).toBe(true);
      });

      it('should be true with single assistant message', () => {
        store.startAssistantMessage(TEST_CONV_ID);
        expect(store.hasMessages).toBe(true);
      });

      it('should become false after clearing messages', () => {
        store.addUserMessage('Test');
        expect(store.hasMessages).toBe(true);
        store.clearMessages();
        expect(store.hasMessages).toBe(false);
      });
    });

    describe('hasPendingActions', () => {
      it('should be false when empty', () => {
        expect(store.hasPendingActions).toBe(false);
      });

      it('should be true when actions exist', () => {
        store.addPendingAction(TEST_CONV_ID, createBashAction({ id: 'action-1' }));
        expect(store.hasPendingActions).toBe(true);
      });

      it('should become false after removing all actions', () => {
        store.addPendingAction(TEST_CONV_ID, createBashAction({ id: 'action-1' }));
        expect(store.hasPendingActions).toBe(true);
        store.removePendingAction(TEST_CONV_ID, 'action-1');
        expect(store.hasPendingActions).toBe(false);
      });
    });

    describe('lastMessage', () => {
      it('should be null when empty', () => {
        expect(store.lastMessage).toBeNull();
      });

      it('should return last message', () => {
        store.addUserMessage('First');
        store.addUserMessage('Second');
        expect(store.lastMessage?.content).toBe('Second');
      });

      it('should update when new message is added', () => {
        store.addUserMessage('Original');
        expect(store.lastMessage?.content).toBe('Original');
        store.addUserMessage('New');
        expect(store.lastMessage?.content).toBe('New');
      });

      it('should return assistant message when streaming', () => {
        store.addUserMessage('Question');
        store.startAssistantMessage(TEST_CONV_ID);
        store.appendChunk(TEST_CONV_ID, 'Answer');
        expect(store.lastMessage?.role).toBe('assistant');
        expect(store.lastMessage?.content).toBe('Answer');
      });
    });
  });

  // ===========================================================================
  // addMessage
  // ===========================================================================
  describe('addMessage', () => {
    it('should add message to array', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Test message',
        timestamp: Date.now(),
      };
      store.addMessage(message);
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0]).toEqual(message);
    });

    it('should preserve message order', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'First', timestamp: 1000 },
        { id: 'msg-2', role: 'assistant', content: 'Second', timestamp: 2000 },
        { id: 'msg-3', role: 'user', content: 'Third', timestamp: 3000 },
      ];
      messages.forEach((msg) => store.addMessage(msg));
      expect(store.messages).toHaveLength(3);
      expect(store.messages[0].content).toBe('First');
      expect(store.messages[1].content).toBe('Second');
      expect(store.messages[2].content).toBe('Third');
    });

    it('should enforce message limit by removing oldest', () => {
      // Add more than MAX_COUNT messages
      for (let i = 0; i < 105; i++) {
        store.addMessage({
          id: `msg-${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: i,
        });
      }
      // Should only have MAX_COUNT messages (100)
      expect(store.messages).toHaveLength(100);
      // Should have removed oldest (first 5)
      expect(store.messages[0].content).toBe('Message 5');
      expect(store.messages[99].content).toBe('Message 104');
    });

    it('should handle exactly MAX_COUNT messages', () => {
      for (let i = 0; i < 100; i++) {
        store.addMessage({
          id: `msg-${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: i,
        });
      }
      expect(store.messages).toHaveLength(100);
      expect(store.messages[0].content).toBe('Message 0');
    });
  });

  // ===========================================================================
  // addUserMessage
  // ===========================================================================
  describe('addUserMessage', () => {
    it('should add a user message', () => {
      const message = store.addUserMessage('Hello');
      expect(store.messages).toHaveLength(1);
      expect(message.role).toBe('user');
      expect(message.content).toBe('Hello');
      expect(message.id).toMatch(/^msg_/);
      expect(message.timestamp).toBeGreaterThan(0);
    });

    it('should generate unique IDs', () => {
      const msg1 = store.addUserMessage('First');
      const msg2 = store.addUserMessage('Second');
      expect(msg1.id).not.toBe(msg2.id);
    });

    it('should handle empty content', () => {
      const message = store.addUserMessage('');
      expect(message.content).toBe('');
      expect(store.messages).toHaveLength(1);
    });

    it('should handle multiline content', () => {
      const content = 'Line 1\nLine 2\nLine 3';
      const message = store.addUserMessage(content);
      expect(message.content).toBe(content);
    });

    it('should handle special characters and emoji', () => {
      const content = 'Test with <script>alert("xss")</script> and emoji 🎉 and unicode 你好';
      const message = store.addUserMessage(content);
      expect(message.content).toBe(content);
    });

    it('should handle very long content', () => {
      const longContent = 'x'.repeat(100000);
      const message = store.addUserMessage(longContent);
      expect(message.content).toHaveLength(100000);
    });
  });

  // ===========================================================================
  // startAssistantMessage
  // ===========================================================================
  describe('startAssistantMessage', () => {
    it('should add an empty streaming message', () => {
      const message = store.startAssistantMessage(TEST_CONV_ID);
      expect(store.messages).toHaveLength(1);
      expect(message.role).toBe('assistant');
      expect(message.content).toBe('');
      expect(message.isStreaming).toBe(true);
    });

    it('should reset currentStreamingContent', () => {
      store.startAssistantMessage(TEST_CONV_ID);
      store.appendChunk(TEST_CONV_ID, 'old content');
      store.finishStreaming(TEST_CONV_ID);

      // Start new message
      store.startAssistantMessage(TEST_CONV_ID);
      expect(store.currentStreamingContent).toBe('');
    });

    it('should generate unique ID', () => {
      const msg1 = store.startAssistantMessage(TEST_CONV_ID);
      store.finishStreaming(TEST_CONV_ID);
      const msg2 = store.startAssistantMessage(TEST_CONV_ID);
      expect(msg1.id).not.toBe(msg2.id);
    });

    it('should set timestamp', () => {
      const before = Date.now();
      const message = store.startAssistantMessage(TEST_CONV_ID);
      const after = Date.now();
      expect(message.timestamp).toBeGreaterThanOrEqual(before);
      expect(message.timestamp).toBeLessThanOrEqual(after);
    });
  });

  // ===========================================================================
  // appendChunk (formerly appendToLastMessage)
  // ===========================================================================
  describe('appendChunk', () => {
    it('should append content to last assistant message', () => {
      store.startAssistantMessage(TEST_CONV_ID);
      store.appendChunk(TEST_CONV_ID, 'Hello');
      store.appendChunk(TEST_CONV_ID, ' World');
      expect(store.messages[0].content).toBe('Hello World');
      expect(store.currentStreamingContent).toBe('Hello World');
    });

    it('should handle empty chunks', () => {
      store.startAssistantMessage(TEST_CONV_ID);
      store.appendChunk(TEST_CONV_ID, '');
      store.appendChunk(TEST_CONV_ID, 'Content');
      store.appendChunk(TEST_CONV_ID, '');
      expect(store.messages[0].content).toBe('Content');
    });

    it('should handle rapid successive appends', () => {
      store.startAssistantMessage(TEST_CONV_ID);
      // Simulate rapid streaming
      for (let i = 0; i < 100; i++) {
        store.appendChunk(TEST_CONV_ID, `${i} `);
      }
      const expected = Array.from({ length: 100 }, (_, i) => `${i} `).join('');
      expect(store.messages[0].content).toBe(expected);
      expect(store.currentStreamingContent).toBe(expected);
    });

    it('should handle unicode in chunks', () => {
      store.startAssistantMessage(TEST_CONV_ID);
      store.appendChunk(TEST_CONV_ID, 'Hello ');
      store.appendChunk(TEST_CONV_ID, '世界 ');
      store.appendChunk(TEST_CONV_ID, '🌍');
      expect(store.messages[0].content).toBe('Hello 世界 🌍');
    });

    it('should handle newlines in chunks', () => {
      store.startAssistantMessage(TEST_CONV_ID);
      store.appendChunk(TEST_CONV_ID, 'Line 1\n');
      store.appendChunk(TEST_CONV_ID, 'Line 2\n');
      store.appendChunk(TEST_CONV_ID, 'Line 3');
      expect(store.messages[0].content).toBe('Line 1\nLine 2\nLine 3');
    });
  });

  // ===========================================================================
  // finishStreaming
  // ===========================================================================
  describe('finishStreaming', () => {
    it('should mark last message as not streaming', () => {
      store.startAssistantMessage(TEST_CONV_ID);
      store.appendChunk(TEST_CONV_ID, 'Complete message');
      store.finishStreaming(TEST_CONV_ID);
      expect(store.messages[0].isStreaming).toBe(false);
    });

    it('should be idempotent', () => {
      store.startAssistantMessage(TEST_CONV_ID);
      store.appendChunk(TEST_CONV_ID, 'Content');
      store.finishStreaming(TEST_CONV_ID);
      store.finishStreaming(TEST_CONV_ID);
      store.finishStreaming(TEST_CONV_ID);
      expect(store.messages[0].isStreaming).toBe(false);
    });

    it('should handle empty message content', () => {
      store.startAssistantMessage(TEST_CONV_ID);
      store.finishStreaming(TEST_CONV_ID);
      expect(store.messages[0].content).toBe('');
      expect(store.messages[0].isStreaming).toBe(false);
    });
  });

  // ===========================================================================
  // Pending Actions
  // ===========================================================================
  describe('addPendingAction', () => {
    it('should add action to pending actions', () => {
      const action = createBashAction({ id: 'action-1' });
      store.addPendingAction(TEST_CONV_ID, action);
      expect(store.pendingActions).toHaveLength(1);
      expect(store.pendingActions[0]).toEqual(action);
      expect(store.hasPendingActions).toBe(true);
    });

    it('should allow multiple actions', () => {
      const actions: PendingAction[] = [
        createFileEditAction({ id: 'a1', description: 'Edit 1' }),
        createFileEditAction({ id: 'a2', description: 'Edit 2' }),
        createBashAction({ id: 'a3', description: 'Run' }),
      ];
      actions.forEach((a) => store.addPendingAction(TEST_CONV_ID, a));
      expect(store.pendingActions).toHaveLength(3);
    });

    it('should preserve action order', () => {
      store.addPendingAction(TEST_CONV_ID, createBashAction({ id: 'first', description: 'First' }));
      store.addPendingAction(TEST_CONV_ID, createBashAction({ id: 'second', description: 'Second' }));
      expect(store.pendingActions[0].id).toBe('first');
      expect(store.pendingActions[1].id).toBe('second');
    });
  });

  describe('removePendingAction', () => {
    it('should remove action by id', () => {
      store.addPendingAction(TEST_CONV_ID, createFileEditAction({ id: 'action-1' }));
      store.addPendingAction(TEST_CONV_ID, createBashAction({ id: 'action-2' }));
      store.removePendingAction(TEST_CONV_ID, 'action-1');
      expect(store.pendingActions).toHaveLength(1);
      expect(store.pendingActions[0].id).toBe('action-2');
    });

    it('should handle non-existent action id gracefully', () => {
      store.addPendingAction(TEST_CONV_ID, createFileEditAction({ id: 'action-1' }));
      store.removePendingAction(TEST_CONV_ID, 'non-existent');
      expect(store.pendingActions).toHaveLength(1);
    });

    it('should remove from middle of array', () => {
      store.addPendingAction(TEST_CONV_ID, createBashAction({ id: 'a1', description: '1' }));
      store.addPendingAction(TEST_CONV_ID, createBashAction({ id: 'a2', description: '2' }));
      store.addPendingAction(TEST_CONV_ID, createBashAction({ id: 'a3', description: '3' }));
      store.removePendingAction(TEST_CONV_ID, 'a2');
      expect(store.pendingActions).toHaveLength(2);
      expect(store.pendingActions[0].id).toBe('a1');
      expect(store.pendingActions[1].id).toBe('a3');
    });
  });

  describe('updateActionStatus', () => {
    it('should update action status to approved', () => {
      store.addPendingAction(TEST_CONV_ID, createFileEditAction({ id: 'action-1' }));
      store.updateActionStatus(TEST_CONV_ID, 'action-1', 'approved');
      expect(store.pendingActions[0].status).toBe('approved');
    });

    it('should update action status to rejected', () => {
      store.addPendingAction(TEST_CONV_ID, createFileEditAction({ id: 'action-1' }));
      store.updateActionStatus(TEST_CONV_ID, 'action-1', 'rejected');
      expect(store.pendingActions[0].status).toBe('rejected');
    });

    it('should handle non-existent action gracefully', () => {
      store.updateActionStatus(TEST_CONV_ID, 'non-existent', 'approved');
      // Should not throw
      expect(store.pendingActions).toHaveLength(0);
    });

    it('should update correct action when multiple exist', () => {
      store.addPendingAction(TEST_CONV_ID, createBashAction({ id: 'a1', description: '1' }));
      store.addPendingAction(TEST_CONV_ID, createBashAction({ id: 'a2', description: '2' }));
      store.updateActionStatus(TEST_CONV_ID, 'a2', 'approved');
      expect(store.pendingActions[0].status).toBe('pending');
      expect(store.pendingActions[1].status).toBe('approved');
    });
  });

  // ===========================================================================
  // Loading State
  // ===========================================================================
  describe('setLoading', () => {
    it('should set loading to true', () => {
      store.setLoading(TEST_CONV_ID, true);
      expect(store.isLoading).toBe(true);
    });

    it('should set loading to false', () => {
      store.setLoading(TEST_CONV_ID, true);
      store.setLoading(TEST_CONV_ID, false);
      expect(store.isLoading).toBe(false);
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================
  describe('setError', () => {
    it('should set error message', () => {
      store.setError(TEST_CONV_ID, 'Something went wrong');
      expect(store.error).toBe('Something went wrong');
    });

    it('should allow null to clear error', () => {
      store.setError(TEST_CONV_ID, 'Error');
      store.setError(TEST_CONV_ID, null);
      expect(store.error).toBeNull();
    });
  });

  describe('clearError', () => {
    it('should clear error', () => {
      store.setError(TEST_CONV_ID, 'Error message');
      store.clearError();
      expect(store.error).toBeNull();
    });

    it('should be safe to call when no error', () => {
      store.clearError();
      expect(store.error).toBeNull();
    });
  });

  // ===========================================================================
  // clearMessages
  // ===========================================================================
  describe('clearMessages', () => {
    it('should clear all messages', () => {
      store.addUserMessage('Test');
      store.startAssistantMessage(TEST_CONV_ID);
      store.appendChunk(TEST_CONV_ID, 'Response');
      store.clearMessages();
      expect(store.messages).toEqual([]);
    });

    it('should reset all message-related state', () => {
      store.addUserMessage('Test');
      store.startAssistantMessage(TEST_CONV_ID);
      store.appendChunk(TEST_CONV_ID, 'Response');

      store.clearMessages();

      expect(store.messages).toEqual([]);
    });
  });

  // ===========================================================================
  // loadMessages
  // ===========================================================================
  describe('loadMessages', () => {
    it('should replace all messages', () => {
      store.addUserMessage('Old message');
      const newMessages: ChatMessage[] = [
        { id: 'new-1', role: 'user', content: 'New 1', timestamp: 1000 },
        { id: 'new-2', role: 'assistant', content: 'New 2', timestamp: 2000 },
      ];
      store.loadMessages(newMessages);
      expect(store.messages).toHaveLength(2);
      expect(store.messages[0].content).toBe('New 1');
      expect(store.messages[1].content).toBe('New 2');
    });

    it('should handle empty array', () => {
      store.addUserMessage('Existing');
      store.loadMessages([]);
      expect(store.messages).toHaveLength(0);
    });

    it('should set messages to provided array', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Test', timestamp: 1000 },
      ];
      store.loadMessages(messages);
      expect(store.messages).toStrictEqual(messages);
    });

    it('should load large conversation history', () => {
      const messages: ChatMessage[] = Array.from({ length: 50 }, (_, i) => ({
        id: `msg-${i}`,
        role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `Message ${i}`,
        timestamp: i * 1000,
      }));
      store.loadMessages(messages);
      expect(store.messages).toHaveLength(50);
    });
  });

  // ===========================================================================
  // Integration Scenarios
  // ===========================================================================
  describe('complete conversation flow', () => {
    it('should handle a full conversation cycle', () => {
      // User sends message
      store.addUserMessage('Hello, can you help me?');
      expect(store.messages).toHaveLength(1);
      expect(store.hasMessages).toBe(true);

      // Start streaming response
      store.setLoading(TEST_CONV_ID, true);
      const assistantMsg = store.startAssistantMessage(TEST_CONV_ID);
      expect(store.messages).toHaveLength(2);
      expect(assistantMsg.isStreaming).toBe(true);

      // Stream chunks
      store.appendChunk(TEST_CONV_ID, 'Of course!');
      store.appendChunk(TEST_CONV_ID, ' How can I assist you today?');
      expect(store.currentStreamingContent).toBe('Of course! How can I assist you today?');

      // Finish streaming
      store.finishStreaming(TEST_CONV_ID);
      store.setLoading(TEST_CONV_ID, false);

      expect(store.messages[1].isStreaming).toBe(false);
      expect(store.isLoading).toBe(false);
      expect(store.messages[1].content).toBe('Of course! How can I assist you today?');
    });

    it('should handle tool use approval flow', () => {
      // User sends message
      store.addUserMessage('Run the tests');
      store.setLoading(TEST_CONV_ID, true);
      store.startAssistantMessage(TEST_CONV_ID);
      store.appendChunk(TEST_CONV_ID, 'I\'ll run the tests for you.');
      store.finishStreaming(TEST_CONV_ID);

      // Tool use requested
      const action = createBashAction({
        id: 'tool-1',
        description: 'npm test',
        details: { command: 'npm test', workingDirectory: '/project' },
      });
      store.addPendingAction(TEST_CONV_ID, action);
      expect(store.hasPendingActions).toBe(true);

      // User approves
      store.updateActionStatus(TEST_CONV_ID, 'tool-1', 'approved');
      expect(store.pendingActions[0].status).toBe('approved');

      // Action completed, remove
      store.removePendingAction(TEST_CONV_ID, 'tool-1');
      expect(store.hasPendingActions).toBe(false);

      store.setLoading(TEST_CONV_ID, false);
    });

    it('should handle error during conversation', () => {
      store.addUserMessage('Do something');
      store.setLoading(TEST_CONV_ID, true);
      store.startAssistantMessage(TEST_CONV_ID);

      // Error occurs
      store.setError(TEST_CONV_ID, 'Connection lost');
      store.setLoading(TEST_CONV_ID, false);

      expect(store.error).toBe('Connection lost');
      expect(store.isLoading).toBe(false);

      // User clears error
      store.clearError();
      expect(store.error).toBeNull();
    });

    it('should handle multiple user-assistant exchanges', () => {
      // Add multiple exchanges
      for (let i = 0; i < 10; i++) {
        store.addUserMessage(`Question ${i}`);
        store.startAssistantMessage(TEST_CONV_ID);
        store.appendChunk(TEST_CONV_ID, `Answer ${i}`);
        store.finishStreaming(TEST_CONV_ID);
      }

      expect(store.messages).toHaveLength(20);

      // Verify alternating pattern
      for (let i = 0; i < 20; i++) {
        const expected = i % 2 === 0 ? 'user' : 'assistant';
        expect(store.messages[i].role).toBe(expected);
      }
    });

    it('should handle concurrent action updates', () => {
      // Add multiple actions
      for (let i = 0; i < 5; i++) {
        store.addPendingAction(TEST_CONV_ID, createFileEditAction({
          id: `action-${i}`,
          description: `Edit ${i}`,
        }));
      }

      // Update all to approved
      for (let i = 0; i < 5; i++) {
        store.updateActionStatus(TEST_CONV_ID, `action-${i}`, 'approved');
      }

      // Verify all updated
      store.pendingActions.forEach((action) => {
        expect(action.status).toBe('approved');
      });
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================
  describe('edge cases', () => {
    it('should handle unicode content throughout', () => {
      const unicodeContent = '你好世界 🌍 مرحبا العالم Привет мир';
      const message = store.addUserMessage(unicodeContent);
      expect(message.content).toBe(unicodeContent);
    });

    it('should handle message limit with alternating user/assistant', () => {
      // Fill up to limit with alternating messages
      for (let i = 0; i < 60; i++) {
        if (i % 2 === 0) {
          store.addUserMessage(`User ${i}`);
        } else {
          store.startAssistantMessage(TEST_CONV_ID);
          store.appendChunk(TEST_CONV_ID, `Assistant ${i}`);
          store.finishStreaming(TEST_CONV_ID);
        }
      }
      expect(store.messages.length).toBeLessThanOrEqual(100);
    });

    it('should handle empty append followed by content', () => {
      store.startAssistantMessage(TEST_CONV_ID);
      store.appendChunk(TEST_CONV_ID, '');
      store.appendChunk(TEST_CONV_ID, '');
      store.appendChunk(TEST_CONV_ID, 'Finally content');
      store.appendChunk(TEST_CONV_ID, '');
      expect(store.messages[0].content).toBe('Finally content');
    });
  });

  // ===========================================================================
  // Multi-conversation support
  // ===========================================================================
  describe('multi-conversation support', () => {
    it('should track state per conversation', () => {
      const conv1 = 'conv-1';
      const conv2 = 'conv-2';

      // Set loading for conv1
      store.setCurrentConversation(conv1);
      store.setLoading(conv1, true);

      // Check conv1 is loading
      expect(store.isLoading).toBe(true);

      // Switch to conv2
      store.setCurrentConversation(conv2);
      store.setLoading(conv2, false);

      // Check conv2 is not loading
      expect(store.isLoading).toBe(false);

      // Check conv1 is still loading
      expect(store.isConversationLoading(conv1)).toBe(true);
    });

    it('should isolate pending actions per conversation', () => {
      const conv1 = 'conv-1';
      const conv2 = 'conv-2';

      store.setCurrentConversation(conv1);
      store.addPendingAction(conv1, createBashAction({ id: 'action-1' }));

      store.setCurrentConversation(conv2);
      store.addPendingAction(conv2, createBashAction({ id: 'action-2' }));

      // Check conv1 actions
      store.setCurrentConversation(conv1);
      expect(store.pendingActions).toHaveLength(1);
      expect(store.pendingActions[0].id).toBe('action-1');

      // Check conv2 actions
      store.setCurrentConversation(conv2);
      expect(store.pendingActions).toHaveLength(1);
      expect(store.pendingActions[0].id).toBe('action-2');
    });

    it('should track resource limits', () => {
      store.updateActiveQueries(3, 5, 1);
      expect(store.activeQueryCount).toBe(3);
      expect(store.maxConcurrentQueries).toBe(5);
      expect(store.processingQueryCount).toBe(1);
      expect(store.isAtResourceLimit).toBe(false);
      expect(store.canStartNewQuery).toBe(true);

      store.updateActiveQueries(5, 5, 2);
      expect(store.isAtResourceLimit).toBe(true);
      expect(store.canStartNewQuery).toBe(false);
    });
  });

  describe('tool use enrichment from permission', () => {
    it('enriches an auto-captured AskUserQuestion entry without creating a duplicate when input JSON differs after IPC', () => {
      // Repro: AskUserQuestion's questions[].options[] payload can serialize
      // differently after structuredClone, so the previous match condition
      // (strict input JSON equality) failed and the fallback added a second
      // inline indicator. The single indicator should survive enrichment.
      const TOOL_USE_ID = 'toolu_AskUserQ_xxxxxxxxxxxxxxxxxxxxxxxx';
      const ACTION_ID = 'action_aboard_question';

      store.addAutoToolUseMessage(TEST_CONV_ID, {
        toolUseBlockId: TOOL_USE_ID,
        toolName: 'AskUserQuestion',
        // generic description from generateToolDescription default case
        description: 'Tool: AskUserQuestion',
        // Original input order (as emitted by the SDK assistant message)
        input: { questions: [{ header: 'A', question: 'q?', multiSelect: false, options: [{ label: 'X', description: 'd' }] }] },
      });

      store.enrichToolUseFromPermission(TEST_CONV_ID, {
        id: ACTION_ID,
        type: 'ask-user-question',
        toolName: 'AskUserQuestion',
        description: 'q?',
        // Different key order — this is the IPC-after-clone scenario
        input: { questions: [{ question: 'q?', header: 'A', options: [{ description: 'd', label: 'X' }], multiSelect: false }] },
        status: 'pending',
        timestamp: Date.now(),
        details: {
          questions: [{ question: 'q?', header: 'A', multiSelect: false, options: [{ label: 'X', description: 'd' }] }],
          truncated: false,
        },
      });

      const toolUseMessages = store.messages.filter(m => m.toolUse?.toolName === 'AskUserQuestion');
      expect(toolUseMessages).toHaveLength(1);
      expect(toolUseMessages[0].toolUse?.actionId).toBe(ACTION_ID);
      expect(toolUseMessages[0].toolUse?.toolUseBlockId).toBe(TOOL_USE_ID);
      expect(toolUseMessages[0].toolUse?.description).toBe('q?');
      expect(toolUseMessages[0].toolUse?.status).toBe('pending');
    });

    it('pairs canUseTool calls with their corresponding tool_use blocks in FIFO order for parallel Bash', () => {
      const captures = [
        { toolUseBlockId: 'toolu_b1', description: 'Run cmd 1', input: { command: 'echo 1' } },
        { toolUseBlockId: 'toolu_b2', description: 'Run cmd 2', input: { command: 'echo 2' } },
        { toolUseBlockId: 'toolu_b3', description: 'Run cmd 3', input: { command: 'echo 3' } },
      ];
      for (const c of captures) {
        store.addAutoToolUseMessage(TEST_CONV_ID, { ...c, toolName: 'Bash' });
      }

      const actionIds = ['action_b1', 'action_b2', 'action_b3'];
      for (let i = 0; i < captures.length; i++) {
        store.enrichToolUseFromPermission(TEST_CONV_ID, createBashAction({
          id: actionIds[i],
          input: captures[i].input,
          description: captures[i].description,
        }));
      }

      const toolUseMessages = store.messages.filter(m => m.toolUse?.toolName === 'Bash');
      expect(toolUseMessages).toHaveLength(3);
      // FIFO pairing: capture[i] ↔ action[i]
      expect(toolUseMessages[0].toolUse?.toolUseBlockId).toBe('toolu_b1');
      expect(toolUseMessages[0].toolUse?.actionId).toBe('action_b1');
      expect(toolUseMessages[1].toolUse?.toolUseBlockId).toBe('toolu_b2');
      expect(toolUseMessages[1].toolUse?.actionId).toBe('action_b2');
      expect(toolUseMessages[2].toolUse?.toolUseBlockId).toBe('toolu_b3');
      expect(toolUseMessages[2].toolUse?.actionId).toBe('action_b3');
    });
  });

  describe('background task lifecycle', () => {
    it('remaps the initial toolUseId-keyed entry when task_started arrives before user-message remap', () => {
      // Replays the real SDK sequence captured in production logs:
      //  1. Tool use block detected         → running, taskId = toolu_xxx
      //  2. task_started (no previousTaskId)→ running, taskId = bash_xxx, toolUseId = toolu_xxx
      //  3. User-message remap               → running, taskId = bash_xxx, previousTaskId = toolu_xxx
      //  4. task_updated                     → completed, taskId = bash_xxx
      //
      // Without the implicit toolUseId remap in handleTaskNotification, step 2
      // creates a brand-new entry under bash_xxx while leaving toolu_xxx orphaned;
      // the UI then shows the orphan as "Running" forever.
      const TOOL_USE_ID = 'toolu_013SJkDc5wEo2BNGkTZq5MRt';
      const TASK_ID = 'bbwlue56w';

      store.handleTaskNotification(TEST_CONV_ID, {
        taskId: TOOL_USE_ID,
        status: 'running',
        description: 'Replay 1',
      });
      expect(store.runningBackgroundTasksList).toHaveLength(1);

      store.handleTaskNotification(TEST_CONV_ID, {
        taskId: TASK_ID,
        status: 'running',
        description: 'Replay 1',
        toolUseId: TOOL_USE_ID,
      });
      expect(store.runningBackgroundTasksList).toHaveLength(1);
      expect(store.backgroundTasks.get(TASK_ID)?.status).toBe('running');
      expect(store.backgroundTasks.get(TOOL_USE_ID)).toBeUndefined();

      store.handleTaskNotification(TEST_CONV_ID, {
        taskId: TASK_ID,
        status: 'running',
        previousTaskId: TOOL_USE_ID,
      });
      expect(store.runningBackgroundTasksList).toHaveLength(1);

      store.handleTaskNotification(TEST_CONV_ID, {
        taskId: TASK_ID,
        status: 'completed',
      });
      expect(store.runningBackgroundTasksList).toHaveLength(0);
      expect(store.backgroundTasks.get(TASK_ID)?.status).toBe('completed');
    });

    it('cleans up three parallel background tasks regardless of arrival interleaving', () => {
      const tasks = [
        { toolUseId: 'toolu_013SJkDc5wEo2BNGkTZq5MRt', taskId: 'bbwlue56w', description: 'Replay 1' },
        { toolUseId: 'toolu_01CD7FACuHwXLY3WFXr1nVJd', taskId: 'b4s4ju9vc', description: 'Replay 2' },
        { toolUseId: 'toolu_01C1QJngKt3YzXsPkSQxKRCS', taskId: 'bz35z78ic', description: 'Replay 3' },
      ];

      for (const t of tasks) {
        store.handleTaskNotification(TEST_CONV_ID, {
          taskId: t.toolUseId,
          status: 'running',
          description: t.description,
        });
      }
      expect(store.runningBackgroundTasksList).toHaveLength(3);

      for (const t of tasks) {
        store.handleTaskNotification(TEST_CONV_ID, {
          taskId: t.taskId,
          status: 'running',
          description: t.description,
          toolUseId: t.toolUseId,
        });
      }
      expect(store.runningBackgroundTasksList).toHaveLength(3);
      expect(store.backgroundTasks.size).toBe(3);

      for (const t of tasks) {
        store.handleTaskNotification(TEST_CONV_ID, {
          taskId: t.taskId,
          status: 'completed',
          summary: `${t.description} done`,
        });
      }
      expect(store.runningBackgroundTasksList).toHaveLength(0);
      expect(store.backgroundTasks.size).toBe(3);
      for (const t of tasks) {
        expect(store.backgroundTasks.get(t.taskId)?.status).toBe('completed');
      }
    });
  });
});
