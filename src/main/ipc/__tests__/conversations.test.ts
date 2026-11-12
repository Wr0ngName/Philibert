/**
 * Comprehensive tests for Conversations IPC handlers.
 *
 * Tests cover:
 * - CONVERSATION_LIST_PAGE and the archiving handlers
 * - CONVERSATION_UPDATE handler, the only write
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

// The call results live in the user's folders: removing them is tested
// against real folders in session-records.test.ts.
const { deleteToolResults } = vi.hoisted(() => ({
  deleteToolResults: vi.fn(),
}));
vi.mock('../../services/claude/session-records', () => ({ deleteToolResults }));

const mockConversationService = {
  listPage: vi.fn(),
  archivedCount: vi.fn(),
  summary: vi.fn(),
  setArchived: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

const mockSessions = { endConversation: vi.fn() };

// Import after mocks
import { IPC_CHANNELS, Conversation, type ConversationUpdate } from '../../../shared/types';
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
    mockConversationService.update.mockResolvedValue(undefined);
    mockConversationService.delete.mockResolvedValue(undefined);
    deleteToolResults.mockResolvedValue(0);

    // Register handlers
    setupConversationIPC(mockConversationService as any, mockSessions);
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
      expect(handlers.has(IPC_CHANNELS.CONVERSATION_UPDATE)).toBe(true);
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
      setupConversationIPC(null as any, mockSessions);
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
  // CONVERSATION_UPDATE — the only write
  // ===========================================================================
  describe('CONVERSATION_UPDATE handler', () => {
    let handler: (...args: unknown[]) => unknown;
    const sampleUpdate: ConversationUpdate = {
      id: 'conv_123',
      workingDirectory: '/home/user/project',
      updatedAt: Date.now(),
      upsert: sampleConversation.messages,
    };

    beforeEach(() => {
      handler = handlers.get(IPC_CHANNELS.CONVERSATION_UPDATE)!;
    });

    it('applies the update', async () => {
      await handler({}, sampleUpdate);

      expect(mockConversationService.update).toHaveBeenCalledWith(sampleUpdate);
    });

    it('applies an update that only changes details, with no message', async () => {
      // A session id or the task list changing is a write of its own.
      const detailsOnly = { ...sampleUpdate, upsert: [], sdkSessionId: 'session-1' };

      await handler({}, detailsOnly);

      expect(mockConversationService.update).toHaveBeenCalledWith(detailsOnly);
    });

    it.each([
      ['not an object', 'not-an-object'],
      ['null', null],
      ['undefined', undefined],
      ['without an id', { ...sampleUpdate, id: undefined }],
      ['with an empty id', { ...sampleUpdate, id: '' }],
      ['with an id of spaces', { ...sampleUpdate, id: '   ' }],
      ['with an id that is not a string', { ...sampleUpdate, id: 123 }],
      ['with upsert not an array', { ...sampleUpdate, upsert: 'not-an-array' }],
      ['with upsert null', { ...sampleUpdate, upsert: null }],
      ['with a working directory that is not a string', { ...sampleUpdate, workingDirectory: 42 }],
      ['with updatedAt zero', { ...sampleUpdate, updatedAt: 0 }],
      ['with updatedAt negative', { ...sampleUpdate, updatedAt: -1 }],
      ['with updatedAt not a number', { ...sampleUpdate, updatedAt: 'invalid' }],
    ])('refuses an update %s, writing nothing', async (_name, invalid) => {
      // ValidationError is caught and wrapped in ConfigurationError by the handler
      await expect(handler({}, invalid)).rejects.toThrow(ConfigurationError);
      expect(mockConversationService.update).not.toHaveBeenCalled();
    });

    it('should throw when conversation service is not initialized', async () => {
      handlers.clear();
      setupConversationIPC(null as any, mockSessions);
      const nullHandler = handlers.get(IPC_CHANNELS.CONVERSATION_UPDATE)!;

      await expect(nullHandler({}, sampleUpdate)).rejects.toThrow(ConfigurationError);
    });

    it('should propagate service errors', async () => {
      mockConversationService.update.mockRejectedValue(new Error('Disk full'));

      await expect(handler({}, sampleUpdate)).rejects.toThrow(ConfigurationError);
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
      setupConversationIPC(null as any, mockSessions);
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

    // Its Claude Code session is left to Claude Code's retention clean-up:
    // only what this app wrote for it goes with it.
    it('ends its session and removes the call results this app wrote for it', async () => {
      const order: string[] = [];
      mockConversationService.delete.mockImplementation(async () => { order.push('discussion deleted'); });
      mockSessions.endConversation.mockImplementation(() => { order.push('session ended'); });
      deleteToolResults.mockImplementation(async () => { order.push('call results removed'); return 3; });

      await handler({}, 'conv_123');

      expect(order).toEqual(['discussion deleted', 'session ended', 'call results removed']);
      expect(mockSessions.endConversation).toHaveBeenCalledWith('conv_123');
      expect(deleteToolResults).toHaveBeenCalledWith('conv_123');
    });

    it('still succeeds when the call results cannot all be removed: the discussion is gone', async () => {
      deleteToolResults.mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));

      await expect(handler({}, 'conv_123')).resolves.toBeUndefined();
      expect(mockConversationService.delete).toHaveBeenCalledWith('conv_123');
    });

    it('removes nothing when the discussion could not be deleted', async () => {
      mockConversationService.delete.mockRejectedValue(new Error('File locked'));

      await expect(handler({}, 'conv_123')).rejects.toThrow(ConfigurationError);
      expect(mockSessions.endConversation).not.toHaveBeenCalled();
      expect(deleteToolResults).not.toHaveBeenCalled();
    });
  });
});
