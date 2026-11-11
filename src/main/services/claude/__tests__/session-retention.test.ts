/**
 * How long Claude Code keeps sessions, read from and written to its user
 * settings — a file shared with Claude Code in a terminal, against a real
 * folder.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CLAUDE_DEFAULT_SESSION_RETENTION_DAYS } from '../../../../shared/types';
import { readSessionRetention, writeSessionRetention } from '../session-retention';

let configDir: string;
const settingsFile = () => path.join(configDir, 'settings.json');
const settings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) as Record<string, unknown>;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-settings-'));
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('reading', () => {
  it("is Claude Code's default with no settings file, or none of the key", async () => {
    expect(await readSessionRetention(configDir)).toEqual({ status: 'default', days: CLAUDE_DEFAULT_SESSION_RETENTION_DAYS });
    fs.writeFileSync(settingsFile(), JSON.stringify({ model: 'opus' }));
    expect(await readSessionRetention(configDir)).toEqual({ status: 'default', days: 30 });
  });

  it('is what the settings say', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ cleanupPeriodDays: 90 }));
    expect(await readSessionRetention(configDir)).toEqual({ status: 'set', days: 90 });
  });

  it('is not known from a file that is not JSON, or a value that is not a whole number of days', async () => {
    fs.writeFileSync(settingsFile(), '{ "cleanupPeriodDays": 9');
    expect(await readSessionRetention(configDir)).toEqual({ status: 'unreadable' });
    for (const value of [0, 1.5, '30', -1]) {
      fs.writeFileSync(settingsFile(), JSON.stringify({ cleanupPeriodDays: value }));
      expect(await readSessionRetention(configDir), String(value)).toEqual({ status: 'unreadable' });
    }
    fs.writeFileSync(settingsFile(), '[1]');
    expect(await readSessionRetention(configDir)).toEqual({ status: 'unreadable' });
  });
});

describe('writing', () => {
  it('sets the key, keeping everything else in the file as it was', async () => {
    const before = { model: 'opus', permissions: { allow: ['Read'] }, cleanupPeriodDays: 30 };
    fs.writeFileSync(settingsFile(), JSON.stringify(before));

    expect(await writeSessionRetention(365, configDir)).toEqual({ status: 'set', days: 365 });

    expect(settings()).toEqual({ ...before, cleanupPeriodDays: 365 });
    expect(await readSessionRetention(configDir)).toEqual({ status: 'set', days: 365 });
  });

  it('makes the file, and its folder, when there is none', async () => {
    const fresh = path.join(configDir, 'not-yet');
    await writeSessionRetention(60, fresh);
    expect(JSON.parse(fs.readFileSync(path.join(fresh, 'settings.json'), 'utf-8'))).toEqual({ cleanupPeriodDays: 60 });
  });

  it('fixes a value that is not a whole number of days', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ cleanupPeriodDays: 0, model: 'opus' }));
    await writeSessionRetention(30, configDir);
    expect(settings()).toEqual({ cleanupPeriodDays: 30, model: 'opus' });
  });

  it('never writes over a file that is not a JSON object', async () => {
    const broken = '{ "model": "opus", ';
    fs.writeFileSync(settingsFile(), broken);
    await expect(writeSessionRetention(60, configDir)).rejects.toThrow();
    expect(fs.readFileSync(settingsFile(), 'utf-8')).toBe(broken);
  });

  it('refuses a number of days Claude Code would refuse', async () => {
    for (const days of [0, -5, 2.5, Number.NaN]) {
      await expect(writeSessionRetention(days, configDir), String(days)).rejects.toThrow();
    }
    expect(fs.existsSync(settingsFile())).toBe(false);
  });
});
