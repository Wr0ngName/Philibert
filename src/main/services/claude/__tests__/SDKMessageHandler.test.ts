/**
 * Tests for SDKMessageHandler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { SlashCommandInfo } from '../../../../shared/types';
// Mock the logger to avoid Electron app dependency
vi.mock('../../../utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
import { SDKMessageHandler, MessageHandlerCallbacks, resolveResultError, extractTaskCreateId } from '../SDKMessageHandler';

describe('SDKMessageHandler', () => {
  let callbacks: MessageHandlerCallbacks;
  let handler: SDKMessageHandler;

  beforeEach(() => {
    callbacks = {
      onChunk: vi.fn(),
      onSlashCommands: vi.fn(),
      onTaskNotification: vi.fn(),
      onUsageUpdate: vi.fn(),
      onSystemNote: vi.fn(),
    };
    handler = new SDKMessageHandler(callbacks);
  });

  describe('reset', () => {
    it('should reset querySucceeded flag', () => {
      // Simulate query success
      handler.handleMessage({
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        duration_ms: 100,
      } as never);

      expect(handler.didQuerySucceed()).toBe(true);

      handler.reset();
      expect(handler.didQuerySucceed()).toBe(false);
    });

    it('should reset slash command tracking flag', () => {
      handler.markSlashCommandSent();
      handler.reset();
      // Flag should be reset - verify by checking behavior
      // When slash command flag is reset, assistant messages won't be emitted
      handler.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'test' }] },
      } as never);
      expect(callbacks.onChunk).not.toHaveBeenCalled();
    });
  });

  describe('markSlashCommandSent', () => {
    it('should mark that a slash command was sent', () => {
      handler.markSlashCommandSent();

      // When slash command is marked, assistant messages should be emitted
      handler.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Help output' }] },
      } as never);

      expect(callbacks.onChunk).toHaveBeenCalledWith('Help output');
    });

    it('should reset flag after processing assistant message', () => {
      handler.markSlashCommandSent();

      // First assistant message - emitted
      handler.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'First' }] },
      } as never);

      // Clear the mock
      vi.clearAllMocks();

      // Second assistant message - not emitted (flag was reset)
      handler.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Second' }] },
      } as never);

      expect(callbacks.onChunk).not.toHaveBeenCalled();
    });
  });

  describe('updateSlashCommands', () => {
    it('should replace the list with exactly what the SDK reports', () => {
      // A replacement, not a merge. The SDK's push is authoritative
      // ("Clients should REPLACE their cached command list with this
      // payload") and already includes Claude Code's own commands. Merging a
      // local table over it was what hid /rewind, which the table lacked.
      const commands: SlashCommandInfo[] = [
        { name: 'custom-skill', description: 'Custom skill', argumentHint: '' },
      ];

      handler.updateSlashCommands(commands);

      expect(handler.getSlashCommands()).toEqual(commands);
    });

    it('should keep aliases and the builtin marker', () => {
      // Dropping these broke alias resolution (/cost → /usage) and left the
      // autocomplete unable to tell a project command from a builtin one.
      const commands: SlashCommandInfo[] = [
        {
          name: 'usage',
          description: 'Token and cost totals',
          argumentHint: '',
          aliases: ['cost', 'stats'],
          builtin: true,
        },
      ];

      handler.updateSlashCommands(commands);

      const usage = handler.getSlashCommands().find((c) => c.name === 'usage');
      expect(usage?.aliases).toEqual(['cost', 'stats']);
      expect(usage?.builtin).toBe(true);
    });

    it('should keep two rows that share a name', () => {
      // The SDK allows it and defines which one a typed name runs, so
      // collapsing them here would break that rule.
      const commands: SlashCommandInfo[] = [
        { name: 'review', description: 'project version', argumentHint: '' },
        { name: 'review', description: 'builtin version', argumentHint: '', builtin: true },
      ];

      handler.updateSlashCommands(commands);

      expect(handler.getSlashCommands()).toHaveLength(2);
    });
  });

  describe('handleMessage - assistant type', () => {
    it('should not emit regular assistant messages', async () => {
      await handler.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Regular message' }] },
      } as never);

      expect(callbacks.onChunk).not.toHaveBeenCalled();
    });

    it('should emit assistant messages when slash command flag is set', async () => {
      handler.markSlashCommandSent();

      await handler.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Command output' }] },
      } as never);

      expect(callbacks.onChunk).toHaveBeenCalledWith('Command output');
    });

    it('should not emit empty text content', async () => {
      handler.markSlashCommandSent();

      await handler.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '   ' }] },
      } as never);

      expect(callbacks.onChunk).not.toHaveBeenCalled();
    });
  });

  describe('handleMessage - session_id handling', () => {
    it('should emit session_id from init message', async () => {
      const onSessionId = vi.fn();
      const callbacksWithSession: MessageHandlerCallbacks = {
        ...callbacks,
        onSessionId,
      };
      const sessionHandler = new SDKMessageHandler(callbacksWithSession);

      await sessionHandler.handleMessage({
        type: 'system',
        subtype: 'init',
        slash_commands: [],
        model: 'claude-3',
        session_id: 'test-session-abc123',
      } as never);

      expect(onSessionId).toHaveBeenCalledWith('test-session-abc123');
    });

    it('should emit session_id from result message', async () => {
      const onSessionId = vi.fn();
      const callbacksWithSession: MessageHandlerCallbacks = {
        ...callbacks,
        onSessionId,
      };
      const sessionHandler = new SDKMessageHandler(callbacksWithSession);

      await sessionHandler.handleMessage({
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        duration_ms: 100,
        session_id: 'result-session-xyz789',
      } as never);

      expect(onSessionId).toHaveBeenCalledWith('result-session-xyz789');
    });

    it('should NOT emit session_id from error result messages', async () => {
      const onSessionId = vi.fn();
      const callbacksWithSession: MessageHandlerCallbacks = {
        ...callbacks,
        onSessionId,
      };
      const sessionHandler = new SDKMessageHandler(callbacksWithSession);

      await sessionHandler.handleMessage({
        type: 'result',
        subtype: 'error_during_execution',
        num_turns: 0,
        duration_ms: 0,
        session_id: 'stale-error-session-id',
      } as never);

      expect(onSessionId).not.toHaveBeenCalled();
    });

    it('should NOT emit session_id from error subtype result messages', async () => {
      const onSessionId = vi.fn();
      const callbacksWithSession: MessageHandlerCallbacks = {
        ...callbacks,
        onSessionId,
      };
      const sessionHandler = new SDKMessageHandler(callbacksWithSession);

      await sessionHandler.handleMessage({
        type: 'result',
        subtype: 'error',
        num_turns: 0,
        duration_ms: 0,
        session_id: 'another-stale-session-id',
      } as never);

      expect(onSessionId).not.toHaveBeenCalled();
    });

    it('should not emit session_id if not present in init message', async () => {
      const onSessionId = vi.fn();
      const callbacksWithSession: MessageHandlerCallbacks = {
        ...callbacks,
        onSessionId,
      };
      const sessionHandler = new SDKMessageHandler(callbacksWithSession);

      await sessionHandler.handleMessage({
        type: 'system',
        subtype: 'init',
        slash_commands: [],
        model: 'claude-3',
      } as never);

      expect(onSessionId).not.toHaveBeenCalled();
    });
  });

  describe('handleMessage - system type with init', () => {
    it('should record the command names the init message carries', async () => {
      // init carries names only, so this is the preliminary list that gets
      // them into the autocomplete at once; supportedCommands() follows with
      // the detailed rows. Nothing is added from a local table.
      await handler.handleMessage({
        type: 'system',
        subtype: 'init',
        slash_commands: ['custom-skill', 'another-skill'],
        model: 'claude-3',
      } as never);

      expect(handler.getSlashCommands()).toEqual([
        { name: 'custom-skill', description: '', argumentHint: '' },
        { name: 'another-skill', description: '', argumentHint: '' },
      ]);
    });

    it('should not downgrade a detailed row to a bare name', async () => {
      // A description the user is reading must not be replaced by nothing
      // just because init lists the same command again.
      handler.updateSlashCommands([
        { name: 'custom-skill', description: 'Full description', argumentHint: '<arg>' },
      ]);

      await handler.handleMessage({
        type: 'system',
        subtype: 'init',
        slash_commands: ['custom-skill'],
        model: 'claude-3',
      } as never);

      const command = handler.getSlashCommands().find((c) => c.name === 'custom-skill');
      expect(command?.description).toBe('Full description');
      expect(command?.argumentHint).toBe('<arg>');
    });

    it('should emit the command list to the callback', async () => {
      vi.clearAllMocks();

      await handler.handleMessage({
        type: 'system',
        subtype: 'init',
        slash_commands: ['custom-skill'],
        model: 'claude-3',
      } as never);

      expect(callbacks.onSlashCommands).toHaveBeenCalled();
      const mockFn = callbacks.onSlashCommands as ReturnType<typeof vi.fn>;
      const emittedCommands = mockFn.mock.calls[mockFn.mock.calls.length - 1][0];
      expect(emittedCommands.find((c: SlashCommandInfo) => c.name === 'custom-skill')).toBeDefined();
    });

    it('should not emit an empty list when constructed', () => {
      // The renderer REPLACES its list with whatever arrives on this channel,
      // so emitting the empty starting value would clear a list it had
      // already fetched for the prompt box.
      const emissions = (callbacks.onSlashCommands as ReturnType<typeof vi.fn>).mock.calls;
      expect(emissions.filter((call) => (call[0] as SlashCommandInfo[]).length === 0)).toEqual([]);
    });

    it('should add new SDK commands while preserving existing descriptions', async () => {
      // First set commands with descriptions via updateSlashCommands
      handler.updateSlashCommands([
        { name: 'custom', description: 'Custom desc', argumentHint: '' },
      ]);

      const commandsBefore = handler.getSlashCommands();
      const countBefore = commandsBefore.length;

      // Then receive init message with a NEW skill (should be added)
      await handler.handleMessage({
        type: 'system',
        subtype: 'init',
        slash_commands: ['new-skill'],
        model: 'claude-3',
      } as never);

      // Should have one more command (new-skill was added)
      const commandsAfter = handler.getSlashCommands();
      expect(commandsAfter.length).toBe(countBefore + 1);

      // Existing descriptions should be preserved
      const customCmd = commandsAfter.find(c => c.name === 'custom');
      expect(customCmd?.description).toBe('Custom desc');

      // New skill should be added (with empty description from init)
      const newSkill = commandsAfter.find(c => c.name === 'new-skill');
      expect(newSkill).toBeDefined();
    });
  });

  describe('handleMessage - stream_event type', () => {
    it('should emit text delta chunks', async () => {
      await handler.handleMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello' },
        },
      } as never);

      expect(callbacks.onChunk).toHaveBeenCalledWith('Hello');
    });

    it('should not emit for non-text_delta events', async () => {
      await handler.handleMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          delta: {},
        },
      } as never);

      expect(callbacks.onChunk).not.toHaveBeenCalled();
    });
  });

  describe('handleMessage - result type', () => {
    it('should set querySucceeded on success', async () => {
      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        duration_ms: 100,
      } as never);

      expect(handler.didQuerySucceed()).toBe(true);
    });

    it('should emit result text on success (slash command output)', async () => {
      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        duration_ms: 100,
        result: 'Help output from /help command',
      } as never);

      expect(callbacks.onChunk).toHaveBeenCalledWith('Help output from /help command');
    });

    it('should not emit empty result text', async () => {
      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        duration_ms: 100,
        result: '   ',
      } as never);

      expect(callbacks.onChunk).not.toHaveBeenCalled();
    });

    it('should not set querySucceeded on non-success', async () => {
      await handler.handleMessage({
        type: 'result',
        subtype: 'error',
        num_turns: 0,
        duration_ms: 50,
      } as never);

      expect(handler.didQuerySucceed()).toBe(false);
    });

    it('should emit usage update with token counts', async () => {
      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        num_turns: 3,
        duration_ms: 5000,
        total_cost_usd: 0.05,
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
        },
      } as never);

      expect(callbacks.onUsageUpdate).toHaveBeenCalledWith(expect.objectContaining({
        totalCostUSD: 0.05,
        numTurns: 3,
        durationMs: 5000,
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 200,
          cacheCreationInputTokens: 100,
        },
      }));
    });

    it('should emit usage update with model-specific usage', async () => {
      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        duration_ms: 1000,
        total_cost_usd: 0.02,
        usage: {
          input_tokens: 500,
          output_tokens: 200,
        },
        modelUsage: {
          'claude-3-opus': {
            inputTokens: 500,
            outputTokens: 200,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.02,
            contextWindow: 200000,
            maxOutputTokens: 4096,
          },
        },
      } as never);

      expect(callbacks.onUsageUpdate).toHaveBeenCalledWith(expect.objectContaining({
        modelUsage: {
          'claude-3-opus': expect.objectContaining({
            inputTokens: 500,
            outputTokens: 200,
            contextWindow: 200000,
            maxOutputTokens: 4096,
            costUSD: 0.02,
          }),
        },
      }));
    });

    it('should emit usage update on error results too', async () => {
      await handler.handleMessage({
        type: 'result',
        subtype: 'error',
        num_turns: 1,
        duration_ms: 500,
        total_cost_usd: 0.01,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
      } as never);

      expect(callbacks.onUsageUpdate).toHaveBeenCalledWith(expect.objectContaining({
        totalCostUSD: 0.01,
        usage: expect.objectContaining({
          inputTokens: 100,
          outputTokens: 50,
        }),
      }));
    });
  });

  // ===========================================================================
  // Auth Error Detection (onAuthError callback)
  // ===========================================================================
  describe('auth error detection', () => {
    let handlerWithAuth: SDKMessageHandler;
    let authCallbacks: MessageHandlerCallbacks;

    beforeEach(() => {
      authCallbacks = {
        onChunk: vi.fn(),
        onSlashCommands: vi.fn(),
        onTaskNotification: vi.fn(),
        onUsageUpdate: vi.fn(),
        onSystemNote: vi.fn(),
        onAuthError: vi.fn(),
      };
      handlerWithAuth = new SDKMessageHandler(authCallbacks);
    });

    // Assistant text is model output, not an API signal — the model can legitimately
    // discuss 401s, tokens, auth failures (security audits, code review, docs). Scanning
    // it for keywords produced catastrophic false positives that killed live sessions.
    // Only SDK-emitted result errors are trusted as auth signals.
    it('should NOT fire onAuthError when assistant text mentions auth keywords', async () => {
      const authy = [
        'Failed to authenticate. API Error: 401 Invalid bearer token',
        'Request failed: Unauthorized access',
        'Error: invalid bearer token provided',
        'Authentication failed: invalid token',
        "script emits KEY_NOT_FOUND and would return Unauthorized on the API",
      ];
      for (const text of authy) {
        await handlerWithAuth.handleMessage({
          type: 'assistant',
          message: { content: [{ type: 'text', text }] },
        } as never);
      }

      expect(authCallbacks.onAuthError).not.toHaveBeenCalled();
    });

    it('should NOT fire onAuthError for normal messages', async () => {
      await handlerWithAuth.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Here is the code you requested.' }] },
      } as never);

      expect(authCallbacks.onAuthError).not.toHaveBeenCalled();
    });

    it('should fire onAuthError on error result with 401', async () => {
      await handlerWithAuth.handleMessage({
        type: 'result',
        subtype: 'error',
        error: 'API returned 401 unauthorized',
        num_turns: 0,
        duration_ms: 0,
      } as never);

      expect(authCallbacks.onAuthError).toHaveBeenCalledTimes(1);
    });

    it('should fire onAuthError on error result with invalid bearer', async () => {
      await handlerWithAuth.handleMessage({
        type: 'result',
        subtype: 'error',
        error: 'Failed: invalid bearer token',
        num_turns: 0,
        duration_ms: 0,
      } as never);

      expect(authCallbacks.onAuthError).toHaveBeenCalledTimes(1);
    });

    it('should NOT fire onAuthError on non-auth error results', async () => {
      await handlerWithAuth.handleMessage({
        type: 'result',
        subtype: 'error',
        error: 'Rate limit exceeded',
        num_turns: 0,
        duration_ms: 0,
      } as never);

      expect(authCallbacks.onAuthError).not.toHaveBeenCalled();
    });

    it('should not crash when onAuthError is not provided', async () => {
      // handler (without onAuthError) should not throw on an auth-flagged result
      await expect(handler.handleMessage({
        type: 'result',
        subtype: 'error',
        error: 'API returned 401 unauthorized',
        num_turns: 0,
        duration_ms: 0,
      } as never)).resolves.not.toThrow();
    });
  });

  describe('native task lifecycle messages', () => {
    it('should emit running notification for task_started', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-abc',
        description: 'Running unit tests',
        task_type: 'agent',
      } as never);

      expect(callbacks.onTaskNotification).toHaveBeenCalledWith({
        taskId: 'task-abc',
        status: 'running',
        description: 'Running unit tests',
      });
    });

    it('should skip task_started with skip_transcript flag', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-silent',
        description: 'Ambient task',
        skip_transcript: true,
      } as never);

      expect(callbacks.onTaskNotification).not.toHaveBeenCalled();
    });

    it('should emit progress notification for task_progress', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'task_progress',
        task_id: 'task-abc',
        description: 'Running tests',
        summary: 'Analyzing authentication module',
        last_tool_name: 'Bash',
      } as never);

      expect(callbacks.onTaskNotification).toHaveBeenCalledWith({
        taskId: 'task-abc',
        status: 'running',
        description: 'Running tests',
        summary: 'Analyzing authentication module',
      });
    });

    it('should emit completion for task_updated with completed status', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-abc',
        patch: { status: 'completed', description: 'Tests passed' },
      } as never);

      expect(callbacks.onTaskNotification).toHaveBeenCalledWith({
        taskId: 'task-abc',
        status: 'completed',
        description: 'Tests passed',
      });
    });

    it('should emit failure for task_updated with failed status and error', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-abc',
        patch: { status: 'failed', error: 'Timeout exceeded' },
      } as never);

      expect(callbacks.onTaskNotification).toHaveBeenCalledWith({
        taskId: 'task-abc',
        status: 'failed',
        error: 'Timeout exceeded',
      });
    });

    it('should map killed status to stopped', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-abc',
        patch: { status: 'killed' },
      } as never);

      expect(callbacks.onTaskNotification).toHaveBeenCalledWith({
        taskId: 'task-abc',
        status: 'stopped',
      });
    });

    it('should ignore task_updated with pending status', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-abc',
        patch: { status: 'pending' },
      } as never);

      expect(callbacks.onTaskNotification).not.toHaveBeenCalled();
    });

    it('should not emit task notification for session_state_changed', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        uuid: 'uuid-123',
        session_id: 'sess-123',
      } as never);

      expect(callbacks.onTaskNotification).not.toHaveBeenCalled();
    });
  });

  describe('resolveResultError', () => {
    it('extracts the canonical errors[] array used by SDKResultError', () => {
      expect(resolveResultError({ errors: ['No conversation found with session ID abc'] }))
        .toBe('No conversation found with session ID abc');
    });

    it('joins multiple errors with "; "', () => {
      expect(resolveResultError({ errors: ['first failure', 'second failure'] }))
        .toBe('first failure; second failure');
    });

    it('skips non-string entries when joining', () => {
      expect(resolveResultError({ errors: ['a', 42 as unknown as string, 'b'] }))
        .toBe('a; b');
    });

    it('falls back to legacy singular `error` when errors[] is missing', () => {
      expect(resolveResultError({ error: 'something broke' }))
        .toBe('something broke');
    });

    it('returns empty string when neither errors nor error is set', () => {
      expect(resolveResultError({})).toBe('');
    });

    it('prefers errors[] over error when both are present', () => {
      expect(resolveResultError({ errors: ['new shape'], error: 'old shape' }))
        .toBe('new shape');
    });

    it('returns empty string for empty errors[] array', () => {
      expect(resolveResultError({ errors: [] })).toBe('');
    });
  });

  describe('extractTaskCreateId', () => {
    it('extracts task.id from a structured object', () => {
      expect(extractTaskCreateId({ task: { id: 'task-abc', subject: 'x' } })).toBe('task-abc');
    });

    it('extracts task.id from a JSON string', () => {
      expect(extractTaskCreateId('{"task":{"id":"7","subject":"x"}}')).toBe('7');
    });

    it('extracts task.id from an array of text blocks whose joined text is JSON', () => {
      expect(extractTaskCreateId([{ type: 'text', text: '{"task":{"id":"9"}}' }])).toBe('9');
    });

    it('extracts the ID from the CLI human-readable text form', () => {
      // This is the shape the CLI actually delivers today — the JSON extraction
      // above never matches, so this fallback is what keeps TaskUpdate wiring intact.
      expect(extractTaskCreateId('Task #3 created successfully: Audit Entra script'))
        .toBe('3');
    });

    it('extracts the ID from human-readable text wrapped in a text block', () => {
      expect(extractTaskCreateId([{ type: 'text', text: 'Task #42 created successfully: something' }]))
        .toBe('42');
    });

    it('returns undefined when neither JSON nor the text pattern is present', () => {
      expect(extractTaskCreateId('Some unrelated tool output')).toBeUndefined();
    });

    it('returns undefined for empty content', () => {
      expect(extractTaskCreateId('')).toBeUndefined();
      expect(extractTaskCreateId(null)).toBeUndefined();
      expect(extractTaskCreateId(undefined)).toBeUndefined();
    });
  });
});
