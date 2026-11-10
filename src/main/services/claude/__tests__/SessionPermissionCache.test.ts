/**
 * Comprehensive tests for SessionPermissionCache.
 *
 * Tests cover:
 * - addPermissions: filtering, deduplication, ID generation, accumulation
 * - isAllowed: toolName matching, conversation scoping, revocation handling
 * - revokePermission: removal, cleanup, callbacks
 * - getPermissions: retrieval for known/unknown conversations
 * - clearConversation: scoped clearing, callbacks
 * - clearAll: global clearing, callbacks for all conversations
 * - onPermissionsChanged: callback registration and invocation
 */

import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('../../../utils/logger', () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock ID generation to ensure deterministic tests
vi.mock('../../../../shared/id', () => {
  let idCounter = 0;
  return {
    generateId: vi.fn((prefix: string) => {
      idCounter++;
      return `${prefix}_test_${idCounter}`;
    }),
    ID_PREFIXES: {
      ACTION: 'action',
      CONVERSATION: 'conv',
      MESSAGE: 'msg',
      MODAL: 'modal',
    },
  };
});

// Import after mocks
import { generateId } from '../../../../shared/id';
import { SessionPermissionCache } from '../SessionPermissionCache';

describe('SessionPermissionCache', () => {
  let cache: SessionPermissionCache;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the ID counter
    (generateId as any).mockClear();
    let idCounter = 0;
    (generateId as any).mockImplementation((prefix: string) => {
      idCounter++;
      return `${prefix}_test_${idCounter}`;
    });
    cache = new SessionPermissionCache();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // addPermissions
  // ===========================================================================
  describe('addPermissions', () => {
    it('should add session-scoped permissions', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(1);
      expect(permissions[0].toolName).toBe('Bash');
      expect(permissions[0].ruleContent).toBe('npm test');
    });

    it('should add cliArg-scoped permissions', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Write', ruleContent: '/tmp/output.txt' }],
          behavior: 'allow',
          destination: 'cliArg',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(1);
      expect(permissions[0].toolName).toBe('Write');
    });

    it('should ignore projectSettings destination', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'projectSettings',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(0);
    });

    it('should ignore userSettings destination', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'userSettings',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(0);
    });

    it('should ignore localSettings destination', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(0);
    });

    it('should ignore removeRules type', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'removeRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        } as PermissionUpdate,
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(0);
    });

    it('should deduplicate by toolName + ruleContent combination', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [
            { toolName: 'Bash', ruleContent: 'npm test' },
            { toolName: 'Bash', ruleContent: 'npm test' }, // Exact duplicate
          ],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(1);
    });

    it('should allow same toolName with different ruleContent', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [
            { toolName: 'Bash', ruleContent: 'npm test' },
            { toolName: 'Bash', ruleContent: 'npm build' },
          ],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(2);
    });

    it('should allow same ruleContent with different toolName', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [
            { toolName: 'Bash', ruleContent: '/tmp/test.txt' },
            { toolName: 'Write', ruleContent: '/tmp/test.txt' },
          ],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(2);
    });

    it('should generate unique IDs for each entry', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [
            { toolName: 'Bash', ruleContent: 'npm test' },
            { toolName: 'Write', ruleContent: '/tmp/file.txt' },
          ],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions[0].id).toBe('action_test_1');
      expect(permissions[1].id).toBe('action_test_2');
      expect(permissions[0].id).not.toBe(permissions[1].id);
    });

    it('should create correct description for each entry', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [
            { toolName: 'Bash', ruleContent: 'npm test' },
            { toolName: 'Write', ruleContent: '/tmp/file.txt' },
          ],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions[0].description).toBe('Allow Bash for this session');
      expect(permissions[1].description).toBe('Allow Write for this session');
    });

    it('should set grantedAt timestamp', () => {
      const before = Date.now();

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const after = Date.now();
      const permissions = cache.getPermissions('conv1');
      expect(permissions[0].grantedAt).toBeGreaterThanOrEqual(before);
      expect(permissions[0].grantedAt).toBeLessThanOrEqual(after);
    });

    it('should call onChange callback with new permissions', () => {
      const onChangeCallback = vi.fn();
      cache.onPermissionsChanged(onChangeCallback);

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      expect(onChangeCallback).toHaveBeenCalledWith('conv1', expect.any(Array));
      expect(onChangeCallback).toHaveBeenCalledTimes(1);
    });

    it('should accumulate permissions across multiple calls', () => {
      const suggestions1: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      const suggestions2: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Write', ruleContent: '/tmp/file.txt' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions1);
      cache.addPermissions('conv1', suggestions2);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(2);
      expect(permissions.find((p) => p.toolName === 'Bash')).toBeDefined();
      expect(permissions.find((p) => p.toolName === 'Write')).toBeDefined();
    });

    it('should deduplicate across multiple calls', () => {
      const suggestions1: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      const suggestions2: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], // Same as first call
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions1);
      cache.addPermissions('conv1', suggestions2);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(1);
    });

    it('should handle rules without ruleContent', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(1);
      expect(permissions[0].toolName).toBe('Bash');
      expect(permissions[0].ruleContent).toBeUndefined();
    });

    it('should deduplicate rules without ruleContent', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [
            { toolName: 'Bash' },
            { toolName: 'Bash' }, // Duplicate (no ruleContent)
          ],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(1);
    });

    it('should handle empty suggestions array', () => {
      cache.addPermissions('conv1', []);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(0);
    });

    it('should handle multiple rules in single suggestion', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [
            { toolName: 'Bash', ruleContent: 'npm test' },
            { toolName: 'Write', ruleContent: '/tmp/file.txt' },
            { toolName: 'Read', ruleContent: '/tmp/input.txt' },
          ],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(3);
    });

    it('should handle mixed destinations in suggestions array', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
        {
          type: 'addRules',
          rules: [{ toolName: 'Write', ruleContent: '/tmp/file.txt' }],
          behavior: 'allow',
          destination: 'projectSettings',
        },
        {
          type: 'addRules',
          rules: [{ toolName: 'Read', ruleContent: '/tmp/input.txt' }],
          behavior: 'allow',
          destination: 'cliArg',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(2); // Only session and cliArg
      expect(permissions.find((p) => p.toolName === 'Bash')).toBeDefined();
      expect(permissions.find((p) => p.toolName === 'Read')).toBeDefined();
      expect(permissions.find((p) => p.toolName === 'Write')).toBeUndefined();
    });

    it('should handle mixed types in suggestions array', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
        {
          type: 'addDirectories',
          directories: ['/tmp'],
          destination: 'session',
        },
        {
          type: 'addRules',
          rules: [{ toolName: 'Write', ruleContent: '/tmp/file.txt' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(3); // addRules + addDirectories
      expect(permissions.find((p) => p.toolName === 'Bash')).toBeDefined();
      expect(permissions.find((p) => p.toolName === 'Write')).toBeDefined();
      expect(permissions.find((p) => p.toolName === 'dir:/tmp')).toBeDefined();
    });
  });

  // ===========================================================================
  // isAllowed
  // ===========================================================================
  describe('isAllowed', () => {
    it('should return true when toolName matches a cached permission', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const allowed = cache.isAllowed('conv1', 'Bash', {});
      expect(allowed).toBe(true);
    });

    it('should return false for unknown conversation', () => {
      const allowed = cache.isAllowed('unknownConv', 'Bash', {});
      expect(allowed).toBe(false);
    });

    it('should return false for uncached toolName', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const allowed = cache.isAllowed('conv1', 'Write', {});
      expect(allowed).toBe(false);
    });

    it('should be scoped per conversation', () => {
      const suggestions1: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      const suggestions2: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Write', ruleContent: '/tmp/file.txt' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions1);
      cache.addPermissions('conv2', suggestions2);

      expect(cache.isAllowed('conv1', 'Bash', {})).toBe(true);
      expect(cache.isAllowed('conv1', 'Write', {})).toBe(false);
      expect(cache.isAllowed('conv2', 'Bash', {})).toBe(false);
      expect(cache.isAllowed('conv2', 'Write', {})).toBe(true);
    });

    it('should return false after permission is revoked', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      const permissions = cache.getPermissions('conv1');
      cache.revokePermission('conv1', permissions[0].id);

      const allowed = cache.isAllowed('conv1', 'Bash', {});
      expect(allowed).toBe(false);
    });

    it('should match by toolName only, not ruleContent', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      // Should allow any Bash command, not just 'npm test'
      const allowed = cache.isAllowed('conv1', 'Bash', { command: 'npm build' });
      expect(allowed).toBe(true);
    });

    it('should return false for empty conversation cache', () => {
      // Add then clear
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      cache.clearConversation('conv1');

      const allowed = cache.isAllowed('conv1', 'Bash', {});
      expect(allowed).toBe(false);
    });

    it('should handle multiple permissions for same toolName', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [
            { toolName: 'Bash', ruleContent: 'npm test' },
            { toolName: 'Bash', ruleContent: 'npm build' },
          ],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const allowed = cache.isAllowed('conv1', 'Bash', {});
      expect(allowed).toBe(true);
    });

    it('should ignore input parameter', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      // Input is ignored (3rd parameter)
      const allowed1 = cache.isAllowed('conv1', 'Bash', {});
      const allowed2 = cache.isAllowed('conv1', 'Bash', { command: 'npm test' });
      const allowed3 = cache.isAllowed('conv1', 'Bash', { command: 'rm -rf /' });

      expect(allowed1).toBe(true);
      expect(allowed2).toBe(true);
      expect(allowed3).toBe(true);
    });
  });

  // ===========================================================================
  // revokePermission
  // ===========================================================================
  describe('revokePermission', () => {
    it('should remove permission by ID and return true', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      const permissions = cache.getPermissions('conv1');
      const permissionId = permissions[0].id;

      const result = cache.revokePermission('conv1', permissionId);

      expect(result).toBe(true);
      expect(cache.getPermissions('conv1')).toHaveLength(0);
    });

    it('should return false for unknown conversation ID', () => {
      const result = cache.revokePermission('unknownConv', 'action_test_1');

      expect(result).toBe(false);
    });

    it('should return false for unknown permission ID', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const result = cache.revokePermission('conv1', 'unknownPermissionId');

      expect(result).toBe(false);
    });

    it('should call onChange callback after revoking', () => {
      const onChangeCallback = vi.fn();
      cache.onPermissionsChanged(onChangeCallback);

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      onChangeCallback.mockClear(); // Clear the add call

      const permissions = cache.getPermissions('conv1');
      cache.revokePermission('conv1', permissions[0].id);

      expect(onChangeCallback).toHaveBeenCalledWith('conv1', []);
      expect(onChangeCallback).toHaveBeenCalledTimes(1);
    });

    it('should clean up map entry when last permission removed', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      const permissions = cache.getPermissions('conv1');
      cache.revokePermission('conv1', permissions[0].id);

      // Should return empty array (not undefined) after map entry is deleted
      expect(cache.getPermissions('conv1')).toEqual([]);
    });

    it('should only remove the specified permission', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [
            { toolName: 'Bash', ruleContent: 'npm test' },
            { toolName: 'Write', ruleContent: '/tmp/file.txt' },
            { toolName: 'Read', ruleContent: '/tmp/input.txt' },
          ],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      const permissions = cache.getPermissions('conv1');
      // Save IDs before mutation (getPermissions returns the internal array reference)
      const firstId = permissions[0].id;
      const middlePermissionId = permissions[1].id;
      const thirdId = permissions[2].id;

      cache.revokePermission('conv1', middlePermissionId);

      const remaining = cache.getPermissions('conv1');
      expect(remaining).toHaveLength(2);
      expect(remaining.find((p) => p.id === middlePermissionId)).toBeUndefined();
      expect(remaining.find((p) => p.id === firstId)).toBeDefined();
      expect(remaining.find((p) => p.id === thirdId)).toBeDefined();
    });

    it('should not affect other conversations', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      cache.addPermissions('conv2', suggestions);

      const permissions1 = cache.getPermissions('conv1');
      cache.revokePermission('conv1', permissions1[0].id);

      expect(cache.getPermissions('conv1')).toHaveLength(0);
      expect(cache.getPermissions('conv2')).toHaveLength(1);
    });
  });

  // ===========================================================================
  // getPermissions
  // ===========================================================================
  describe('getPermissions', () => {
    it('should return cached entries for known conversation', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [
            { toolName: 'Bash', ruleContent: 'npm test' },
            { toolName: 'Write', ruleContent: '/tmp/file.txt' },
          ],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(2);
    });

    it('should return empty array for unknown conversation', () => {
      const permissions = cache.getPermissions('unknownConv');
      expect(permissions).toEqual([]);
    });

    it('should return array with all expected fields', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions[0]).toHaveProperty('id');
      expect(permissions[0]).toHaveProperty('toolName');
      expect(permissions[0]).toHaveProperty('ruleContent');
      expect(permissions[0]).toHaveProperty('description');
      expect(permissions[0]).toHaveProperty('grantedAt');
    });

    it('should return empty array after conversation is cleared', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      cache.clearConversation('conv1');

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toEqual([]);
    });
  });

  // ===========================================================================
  // clearConversation
  // ===========================================================================
  describe('clearConversation', () => {
    it('should clear all permissions for a conversation', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [
            { toolName: 'Bash', ruleContent: 'npm test' },
            { toolName: 'Write', ruleContent: '/tmp/file.txt' },
          ],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      cache.clearConversation('conv1');

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toEqual([]);
    });

    it('should call onChange callback with empty array', () => {
      const onChangeCallback = vi.fn();
      cache.onPermissionsChanged(onChangeCallback);

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      onChangeCallback.mockClear(); // Clear the add call

      cache.clearConversation('conv1');

      expect(onChangeCallback).toHaveBeenCalledWith('conv1', []);
      expect(onChangeCallback).toHaveBeenCalledTimes(1);
    });

    it('should not affect other conversations', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      cache.addPermissions('conv2', suggestions);
      cache.clearConversation('conv1');

      expect(cache.getPermissions('conv1')).toEqual([]);
      expect(cache.getPermissions('conv2')).toHaveLength(1);
    });

    it('should be a no-op if conversation does not exist', () => {
      const onChangeCallback = vi.fn();
      cache.onPermissionsChanged(onChangeCallback);

      cache.clearConversation('unknownConv');

      // Should not call callback for non-existent conversation
      expect(onChangeCallback).not.toHaveBeenCalled();
    });

    it('should allow re-adding permissions after clearing', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      cache.clearConversation('conv1');
      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(1);
    });
  });

  // ===========================================================================
  // clearAll
  // ===========================================================================
  describe('clearAll', () => {
    it('should clear all conversations', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      cache.addPermissions('conv2', suggestions);
      cache.addPermissions('conv3', suggestions);

      cache.clearAll();

      expect(cache.getPermissions('conv1')).toEqual([]);
      expect(cache.getPermissions('conv2')).toEqual([]);
      expect(cache.getPermissions('conv3')).toEqual([]);
    });

    it('should call onChange for each cleared conversation', () => {
      const onChangeCallback = vi.fn();
      cache.onPermissionsChanged(onChangeCallback);

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      cache.addPermissions('conv2', suggestions);
      cache.addPermissions('conv3', suggestions);

      onChangeCallback.mockClear(); // Clear the add calls

      cache.clearAll();

      expect(onChangeCallback).toHaveBeenCalledWith('conv1', []);
      expect(onChangeCallback).toHaveBeenCalledWith('conv2', []);
      expect(onChangeCallback).toHaveBeenCalledWith('conv3', []);
      expect(onChangeCallback).toHaveBeenCalledTimes(3);
    });

    it('should handle empty cache', () => {
      const onChangeCallback = vi.fn();
      cache.onPermissionsChanged(onChangeCallback);

      cache.clearAll();

      expect(onChangeCallback).not.toHaveBeenCalled();
    });

    it('should allow re-adding permissions after clearing all', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      cache.clearAll();
      cache.addPermissions('conv1', suggestions);

      const permissions = cache.getPermissions('conv1');
      expect(permissions).toHaveLength(1);
    });
  });

  // ===========================================================================
  // onPermissionsChanged
  // ===========================================================================
  describe('onPermissionsChanged', () => {
    it('should register callback', () => {
      const onChangeCallback = vi.fn();

      cache.onPermissionsChanged(onChangeCallback);

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      expect(onChangeCallback).toHaveBeenCalled();
    });

    it('should be called on add', () => {
      const onChangeCallback = vi.fn();
      cache.onPermissionsChanged(onChangeCallback);

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      expect(onChangeCallback).toHaveBeenCalledWith('conv1', expect.any(Array));
    });

    it('should be called on revoke', () => {
      const onChangeCallback = vi.fn();
      cache.onPermissionsChanged(onChangeCallback);

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      const permissions = cache.getPermissions('conv1');

      onChangeCallback.mockClear();

      cache.revokePermission('conv1', permissions[0].id);

      expect(onChangeCallback).toHaveBeenCalledWith('conv1', []);
    });

    it('should be called on clearConversation', () => {
      const onChangeCallback = vi.fn();
      cache.onPermissionsChanged(onChangeCallback);

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      onChangeCallback.mockClear();

      cache.clearConversation('conv1');

      expect(onChangeCallback).toHaveBeenCalledWith('conv1', []);
    });

    it('should be called on clearAll', () => {
      const onChangeCallback = vi.fn();
      cache.onPermissionsChanged(onChangeCallback);

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);
      cache.addPermissions('conv2', suggestions);

      onChangeCallback.mockClear();

      cache.clearAll();

      expect(onChangeCallback).toHaveBeenCalledWith('conv1', []);
      expect(onChangeCallback).toHaveBeenCalledWith('conv2', []);
    });

    it('should not be called when no callback registered', () => {
      // No callback registered
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      // Should not throw
      expect(() => cache.addPermissions('conv1', suggestions)).not.toThrow();
      expect(() => cache.clearConversation('conv1')).not.toThrow();
    });

    it('should allow replacing callback', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      cache.onPermissionsChanged(callback1);

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(0);

      cache.onPermissionsChanged(callback2);

      cache.addPermissions('conv2', suggestions);

      expect(callback1).toHaveBeenCalledTimes(1); // Not called again
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it('should pass conversation ID and permissions to callback', () => {
      const onChangeCallback = vi.fn();
      cache.onPermissionsChanged(onChangeCallback);

      const suggestions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [
            { toolName: 'Bash', ruleContent: 'npm test' },
            { toolName: 'Write', ruleContent: '/tmp/file.txt' },
          ],
          behavior: 'allow',
          destination: 'session',
        },
      ];

      cache.addPermissions('conv1', suggestions);

      expect(onChangeCallback).toHaveBeenCalledWith('conv1', expect.arrayContaining([
        expect.objectContaining({ toolName: 'Bash' }),
        expect.objectContaining({ toolName: 'Write' }),
      ]));
    });
  });

  describe('setMode handling', () => {
    it('should expand acceptEdits mode to Write, Edit, MultiEdit, NotebookEdit tools', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'session',
        } as PermissionUpdate,
      ];

      cache.addPermissions('conv1', suggestions);
      const perms = cache.getPermissions('conv1');

      expect(perms).toHaveLength(4);
      expect(perms.map(p => p.toolName)).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
    });

    it('should auto-approve Write tool after acceptEdits mode is cached', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'session',
        } as PermissionUpdate,
      ];

      cache.addPermissions('conv1', suggestions);

      expect(cache.isAllowed('conv1', 'Write', {})).toBe(true);
      expect(cache.isAllowed('conv1', 'Edit', {})).toBe(true);
      expect(cache.isAllowed('conv1', 'MultiEdit', {})).toBe(true);
      expect(cache.isAllowed('conv1', 'NotebookEdit', {})).toBe(true);
    });

    it('should NOT auto-approve Bash after acceptEdits mode', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'session',
        } as PermissionUpdate,
      ];

      cache.addPermissions('conv1', suggestions);

      expect(cache.isAllowed('conv1', 'Bash', {})).toBe(false);
    });

    it('should expand bypassPermissions mode to wildcard', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'setMode',
          mode: 'bypassPermissions',
          destination: 'session',
        } as PermissionUpdate,
      ];

      cache.addPermissions('conv1', suggestions);
      const perms = cache.getPermissions('conv1');

      expect(perms).toHaveLength(1);
      expect(perms[0].toolName).toBe('*');
    });

    it('should auto-approve any tool after bypassPermissions mode', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'setMode',
          mode: 'bypassPermissions',
          destination: 'session',
        } as PermissionUpdate,
      ];

      cache.addPermissions('conv1', suggestions);

      expect(cache.isAllowed('conv1', 'Bash', {})).toBe(true);
      expect(cache.isAllowed('conv1', 'Write', {})).toBe(true);
      expect(cache.isAllowed('conv1', 'Edit', {})).toBe(true);
      expect(cache.isAllowed('conv1', 'SomeUnknownTool', {})).toBe(true);
    });

    it('should ignore setMode with non-session destination', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'projectSettings',
        } as PermissionUpdate,
      ];

      cache.addPermissions('conv1', suggestions);

      expect(cache.getPermissions('conv1')).toHaveLength(0);
      expect(cache.isAllowed('conv1', 'Write', {})).toBe(false);
    });

    it('should deduplicate mode expansions across multiple calls', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'session',
        } as PermissionUpdate,
      ];

      cache.addPermissions('conv1', suggestions);
      cache.addPermissions('conv1', suggestions);

      // Should still only have 4 entries, not 8
      expect(cache.getPermissions('conv1')).toHaveLength(4);
    });

    it('should handle unknown mode gracefully', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'setMode',
          mode: 'plan' as any,
          destination: 'session',
        } as PermissionUpdate,
      ];

      cache.addPermissions('conv1', suggestions);
      const perms = cache.getPermissions('conv1');

      expect(perms).toHaveLength(1);
      expect(perms[0].toolName).toBe('mode:plan');
    });

    it('should call onChange callback when setMode permissions are added', () => {
      const onChangeCallback = vi.fn();
      cache.onPermissionsChanged(onChangeCallback);

      const suggestions: PermissionUpdate[] = [
        {
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'session',
        } as PermissionUpdate,
      ];

      cache.addPermissions('conv1', suggestions);

      expect(onChangeCallback).toHaveBeenCalledWith('conv1', expect.arrayContaining([
        expect.objectContaining({ toolName: 'Write' }),
        expect.objectContaining({ toolName: 'Edit' }),
      ]));
    });
  });

  describe('addDirectories handling', () => {
    it('should store directory entries', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addDirectories',
          directories: ['/home/user/project'],
          destination: 'session',
        } as PermissionUpdate,
      ];

      cache.addPermissions('conv1', suggestions);
      const perms = cache.getPermissions('conv1');

      expect(perms).toHaveLength(1);
      expect(perms[0].toolName).toBe('dir:/home/user/project');
      expect(perms[0].description).toBe('Allow directory: /home/user/project');
    });

    it('should ignore addDirectories with non-session destination', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'addDirectories',
          directories: ['/some/path'],
          destination: 'projectSettings',
        } as PermissionUpdate,
      ];

      cache.addPermissions('conv1', suggestions);
      expect(cache.getPermissions('conv1')).toHaveLength(0);
    });
  });

  describe('replaceRules handling', () => {
    it('should process replaceRules same as addRules', () => {
      const suggestions: PermissionUpdate[] = [
        {
          type: 'replaceRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
          behavior: 'allow',
          destination: 'session',
        } as PermissionUpdate,
      ];

      cache.addPermissions('conv1', suggestions);
      expect(cache.isAllowed('conv1', 'Bash', {})).toBe(true);
    });
  });

  // A prompt after a restart was traced from the log, which said only how
  // many grants came back — not whether its tool was among them.
  describe('seeding from a saved discussion', () => {
    it('logs which tools came back, not only how many', async () => {
      const { default: logger } = await import('../../../utils/logger');

      cache.seed('conv1', [
        { id: 'p1', toolName: 'Monitor', description: 'Monitor', grantedAt: 1 },
        { id: 'p2', toolName: 'WebFetch', description: 'WebFetch', grantedAt: 2 },
      ]);

      expect(logger.info).toHaveBeenCalledWith('Session permissions seeded from persisted state', {
        conversationId: 'conv1', count: 2, tools: ['Monitor', 'WebFetch'],
      });
      expect(cache.isAllowed('conv1', 'Monitor', {})).toBe(true);
    });
  });
});
