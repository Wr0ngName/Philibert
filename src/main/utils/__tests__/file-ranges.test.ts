/**
 * Reading only some byte ranges of a file, against a real file.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { readRanges } from '../file-ranges';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-ranges-'));
  file = path.join(dir, 'f');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readRanges', () => {
  it('gives each range its bytes, in the order asked', async () => {
    fs.writeFileSync(file, '0123456789abcdef');

    const out = await readRanges(file, [{ start: 10, length: 3 }, { start: 0, length: 2 }, { start: 5, length: 1 }]);

    expect(out.map((b) => b.toString())).toEqual(['abc', '01', '5']);
  });

  it('reads ranges close together at once, and far ones apart', async () => {
    fs.writeFileSync(file, Buffer.alloc(300 * 1024, 0x61));
    const reads: number[] = [];
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (f, flags) => {
      const handle = await open(f, flags);
      const read = handle.read.bind(handle);
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        reads.push(position);
        return read(buffer, offset, length, position);
      }) as typeof handle.read;
      return handle;
    });

    await readRanges(file, [{ start: 0, length: 10 }, { start: 20, length: 10 }, { start: 200 * 1024, length: 10 }]);

    expect(reads).toEqual([0, 200 * 1024]);
  });

  it('fails on a range past the end of the file, rather than answering short', async () => {
    fs.writeFileSync(file, 'short');

    await expect(readRanges(file, [{ start: 2, length: 10 }])).rejects.toThrow('ends at byte 5');
  });

  it('reads nothing for no range', async () => {
    expect(await readRanges(path.join(dir, 'missing'), [])).toEqual([]);
  });
});
