/**
 * Removing what Claude Code keeps of a deleted discussion, against real
 * folders: its session transcript and its agents' (through the SDK's own
 * deleteSession), its task outputs, and the call results this app wrote.
 *
 * Asked for: deleting a discussion left all of it behind, until Claude Code's
 * own clean-up 30 days later — or for ever, for the call results.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { deleteSessionRecords, deleteToolResults } from '../session-records';
import { writeToolResultFile } from '../tool-result-file';

const SESSION = 'd75d29ae-0f62-4a9c-a82a-f45f5011d60f';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000000';
const saved: Record<string, string | undefined> = {};
let root: string;

function file(...parts: string[]): string {
  const p = path.join(root, ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x');
  return p;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-records-'));
  for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_TMPDIR', 'TMPDIR']) saved[key] = process.env[key];
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'config');
  process.env.CLAUDE_CODE_TMPDIR = path.join(root, 'cli-tmp');
  process.env.TMPDIR = path.join(root, 'tmp');
  fs.mkdirSync(process.env.TMPDIR, { recursive: true });
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('deleteSessionRecords', () => {
  it("removes the session's transcript, its agents' transcripts and its task outputs, and nothing else", async () => {
    const transcript = file('config', 'projects', 'C--Users-kotik-tmp', `${SESSION}.jsonl`);
    const agent = file('config', 'projects', 'C--Users-kotik-tmp', SESSION, 'subagents', 'agent-a1.jsonl');
    const output = file('cli-tmp', 'claude', 'C--Users-kotik-tmp', SESSION, 'tasks', 'b1.output');
    const other = file('config', 'projects', 'C--Users-kotik-tmp', `${OTHER}.jsonl`);
    const otherOutput = file('cli-tmp', 'claude', 'C--Users-kotik-tmp', OTHER, 'tasks', 'b2.output');

    expect(await deleteSessionRecords(SESSION)).toEqual({ transcript: true, tempDirs: 1 });

    for (const gone of [transcript, agent, output]) expect(fs.existsSync(gone), gone).toBe(false);
    expect(fs.existsSync(path.join(root, 'config', 'projects', 'C--Users-kotik-tmp', SESSION))).toBe(false);
    for (const kept of [other, otherOutput]) expect(fs.existsSync(kept), kept).toBe(true);
  });

  it('removes what is left when Claude Code already removed the transcript', async () => {
    const output = file('cli-tmp', 'claude-1000', 'proj', SESSION, 'tasks', 'b1.output');

    expect(await deleteSessionRecords(SESSION)).toEqual({ transcript: false, tempDirs: 1 });
    expect(fs.existsSync(output)).toBe(false);
  });

  it('does not follow a link out of the temp folder', async () => {
    const outside = file('elsewhere', SESSION, 'keep.txt');
    fs.mkdirSync(path.join(root, 'cli-tmp'), { recursive: true });
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'cli-tmp', 'link'));

    await deleteSessionRecords(SESSION);

    expect(fs.existsSync(outside)).toBe(true);
  });
});

describe('deleteToolResults', () => {
  it("removes the discussion's call results only", async () => {
    const mine = [writeToolResultFile('conv_a1_b2', 'toolu_1', 'r'), writeToolResultFile('conv_a1_b2', 'srvtoolu_2', 'r')];
    const theirs = writeToolResultFile('conv_a1_b3', 'toolu_3', 'r');

    expect(await deleteToolResults('conv_a1_b2')).toBe(2);

    for (const gone of mine) expect(fs.existsSync(gone)).toBe(false);
    expect(fs.existsSync(theirs)).toBe(true);
  });

  it('is nothing to do when no result was ever written', async () => {
    expect(await deleteToolResults('conv_a1_b2')).toBe(0);
  });
});
