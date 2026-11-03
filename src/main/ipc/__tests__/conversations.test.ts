/**
 * Comprehensive tests for Conversations IPC handlers.
 *
 * Tests cover:
 * - CONVERSATION_LIST_PAGE and the archiving handlers
 * - CONVERSATION_GET handler for retrieving a single conversation
 * - CONVERSATION_SAVE handler for saving conversations
 * - CONVERSATION_DELETE handler for deleting conversations
 * - Service validation for all handlers
 * - Input validation
 * - Error propagation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to ensure mocks are available before vi.mock is called
const { mockIpcMainHandle, mockIpcMain } = vi.hoisted(() => {
  const mockIpcMainHandle = vi.fn();
  return {
    mockIpcMainHandle,
    mockIpcMain: {
      handle: mockIpcMainHandle,
      on: vi.fn(),
      removeHandler: vi.fn(),
      removeAllListeners: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  app: {
    getPath: (name: string) => name === 'userData' ? '/tmp/test-userdata' : `/tmp/${name}`,
  },
}));

vi.mock('../../utils/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockConversationService = {
  listPage: vi.fn(),
  archivedCount: vi.fn(),
  summary: vi.fn(),
  setArchived: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
};

// Import after mocks
import { IPC_CHANNELS, Conversation } from '../../../shared/types';
import { ConfigurationError } from '../../errors';
import { setupConversationIPC } from '../conversations';

describe('Conversations IPC handlers', () => {
  let handlers: Map<string, (...args: unknown[]) => unknown>;

  const sampleConversation: Conversation = {
    id: 'conv_123',
    title: 'Test Conversation',
    workingDirectory: '/home/user/project',
    messages: [
      {
        id: 'msg_1',
        role: 'user',
        content: 'Hello Claude',
        timestamp: Date.now() - 60000,
      },
      {
        id: 'msg_2',
        role: 'assistant',
        content: 'Hello! How can I help you?',
        timestamp: Date.now() - 30000,
      },
    ],
    createdAt: Date.now() - 3600000,
    updatedAt: Date.now() - 30000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();

    // Capture registered handlers
    mockIpcMainHandle.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    });

    // Default mock implementations
    mockConversationService.listPage.mockResolvedValue({ conversations: [sampleConversation], hasMore: false });
    mockConversationService.archivedCount.mockResolvedValue(4);
    mockConversationService.summary.mockResolvedValue({ id: 'conv_123' });
    mockConversationService.setArchived.mockResolvedValue({ id: 'conv_123' });
    mockConversationService.get.mockResolvedValue(sampleConversation);
    mockConversationService.save.mockResolvedValue(undefined);
    mockConversationService.delete.mockResolvedValue(undefined);

    // Register handlers
    setupConversationIPC(mockConversationService as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Handler Registration
  // ===========================================================================
  describe('handler registration', () => {
    it('should register all conversation handlers', () => {
      expect(handlers.has(IPC_CHANNELS.CONVERSATION_LIST_PAGE)).toBe(true);
      expect(handlers.has(IPC_CHANNELS.CONVERSATION_ARCHIVED_COUNT)).toBe(true);
      expect(handlers.has(IPC_CHANNELS.CONVERSATION_SUMMARY)).toBe(true);
      expect(handlers.has(IPC_CHANNELS.CONVERSATION_SET_ARCHIVED)).toBe(true);
      expect(handlers.has(IPC_CHANNELS.CONVERSATION_GET)).toBe(true);
      expect(handlers.has(IPC_CHANNELS.CONVERSATION_SAVE)).toBe(true);
      expect(handlers.has(IPC_CHANNELS.CONVERSATION_DELETE)).toBe(true);
    });
  });

  // ===========================================================================
  // CONVERSATION_LIST_PAGE
  // ===========================================================================
  describe('CONVERSATION_LIST_PAGE handler', () => {
    let handler: (...args: unknown[]) => unknown;
    const request = { archived: false, autoArchiveDays: 30, limit: 50 };

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.CONVERSATION_LIST_PAGE)!;
    });

    it('passes a valid request to the service and returns its page', async () => {
      const after = { updatedAt: 1000, id: 'conv_1' };
      const result = await handler({}, { ...request, after });

      expect(mockConversationService.listPage).toHaveBeenCalledWith({ ...request, after });
      expect(result).toEqual({ conversations: [sampleConversation], hasMore: false });
    });

    it.each([
      ['not an object', 'nope'],
      ['archived not a boolean', { ...request, archived: 'yes' }],
      ['a day count not offered', { ...request, autoArchiveDays: 12 }],
      ['a page size of zero', { ...request, limit: 0 }],
      ['a cursor without an id', { ...request, after: { updatedAt: 1 } }],
      ['a cursor without a time', { ...request, after: { id: 'conv_1' } }],
    ])('refuses %s', async (_label, bad) => {
      await expect(handler({}, bad)).rejects.toThrow(ConfigurationError);
      expect(mockConversationService.listPage).not.toHaveBeenCalled();
    });

    it('should throw when conversation service is not initialized', async () => {
      handlers.clear();
      setupConversationIPC(null as any);
      const nullHandler = handlers.get(IPC_CHANNELS.CONVERSATION_LIST_PAGE)!;

      await expect(nullHandler({}, request)).rejects.toThrow(ConfigurationError);
    });

    it('should propagate service errors', async () => {
      mockConversationService.listPage.mockRejectedValue(new Error('Storage error'));

      await expect(handler({}, request)).rejects.toThrow(ConfigurationError);
    });
  });

  // ===========================================================================
  // Archiving
  // ===========================================================================
  describe('archiving handlers', () => {
    it('counts the archived ones for a valid setting, and refuses another', async () => {
      const count = handlers.get(IPC_CHANNELS.CONVERSATION_ARCHIVED_COUNT)!;
      await expect(count({}, 7)).resolves.toBe(4);
      expect(mockConversationService.archivedCount).toHaveBeenCalledWith(7);
      await expect(count({}, '7')).rejects.toThrow(ConfigurationError);
    });

    it('reads one entry by id, and refuses an id that is not a string', async () => {
      const summary = handlers.get(IPC_CHANNELS.CONVERSATION_SUMMARY)!;
      await expect(summary({}, 'conv_123')).resolves.toEqual({ id: 'conv_123' });
      await expect(summary({}, 42)).rejects.toThrow(ConfigurationError);
    });

    it('archives or brings back, and refuses a flag that is not a boolean', async () => {
      const setArchived = handlers.get(IPC_CHANNELS.CONVERSATION_SET_ARCHIVED)!;
      await setArchived({}, 'conv_123', true);
      expect(mockConversationService.setArchived).toHaveBeenCalledWith('conv_123', true);
      await expect(setArchived({}, 'conv_123', 'true')).rejects.toThrow(ConfigurationError);
      expect(mockConversationService.setArchived).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // CONVERSATION_GET
  // ===========================================================================
  describe('CONVERSATION_GET handler', () => {
    let handler: (...args: unknown[]) => unknown;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.CONVERSATION_GET)!;
    });

    it('should return conversation by ID', async () => {
      const result = await handler({}, 'conv_123');

      expect(mockConversationService.get).toHaveBeenCalledWith('conv_123');
      expect(result).toEqual(sampleConversation);
    });

    it('should throw when ID is not a string', async () => {
      await expect(handler({}, 123)).rejects.toThrow(ConfigurationError);
    });

    it('should throw when ID is empty', async () => {
      await expect(handler({}, '')).rejects.toThrow(ConfigurationError);
    });

    it('should throw when ID is only whitespace', async () => {
      await expect(handler({}, '   ')).rejects.toThrow(ConfigurationError);
    });

    it('should throw when ID is null', async () => {
      await expect(handler({}, null)).rejects.toThrow(ConfigurationError);
    });

    it('should throw when conversation is not found', async () => {
      mockConversationService.get.mockResolvedValue(null);

      await expect(handler({}, 'nonexistent_id')).rejects.toThrow(ConfigurationError);
    });

    it('should throw when conversation service is not initialized', async () => {
      handlers.clear();
      setupConversationIPC(null as any);
      const nullHandler = handlers.get(IPC_CHANNELS.CONVERSATION_GET)!;

      await expect(nullHandler({}, 'conv_123')).rejects.toThrow(ConfigurationError);
    });

    it('should propagate service errors', async () => {
      mockConversationService.get.mockRejectedValue(new Error('Decryption failed'));

      await expect(handler({}, 'conv_123')).rejects.toThrow(ConfigurationError);
    });
  });

  // ===========================================================================
  // CONVERSATION_SAVE
  // ===========================================================================
  describe('CONVERSATION_SAVE handler', () => {
    let handler: (...args: unknown[]) => unknown;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.CONVERSATION_SAVE)!;
    });

    it('should save conversation', async () => {
      await handler({}, sampleConversation);

      expect(mockConversationService.save).toHaveBeenCalledWith(sampleConversation);
    });

    it('should save conversation with many messages', async () => {
      const manyMessages = Array.from({ length: 100 }, (_, i) => ({
        id: `msg_${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
        timestamp: Date.now() - i * 1000,
      })) as any[];

      const largeConversation = {
        ...sampleConversation,
        messages: manyMessages,
      };

      await handler({}, largeConversation);

      expect(mockConversationService.save).toHaveBeenCalledWith(largeConversation);
    });

    it('should throw when conversation is not an object', async () => {
      await expect(handler({}, 'not-an-object')).rejects.toThrow(ConfigurationError);
    });

    it('should throw when conversation is null', async () => {
      await expect(handler({}, null)).rejects.toThrow(ConfigurationError);
    });

    it('should throw when conversation is undefined', async () => {
      await expect(handler({}, undefined)).rejects.toThrow(ConfigurationError);
    });

    it('should throw when conversation ID is missing', async () => {
      const invalidConversation = { ...sampleConversation };
      delete (invalidConversation as any).id;

      // ValidationError is caught and wrapped in ConfigurationError by the handler
      await expect(handler({}, invalidConversation)).rejects.toThrow(ConfigurationError);
    });

    it('should throw when conversation ID is empty', async () => {
      // ValidationError is caught and wrapped in ConfigurationError by the handler
      await expect(handler({}, { ...sampleConversation, id: '' })).rejects.toThrow(ConfigurationError);
    });

    it('should throw when conversation ID is only whitespace', async () => {
      // ValidationError is caught and wrapped in ConfigurationError by the handler
      await expect(handler({}, { ...sampleConversation, id: '   ' })).rejects.toThrow(ConfigurationError);
    });

    it('should throw when conversation ID is not a string', async () => {
      // ValidationError is caught and wrapped in ConfigurationError by the handler
      await expect(handler({}, { ...sampleConversation, id: 123 })).rejects.toThrow(ConfigurationError);
    });

    it('should throw when messages is not an array', async () => {
      // ValidationError is caught and wrapped in ConfigurationError by the handler
      await expect(handler({}, { ...sampleConversation, messages: 'not-an-array' })).rejects.toThrow(ConfigurationError);
    });

    it('should throw when messages is null', async () => {
      // ValidationError is caught and wrapped in ConfigurationError by the handler
      await expect(handler({}, { ...sampleConversation, messages: null })).rejects.toThrow(ConfigurationError);
    });

    it('should throw when createdAt is invalid', async () => {
      // ValidationError is caught and wrapped in ConfigurationError by the handler
      await expect(handler({}, { ...sampleConversation, createdAt: 0 })).rejects.toThrow(ConfigurationError);
      await expect(handler({}, { ...sampleConversation, createdAt: -1 })).rejects.toThrow(ConfigurationError);
      await expect(handler({}, { ...sampleConversation, createdAt: 'invalid' })).rejects.toThrow(ConfigurationError);
    });

    it('should throw when updatedAt is invalid', async () => {
      // ValidationError is caught and wrapped in ConfigurationError by the handler
      await expect(handler({}, { ...sampleConversation, updatedAt: 0 })).rejects.toThrow(ConfigurationError);
      await expect(handler({}, { ...sampleConversation, updatedAt: -1 })).rejects.toThrow(ConfigurationError);
      await expect(handler({}, { ...sampleConversation, updatedAt: 'invalid' })).rejects.toThrow(ConfigurationError);
    });

    it('should throw when conversation service is not initialized', async () => {
      handlers.clear();
      setupConversationIPC(null as any);
      const nullHandler = handlers.get(IPC_CHANNELS.CONVERSATION_SAVE)!;

      await expect(nullHandler({}, sampleConversation)).rejects.toThrow(ConfigurationError);
    });

    it('should propagate service errors', async () => {
      mockConversationService.save.mockRejectedValue(new Error('Disk full'));

      await expect(handler({}, sampleConversation)).rejects.toThrow(ConfigurationError);
    });

    it('should save conversation with empty messages array', async () => {
      const emptyMessagesConv = { ...sampleConversation, messages: [] };

      await handler({}, emptyMessagesConv);

      expect(mockConversationService.save).toHaveBeenCalledWith(emptyMessagesConv);
    });
  });

  // ===========================================================================
  // CONVERSATION_DELETE
  // ===========================================================================
  describe('CONVERSATION_DELETE handler', () => {
    let handler: (...args: unknown[]) => unknown;

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.CONVERSATION_DELETE)!;
    });

    it('should delete conversation by ID', async () => {
      await handler({}, 'conv_123');

      expect(mockConversationService.delete).toHaveBeenCalledWith('conv_123');
    });

    it('should throw when ID is not a string', async () => {
      await expect(handler({}, 123)).rejects.toThrow(ConfigurationError);
    });

    it('should throw when ID is empty', async () => {
      await expect(handler({}, '')).rejects.toThrow(ConfigurationError);
    });

    it('should throw when ID is only whitespace', async () => {
      await expect(handler({}, '   ')).rejects.toThrow(ConfigurationError);
    });

    it('should throw when ID is null', async () => {
      await expect(handler({}, null)).rejects.toThrow(ConfigurationError);
    });

    it('should throw when conversation service is not initialized', async () => {
      handlers.clear();
      setupConversationIPC(null as any);
      const nullHandler = handlers.get(IPC_CHANNELS.CONVERSATION_DELETE)!;

      await expect(nullHandler({}, 'conv_123')).rejects.toThrow(ConfigurationError);
    });

    it('should propagate service errors', async () => {
      mockConversationService.delete.mockRejectedValue(new Error('File locked'));

      await expect(handler({}, 'conv_123')).rejects.toThrow(ConfigurationError);
    });

    it('should handle deleting non-existent conversation gracefully', async () => {
      // Service doesn't throw if conversation doesn't exist
      mockConversationService.delete.mockResolvedValue(undefined);

      await expect(handler({}, 'nonexistent')).resolves.toBeUndefined();
    });
  });
});
