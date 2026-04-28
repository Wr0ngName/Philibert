/**
 * Comprehensive tests for PermissionManager.
 *
 * Tests cover:
 * - Permission suggestion parsing (describePermissionSuggestions via public API)
 * - Scope mapping (SDK destinations → session/project/global)
 * - Label generation for different scopes and tool counts
 * - Directory-based suggestions
 * - Mixed suggestions with multiple scopes
 * - Edge cases (no suggestions, empty arrays, etc.)
 */

import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { PendingAction } from '../../../../shared/types';
import { PermissionManager } from '../PermissionManager';
import { SessionPermissionCache } from '../SessionPermissionCache';

// Mock logger
vi.mock('../../../utils/logger', () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('PermissionManager', () => {
  let permissionManager: PermissionManager;
  let mockConfigService: any;
  let capturedAction: PendingAction | null;
  let emitToolUse: (action: PendingAction) => void;

  beforeEach(() => {
    // Reset captured action
    capturedAction = null;

    // Mock ConfigService
    mockConfigService = {
      getConfig: vi.fn().mockResolvedValue({
        autoApproveReads: false,
      }),
    };

    // Tool use emitter that captures the action
    emitToolUse = (action: PendingAction) => {
      capturedAction = action;
    };

    // Create PermissionManager instance
    permissionManager = new PermissionManager(mockConfigService, emitToolUse);
  });

  describe('describePermissionSuggestions (via public API)', () => {
    it('should return undefined permissionInfo when no suggestions provided', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      // Call without suggestions
      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions: undefined,
      });

      // Wait for next tick to allow action to be emitted
      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toBeUndefined();
    });

    it('should return undefined permissionInfo when suggestions array is empty', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      // Call with empty suggestions array
      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions: [],
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toBeUndefined();
    });

    it('should create session-scoped label for session destination', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Allow Bash this session',
        description: 'Allow Bash for this session',
        scope: 'session',
        scopeOptions: [{ scope: 'session', label: 'Allow Bash this session', description: 'Allow Bash for this session' }],
      });
    });

    it('should create session-scoped label for cliArg destination', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'cliArg',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Allow Bash this session',
        description: 'Allow Bash for this session',
        scope: 'session',
        scopeOptions: [{ scope: 'session', label: 'Allow Bash this session', description: 'Allow Bash for this session' }],
      });
    });

    it('should create project-scoped label for projectSettings destination', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'projectSettings',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Allow Bash in this project',
        description: 'Allow Bash for this project',
        scope: 'project',
        scopeOptions: [{ scope: 'project', label: 'Allow Bash in project', description: 'Allow Bash for this project' }],
      });
    });

    it('should create project-scoped label for localSettings destination', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Allow Bash in this project',
        description: 'Allow Bash for this project',
        scope: 'project',
        scopeOptions: [{ scope: 'project', label: 'Allow Bash in project', description: 'Allow Bash for this project' }],
      });
    });

    it('should create global-scoped label for userSettings destination', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'userSettings',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Always allow Bash',
        description: 'Allow Bash globally',
        scope: 'global',
        scopeOptions: [{ scope: 'global', label: 'Always allow Bash', description: 'Allow Bash globally' }],
      });
    });

    it('should handle multiple tools in rules with count label', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [
            { toolName: 'Bash' },
            { toolName: 'Read' },
          ],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo?.alwaysAllowLabel).toBe('Allow 2 tools this session');
      expect(capturedAction?.permissionInfo?.scope).toBe('session');
    });

    it('should handle multiple tools across multiple rules', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
        {
          type: 'addRules',
          rules: [{ toolName: 'Read' }, { toolName: 'Write' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo?.alwaysAllowLabel).toBe('Allow 3 tools this session');
      expect(capturedAction?.permissionInfo?.scope).toBe('session');
    });

    it('should include directory info in description for addDirectories', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addDirectories',
          directories: ['/home/user/project', '/home/user/data'],
          destination: 'session',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo?.description).toContain('/home/user/project');
      expect(capturedAction?.permissionInfo?.description).toContain('/home/user/data');
      expect(capturedAction?.permissionInfo?.description).toContain('Add directories');
    });

    it('should use broadest scope when multiple scopes present', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      // Mix of session, project, and global scopes - global should win
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
        {
          type: 'addRules',
          rules: [{ toolName: 'Read' }],
          behavior: 'allow',
          destination: 'projectSettings',
        },
        {
          type: 'addRules',
          rules: [{ toolName: 'Write' }],
          behavior: 'allow',
          destination: 'userSettings',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo?.scope).toBe('global');
      expect(capturedAction?.permissionInfo?.alwaysAllowLabel).toBe('Always allow 3 tools');
    });

    it('should prefer project scope over session scope', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
        {
          type: 'addRules',
          rules: [{ toolName: 'Read' }],
          behavior: 'allow',
          destination: 'projectSettings',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo?.scope).toBe('project');
      expect(capturedAction?.permissionInfo?.alwaysAllowLabel).toBe('Allow 2 tools in this project');
    });

    it('should combine multiple suggestion descriptions', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
        {
          type: 'addDirectories',
          directories: ['/home/user/project'],
          destination: 'session',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      const description = capturedAction?.permissionInfo?.description || '';
      expect(description).toContain('Allow Bash');
      expect(description).toContain('Add directories');
      expect(description).toContain(';'); // Multiple descriptions joined with semicolon
    });

    it('should use requesting tool name when no tools in rules', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      // addDirectories doesn't have rules, so should fall back to requesting tool name
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addDirectories',
          directories: ['/home/user/project'],
          destination: 'session',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo?.alwaysAllowLabel).toBe('Allow Bash this session');
    });

    it('should handle rules with ruleContent field', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [
            {
              toolName: 'Bash',
              ruleContent: 'command contains "git"',
            },
          ],
          behavior: 'allow',
          destination: 'projectSettings',
        },
      ];

      canUseTool('Bash', { command: 'git status' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Allow Bash in this project',
        description: 'Allow Bash (command contains "git") for this project',
        scope: 'project',
        scopeOptions: [{ scope: 'project', label: 'Allow Bash (command contains "git") in project', description: 'Allow Bash (command contains "git") for this project' }],
      });
    });

    it('should include directory paths in scope option label for addDirectories', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addDirectories',
          directories: ['/home/user/project'],
          destination: 'session',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      // Scope option label should include the directory path
      expect(capturedAction?.permissionInfo?.scopeOptions[0].label).toBe(
        'Allow Bash (/home/user/project) this session'
      );
    });

    it('should show directory count when many directories in addDirectories', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addDirectories',
          directories: ['/home/a', '/home/b', '/home/c'],
          destination: 'projectSettings',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      // With 3+ directories, should show count instead of listing all
      expect(capturedAction?.permissionInfo?.scopeOptions[0].label).toBe(
        'Allow Bash (3 directories) in project'
      );
    });

    it('should handle deny behavior suggestions', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'deny', // Note: deny instead of allow
          destination: 'session',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      // Should still create permissionInfo (SDK provides it, we display it)
      expect(capturedAction?.permissionInfo).toBeDefined();
      expect(capturedAction?.permissionInfo?.scope).toBe('session');
    });
  });

  describe('permissionContext (blockedPath and decisionReason)', () => {
    it('should include blockedPath when provided by SDK', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      canUseTool('Bash', { command: 'cat /etc/passwd' }, {
        signal,
        toolUseID: 'test-id',
        suggestions: undefined,
        blockedPath: '/etc/passwd',
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionContext).toEqual({
        blockedPath: '/etc/passwd',
        decisionReason: undefined,
      });
    });

    it('should include decisionReason when provided by SDK', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      canUseTool('Bash', { command: 'cat /etc/passwd' }, {
        signal,
        toolUseID: 'test-id',
        suggestions: undefined,
        decisionReason: 'Bash command tries to access a path outside allowed directories',
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionContext).toEqual({
        blockedPath: undefined,
        decisionReason: 'Bash command tries to access a path outside allowed directories',
      });
    });

    it('should include both blockedPath and decisionReason', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      canUseTool('Write', { file_path: '/etc/config', content: 'data' }, {
        signal,
        toolUseID: 'test-id',
        suggestions: [
          {
            type: 'addDirectories',
            directories: ['/etc'],
            destination: 'session',
          },
        ],
        blockedPath: '/etc/config',
        decisionReason: 'Write path is outside allowed directories',
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionContext).toEqual({
        blockedPath: '/etc/config',
        decisionReason: 'Write path is outside allowed directories',
      });
    });

    it('should not include permissionContext when neither blockedPath nor decisionReason provided', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions: undefined,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionContext).toBeUndefined();
    });
  });

  describe('integration with action creation', () => {
    it('should include permissionInfo in Bash action', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'projectSettings',
        },
      ];

      canUseTool('Bash', { command: 'ls -la' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.type).toBe('bash-command');
      expect(capturedAction?.toolName).toBe('Bash');
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Allow Bash in this project',
        description: 'Allow Bash for this project',
        scope: 'project',
        scopeOptions: [{ scope: 'project', label: 'Allow Bash in project', description: 'Allow Bash for this project' }],
      });
    });

    it('should include permissionInfo in Write action', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Write' }],
          behavior: 'allow',
          destination: 'userSettings',
        },
      ];

      canUseTool('Write', { file_path: '/test.txt', content: 'hello' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.type).toBe('file-create');
      expect(capturedAction?.toolName).toBe('Write');
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Always allow Write',
        description: 'Allow Write globally',
        scope: 'global',
        scopeOptions: [{ scope: 'global', label: 'Always allow Write', description: 'Allow Write globally' }],
      });
    });

    it('should include permissionInfo in Edit action', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Edit' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      canUseTool('Edit', {
        file_path: '/test.txt',
        old_string: 'old',
        new_string: 'new',
      }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.type).toBe('file-edit');
      expect(capturedAction?.toolName).toBe('Edit');
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Allow Edit this session',
        description: 'Allow Edit for this session',
        scope: 'session',
        scopeOptions: [{ scope: 'session', label: 'Allow Edit this session', description: 'Allow Edit for this session' }],
      });
    });

    it('should not include permissionInfo when auto-approving reads', async () => {
      // Configure auto-approve for reads
      mockConfigService.getConfig.mockResolvedValue({
        autoApproveReads: true,
      });

      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Read' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      const result = await canUseTool('Read', { file_path: '/test.txt' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      // Should auto-approve without emitting action
      expect(result.behavior).toBe('allow');
      expect(capturedAction).toBeNull(); // No action emitted
    });
  });

  describe('edge cases', () => {
    it('should handle empty rules array', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      // Should fall back to requesting tool name
      expect(capturedAction?.permissionInfo?.alwaysAllowLabel).toBe('Allow Bash this session');
    });

    it('should handle empty directories array', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addDirectories',
          directories: [],
          destination: 'session',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toBeDefined();
      expect(capturedAction?.permissionInfo?.description).toContain('Add directories');
    });

    it('should deduplicate tool names across suggestions', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }], // Duplicate
          behavior: 'allow',
          destination: 'session',
        },
      ];

      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      // Should show single tool, not "2 tools"
      expect(capturedAction?.permissionInfo?.alwaysAllowLabel).toBe('Allow Bash this session');
    });
  });

  describe('session permission cache integration', () => {
    it('should auto-approve when tool is in session cache (no emit to renderer)', async () => {
      // Create real SessionPermissionCache
      const cache = new SessionPermissionCache();
      const conversationId = 'conv-1';

      // Pre-populate cache with Bash permission
      cache.addPermissions(conversationId, [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
      ]);

      // Create PermissionManager with cache
      const permissionManager = new PermissionManager(
        mockConfigService,
        emitToolUse,
        cache,
        conversationId,
      );

      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      // Call canUseTool for Bash - should auto-approve from cache
      const result = await canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        suggestions: undefined,
      });

      // Should allow immediately without emitting action
      expect(result.behavior).toBe('allow');
      expect(capturedAction).toBeNull(); // No action emitted
    });

    it('should prompt user when tool is NOT in cache', async () => {
      const cache = new SessionPermissionCache();
      const conversationId = 'conv-1';

      // Pre-populate cache with Bash only
      cache.addPermissions(conversationId, [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
      ]);

      const permissionManager = new PermissionManager(
        mockConfigService,
        emitToolUse,
        cache,
        conversationId,
      );

      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      // Request Write tool - not in cache
      canUseTool('Write', { file_path: '/test.txt', content: 'hello' }, {
        signal,
        toolUseID: 'test-id',
        suggestions: undefined,
      });

      await new Promise(resolve => setImmediate(resolve));

      // Should emit action (prompt user)
      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.toolName).toBe('Write');
    });

    it('should cache session permission when user clicks always allow', async () => {
      const cache = new SessionPermissionCache();
      const conversationId = 'conv-1';

      const permissionManager = new PermissionManager(
        mockConfigService,
        emitToolUse,
        cache,
        conversationId,
      );

      const canUseTool = permissionManager.createCanUseToolCallback();
      const abortController = new AbortController();

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      // Call canUseTool (don't await - it returns pending promise)
      const promise = canUseTool('Bash', { command: 'ls' }, {
        signal: abortController.signal,
        toolUseID: 'test-id',
        suggestions,
      });

      // Wait for action to be emitted
      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      const actionId = capturedAction!.id;

      // User approves with alwaysAllow
      permissionManager.handleActionResponse({
        conversationId,
        actionId,
        approved: true,
        alwaysAllow: true,
      });

      // Wait for promise to resolve
      const result = await promise;

      expect(result.behavior).toBe('allow');

      // Verify cache now has the permission
      expect(cache.isAllowed(conversationId, 'Bash', {})).toBe(true);
    });

    it('should NOT cache when alwaysAllow is false', async () => {
      const cache = new SessionPermissionCache();
      const conversationId = 'conv-1';

      const permissionManager = new PermissionManager(
        mockConfigService,
        emitToolUse,
        cache,
        conversationId,
      );

      const canUseTool = permissionManager.createCanUseToolCallback();
      const abortController = new AbortController();

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      const promise = canUseTool('Bash', { command: 'ls' }, {
        signal: abortController.signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      const actionId = capturedAction!.id;

      // User approves WITHOUT alwaysAllow
      permissionManager.handleActionResponse({
        conversationId,
        actionId,
        approved: true,
        alwaysAllow: false,
      });

      await promise;

      // Cache should NOT have permission
      expect(cache.isAllowed(conversationId, 'Bash', {})).toBe(false);
    });

    it('should NOT cache when alwaysAllow is undefined', async () => {
      const cache = new SessionPermissionCache();
      const conversationId = 'conv-1';

      const permissionManager = new PermissionManager(
        mockConfigService,
        emitToolUse,
        cache,
        conversationId,
      );

      const canUseTool = permissionManager.createCanUseToolCallback();
      const abortController = new AbortController();

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      const promise = canUseTool('Bash', { command: 'ls' }, {
        signal: abortController.signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      const actionId = capturedAction!.id;

      // User approves WITHOUT alwaysAllow field
      permissionManager.handleActionResponse({
        conversationId,
        actionId,
        approved: true,
      });

      await promise;

      // Cache should NOT have permission
      expect(cache.isAllowed(conversationId, 'Bash', {})).toBe(false);
    });

    it('should NOT cache non-session (project/global) permissions', async () => {
      const cache = new SessionPermissionCache();
      const conversationId = 'conv-1';

      const permissionManager = new PermissionManager(
        mockConfigService,
        emitToolUse,
        cache,
        conversationId,
      );

      const canUseTool = permissionManager.createCanUseToolCallback();
      const abortController = new AbortController();

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'projectSettings', // Project scope, not session
        },
      ];

      const promise = canUseTool('Bash', { command: 'ls' }, {
        signal: abortController.signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      const actionId = capturedAction!.id;

      // User approves with alwaysAllow
      permissionManager.handleActionResponse({
        conversationId,
        actionId,
        approved: true,
        alwaysAllow: true,
      });

      const result = await promise;

      // Permission should be approved for this request
      expect(result.behavior).toBe('allow');

      // But cache should NOT have permission (SessionPermissionCache filters project/global)
      expect(cache.isAllowed(conversationId, 'Bash', {})).toBe(false);
    });

    it('should auto-resolve other pending permissions after always-allow updates cache', async () => {
      const cache = new SessionPermissionCache();
      const conversationId = 'conv-1';
      const capturedActions: PendingAction[] = [];
      const executedActionIds: string[] = [];

      const pm = new PermissionManager(
        mockConfigService,
        (action: PendingAction) => { capturedActions.push(action); },
        cache,
        conversationId,
        (actionId: string) => { executedActionIds.push(actionId); },
      );

      const canUseTool = pm.createCanUseToolCallback();
      const abortController = new AbortController();

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      // Create 3 pending Bash permission requests (simulating batched tool calls)
      const promise1 = canUseTool('Bash', { command: 'ls' }, {
        signal: abortController.signal,
        toolUseID: 'id-1',
        suggestions,
      });
      const promise2 = canUseTool('Bash', { command: 'pwd' }, {
        signal: abortController.signal,
        toolUseID: 'id-2',
        suggestions,
      });
      const promise3 = canUseTool('Bash', { command: 'date' }, {
        signal: abortController.signal,
        toolUseID: 'id-3',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedActions).toHaveLength(3);
      expect(pm.getPendingCount()).toBe(3);

      // User approves first with alwaysAllow
      pm.handleActionResponse({
        conversationId,
        actionId: capturedActions[0].id,
        approved: true,
        alwaysAllow: true,
      });

      // All three should resolve
      const [result1, result2, result3] = await Promise.all([promise1, promise2, promise3]);

      expect(result1.behavior).toBe('allow');
      expect(result2.behavior).toBe('allow');
      expect(result3.behavior).toBe('allow');
      expect(pm.getPendingCount()).toBe(0);

      // Auto-resolved actions should emit toolExecuted for UI update
      expect(executedActionIds).toContain(capturedActions[1].id);
      expect(executedActionIds).toContain(capturedActions[2].id);
    });

    it('should NOT auto-resolve pending permissions for different tools', async () => {
      const cache = new SessionPermissionCache();
      const conversationId = 'conv-1';
      const capturedActions: PendingAction[] = [];

      const pm = new PermissionManager(
        mockConfigService,
        (action: PendingAction) => { capturedActions.push(action); },
        cache,
        conversationId,
      );

      const canUseTool = pm.createCanUseToolCallback();
      const abortController = new AbortController();

      const bashSuggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      // Create pending Bash and Write permissions
      canUseTool('Bash', { command: 'ls' }, {
        signal: abortController.signal,
        toolUseID: 'id-1',
        suggestions: bashSuggestions,
      });
      canUseTool('Write', { file_path: '/test.txt', content: 'hi' }, {
        signal: abortController.signal,
        toolUseID: 'id-2',
        suggestions: undefined,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedActions).toHaveLength(2);

      // Approve Bash with alwaysAllow
      pm.handleActionResponse({
        conversationId,
        actionId: capturedActions[0].id,
        approved: true,
        alwaysAllow: true,
      });

      // Write should still be pending (different tool)
      expect(pm.getPendingCount()).toBe(1);
    });

    it('should work without cache (backward compatibility)', async () => {
      // Create PermissionManager without cache args
      const permissionManager = new PermissionManager(
        mockConfigService,
        emitToolUse,
        // No cache or conversationId
      );

      const canUseTool = permissionManager.createCanUseToolCallback();
      const abortController = new AbortController();

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      // Should work normally - emit action
      const promise = canUseTool('Bash', { command: 'ls' }, {
        signal: abortController.signal,
        toolUseID: 'test-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      const actionId = capturedAction!.id;

      // User approves with alwaysAllow
      permissionManager.handleActionResponse({
        conversationId: 'any-conv',
        actionId,
        approved: true,
        alwaysAllow: true,
      });

      const result = await promise;

      // Should approve normally
      expect(result.behavior).toBe('allow');
      // No errors - everything works without cache
    });
  });
});
