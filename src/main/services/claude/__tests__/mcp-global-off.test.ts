/**
 * Turning a tool off everywhere: `deniedMcpServers` in Claude Code's user
 * settings, against a real folder — what ends up in the file is what Claude
 * Code reads, and it is shared with Claude Code in a terminal.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { readGloballyOff, setGloballyOff } from '../mcp-global-off';

let configDir: string;
const settingsFile = () => path.join(configDir, 'settings.json');
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) as Record<string, unknown>;

beforeEach(() => {
  configDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-global-off-')), 'claude');
});

afterEach(() => {
  fs.rmSync(path.dirname(configDir), { recursive: true, force: true });
});

describe('readGloballyOff', () => {
  it('is none when there are no settings', async () => {
    expect(await readGloballyOff(configDir)).toEqual(new Set());
  });

  it('is the servers named — not those matched by command or address', async () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({
      deniedMcpServers: [{ serverName: 'claude.ai Gmail' }, { serverCommand: ['npx', 'x'] }, { serverUrl: 'https://a/*' }, 'junk'],
    }));

    expect(await readGloballyOff(configDir)).toEqual(new Set(['claude.ai Gmail']));
  });

  it('throws on settings that are not a JSON object, rather than calling them empty', async () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(settingsFile(), '{ not json');

    await expect(readGloballyOff(configDir)).rejects.toThrow();
  });
});

describe('setGloballyOff', () => {
  it('turns one off, creating the settings when there are none', async () => {
    await setGloballyOff('claude.ai Gmail', true, configDir);

    expect(readSettings()).toEqual({ deniedMcpServers: [{ serverName: 'claude.ai Gmail' }] });
  });

  it('keeps every other setting, and every other entry — the user\'s or an administrator\'s', async () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({
      cleanupPeriodDays: 60,
      deniedMcpServers: [{ serverUrl: 'https://a/*' }, { serverName: 'other' }],
    }));

    await setGloballyOff('claude.ai Gmail', true, configDir);
    await setGloballyOff('claude.ai Gmail', true, configDir);

    expect(readSettings()).toEqual({
      cleanupPeriodDays: 60,
      deniedMcpServers: [{ serverUrl: 'https://a/*' }, { serverName: 'other' }, { serverName: 'claude.ai Gmail' }],
    });
  });

  it('turns one back on by removing what names it, and the list once it is empty', async () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ model: 'opus', deniedMcpServers: [{ serverName: 'notes' }] }));

    await setGloballyOff('notes', false, configDir);

    expect(readSettings()).toEqual({ model: 'opus' });
  });

  it('never writes over settings it cannot read', async () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(settingsFile(), '{ not json');

    await expect(setGloballyOff('notes', true, configDir)).rejects.toThrow();
    expect(fs.readFileSync(settingsFile(), 'utf-8')).toBe('{ not json');
  });
});
