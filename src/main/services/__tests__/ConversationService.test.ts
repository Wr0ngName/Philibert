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

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

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

vi.mock('../../utils/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/paths')>();
  return {
    ...actual,
    getConversationsPath: () => '/app/conversations',
    isPathWithin: () => true,
  };
});

// Import after mocks
import { Conversation } from '../../../shared/types';
import realLogger from '../../utils/logger';
import { ConversationService } from '../ConversationService';

const logger = realLogger as unknown as Record<'debug' | 'info' | 'warn' | 'error', Mock>;


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
    // `access` included: a test that makes the directory unwritable otherwise
    // leaves it unwritable for every test declared after it.
    mockFs.promises.access.mockResolvedValue(undefined);

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

    it('fails on a corrupt file rather than reporting it as missing', async () => {
      // It used to return null, which is the same answer as "there is no such
      // conversation" — and `update` builds on what this returns, so a
      // corrupt file was treated as a new conversation and the next write
      // replaced whatever was still in it. Failing leaves the file alone for
      // recovery and tells the user the truth.
      mockFileSystem.set('/app/conversations/invalid.json', 'invalid json {{{');

      await expect(service.get('invalid')).rejects.toThrow();

      // And the file is untouched.
      expect(mockFileSystem.get('/app/conversations/invalid.json')).toBe('invalid json {{{');
    });

    it('still reports a conversation that is simply absent as null', async () => {
      // The distinction the change rests on: absent is an answer, unreadable
      // is a failure.
      await expect(service.get('never-existed')).resolves.toBeNull();
    });

    it('does not let one corrupt file break the list', async () => {
      // The sidebar has to keep working: `list` skips what it cannot parse.
      mockFileSystem.set('/app/conversations/invalid.json', 'invalid json {{{');
      mockFileSystem.set(
        '/app/conversations/good.json',
        JSON.stringify(createConversation({ id: 'good', title: 'Readable' })),
      );

      const list = await service.list();

      expect(list.map((c) => c.id)).toEqual(['good']);
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

  // ===========================================================================
  // clearAllSessionIds() — Bug 1 fix
  // Strips sdkSessionId from all persisted conversation files.
  // ===========================================================================
  describe('clearAllSessionIds()', () => {
    it('should remove sdkSessionId from every conversation file that has one', async () => {
      const conv1 = createConversation({ id: 'conv_clear_1', sdkSessionId: 'session-aaa' });
      const conv2 = createConversation({ id: 'conv_clear_2', sdkSessionId: 'session-bbb' });
      mockFileSystem.set('/app/conversations/conv_clear_1.json', JSON.stringify(conv1));
      mockFileSystem.set('/app/conversations/conv_clear_2.json', JSON.stringify(conv2));

      await service.clearAllSessionIds();

      const loaded1 = JSON.parse(mockFileSystem.get('/app/conversations/conv_clear_1.json')!);
      const loaded2 = JSON.parse(mockFileSystem.get('/app/conversations/conv_clear_2.json')!);
      expect(loaded1.sdkSessionId).toBeUndefined();
      expect(loaded2.sdkSessionId).toBeUndefined();
    });

    it('should leave conversations without sdkSessionId unchanged', async () => {
      const conv = createConversation({ id: 'conv_no_session' });
      delete (conv as any).sdkSessionId;
      const original = JSON.stringify(conv);
      mockFileSystem.set('/app/conversations/conv_no_session.json', original);

      await service.clearAllSessionIds();

      expect(mockFileSystem.get('/app/conversations/conv_no_session.json')).toBe(original);
    });

    it('should keep other conversation fields intact after clearing session ID', async () => {
      const conv = createConversation({
        id: 'conv_intact',
        title: 'Keep Me',
        workingDirectory: '/home/user/project',
        sdkSessionId: 'remove-me',
      });
      mockFileSystem.set('/app/conversations/conv_intact.json', JSON.stringify(conv));

      await service.clearAllSessionIds();

      const loaded = JSON.parse(mockFileSystem.get('/app/conversations/conv_intact.json')!);
      expect(loaded.title).toBe('Keep Me');
      expect(loaded.workingDirectory).toBe('/home/user/project');
      expect(loaded.sdkSessionId).toBeUndefined();
    });

    it('should skip non-json files without throwing', async () => {
      const conv = createConversation({ id: 'conv_skip', sdkSessionId: 'session-x' });
      mockFileSystem.set('/app/conversations/conv_skip.json', JSON.stringify(conv));
      mockFileSystem.set('/app/conversations/notes.txt', 'ignore me');

      await expect(service.clearAllSessionIds()).resolves.toBeUndefined();

      // The JSON file was cleaned; the text file was untouched
      const loaded = JSON.parse(mockFileSystem.get('/app/conversations/conv_skip.json')!);
      expect(loaded.sdkSessionId).toBeUndefined();
    });

    it('should handle an empty conversations directory', async () => {
      await expect(service.clearAllSessionIds()).resolves.toBeUndefined();
    });

    it('should be idempotent — running twice does not corrupt data', async () => {
      const conv = createConversation({ id: 'conv_idem', sdkSessionId: 'session-y' });
      mockFileSystem.set('/app/conversations/conv_idem.json', JSON.stringify(conv));

      await service.clearAllSessionIds();
      await service.clearAllSessionIds();

      const loaded = JSON.parse(mockFileSystem.get('/app/conversations/conv_idem.json')!);
      expect(loaded.sdkSessionId).toBeUndefined();
      expect(loaded.id).toBe('conv_idem');
    });
  });

  // ===========================================================================
  // recoverSessionData()
  // Searches ALL project dirs by session ID (no escaping dependency).
  // Reads the actual CWD from the session JSONL and updates the conversation.
  // ===========================================================================
  describe('recoverSessionData()', () => {
    const SESSION_ID = 'abc123-session';
    const REAL_CWD = 'C:\\Claude\\Claude Femmexpat\\actual-subdir';
    const SESSION_FILE_CONTENT = JSON.stringify({ type: 'system', cwd: REAL_CWD });
    const STALE_CWD = 'C:\\Claude\\Claude Femmexpat';

    beforeEach(() => {
      process.env.HOME = '/mock-home';
      mockFs.promises.access.mockResolvedValue(undefined);
      mockFs.existsSync.mockImplementation((p: string) => mockFileSystem.has(p));
    });

    afterEach(() => {
      delete process.env.HOME;
    });

    it('finds session file by ID regardless of directory name and recovers CWD', async () => {
      const conv = createConversation({
        id: 'conv_recover',
        workingDirectory: STALE_CWD,
        sdkSessionId: SESSION_ID,
      });
      mockFileSystem.set('/app/conversations/conv_recover.json', JSON.stringify(conv));

      // Session file under an arbitrarily-named directory
      const someDir = 'whatever-dir-name-doesnt-matter';
      const sessionFilePath = `/mock-home/.claude/projects/${someDir}/${SESSION_ID}.jsonl`;
      mockFileSystem.set(sessionFilePath, SESSION_FILE_CONTENT);

      mockFs.promises.readdir.mockImplementation(async (dir: string) => {
        if (dir === '/mock-home/.claude/projects') return [someDir];
        if (dir === '/app/conversations') return ['conv_recover.json'];
        return [];
      });

      await service.recoverSessionData();

      const updated = JSON.parse(mockFileSystem.get('/app/conversations/conv_recover.json')!);
      expect(updated.workingDirectory).toBe(REAL_CWD);
    });

    it('does not update conversation when CWD already matches session file', async () => {
      const conv = createConversation({
        id: 'conv_already_ok',
        workingDirectory: REAL_CWD,
        sdkSessionId: SESSION_ID,
      });
      const original = JSON.stringify(conv);
      mockFileSystem.set('/app/conversations/conv_already_ok.json', original);

      const someDir = 'some-project-dir';
      mockFileSystem.set(
        `/mock-home/.claude/projects/${someDir}/${SESSION_ID}.jsonl`,
        SESSION_FILE_CONTENT
      );

      mockFs.promises.readdir.mockImplementation(async (dir: string) => {
        if (dir === '/mock-home/.claude/projects') return [someDir];
        if (dir === '/app/conversations') return ['conv_already_ok.json'];
        return [];
      });

      await service.recoverSessionData();

      expect(mockFileSystem.get('/app/conversations/conv_already_ok.json')).toBe(original);
    });

    it('leaves conversation alone when session file is gone', async () => {
      const conv = createConversation({
        id: 'conv_gone',
        workingDirectory: STALE_CWD,
        sdkSessionId: SESSION_ID,
      });
      const original = JSON.stringify(conv);
      mockFileSystem.set('/app/conversations/conv_gone.json', original);

      mockFs.promises.readdir.mockImplementation(async (dir: string) => {
        if (dir === '/mock-home/.claude/projects') return ['empty-dir'];
        if (dir === '/app/conversations') return ['conv_gone.json'];
        return [];
      });

      await service.recoverSessionData();

      expect(mockFileSystem.get('/app/conversations/conv_gone.json')).toBe(original);
    });

    it('skips conversations without sdkSessionId', async () => {
      const conv = createConversation({ id: 'conv_no_sid' });
      delete (conv as any).sdkSessionId;
      const original = JSON.stringify(conv);
      mockFileSystem.set('/app/conversations/conv_no_sid.json', original);

      mockFs.promises.readdir.mockImplementation(async (dir: string) => {
        if (dir === '/mock-home/.claude/projects') return [];
        if (dir === '/app/conversations') return ['conv_no_sid.json'];
        return [];
      });

      await service.recoverSessionData();

      expect(mockFileSystem.get('/app/conversations/conv_no_sid.json')).toBe(original);
    });

    it('does nothing when HOME is not set', async () => {
      delete process.env.HOME;
      delete process.env.USERPROFILE;

      const conv = createConversation({ id: 'conv_nohome', sdkSessionId: SESSION_ID });
      mockFileSystem.set('/app/conversations/conv_nohome.json', JSON.stringify(conv));

      await expect(service.recoverSessionData()).resolves.toBeUndefined();

      const convWriteCalls = mockFs.promises.writeFile.mock.calls.filter(
        (args: unknown[]) => String(args[0]).includes('conv_nohome')
      );
      expect(convWriteCalls).toHaveLength(0);
    });

    it('does nothing when ~/.claude/projects does not exist', async () => {
      mockFs.promises.access.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      const conv = createConversation({ id: 'conv_noprojects', sdkSessionId: SESSION_ID });
      mockFileSystem.set('/app/conversations/conv_noprojects.json', JSON.stringify(conv));

      await expect(service.recoverSessionData()).resolves.toBeUndefined();

      const convWriteCalls = mockFs.promises.writeFile.mock.calls.filter(
        (args: unknown[]) => String(args[0]).includes('conv_noprojects')
      );
      expect(convWriteCalls).toHaveLength(0);
    });
  });

  // ===========================================================================
  // update() — the renderer's only write path
  // ===========================================================================
  describe('update()', () => {
    /**
     * A write is a change, not a whole conversation. The renderer holds a
     * window of a long conversation, so a write that carried "the messages"
     * would store only the window — which is how trimming memory would have
     * erased history. See ConversationUpdate.
     */
    const stored = (id: string) => {
      const raw = mockFileSystem.get(`/app/conversations/${id}.json`);
      return raw ? (JSON.parse(raw) as Conversation) : null;
    };
    const ids = (id: string) => (stored(id)?.messages ?? []).map((m) => m.id);

    const msg = (id: string, content = `content ${id}`): Conversation['messages'][number] => ({
      id, role: 'user', content, timestamp: 1_700_000_000_000,
    });

    async function seed(id: string, messageIds: string[]): Promise<void> {
      await service.save(createConversation({
        id,
        title: 'Seeded',
        messages: messageIds.map((m) => msg(m)),
      }));
    }

    const base = (id: string) => ({
      id, upsert: [], workingDirectory: '/home/user/project', updatedAt: Date.now(),
    });

    it('appends messages it has not seen', async () => {
      await seed('c1', ['m1', 'm2']);

      await service.update({ ...base('c1'), upsert: [msg('m3')] });

      expect(ids('c1')).toEqual(['m1', 'm2', 'm3']);
    });

    it('replaces a message it already has, where it already is', async () => {
      // Edits legitimately reach stored messages: a streaming flag cleared
      // when a turn ends, a tool result arriving late. Appending a second
      // copy, or moving it to the end, would both corrupt the transcript.
      await seed('c2', ['m1', 'm2', 'm3']);

      await service.update({ ...base('c2'), upsert: [msg('m2', 'edited')] });

      expect(ids('c2')).toEqual(['m1', 'm2', 'm3']);
      expect(stored('c2')?.messages[1].content).toBe('edited');
    });

    it('creates the conversation when there is none', async () => {
      await service.update({ ...base('c3'), upsert: [msg('m1')], title: 'Fresh' });

      expect(ids('c3')).toEqual(['m1']);
      expect(stored('c3')?.title).toBe('Fresh');
    });

    it('cannot shorten a conversation on its own', async () => {
      // The property everything else rests on.
      await seed('c4', ['m1', 'm2', 'm3', 'm4']);

      await service.update({ ...base('c4'), upsert: [msg('m4')] });

      expect(ids('c4')).toEqual(['m1', 'm2', 'm3', 'm4']);
    });

    it('truncates from a message when asked to', async () => {
      // What a rewind does: that turn and the ones after it really are gone.
      await seed('c5', ['m1', 'm2', 'm3', 'm4']);

      await service.update({ ...base('c5'), truncateFromId: 'm3' });

      expect(ids('c5')).toEqual(['m1', 'm2']);
    });

    it('truncates and then appends in one write', async () => {
      // The rewind writes the turns that follow it in the same save.
      await seed('c6', ['m1', 'm2', 'm3']);

      await service.update({
        ...base('c6'), truncateFromId: 'm2', upsert: [msg('m9')],
      });

      expect(ids('c6')).toEqual(['m1', 'm9']);
    });

    it('keeps the history when the truncation anchor is gone', async () => {
      // "From" cannot be known without the anchor. Dropping nothing is the
      // recoverable mistake; dropping everything is not.
      await seed('c7', ['m1', 'm2', 'm3']);

      await service.update({ ...base('c7'), truncateFromId: 'does-not-exist' });

      expect(ids('c7')).toEqual(['m1', 'm2', 'm3']);
    });

    it('clears every message when the first one is the anchor', async () => {
      // Which is how a conversation is emptied now: there is no separate
      // "remove everything", because naming the oldest message to discard
      // says it already — and that spelling cannot be reached by accident
      // from a window with no predecessor to name.
      await seed('c8', ['m1', 'm2']);

      await service.update({ ...base('c8'), truncateFromId: 'm1' });

      expect(ids('c8')).toEqual([]);
    });

    it('keeps metadata it was not given', async () => {
      await service.save(createConversation({
        id: 'c9', title: 'Kept', sdkSessionId: 'session-1', messages: [msg('m1')],
      }));

      await service.update({ ...base('c9'), upsert: [msg('m2')] });

      expect(stored('c9')?.sdkSessionId).toBe('session-1');
      expect(stored('c9')?.title).toBe('Kept');
    });

    it('applies the metadata it was given', async () => {
      await seed('c10', ['m1']);

      await service.update({
        ...base('c10'), title: 'Renamed', customTitle: true, sdkSessionId: 'session-2',
      });

      expect(stored('c10')?.title).toBe('Renamed');
      expect(stored('c10')?.customTitle).toBe(true);
      expect(stored('c10')?.sdkSessionId).toBe('session-2');
    });

    it('keeps the original createdAt', async () => {
      await service.save(createConversation({ id: 'c11', createdAt: 111, messages: [msg('m1')] }));

      await service.update({ ...base('c11'), upsert: [msg('m2')], createdAt: 999 });

      expect(stored('c11')?.createdAt).toBe(111);
    });

    it('is idempotent, so a retried write cannot duplicate anything', async () => {
      await seed('c12', ['m1']);

      await service.update({ ...base('c12'), upsert: [msg('m2')] });
      await service.update({ ...base('c12'), upsert: [msg('m2')] });

      expect(ids('c12')).toEqual(['m1', 'm2']);
    });
  });

  // ===========================================================================
  // getWindow() / getOlder() — reading a long conversation in pieces
  // ===========================================================================
  describe('reading a conversation as a window', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({
      id: `m${i}`, role: 'user' as const, content: `message ${i}`, timestamp: 1000 + i,
    }));

    beforeEach(async () => {
      await service.save(createConversation({ id: 'long', title: 'Long', messages: many(1000) }));
    });

    it('returns the most recent messages and counts the rest', async () => {
      const window = await service.getWindow('long', 100);

      expect(window?.conversation.messages).toHaveLength(100);
      expect(window?.conversation.messages[0].id).toBe('m900');
      expect(window?.olderCount).toBe(900);
    });

    it('returns everything when the limit exceeds the conversation', async () => {
      const window = await service.getWindow('long', 5000);

      expect(window?.conversation.messages).toHaveLength(1000);
      expect(window?.olderCount).toBe(0);
    });

    it('is null for a conversation that does not exist', async () => {
      expect(await service.getWindow('nope', 10)).toBeNull();
    });

    it('returns the page before a given message', async () => {
      const page = await service.getOlder('long', 'm900', 100);

      expect(page?.messages).toHaveLength(100);
      expect(page?.messages[0].id).toBe('m800');
      expect(page?.messages.at(-1)?.id).toBe('m899');
      expect(page?.olderCount).toBe(800);
    });

    it('stops at the beginning rather than wrapping', async () => {
      const page = await service.getOlder('long', 'm10', 100);

      expect(page?.messages.map((m) => m.id)).toEqual(
        Array.from({ length: 10 }, (_, i) => `m${i}`),
      );
      expect(page?.olderCount).toBe(0);
    });

    it('answers emptily for an id it does not hold', async () => {
      // Keyed by id rather than by index precisely so a conversation that
      // grew in between cannot shift a page; an unknown id is then the
      // honest "nothing to give you".
      const page = await service.getOlder('long', 'not-a-message', 100);

      expect(page?.messages).toEqual([]);
      expect(page?.olderCount).toBe(0);
    });

    it('returns the page after a given message', async () => {
      const page = await service.getNewer('long', 'm899', 50);

      expect(page?.messages[0].id).toBe('m900');
      expect(page?.messages).toHaveLength(50);
      expect(page?.newerCount).toBe(50);
    });

    // A turn the renderer holds in memory apart from its window may be
    // stored in part, and its copy in memory is ahead of the stored one. A
    // read running into it would hand back a stale copy and count it twice.
    it('stops a page at the start of a turn held in memory', async () => {
      const page = await service.getNewer('long', 'm899', 500, 'm950');

      expect(page?.messages.map((m) => m.id)).toEqual(
        Array.from({ length: 50 }, (_, i) => `m${900 + i}`),
      );
      expect(page?.newerCount).toBe(0);
    });

    it('counts only what lies before a held turn', async () => {
      const page = await service.getNewer('long', 'm899', 10, 'm950');

      expect(page?.messages).toHaveLength(10);
      expect(page?.newerCount).toBe(40);
    });

    it('ignores a held turn that is not stored yet', async () => {
      const page = await service.getNewer('long', 'm989', 500, 'not-stored-yet');

      expect(page?.messages).toHaveLength(10);
      expect(page?.newerCount).toBe(0);
    });

    it('returns nothing past a held turn, even asked from inside it', async () => {
      const page = await service.getNewer('long', 'm960', 10, 'm950');

      expect(page?.messages).toEqual([]);
      expect(page?.newerCount).toBe(0);
    });

    it('returns the stretch around a message, counted either side', async () => {
      const around = await service.getAround('long', 'm500', 250, 250);

      expect(around?.messages[0].id).toBe('m250');
      expect(around?.messages.at(-1)?.id).toBe('m750');
      expect(around?.messages).toHaveLength(501);
      expect(around?.olderCount).toBe(250);
      expect(around?.newerCount).toBe(249);
    });

    it('clamps the stretch at both ends of the conversation', async () => {
      const first = await service.getAround('long', 'm3', 250, 250);
      expect(first?.olderCount).toBe(0);
      expect(first?.messages[0].id).toBe('m0');

      const last = await service.getAround('long', 'm998', 250, 250);
      expect(last?.newerCount).toBe(0);
      expect(last?.messages.at(-1)?.id).toBe('m999');
    });

    it('stops the stretch at the start of a held turn', async () => {
      const around = await service.getAround('long', 'm900', 250, 250, 'm950');

      expect(around?.messages.at(-1)?.id).toBe('m949');
      expect(around?.newerCount).toBe(0);
    });

    it('has no stretch for a message inside a held turn, or one not stored', async () => {
      expect(await service.getAround('long', 'm960', 250, 250, 'm950')).toBeNull();
      expect(await service.getAround('long', 'nope', 250, 250)).toBeNull();
      expect(await service.getAround('nope', 'm1', 250, 250)).toBeNull();
    });
  });

  // ===========================================================================
  // Writes that look like they lose history
  // ===========================================================================
  describe('a write that looks like it loses history', () => {
    /**
     * This replaced a guard that REFUSED such a write, and the refusal is what
     * lost the messages: the save threw, the retries gave up, the file kept
     * its previous content, and everything since the last successful save
     * existed only in the renderer's memory until the conversation was
     * switched away from.
     *
     * So the contract is: say so, write it anyway. Every test here asserts the
     * write landed as well as whether anything was said about it.
     */

    const withMessages = (id: string, ids: string[]): Conversation =>
      createConversation({
        id,
        title: 'Kept',
        messages: ids.map((messageId, index) => ({
          id: messageId,
          role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
          content: `content ${messageId}`,
          timestamp: 1_700_000_000_000 + index,
        })),
      });

    const storedIds = (id: string): string[] => {
      const raw = mockFileSystem.get(`/app/conversations/${id}.json`);
      if (!raw) return [];
      return (JSON.parse(raw) as Conversation).messages.map((m) => m.id);
    };

    const warnings = (): unknown[][] =>
      logger.warn.mock.calls.filter((args: unknown[]) =>
        String(args[0]).includes('loses history'),
      );

    it('says nothing about a conversation simply growing', async () => {
      // The shape the previous guard flagged: same first message, more of
      // them. That is what every conversation in the app looks like, which is
      // why the guard fired on healthy saves.
      await service.save(withMessages('conv_growing', ['m1', 'm2']));
      await service.save(withMessages('conv_growing', ['m1', 'm2', 'm3']));
      await service.save(withMessages('conv_growing', ['m1', 'm2', 'm3', 'm4']));

      expect(warnings()).toHaveLength(0);
      expect(storedIds('conv_growing')).toEqual(['m1', 'm2', 'm3', 'm4']);
    });

    it('says nothing about the first write of a conversation', async () => {
      // Nothing to compare against — including after a restart, since what
      // was last written is only remembered in memory.
      await service.save(withMessages('conv_first', ['m1', 'm2', 'm3']));

      expect(warnings()).toHaveLength(0);
      expect(storedIds('conv_first')).toEqual(['m1', 'm2', 'm3']);
    });

    it('reports a history that now starts with a different message', async () => {
      await service.save(withMessages('conv_head', ['m1', 'm2', 'm3']));
      await service.save(withMessages('conv_head', ['m9', 'm10']));

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0][1]).toMatchObject({
        id: 'conv_head',
        reason: 'the history diverges at message 0 (was m1, now m9)',
        divergedAt: 0,
        previousCount: 3,
        incomingCount: 2,
      });
    });

    it('reports where a longer history stops agreeing, and says how long', async () => {
      // The reported case: 12,180 messages written over 11,745 with the same
      // opening. Longer, so nothing about the length says anything is wrong —
      // the index is the only thing that locates it, and the refusing version
      // never logged one.
      await service.save(withMessages('conv_middle', ['m1', 'm2', 'm3', 'm4']));
      await service.save(withMessages('conv_middle', ['m1', 'm2', 'm9', 'm4', 'm5', 'm6']));

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0][1]).toMatchObject({
        id: 'conv_middle',
        divergedAt: 2,
        previousCount: 4,
        incomingCount: 6,
      });
    });

    it('reports a history that shrank', async () => {
      await service.save(withMessages('conv_shrank', ['m1', 'm2', 'm3']));
      await service.save(withMessages('conv_shrank', ['m1', 'm2']));

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0][1]).toMatchObject({
        id: 'conv_shrank',
        reason: 'the history shrank from 3 to 2 messages',
      });
    });

    it('writes the suspicious history rather than refusing it', async () => {
      // The whole point. A refusal here is the data loss.
      await service.save(withMessages('conv_written', ['m1', 'm2', 'm3']));
      await expect(
        service.save(withMessages('conv_written', ['m9', 'm10'])),
      ).resolves.toBeUndefined();

      expect(storedIds('conv_written')).toEqual(['m9', 'm10']);
    });

    it('does not report one conversation because of another', async () => {
      await service.save(withMessages('conv_a', ['a1', 'a2', 'a3']));
      await service.save(withMessages('conv_b', ['b1']));
      await service.save(withMessages('conv_b', ['b1', 'b2']));

      expect(warnings()).toHaveLength(0);
      expect(storedIds('conv_a')).toEqual(['a1', 'a2', 'a3']);
      expect(storedIds('conv_b')).toEqual(['b1', 'b2']);
    });

    it('compares against the last write that actually landed', async () => {
      await service.save(withMessages('conv_failed', ['m1', 'm2']));

      mockFs.promises.writeFile.mockRejectedValue(new Error('disk full'));
      await expect(
        service.save(withMessages('conv_failed', ['m1', 'm2', 'm3', 'm4'])),
      ).rejects.toThrow('disk full');

      mockFs.promises.writeFile.mockImplementation(
        async (path: string, content: string) => {
          mockFileSystem.set(path, content);
        },
      );
      // Three messages is growth on what is on disk, and would look like a
      // loss only if the failed four-message attempt had been recorded.
      await service.save(withMessages('conv_failed', ['m1', 'm2', 'm3']));

      expect(warnings()).toHaveLength(0);
      expect(storedIds('conv_failed')).toEqual(['m1', 'm2', 'm3']);
    });

    it('says nothing when a conversation is emptied and refilled', async () => {
      // `/clear` writes an empty transcript; the next turn writes a fresh
      // head. Neither is a loss worth reporting — the empty write is the
      // instruction, and it leaves nothing to be the previous head.
      await service.save(withMessages('conv_cleared', ['m1', 'm2', 'm3']));
      await service.save(withMessages('conv_cleared', []));
      await service.save(withMessages('conv_cleared', ['n1']));

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0][1]).toMatchObject({
        reason: 'the history shrank from 3 to 0 messages',
      });
      expect(storedIds('conv_cleared')).toEqual(['n1']);
    });
  });
});
