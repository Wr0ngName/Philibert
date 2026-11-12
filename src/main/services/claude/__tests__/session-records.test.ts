/**
 * Removing what this app keeps of a deleted discussion outside its own files
 * — the call results written for the detail view — against a real folder.
 * What Claude Code keeps of its session is left to Claude Code's retention.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { deleteToolResults } from '../session-records';
import { writeToolResultFile } from '../tool-result-file';

let root: string;
let savedTmpdir: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-records-'));
  savedTmpdir = process.env.TMPDIR;
  // The call results are written under the system temp folder.
  process.env.TMPDIR = path.join(root, 'tmp');
  fs.mkdirSync(process.env.TMPDIR, { recursive: true });
});

afterEach(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  fs.rmSync(root, { recursive: true, force: true });
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
