/**
 * Tests for SessionPermissionCache: what "for this session" grants are kept,
 * and what is given to the CLI from them.
 *
 * The cache decides nothing about a tool call — the CLI matches its rules —
 * so these tests are about what it keeps and what it reports in force:
 * - addPermissions / addRule: which updates are kept, as which kind
 * - allowRules: the CLI rule strings in force, sandboxed or not
 * - mode / directories: what a new session is started with
 * - revokePermission / clearConversation: what was taken away
 * - seed: saved entries, including ones saved before entries had a kind
 */

import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/logger', () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import type { SessionPermissionEntry } from '../../../../shared/types';
import { SessionPermissionCache } from '../SessionPermissionCache';

const sessionRule = (toolName: string, ruleContent?: string, destination: PermissionUpdate['destination'] = 'session'): PermissionUpdate => ({
  type: 'addRules',
  rules: [{ toolName, ...(ruleContent !== undefined ? { ruleContent } : {}) }],
  behavior: 'allow',
  destination,
});

describe('SessionPermissionCache', () => {
  let cache: SessionPermissionCache;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = new SessionPermissionCache();
  });

  describe('addPermissions', () => {
    it('keeps a session allow rule with its content', () => {
      cache.addPermissions('c1', [sessionRule('Bash', 'npm test *')]);

      const [entry] = cache.getPermissions('c1');
      expect(entry).toMatchObject({ kind: 'rule', toolName: 'Bash', ruleContent: 'npm test *' });
      expect(entry.description).toBe('Allow Bash (npm test *) for this session');
      expect(entry.id).toEqual(expect.any(String));
      expect(entry.grantedAt).toEqual(expect.any(Number));
    });

    it('keeps cliArg rules as session rules', () => {
      cache.addPermissions('c1', [sessionRule('WebSearch', undefined, 'cliArg')]);
      expect(cache.getPermissions('c1')).toMatchObject([{ kind: 'rule', toolName: 'WebSearch' }]);
    });

    it.each(['projectSettings', 'localSettings', 'userSettings'] as const)(
      'leaves %s updates to the CLI',
      (destination) => {
        cache.addPermissions('c1', [
          sessionRule('Bash', 'ls', destination),
          { type: 'setMode', mode: 'acceptEdits', destination },
          { type: 'addDirectories', directories: ['/x'], destination },
        ]);
        expect(cache.getPermissions('c1')).toEqual([]);
      },
    );

    it('keeps no deny rule and no removal: neither grants anything', () => {
      cache.addPermissions('c1', [
        { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
        { type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
        { type: 'removeDirectories', directories: ['/x'], destination: 'session' },
      ]);
      expect(cache.getPermissions('c1')).toEqual([]);
    });

    it('keeps replaceRules as it keeps addRules', () => {
      cache.addPermissions('c1', [{ type: 'replaceRules', rules: [{ toolName: 'Read', ruleContent: '/a/**' }], behavior: 'allow', destination: 'session' }]);
      expect(cache.getPermissions('c1')).toMatchObject([{ kind: 'rule', toolName: 'Read', ruleContent: '/a/**' }]);
    });

    it('keeps a mode as one entry, not as the tools it lets edit', () => {
      cache.addPermissions('c1', [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
      expect(cache.getPermissions('c1')).toMatchObject([{ kind: 'mode', mode: 'acceptEdits' }]);
      expect(cache.allowRules('c1', false)).toEqual([]);
    });

    it('keeps one mode: a new one replaces the one before', () => {
      cache.addPermissions('c1', [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
      cache.addPermissions('c1', [{ type: 'setMode', mode: 'plan', destination: 'session' }]);
      expect(cache.getPermissions('c1').filter((e) => e.kind === 'mode')).toMatchObject([{ mode: 'plan' }]);
    });

    it('keeps directories', () => {
      cache.addPermissions('c1', [{ type: 'addDirectories', directories: ['/a', '/b'], destination: 'session' }]);
      expect(cache.directories('c1', false)).toEqual(['/a', '/b']);
    });

    it('keeps each grant once', () => {
      const updates: PermissionUpdate[] = [
        sessionRule('Bash', 'ls'),
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        { type: 'addDirectories', directories: ['/a'], destination: 'session' },
      ];
      cache.addPermissions('c1', updates);
      cache.addPermissions('c1', updates);
      expect(cache.getPermissions('c1')).toHaveLength(3);
    });

    it('tells the listener only when something was kept', () => {
      const onChange = vi.fn();
      cache.onPermissionsChanged(onChange);

      cache.addPermissions('c1', [sessionRule('Bash', 'ls', 'localSettings')]);
      expect(onChange).not.toHaveBeenCalled();

      cache.addPermissions('c1', [sessionRule('Bash', 'ls')]);
      expect(onChange).toHaveBeenCalledWith('c1', cache.getPermissions('c1'));
    });

    it('marks a shell rule granted inside the sandbox, and no other tool\'s', () => {
      cache.addPermissions('c1', [sessionRule('Bash', 'ls'), sessionRule('PowerShell'), sessionRule('WebSearch')], { sandboxed: true });
      expect(cache.getPermissions('c1').map((e) => (e.kind === 'rule' ? [e.toolName, e.sandboxed ?? false] : null)))
        .toEqual([['Bash', true], ['PowerShell', true], ['WebSearch', false]]);
    });
  });

  describe('addRule', () => {
    it('keeps the whole tool', () => {
      cache.addRule('c1', 'WebFetch');
      expect(cache.getPermissions('c1')).toMatchObject([{ kind: 'rule', toolName: 'WebFetch', description: 'Allow WebFetch for this session' }]);
      expect(cache.getPermissions('c1')[0]).not.toHaveProperty('ruleContent');
    });

    it('is idempotent', () => {
      const onChange = vi.fn();
      cache.onPermissionsChanged(onChange);
      cache.addRule('c1', 'WebFetch');
      cache.addRule('c1', 'WebFetch');
      expect(cache.getPermissions('c1')).toHaveLength(1);
      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });

  describe('allowRules', () => {
    it('writes rules in the CLI syntax, escaping what the CLI escapes', () => {
      cache.addRule('c1', 'Bash');
      cache.addRule('c1', 'Bash', 'touch "(x) y, z"');
      cache.addRule('c1', 'PowerShell', 'Get-Item C:\\temp');
      expect(cache.allowRules('c1', false)).toEqual([
        'Bash',
        'Bash(touch "\\(x\\) y, z")',
        'PowerShell(Get-Item C:\\\\temp)',
      ]);
    });

    it('gives a shell rule granted in the sandbox only while the session is sandboxed', () => {
      cache.addRule('c1', 'Bash', 'npm test *', { sandboxed: true });
      cache.addRule('c1', 'Bash', 'ls');
      expect(cache.allowRules('c1', true)).toEqual(['Bash(npm test *)', 'Bash(ls)']);
      expect(cache.allowRules('c1', false)).toEqual(['Bash(ls)']);
    });

    it('is empty for a conversation with no grants', () => {
      expect(cache.allowRules('none', false)).toEqual([]);
    });

    it('is per conversation', () => {
      cache.addRule('c1', 'Bash');
      cache.addRule('c2', 'WebFetch');
      expect(cache.allowRules('c1', false)).toEqual(['Bash']);
      expect(cache.allowRules('c2', false)).toEqual(['WebFetch']);
    });
  });

  describe('grants made inside the sandbox for a shell command', () => {
    const shellAsk = (sandboxed: boolean) => ({ sandboxed, askingTool: 'Bash' });
    const broad: PermissionUpdate[] = [
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      { type: 'addDirectories', directories: ['/home/u'], destination: 'session' },
    ];

    it('are in force inside the sandbox only: the rule, the mode and the directories that came with it', () => {
      cache.addPermissions('c1', broad, shellAsk(true));

      expect(cache.getPermissions('c1').map((e) => [e.kind, e.sandboxed])).toEqual([['rule', true], ['mode', true], ['directory', true]]);
      expect([cache.allowRules('c1', true), cache.mode('c1', true), cache.directories('c1', true)]).toEqual([['Bash'], 'acceptEdits', ['/home/u']]);
      expect([cache.allowRules('c1', false), cache.mode('c1', false), cache.directories('c1', false)]).toEqual([[], undefined, []]);
    });

    it('are in force either way when made outside the sandbox', () => {
      cache.addPermissions('c1', broad, shellAsk(false));

      expect([cache.allowRules('c1', false), cache.mode('c1', false), cache.directories('c1', false)]).toEqual([['Bash'], 'acceptEdits', ['/home/u']]);
    });

    it('are not tied to the sandbox when another tool asked: the sandbox does not confine it', () => {
      cache.addPermissions('c1', broad.slice(1), { sandboxed: true, askingTool: 'Edit' });

      expect([cache.mode('c1', false), cache.directories('c1', false)]).toEqual(['acceptEdits', ['/home/u']]);
    });

    it('are widened, not doubled, when given again outside the sandbox', () => {
      cache.addPermissions('c1', broad, shellAsk(true));
      cache.addPermissions('c1', broad, shellAsk(false));

      expect(cache.getPermissions('c1').filter((e) => e.kind !== 'rule').map((e) => [e.kind, e.sandboxed ?? false]))
        .toEqual([['mode', false], ['directory', false]]);
      cache.addPermissions('c1', broad, shellAsk(true));
      expect(cache.getPermissions('c1').filter((e) => e.kind !== 'rule')).toHaveLength(2);
      expect([cache.mode('c1', false), cache.directories('c1', false)]).toEqual(['acceptEdits', ['/home/u']]);
    });
  });

  describe('mode', () => {
    it('is the mode granted', () => {
      cache.addPermissions('c1', [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
      expect(cache.mode('c1', false)).toBe('acceptEdits');
    });

    it('is nothing for a saved mode this SDK does not know', () => {
      cache.seed('c1', [{ id: 'm', kind: 'mode', mode: 'someFutureMode', description: '', grantedAt: 1 }]);
      expect(cache.getPermissions('c1')).toHaveLength(1);
      expect(cache.mode('c1', false)).toBeUndefined();
    });
  });

  describe('revokePermission', () => {
    it('returns the entry taken away and tells the listener', () => {
      const onChange = vi.fn();
      cache.addRule('c1', 'Bash', 'ls');
      cache.addRule('c1', 'WebFetch');
      cache.onPermissionsChanged(onChange);
      const [first] = cache.getPermissions('c1');

      expect(cache.revokePermission('c1', first.id)).toEqual(first);
      expect(cache.allowRules('c1', false)).toEqual(['WebFetch']);
      expect(onChange).toHaveBeenCalledWith('c1', cache.getPermissions('c1'));
    });

    it('returns null for an unknown conversation or entry', () => {
      cache.addRule('c1', 'Bash');
      expect(cache.revokePermission('nope', 'x')).toBeNull();
      expect(cache.revokePermission('c1', 'x')).toBeNull();
      expect(cache.getPermissions('c1')).toHaveLength(1);
    });

    it('leaves other conversations alone', () => {
      cache.addRule('c1', 'Bash');
      cache.addRule('c2', 'Bash');
      cache.revokePermission('c1', cache.getPermissions('c1')[0].id);
      expect(cache.getPermissions('c1')).toEqual([]);
      expect(cache.allowRules('c2', false)).toEqual(['Bash']);
    });
  });

  describe('clearConversation', () => {
    it('returns every entry taken away and tells the listener', () => {
      cache.addRule('c1', 'Bash');
      cache.addPermissions('c1', [{ type: 'addDirectories', directories: ['/a'], destination: 'session' }]);
      const before = [...cache.getPermissions('c1')];
      const onChange = vi.fn();
      cache.onPermissionsChanged(onChange);

      expect(cache.clearConversation('c1')).toEqual(before);
      expect(cache.getPermissions('c1')).toEqual([]);
      expect(onChange).toHaveBeenCalledWith('c1', []);
    });

    it('returns nothing and says nothing for a conversation with no grants', () => {
      const onChange = vi.fn();
      cache.onPermissionsChanged(onChange);
      expect(cache.clearConversation('nope')).toEqual([]);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('clearAll', () => {
    it('clears every conversation and tells the listener for each', () => {
      cache.addRule('c1', 'Bash');
      cache.addRule('c2', 'Bash');
      const onChange = vi.fn();
      cache.onPermissionsChanged(onChange);

      cache.clearAll();

      expect(cache.getPermissions('c1')).toEqual([]);
      expect(cache.getPermissions('c2')).toEqual([]);
      expect(onChange).toHaveBeenCalledWith('c1', []);
      expect(onChange).toHaveBeenCalledWith('c2', []);
    });
  });

  describe('seed', () => {
    it('takes saved entries in today\'s shape', () => {
      const saved: SessionPermissionEntry[] = [
        { id: 'r', kind: 'rule', toolName: 'Bash', ruleContent: 'ls', sandboxed: true, description: 'd', grantedAt: 1 },
        { id: 'm', kind: 'mode', mode: 'acceptEdits', description: 'd', grantedAt: 2 },
        { id: 'd', kind: 'directory', directory: '/a', description: 'd', grantedAt: 3 },
      ];
      expect(cache.seed('c1', saved)).toBe(true);
      expect(cache.getPermissions('c1')).toEqual(saved);
    });

    it('reads entries saved before they had a kind', () => {
      cache.seed('c1', [
        { id: '1', toolName: 'Bash', ruleContent: 'npm test', description: 'd', grantedAt: 1 },
        { id: '2', toolName: 'mode:acceptEdits', description: 'd', grantedAt: 2 },
        { id: '3', toolName: '*', description: 'd', grantedAt: 3 },
        { id: '4', toolName: 'dir:/home/user/project', description: 'd', grantedAt: 4 },
      ]);
      expect(cache.getPermissions('c1')).toEqual([
        { id: '1', kind: 'rule', toolName: 'Bash', ruleContent: 'npm test', description: 'd', grantedAt: 1 },
        { id: '2', kind: 'mode', mode: 'acceptEdits', description: 'd', grantedAt: 2 },
        { id: '3', kind: 'mode', mode: 'bypassPermissions', description: 'd', grantedAt: 3 },
        { id: '4', kind: 'directory', directory: '/home/user/project', description: 'd', grantedAt: 4 },
      ]);
    });

    it('drops what is not an entry, so a damaged save grants nothing', () => {
      cache.seed('c1', [null, 42, { toolName: 'Bash' }, { id: 'x', kind: 'rule' }, { id: 'y', kind: 'other', toolName: 'Bash' }, { id: 'ok', toolName: 'Read' }]);
      expect(cache.getPermissions('c1')).toMatchObject([{ id: 'ok', kind: 'rule', toolName: 'Read' }]);
    });

    it('does not replace grants already made in this run', () => {
      cache.addRule('c1', 'Bash');
      expect(cache.seed('c1', [{ id: 'old', kind: 'rule', toolName: 'WebFetch', description: '', grantedAt: 1 }])).toBe(false);
      expect(cache.allowRules('c1', false)).toEqual(['Bash']);
    });

    it('takes nothing from an empty or non-list save', () => {
      expect(cache.seed('c1', [])).toBe(false);
      expect(cache.seed('c1', { not: 'a list' })).toBe(false);
      expect(cache.getPermissions('c1')).toEqual([]);
    });

    // A prompt after a restart was traced from the log, which said only how
    // many grants came back — not whether its tool was among them.
    it('logs which grants came back, not only how many', async () => {
      const { default: logger } = await import('../../../utils/logger');

      cache.seed('c1', [
        { id: 'p1', toolName: 'Monitor', description: 'Monitor', grantedAt: 1 },
        { id: 'p2', toolName: 'dir:/a', description: 'dir', grantedAt: 2 },
      ]);

      expect(logger.info).toHaveBeenCalledWith('Session permissions seeded from persisted state', {
        conversationId: 'c1', count: 2, grants: ['Monitor', 'directory'],
      });
    });
  });
});
