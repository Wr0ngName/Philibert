/**
 * Comprehensive tests for ClaudeCodeService.
 *
 * Uses real ConfigService with mocked external boundaries:
 * - electron safeStorage (OS keychain)
 * - electron-store (filesystem persistence)
 * - electron dialog (UI prompts)
 * - fs (filesystem operations)
 * - @anthropic-ai/claude-agent-sdk (SDK query)
 *
 * Tests cover:
 * - Message sending with SDK integration
 * - Tool permission handling (canUseTool callback)
 * - Action approval and rejection flows
 * - Streaming message handling
 * - Abort functionality
 * - Authentication validation
 * - Error handling and recovery
 * - Slash commands caching
 * - Multi-conversation support
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to ensure mocks are available before vi.mock is called
const { mockQuery, mockSend, mockSafeStorage, mockDialog, mockStoreData, mockNotificationService } = vi.hoisted(() => {
  const storeData: Record<string, unknown> = {};

  return {
    mockQuery: vi.fn(),
    mockSend: vi.fn(),
    mockSafeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
      decryptString: vi.fn((buffer: Buffer) => {
        const str = buffer.toString();
        if (str.startsWith('encrypted:')) return str.slice('encrypted:'.length);
        throw new Error('decryption failed');
      }),
    },
    mockDialog: {
      showMessageBox: vi.fn(),
    },
    mockStoreData: storeData,
    mockNotificationService: {
      showPermissionRequest: vi.fn(),
      showQueryComplete: vi.fn(),
      showError: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() },
  BrowserWindow: vi.fn(),
  safeStorage: mockSafeStorage,
  dialog: mockDialog,
}));

vi.mock('electron-store', () => ({
  default: class MockStore {
    private data: Record<string, unknown>;
    constructor(opts?: { defaults?: Record<string, unknown> }) {
      Object.assign(mockStoreData, opts?.defaults || {});
      this.data = mockStoreData;
    }
    get(key: string, defaultValue?: unknown) {
      return key in this.data ? this.data[key] : defaultValue;
    }
    set(key: string, value: unknown) { this.data[key] = value; }
    delete(key: string) { delete this.data[key]; }
    clear() { for (const k of Object.keys(this.data)) delete this.data[k]; }
    get store() { return { ...this.data }; }
  },
}));

// Mock the SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

// Mock resourcePaths (uses electron's app which isn't available in tests)
vi.mock('../../utils/resourcePaths', () => ({
  ClaudeCliPaths: {
    findBundledCli: vi.fn(() => null),
  },
  WindowsPaths: {
    hasBundledGitBash: vi.fn(() => false),
    getBashExe: vi.fn(() => ''),
    buildEnhancedPath: vi.fn(() => ''),
  },
  getClaudeConfigDir: vi.fn(() => '/tmp/test-claude-config'),
}));

// Mock logger
vi.mock('../../utils/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  setLogLevel: vi.fn(),
}));

// Mock fs (used by handleAuthInvalidated for credentials file cleanup)
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Mock ipc-helpers
vi.mock('../../utils/ipc-helpers', () => ({
  createSender: vi.fn(() => mockSend),
}));

// Import after mocks
import { IPC_CHANNELS } from '../../../shared/types';
import { createMockBrowserWindow } from '../../__tests__/setup';
import ClaudeCodeService from '../ClaudeCodeService';
import ConfigService from '../ConfigService';

// Test conversation ID for multi-conversation tests
const TEST_CONV_ID = 'test-conv-123';

describe('ClaudeCodeService', () => {
  let service: ClaudeCodeService;
  let configService: ConfigService;
  let mockWindow: ReturnType<typeof createMockBrowserWindow>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Clear store data between tests
    for (const k of Object.keys(mockStoreData)) delete mockStoreData[k];

    mockWindow = createMockBrowserWindow();
    const getMainWindow = vi.fn().mockReturnValue(mockWindow);

    // Real ConfigService with mocked electron-store and safeStorage
    configService = new ConfigService();
    await configService.ensureInitialized();

    // Default state: authenticated with OAuth token
    await configService.setOAuthToken('sk-ant-oat01-test-token-that-is-long-enough-to-pass-validation-check');
    await configService.setConfig({ autoApproveReads: false });

    const mockConversationService = { clearAllSessionIds: vi.fn().mockResolvedValue(undefined) };
    service = new ClaudeCodeService(configService, getMainWindow as any, mockNotificationService as any, mockConversationService as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Constructor and Initialization
  // ===========================================================================
  describe('constructor', () => {
    it('should initialize with config service and window getter', () => {
      expect(service).toBeDefined();
    });

    it('should create sender using provided window getter', async () => {
      const { createSender } = vi.mocked(await import('../../utils/ipc-helpers'));
      expect(createSender).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // hasAuth
  // ===========================================================================
  describe('hasAuth', () => {
    it('should delegate to config service', async () => {
      const result = await service.hasAuth();

      expect(result).toBe(true);
    });

    it('should return false when not authenticated', async () => {
      await configService.logout();

      const result = await service.hasAuth();

      expect(result).toBe(false);
    });
  });

  // ===========================================================================
  // sendMessage - Authentication
  // ===========================================================================
  describe('sendMessage - authentication', () => {
    it('should emit error when not authenticated', async () => {
      await configService.logout();

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user/project');

      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_ERROR,
        TEST_CONV_ID,
        expect.stringContaining('Not authenticated')
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should validate OAuth token format', async () => {
      await configService.setOAuthToken('short');

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');

      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_ERROR,
        TEST_CONV_ID,
        expect.stringContaining('Invalid OAuth token')
      );
    });

    it('should validate OAuth token prefix', async () => {
      await configService.setOAuthToken('invalid-token-without-proper-prefix');

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');

      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_ERROR,
        TEST_CONV_ID,
        expect.stringContaining('Invalid OAuth token')
      );
    });

    it('should validate API key format', async () => {
      await configService.setOAuthToken('');
      await configService.setApiKey('invalid-key');

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');

      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_ERROR,
        TEST_CONV_ID,
        expect.stringContaining('Invalid API key')
      );
    });

    it('should accept valid API key', async () => {
      await configService.setOAuthToken('');
      await configService.setApiKey('sk-ant-api03-test-key-that-is-long-enough-to-pass');

      const mockIterator = createMockQueryIterator([]);
      mockQuery.mockReturnValue(mockIterator);

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');

      expect(mockQuery).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // sendMessage - SDK Integration
  // ===========================================================================
  describe('sendMessage - SDK integration', () => {
    beforeEach(async () => {
      await configService.setOAuthToken(
        'sk-ant-oat01-valid-token-that-is-long-enough-to-pass-validation-requirements'
      );
    });

    it('should call SDK query with correct parameters', async () => {
      const mockIterator = createMockQueryIterator([]);
      mockQuery.mockReturnValue(mockIterator);

      await service.sendMessage(TEST_CONV_ID, 'Hello Claude', '/home/user/project');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.objectContaining({
            [Symbol.asyncIterator]: expect.any(Function),
          }),
          options: expect.objectContaining({
            cwd: '/home/user/project',
            abortController: expect.any(AbortController),
            canUseTool: expect.any(Function),
            includePartialMessages: true,
          }),
        })
      );
    });

    it('should emit CLAUDE_DONE on successful completion', async () => {
      const mockIterator = createMockQueryIterator([
        { type: 'result', subtype: 'success', num_turns: 1, duration_ms: 1000 },
      ]);
      mockQuery.mockReturnValue(mockIterator);

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');

      // Wait for the async message loop to complete
      await vi.waitFor(() => {
        expect(mockSend).toHaveBeenCalledWith(IPC_CHANNELS.CLAUDE_DONE, TEST_CONV_ID);
      });
    });

    it('should handle SDK throwing an error', async () => {
      mockQuery.mockImplementation(() => {
        throw new Error('SDK initialization failed');
      });

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');

      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_ERROR,
        TEST_CONV_ID,
        expect.any(String)
      );
    });

    it('should handle iterator throwing during iteration', async () => {
      const mockIterator = createThrowingIterator(new Error('Stream error'));
      mockQuery.mockReturnValue(mockIterator);

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');

      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_ERROR,
        TEST_CONV_ID,
        expect.any(String)
      );
    });
  });

  // ===========================================================================
  // Streaming Messages
  // ===========================================================================
  describe('streaming messages', () => {
    beforeEach(async () => {
      await configService.setOAuthToken(
        'sk-ant-oat01-valid-token-that-is-long-enough-to-pass-validation-requirements'
      );
    });

    it('should emit chunks for stream events', async () => {
      const mockIterator = createMockQueryIterator([
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'World' } },
        },
        { type: 'result', subtype: 'success' },
      ]);
      mockQuery.mockReturnValue(mockIterator);

      await service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');

      // Wait for the async message loop to process all chunks
      await vi.waitFor(() => {
        expect(mockSend).toHaveBeenCalledWith(IPC_CHANNELS.CLAUDE_CHUNK, TEST_CONV_ID, 'Hello ');
        expect(mockSend).toHaveBeenCalledWith(IPC_CHANNELS.CLAUDE_CHUNK, TEST_CONV_ID, 'World');
      });
    });

    it('should handle system messages', async () => {
      const mockIterator = createMockQueryIterator([
        { type: 'system', subtype: 'status', status: 'Compacting context...' },
        { type: 'result', subtype: 'success' },
      ]);
      mockQuery.mockReturnValue(mockIterator);

      await service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');

      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_CHUNK,
        TEST_CONV_ID,
        expect.stringContaining('Compacting context')
      );
    });

    it('should handle init message with slash commands', async () => {
      // Clear the initial emit from constructor
      mockSend.mockClear();

      const mockIterator = createMockQueryIterator([
        {
          type: 'system',
          subtype: 'init',
          slash_commands: ['custom-skill', 'another-skill'],
          model: 'claude-3-opus',
        },
        { type: 'result', subtype: 'success' },
      ]);
      mockQuery.mockReturnValue(mockIterator);

      await service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');

      // Should emit merged commands (built-in + SDK skills)
      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_SLASH_COMMANDS,
        TEST_CONV_ID,
        expect.arrayContaining([
          // Built-in commands
          expect.objectContaining({ name: 'help' }),
          expect.objectContaining({ name: 'clear' }),
          expect.objectContaining({ name: 'compact' }),
          // SDK skills from init
          expect.objectContaining({ name: 'custom-skill' }),
          expect.objectContaining({ name: 'another-skill' }),
        ])
      );
    });
  });

  // ===========================================================================
  // Tool Permission Handling
  // ===========================================================================
  describe('tool permission handling', () => {
    let capturedCanUseTool: (...args: unknown[]) => unknown;
    let finishIterator: () => void;
    let sendMessagePromise: Promise<void>;

    beforeEach(async () => {
      await configService.setOAuthToken(
        'sk-ant-oat01-valid-token-that-is-long-enough-to-pass-validation-requirements'
      );
      await configService.setConfig({ autoApproveReads: false });

      // Create an iterator that waits for our signal before completing
      mockQuery.mockImplementation(({ options }) => {
        capturedCanUseTool = options.canUseTool;
        return createPendingIterator((resolve) => {
          finishIterator = resolve;
        });
      });
    });

    afterEach(async () => {
      // Ensure iterator completes after each test
      if (finishIterator) {
        finishIterator();
      }
      if (sendMessagePromise) {
        await sendMessagePromise;
      }
    });

    it('should emit tool use event for permission request', async () => {
      // Start sendMessage but don't await - it will wait for iterator to complete
      sendMessagePromise = service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');

      // Wait for all async operations to settle (auth check, query call, etc.)
      await new Promise(resolve => setImmediate(resolve));

      const mockAbortController = { signal: { aborted: false, addEventListener: vi.fn() } };

      // Trigger permission request (don't await - it waits for response)
      const permissionPromise = capturedCanUseTool(
        'Bash',
        { command: 'ls -la', cwd: '/home/user' },
        { signal: mockAbortController.signal, suggestions: [] }
      );

      // Wait for permission callback to progress
      await new Promise(resolve => setImmediate(resolve));

      // Should emit tool use event
      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_TOOL_USE,
        TEST_CONV_ID,
        expect.objectContaining({
          toolName: 'Bash',
          type: 'bash-command',
        })
      );

      // Clean up by approving
      const action = mockSend.mock.calls.find(
        (call) => call[0] === IPC_CHANNELS.CLAUDE_TOOL_USE
      )?.[2];
      if (action) {
        service.handleActionResponse(TEST_CONV_ID, { conversationId: TEST_CONV_ID, actionId: action.id, approved: true });
      }
      await permissionPromise;

      // Finish the iterator and wait for sendMessage to complete
      finishIterator();
      await sendMessagePromise;
    });

    it('should auto-approve read operations when configured', async () => {
      await configService.setConfig({ autoApproveReads: true });

      // Start sendMessage but don't await
      sendMessagePromise = service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');
      await new Promise(resolve => setImmediate(resolve));

      const mockAbortController = { signal: { aborted: false, addEventListener: vi.fn() } };

      const result = await capturedCanUseTool(
        'Read',
        { file_path: '/home/user/test.txt' },
        { signal: mockAbortController.signal, suggestions: [] }
      ) as { behavior: string };

      expect(result.behavior).toBe('allow');
      // Should NOT emit tool use event for auto-approved
      const toolUseCalls = mockSend.mock.calls.filter(
        (call) => call[0] === IPC_CHANNELS.CLAUDE_TOOL_USE
      );
      expect(toolUseCalls).toHaveLength(0);

      finishIterator();
      await sendMessagePromise;
    });

    it('should deny when operation is aborted', async () => {
      // Start sendMessage but don't await
      sendMessagePromise = service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');
      await new Promise(resolve => setImmediate(resolve));

      const mockAbortController = { signal: { aborted: true, addEventListener: vi.fn() } };

      const result = await capturedCanUseTool(
        'Bash',
        { command: 'ls' },
        { signal: mockAbortController.signal, suggestions: [] }
      ) as { behavior: string; interrupt: boolean };

      expect(result.behavior).toBe('deny');
      expect(result.interrupt).toBe(true);

      finishIterator();
      await sendMessagePromise;
    });

    it('should generate unique action IDs', async () => {
      // Start sendMessage but don't await
      sendMessagePromise = service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');
      await new Promise(resolve => setImmediate(resolve));

      const mockAbortController = { signal: { aborted: false, addEventListener: vi.fn() } };

      // Request multiple permissions
      const promise1 = capturedCanUseTool('Bash', { command: 'ls' }, { signal: mockAbortController.signal, suggestions: [] });
      await new Promise(resolve => setImmediate(resolve));
      const promise2 = capturedCanUseTool('Bash', { command: 'pwd' }, { signal: mockAbortController.signal, suggestions: [] });
      await new Promise(resolve => setImmediate(resolve));

      const toolUseCalls = mockSend.mock.calls.filter(
        (call) => call[0] === IPC_CHANNELS.CLAUDE_TOOL_USE
      );

      expect(toolUseCalls.length).toBe(2);
      expect(toolUseCalls[0][2].id).not.toBe(toolUseCalls[1][2].id);

      // Clean up by approving both
      service.handleActionResponse(TEST_CONV_ID, { conversationId: TEST_CONV_ID, actionId: toolUseCalls[0][2].id, approved: true });
      service.handleActionResponse(TEST_CONV_ID, { conversationId: TEST_CONV_ID, actionId: toolUseCalls[1][2].id, approved: true });
      await Promise.all([promise1, promise2]);

      finishIterator();
      await sendMessagePromise;
    });

    it('should create correct action for Edit tool', async () => {
      // Start sendMessage but don't await
      sendMessagePromise = service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');
      await new Promise(resolve => setImmediate(resolve));

      const mockAbortController = { signal: { aborted: false, addEventListener: vi.fn() } };

      const promise = capturedCanUseTool(
        'Edit',
        { file_path: '/test.txt', old_string: 'foo', new_string: 'bar' },
        { signal: mockAbortController.signal, suggestions: [] }
      );
      await new Promise(resolve => setImmediate(resolve));

      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_TOOL_USE,
        TEST_CONV_ID,
        expect.objectContaining({
          type: 'file-edit',
          toolName: 'Edit',
          description: expect.stringContaining('/test.txt'),
        })
      );

      // Clean up
      const action = mockSend.mock.calls.find(
        (call) => call[0] === IPC_CHANNELS.CLAUDE_TOOL_USE
      )?.[2];
      if (action) {
        service.handleActionResponse(TEST_CONV_ID, { conversationId: TEST_CONV_ID, actionId: action.id, approved: true });
      }
      await promise;

      finishIterator();
      await sendMessagePromise;
    });

    it('should create correct action for Write tool', async () => {
      // Start sendMessage but don't await
      sendMessagePromise = service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');
      await new Promise(resolve => setImmediate(resolve));

      const mockAbortController = { signal: { aborted: false, addEventListener: vi.fn() } };

      const promise = capturedCanUseTool(
        'Write',
        { file_path: '/new-file.txt', content: 'hello' },
        { signal: mockAbortController.signal, suggestions: [] }
      );
      await new Promise(resolve => setImmediate(resolve));

      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_TOOL_USE,
        TEST_CONV_ID,
        expect.objectContaining({
          type: 'file-create',
          toolName: 'Write',
        })
      );

      // Clean up
      const action = mockSend.mock.calls.find(
        (call) => call[0] === IPC_CHANNELS.CLAUDE_TOOL_USE
      )?.[2];
      if (action) {
        service.handleActionResponse(TEST_CONV_ID, { conversationId: TEST_CONV_ID, actionId: action.id, approved: true });
      }
      await promise;

      finishIterator();
      await sendMessagePromise;
    });
  });

  // ===========================================================================
  // Action Response Handling
  // ===========================================================================
  describe('handleActionResponse', () => {
    let capturedCanUseTool: (...args: unknown[]) => unknown;
    let permissionPromise: ReturnType<typeof capturedCanUseTool>;
    let finishIterator: () => void;
    let sendMessagePromise: Promise<void>;

    beforeEach(async () => {
      await configService.setOAuthToken(
        'sk-ant-oat01-valid-token-that-is-long-enough-to-pass-validation-requirements'
      );

      // Create an iterator that waits for our signal before completing
      mockQuery.mockImplementation(({ options }) => {
        capturedCanUseTool = options.canUseTool;
        return createPendingIterator((resolve) => {
          finishIterator = resolve;
        });
      });

      // Start sendMessage but don't await - it will wait for iterator to complete
      sendMessagePromise = service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');
      await new Promise(resolve => setImmediate(resolve));

      const mockAbortController = { signal: { aborted: false, addEventListener: vi.fn() } };

      permissionPromise = capturedCanUseTool(
        'Bash',
        { command: 'rm -rf /important' },
        { signal: mockAbortController.signal, suggestions: [] }
      );
      await new Promise(resolve => setImmediate(resolve));
    });

    afterEach(async () => {
      // Ensure iterator completes after each test
      if (finishIterator) {
        finishIterator();
      }
      if (sendMessagePromise) {
        await sendMessagePromise;
      }
    });

    it('should approve action when approved is true', async () => {
      const action = mockSend.mock.calls.find(
        (call) => call[0] === IPC_CHANNELS.CLAUDE_TOOL_USE
      )?.[2];

      service.handleActionResponse(TEST_CONV_ID, {
        conversationId: TEST_CONV_ID,
        actionId: action.id,
        approved: true,
      });

      const result = await permissionPromise as { behavior: string };
      expect(result.behavior).toBe('allow');
    });

    it('should deny action when approved is false', async () => {
      const toolAction = mockSend.mock.calls.find(
        (call) => call[0] === IPC_CHANNELS.CLAUDE_TOOL_USE
      )?.[2];

      service.handleActionResponse(TEST_CONV_ID, {
        conversationId: TEST_CONV_ID,
        actionId: toolAction.id,
        approved: false,
        denyMessage: 'Too dangerous',
      });

      const result = await permissionPromise as { behavior: string; message: string };
      expect(result.behavior).toBe('deny');
      expect(result.message).toBe('Too dangerous');
    });

    it('should include updated input when provided', async () => {
      const action = mockSend.mock.calls.find(
        (call) => call[0] === IPC_CHANNELS.CLAUDE_TOOL_USE
      )?.[2];

      service.handleActionResponse(TEST_CONV_ID, {
        conversationId: TEST_CONV_ID,
        actionId: action.id,
        approved: true,
        updatedInput: { command: 'ls -la' }, // Modified command
      });

      const result = await permissionPromise as { updatedInput: Record<string, unknown> };
      expect(result.updatedInput).toEqual({ command: 'ls -la' });
    });

    it('should handle unknown action ID gracefully', () => {
      // Should not throw
      expect(() => {
        service.handleActionResponse(TEST_CONV_ID, {
          conversationId: TEST_CONV_ID,
          actionId: 'unknown-action-id',
          approved: true,
        });
      }).not.toThrow();
    });
  });

  // ===========================================================================
  // Abort Functionality
  // ===========================================================================
  describe('abort', () => {
    it('should abort the current query', async () => {
      const mockInterrupt = vi.fn();
      let iteratorStarted = false;
      let resolveIterator: (() => void) | undefined;

      // Create an iterator that hangs until interrupted
      const hangingIterator = {
        // eslint-disable-next-line require-yield
        [Symbol.asyncIterator]: async function* () {
          iteratorStarted = true;
          // Wait indefinitely until the iterator is "released"
          await new Promise<void>((resolve) => {
            resolveIterator = resolve;
          });
        },
        interrupt: mockInterrupt.mockImplementation(() => {
          // When interrupted, release the iterator
          resolveIterator?.();
        }),
        supportedCommands: vi.fn().mockResolvedValue([]),
        close: vi.fn(),
      };
      mockQuery.mockReturnValue(hangingIterator);

      // Start a message (don't await - it will hang)
      const messagePromise = service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');

      // Wait for the iterator to actually start (sendMessage has several awaits before query())
      while (!iteratorStarted) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      // Abort
      await service.abort(TEST_CONV_ID);

      // Now the message should complete
      await messagePromise;

      expect(mockInterrupt).toHaveBeenCalled();
    });

    it('should clear pending permissions on abort', async () => {
      let capturedCanUseTool: ((...args: unknown[]) => unknown) | undefined;
      let resolveIterator: (() => void) | undefined;

      // Create an iterator that hangs until the permission request triggers it
      mockQuery.mockImplementation(({ options }) => {
        capturedCanUseTool = options.canUseTool;
        return {
          [Symbol.asyncIterator]: async function* () {
            // Wait until test signals to continue
            await new Promise<void>((resolve) => {
              resolveIterator = resolve;
            });
            yield { type: 'result', subtype: 'success' };
          },
          interrupt: vi.fn().mockImplementation(() => {
            resolveIterator?.();
          }),
          supportedCommands: vi.fn().mockResolvedValue([]),
          close: vi.fn(),
        };
      });

      // Start message (will hang in iterator)
      const messagePromise = service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');

      // Wait for query() to be called and canUseTool to be captured
      while (!capturedCanUseTool) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      const mockAbortController = { signal: { aborted: false, addEventListener: vi.fn() } };

      // Create a pending permission
      const permissionPromise = capturedCanUseTool(
        'Bash',
        { command: 'ls' },
        { signal: mockAbortController.signal, suggestions: [] }
      );
      await new Promise((resolve) => setImmediate(resolve)); // Let callback progress

      // Abort should clear pending permissions and release the iterator
      await service.abort(TEST_CONV_ID);

      const result = await permissionPromise as { behavior: string; interrupt: boolean };
      expect(result.behavior).toBe('deny');
      expect(result.interrupt).toBe(true);

      // Clean up
      await messagePromise;
    });

    it('should not throw when no active query', async () => {
      await expect(service.abort(TEST_CONV_ID)).resolves.not.toThrow();
    });

    it('should preserve session after interrupt (no --resume needed for next message)', async () => {
      let interruptResolve: (() => void) | undefined;
      let messageCount = 0;
      let finishSession: (() => void) | undefined;

      const mockIterator = {
        [Symbol.asyncIterator]: async function* () {
          // First turn: hang until interrupted, then yield result
          messageCount++;
          await new Promise<void>((resolve) => {
            interruptResolve = resolve;
          });
          yield {
            type: 'system',
            subtype: 'init',
            slash_commands: [],
            model: 'claude-3',
            session_id: 'test-session-preserved',
          };
          yield { type: 'result', subtype: 'success', num_turns: 0, duration_ms: 0 };

          // Second turn: wait for next message, then complete
          messageCount++;
          await new Promise<void>((resolve) => {
            finishSession = resolve;
          });
          yield { type: 'result', subtype: 'success', num_turns: 1, duration_ms: 100 };
        },
        interrupt: vi.fn().mockImplementation(() => {
          interruptResolve?.();
        }),
        supportedCommands: vi.fn().mockResolvedValue([]),
        supportedModels: vi.fn().mockResolvedValue([]),
        setModel: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      };
      mockQuery.mockReturnValue(mockIterator);

      // Send first message — starts the session
      service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');
      await vi.waitFor(() => {
        expect(interruptResolve).toBeDefined();
      });

      // Interrupt the turn (user clicks Stop)
      await service.abort(TEST_CONV_ID);

      // Session should still be active after interrupt
      expect(service.isConversationActive(TEST_CONV_ID)).toBe(true);

      // Wait for the interrupted result to be processed
      await vi.waitFor(() => {
        expect(mockSend).toHaveBeenCalledWith(IPC_CHANNELS.CLAUDE_DONE, TEST_CONV_ID);
      });

      // query() should NOT have been called again (session reused, no --resume)
      expect(mockQuery).toHaveBeenCalledTimes(1);

      // Send second message — should reuse the existing session
      await service.sendMessage(TEST_CONV_ID, 'Second message', '/home/user');

      // Still only one query() call (same session reused)
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(messageCount).toBe(2);

      // Clean up
      finishSession?.();
      await vi.waitFor(() => {
        expect(service.isConversationActive(TEST_CONV_ID)).toBe(false);
      });
    });

    it('should fall back to hard termination when interrupt fails', async () => {
      let iteratorStarted = false;
      let resolveIterator: (() => void) | undefined;

      const mockIterator = {
        // eslint-disable-next-line require-yield
        [Symbol.asyncIterator]: async function* () {
          iteratorStarted = true;
          await new Promise<void>((resolve) => {
            resolveIterator = resolve;
          });
        },
        interrupt: vi.fn().mockRejectedValue(new Error('interrupt failed')),
        supportedCommands: vi.fn().mockResolvedValue([]),
        supportedModels: vi.fn().mockResolvedValue([]),
        setModel: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      };
      mockQuery.mockReturnValue(mockIterator);

      service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');
      while (!iteratorStarted) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      // Abort — interrupt will fail, should fall back to hard termination
      await service.abort(TEST_CONV_ID);

      // Session should be cleaned up (hard kill fallback)
      expect(service.isConversationActive(TEST_CONV_ID)).toBe(false);

      // Should emit done via the termination path
      expect(mockSend).toHaveBeenCalledWith(IPC_CHANNELS.CLAUDE_DONE, TEST_CONV_ID);

      // Clean up the dangling iterator
      resolveIterator?.();
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================
  describe('error handling', () => {
    beforeEach(async () => {
      await configService.setOAuthToken(
        'sk-ant-oat01-valid-token-that-is-long-enough-to-pass-validation-requirements'
      );
    });

    it('should auto-clear credentials and notify on 401 error', async () => {
      mockQuery.mockImplementation(() => {
        throw new Error('API returned 401 unauthorized');
      });

      await service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');

      // handleAuthInvalidated runs async fire-and-forget — wait for all effects
      await vi.waitFor(async () => {
        const token = await configService.getOAuthToken();
        expect(token).toBe('');
        expect(mockSend).toHaveBeenCalledWith(IPC_CHANNELS.AUTH_INVALIDATED);
      });
    });

    it('should convert 429 error to rate limit message', async () => {
      mockQuery.mockImplementation(() => {
        throw new Error('429 Too Many Requests');
      });

      await service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');

      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_ERROR,
        TEST_CONV_ID,
        expect.stringContaining('Rate limit')
      );
    });

    it('should convert network error to user-friendly message', async () => {
      mockQuery.mockImplementation(() => {
        throw new Error('ECONNREFUSED');
      });

      await service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');

      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_ERROR,
        TEST_CONV_ID,
        expect.stringContaining('Network error')
      );
    });

    it('should handle AbortError silently', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockQuery.mockImplementation(() => {
        throw abortError;
      });

      await service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');

      // Should NOT emit error for abort
      const errorCalls = mockSend.mock.calls.filter(
        (call) => call[0] === IPC_CHANNELS.CLAUDE_ERROR
      );
      expect(errorCalls).toHaveLength(0);
    });

    it('should handle process exit error after successful query', async () => {
      // Iterator completes successfully
      mockQuery.mockImplementation(() => ({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'result', subtype: 'success', num_turns: 1 };
        },
        interrupt: vi.fn(),
        close: vi.fn(),
      }));

      await service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');

      // Wait for the async message loop to complete
      await vi.waitFor(() => {
        expect(mockSend).toHaveBeenCalledWith(IPC_CHANNELS.CLAUDE_DONE, TEST_CONV_ID);
      });
    });
  });

  // ===========================================================================
  // Slash Commands
  // ===========================================================================
  describe('getSlashCommands', () => {
    it('should return cached slash commands', () => {
      const commands = service.getSlashCommands();
      expect(Array.isArray(commands)).toBe(true);
    });

    it('should return merged built-in and SDK commands after init message', async () => {
      const mockIterator = createMockQueryIterator([
        {
          type: 'system',
          subtype: 'init',
          slash_commands: ['custom-skill', 'another-skill'],
        },
        { type: 'result', subtype: 'success' },
      ]);
      mockQuery.mockReturnValue(mockIterator);

      await service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');

      const commands = service.getSlashCommands();
      // Should have built-in commands + SDK commands merged
      expect(commands.length).toBeGreaterThan(2);
      // Built-in commands should be present with descriptions
      expect(commands.find(c => c.name === 'help')).toBeDefined();
      expect(commands.find(c => c.name === 'clear')).toBeDefined();
      // SDK commands should also be present
      expect(commands.find(c => c.name === 'custom-skill')).toBeDefined();
    });
  });

  // ===========================================================================
  // Multi-Conversation Support
  // ===========================================================================
  describe('multi-conversation support', () => {
    const CONV_ID_1 = 'conv-1';
    const CONV_ID_2 = 'conv-2';

    it('should track active queries per conversation', async () => {
      // Create iterators that hang
      const createHangingIterator = () => {
        let resolveIterator: (() => void) | undefined;
        return {
          iterator: {
            [Symbol.asyncIterator]: async function* () {
              await new Promise<void>((resolve) => {
                resolveIterator = resolve;
              });
              yield { type: 'result', subtype: 'success' };
            },
            interrupt: vi.fn().mockImplementation(() => {
              resolveIterator?.();
            }),
            supportedCommands: vi.fn().mockResolvedValue([]),
            close: vi.fn(),
          },
          resolve: () => resolveIterator?.(),
        };
      };

      const iter1 = createHangingIterator();
      const iter2 = createHangingIterator();

      let queryCallCount = 0;
      mockQuery.mockImplementation(() => {
        queryCallCount++;
        return queryCallCount === 1 ? iter1.iterator : iter2.iterator;
      });

      // Start two conversations
      const promise1 = service.sendMessage(CONV_ID_1, 'Hello', '/home/user');
      await new Promise(resolve => setImmediate(resolve)); // Let first query start

      const promise2 = service.sendMessage(CONV_ID_2, 'World', '/home/user');
      await new Promise(resolve => setImmediate(resolve)); // Let second query start

      // Both should be active
      expect(service.getActiveConversationIds()).toContain(CONV_ID_1);
      expect(service.getActiveConversationIds()).toContain(CONV_ID_2);

      // Clean up
      iter1.resolve();
      iter2.resolve();
      await Promise.all([promise1, promise2]);
    });

    it('should abort specific conversation without affecting others', async () => {
      const createHangingIterator = () => {
        let resolveIterator: (() => void) | undefined;
        const interrupt = vi.fn().mockImplementation(() => {
          resolveIterator?.();
        });
        return {
          iterator: {
            [Symbol.asyncIterator]: async function* () {
              await new Promise<void>((resolve) => {
                resolveIterator = resolve;
              });
              yield { type: 'result', subtype: 'success' };
            },
            interrupt,
            supportedCommands: vi.fn().mockResolvedValue([]),
            close: vi.fn(),
          },
          interrupt,
          resolve: () => resolveIterator?.(),
        };
      };

      const iter1 = createHangingIterator();
      const iter2 = createHangingIterator();

      let queryCallCount = 0;
      mockQuery.mockImplementation(() => {
        queryCallCount++;
        return queryCallCount === 1 ? iter1.iterator : iter2.iterator;
      });

      // Start two conversations
      const promise1 = service.sendMessage(CONV_ID_1, 'Hello', '/home/user');
      await new Promise(resolve => setImmediate(resolve));

      const promise2 = service.sendMessage(CONV_ID_2, 'World', '/home/user');
      await new Promise(resolve => setImmediate(resolve));

      // Abort only the first conversation
      await service.abort(CONV_ID_1);

      // First should be interrupted
      expect(iter1.interrupt).toHaveBeenCalled();
      // Second should NOT be interrupted
      expect(iter2.interrupt).not.toHaveBeenCalled();

      // Clean up
      iter2.resolve();
      await Promise.all([promise1, promise2]);
    });

    it('should respect resource limits', async () => {
      // Start max concurrent queries
      const iterators: Array<{ resolve: () => void }> = [];
      mockQuery.mockImplementation(() => {
        let resolveIterator: (() => void) | undefined;
        const iter = {
          [Symbol.asyncIterator]: async function* () {
            await new Promise<void>((resolve) => {
              resolveIterator = resolve;
            });
            yield { type: 'result', subtype: 'success' };
          },
          interrupt: vi.fn().mockImplementation(() => {
            resolveIterator?.();
          }),
          supportedCommands: vi.fn().mockResolvedValue([]),
          close: vi.fn(),
        };
        iterators.push({ resolve: () => resolveIterator?.() });
        return iter;
      });

      // Start 5 conversations (the max)
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(service.sendMessage(`conv-${i}`, 'Hello', '/home/user'));
        await new Promise(resolve => setImmediate(resolve));
      }

      // Try to start a 6th - should emit error
      await service.sendMessage('conv-6', 'Hello', '/home/user');

      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_ERROR,
        'conv-6',
        expect.stringContaining('Maximum concurrent conversations')
      );

      // Clean up
      iterators.forEach(iter => iter.resolve());
      await Promise.all(promises);
    });
  });

  // ===========================================================================
  // Model Selection
  // ===========================================================================
  describe('sendMessage - model selection', () => {
    it('should pass selected model to SDK query options', async () => {
      await configService.setSelectedModel('claude-opus-4-7');
      const mockIterator = createMockQueryIterator([]);
      mockQuery.mockReturnValue(mockIterator);

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            model: 'claude-opus-4-7',
          }),
        })
      );
    });

    it('should NOT pass model when selectedModel is empty (use SDK default)', async () => {
      await configService.setSelectedModel('');
      const mockIterator = createMockQueryIterator([]);
      mockQuery.mockReturnValue(mockIterator);

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');

      const queryOptions = mockQuery.mock.calls[0][0].options;
      expect(queryOptions.model).toBeUndefined();
    });

    it('should resume session and defer model via setModel when model is explicitly selected', async () => {
      await configService.setSelectedModel('claude-opus-4-7');

      // Create an iterator that yields init with session_id so sessionReady resolves
      let resolveWait!: () => void;
      const waitPromise = new Promise<void>((resolve) => { resolveWait = resolve; });
      const mockIterator = {
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'resumed-session-id', slash_commands: [] };
          await waitPromise;
          yield { type: 'result', subtype: 'success' };
        },
        interrupt: vi.fn(),
        supportedCommands: vi.fn().mockResolvedValue([]),
        supportedModels: vi.fn().mockResolvedValue([]),
        setModel: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      };
      mockQuery.mockReturnValue(mockIterator);

      const sendPromise = service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user', 'old-session-id');
      // Let the message loop process the init message and setModel to be called
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have passed resume, NOT model
      const queryOptions = mockQuery.mock.calls[0][0].options;
      expect(queryOptions.resume).toBe('old-session-id');
      expect(queryOptions.model).toBeUndefined();

      // setModel should have been called after session init
      expect(mockIterator.setModel).toHaveBeenCalledWith('claude-opus-4-7');

      // Clean up
      resolveWait();
      await sendPromise.catch(() => {});
    });

    it('should use resume when no model is explicitly selected', async () => {
      await configService.setSelectedModel('');
      const mockIterator = createMockQueryIterator([]);
      mockQuery.mockReturnValue(mockIterator);

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user', 'old-session-id');

      const queryOptions = mockQuery.mock.calls[0][0].options;
      expect(queryOptions.model).toBeUndefined();
      expect(queryOptions.resume).toBe('old-session-id');
    });

    it('should call setModel() on existing session when model changes', async () => {
      // Start session with default model — use iterator that yields init then waits
      await configService.setSelectedModel('');
      let resolveFirst!: () => void;
      const waitPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });
      const firstIterator = {
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'test-session-456', slash_commands: [] };
          await waitPromise;
          yield { type: 'result', subtype: 'success' };
        },
        interrupt: vi.fn(),
        supportedCommands: vi.fn().mockResolvedValue([]),
        supportedModels: vi.fn().mockResolvedValue([]),
        setModel: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      };
      mockQuery.mockReturnValue(firstIterator);

      const firstPromise = service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');
      // Let the message loop process the init message
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockQuery).toHaveBeenCalledTimes(1);

      // Change model to Opus
      await configService.setSelectedModel('claude-opus-4-7');

      // Send second message — should call setModel() on existing session
      await service.sendMessage(TEST_CONV_ID, 'Second message', '/home/user');

      // Should NOT have created a second query — reused existing session with setModel()
      expect(mockQuery).toHaveBeenCalledTimes(1);

      // setModel should have been called with the new model
      expect(firstIterator.setModel).toHaveBeenCalledWith('claude-opus-4-7');

      // Clean up
      resolveFirst();
      await firstPromise.catch(() => {});
    });

    it('should reuse existing session when model has NOT changed', async () => {
      // Start session with default model — use an iterator that yields init then waits
      await configService.setSelectedModel('');
      let resolveFirst!: () => void;
      const waitPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });
      const firstIterator = {
        [Symbol.asyncIterator]: async function* () {
          // Yield an init message so sessionReady resolves
          yield { type: 'system', subtype: 'init', session_id: 'test-session-123', slash_commands: [] };
          // Then wait for cleanup
          await waitPromise;
          yield { type: 'result', subtype: 'success' };
        },
        interrupt: vi.fn(),
        supportedCommands: vi.fn().mockResolvedValue([]),
        supportedModels: vi.fn().mockResolvedValue([]),
        close: vi.fn(),
      };
      mockQuery.mockReturnValue(firstIterator);

      const firstPromise = service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');
      // Let the message loop process the init message
      await new Promise(resolve => setTimeout(resolve, 50));

      // Send second message with same model (still empty/default)
      await service.sendMessage(TEST_CONV_ID, 'Follow-up', '/home/user');

      // Should NOT have created a second query — reused existing session
      expect(mockQuery).toHaveBeenCalledTimes(1);

      // Clean up
      resolveFirst();
      await firstPromise.catch(() => {});
    });
  });

  // ===========================================================================
  // Session Lifecycle — session ID robustness through the whole conversation
  // ===========================================================================
  describe('session lifecycle', () => {
    it('should emit session ID from init message to renderer', async () => {
      const mockIterator = createMockQueryIterator([
        { type: 'system', subtype: 'init', session_id: 'init-session-42', slash_commands: [], model: 'claude-3' },
        { type: 'result', subtype: 'success', num_turns: 1, duration_ms: 100 },
      ]);
      mockQuery.mockReturnValue(mockIterator);

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');

      await vi.waitFor(() => {
        expect(mockSend).toHaveBeenCalledWith(
          IPC_CHANNELS.CLAUDE_SESSION_ID,
          TEST_CONV_ID,
          'init-session-42'
        );
      });
    });

    it('should NOT emit session ID from error result messages', async () => {
      const mockIterator = createMockQueryIterator([
        { type: 'system', subtype: 'init', session_id: 'good-session', slash_commands: [] },
        { type: 'result', subtype: 'error_during_execution', session_id: 'stale-error-session', num_turns: 0, duration_ms: 0, is_error: true },
      ]);
      mockQuery.mockReturnValue(mockIterator);

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');

      await vi.waitFor(() => {
        expect(mockSend).toHaveBeenCalledWith(IPC_CHANNELS.CLAUDE_DONE, TEST_CONV_ID);
      });

      // Should have emitted the init session ID
      const sessionIdCalls = mockSend.mock.calls.filter(
        (call: unknown[]) => call[0] === IPC_CHANNELS.CLAUDE_SESSION_ID
      );
      expect(sessionIdCalls).toHaveLength(1);
      expect(sessionIdCalls[0][2]).toBe('good-session');
    });

    it('should not need --resume when session is still alive (multi-turn within same session)', async () => {
      let turnIndex = 0;
      const turnResolvers: (() => void)[] = [];

      const mockIterator = {
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'persistent-session-789', slash_commands: [] };

          // Turn 1
          await new Promise<void>((resolve) => { turnResolvers.push(resolve); });
          yield { type: 'result', subtype: 'success', num_turns: 1, duration_ms: 100 };
          turnIndex++;

          // Turn 2
          await new Promise<void>((resolve) => { turnResolvers.push(resolve); });
          yield { type: 'result', subtype: 'success', num_turns: 2, duration_ms: 200 };
          turnIndex++;
        },
        interrupt: vi.fn(),
        supportedCommands: vi.fn().mockResolvedValue([]),
        supportedModels: vi.fn().mockResolvedValue([]),
        setModel: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      };
      mockQuery.mockReturnValue(mockIterator);

      // First message — creates session
      service.sendMessage(TEST_CONV_ID, 'First', '/home/user');
      await vi.waitFor(() => { expect(turnResolvers).toHaveLength(1); });
      turnResolvers[0]();

      await vi.waitFor(() => { expect(turnIndex).toBe(1); });

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(service.isConversationActive(TEST_CONV_ID)).toBe(true);

      // Second message — reuses the SAME session, no new query()
      await service.sendMessage(TEST_CONV_ID, 'Second', '/home/user');
      await vi.waitFor(() => { expect(turnResolvers).toHaveLength(2); });
      turnResolvers[1]();

      await vi.waitFor(() => { expect(turnIndex).toBe(2); });

      // Still only one query() call — session was reused, no --resume
      expect(mockQuery).toHaveBeenCalledTimes(1);

      const queryOptions = mockQuery.mock.calls[0][0].options;
      expect(queryOptions.resume).toBeUndefined();
    });

    it('should use --resume only when session is dead (e.g. after app restart)', async () => {
      // Simulate first session that completes and dies (iterator exhausted)
      const firstIterator = createMockQueryIterator([
        { type: 'system', subtype: 'init', session_id: 'original-session', slash_commands: [] },
        { type: 'result', subtype: 'success', num_turns: 1, duration_ms: 100 },
      ]);
      mockQuery.mockReturnValue(firstIterator);

      await service.sendMessage(TEST_CONV_ID, 'First', '/home/user');

      // Wait for session to complete and be cleaned up
      await vi.waitFor(() => {
        expect(service.isConversationActive(TEST_CONV_ID)).toBe(false);
      });

      // Now simulate sending a message with a stored session ID (as after app restart)
      const secondIterator = createMockQueryIterator([
        { type: 'system', subtype: 'init', session_id: 'resumed-session', slash_commands: [] },
        { type: 'result', subtype: 'success', num_turns: 2, duration_ms: 200 },
      ]);
      mockQuery.mockReturnValue(secondIterator);

      await service.sendMessage(TEST_CONV_ID, 'After restart', '/home/user', 'original-session');

      // Should have created a NEW query with --resume
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const secondQueryOptions = mockQuery.mock.calls[1][0].options;
      expect(secondQueryOptions.resume).toBe('original-session');
    });

    it('should clear stale session ID and show error when --resume fails', async () => {
      const mockIterator = createMockQueryIterator([
        { type: 'result', subtype: 'error_during_execution', error: 'No conversation found with session ID abc123', num_turns: 0, duration_ms: 0, is_error: true, session_id: 'stale-id' },
      ]);
      mockQuery.mockReturnValue(mockIterator);

      await service.sendMessage(TEST_CONV_ID, 'Resume attempt', '/home/user', 'abc123');

      await vi.waitFor(() => {
        // Should clear the stale session ID (empty string)
        expect(mockSend).toHaveBeenCalledWith(
          IPC_CHANNELS.CLAUDE_SESSION_ID,
          TEST_CONV_ID,
          ''
        );

        // Should show a user-friendly error
        expect(mockSend).toHaveBeenCalledWith(
          IPC_CHANNELS.CLAUDE_ERROR,
          TEST_CONV_ID,
          expect.stringContaining('session has expired')
        );
      });
    });

    it('should keep session alive across multiple interrupt cycles', async () => {
      let turnIndex = 0;
      const turnResolvers: (() => void)[] = [];

      const mockIterator = {
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'durable-session', slash_commands: [] };

          // Turn 1: will be interrupted
          await new Promise<void>((resolve) => { turnResolvers.push(resolve); });
          yield { type: 'result', subtype: 'success', num_turns: 0, duration_ms: 50 };
          turnIndex++;

          // Turn 2: will also be interrupted
          await new Promise<void>((resolve) => { turnResolvers.push(resolve); });
          yield { type: 'result', subtype: 'success', num_turns: 0, duration_ms: 50 };
          turnIndex++;

          // Turn 3: completes normally
          await new Promise<void>((resolve) => { turnResolvers.push(resolve); });
          yield { type: 'result', subtype: 'success', num_turns: 1, duration_ms: 100 };
          turnIndex++;
        },
        interrupt: vi.fn().mockImplementation(() => {
          const latest = turnResolvers[turnResolvers.length - 1];
          latest?.();
        }),
        supportedCommands: vi.fn().mockResolvedValue([]),
        supportedModels: vi.fn().mockResolvedValue([]),
        setModel: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      };
      mockQuery.mockReturnValue(mockIterator);

      // Turn 1
      service.sendMessage(TEST_CONV_ID, 'Message 1', '/home/user');
      await vi.waitFor(() => { expect(turnResolvers).toHaveLength(1); });

      // Interrupt turn 1
      await service.abort(TEST_CONV_ID);
      await vi.waitFor(() => { expect(turnIndex).toBe(1); });
      expect(service.isConversationActive(TEST_CONV_ID)).toBe(true);

      // Turn 2 — still same session
      await service.sendMessage(TEST_CONV_ID, 'Message 2', '/home/user');
      await vi.waitFor(() => { expect(turnResolvers).toHaveLength(2); });

      // Interrupt turn 2
      await service.abort(TEST_CONV_ID);
      await vi.waitFor(() => { expect(turnIndex).toBe(2); });
      expect(service.isConversationActive(TEST_CONV_ID)).toBe(true);

      // Turn 3 — still same session, completes normally
      await service.sendMessage(TEST_CONV_ID, 'Message 3', '/home/user');
      await vi.waitFor(() => { expect(turnResolvers).toHaveLength(3); });
      turnResolvers[2]();
      await vi.waitFor(() => { expect(turnIndex).toBe(3); });

      // Only ONE query() call across all 3 turns + 2 interrupts
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });
});

// ===========================================================================
// Helper Functions
// ===========================================================================

/**
 * Create a mock async iterator for SDK query results
 */

function createMockQueryIterator(messages: any[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const msg of messages) {
        yield msg;
      }
    },
    interrupt: vi.fn(),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedModels: vi.fn().mockResolvedValue([]),
    setModel: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

/**
 * Create an iterator that waits for a signal before completing
 * Used for tests that need the query to stay active during permission handling
 */
function createPendingIterator(onReady: (resolve: () => void) => void) {
  const waitPromise = new Promise<void>((resolve) => {
    onReady(resolve);
  });

  return {
    [Symbol.asyncIterator]: async function* () {
      await waitPromise;
      yield { type: 'result', subtype: 'success' };
    },
    interrupt: vi.fn(),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedModels: vi.fn().mockResolvedValue([]),
    setModel: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

/**
 * Create an iterator that throws an error
 */
function createThrowingIterator(error: Error) {
  return {
    // eslint-disable-next-line require-yield
    [Symbol.asyncIterator]: async function* () {
      throw error;
    },
    interrupt: vi.fn(),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedModels: vi.fn().mockResolvedValue([]),
    setModel: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}
