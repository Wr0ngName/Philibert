/**
 * Where Claude Code's global config file is: the three cases measured on CLI
 * 2.1.280, by running `claude mcp add-json --scope user` with each and seeing
 * which file it wrote.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { globalConfigFile } from '../claude-files';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-claude-files-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('globalConfigFile', () => {
  it('is in $CLAUDE_CONFIG_DIR when it is set', () => {
    expect(globalConfigFile({ CLAUDE_CONFIG_DIR: '/cfg' }, home)).toBe(path.join('/cfg', '.claude.json'));
  });

  it('is ~/.claude.json otherwise — beside ~/.claude, not in it', () => {
    fs.mkdirSync(path.join(home, '.claude'));
    expect(globalConfigFile({}, home)).toBe(path.join(home, '.claude.json'));
  });

  it('is ~/.claude/.config.json when that file is left from an older version', () => {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', '.config.json'), '{}');
    expect(globalConfigFile({}, home)).toBe(path.join(home, '.claude', '.config.json'));
  });
});
