/**
 * Comprehensive tests for ConversationService.
 *
 * Tests cover:
 * - Conversation listing with metadata stripping
 * - Conversation retrieval by ID
 * - Conversation saving with auto-title generation
 * - Conversation deletion
 * - Conversation creation with unique IDs
 * - Error handling and edge cases
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to ensure mocks are available before vi.mock is called
const { mockFs, mockFileSystem } = vi.hoisted(() => {
  const fileSystem = new Map<string, string>();
  return {
    mockFileSystem: fileSystem,
    mockFs: {
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
      constants: {
        W_OK: 2,
      },
      promises: {
        access: vi.fn().mockResolvedValue(undefined), // Directory is accessible by default
        mkdir: vi.fn().mockResolvedValue(undefined),
        readdir: vi.fn().mockImplementation(async (dir: string) => {
          const files: string[] = [];
          for (const key of fileSystem.keys()) {
            if (key.startsWith(dir + '/')) {
              const filename = key.slice(dir.length + 1);
              if (!filename.includes('/')) {
                files.push(filename);
              }
            }
          }
          return files;
        }),
        readFile: vi.fn().mockImplementation(async (path: string, _encoding?: string) => {
          const content = fileSystem.get(path);
          if (content === undefined) {
            const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return content;
        }),
        writeFile: vi.fn().mockImplementation(async (path: string, content: string, _encoding?: string) => {
          fileSystem.set(path, content);
        }),
        unlink: vi.fn().mockImplementation(async (path: string) => {
          if (!fileSystem.has(path)) {
            const error = new Error(`ENOENT: no such file or directory, unlink '${path}'`) as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          fileSystem.delete(path);
        }),
      },
    },
  };
});

vi.mock('node:fs', () => ({
  default: mockFs,
  existsSync: mockFs.existsSync,
  mkdirSync: mockFs.mkdirSync,
  constants: mockFs.constants,
  promises: mockFs.promises,
}));

vi.mock('node:path', () => ({
  default: {
    join: (...parts: string[]) => parts.join('/'),
  },
  join: (...parts: string[]) => parts.join('/'),
}));

vi.mock('../../utils/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../utils/paths', () => ({
  getConversationsPath: () => '/app/conversations',
  isPathWithin: () => true, // Always return true in tests (paths are mocked)
}));

// Import after mocks
import { Conversation } from '../../../shared/types';
import { ConversationService } from '../ConversationService';

describe('ConversationService', () => {
  let service: ConversationService;

  const createConversation = (overrides: Partial<Conversation> = {}): Conversation => ({
    id: 'conv_test_123',
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
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFileSystem.clear();
    mockFs.existsSync.mockReturnValue(true);

    // Re-establish mock implementations after clearAllMocks
    // (clearAllMocks can affect mockImplementation in some cases)
    mockFs.promises.readdir.mockImplementation(async (dir: string) => {
      const files: string[] = [];
      for (const key of mockFileSystem.keys()) {
        if (key.startsWith(dir + '/')) {
          const filename = key.slice(dir.length + 1);
          if (!filename.includes('/')) {
            files.push(filename);
          }
        }
      }
      return files;
    });

    mockFs.promises.readFile.mockImplementation(async (path: string, _encoding?: string) => {
      const content = mockFileSystem.get(path);
      if (content === undefined) {
        const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return content;
    });

    mockFs.promises.writeFile.mockImplementation(async (path: string, content: string, _encoding?: string) => {
      mockFileSystem.set(path, content);
    });

    mockFs.promises.unlink.mockImplementation(async (path: string) => {
      if (!mockFileSystem.has(path)) {
        const error = new Error(`ENOENT: no such file or directory, unlink '${path}'`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      mockFileSystem.delete(path);
    });

    service = new ConversationService();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Initialization
  // ===========================================================================
  describe('initialization', () => {
    it('should create conversations directory if it does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      new ConversationService();

      expect(mockFs.mkdirSync).toHaveBeenCalledWith('/app/conversations', { recursive: true });
    });

    it('should not create directory if it already exists', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.mkdirSync.mockClear();
      new ConversationService();

      expect(mockFs.mkdirSync).not.toHaveBeenCalled();
    });

    it('should handle directory creation errors gracefully', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      // Should not throw
      expect(() => new ConversationService()).not.toThrow();
    });
  });

  // ===========================================================================
  // list()
  // ===========================================================================
  describe('list()', () => {
    it('should return empty array when no conversations exist', async () => {
      const conversations = await service.list();

      expect(conversations).toEqual([]);
    });

    it('should return conversations sorted by updatedAt (newest first)', async () => {
      const conv1 = createConversation({ id: 'conv_1', updatedAt: 1000 });
      const conv2 = createConversation({ id: 'conv_2', updatedAt: 3000 });
      const conv3 = createConversation({ id: 'conv_3', updatedAt: 2000 });

      mockFileSystem.set('/app/conversations/conv_1.json', JSON.stringify(conv1));
      mockFileSystem.set('/app/conversations/conv_2.json', JSON.stringify(conv2));
      mockFileSystem.set('/app/conversations/conv_3.json', JSON.stringify(conv3));

      const conversations = await service.list();

      expect(conversations.map((c) => c.id)).toEqual(['conv_2', 'conv_3', 'conv_1']);
    });

    it('should return conversations without messages (metadata only)', async () => {
      const conv = createConversation({
        messages: [
          { id: 'msg_1', role: 'user', content: 'Secret message', timestamp: Date.now() },
        ],
      });

      mockFileSystem.set('/app/conversations/conv_test_123.json', JSON.stringify(conv));

      const conversations = await service.list();

      expect(conversations[0].messages).toEqual([]);
    });

    it('should skip non-json files', async () => {
      const conv = createConversation();
      mockFileSystem.set('/app/conversations/conv_test_123.json', JSON.stringify(conv));
      mockFileSystem.set('/app/conversations/notes.txt', 'some text');
      mockFileSystem.set('/app/conversations/.DS_Store', 'binary');

      const conversations = await service.list();

      expect(conversations).toHaveLength(1);
    });

    it('should skip files with invalid JSON', async () => {
      const conv = createConversation({ id: 'valid' });
      mockFileSystem.set('/app/conversations/valid.json', JSON.stringify(conv));
      mockFileSystem.set('/app/conversations/invalid.json', 'not json {{{');

      const conversations = await service.list();

      expect(conversations).toHaveLength(1);
      expect(conversations[0].id).toBe('valid');
    });

    it('should return empty array on read error', async () => {
      mockFs.promises.readdir.mockRejectedValueOnce(new Error('Permission denied'));

      const conversations = await service.list();

      expect(conversations).toEqual([]);
    });
  });

  // ===========================================================================
  // get()
  // ===========================================================================
  describe('get()', () => {
    it('should return conversation by ID', async () => {
      const conv = createConversation();
      mockFileSystem.set('/app/conversations/conv_test_123.json', JSON.stringify(conv));

      const result = await service.get('conv_test_123');

      expect(result).toMatchObject({
        id: 'conv_test_123',
        title: 'Test Conversation',
      });
    });

    it('should return full messages', async () => {
      const conv = createConversation({
        messages: [
          { id: 'msg_1', role: 'user', content: 'Full message content', timestamp: Date.now() },
        ],
      });
      mockFileSystem.set('/app/conversations/conv_test_123.json', JSON.stringify(conv));

      const result = await service.get('conv_test_123');

      expect(result?.messages).toHaveLength(1);
      expect(result?.messages[0].content).toBe('Full message content');
    });

    it('should return null for non-existent conversation', async () => {
      const result = await service.get('nonexistent');

      expect(result).toBeNull();
    });

    it('should return null for invalid JSON', async () => {
      // Set invalid JSON that will cause JSON.parse to fail
      mockFileSystem.set('/app/conversations/invalid.json', 'invalid json {{{');

      const result = await service.get('invalid');

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // save()
  // ===========================================================================
  describe('save()', () => {
    it('should save conversation to file', async () => {
      const conv = createConversation();

      await service.save(conv);

      expect(mockFs.promises.writeFile).toHaveBeenCalledWith(
        '/app/conversations/conv_test_123.json',
        expect.any(String),
        'utf-8'
      );
    });

    it('should preserve the updatedAt timestamp from payload', async () => {
      const conv = createConversation({ updatedAt: 1000 });

      await service.save(conv);

      const savedContent = mockFileSystem.get('/app/conversations/conv_test_123.json');
      const saved = JSON.parse(savedContent!);

      expect(saved.updatedAt).toBe(1000);
    });

    it('should generate title from first user message if not set', async () => {
      const conv = createConversation({
        title: '',
        messages: [
          { id: 'msg_1', role: 'user', content: 'Help me write a function', timestamp: Date.now() },
        ],
      });

      await service.save(conv);

      const savedContent = mockFileSystem.get('/app/conversations/conv_test_123.json');
      const saved = JSON.parse(savedContent!);

      expect(saved.title).toBe('Help me write a function');
    });

    it('should truncate long auto-generated titles', async () => {
      const longMessage = 'A'.repeat(100);
      const conv = createConversation({
        title: '',
        messages: [
          { id: 'msg_1', role: 'user', content: longMessage, timestamp: Date.now() },
        ],
      });

      await service.save(conv);

      const savedContent = mockFileSystem.get('/app/conversations/conv_test_123.json');
      const saved = JSON.parse(savedContent!);

      expect(saved.title.length).toBeLessThanOrEqual(53); // 50 + '...'
      expect(saved.title.endsWith('...')).toBe(true);
    });

    it('should not overwrite existing title', async () => {
      const conv = createConversation({
        title: 'My Custom Title',
        messages: [
          { id: 'msg_1', role: 'user', content: 'Some message', timestamp: Date.now() },
        ],
      });

      await service.save(conv);

      const savedContent = mockFileSystem.get('/app/conversations/conv_test_123.json');
      const saved = JSON.parse(savedContent!);

      expect(saved.title).toBe('My Custom Title');
    });

    it('should save pretty-printed JSON', async () => {
      const conv = createConversation();

      await service.save(conv);

      expect(mockFs.promises.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('\n'),
        'utf-8'
      );
    });

    it('should propagate write errors after retries', async () => {
      const conv = createConversation();
      // Mock all 3 retry attempts to fail
      mockFs.promises.writeFile
        .mockRejectedValueOnce(new Error('Disk full'))
        .mockRejectedValueOnce(new Error('Disk full'))
        .mockRejectedValueOnce(new Error('Disk full'));

      await expect(service.save(conv)).rejects.toThrow('Disk full');
    });

    it('should handle empty messages array', async () => {
      const conv = createConversation({ title: '', messages: [] });

      await service.save(conv);

      const savedContent = mockFileSystem.get('/app/conversations/conv_test_123.json');
      const saved = JSON.parse(savedContent!);

      expect(saved.title).toBe('');
    });
  });

  // ===========================================================================
  // delete()
  // ===========================================================================
  describe('delete()', () => {
    it('should delete conversation file', async () => {
      mockFileSystem.set('/app/conversations/conv_123.json', '{}');

      await service.delete('conv_123');

      expect(mockFs.promises.unlink).toHaveBeenCalledWith('/app/conversations/conv_123.json');
    });

    it('should not throw for non-existent conversation', async () => {
      await expect(service.delete('nonexistent')).resolves.toBeUndefined();
    });

    it('should propagate non-ENOENT errors', async () => {
      const error = new Error('Permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      mockFs.promises.unlink.mockRejectedValueOnce(error);

      await expect(service.delete('conv_123')).rejects.toThrow('Permission denied');
    });
  });

  // ===========================================================================
  // create()
  // ===========================================================================
  describe('create()', () => {
    it('should create new conversation with unique ID', () => {
      const conv = service.create('/home/user/project');

      expect(conv.id).toMatch(/^conv_[a-z0-9]+_[a-z0-9]+$/);
    });

    it('should set the working directory', () => {
      const conv = service.create('/home/user/project');

      expect(conv.workingDirectory).toBe('/home/user/project');
    });

    it('should initialize with empty messages', () => {
      const conv = service.create('/home/user/project');

      expect(conv.messages).toEqual([]);
    });

    it('should initialize with empty title', () => {
      const conv = service.create('/home/user/project');

      expect(conv.title).toBe('');
    });

    it('should set createdAt timestamp', () => {
      const before = Date.now();
      const conv = service.create('/home/user/project');
      const after = Date.now();

      expect(conv.createdAt).toBeGreaterThanOrEqual(before);
      expect(conv.createdAt).toBeLessThanOrEqual(after);
    });

    it('should set updatedAt timestamp', () => {
      const before = Date.now();
      const conv = service.create('/home/user/project');
      const after = Date.now();

      expect(conv.updatedAt).toBeGreaterThanOrEqual(before);
      expect(conv.updatedAt).toBeLessThanOrEqual(after);
    });

    it('should generate unique IDs for multiple conversations', () => {
      const conv1 = service.create('/home/user/project');
      const conv2 = service.create('/home/user/project');
      const conv3 = service.create('/home/user/project');

      expect(new Set([conv1.id, conv2.id, conv3.id]).size).toBe(3);
    });
  });

  // ===========================================================================
  // Integration scenarios
  // ===========================================================================
  describe('integration scenarios', () => {
    it('should create, save, retrieve, and delete a conversation', async () => {
      // Create
      const conv = service.create('/home/user/project');
      conv.messages.push({
        id: 'msg_1',
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      });

      // Save
      await service.save(conv);

      // Verify file was written
      const expectedPath = `/app/conversations/${conv.id}.json`;
      expect(mockFileSystem.has(expectedPath)).toBe(true);

      // Retrieve
      const retrieved = await service.get(conv.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.messages).toHaveLength(1);
      expect(retrieved?.messages[0].content).toBe('Hello');

      // List
      const list = await service.list();
      expect(list).toHaveLength(1);
      expect(list[0].messages).toEqual([]); // List doesn't include messages

      // Delete
      await service.delete(conv.id);

      // Verify deleted
      const deleted = await service.get(conv.id);
      expect(deleted).toBeNull();
    });

    it('should handle concurrent saves', async () => {
      const conv1 = service.create('/project1');
      const conv2 = service.create('/project2');
      const conv3 = service.create('/project3');

      await Promise.all([service.save(conv1), service.save(conv2), service.save(conv3)]);

      const list = await service.list();
      expect(list).toHaveLength(3);
    });
  });

  // ===========================================================================
  // SDK Session ID persistence
  // ===========================================================================
  describe('sdkSessionId persistence', () => {
    it('should preserve sdkSessionId through save and get', async () => {
      const conv = createConversation({ sdkSessionId: 'sdk-session-abc-123' });

      await service.save(conv);
      const retrieved = await service.get(conv.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.sdkSessionId).toBe('sdk-session-abc-123');
    });

    it('should preserve sdkSessionId as undefined when not set', async () => {
      const conv = createConversation();
      // Ensure no sdkSessionId property
      delete (conv as any).sdkSessionId;

      await service.save(conv);
      const retrieved = await service.get(conv.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.sdkSessionId).toBeUndefined();
    });

    it('should not strip sdkSessionId in list() (metadata includes it)', async () => {
      const conv = createConversation({ sdkSessionId: 'list-session-id' });
      mockFileSystem.set(`/app/conversations/${conv.id}.json`, JSON.stringify(conv));

      const list = await service.list();

      expect(list).toHaveLength(1);
      expect(list[0].sdkSessionId).toBe('list-session-id');
    });

    it('should handle updating sdkSessionId on re-save', async () => {
      const conv = createConversation({ sdkSessionId: 'old-session' });
      await service.save(conv);

      // Update session ID
      conv.sdkSessionId = 'new-session';
      await service.save(conv);

      const retrieved = await service.get(conv.id);
      expect(retrieved?.sdkSessionId).toBe('new-session');
    });
  });
});
