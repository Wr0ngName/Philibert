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

import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { PendingAction } from '../../../../shared/types';
import { PermissionManager, comparablePath } from '../PermissionManager';
import { SessionPermissionCache } from '../SessionPermissionCache';

describe('comparablePath', () => {
  it('reads a CLI rule path and the tool path it covers alike', () => {
    expect(comparablePath('//c/Users/k/tasks/**')).toBe('/c/Users/k/tasks');
    expect(comparablePath('C:\\Users\\k\\tasks\\a.output')).toBe('/c/Users/k/tasks/a.output');
    expect(comparablePath('c:/Users/k/tasks/')).toBe('/c/Users/k/tasks');
    expect(comparablePath('//home/k/project/*')).toBe('/home/k/project');
    expect(comparablePath('/home/k/project/a.ts')).toBe('/home/k/project/a.ts');
  });
});

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
    it('should return synthetic session scope when no suggestions provided', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      // Call without suggestions
      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        requestId: 'test-request-id',
        suggestions: undefined,
      });

      // Wait for next tick to allow action to be emitted
      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Allow Bash this session',
        description: 'Allow Bash for this session',
        scope: 'session',
        scopeOptions: [
          { scope: 'session', label: 'Allow Bash this session', description: 'Allow Bash for this session' },
        ],
      });
    });

    it('should return synthetic session scope when suggestions array is empty', async () => {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const signal = new AbortController().signal;

      // Call with empty suggestions array
      canUseTool('Bash', { command: 'ls' }, {
        signal,
        toolUseID: 'test-id',
        requestId: 'test-request-id',
        suggestions: [],
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Allow Bash this session',
        description: 'Allow Bash for this session',
        scope: 'session',
        scopeOptions: [
          { scope: 'session', label: 'Allow Bash this session', description: 'Allow Bash for this session' },
        ],
      });
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
        requestId: 'test-request-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Allow Bash in this project',
        description: 'Allow Bash for this session; Allow Bash for this project',
        scope: 'project',
        scopeOptions: [
          { scope: 'session', label: 'Allow Bash this session', description: 'Allow Bash for this session' },
          { scope: 'project', label: 'Allow Bash in project', description: 'Allow Bash for this project' },
        ],
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
        requestId: 'test-request-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Allow Bash in this project',
        description: 'Allow Bash for this session; Allow Bash for this project',
        scope: 'project',
        scopeOptions: [
          { scope: 'session', label: 'Allow Bash this session', description: 'Allow Bash for this session' },
          { scope: 'project', label: 'Allow Bash in project', description: 'Allow Bash for this project' },
        ],
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
        requestId: 'test-request-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Allow Bash in this project',
        description: 'Allow Bash for this project',
        scope: 'project',
        scopeOptions: [
          { scope: 'session', label: 'Allow Bash this session', description: 'Allow Bash for this session' },
          { scope: 'project', label: 'Allow Bash in project', description: 'Allow Bash for this project' },
        ],
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
        requestId: 'test-request-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Allow Bash in this project',
        description: 'Allow Bash for this project',
        scope: 'project',
        scopeOptions: [
          { scope: 'session', label: 'Allow Bash this session', description: 'Allow Bash for this session' },
          { scope: 'project', label: 'Allow Bash in project', description: 'Allow Bash for this project' },
        ],
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
        requestId: 'test-request-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Always allow Bash',
        description: 'Allow Bash globally',
        scope: 'global',
        scopeOptions: [
          { scope: 'session', label: 'Allow Bash this session', description: 'Allow Bash for this session' },
          { scope: 'global', label: 'Always allow Bash', description: 'Allow Bash globally' },
        ],
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
        requestId: 'test-request-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo?.scopeOptions[0]?.label).toBe('Allow 2 tools this session');
      expect(capturedAction?.permissionInfo?.alwaysAllowLabel).toBe('Allow 2 tools in this project');
      expect(capturedAction?.permissionInfo?.scope).toBe('project');
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
        requestId: 'test-request-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo?.scopeOptions[0]?.label).toBe('Allow 3 tools this session');
      expect(capturedAction?.permissionInfo?.alwaysAllowLabel).toBe('Allow 3 tools in this project');
      expect(capturedAction?.permissionInfo?.scope).toBe('project');
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
        requestId: 'test-request-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      // Named short: the full paths make the lines as wide as the paths.
      expect(capturedAction?.permissionInfo?.description).toContain('Add directories: …/project, …/data');
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
        requestId: 'test-request-id',
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
        requestId: 'test-request-id',
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
        requestId: 'test-request-id',
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
        requestId: 'test-request-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo?.scopeOptions.map(o => o.label)).toEqual([
        'Allow Bash (…/project) this session',
        'Allow Bash (…/project) in project',
      ]);
      expect(capturedAction?.permissionInfo?.alwaysAllowLabel).toBe('Allow Bash in this project');
    });

    it('grants the whole tool in project, as "this session" does, whatever narrower rule the CLI suggested', async () => {
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
        requestId: 'test-request-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Allow Bash in this project',
        description: 'Allow Bash for this project',
        scope: 'project',
        scopeOptions: [
          { scope: 'session', label: 'Allow Bash this session', description: 'Allow Bash for this session' },
          { scope: 'project', label: 'Allow Bash in project', description: 'Allow Bash for this project' },
          // The CLI's own narrower rule stays available as a second choice.
          { scope: 'project', variant: 'narrow', label: 'Allow Bash (command contains "git") in project', description: 'Allow only Bash (command contains "git") for this project' },
        ],
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
        requestId: 'test-request-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      // Scope option label should include the directory path
      expect(capturedAction?.permissionInfo?.scopeOptions[0].label).toBe(
        'Allow Bash (…/project) this session'
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
        requestId: 'test-request-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      // With 3+ directories, should show count instead of listing all
      // scopeOptions[0] is the synthetic session option, [1] is the project option from SDK
      const projectOption = capturedAction?.permissionInfo?.scopeOptions.find(o => o.scope === 'project');
      expect(projectOption?.label).toBe(
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
        requestId: 'test-request-id',
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
        requestId: 'test-request-id',
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
        requestId: 'test-request-id',
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
        requestId: 'test-request-id',
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
        requestId: 'test-request-id',
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
        requestId: 'test-request-id',
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
        scopeOptions: [
          { scope: 'session', label: 'Allow Bash this session', description: 'Allow Bash for this session' },
          { scope: 'project', label: 'Allow Bash in project', description: 'Allow Bash for this project' },
        ],
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
        requestId: 'test-request-id',
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
        scopeOptions: [
          { scope: 'session', label: 'Allow Write this session', description: 'Allow Write for this session' },
          { scope: 'global', label: 'Always allow Write', description: 'Allow Write globally' },
        ],
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
        requestId: 'test-request-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.type).toBe('file-edit');
      expect(capturedAction?.toolName).toBe('Edit');
      expect(capturedAction?.permissionInfo).toEqual({
        alwaysAllowLabel: 'Allow Edit in this project',
        description: 'Allow Edit for this session; Allow Edit for this project',
        scope: 'project',
        scopeOptions: [
          { scope: 'session', label: 'Allow Edit this session', description: 'Allow Edit for this session' },
          { scope: 'project', label: 'Allow Edit in project', description: 'Allow Edit for this project' },
        ],
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
        requestId: 'test-request-id',
        suggestions,
      });

      // Should auto-approve without emitting action
      expect(result!.behavior).toBe('allow');
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
        requestId: 'test-request-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      // Should fall back to requesting tool name
      expect(capturedAction?.permissionInfo?.alwaysAllowLabel).toBe('Allow Bash this session');
      // An empty rule list persists nothing, so it must not become a project option
      expect(capturedAction?.permissionInfo?.scopeOptions.map(o => o.scope)).toEqual(['session']);
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
        requestId: 'test-request-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction?.permissionInfo).toBeDefined();
      expect(capturedAction?.permissionInfo?.description).toContain('Add directories');
      expect(capturedAction?.permissionInfo?.scopeOptions.map(o => o.scope)).toEqual(['session']);
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
        requestId: 'test-request-id',
        suggestions,
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(capturedAction).not.toBeNull();
      // Should show single tool, not "2 tools"
      expect(capturedAction?.permissionInfo?.scopeOptions.map(o => o.label)).toEqual([
        'Allow Bash this session',
        'Allow Bash in project',
      ]);
    });
  });

  describe('project scope for session-only suggestions', () => {
    /** Raise a permission request, then approve it; returns the emitted action and the allow result. */
    async function requestAndApprove(
      toolName: string,
      input: Record<string, unknown>,
      suggestions: PermissionUpdate[] | undefined,
      chosenScope: 'session' | 'project',
    ): Promise<{ action: PendingAction; result: Extract<PermissionResult, { behavior: 'allow' }> }> {
      const canUseTool = permissionManager.createCanUseToolCallback();
      const pending = canUseTool(toolName, input, {
        signal: new AbortController().signal,
        toolUseID: 'test-id',
        requestId: 'test-request-id',
        suggestions,
      });
      await new Promise(resolve => setImmediate(resolve));
      const action = capturedAction!;
      permissionManager.handleActionResponse({
        actionId: action.id,
        conversationId: 'conv-1',
        approved: true,
        alwaysAllow: true,
        chosenScope,
      });
      const result = await pending;
      if (result?.behavior !== 'allow') {
        throw new Error(`Expected an allow result, got ${JSON.stringify(result)}`);
      }
      return { action, result };
    }

    // Shapes below are what the bundled CLI actually sent (scratch probe against SDK 0.3.280).
    const WRITE_SUGGESTIONS: PermissionUpdate[] = [
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ];
    const BASH_SUGGESTIONS: PermissionUpdate[] = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch probe-one.txt' }], behavior: 'allow', destination: 'localSettings' },
      { type: 'addDirectories', directories: ['/tmp/project'], destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ];

    it('offers a project option for a file edit whose only suggestion is acceptEdits', async () => {
      const { action } = await requestAndApprove('Write', { file_path: '/tmp/project/a.txt', content: 'x' }, WRITE_SUGGESTIONS, 'project');

      expect(action.permissionInfo?.scopeOptions).toEqual([
        { scope: 'session', label: 'Allow Write this session', description: 'Set mode: acceptEdits' },
        { scope: 'project', label: 'Allow Write in project', description: 'Allow Write for this project' },
      ]);
    });

    it('persists a rule for the requesting tool, not the mode, when project is chosen', async () => {
      const { result } = await requestAndApprove('Write', { file_path: '/tmp/project/a.txt', content: 'x' }, WRITE_SUGGESTIONS, 'project');

      const persisted = result.updatedPermissions?.filter(u => u.destination === 'localSettings');
      expect(persisted).toEqual([
        { type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'localSettings' },
      ]);
    });

    it('persists nothing to disk when session is chosen', async () => {
      const { result } = await requestAndApprove('Write', { file_path: '/tmp/project/a.txt', content: 'x' }, WRITE_SUGGESTIONS, 'session');

      const destinations = (result.updatedPermissions ?? []).map(u => u.destination);
      expect(destinations).not.toContain('localSettings');
    });

    it('clones a session rule and a session directory into localSettings', async () => {
      const suggestions: PermissionUpdate[] = [
        { type: 'addRules', rules: [{ toolName: 'WebSearch' }], behavior: 'allow', destination: 'session' },
        { type: 'addDirectories', directories: ['/tmp/other'], destination: 'session' },
      ];
      const { result } = await requestAndApprove('WebSearch', { query: 'x' }, suggestions, 'project');

      const persisted = result.updatedPermissions?.filter(u => u.destination === 'localSettings');
      expect(persisted).toEqual([
        { type: 'addRules', rules: [{ toolName: 'WebSearch' }], behavior: 'allow', destination: 'localSettings' },
        { type: 'addDirectories', directories: ['/tmp/other'], destination: 'localSettings' },
      ]);
    });

    // Reported (main.log, 2026-10-30): reading a task's output file outside
    // the project, the options read "Allow Read (//c/Users/kotik/AppData/…/
    // tasks/**) for this session" — the CLI's folder rule, as wide as the
    // path — while "this session" grants the whole tool.
    const TASK_FOLDER = '//c/Users/kotik/AppData/Local/Temp/philibert-cli/claude/C--Users-kotik-Documents-git-tmp/d75d29ae-0f62-4a9c-a82a-f45f5011d60f/tasks/**';
    const TASK_FILE = 'C:\\Users\\kotik\\AppData\\Local\\Temp\\philibert-cli\\claude\\C--Users-kotik-Documents-git-tmp\\d75d29ae-0f62-4a9c-a82a-f45f5011d60f\\tasks\\bcbety4d2.output';

    it('names "this session" after the whole tool it grants, not the folder the CLI suggested', async () => {
      const { action, result } = await requestAndApprove(
        'Read',
        { file_path: TASK_FILE },
        [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: TASK_FOLDER }], behavior: 'allow', destination: 'session' }],
        'session',
      );

      expect(action.permissionInfo?.scopeOptions).toEqual([
        { scope: 'session', label: 'Allow Read this session', description: 'Allow Read for this session' },
        { scope: 'project', label: 'Allow Read in project', description: 'Allow Read for this project' },
      ]);
      expect(result.updatedPermissions).toEqual([
        { type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow', destination: 'session' },
      ]);
    });

    it('names a path the CLI suggests for the project "this folder" or "this file", never in full', async () => {
      const folder = await requestAndApprove(
        'Read',
        { file_path: TASK_FILE },
        [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: TASK_FOLDER }], behavior: 'allow', destination: 'localSettings' }],
        'project',
      );
      expect(folder.action.permissionInfo?.scopeOptions.filter(o => o.variant === 'narrow')).toEqual([
        { scope: 'project', variant: 'narrow', label: 'Allow Read (this folder) in project', description: 'Allow only Read (this folder) for this project' },
      ]);

      const file = await requestAndApprove(
        'Edit',
        { file_path: '/home/user/project/src/a.ts' },
        [{ type: 'addRules', rules: [{ toolName: 'Edit', ruleContent: '//home/user/project/src/a.ts' }], behavior: 'allow', destination: 'localSettings' }],
        'project',
      );
      expect(file.action.permissionInfo?.scopeOptions.find(o => o.variant === 'narrow')?.label).toBe('Allow Edit (this file) in project');
    });

    it('replaces the exact command the CLI suggests for the project with the whole tool, as "this session" grants', async () => {
      const { action, result } = await requestAndApprove('Bash', { command: 'touch probe-one.txt' }, BASH_SUGGESTIONS, 'project');

      expect(action.permissionInfo?.scopeOptions.filter(o => o.scope === 'project').map(o => o.label)).toEqual([
        'Allow Bash (…/project) in project',
        'Allow this exact command in project',
      ]);
      expect(result.updatedPermissions?.filter(u => u.destination === 'localSettings')).toEqual([
        { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' },
        { type: 'addDirectories', directories: ['/tmp/project'], destination: 'localSettings' },
      ]);
    });

    it('offers "Allow PowerShell in project" for a one-off PowerShell pipeline (main.log, 2026-10-29)', async () => {
      // The CLI's project suggestion for it was the whole command line.
      const command = 'Get-ChildItem -Force | Select-Object Mode,Name,Length; Get-ChildItem -Directory | ForEach-Object { "--- $($_.Name)"; Get-ChildItem $_.FullName -Force | Select-Object -First 30 -ExpandProperty Name }';
      const { action, result } = await requestAndApprove(
        'PowerShell',
        { command, description: 'List working directory contents' },
        [{ type: 'addRules', rules: [{ toolName: 'PowerShell', ruleContent: command }], behavior: 'allow', destination: 'localSettings' }],
        'project',
      );

      // Short labels: the command is never repeated in a button.
      expect(action.permissionInfo?.scopeOptions).toEqual([
        { scope: 'session', label: 'Allow PowerShell this session', description: 'Allow PowerShell for this session' },
        { scope: 'project', label: 'Allow PowerShell in project', description: 'Allow PowerShell for this project' },
        { scope: 'project', variant: 'narrow', label: 'Allow this exact command in project', description: 'Allow only this exact command for this project' },
      ]);
      expect(result.updatedPermissions).toEqual([
        { type: 'addRules', rules: [{ toolName: 'PowerShell' }], behavior: 'allow', destination: 'localSettings' },
      ]);
    });

    it('persists only the exact command when "this exact command" is chosen', async () => {
      const command = 'git log --oneline -5';
      const narrow: PermissionUpdate = {
        type: 'addRules', rules: [{ toolName: 'PowerShell', ruleContent: command }], behavior: 'allow', destination: 'localSettings',
      };
      const canUseTool = permissionManager.createCanUseToolCallback();
      const pending = canUseTool('PowerShell', { command }, {
        signal: new AbortController().signal,
        toolUseID: 'test-id',
        requestId: 'test-request-id',
        suggestions: [narrow],
      });
      await new Promise(resolve => setImmediate(resolve));
      permissionManager.handleActionResponse({
        actionId: capturedAction!.id,
        conversationId: 'conv-1',
        approved: true,
        alwaysAllow: true,
        chosenScope: 'project',
        chosenVariant: 'narrow',
      });

      const result = await pending;
      expect(result).toMatchObject({ behavior: 'allow', updatedPermissions: [narrow] });
    });

    it('offers no project option when the SDK made no suggestion', async () => {
      const { action } = await requestAndApprove('Bash', { command: 'a && b' }, undefined, 'session');

      expect(action.permissionInfo?.scopeOptions.map(o => o.scope)).toEqual(['session']);
    });

    it('offers no project option for a mode that is not a file-edit grant', async () => {
      const { action } = await requestAndApprove(
        'ExitPlanMode',
        {},
        [{ type: 'setMode', mode: 'default', destination: 'session' }],
        'session',
      );

      expect(action.permissionInfo?.scopeOptions.map(o => o.scope)).toEqual(['session']);
    });

    it('does not turn a session deny rule into a project allow', async () => {
      const { action } = await requestAndApprove(
        'Bash',
        { command: 'ls' },
        [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' }],
        'session',
      );

      expect(action.permissionInfo?.scopeOptions.map(o => o.scope)).toEqual(['session']);
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
        requestId: 'test-request-id',
        suggestions: undefined,
      });

      // Should allow immediately without emitting action
      expect(result!.behavior).toBe('allow');
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
        requestId: 'test-request-id',
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
        requestId: 'test-request-id',
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

      expect(result!.behavior).toBe('allow');

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
        requestId: 'test-request-id',
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
        requestId: 'test-request-id',
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
        requestId: 'test-request-id',
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
      expect(result!.behavior).toBe('allow');

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
        requestId: 'test-request-id',
        suggestions,
      });
      const promise2 = canUseTool('Bash', { command: 'pwd' }, {
        signal: abortController.signal,
        toolUseID: 'id-2',
        requestId: 'test-request-id',
        suggestions,
      });
      const promise3 = canUseTool('Bash', { command: 'date' }, {
        signal: abortController.signal,
        toolUseID: 'id-3',
        requestId: 'test-request-id',
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

      expect(result1!.behavior).toBe('allow');
      expect(result2!.behavior).toBe('allow');
      expect(result3!.behavior).toBe('allow');
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
        requestId: 'test-request-id',
        suggestions: bashSuggestions,
      });
      canUseTool('Write', { file_path: '/test.txt', content: 'hi' }, {
        signal: abortController.signal,
        toolUseID: 'id-2',
        requestId: 'test-request-id',
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

    it('AskUserQuestion intercept: emits ask-user-question action and short-circuits SDK execution', async () => {
      const followUps: string[] = [];
      const permissionManager = new PermissionManager(
        mockConfigService,
        emitToolUse,
        undefined,
        'conv-1',
        undefined,
        (text) => followUps.push(text),
      );

      const canUseTool = permissionManager.createCanUseToolCallback();
      const abortController = new AbortController();

      const input = {
        questions: [
          {
            question: 'Which library should we use?',
            header: 'Library',
            multiSelect: false,
            options: [
              { label: 'axios', description: 'Popular HTTP client' },
              { label: 'fetch', description: 'Native browser API' },
            ],
          },
        ],
      };

      const promise = canUseTool('AskUserQuestion', input, {
        signal: abortController.signal,
        toolUseID: 'tu-1',
        requestId: 'test-request-id',
        suggestions: undefined,
      });

      await new Promise((r) => setImmediate(r));

      expect(capturedAction).not.toBeNull();
      expect(capturedAction!.type).toBe('ask-user-question');
      const action = capturedAction as PendingAction & { details: { questions: unknown[]; truncated: boolean } };
      expect(action.details.truncated).toBe(false);
      expect(action.details.questions).toHaveLength(1);

      // User answers
      permissionManager.handleQuestionAnswer({
        conversationId: 'conv-1',
        actionId: capturedAction!.id,
        answers: [{ question: 'Which library should we use?', answer: 'axios' }],
      });

      const result = await promise;
      expect(result!.behavior).toBe('deny');
      const parsed = JSON.parse((result as { message: string }).message);
      expect(parsed.answers['Which library should we use?']).toBe('axios');
      expect((result as { interrupt?: boolean }).interrupt).toBe(false);
      expect(followUps).toHaveLength(1);
      expect(followUps[0]).toContain('[User answered AskUserQuestion]:');
      expect(followUps[0]).toContain('axios');
    });

    it('AskUserQuestion intercept: cancellation returns deny without a follow-up message', async () => {
      const followUps: string[] = [];
      const permissionManager = new PermissionManager(
        mockConfigService,
        emitToolUse,
        undefined,
        'conv-1',
        undefined,
        (text) => followUps.push(text),
      );

      const canUseTool = permissionManager.createCanUseToolCallback();
      const abortController = new AbortController();

      const promise = canUseTool('AskUserQuestion', {
        questions: [
          {
            question: 'Approach?',
            header: 'Approach',
            multiSelect: false,
            options: [
              { label: 'A', description: '' },
              { label: 'B', description: '' },
            ],
          },
        ],
      }, {
        signal: abortController.signal,
        toolUseID: 'tu-2',
        requestId: 'test-request-id',
        suggestions: undefined,
      });

      await new Promise((r) => setImmediate(r));
      expect(capturedAction).not.toBeNull();

      permissionManager.handleQuestionAnswer({
        conversationId: 'conv-1',
        actionId: capturedAction!.id,
        answers: [],
        cancelled: true,
      });

      const result = await promise;
      expect(result!.behavior).toBe('deny');
      expect((result as { message: string }).message).toContain('cancelled');
      expect(followUps).toHaveLength(0);
    });

    it('AskUserQuestion intercept: invalid payload denies with a clear message', async () => {
      const permissionManager = new PermissionManager(mockConfigService, emitToolUse);
      const canUseTool = permissionManager.createCanUseToolCallback();
      const abortController = new AbortController();

      const result = await canUseTool('AskUserQuestion', { questions: [] }, {
        signal: abortController.signal,
        toolUseID: 'tu-3',
        requestId: 'test-request-id',
        suggestions: undefined,
      });

      expect(result!.behavior).toBe('deny');
      expect((result as { message: string }).message).toMatch(/empty|invalid/i);
      // No action should have been emitted for an invalid payload
      expect(capturedAction).toBeNull();
    });

    it('AskUserQuestion intercept: multiSelect answers are formatted as comma-separated', async () => {
      const followUps: string[] = [];
      const permissionManager = new PermissionManager(
        mockConfigService,
        emitToolUse,
        undefined,
        'conv-1',
        undefined,
        (text) => followUps.push(text),
      );

      const canUseTool = permissionManager.createCanUseToolCallback();
      const abortController = new AbortController();

      const input = {
        questions: [
          {
            question: 'Pick features',
            header: 'Features',
            multiSelect: true,
            options: [
              { label: 'a', description: '' },
              { label: 'b', description: '' },
              { label: 'c', description: '' },
            ],
          },
        ],
      };

      const promise = canUseTool('AskUserQuestion', input, {
        signal: abortController.signal,
        toolUseID: 'tu-4',
        requestId: 'test-request-id',
        suggestions: undefined,
      });

      await new Promise((r) => setImmediate(r));
      permissionManager.handleQuestionAnswer({
        conversationId: 'conv-1',
        actionId: capturedAction!.id,
        answers: [{ question: 'Pick features', answer: 'a, b' }],
      });

      const result = await promise;
      const parsed = JSON.parse((result as { message: string }).message);
      expect(parsed.answers['Pick features']).toBe('a, b');
    });

    it('AskUserQuestion: createPendingAction returns null as defense-in-depth', async () => {
      const permissionManager = new PermissionManager(mockConfigService, emitToolUse);
      // Call the private method via casting; verifies the safety net at line ~470
      const result = (permissionManager as unknown as {
        createPendingAction: (id: string, toolName: string, input: Record<string, unknown>) => unknown | null;
      }).createPendingAction('action-x', 'AskUserQuestion', {});
      expect(result).toBeNull();
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
        requestId: 'test-request-id',
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
      expect(result!.behavior).toBe('allow');
      // No errors - everything works without cache
    });
  });
});
