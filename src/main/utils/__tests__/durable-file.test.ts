/**
 * Writing files so that stopping part-way never leaves a damaged one,
 * against a real folder.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { appendToFile, isTemporaryFile, replaceFile, temporaryFileOf } from '../durable-file';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-durable-'));
  file = path.join(dir, 'f.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const busy = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

describe('replaceFile', () => {
  it('replaces the content, leaving nothing beside it', async () => {
    fs.writeFileSync(file, 'old');

    await replaceFile(file, 'new');

    expect(fs.readFileSync(file, 'utf-8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['f.json']);
  });

  it('creates a file that is not there', async () => {
    await replaceFile(file, 'first');

    expect(fs.readFileSync(file, 'utf-8')).toBe('first');
  });

  it('leaves the old content whole when it fails before its rename', async () => {
    // What ending the process before the rename leaves, short of a kill.
    fs.writeFileSync(file, 'old');
    vi.spyOn(fs.promises, 'rename').mockRejectedValue(busy('EIO'));

    await expect(replaceFile(file, 'new')).rejects.toThrow('EIO');

    expect(fs.readFileSync(file, 'utf-8')).toBe('old');
    expect(fs.readdirSync(dir)).toEqual(['f.json']);
  });

  it('retries a rename that another program blocked for a moment, as on Windows', async () => {
    const rename = fs.promises.rename.bind(fs.promises);
    let refused = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (refused < 2) {
        refused += 1;
        throw busy('EPERM');
      }
      return rename(from, to);
    });

    await replaceFile(file, 'new');

    expect(refused).toBe(2);
    expect(fs.readFileSync(file, 'utf-8')).toBe('new');
  });

  it('gives up on a rename that stays blocked', async () => {
    fs.writeFileSync(file, 'old');
    vi.spyOn(fs.promises, 'rename').mockRejectedValue(busy('EBUSY'));

    await expect(replaceFile(file, 'new')).rejects.toThrow('EBUSY');
    expect(fs.readFileSync(file, 'utf-8')).toBe('old');
  });
});

describe('appendToFile', () => {
  it('adds to the end, creating the file when needed', async () => {
    await appendToFile(file, 'a\n');
    await appendToFile(file, 'b\n');

    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nb\n');
  });
});

describe('temporary files', () => {
  it('are named so they are recognised as such', () => {
    expect(isTemporaryFile(path.basename(temporaryFileOf(file)))).toBe(true);
    expect(isTemporaryFile('f.json')).toBe(false);
    expect(isTemporaryFile('f.messages.jsonl')).toBe(false);
  });
});
