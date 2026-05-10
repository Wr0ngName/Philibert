/**
 * Comprehensive tests for ClaudeCodeService.
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
const { mockQuery, mockSend, mockConfigService, mockNotificationService } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSend: vi.fn(),
  mockConfigService: {
    hasAuth: vi.fn(),
    getOAuthToken: vi.fn(),
    getApiKey: vi.fn(),
    getConfig: vi.fn(),
    getSelectedModel: vi.fn(),
  },
  mockNotificationService: {
    showPermissionRequest: vi.fn(),
    showQueryComplete: vi.fn(),
    showError: vi.fn(),
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
}));

// Mock logger
vi.mock('../../utils/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock ipc-helpers
vi.mock('../../utils/ipc-helpers', () => ({
  createSender: vi.fn(() => mockSend),
}));

// Import after mocks
import { IPC_CHANNELS } from '../../../shared/types';
import { createMockBrowserWindow } from '../../__tests__/setup';
import ClaudeCodeService from '../ClaudeCodeService';

// Test conversation ID for multi-conversation tests
const TEST_CONV_ID = 'test-conv-123';

describe('ClaudeCodeService', () => {
  let service: ClaudeCodeService;
  let mockWindow: ReturnType<typeof createMockBrowserWindow>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockWindow = createMockBrowserWindow();
    const getMainWindow = vi.fn().mockReturnValue(mockWindow);

    // Default mock implementations
    mockConfigService.hasAuth.mockResolvedValue(true);
    mockConfigService.getOAuthToken.mockResolvedValue('sk-ant-oat01-test-token-that-is-long-enough-to-pass-validation-check');
    mockConfigService.getApiKey.mockResolvedValue('');
    mockConfigService.getConfig.mockResolvedValue({ autoApproveReads: false });
    mockConfigService.getSelectedModel.mockResolvedValue('');

    service = new ClaudeCodeService(mockConfigService as any, getMainWindow, mockNotificationService as any);
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
      mockConfigService.hasAuth.mockResolvedValue(true);

      const result = await service.hasAuth();

      expect(result).toBe(true);
      expect(mockConfigService.hasAuth).toHaveBeenCalled();
    });

    it('should return false when not authenticated', async () => {
      mockConfigService.hasAuth.mockResolvedValue(false);

      const result = await service.hasAuth();

      expect(result).toBe(false);
    });
  });

  // ===========================================================================
  // sendMessage - Authentication
  // ===========================================================================
  describe('sendMessage - authentication', () => {
    it('should emit error when not authenticated', async () => {
      mockConfigService.hasAuth.mockResolvedValue(false);

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user/project');

      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_ERROR,
        TEST_CONV_ID,
        expect.stringContaining('Not authenticated')
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should validate OAuth token format', async () => {
      mockConfigService.getOAuthToken.mockResolvedValue('short');

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');

      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_ERROR,
        TEST_CONV_ID,
        expect.stringContaining('Invalid OAuth token')
      );
    });

    it('should validate OAuth token prefix', async () => {
      // Wrong prefix - should reject
      mockConfigService.getOAuthToken.mockResolvedValue('invalid-token-without-proper-prefix');

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');

      // Should emit error for invalid token prefix
      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_ERROR,
        TEST_CONV_ID,
        expect.stringContaining('Invalid OAuth token')
      );
    });

    it('should validate API key format', async () => {
      mockConfigService.getOAuthToken.mockResolvedValue('');
      mockConfigService.getApiKey.mockResolvedValue('invalid-key');

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');

      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_ERROR,
        TEST_CONV_ID,
        expect.stringContaining('Invalid API key')
      );
    });

    it('should accept valid API key', async () => {
      mockConfigService.getOAuthToken.mockResolvedValue('');
      mockConfigService.getApiKey.mockResolvedValue('sk-ant-api03-test-key-that-is-long-enough-to-pass');

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
    beforeEach(() => {
      mockConfigService.getOAuthToken.mockResolvedValue(
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
    beforeEach(() => {
      mockConfigService.getOAuthToken.mockResolvedValue(
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

    beforeEach(() => {
      mockConfigService.getOAuthToken.mockResolvedValue(
        'sk-ant-oat01-valid-token-that-is-long-enough-to-pass-validation-requirements'
      );
      mockConfigService.getConfig.mockResolvedValue({ autoApproveReads: false });

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
      mockConfigService.getConfig.mockResolvedValue({ autoApproveReads: true });

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
      mockConfigService.getOAuthToken.mockResolvedValue(
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
      const action = mockSend.mock.calls.find(
        (call) => call[0] === IPC_CHANNELS.CLAUDE_TOOL_USE
      )?.[2];

      service.handleActionResponse(TEST_CONV_ID, {
        conversationId: TEST_CONV_ID,
        actionId: action.id,
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

      mockConfigService.getOAuthToken.mockResolvedValue(
        'sk-ant-oat01-valid-token-that-is-long-enough-to-pass-validation-requirements'
      );

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

      mockConfigService.getOAuthToken.mockResolvedValue(
        'sk-ant-oat01-valid-token-that-is-long-enough-to-pass-validation-requirements'
      );

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
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================
  describe('error handling', () => {
    beforeEach(() => {
      mockConfigService.getOAuthToken.mockResolvedValue(
        'sk-ant-oat01-valid-token-that-is-long-enough-to-pass-validation-requirements'
      );
    });

    it('should convert 401 error to user-friendly message', async () => {
      mockQuery.mockImplementation(() => {
        throw new Error('API returned 401 unauthorized');
      });

      await service.sendMessage(TEST_CONV_ID, 'Hi', '/home/user');

      expect(mockSend).toHaveBeenCalledWith(
        IPC_CHANNELS.CLAUDE_ERROR,
        TEST_CONV_ID,
        expect.stringContaining('Authentication failed')
      );
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
      mockConfigService.getOAuthToken.mockResolvedValue(
        'sk-ant-oat01-valid-token-that-is-long-enough-to-pass-validation-requirements'
      );

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

    beforeEach(() => {
      mockConfigService.getOAuthToken.mockResolvedValue(
        'sk-ant-oat01-valid-token-that-is-long-enough-to-pass-validation-requirements'
      );
    });

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
    beforeEach(() => {
      mockConfigService.getOAuthToken.mockResolvedValue(
        'sk-ant-oat01-valid-token-that-is-long-enough-to-pass-validation-requirements'
      );
    });

    it('should pass selected model to SDK query options', async () => {
      mockConfigService.getSelectedModel.mockResolvedValue('claude-opus-4-7');
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
      mockConfigService.getSelectedModel.mockResolvedValue('');
      const mockIterator = createMockQueryIterator([]);
      mockQuery.mockReturnValue(mockIterator);

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user');

      const queryOptions = mockQuery.mock.calls[0][0].options;
      expect(queryOptions.model).toBeUndefined();
    });

    it('should resume session and defer model via setModel when model is explicitly selected', async () => {
      mockConfigService.getSelectedModel.mockResolvedValue('claude-opus-4-7');

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
      mockConfigService.getSelectedModel.mockResolvedValue('');
      const mockIterator = createMockQueryIterator([]);
      mockQuery.mockReturnValue(mockIterator);

      await service.sendMessage(TEST_CONV_ID, 'Hello', '/home/user', 'old-session-id');

      const queryOptions = mockQuery.mock.calls[0][0].options;
      expect(queryOptions.model).toBeUndefined();
      expect(queryOptions.resume).toBe('old-session-id');
    });

    it('should call setModel() on existing session when model changes', async () => {
      // Start session with default model — use iterator that yields init then waits
      mockConfigService.getSelectedModel.mockResolvedValue('');
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
      mockConfigService.getSelectedModel.mockResolvedValue('claude-opus-4-7');

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
      mockConfigService.getSelectedModel.mockResolvedValue('');
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
      mockConfigService.getSelectedModel.mockResolvedValue('');

      await service.sendMessage(TEST_CONV_ID, 'Follow-up', '/home/user');

      // Should NOT have created a second query — reused existing session
      expect(mockQuery).toHaveBeenCalledTimes(1);

      // Clean up
      resolveFirst();
      await firstPromise.catch(() => {});
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
