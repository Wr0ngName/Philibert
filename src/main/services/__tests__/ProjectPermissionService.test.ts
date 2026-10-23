/**
 * Tests for ProjectPermissionService.
 *
 * Run against a real temp directory, like McpConfigService's: what matters is
 * what ends up on disk, because the CLI reads these files, and a revoke that
 * drops a user's unrelated keys would be invisible to a mocked fs.
 *
 * The stored shapes used here are the ones the bundled CLI wrote when handed
 * `localSettings` updates: "Bash(touch probe-one.txt)" and "Write" under
 * `permissions.allow`, and directories under `permissions.additionalDirectories`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ConfigurationError, ValidationError } from '../../errors';
import { ProjectPermissionService } from '../ProjectPermissionService';

let projectDir: string;
let service: ProjectPermissionService;

function settingsPath(file: 'settings.local.json' | 'settings.json'): string {
  return path.join(projectDir, '.claude', file);
}

function writeSettings(file: 'settings.local.json' | 'settings.json', value: unknown): void {
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.writeFileSync(settingsPath(file), JSON.stringify(value, null, 2));
}

function readLocalSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath('settings.local.json'), 'utf-8'));
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-project-perms-'));
  service = new ProjectPermissionService();
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe('list', () => {
  it('is empty for a project without settings files', () => {
    expect(service.list(projectDir)).toEqual([]);
  });

  it('parses rules and directories from both files, local first', () => {
    writeSettings('settings.local.json', {
      permissions: {
        allow: ['Bash(touch probe-one.txt)', 'Write'],
        additionalDirectories: ['/tmp/extra'],
      },
    });
    writeSettings('settings.json', { permissions: { allow: ['WebFetch(domain:example.com)'] } });

    expect(service.list(projectDir)).toEqual([
      { kind: 'rule', value: 'Bash(touch probe-one.txt)', toolName: 'Bash', ruleContent: 'touch probe-one.txt', source: 'local' },
      { kind: 'rule', value: 'Write', toolName: 'Write', source: 'local' },
      { kind: 'directory', value: '/tmp/extra', source: 'local' },
      { kind: 'rule', value: 'WebFetch(domain:example.com)', toolName: 'WebFetch', ruleContent: 'domain:example.com', source: 'shared' },
    ]);
  });

  it('keeps nested parentheses inside the rule specifier', () => {
    writeSettings('settings.local.json', { permissions: { allow: ['Bash(echo (a) b)'] } });

    expect(service.list(projectDir)[0]).toMatchObject({ toolName: 'Bash', ruleContent: 'echo (a) b' });
  });

  it('ignores deny/ask rules and non-string junk', () => {
    writeSettings('settings.local.json', {
      permissions: { allow: ['Read', 42, null], deny: ['Bash(rm:*)'], ask: ['Edit'], additionalDirectories: 'nope' },
    });

    expect(service.list(projectDir).map(e => e.value)).toEqual(['Read']);
  });

  it('refuses to read a settings file that is not valid JSON', () => {
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath('settings.local.json'), '{ nope');

    expect(() => service.list(projectDir)).toThrow(ConfigurationError);
  });
});

describe('revoke', () => {
  it('removes the rule and keeps every other key of the file', () => {
    writeSettings('settings.local.json', {
      enabledMcpjsonServers: ['docs'],
      permissions: { allow: ['Write', 'Bash(npm test)'], deny: ['Bash(rm:*)'], additionalDirectories: ['/tmp/extra'] },
    });

    const remaining = service.revoke(projectDir, 'rule', 'Write');

    expect(readLocalSettings()).toEqual({
      enabledMcpjsonServers: ['docs'],
      permissions: { allow: ['Bash(npm test)'], deny: ['Bash(rm:*)'], additionalDirectories: ['/tmp/extra'] },
    });
    expect(remaining.map(e => e.value)).toEqual(['Bash(npm test)', '/tmp/extra']);
  });

  it('removes a directory from additionalDirectories, not from allow', () => {
    writeSettings('settings.local.json', {
      permissions: { allow: ['/tmp/extra'], additionalDirectories: ['/tmp/extra'] },
    });

    service.revoke(projectDir, 'directory', '/tmp/extra');

    expect(readLocalSettings()).toEqual({ permissions: { allow: ['/tmp/extra'], additionalDirectories: [] } });
  });

  it('never edits the shared settings file', () => {
    writeSettings('settings.json', { permissions: { allow: ['Write'] } });
    const before = fs.readFileSync(settingsPath('settings.json'), 'utf-8');

    expect(() => service.revoke(projectDir, 'rule', 'Write')).toThrow(ValidationError);
    expect(fs.readFileSync(settingsPath('settings.json'), 'utf-8')).toBe(before);
    expect(fs.existsSync(settingsPath('settings.local.json'))).toBe(false);
  });

  it('rejects an entry that is not in the local file', () => {
    writeSettings('settings.local.json', { permissions: { allow: ['Write'] } });

    expect(() => service.revoke(projectDir, 'rule', 'Edit')).toThrow(ValidationError);
    expect(readLocalSettings()).toEqual({ permissions: { allow: ['Write'] } });
  });
});
