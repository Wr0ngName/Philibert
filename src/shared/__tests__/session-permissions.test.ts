import { describe, it, expect } from 'vitest';

import { cliRuleString, entryInForce, normalizeSessionEntry, sessionEntryTitle } from '../session-permissions';
import type { SessionPermissionEntry } from '../types';

describe('cliRuleString', () => {
  it('is the tool alone without content', () => {
    expect(cliRuleString('WebSearch')).toBe('WebSearch');
    expect(cliRuleString('Bash', '')).toBe('Bash');
  });

  // The escaping CLI 2.1.280 writes and reads back: `\`, `(` and `)`.
  it.each([
    ['npm test *', 'Bash(npm test *)'],
    ['touch "(x) y, z"', 'Bash(touch "\\(x\\) y, z")'],
    ['echo a\\b', 'Bash(echo a\\\\b)'],
    ['echo \\(', 'Bash(echo \\\\\\()'],
  ])('escapes %s', (content, rule) => {
    expect(cliRuleString('Bash', content)).toBe(rule);
  });

  it('round-trips through the CLI\'s own unescaping', () => {
    // Akr/Tkr in the CLI 2.1.280 bundle: `\(` → `(`, `\)` → `)`, then `\\` → `\`.
    const unescape = (raw: string) => raw.replaceAll('\\(', '(').replaceAll('\\)', ')').replaceAll('\\\\', '\\');
    for (const content of ['touch "(x) y"', 'grep -E "a|(b)" f', 'C:\\temp\\(1)']) {
      const rule = cliRuleString('Bash', content);
      expect(unescape(rule.slice('Bash('.length, -1))).toBe(content);
    }
  });
});

describe('normalizeSessionEntry', () => {
  it('keeps a mode or a directory of today\'s shape, and drops one with nothing in it', () => {
    expect(normalizeSessionEntry({ id: 'm', kind: 'mode', mode: 'plan', description: '', grantedAt: 1 }))
      .toEqual({ id: 'm', kind: 'mode', mode: 'plan', description: '', grantedAt: 1 });
    expect(normalizeSessionEntry({ id: 'd', kind: 'directory', directory: '/h', description: '', grantedAt: 1, sandboxed: true }))
      .toEqual({ id: 'd', kind: 'directory', directory: '/h', description: '', grantedAt: 1, sandboxed: true });
    expect(normalizeSessionEntry({ id: 'm', kind: 'mode', mode: '' })).toBeNull();
    expect(normalizeSessionEntry({ id: 'd', kind: 'directory', directory: '' })).toBeNull();
    expect(normalizeSessionEntry({ id: 'x', toolName: 'mode:' })).toBeNull();
  });

  it('marks a rule sandboxed only when it says so', () => {
    expect(normalizeSessionEntry({ id: 'r', kind: 'rule', toolName: 'Bash', sandboxed: 'yes' })).not.toHaveProperty('sandboxed');
  });
});

describe('entryInForce', () => {
  const rule = (sandboxed?: boolean): SessionPermissionEntry => ({
    id: 'r', kind: 'rule', toolName: 'Bash', description: '', grantedAt: 0, ...(sandboxed ? { sandboxed } : {}),
  });

  it('holds a grant made outside the sandbox either way, and one made inside only inside', () => {
    expect([entryInForce(rule(), false), entryInForce(rule(), true)]).toEqual([true, true]);
    expect([entryInForce(rule(true), false), entryInForce(rule(true), true)]).toEqual([false, true]);
  });

  it('holds a mode or a directory made inside the sandbox only inside, as a rule', () => {
    const mode: SessionPermissionEntry = { id: 'm', kind: 'mode', mode: 'acceptEdits', description: '', grantedAt: 0, sandboxed: true };
    const directory: SessionPermissionEntry = { id: 'd', kind: 'directory', directory: '/home/u', description: '', grantedAt: 0, sandboxed: true };
    expect([entryInForce(mode, false), entryInForce(mode, true), entryInForce(directory, false), entryInForce(directory, true)])
      .toEqual([false, true, false, true]);
  });
});

describe('sessionEntryTitle', () => {
  it('names each kind', () => {
    expect(sessionEntryTitle({ id: 'a', kind: 'rule', toolName: 'Bash', ruleContent: 'ls', description: '', grantedAt: 0 })).toBe('Bash (ls)');
    expect(sessionEntryTitle({ id: 'b', kind: 'rule', toolName: 'WebSearch', description: '', grantedAt: 0 })).toBe('WebSearch');
    expect(sessionEntryTitle({ id: 'c', kind: 'mode', mode: 'acceptEdits', description: '', grantedAt: 0 })).toBe('Mode: acceptEdits');
    expect(sessionEntryTitle({ id: 'd', kind: 'directory', directory: '/a', description: '', grantedAt: 0 })).toBe('Directory: /a');
  });
});
